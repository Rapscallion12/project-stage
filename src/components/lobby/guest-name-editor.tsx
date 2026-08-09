"use client";

import { useState, useTransition } from "react";
import { setGuestName } from "@/app/events/[id]/lobby/actions";
import { Input } from "@/components/ui/input";

/**
 * Lets a guest pick their own name instead of the generated default —
 * only affects messages sent *after* saving (already-sent messages keep
 * their snapshot; see the migration's author_display_name comment).
 * Never shown to account holders, whose name comes from their profile.
 */
export function GuestNameEditor({ initialName }: { initialName: string }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(initialName);
  const [pending, startTransition] = useTransition();

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
      className="flex items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        startTransition(async () => {
          const result = await setGuestName(name);
          if (!result.error) setEditing(false);
        });
      }}
    >
      <Input
        value={name}
        onChange={(e) => setName(e.target.value)}
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
