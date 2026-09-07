"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
// Realtime subscriptions call the Supabase client directly rather than
// going through a repository — unlike the durable-write repositories in
// lib/repositories/, there's no portable abstraction for "subscribe to
// live changes" that wouldn't be premature (every realtime provider's API
// shape differs enough that a generic wrapper would just be Supabase's
// API with extra steps). This is a deliberate, documented exception — see
// ARCHITECTURE.md's Vendor portability section.
import { createClient } from "@/lib/supabase/client";
import { sendMessage } from "@/app/events/[id]/lobby/actions";
import type { Identity } from "@/lib/identity";

/**
 * Real-device report (optimistic-send redesign): `undefined` for every
 * authoritative, server-confirmed row — the overwhelming majority.
 * Present only on a message *this exact tab* optimistically inserted and
 * is still tracking the outcome of. Purely local presentation state:
 * never persisted, never part of the actual `event_chat_messages` row,
 * never sent to the server. See `submitComment`'s own doc comment for
 * the full lifecycle this drives.
 */
export type OptimisticStatus = "sending" | "failed";

export type LobbyMessage = {
  id: string;
  author_display_name: string;
  author_profile_id: string | null;
  author_guest_id: string | null;
  body: string;
  created_at: string;
  /** See ChatMessage's doc comment in lib/repositories/chat.ts — a permanent "was this a mic request" marker, issue #14. */
  is_speaker_request: boolean;
  optimisticStatus?: OptimisticStatus;
};

export type ReactionState = { count: number; reactedByMe: boolean };

const MAX_MESSAGES_IN_MEMORY = 300;
/**
 * Real-device report, Section 6: this tab's own successive comment
 * dispatches are paced at least this far apart — a small (100ms) safety
 * margin over `sendMessage`'s own server-side `RATE_LIMIT_MS` (2000ms),
 * absorbing ordinary network/clock variance so a normal fast-typing burst
 * never actually *reaches* the server fast enough to trip that check,
 * without ever touching the check itself. Purely a transport-pacing
 * detail — every optimistic message still appears to the user instantly,
 * regardless of this delay (see `submitComment`'s own doc comment).
 */
