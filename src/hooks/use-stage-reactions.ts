"use client";

import { useEffect, useRef, useState } from "react";
// Same documented exception as use-lobby-realtime.ts's own comment —
// subscribing to a live broadcast channel calls the Supabase client
// directly, not through a repository.
import { createClient } from "@/lib/supabase/client";
import { sendStageReaction } from "@/app/events/[id]/room/actions";
import { REACTION_BURST_LIFETIME_MS } from "@/lib/reactions/constants";
import { useReactionHeat } from "@/hooks/use-reaction-heat";
import { useReactionPreferences } from "@/hooks/use-reaction-preferences";

export type IncomingStageReaction = {
  /** Ephemeral, server-generated per send — never a durable row id. */
  id: string;
  /** LiveKit-format identity string (`profile:<id>`/`guest:<id>`) of the seat this reaction targets. */
  targetIdentity: string;
  emoji: string;
  /** 0-1, tile-relative. */
  x: number;
  /** 0-1, tile-relative. */
  y: number;
  senderIdentity: string;
  ts: number;
};

/**
 * Pre-launch interaction pass: owns the one live subscription to this
 * event's directed-reaction broadcast channel, and the one client-side
 * heat meter — instantiated once, in `EventRoom` (same "live state lives
 * above whichever presentation component renders it" discipline
 * `useLiveRoomConnection`/`useActiveSpeakers` already established),
 * never per-composition.
 *
 * **Ephemeral by construction**: incoming reactions live only in this
 * hook's own in-memory array, auto-pruned after
 * `REACTION_BURST_LIFETIME_MS` — never written anywhere, never part of
 * `messages`/comment history. A page refresh loses every reaction that
 * already animated, which is correct: they were never meant to survive
 * one.
 *
 * **Presentation-independent delivery**: every subscriber receives the
 * exact same event (target identity, emoji, normalized x/y) regardless
 * of that viewer's own display preference — `StageReactionsOverlay`
 * (the actual renderer) is what decides on-speaker/side/hidden per
 * viewer, from this same shared list. See that component's own doc
 * comment.
 */
function useStageReactions(eventId: string) {
  const [incoming, setIncoming] = useState<IncomingStageReaction[]>([]);
  const heat = useReactionHeat();
  const pruneTimeoutsRef = useRef(new Set<ReturnType<typeof setTimeout>>());

  useEffect(() => {
    // Captured once, at the top of the effect — the Set instance itself
    // never changes across this hook's lifetime (never reassigned), only
    // its contents do; this is purely to satisfy the "ref value may have
    // changed by cleanup time" lint rule, not a real staleness risk.
    const pruneTimeouts = pruneTimeoutsRef.current;
    const supabase = createClient();
    const channel = supabase
      .channel(`event-reactions:${eventId}`)
      .on("broadcast", { event: "reaction" }, (message) => {
        const reaction = message.payload as IncomingStageReaction;
        setIncoming((prev) => [...prev, reaction]);
        const timeout = setTimeout(() => {
          pruneTimeouts.delete(timeout);
          setIncoming((prev) => prev.filter((r) => r.id !== reaction.id));
        }, REACTION_BURST_LIFETIME_MS);
        pruneTimeouts.add(timeout);
      })
      .subscribe();

    return () => {
      for (const timeout of pruneTimeouts) clearTimeout(timeout);
      pruneTimeouts.clear();
      setIncoming([]);
      void supabase.removeChannel(channel);
    };
  }, [eventId]);

  /**
   * Section 2: `targetIdentity` is always the authoritative seat
   * identity the caller already resolved (e.g. from `SpeakerStage`'s own
   * `renderTile`, which computes it from `speaker.profile_id`/
   * `guest_id` — never "top tile"/"bottom tile"), so a local visual
   * speaker swap can never cause this to target the wrong person.
   */
  async function send(targetIdentity: string, emoji: string, x: number, y: number) {
    heat.recordOptimisticSend();
    const result = await sendStageReaction(eventId, targetIdentity, emoji, x, y);
    if (result.heatAfter !== undefined && result.inCooldownAfter !== undefined) {
      heat.reconcileWithServer(result.heatAfter, result.inCooldownAfter);
    }
    return result;
  }

  return {
    incoming,
    send,
    heat: heat.heat,
    heatFraction: heat.heatFraction,
    inCooldown: heat.inCooldown,
    canSend: heat.canSend,
  };
}

/**
 * Pre-launch interaction pass: the one bundled reaction hook `EventRoom`
 * calls — composes `useStageReactions` (delivery + server-reconciled
 * heat) and `useReactionPreferences` (local emoji/display prefs) into a
 * single object so every composition/component below only needs to
 * thread *one* `reactions` prop, not six separate ones. Instantiated
 * once, above the role/orientation branches, same discipline as
 * `useLiveRoomConnection`/`useActiveSpeakers`.
 */
export function useReactionsController(eventId: string) {
  const preferences = useReactionPreferences();
  const stage = useStageReactions(eventId);
  return { ...preferences, ...stage };
}

export type ReactionsController = ReturnType<typeof useReactionsController>;
