"use client";

import { useEffect, useRef, useState } from "react";
// Same documented exception as use-lobby-realtime.ts's own comment —
// subscribing to a live broadcast channel calls the Supabase client
// directly, not through a repository.
import { createClient } from "@/lib/supabase/client";
import { sendStageReaction } from "@/app/events/[id]/room/actions";
import { REACTION_BURST_LIFETIME_MS, REACTION_SENT_ID_MEMORY_MS } from "@/lib/reactions/constants";
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
 *
 * **Instant sender feedback (real-device follow-up)**: the network/
 * server round trip (resolve identity → `record_stage_reaction_attempt`
 * → `httpSend` REST broadcast → the broadcast traveling back down the
 * sender's own subscribed WebSocket channel) was previously the *only*
 * path that ever added anything to `incoming` — including for the
 * sender's own reaction, so the sender genuinely waited out that whole
 * round trip before seeing their own animation. `send()` below now adds
 * a local, optimistic entry to `incoming` immediately, synchronously,
 * before `sendStageReaction` is even called — the authoritative call
 * still happens concurrently and is still the only thing that can ever
 * move heat or trigger a real broadcast (this local entry is
 * presentation only, exactly like the client-visible heat meter is).
 *
 * **Dedup — real-device correction, second pass**: the optimistic entry
 * and the real broadcast eventually sent by the server for the *same*
 * send carry the *identical* `id` (generated client-side, threaded
 * through `sendStageReaction`'s `reactionId` parameter, echoed back
 * verbatim in the broadcast payload). The *first* version of this dedup
 * compared the incoming broadcast's id against whatever was still in
 * `incoming` — which is exactly the bug: `incoming` entries are pruned
 * after `REACTION_BURST_LIFETIME_MS` (2200ms, tied to the on-screen
 * animation's own duration), but the round trip this is deduping against
 * (DB row lock + REST broadcast + Realtime propagation back to the
 * sender) has no such guarantee of finishing that fast — a slower round
 * trip meant the optimistic entry was already gone by the time its own
 * confirmation arrived, so the id match silently failed and the
 * broadcast got added as if it were a brand-new reaction. Fixed by
 * tracking "ids this exact tab has sent" in a *separate*, longer-lived
 * ref (`sentReactionIdsRef`, `REACTION_SENT_ID_MEMORY_MS`, 30s — no
 * relation to the visual burst's own 2.2s lifetime) — the broadcast
 * handler checks this set *before* ever touching `incoming`, so a slow
 * round trip can never defeat it. Deliberately id-based, not
 * `senderIdentity`-based: a same-identity reaction sent from a
 * *different* tab/device (e.g. a guest with the same cookie open in two
 * tabs) never gets added to *this* tab's `sentReactionIdsRef`, so its
 * own first sighting of that broadcast still renders normally — matching
 * "suppress only this browser/device's own optimistic echo, never
 * another session's legitimate activity."
 *
 * **Heat is never touched by this path, by construction**: only `send()`
 * below ever calls `recordOptimisticSend`/`reconcileWithServer` — the
 * broadcast handler (`addReaction`'s caller) has no access to `heat` at
 * all. Receiving *any* reaction, whether it's your own echo or someone
 * else's, can never move your own sending heat.
 */
function useStageReactions(eventId: string, myIdentity: string) {
  const [incoming, setIncoming] = useState<IncomingStageReaction[]>([]);
  const heat = useReactionHeat();
  const pruneTimeoutsRef = useRef(new Set<ReturnType<typeof setTimeout>>());
  // Ids this exact hook instance (this tab/session) has sent and already
  // rendered optimistically — see this function's own doc comment above
  // for why this is deliberately a separate, longer-lived tracking
  // mechanism from the visual `incoming` array's own pruning.
  const sentReactionIdsRef = useRef(new Set<string>());
  const sentIdTimeoutsRef = useRef(new Set<ReturnType<typeof setTimeout>>());

  function addReaction(reaction: IncomingStageReaction) {
    setIncoming((prev) => {
      if (prev.some((r) => r.id === reaction.id)) return prev;
      return [...prev, reaction];
    });
    const timeout = setTimeout(() => {
      pruneTimeoutsRef.current.delete(timeout);
      setIncoming((prev) => prev.filter((r) => r.id !== reaction.id));
    }, REACTION_BURST_LIFETIME_MS);
    pruneTimeoutsRef.current.add(timeout);
  }

  useEffect(() => {
    // Captured once, at the top of the effect — the Set instances
    // themselves never change across this hook's lifetime (never
    // reassigned), only their contents do; this is purely to satisfy the
    // "ref value may have changed by cleanup time" lint rule, not a real
    // staleness risk.
    const pruneTimeouts = pruneTimeoutsRef.current;
    const sentIds = sentReactionIdsRef.current;
    const sentIdTimeouts = sentIdTimeoutsRef.current;
    const supabase = createClient();
    const channel = supabase
      .channel(`event-reactions:${eventId}`)
      .on("broadcast", { event: "reaction" }, (message) => {
        const reaction = message.payload as IncomingStageReaction;
        // This tab's own confirmed echo — already shown optimistically
        // (or deliberately not shown at all, if canSend was already
        // known false at send time; either way, this tab has nothing
        // further to render for it). Never re-added, never re-touches
        // heat (nothing below this branch ever runs).
        if (sentIds.has(reaction.id)) return;
        addReaction(reaction);
      })
      .subscribe();

    return () => {
      for (const timeout of pruneTimeouts) clearTimeout(timeout);
      pruneTimeouts.clear();
      for (const timeout of sentIdTimeouts) clearTimeout(timeout);
      sentIdTimeouts.clear();
      sentIds.clear();
      setIncoming([]);
      void supabase.removeChannel(channel);
    };
    // addReaction is intentionally not listed as a dependency — it only
    // ever calls stable setters (setIncoming from useState,
    // pruneTimeoutsRef.current, a ref), so a "stale" closure from this
    // effect's mount-time capture behaves identically to a fresh one;
    // re-subscribing on every render would be strictly worse (see
    // eventId as the only real dependency). The lint rule doesn't flag
    // this (it isn't declared with useCallback, so it has no stable
    // identity to compare against renders) — this comment exists so a
    // future pass doesn't "fix" it by adding the dependency anyway.
  }, [eventId]);

  /**
   * Section 2: `targetIdentity` is always the authoritative seat
   * identity the caller already resolved (e.g. from `SpeakerStage`'s own
   * `renderTile`, which computes it from `speaker.profile_id`/
   * `guest_id` — never "top tile"/"bottom tile"), so a local visual
   * speaker swap can never cause this to target the wrong person.
   *
   * The optimistic local entry only ever renders when `heat.canSend` is
   * already true at the moment of the tap — the client's own
   * synchronized heat/cooldown state (kept honest by `reconcileWithServer`
   * below on every prior send) already knows when sending is blocked;
   * showing a fake animation in that case would be actively misleading,
   * not helpful, per explicit instruction. The authoritative call below
   * still always happens regardless — the server, not this local guess,
   * remains the only real accept/reject decision; a stale client guess
   * that's actually wrong just means this specific send arrives slightly
   * later (via the ordinary broadcast round trip) instead of instantly,
   * never that a legitimate reaction is silently dropped.
   */
  async function send(targetIdentity: string, emoji: string, x: number, y: number) {
    const id = crypto.randomUUID();
    if (heat.canSend) {
      // Remembered *before* the round trip even starts, independent of
      // the visual burst's own shorter lifetime — see this hook's own
      // doc comment on `sentReactionIdsRef` for why this fixes the real
      // duplicate bug rather than the id-matching idea alone.
      sentReactionIdsRef.current.add(id);
      const cleanup = setTimeout(() => {
        sentIdTimeoutsRef.current.delete(cleanup);
        sentReactionIdsRef.current.delete(id);
      }, REACTION_SENT_ID_MEMORY_MS);
      sentIdTimeoutsRef.current.add(cleanup);
      addReaction({ id, targetIdentity, emoji, x, y, senderIdentity: myIdentity, ts: Date.now() });
    }
    heat.recordOptimisticSend();
    const result = await sendStageReaction(eventId, targetIdentity, emoji, x, y, id);
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
 *
 * `myIdentity` (real-device follow-up): the viewer's own LiveKit-format
 * identity (`EventRoom`'s own canonical `myIdentity`, computed once from
 * the resolved caller identity — not seat-scoped, works whether or not
 * this viewer currently holds a seat) — threaded through so `incoming`
 * reactions can be told apart as "mine" vs. "someone else's" for
 * presentation (instant local feedback, Side mode's own sender/others
 * split — see `SpeakerStage`'s own doc comment) without a second,
 * separately-maintained notion of identity.
 */
export function useReactionsController(eventId: string, myIdentity: string) {
  const preferences = useReactionPreferences();
  const stage = useStageReactions(eventId, myIdentity);
  return { ...preferences, ...stage, myIdentity };
}

export type ReactionsController = ReturnType<typeof useReactionsController>;
