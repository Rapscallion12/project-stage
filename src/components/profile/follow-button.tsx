"use client";

import { useState, useTransition } from "react";
import { followProfileAction, unfollowProfileAction } from "@/app/profile/actions";
import { Button } from "@/components/ui/button";

/**
 * Issue #29, Section 11: "If a guest taps Follow, a lightweight signup/
 * login prompt is acceptable because Follow inherently requires
 * persistent identity." Never on page load, never for the profile
 * owner's own page (the caller simply doesn't render this component
 * there) — only surfaces once an actual tap hits the account-only gate
 * inside the server action, matching every other account-gated action
 * in this app (mic request, RTS).
 */
export function FollowButton({
  targetProfileId,
  initiallyFollowing,
  onCountChange,
}: {
  targetProfileId: string;
  initiallyFollowing: boolean;
  /** Optimistic local count adjustment — the page's own follower count updates immediately on tap, same "explicit, immediate feedback" discipline the rest of this app's optimistic actions already use (e.g. comment likes). */
  onCountChange?: (delta: 1 | -1) => void;
}) {
  const [following, setFollowing] = useState(initiallyFollowing);
  const [pending, startTransition] = useTransition();
  const [promptSignup, setPromptSignup] = useState(false);

  function toggle() {
    const wasFollowing = following;
    setFollowing(!wasFollowing);
    onCountChange?.(wasFollowing ? -1 : 1);
    startTransition(async () => {
      const result = wasFollowing ? await unfollowProfileAction(targetProfileId) : await followProfileAction(targetProfileId);
      if ("error" in result) {
        // Roll back the optimistic update — the action didn't succeed.
        setFollowing(wasFollowing);
        onCountChange?.(wasFollowing ? 1 : -1);
        setPromptSignup(true);
      }
    });
  }

  if (promptSignup) {
    return (
      <div className="flex items-center gap-2 text-sm">
        <span className="text-muted">Create an account to follow people.</span>
        <a href="/signup" className="font-medium text-accent hover:underline">
          Sign up
        </a>
      </div>
    );
  }

  return (
    <Button type="button" variant={following ? "secondary" : "primary"} disabled={pending} onClick={toggle} data-testid="follow-button">
      {following ? "Following" : "Follow"}
    </Button>
  );
}
