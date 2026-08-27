"use client";

import { useEffect, useMemo, useRef, useState } from "react";
// Realtime subscriptions call the Supabase client directly rather than
// going through a repository — unlike the durable-write repositories in
// lib/repositories/, there's no portable abstraction for "subscribe to
// live changes" that wouldn't be premature (every realtime provider's API
// shape differs enough that a generic wrapper would just be Supabase's
// API with extra steps). This is a deliberate, documented exception — see
// ARCHITECTURE.md's Vendor portability section.
import { createClient } from "@/lib/supabase/client";
import type { Identity } from "@/lib/identity";

export type LobbyMessage = {
  id: string;
  author_display_name: string;
  author_profile_id: string | null;
  author_guest_id: string | null;
  body: string;
  created_at: string;
  /** See ChatMessage's doc comment in lib/repositories/chat.ts — a permanent "was this a mic request" marker, issue #14. */
  is_speaker_request: boolean;
};

export type ReactionState = { count: number; reactedByMe: boolean };

const MAX_MESSAGES_IN_MEMORY = 300;

/**
 * Removes one deleted message from the live list. Pure, exported for
 * testability without a live Realtime connection — same reasoning as
 * `applySpeakerChange` (use-active-speakers.ts). Ordinary product usage
 * never hard-deletes a chat message (it's permanent); the Session
 * Simulator's Reset Session is the one real caller today (see
 * migration 00000000000023 for why `event_chat_messages` needed
 * `REPLICA IDENTITY FULL` for this DELETE event to even reach here
 * correctly-filtered by event).
 */
export function removeMessage(messages: LobbyMessage[], deletedId: string): LobbyMessage[] {
  return messages.filter((m) => m.id !== deletedId);
}

/**
 * Removes one deleted reaction's contribution from the aggregated
 * per-message count — the mirror of the INSERT handler's increment,
 * needed because a reaction can be deleted (Reset Session removing a
 * simulated like) without its parent message also being deleted. Needs
 * the deleted row's `message_id`/reactor identity, which
 * `REPLICA IDENTITY FULL` (migration 00000000000023) makes available in
 * a DELETE's `payload.old`, matching what INSERT already carries.
 */
export function removeReaction(
  current: Record<string, ReactionState>,
  deleted: { message_id: string; reactor_profile_id: string | null; reactor_guest_id: string | null },
  identity: Identity,
): Record<string, ReactionState> {
  const existing = current[deleted.message_id];
  if (!existing) return current;
  const wasMine =
    identity.type === "profile" ? deleted.reactor_profile_id === identity.id : deleted.reactor_guest_id === identity.id;
  return {
    ...current,
    [deleted.message_id]: { count: Math.max(0, existing.count - 1), reactedByMe: wasMine ? false : existing.reactedByMe },
  };
}

/**
 * Owns every piece of live lobby state — chat messages, reaction counts,
 * and attendee presence — behind one subscription lifecycle. This hook is
 * meant to be called from exactly one place per lobby (the top-level
 * client component), never duplicated inside a portrait/landscape-only
 * branch: see ARCHITECTURE.md's mobile orientation implementation notes
 * for why that split would silently drop the realtime connection on
 * rotation. The lobby doesn't branch by orientation at all right now
 * (see ARCHITECTURE.md), but this hook is written so it wouldn't matter
 * if a future screen did.
 */
