"use client";

import { useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Issue #21, seventh corrective pass, Sections 21-26: one shared control
 * for every Session Simulator button — consolidating tactile feedback in
 * one place rather than each of the panel's ~15 buttons growing its own
 * one-off `:active`/disabled treatment. Real-device testing found the
 * panel gave *no* visual acknowledgment that a tap had registered at
 * all, worst on Reset (a destructive, take-a-moment action) but true of
 * every control.
 *
 * **Three states, tracked explicitly — never `:hover`, never bare
 * `:active`** (Section 24: "must not depend on `:hover`... make sure
 * this works on iPhone Safari"): iOS Safari's own `:active` pseudo-class
 * is unreliable on a plain element with no touch listener anywhere in
 * its ancestry (a long-standing WebKit quirk, not something a CSS
 * tweak alone fixes reliably). This uses real `onPointerDown`/`onPointerUp`/
 * `onPointerLeave`/`onPointerCancel` handlers instead — the same pointer-
 * event discipline this panel's own header-drag handling already uses
 * (see `handleHeaderPointerDown` et al.) — so "pressed" is genuine
 * boolean React state, not a pseudo-class hoping the browser cooperates.
 *
 * - **Resting**: the caller's own `className` (color/variant), unmodified.
 * - **Pressed**: `brightness-75` for as long as a pointer is actually
 *   down on this button — released on pointer up, leave, *or* cancel
 *   (a finger dragging off the button before lifting must not leave it
 *   stuck "pressed").
 * - **Executing**: only entered when `onClick` returns a `Promise` (a
 *   genuinely asynchronous action) — `opacity-60` plus the native
 *   `disabled` attribute, which is what actually prevents a duplicate
 *   invocation while the first is still in flight (Section 25) and, as
 *   a side effect, correctly suppresses hover/active on every browser.
 *   A synchronous `onClick` (an instant, deterministic generation
 *   action) never enters this state at all — repeated taps stay exactly
 *   as responsive as before (Section 25: "preserve intentional repeated
 *   tapping where appropriate... do not globally debounce every
 *   control").
 *
 * `preventDuplicate` defaults to `true` for any async action; passing
 * `false` opts a specific async control back out (none currently need
 * to, but the escape hatch exists rather than hard-coding the
 * assumption into the state machine itself).
 */
export function SimButton({
  onClick,
  children,
  className,
  disabled = false,
  preventDuplicate = true,
  ...rest
}: {
  onClick: () => void | Promise<void>;
  children: ReactNode;
  className: string;
  /** External disable — e.g. Stop disabled while nothing is running. Independent of this button's own internal executing state. */
  disabled?: boolean;
  preventDuplicate?: boolean;
  "data-testid"?: string;
  "aria-label"?: string;
}) {
  const [pressed, setPressed] = useState(false);
  const [executing, setExecuting] = useState(false);

  function handlePointerDown(event: ReactPointerEvent<HTMLButtonElement>) {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    setPressed(true);
  }
  function releasePress() {
    setPressed(false);
  }

  function handleClick() {
    const result = onClick();
    if (result && typeof result.then === "function") {
      setExecuting(true);
      void result.finally(() => setExecuting(false));
    }
  }

  const effectivelyDisabled = disabled || (executing && preventDuplicate);

  return (
    <button
      type="button"
      onPointerDown={handlePointerDown}
      onPointerUp={releasePress}
      onPointerLeave={releasePress}
      onPointerCancel={releasePress}
      onClick={handleClick}
      disabled={effectivelyDisabled}
      data-pressed={pressed || undefined}
      data-executing={executing || undefined}
      className={cn(
        className,
        "transition-[filter,opacity] disabled:pointer-events-none disabled:opacity-60",
        pressed && !effectivelyDisabled && "brightness-75",
      )}
      {...rest}
    >
      {children}
    </button>
  );
}