const MIN_SEND_INTERVAL_MS = 2100;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
  // Real-device report (optimistic-send redesign) — the outgoing-comment
  // transport machinery. See `submitComment`'s own doc comment below for
  // the full lifecycle; briefly:
  // - `pendingBodiesRef`: id -> the exact text to send, populated at
  //   optimistic-insert time and read at actual-dispatch time (never
  //   re-read from `messages` state, which could be stale inside a
  //   closure captured before this render) — cleared once confirmed,
  //   kept (for a possible retry) if failed.
  // - `outgoingQueueRef`: ids awaiting transport, strictly in submission
  //   order — Section 18's own explicit "A/B/C must reach the backend in
  //   A -> B -> C order" requirement.
  // - `queueRunningRef`: true while `runOutgoingQueue` has an active
  //   processing loop — prevents two overlapping loops from both trying
  //   to drain the same queue concurrently (e.g. two `submitComment`
  //   calls in the same tick).
  // - `lastDispatchAtRef`: when this tab last actually sent a request to
  //   the server (not when the user tapped Send) — what
  //   `MIN_SEND_INTERVAL_MS` paces against.
  const pendingBodiesRef = useRef(new Map<string, string>());
  const outgoingQueueRef = useRef<string[]>([]);
  const queueRunningRef = useRef(false);
  const lastDispatchAtRef = useRef(0);
  const mountedRef = useRef(true);

  // Real-device/live-verification finding: a naked cleanup-only effect
  // (`useEffect(() => () => { mountedRef.current = false }, [])`) is a
  // real bug under React StrictMode's dev-only double-invoke of effects —
  // mount → simulated unmount (cleanup runs, flips this to `false`) →
  // remount, with nothing in the second mount's own effect body ever
  // setting it back to `true`. The ref then stays permanently `false` for
  // the rest of this component's real, still-mounted lifetime, which
  // silently defeated `runOutgoingQueue`'s very first `if
  // (!mountedRef.current) return;` check — every comment still showed
  // optimistically (that part never touched this ref), but the
  // background dispatch to `sendMessage` never ran at all, leaving every
  // comment stuck on "Sending…" forever. Caught only by driving this
  // against a real `next dev` server (StrictMode is dev-only — a
  // production build never double-invokes effects, so this would never
  // have surfaced against a deployed preview) — confirmed not
  // reproducible in this project's own vitest+RTL harness either
  // (`renderHook`'s `wrapper: StrictMode` does not actually double-invoke
  // effects here, verified directly before writing this comment), so
  // there is deliberately no unit test claiming to cover this exact
  // mechanism; the real-browser verification in this pass's own handoff
  // is the authoritative check. Fixed by setting the ref back to `true`
  // at the start of the effect body too, so the second, real mount always
  // starts this correctly `true` again.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const supabase = createClient();

    const chatChannel = supabase
      .channel(`event-chat:${eventId}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "event_chat_messages", filter: `event_id=eq.${eventId}` },
        (payload) => {
          const message = payload.new as LobbyMessage;
          // Real-device report (optimistic-send redesign): reconciliation
          // — `submitComment` below inserts an optimistic entry into
          // `messages` under this *exact* id (client-generated, sent
          // through to the server unchanged — see `insertMessage`'s own
          // doc comment) before this event can possibly arrive. Finding
          // it here by id, not by guessing from body/display-name/
          // timestamp, is what lets this be an exact, unambiguous
          // reconciliation regardless of arrival order. Replacing it in
          // place (same array position, same id) rather than removing +
          // re-appending is what keeps this from ever registering as a
          // "new arrival" to ExpandedComments' own anchoring effect
          // (Section 14: no second jump, no second flash on
          // confirmation) — only the very first, optimistic insertion
          // does that.
          messageIdsRef.current.add(message.id);
          setMessages((prev) => {
            const existingIndex = prev.findIndex((m) => m.id === message.id);
            if (existingIndex !== -1) {
              if (!prev[existingIndex].optimisticStatus) return prev; // already fully confirmed — a duplicate delivery, a safe no-op
              const next = [...prev];
              next[existingIndex] = { ...message, optimisticStatus: undefined };
              return next;
            }
            const next = [...prev, message];
            return next.length > MAX_MESSAGES_IN_MEMORY ? next.slice(-MAX_MESSAGES_IN_MEMORY) : next;
          });
          pendingBodiesRef.current.delete(message.id); // confirmed — no longer needed for a retry
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

  function markConfirmed(id: string, confirmedMessage?: LobbyMessage) {
    pendingBodiesRef.current.delete(id);
    if (!mountedRef.current) return;
    setMessages((prev) =>
      prev.map((m) => (m.id === id ? (confirmedMessage ? { ...confirmedMessage, optimisticStatus: undefined } : { ...m, optimisticStatus: undefined }) : m)),
    );
  }

  function markFailed(id: string) {
    if (!mountedRef.current) return;
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, optimisticStatus: "failed" } : m)));
  }

  async function dispatchOne(id: string) {
    const body = pendingBodiesRef.current.get(id);
    if (body === undefined) return; // nothing left to send — already confirmed/abandoned (e.g. Reset Session)
    lastDispatchAtRef.current = Date.now();
    try {
      const result = await sendMessage(eventId, body, id);
      if (result.ok) {
        // Belt-and-suspenders alongside the Realtime reconciliation in
        // the INSERT handler above — confirms locally even if Realtime
        // is slow, disconnected, or (rarely) misses this specific event;
        // Realtime's own later arrival for this same id is still a safe
        // no-op either way (see that handler's own doc comment).
        markConfirmed(id);
      } else {
        markFailed(id);
      }
    } catch {
      markFailed(id);
    }
  }

  async function runOutgoingQueue() {
    if (queueRunningRef.current) return;
    queueRunningRef.current = true;
    try {
      while (outgoingQueueRef.current.length > 0) {
        if (!mountedRef.current) return;
        const elapsed = Date.now() - lastDispatchAtRef.current;
        if (elapsed < MIN_SEND_INTERVAL_MS) {
          await sleep(MIN_SEND_INTERVAL_MS - elapsed);
          if (!mountedRef.current) return;
        }
        const id = outgoingQueueRef.current.shift();
        if (id === undefined) continue;
        await dispatchOne(id);
      }
    } finally {
      queueRunningRef.current = false;
    }
  }

  function enqueue(id: string) {
    outgoingQueueRef.current.push(id);
    void runOutgoingQueue();
  }

  /**
   * Real-device report ("the composer waits for the server"): the entire
   * point of this redesign — appears in `messages` (and therefore in
   * both `AmbientComments` and `ExpandedComments`, which read this same
   * array) *synchronously*, before any network activity at all. The
   * caller (`ChatPanel`) never awaits this, never disables anything on
   * its account, and the input it read `body` from is cleared by the
   * caller in the same tick — the transport that follows is a background
   * concern this hook owns entirely on its own.
   *
   * **Ordering (Section 18)**: `outgoingQueueRef` is a plain FIFO array;
   * `enqueue` always appends to the end and `runOutgoingQueue` always
   * shifts from the front, so three rapid calls (A, B, C) are dispatched
   * in exactly that order regardless of how their own individual network
   * round trips happen to resolve relative to each other.
   *
   * **Concurrency (Section 5)**: never more than one dispatch in flight
   * at a time *from this tab* — `runOutgoingQueue`'s own `while` loop
   * awaits each `dispatchOne` before advancing, which is also what makes
   * `MIN_SEND_INTERVAL_MS` pacing (Section 6) trivial to enforce
   * correctly. This is a transport-only serialization, invisible to the
   * user: every message the user sends is already visible, and the
   * composer is already clear and ready for the next one, well before
   * its own turn in this queue comes up.
   */
  const submitComment = useCallback(
    (body: string) => {
      const trimmed = body.trim();
      if (!trimmed) return;
      const id = crypto.randomUUID();
      const optimisticMessage: LobbyMessage = {
        id,
        author_display_name: identity.displayName,
        author_profile_id: identity.type === "profile" ? identity.id : null,
        author_guest_id: identity.type === "guest" ? identity.id : null,
        body: trimmed,
        created_at: new Date().toISOString(),
        is_speaker_request: false,
        optimisticStatus: "sending",
      };
      messageIdsRef.current.add(id);
      pendingBodiesRef.current.set(id, trimmed);
      setMessages((prev) => {
        const next = [...prev, optimisticMessage];
        return next.length > MAX_MESSAGES_IN_MEMORY ? next.slice(-MAX_MESSAGES_IN_MEMORY) : next;
      });
      enqueue(id);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [eventId, identity.type, identity.id, identity.displayName],
  );

  /**
   * Real-device report, Section 12-13: retries the *exact* failed
   * message, under its own original id — never the current composer
   * draft, never a new id. If the original attempt actually reached the
   * database despite this tab never seeing a clean response (a dropped
   * response, a reconnect), `insertMessage`'s own idempotent handling of
   * a primary-key conflict on that same id (see its doc comment) means
   * this retry safely resolves as a confirmation instead of creating a
   * second, duplicate row.
   */
  const retryComment = useCallback((id: string) => {
    if (!pendingBodiesRef.current.has(id)) return; // nothing left to retry (already confirmed, or unknown id)
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, optimisticStatus: "sending" } : m)));
    enqueue(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Real-device report, Section 19: Reset Session's own comprehensive
   * server-side wipe removes every real comment already; this clears the
   * client-only optimistic/queue state that a server-side DELETE has no
   * way to know about — any comment still `sending`/`failed` locally,
   * the outgoing queue itself, and every id this tab still remembers a
   * draft body for. Never touches the *draft currently being typed* —
   * that's `ChatPanel`'s own, separate state, untouched by this.
   */
  const clearOptimisticState = useCallback(() => {
    outgoingQueueRef.current = [];
    pendingBodiesRef.current = new Map();
    setMessages((prev) => prev.filter((m) => !m.optimisticStatus));
  }, []);

  return {
    messages: sortedMessages,
    reactions,
    attendeeCount,
    submitComment,
    retryComment,
    clearOptimisticState,
  };
}
