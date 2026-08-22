"use client";

import { useCallback, useState } from "react";

/**
 * Issue #21, retired-gesture pass (real-device finding, 2026-08-22): two
 * successive real-device tests found the room-level downward-drag
 * gesture didn't work — no meaningful transition on an actual iPhone,
 * and (independent of the gesture itself) Watch Mode's "collapsed" chat
 * wrapper was never actually *hidden*, just shorter, so comments/
 * composer still permanently dominated the stage in both orientations.
 * Rather than keep tuning gesture thresholds, this hook was cut back to
 * exactly the one thing proven useful: a plain boolean mode, driven only
 * by explicit taps (the compact 💬 control in Watch Mode, an explicit
 * close/back control in Comments Mode) — no drag tracking, no pointer-
 * event delegation, no dead zone, no `progress` value to interpolate.
 *
 * This is a *deliberate, temporary foundation* — see DECISIONS.md's
 * "Future Figma seam" note. The eventual downward-drag reveal is not
 * abandoned; it's deferred until Watch Mode and Comments Mode both have
 * a real, Figma-defined visual design to transition *between*. Building
 * gesture physics against a visual target that itself needed to change
 * is what produced two rounds of real-device failure — reliable states
 * first, a smooth transition between them later, not the other way
 * around. When that gesture returns, this hook's own `open`/
 * `openComments`/`closeComments` shape is exactly what a drag-driven
 * `progress` value would sit on top of again; nothing about this
 * simplification makes that harder to add back.
 */
export function useCommentsMode() {
  const [open, setOpen] = useState(false);
  const openComments = useCallback(() => setOpen(true), []);
  const closeComments = useCallback(() => setOpen(false), []);
  return { open, openComments, closeComments };
}
