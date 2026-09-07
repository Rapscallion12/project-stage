"use client";

import { startTransition, useActionState, useEffect, useRef, useState, type FormEvent } from "react";
import { sendMessage } from "@/app/events/[id]/lobby/actions";
import { submitSpeakerRequest } from "@/app/events/[id]/room/actions";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { MessageItem } from "@/components/lobby/message-item";
import type { LobbyMessage, ReactionState } from "@/hooks/use-lobby-realtime";
import type { MediaReadinessState } from "@/hooks/use-live-room-connection";

const QUICK_EMOJI = ["😂", "🔥", "👀", "❤️", "😮", "🎉"];

/**
 * One composer, two modes (issue #27) — never a second form elsewhere in
 * the room. Normal mode posts a chat message (`sendMessage`, unchanged);
 * activating 🎤 switches the *same* input/button pair into speaker-
 * request mode (`submitSpeakerRequest`, a thin adapter over the existing
 * authoritative `requestToSpeak` — see room/actions.ts), which both
 * posts the request's badged chat message and creates its
 * `speaker_requests` row atomically, exactly as the removed standalone
 * "Request the mic" form already did. Two separate `useActionState`
 * hooks (one per action, `useActionState` only ever binds one action
 * each) rather than one, but only one input/button pair is ever
 * rendered — the mode decides which hook's state/action/pending governs
 * it, not which component is mounted.
 *
 * `micRequestMode` is a controlled prop, not local state — tapping an
 * empty seat that turns out to have a queue (see `SpeakerTile`/
 * `EventRoom`) needs to switch this *same* composer into request mode
 * from outside it, which only works if something above both can set it.
 *
 * Issue #22: submitting the request form is also the gesture that
 * acquires camera/mic (`onPrepareMedia`) — called directly from
 * `handleSubmit` (the form's own `onSubmit`, see the real-device
 * submission-reliability doc comment on `draft`/`handleSubmit` below for
 * why this is now the *only* submit path at all), synchronously, in the
 * same call stack as the click/tap or Enter keypress that triggered it.
 * This is deliberately a plain, direct call — never chained off the
 * server action's own pending state or a `.then()` — same Safari gesture
 * requirement as `activateMedia` (see useLiveRoomConnection). Ordinary
 * comment submission never touches `onPrepareMedia` at all — only the
 * `micRequestMode` branch of `handleSubmit` calls it, so a plain "just
 * commenting" viewer is never prompted for camera/mic permission.
 *
 * `compact` (issue #21, "05 — Social Stage" Phase 2): renders only the
 * form itself — no message history, no quick-emoji row — as a small
 * translucent "glass" pill for Watch Mode's persistent bottom
 * composer. Same two `useActionState` hooks, same `micRequestMode`
 * contract, same synchronous `onPrepareMedia()` submit order as above
 * — nothing about the actions/gesture-safety logic is duplicated or
 * reimplemented, only the JSX differs. `messages`/`reactions` are
 * simply unused in this mode (still required props so callers that
 * already have them in scope — `RoomLayoutProps` — don't need a
 * separate code path to obtain them).
 *
 * `allowMicRequest` (issue #18, Speaker View Phase 2): defaults to `true`
 * (every existing caller unaffected). `false` hides the 🎙 toggle button
 * entirely in compact mode — not just disables it — since a seated
 * speaker has no use for requesting the mic they already hold. The
 * caller is responsible for also keeping `micRequestMode` false; this
 * prop only controls whether the toggle is offered at all.
 *
 * `hasPendingRequest`/`onCancelPendingRequest` (issue #18 UX finding,
 * real-device report: a persistent "Request sent · Cancel" bar rendered
 * *underneath* this same composer, overlapping the ambient request
 * comment and reading as broken UI once the compact bottom row got
 * crowded). That bar is gone — the existing badged ambient "requesting
 * the mic" chat message (see `MessageItem`/`AmbientComments`) is already
 * the social feedback a request went through; this composer's own mic
 * button now carries the pending state instead of a second, separate
 * element. Three states, one button: idle (gray, tap → open the
 * request-mode input), actively composing a not-yet-submitted request
 * (`micRequestMode`, solid accent — unchanged), and sent-but-not-yet-
 * promoted (`hasPendingRequest` while `micRequestMode` is false, a
 * lighter pulsing accent) — tapping in the third state calls
 * `onCancelPendingRequest` (the same `onCancelPromotion` action the old
 * bar's own Cancel button already called — issue #23's automatic
 * promotion has always supported cancelling a request whether or not its
 * countdown has actually started) instead of re-opening the input. Both
 * props default to `false`/`undefined` — every existing caller (which
 * never had a pending-request concept to show) is unaffected. Once a
 * request is actually accepted, `EventRoom`'s own `promotionCountdown`
 * takes the *whole* composition over to the center-stage countdown (see
 * `PortraitRoom`/`MobileLandscapeRoom`), so this component isn't even
 * mounted by then — there is no intermediate "request sent" screen
 * between this pending state and the countdown.
 *
 * **`landscape:max-w-[40%]` on the compact form** (real-device finding,
 * issue #21): `WatchModeControls`' row gives this composer no explicit
 * width of its own — it grows to fill whatever space isn't claimed by
 * the fixed-size emblems beside it, which in **portrait** (a genuinely
 * narrow viewport) reads fine, but in **landscape** (a much wider one)
 * stretched the composer across most of the screen before React/Vote/
 * Gift, reading as unbalanced. Capped with Tailwind's built-in
 * `landscape:` variant (`@media (orientation: landscape)`) — safe to use
 * bare here, unlike the app's own hand-written media queries elsewhere
 * that also exclude a desktop window by height: `compact` mode is never
 * rendered outside the four mobile room compositions
 * (`PortraitRoom`/`MobileLandscapeRoom`, audience or speaker) — `DesktopRoom`
 * uses the non-compact `ChatPanel` via `RoomChatPanel` instead — so there
 * is no desktop-landscape case for this rule to ever mistakenly catch.
 * Purely a max-width cap, not a fixed size: `flex-1`/`min-w-0` (see
 * below) still let it grow and shrink normally up to that ceiling, so
 * narrow landscape phones aren't forced into an oversized minimum. One
 * change here covers both Watch Mode and Speaker View in landscape,
 * since both render this exact component.
 *
 * `min-w-0` at every level of the compact form (real-device finding,
 * 2026-08-23): the row this composer sits in (`WatchModeControls`) has
 * three `shrink-0` emblems beside it by design — the composer is the
 * only thing allowed to shrink to make room. A flex item's default
 * `min-width` is `auto` (its own content's natural size), not `0` — on
 * a narrow phone that silently capped how far the composer could
 * actually shrink, pushing the rightmost emblem (Gift) partially
 * off-screen instead of compressing the composer further. `min-w-0` has
 * to be set on every nested flex container between the row and the
 * `<input>` (the form, the pill, the input itself) — missing it on just
 * one link breaks the whole chain, since that ancestor's own unshrunk
 * content width becomes the effective floor for everything below it.
 *
 * **`text-base`, not `text-sm`, on the compact `<input>`** (real-device
 * finding, 2026-08-23): focusing the compact composer was triggering
 * iOS Safari's native auto-zoom-on-focus, panning/shifting the whole
 * page. Verified, not assumed, before touching anything: no
 * `fontSize`/root-`html` overrides exist anywhere in this project (no
 * `tailwind.config`, nothing in `globals.css`), so Tailwind's stock
 * scale applies — `text-sm` is 14px, under Safari's 16px threshold;
 * `text-base` is 16px. No `transform`/`scale`/`zoom` exists on any
 * ancestor in the room tree, and there's no app-level
 * `scrollIntoView`/`visualViewport` code anywhere in this codebase —
 * the pan the user saw is Safari's own zoom mechanism, not a second,
 * compounding bug. The shared `<Input>` component
 * (`src/components/ui/input.tsx`) already documents this exact
 * constraint; this raw `<input>` (needed for the compact glass-pill
 * layout, which `<Input>`'s own fixed styling doesn't support) had
 * drifted from it. Same input renders for both mic-off and mic-on
 * states, so this one fix covers both — see the compact `<input>`'s own
 * className.
 */
