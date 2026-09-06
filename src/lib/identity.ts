import { createClient } from "@/lib/supabase/server";
import { getGuestDisplayName, getGuestId } from "@/lib/guest";
import { getProfileDisplayName, getProfileUsername } from "@/lib/repositories/profiles";

export type Identity =
  | { type: "profile"; id: string; displayName: string; username: string | null }
  | { type: "guest"; id: string; displayName: string };

/**
 * Resolves "who is making this request" once, the same way for both a
 * page's initial render and any server action it triggers — an
 * authenticated user's profile if they're logged in, otherwise their
 * guest session. Falls back to a fresh, non-persistent guest id if the
 * cookie is somehow missing (e.g. cookies disabled) rather than throwing,
 * per the project's graceful-degradation principle — participation just
 * won't survive a refresh in that edge case, which is a reasonable
 * degradation, not a broken page.
 */
export async function resolveIdentity(): Promise<Identity> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (user) {
    const [displayName, username] = await Promise.all([getProfileDisplayName(user.id), getProfileUsername(user.id)]);
    return {
      type: "profile",
      id: user.id,
      displayName: displayName ?? "Account holder",
      username,
    };
  }

  const guestId = (await getGuestId()) ?? crypto.randomUUID();
  return {
    type: "guest",
    id: guestId,
    displayName: await getGuestDisplayName(guestId),
  };
}
