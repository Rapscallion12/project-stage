"use client";

import { createClient } from "@/lib/supabase/client";

/**
 * Issue #29 (first profile/social-identity pass): avatar upload calls
 * the Supabase client directly — a new, deliberate, narrow addition to
 * the documented Vendor portability exceptions (auth, Realtime, LiveKit
 * — see ARCHITECTURE.md), not an accidental bypass of the
 * `lib/repositories/` rule. Reasoning: Supabase Storage isn't relational
 * "durable data" the repository pattern is about — it's a blob store
 * with its own authorization model (RLS on `storage.objects`, migration
 * 00000000000044), and an upload is inherently a client-to-storage
 * operation (streaming file bytes through a server action would mean
 * buffering the whole file in a Next.js request body for no benefit).
 * The actual durable *row* write this produces — `profiles.avatar_url`
 * — still goes through the repository layer exactly as every other
 * write does (`saveAvatarUrl`, `app/profile/actions.ts`, calling
 * `updateOwnAvatarUrl`) once the upload itself has a URL to record.
 * RLS on `storage.objects` (own-folder-only) is the actual security
 * boundary for the upload step, the same "let RLS be the boundary"
 * reasoning `lib/repositories/follows.ts` already uses for its own
 * writes.
 */

const MAX_DIMENSION = 512;
const JPEG_QUALITY = 0.85;

const ACCEPTED_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024; // matches the bucket's own file_size_limit (migration 00000000000044)

export type AvatarUploadResult = { url: string } | { error: string };

/**
 * Resizes/re-encodes client-side before upload — a real photo straight
 * off a phone camera can be several megabytes and thousands of pixels
 * wide; nothing in this app ever needs an avatar larger than a few
 * hundred pixels. Simple canvas downscale + JPEG re-encode, not a full
 * media pipeline — caps the *longest* edge at `MAX_DIMENSION`, preserving
 * aspect ratio, and only actually re-encodes if the source is larger
 * than that (a small source image is left as-is rather than upscaled or
 * needlessly re-compressed).
 */
async function resizeImage(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_DIMENSION / Math.max(bitmap.width, bitmap.height));
  if (scale === 1) return file;

  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) return file; // defensive — every real browser this app targets supports 2d canvas
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob ?? file), "image/jpeg", JPEG_QUALITY);
  });
}

/**
 * Uploads the caller's own avatar and returns its public URL. Does NOT
 * write `profiles.avatar_url` itself — the caller (`AvatarEditor`) still
 * has to call the `saveAvatarUrl` server action with the returned URL,
 * keeping the durable-row write in the repository layer per the reasoning
 * above.
 */
export async function uploadAvatar(userId: string, file: File): Promise<AvatarUploadResult> {
  if (!ACCEPTED_TYPES.has(file.type)) {
    return { error: "Please choose a JPEG, PNG, or WebP image." };
  }
  if (file.size > MAX_FILE_SIZE_BYTES) {
    return { error: "That image is too large — please choose one under 5MB." };
  }

  let uploadBody: Blob;
  try {
    uploadBody = await resizeImage(file);
  } catch {
    uploadBody = file; // resizing is a best-effort optimization — an unreadable/corrupt image still fails at upload with a clear error, not silently here
  }

  const supabase = createClient();
  // Fixed filename per user (`upsert: true`) — a user has exactly one
  // avatar; re-uploading replaces it in place rather than accumulating
  // orphaned old files under their own folder.
  const path = `${userId}/avatar.jpg`;
  const { error: uploadError } = await supabase.storage.from("avatars").upload(path, uploadBody, {
    upsert: true,
    contentType: "image/jpeg",
  });
  if (uploadError) {
    return { error: "Couldn't upload that image — try again." };
  }

  const { data } = supabase.storage.from("avatars").getPublicUrl(path);
  // Cache-bust: the path is fixed, so an updated avatar would otherwise
  // keep the exact same URL a browser (or another viewer's already-open
  // tab) may have cached indefinitely.
  return { url: `${data.publicUrl}?v=${Date.now()}` };
}

export async function deleteAvatarFile(userId: string): Promise<void> {
  const supabase = createClient();
  await supabase.storage.from("avatars").remove([`${userId}/avatar.jpg`]);
}