export function ChatPanel({
  eventId,
  messages,
  reactions,
  micRequestMode,
  onMicRequestModeChange,
  onHasPendingRequestChange,
  onPrepareMedia,
  compact = false,
  allowMicRequest = true,
  hasPendingRequest = false,
  onCancelPendingRequest,
  idle = false,
}: {
  eventId: string;
  messages: LobbyMessage[];
  reactions: Record<string, ReactionState>;
  micRequestMode: boolean;
  onMicRequestModeChange: (value: boolean) => void;
  onHasPendingRequestChange: (value: boolean) => void;
  onPrepareMedia: () => Promise<MediaReadinessState>;
  compact?: boolean;
  allowMicRequest?: boolean;
  /** Issue #18 UX finding: drives the mic button's third (pending) visual state — see this component's own doc comment. */
  hasPendingRequest?: boolean;
  /** Called instead of re-opening the request-mode input when the mic button is tapped while a request is already pending. */
  onCancelPendingRequest?: () => void;
  /**
   * Pre-launch interaction pass, Section 8 follow-up (real-device
   * finding: the first pass's idle fade excluded this component
   * entirely, but the compact composer pill is the *widest* surface in
   * Watch Mode's bottom row — leaving it out meant idle barely looked
   * different). Fades only this pill's own background fill toward
   * transparent, never its border, text, mic icon, or the accent
   * mic-request-mode treatment (an active state, not idle chrome).
   * Non-compact (lobby) rendering is untouched regardless — this only
   * ever applies to the `compact` branch below. Defaults to `false`, so
   * every other caller (the lobby proper, and any test that doesn't
   * pass it) is unaffected.
   */
  idle?: boolean;
}) {
  const [sendState, sendFormAction, sendPending] = useActionState(sendMessage.bind(null, eventId), undefined);
  const [requestState, requestFormAction, requestPending] = useActionState(
    submitSpeakerRequest.bind(null, eventId),
    undefined,
  );
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const wasPending = useRef(false);
  // Real-device report ("send is unreliable, draft doesn't consistently
  // clear"): the previous fix (capture-in-onSubmit, restore-on-error)
  // patched a symptom of the actual problem — this form submitted via a
  // native `<form action={...}>`, which hands React's own automatic
  // form-reset behavior *and* this component's own manual `ref.value =`
  // manipulation joint, uncoordinated control over the same uncontrolled
  // DOM node, around the exact same pending->settled moment. Two
  // separate mechanisms racing to decide what the input should show is
  // exactly what "unreliable" looks like — sometimes React's own reset
  // wins, sometimes the manual restore wins, depending on timing that
  // was never actually guaranteed either way.
  //
  // **Fix — one clear state model, not two** (explicit instruction):
  // `draft` below is now the *only* thing that decides what the input
  // shows — a fully controlled input, never let out of React's hands.
  // React's own automatic form-reset can't fight a controlled value: on
  // every render the input is forced back to `value={draft}` regardless
  // of anything the DOM itself tried to reset. The `<form>` no longer
  // has an `action` prop at all — `handleSubmit` below (shared by both
  // the visible arrow *and* keyboard Enter, since both are just ways of
  // firing this same form's `submit` event) drives the action's own
  // dispatch function directly, so this component owns the entire
  // submit->settle sequence explicitly instead of leaning on the
  // browser's native form-submission semantics for any part of it.
  const [draft, setDraft] = useState("");
  // Real-device report, Section 5 ("exactly-once UI submission"): a
  // synchronous re-entrancy guard, same reasoning as this codebase's
  // other in-flight refs (`resetInFlightRef`, `startupInFlightRef` in
  // the Session Simulator panel, `useDoubleTap`'s own tap-pair guard) —
  // `pending` from `useActionState` is real, but it's a state value that
  // updates a render *after* this handler runs, so it can't by itself
  // prevent two submissions dispatched within the same tick (a fast
  // double-tap, or a tap immediately followed by an Enter keypress
  // before React has re-rendered the disabled button).
  const submittingRef = useRef(false);
  // Real-device report: a *second* real bug, found only by actually
  // driving this against the real backend (not assumed) — the naive
  // "success clears the draft" effect below used to unconditionally
  // `setDraft("")`, with no idea *what* had actually been submitted. A
  // completely ordinary sequence — type comment 1, hit send, immediately
  // start typing comment 2 while comment 1 is still round-tripping —
  // meant comment 1's own *later* success would wipe out comment 2's
  // already-in-progress draft the moment it settled, with no warning.
  // This is exactly the kind of "sometimes my typing just vanishes"
  // unreliability a real user reports as "the composer doesn't work,"
  // without a repro as clean as a single failed send. Captured here at
  // submit time; the settle effect below only clears `draft` if it still
  // *equals* what this specific submission actually sent — if the user
  // has since changed it, their newer, not-yet-submitted text is never
  // touched.
  const submittedValueRef = useRef("");

  const pending = micRequestMode ? requestPending : sendPending;
  const error = micRequestMode ? requestState?.error : sendState?.error;

  // On settle: success clears the draft (but only if it's still exactly
  // what was submitted — see `submittedValueRef`'s own doc comment) and
  // refocuses (no error from whichever mode was actually active — not
  // both raw states, since a stale error from the *other* mode's last
  // attempt must never block this one) and releases the re-entrancy
  // guard; failure does nothing to `draft` at all — it was never touched
  // before this point (Section 4: "do not clear before success"), so
  // it's still exactly what the user typed, ready to retry. Covers both
  // modes, since only one is ever pending at a time. A successful
  // request also flips hasPendingRequest and drops back to normal mode,
  // the same way a granted claim already updates RoomControls elsewhere.
  useEffect(() => {
    if (wasPending.current && !pending) {
      submittingRef.current = false;
      if (!error) {
        const justSubmitted = submittedValueRef.current;
        // `queueMicrotask` — this codebase's own established way of
        // keeping a settle-triggered state update out of
        // `react-hooks/set-state-in-effect`'s "synchronous setState
        // inside an effect" flag (see e.g. ExpandedComments' own
        // anchoring effect, or useAutomaticPromotion's `await
        // Promise.resolve()` for the async-function equivalent) —
        // clearing the draft has no synchronous-with-render timing
        // requirement the way a pre-paint scroll adjustment would.
        queueMicrotask(() => setDraft((current) => (current === justSubmitted ? "" : current)));
        inputRef.current?.focus();
        if (micRequestMode) {
          onHasPendingRequestChange(true);
          onMicRequestModeChange(false);
        }
      }
    }
    wasPending.current = pending;
    // Deliberately not depending on the callbacks themselves — this
    // effect only cares about the pending->settled transition, the same
    // "did the transition just happen" check the original single-mode
    // version used.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, error]);

  /**
   * The one authoritative submit path (Section 2's own explicit
   * requirement) — bound to the `<form>`'s own `onSubmit`, which fires
   * identically whether triggered by tapping the visible arrow
   * (`<button type="submit">`) or by the keyboard's Enter/Return/Go
   * action on this single-line input (the browser's own native
   * single-input-form-submits-on-Enter behavior, not anything this
   * component has to wire up itself) — one handler, one validation path,
   * one pending/settle lifecycle, never two slightly different ones to
   * keep in sync by hand.
   */
  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submittingRef.current) return; // exactly-once guard — see submittingRef's own doc comment
    const trimmed = draft.trim();
    if (!trimmed) return; // empty/whitespace draft — silently do nothing, same as the server's own validation would reject anyway
    submittingRef.current = true;
    submittedValueRef.current = draft; // see this ref's own doc comment above

    // Issue #22: acquiring camera/mic must stay a *direct*, synchronous
    // call from this same gesture — see this component's own doc
    // comment on `onPrepareMedia` for the Safari user-activation
    // requirement this preserves unchanged.
    if (micRequestMode) void onPrepareMedia();

    const formData = new FormData();
    formData.set("body", draft);
    const dispatch = micRequestMode ? requestFormAction : sendFormAction;
    startTransition(() => {
      dispatch(formData);
    });
  }

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages.length]);

  function insertEmoji(emoji: string) {
    setDraft((current) => current + emoji);
    inputRef.current?.focus();
  }

  const form = (
    <form
      data-testid="chat-composer-form"
      onSubmit={handleSubmit}
      className={compact ? "flex min-w-0 items-center gap-2 landscape:max-w-[40%]" : "flex gap-2"}
    >
      {compact ? (
        <div
          className={cn(
            "flex h-11 min-w-0 flex-1 items-center gap-2 rounded-full border px-1 pr-3 transition-colors duration-300",
            micRequestMode ? "border-accent/60 bg-accent/15" : cn("border-white/30", idle ? "bg-transparent" : "bg-white/[0.14]"),
          )}
        >
          {allowMicRequest && (
            <button
              type="button"
              data-testid="watch-composer-mic"
              // Issue #21, fourth corrective pass, real-device finding:
              // toggling Request-to-Speak while typing a comment was
              // dismissing the keyboard and losing the draft's focus.
              // Root cause: tapping *any* focusable element (this button
              // included) is the browser's own default behavior for
              // shifting focus away from whatever was previously focused
              // (the input) — on iOS Safari that focus loss is what
              // closes the virtual keyboard, before this button's own
              // onClick ever runs. `preventDefault()` on `mousedown` (the
              // event that actually triggers the focus shift, ahead of
              // `click`) stops the browser from ever moving focus off the
              // input in the first place — the input's value, cursor
              // position, and scroll position are all untouched because
              // nothing ever blurred it. No compensating refocus-after-
              // blur logic is added deliberately (that would still be
              // visible as a flicker); this prevents the blur instead of
              // reacting to it.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                if (hasPendingRequest && !micRequestMode) {
                  onCancelPendingRequest?.();
                  return;
                }
                onMicRequestModeChange(!micRequestMode);
              }}
              disabled={pending}
              aria-pressed={micRequestMode || hasPendingRequest}
              aria-label={
                micRequestMode || hasPendingRequest ? "Cancel speaker request" : "Request to speak"
              }
              className={cn(
                "flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full text-xs transition-colors disabled:opacity-50",
                micRequestMode
                  ? "bg-accent text-white"
                  : hasPendingRequest
                    ? "animate-pulse bg-accent/30 text-accent"
                    : "bg-white/10 text-white/80",
              )}
            >
              🎙
            </button>
          )}
          <input
            ref={inputRef}
            name="body"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={micRequestMode ? "What's your topic?" : "Add a comment…"}
            autoComplete="off"
            maxLength={500}
            // Real-device report: Enter/Return on this single-line input
            // already submits the form natively (the browser's own
            // single-text-input behavior) — that submit event runs
            // `handleSubmit` above, the exact same authoritative path the
            // arrow button's own `type="submit"` triggers. No separate
            // `onKeyDown` handler exists, deliberately: a second, hand-
            // maintained keyboard-submit path is exactly what Section 2
            // explicitly ruled out.
            //
            // text-base (16px), not text-sm: iOS Safari auto-zooms the
            // page on focus for any input under 16px — see real-device
            // finding below. Same convention the shared <Input> component
            // already documents; this raw <input> (needed for the compact
            // glass-pill layout) had drifted from it.
            className="min-w-0 flex-1 bg-transparent text-base text-white placeholder:text-white/50 focus:outline-none"
          />
          <button
            type="submit"
            disabled={pending}
            aria-label={micRequestMode ? "Send speaker request" : "Send comment"}
            // Real-device report, Section 10: the glyph itself is tiny —
            // this button's own tap target now extends well past it
            // (36px, comfortably closer to the ~44px mobile guideline
            // than the previous 24px box) via padding, not a bigger
            // icon. `-m-1.5`/matching padding keeps the *visual* pill
            // size in the composer unchanged while the actual hit-tested
            // element underneath is larger — confirmed no sibling/
            // ancestor overlays or pointer-capture intercept taps here
            // (see this file's own drag-handle doc comment for the one
            // place that pattern existed, and why it's excluded from
            // ever reaching this composer at all — it's a sibling
            // section, never a wrapping ancestor).
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/15 text-sm text-white disabled:opacity-50"
          >
            ↑
          </button>
        </div>
      ) : (
        <>
          <button
            type="button"
            // See the compact mic button's own comment above — same fix,
            // same reasoning, this is the non-compact render of the
            // identical control.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onMicRequestModeChange(!micRequestMode)}
            disabled={pending}
            aria-pressed={micRequestMode}
            aria-label={micRequestMode ? "Cancel speaker request" : "Request to speak"}
            className={cn(
              "flex min-h-11 w-11 shrink-0 items-center justify-center rounded-full border text-base transition-colors disabled:opacity-50",
              micRequestMode
                ? "border-accent bg-accent/15 text-accent"
                : "border-border text-muted hover:bg-surface-hover",
            )}
          >
            🎤
          </button>
          <Input
            ref={inputRef}
            name="body"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={micRequestMode ? "What do you want to talk about?" : "Say something…"}
            autoComplete="off"
            maxLength={500}
            required
            className="flex-1"
          />
          <Button type="submit" disabled={pending}>
            {micRequestMode ? (pending ? "Requesting…" : "Request") : pending ? "Sending…" : "Send"}
          </Button>
        </>
      )}
    </form>
  );

  if (compact) {
    return (
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        {form}
        {error && (
          <p className="rounded-lg bg-black/35 px-3 py-1.5 text-xs text-red-400" role="alert">
            {error}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={listRef} className="flex-1 overflow-y-auto px-4 py-2">
        {messages.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted">
            No messages yet — say hello.
          </p>
        ) : (
          <div className="divide-y divide-border">
            {messages.map((message) => (
              <MessageItem key={message.id} message={message} reaction={reactions[message.id]} />
            ))}
          </div>
        )}
      </div>

      <div className="border-t border-border p-3">
        <div className="mb-2 flex gap-1">
          {QUICK_EMOJI.map((emoji) => (
            <button
              key={emoji}
              type="button"
              onClick={() => insertEmoji(emoji)}
              className="rounded-md px-1.5 py-0.5 text-base hover:bg-surface-hover"
              aria-label={`Insert ${emoji}`}
            >
              {emoji}
            </button>
          ))}
        </div>
        {form}
        {error && (
          <p className="mt-1.5 text-xs text-red-500" role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
