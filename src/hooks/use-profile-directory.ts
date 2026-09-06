"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

export type ProfileDirectoryEntry = { username: string; avatarUrl: string | null };

/**
 * Issue #29 (first profile/social-identity pass), Sections 15/17: the
 * live room's own identity directory — resolves a set of `profile_id`s
 * (from currently-visible speakers/comments/RTS requests) to
 * `{username, avatarUrl}` so `ProfileLink`/`ParticipantAvatar` can make
 * a registered identity tappable and show their current avatar,
 * without duplicating profile data into `event_speakers`/
 * `event_chat_messages`/`speaker_requests` themselves. Deliberately
 * does **not** touch the `display_name` a caller already has — those
 * stay exactly the historical per-episode/per-message snapshot they
 * already are (see `event_speakers.display_name`'s own doc comment);
 * only the avatar image and the tap-to-profile link are "live," since
 * neither one existed at all before this pass, so there's no existing
 * snapshot invariant to preserve for them.
 *
 * Reads `public_profiles` directly via the browser client — the same
 * documented "calls Supabase directly" exception `useActiveSpeakers`/
 * `useLobbyRealtime` already use for live, Realtime-adjacent reads,
 * extended here rather than adding a server-action round-trip for a
 * value that's already anon-readable (`public_profiles` has no RLS gap
 * to route around — see migration 00000000000044's own doc comment).
 * A `profile_id` with no entry in the returned map means "no public
 * profile yet" (a guest, or an account that hasn't chosen a username) —
 * callers treat that identically either way (non-navigable, initials
 * fallback).
 */
export function useProfileDirectory(profileIds: string[]): Record<string, ProfileDirectoryEntry> {
  const idsKey = [...new Set(profileIds)].sort().join(",");
  const [directory, setDirectory] = useState<Record<string, ProfileDirectoryEntry>>({});

  useEffect(() => {
    let cancelled = false;

    // The `await` (a genuine microtask yield, matching
    // `useAutomaticPromotion`'s own established pattern for this exact
    // lint rule) is what makes every `setDirectory` call below happen in
    // a callback continuation, never synchronously within the effect
    // body itself — `react-hooks/set-state-in-effect` flags the latter.
    async function load() {
      await Promise.resolve();
      if (cancelled) return;

      if (idsKey === "") {
        setDirectory({});
        return;
      }
      const supabase = createClient();
      const { data } = await supabase.from("public_profiles").select("id, username, avatar_url").in("id", idsKey.split(","));
      if (cancelled) return;
      const next: Record<string, ProfileDirectoryEntry> = {};
      for (const row of data ?? []) {
        if (row.id && row.username) next[row.id] = { username: row.username, avatarUrl: row.avatar_url };
      }
      setDirectory(next);
    }
    void load();

    return () => {
      cancelled = true;
    };
    // idsKey is the intentional dependency — see this hook's own doc
    // comment for why (a stable, sorted, deduplicated key), not the raw
    // `profileIds` array reference, which changes on every unrelated
    // parent re-render.
  }, [idsKey]);

  return directory;
}
