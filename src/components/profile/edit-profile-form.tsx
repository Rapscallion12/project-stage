"use client";

import { useActionState } from "react";
import { useRouter } from "next/navigation";
import { saveProfile, type SaveProfileState } from "@/app/profile/actions";
import { Button, ButtonLink } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { SOCIAL_PLATFORMS } from "@/lib/social-links";
import type { OwnProfile } from "@/lib/repositories/profiles";

/**
 * Issue #29, Section 13: one explicit Save action for the whole form
 * (display name, username, bio, every social link) — never a write per
 * keystroke. `useActionState` mirrors `SignupForm`'s own established
 * shape exactly (this project's one existing convention for a form
 * backed by a server action with pending/error/success states), rather
 * than inventing a second pattern.
 */
export function EditProfileForm({ profile }: { profile: OwnProfile }) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState<SaveProfileState, FormData>(async (prevState, formData) => {
    const result = await saveProfile(prevState, formData);
    if (result?.status === "success") {
      router.push(`/profile/${result.username}`);
    }
    return result;
  }, undefined);

  const fieldError = (field: string) => (state?.status === "error" && state.field === field ? state.message : null);

  return (
    <form action={formAction} className="flex flex-col gap-5">
      <div>
        <Label htmlFor="displayName">Display name</Label>
        <Input id="displayName" name="displayName" type="text" defaultValue={profile.display_name} required maxLength={50} />
        {fieldError("displayName") && (
          <p className="mt-1 text-sm text-red-500" role="alert">
            {fieldError("displayName")}
          </p>
        )}
      </div>

      <div>
        <Label htmlFor="username">Username</Label>
        <div className="flex items-center gap-1">
          <span className="text-muted">@</span>
          <Input id="username" name="username" type="text" defaultValue={profile.username ?? ""} required maxLength={20} placeholder="jace" />
        </div>
        {fieldError("username") && (
          <p className="mt-1 text-sm text-red-500" role="alert">
            {fieldError("username")}
          </p>
        )}
        <p className="mt-1 text-xs text-muted">Your profile will be at virtualstage.app/profile/{profile.username || "username"}</p>
      </div>

      <div>
        <Label htmlFor="bio">Bio</Label>
        <textarea
          id="bio"
          name="bio"
          maxLength={160}
          rows={3}
          defaultValue={profile.bio ?? ""}
          className="w-full rounded-lg border border-border bg-transparent px-3.5 py-2.5 text-base outline-none transition-colors focus:border-accent"
        />
        {fieldError("bio") && (
          <p className="mt-1 text-sm text-red-500" role="alert">
            {fieldError("bio")}
          </p>
        )}
      </div>

      <fieldset className="flex flex-col gap-3">
        <legend className="mb-1 text-sm font-medium">Social links</legend>
        {SOCIAL_PLATFORMS.map((platform) => (
          <div key={platform.id}>
            <Label htmlFor={`social_${platform.id}`}>{platform.label}</Label>
            <Input
              id={`social_${platform.id}`}
              name={`social_${platform.id}`}
              type="text"
              defaultValue={profile.social_links[platform.id] ?? ""}
              placeholder={platform.id === "website" ? "https://your-site.com" : "handle"}
            />
          </div>
        ))}
        {fieldError("social") && (
          <p className="text-sm text-red-500" role="alert">
            {fieldError("social")}
          </p>
        )}
      </fieldset>

      {fieldError("general") && (
        <p className="text-sm text-red-500" role="alert">
          {fieldError("general")}
        </p>
      )}

      <div className="flex gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save"}
        </Button>
        <ButtonLink href={profile.username ? `/profile/${profile.username}` : "/"} variant="ghost">
          Cancel
        </ButtonLink>
      </div>
    </form>
  );
}
