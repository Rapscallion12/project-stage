"use client";

import { useRef, useState } from "react";
import { uploadAvatar, deleteAvatarFile } from "@/lib/avatar-upload";
import { saveAvatarUrl, removeAvatar } from "@/app/profile/actions";
import { ParticipantAvatar } from "@/components/room/participant-avatar";
import { Button } from "@/components/ui/button";

/**
 * Issue #29, Section 4/20: upload/remove, independent of the rest of
 * Edit Profile's own explicit Save button — Section 20 asks for avatar
 * removal specifically as its own immediate action, and an upload only
 * has anything to persist once it has a URL to write, so both make more
 * sense as their own small, self-contained round trips than as form
 * fields waiting on a separate Save tap.
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
      <ParticipantAvatar name={displayName} imageUrl={avatarUrl} size="lg" />
      <div className="flex flex-col gap-2">
        <div className="flex gap-2">
          <Button type="button" variant="secondary" disabled={pending} onClick={() => inputRef.current?.click()}>
            {pending ? "Uploading…" : avatarUrl ? "Change photo" : "Add photo"}
          </Button>
          {avatarUrl && (
            <Button type="button" variant="ghost" disabled={pending} onClick={handleRemove}>
              Remove
            </Button>
          )}
        </div>
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