export function useLobbyRealtime(
  eventId: string,
  identity: Identity,
  initialMessages: LobbyMessage[],
  initialReactions: Record<string, ReactionState>,
) {
  const [messages, setMessages] = useState<LobbyMessage[]>(initialMessages);
  const [reactions, setReactions] = useState<Record<string, ReactionState>>(initialReactions);
  const [attendeeCount, setAttendeeCount] = useState(1);
  const messageIdsRef = useRef(new Set(initialMessages.map((m) => m.id)));

  useEffect(() => {
    const supabase = createClient();

    const chatChannel = supabase
      .channel(`event-chat:${eventId}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "event_chat_messages", filter: `event_id=eq.${eventId}` },
        (payload) => {
          const message = payload.new as LobbyMessage;
          if (messageIdsRef.current.has(message.id)) return;
          messageIdsRef.current.add(message.id);
          setMessages((prev) => {
            const next = [...prev, message];
            return next.length > MAX_MESSAGES_IN_MEMORY ? next.slice(-MAX_MESSAGES_IN_MEMORY) : next;
          });
        },
      )
      .on(
        // Not filtered by event — this table has no event_id column
        // (reactions reference a message, not an event directly), so we
        // filter client-side against messages we already know about.
        // Fine at prototype scale; if concurrent-event volume ever makes
        // this a real cost, add a denormalized event_id column.
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "event_chat_message_reactions" },
        (payload) => {
          const reaction = payload.new as {
            message_id: string;
            reactor_profile_id: string | null;
            reactor_guest_id: string | null;
          };
          if (!messageIdsRef.current.has(reaction.message_id)) return;

          const isMine =
            identity.type === "profile"
              ? reaction.reactor_profile_id === identity.id
              : reaction.reactor_guest_id === identity.id;

          setReactions((prev) => {
            const existing = prev[reaction.message_id] ?? { count: 0, reactedByMe: false };
            return {
              ...prev,
              [reaction.message_id]: {
                count: existing.count + 1,
                reactedByMe: existing.reactedByMe || isMine,
              },
            };
          });
        },
      )
      .on(
        // Session Simulator Reset Session follow-up: the one real-world
        // path that hard-deletes a chat message. Removing it here — not
        // just from the DB — is what makes the live feed, Expanded
        // Comments (which snapshots from `messages` on open), and Top
        // Speaker Requests (a separate hook, see use-active-speaker-requests.ts)
        // stop showing it without requiring a page reload.
        "postgres_changes",
        { event: "DELETE", schema: "public", table: "event_chat_messages", filter: `event_id=eq.${eventId}` },
        (payload) => {
          const deletedId = (payload.old as { id: string }).id;
          messageIdsRef.current.delete(deletedId);
          setMessages((prev) => removeMessage(prev, deletedId));
          // Belt-and-suspenders, not load-bearing: any reactions on this
          // message will also arrive as their own individual DELETE
          // events (cascade deletes still emit one WAL entry per row),
          // handled by the reaction-DELETE listener below — this just
          // clears the whole aggregate immediately rather than waiting
          // on however many of those arrive.
          setReactions((prev) => {
            if (!(deletedId in prev)) return prev;
            const next = { ...prev };
            delete next[deletedId];
            return next;
          });
        },
      )
      .on(
        // Same reasoning as the message DELETE above — a reaction can
        // also be deleted on its own (Reset Session removing a simulated
        // like from a message that isn't itself being deleted).
        "postgres_changes",
        { event: "DELETE", schema: "public", table: "event_chat_message_reactions" },
        (payload) => {
          const deleted = payload.old as {
            message_id: string;
            reactor_profile_id: string | null;
            reactor_guest_id: string | null;
          };
          if (!messageIdsRef.current.has(deleted.message_id)) return;
          setReactions((prev) => removeReaction(prev, deleted, identity));
        },
      )
      .subscribe();

    const presenceChannel = supabase.channel(`event-presence:${eventId}`, {
      config: { presence: { key: identity.id } },
    });

    presenceChannel
      .on("presence", { event: "sync" }, () => {
        const state = presenceChannel.presenceState();
        setAttendeeCount(Object.keys(state).length);
      })
      .subscribe(async (status) => {
        if (status === "SUBSCRIBED") {
          await presenceChannel.track({ name: identity.displayName });
        }
      });

    return () => {
      supabase.removeChannel(chatChannel);
      supabase.removeChannel(presenceChannel);
    };
    // identity.id/type/displayName are stable for the lifetime of a
    // lobby visit (a page load), so this effect intentionally only reruns
    // if the event itself changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId]);

  const sortedMessages = useMemo(
    () => [...messages].sort((a, b) => a.created_at.localeCompare(b.created_at)),
    [messages],
  );

  return { messages: sortedMessages, reactions, attendeeCount };
}
