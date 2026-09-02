"use client";

import { useRef, useState } from "react";
import { uploadAvatar, deleteAvatarFile } from "@/lib/avatar-upload";
import { saveAvatarUrl, removeAvatar } from "@/app/profile/actions";
import { ParticipantAvatar } from "@/components/room/participant-avatar";

/**
 * Issue #29, Section 4/20 (original pass) + profile UX polish pass
 * Sections 5-8: upload/remove, independent of the rest of Edit Profile's
 * own explicit Save button — Section 20 asks for avatar removal
 * specifically as its own immediate action, and an upload only has
 * anything to persist once it has a URL to write, so both make more sense
 * as their own small, self-contained round trips than as form fields
 * waiting on a separate Save tap.
 *
 * **The avatar circle itself is the picker trigger** (real-iPhone
 * feedback: a separate "Add photo" button next to the avatar wasn't an
 * obvious relationship) — a real `<button>` wrapping `ParticipantAvatar`,
 * so Enter/Space activate it for free with no extra keyboard handling.
 * Same `inputRef.current?.click()` this pass's original "Add photo"
 * button called, and the exact same `uploadAvatar`/`saveAvatarUrl`/
 * `deleteAvatarFile`/`removeAvatar` pipeline below, completely
 * unchanged — only the trigger and layout are new, per this pass's own
 * explicit "do not create a second upload implementation" instruction.
 * The small camera-badge overlay is decorative (`aria-hidden`); the real
 * accessible name lives on the button itself and switches between "Add
 * profile photo" / "Change profile photo" depending on whether one
 * already exists, satisfying Section 7's accessibility requirement
 * without needing a separate visible text button anymore.
 */
export function AvatarEditor({ userId, displayName, initialAvatarUrl }: { userId: string; displayName: string; initialAvatarUrl: string | null }) {
  const [avatarUrl, setAvatarUrl] = useState(initialAvatarUrl);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file later
    if (!file) return;

    setError(null);
    setPending(true);
    const uploadResult = await uploadAvatar(userId, file);
    if ("error" in uploadResult) {
      setError(uploadResult.error);
      setPending(false);
      return;
    }
    const saveResult = await saveAvatarUrl(uploadResult.url);
    setPending(false);
    if (saveResult && "error" in saveResult) {
      setError(saveResult.error);
      return;
    }
    setAvatarUrl(uploadResult.url);
  }

  async function handleRemove() {
    setError(null);
    setPending(true);
    await deleteAvatarFile(userId);
    const result = await removeAvatar();
    setPending(false);
    if (result && "error" in result) {
      setError(result.error);
      return;
    }
    setAvatarUrl(null);
  }

  return (
    <div className="flex items-center gap-4">
      <div className="relative shrink-0">
        <button
          type="button"
          disabled={pending}
          onClick={() => inputRef.current?.click()}
          aria-label={avatarUrl ? "Change profile photo" : "Add profile photo"}
          data-testid="avatar-picker-trigger"
          className="block rounded-full outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:opacity-50"
        >
          <ParticipantAvatar name={displayName} imageUrl={avatarUrl} size="lg" />
        </button>
        {/* Decorative edit affordance — the real accessible name is on the button above. Same emoji-icon language the rest of this app's profile UI already uses (SocialLinksDisplay's own PLATFORM_ICONS). */}
        <span
          aria-hidden="true"
          className="pointer-events-none absolute -right-1 -bottom-1 flex h-8 w-8 items-center justify-center rounded-full border-2 border-background bg-accent text-sm text-white shadow-sm"
        >
          📷
        </span>
      </div>
      <div className="flex flex-col gap-1">
        {pending && <p className="text-sm text-muted">Uploading…</p>}
        {avatarUrl && !pending && (
          <button type="button" onClick={handleRemove} className="w-fit text-xs text-muted underline-offset-2 hover:text-foreground hover:underline">
            Remove photo
          </button>
        )}
        <input
          ref={inputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          className="hidden"
          data-testid="avatar-file-input"
          onChange={handleFileChange}
        />
        {error && (
          <p className="text-sm text-red-500" role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
