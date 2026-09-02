"use client";

import { useState } from "react";
import { FollowButton } from "@/components/profile/follow-button";

/**
 * Issue #29, Section 9/11: pairs the Follow button with the follower
 * count so a tap updates the count immediately (optimistic, matching
 * `FollowButton`'s own optimistic toggle) — the two have to live
 * together in one client component for that, rather than the count
 * staying a server-rendered static number on the page around it.
 */
export function FollowButtonSection({
  targetProfileId,
  initiallyFollowing,
  initialFollowerCount,
  initialFollowingCount,
}: {
  targetProfileId: string;
  initiallyFollowing: boolean;
  initialFollowerCount: number;
  initialFollowingCount: number;
}) {
  const [followerCount, setFollowerCount] = useState(initialFollowerCount);

  return (
    <div className="flex flex-col items-end gap-2">
      <FollowButton targetProfileId={targetProfileId} initiallyFollowing={initiallyFollowing} onCountChange={(delta) => setFollowerCount((c) => c + delta)} />
      <div className="flex gap-3 text-sm">
        <span data-testid="follower-count">
          <span className="font-semibold">{followerCount}</span> <span className="text-muted">Followers</span>
        </span>
        <span data-testid="following-count">
          <span className="font-semibold">{initialFollowingCount}</span> <span className="text-muted">Following</span>
        </span>
      </div>
    </div>
  );
}
