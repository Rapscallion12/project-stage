"use server";

import { revalidatePath } from "next/cache";
import { resolveIdentity } from "@/lib/identity";
import { updateOwnProfile, updateOwnAvatarUrl } from "@/lib/repositories/profiles";
import { followProfile as followProfileRepo, unfollowProfile as unfollowProfileRepo } from "@/lib/repositories/follows";
import { validateUsername, normalizeUsername } from "@/lib/username";
import { normalizeSocialLinks, SocialLinkValidationError } from "@/lib/social-links";

export type SaveProfileState =
  | { status: "error"; field: "username" | "displayName" | "bio" | "social" | "general"; message: string }
  | { status: "success"; username: string }
  | undefined;

/**
 * Issue #29: the one explicit Save action for Edit Profile (Section 13
 * — no per-keystroke writes). Account-only, gated *inside* the action
 * per AGENTS.md's progressive-authentication rule — never a redirect,
 * a guest reaching this (e.g. a stale tab) gets a specific,
 * benefit-framed rejection, same as every other account-gated action in
 * this app (`claimOpenSeat`, mic request).
 */
export async function saveProfile(_prevState: SaveProfileState, formData: FormData): Promise<SaveProfileState> {
  const identity = await resolveIdentity();
  if (identity.type !== "profile") {
    return { status: "error", field: "general", message: "Create an account to set up your Virtual Stage profile." };
  }

  const displayName = String(formData.get("displayName") ?? "").trim();
  if (displayName.length < 1) {
    return { status: "error", field: "displayName", message: "Display name can't be empty." };
  }
  if (displayName.length > 50) {
    return { status: "error", field: "displayName", message: "Display name must be 50 characters or fewer." };
  }

  const rawUsername = String(formData.get("username") ?? "");
  const username = normalizeUsername(rawUsername);
  const usernameError = validateUsername(username);
  if (usernameError) {
    return { status: "error", field: "username", message: usernameError };
  }

  const rawBio = String(formData.get("bio") ?? "").trim();
  if (rawBio.length > 160) {
    return { status: "error", field: "bio", message: "Bio must be 160 characters or fewer." };
  }
  const bio = rawBio.length > 0 ? rawBio : null;

  const socialInput: Record<string, string> = {};
  for (const platformId of ["instagram", "tiktok", "youtube", "twitter", "twitch", "website"]) {
    socialInput[platformId] = String(formData.get(`social_${platformId}`) ?? "");
  }
  let socialLinks: Record<string, string>;
  try {
    socialLinks = normalizeSocialLinks(socialInput);
  } catch (error) {
    if (error instanceof SocialLinkValidationError) {
      return { status: "error", field: "social", message: error.message };
    }
    return { status: "error", field: "general", message: "Couldn't save your social links." };
  }

  const updateError = await updateOwnProfile(identity.id, { displayName, username, bio, socialLinks });
  if (updateError) {
    return { status: "error", field: updateError.field, message: updateError.message };
  }

  revalidatePath(`/profile/${username}`);
  revalidatePath("/profile/edit");
  return { status: "success", username };
}

export type AvatarActionState = { error: string } | { ok: true } | undefined;

/** Called right after a successful Storage upload — see `lib/avatar-upload.ts`'s own doc comment for why the upload itself happens client-side while this write-back stays in the repository layer. */
export async function saveAvatarUrl(url: string): Promise<AvatarActionState> {
  const identity = await resolveIdentity();
  if (identity.type !== "profile") {
    return { error: "Create an account to set up your Virtual Stage profile." };
  }
  await updateOwnAvatarUrl(identity.id, url);
  if (identity.username) revalidatePath(`/profile/${identity.username}`);
  revalidatePath("/profile/edit");
  return { ok: true };
}

/** Section 20: avatar removal is its own immediate action, not gated behind the form's Save button. */
export async function removeAvatar(): Promise<AvatarActionState> {
  const identity = await resolveIdentity();
  if (identity.type !== "profile") {
    return { error: "Create an account to set up your Virtual Stage profile." };
  }
  await updateOwnAvatarUrl(identity.id, null);
  if (identity.username) revalidatePath(`/profile/${identity.username}`);
  revalidatePath("/profile/edit");
  return { ok: true };
}

export type FollowActionResult = { error: string } | { ok: true };

/** Section 11: "If a guest taps Follow, a lightweight signup/login prompt is acceptable because Follow inherently requires persistent identity." Never a redirect — the caller decides how to present this error. */
export async function followProfileAction(targetProfileId: string): Promise<FollowActionResult> {
  const identity = await resolveIdentity();
  if (identity.type !== "profile") {
    return { error: "Create an account to follow people." };
  }
  if (identity.id === targetProfileId) {
    return { error: "You can't follow yourself." };
  }
  await followProfileRepo(identity.id, targetProfileId);
  revalidatePath("/profile/[username]", "page");
  return { ok: true };
}

export async function unfollowProfileAction(targetProfileId: string): Promise<FollowActionResult> {
  const identity = await resolveIdentity();
  if (identity.type !== "profile") {
    return { error: "Create an account to follow people." };
  }
  await unfollowProfileRepo(identity.id, targetProfileId);
  revalidatePath("/profile/[username]", "page");
  return { ok: true };
}
