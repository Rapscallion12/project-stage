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
 */
export function GuestNameEditor({ initialName }: { initialName: string }) {
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
        className="h-8 py-1 text-sm"
        autoFocus
      />
      <button type="submit" disabled={pending} className="text-xs text-accent hover:underline">
        Save
      </button>
    </form>
  );
}
