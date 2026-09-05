"use client";

import { useEffect, useRef, useState } from "react";
import {
  REACTION_HEAT_COOLDOWN_EXIT,
  REACTION_HEAT_DRAIN_PER_SECOND,
  REACTION_HEAT_INCREMENT,
  REACTION_HEAT_MAX,
} from "@/lib/reactions/constants";

/**
 * Pre-launch interaction pass, Section 5: the *client-visible* reaction
 * heat meter — continuously draining, not a crude fixed-window rate
 * limit, mirroring `record_stage_reaction_attempt`'s own SQL decay math
 * (migration 00000000000045) closely enough that a normal user never
 * sees the two visibly disagree.
 *
 * **This is UX, not the security boundary** — see
 * `sendStageReaction`/`recordStageReactionAttempt`'s own doc comments
 * for the actual server-authoritative enforcement. This hook exists so
 * the reaction button can fill/pulse *before* a round trip completes,
 * and is always reconciled against whatever the server actually
 * returned once the response arrives (`reconcileWithServer`) — a
 * confirmed reject or an unexpectedly-different accepted value both
 * correct any optimistic drift immediately, rather than the client ever
 * being trusted on its own.
 *
 * Ticks via a plain `setInterval` (not `requestAnimationFrame`) — this
 * drives one small button's fill percentage, not a per-frame canvas/DOM
 * animation loop across a whole room of tiles (contrast
 * `AudioOnlyVisualizer`'s own rAF+ref discipline, which exists
 * specifically to avoid re-rendering many tiles 60x/second); a few
 * state updates per second for one button is proportionate.
 */
export function useReactionHeat() {
  const [heat, setHeat] = useState(0);
  const [inCooldown, setInCooldown] = useState(false);
  // `lastUpdated: 0` (epoch), not `Date.now()` — calling an impure
  // function directly in a ref initializer is flagged by this codebase's
  // own React purity lint rule. Harmless: heat also starts at 0, so the
  // first decay calculation's enormous "elapsed" time still clamps to
  // `max(0, 0 - huge) = 0`, identical to what a real timestamp would
  // have produced.
  const stateRef = useRef({ heat: 0, lastUpdated: 0, inCooldown: false });
  // Mirrors whatever React state was *last actually set to* — read
  // instead of the `heat`/`inCooldown` render-time closures below, which
  // this effect's empty dependency array would otherwise freeze at their
  // initial (mount-time) values forever, making the "already settled,
  // skip the render" check below compare against stale 0/false rather
  // than the real current display state.
  const lastRenderedRef = useRef({ heat: 0, inCooldown: false });

  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      const elapsedSeconds = (now - stateRef.current.lastUpdated) / 1000;
      if (elapsedSeconds <= 0) return;
      const decayed = Math.max(0, stateRef.current.heat - REACTION_HEAT_DRAIN_PER_SECOND * elapsedSeconds);
      const exitingCooldown = stateRef.current.inCooldown && decayed <= REACTION_HEAT_COOLDOWN_EXIT;
      stateRef.current.heat = decayed;
      stateRef.current.lastUpdated = now;
      if (exitingCooldown) stateRef.current.inCooldown = false;
      // Skip the re-render entirely once fully settled *and* the display
      // already reflects that — no reason to keep ticking React state
      // for an idle viewer who hasn't reacted in a while.
      if (decayed === 0 && !stateRef.current.inCooldown && lastRenderedRef.current.heat === 0 && !lastRenderedRef.current.inCooldown) {
        return;
      }
      lastRenderedRef.current = { heat: decayed, inCooldown: stateRef.current.inCooldown };
      setHeat(decayed);
      if (exitingCooldown) setInCooldown(false);
    }, 150);
    return () => clearInterval(interval);
  }, []);

  /** Called immediately on tap, before the server round trip resolves — see this hook's own doc comment. */
  function recordOptimisticSend() {
    const now = Date.now();
    const elapsedSeconds = Math.max(0, (now - stateRef.current.lastUpdated) / 1000);
    const decayed = Math.max(0, stateRef.current.heat - REACTION_HEAT_DRAIN_PER_SECOND * elapsedSeconds);
    const next = Math.min(REACTION_HEAT_MAX, decayed + REACTION_HEAT_INCREMENT);
    const nextCooldown = next >= REACTION_HEAT_MAX;
    stateRef.current = { heat: next, lastUpdated: now, inCooldown: nextCooldown };
    lastRenderedRef.current = { heat: next, inCooldown: nextCooldown };
    setHeat(next);
    setInCooldown(nextCooldown);
  }

  /** Overwrites the local estimate with the server's own authoritative values — called once the send action resolves, whether accepted or rejected. */
  function reconcileWithServer(heatAfter: number, inCooldownAfter: boolean) {
    stateRef.current = { heat: heatAfter, lastUpdated: Date.now(), inCooldown: inCooldownAfter };
    lastRenderedRef.current = { heat: heatAfter, inCooldown: inCooldownAfter };
    setHeat(heatAfter);
    setInCooldown(inCooldownAfter);
  }

  return {
    /** 0-100. */
    heat,
    /** 0-1, for a fill percentage. */
    heatFraction: heat / REACTION_HEAT_MAX,
    inCooldown,
    canSend: !inCooldown,
    recordOptimisticSend,
    reconcileWithServer,
  };
}
