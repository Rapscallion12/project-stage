"use client";

import { useRef, useState, useTransition } from "react";
import { setGuestName } from "@/app/events/[id]/lobby/actions";
import { Input } from "@/components/ui/input";

/**
 * Lets a guest pick their own name instead of the generated default —
 * only affects messages sent *after* saving (already-sent messages keep
 * their snapshot; see the migration's author_display_name comment).
 * Never shown to account holders, whose name comes from their profile.
 *
 * **Commits on blur (real-device fix, 2026-08-22)**: the editor used to
 * only ever exit editing mode from the form's own `onSubmit` — tapping
 * elsewhere, or dismissing the keyboard, fired neither a click on
 * anything in this component nor a submit, so the editor was left
 * stuck open. Every one of those "outside" interactions (tapping
 * Comments, a speaker tile, the stage, dismissing the keyboard) already
 * fires a native `blur` on the input first, since focus is moving away
 * from it — that's the one event common to all of them, so committing
 * there needs no separate document-level click listener. `onSubmit`
 * (Enter/Done) doesn't save independently; it just blurs the input, so
 * there is exactly one commit path, not two that could race each other
 * on a real double-tap. Validation is unchanged from before this fix:
 * `setGuestName` still silently declines to exit editing mode on an
 * empty name — this fix doesn't add a new rule or an error message
 * that didn't already exist.
 *
 * `variant` (issue #21, 05 interaction model): `"inline"` (default) is
 * this component's original text-link presentation, unchanged — every
 * existing caller keeps today's exact appearance. `"chip"` is an
 * additive visual mode for the new minimal Watch Mode top chrome (a
 * small avatar-circle + name pill instead of a text sentence) — same
 * state machine, same commit-on-blur behavior, same server action,
 * only the rendered markup differs. Added as a variant rather than a
 * new component so the tricky blur-commit logic isn't duplicated.
 *
 * **No `text-sm` override on the edit `<Input>`** (real-device finding,
 * issue #18 Speaker View corrective pass): this used to pass
 * `text-sm` (14px) in both variants' className, which `cn()`'s
 * `twMerge` resolves as an override of `<Input>`'s own `text-base`
 * default — silently defeating the exact iOS-Safari-auto-zoom-on-focus
 * fix that default exists for (see `Input`'s own comment; the same bug
 * was already found and fixed once for the Watch Mode composer, see
 * DECISIONS.md's 2026-08-23 entry — it just hadn't been checked here
 * too). Leaving font-size out of this component's className entirely
 * lets `<Input>`'s own 16px default apply untouched, in both variants.
 */
export function GuestNameEditor({
  initialName,
  variant = "inline",
}: {
  initialName: string;
  variant?: "inline" | "chip";
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(initialName);
  const [pending, startTransition] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);

  function commit() {
    startTransition(async () => {
      const result = await setGuestName(name);
      if (!result.error) setEditing(false);
    });
  }

  if (!editing) {
    if (variant === "chip") {
      return (
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="flex items-center gap-2 rounded-full border border-white/30 bg-white/[0.14] py-1 pr-3 pl-1 text-xs text-white/85"
        >
          <span
            aria-hidden="true"
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent text-[10px] font-semibold text-white"
          >
            {name.trim().slice(0, 1).toUpperCase() || "?"}
          </span>
          <span className="max-w-[9rem] truncate">{name}</span>
        </button>
      );
    }
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="text-xs text-muted hover:underline"
      >
        You&apos;re <span className="font-medium">{name}</span> — change name
      </button>
    );
  }

  return (
    <form
      data-testid="guest-name-form"
      className="flex items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        inputRef.current?.blur();
      }}
    >
      <Input
        ref={inputRef}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={commit}
        maxLength={40}
        className={variant === "chip" ? "h-8 w-32 py-1" : "h-8 py-1"}
        autoFocus
      />
      {variant !== "chip" && (
        <button type="submit" disabled={pending} className="text-xs text-accent hover:underline">
          Save
        </button>
      )}
    </form>
  );
}
