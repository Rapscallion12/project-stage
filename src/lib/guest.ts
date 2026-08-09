import { cookies } from "next/headers";

/**
 * Bare anonymous session identifier — not a Supabase auth user, not a
 * `profiles` row. See ARCHITECTURE.md's Guest identity section: this
 * exists purely so a guest's chat messages/reactions can be attributed
 * and deduplicated within an event, never to grant elevated access or
 * accrue anything that outlives the cookie.
 */
export const GUEST_ID_COOKIE = "vs_guest_id";

/** Optional display name a guest picked for themselves, overriding the generated default. */
export const GUEST_NAME_COOKIE = "vs_guest_name";

const GUEST_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days

const ADJECTIVES = [
  "Curious",
  "Quiet",
  "Bold",
  "Cheerful",
  "Restless",
  "Witty",
  "Gentle",
  "Sly",
  "Eager",
  "Calm",
  "Dapper",
  "Nimble",
] as const;

const NOUNS = [
  "Fox",
  "Otter",
  "Heron",
  "Falcon",
  "Badger",
  "Lynx",
  "Sparrow",
  "Wolf",
  "Rabbit",
  "Owl",
  "Raven",
  "Deer",
] as const;

/** Cheap, non-cryptographic string hash — only used to pick a stable name deterministically. */
function hashString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  }
  return hash;
}

/**
 * Deterministic "Adjective Animal" name derived from the guest's session
 * id, so a guest has a stable default identity within their session
 * without needing to type anything or persist an extra value — they can
 * still override it (see GUEST_NAME_COOKIE) to show more personality.
 */
export function generateGuestName(guestId: string): string {
  const hash = hashString(guestId);
  const adjective = ADJECTIVES[hash % ADJECTIVES.length];
  const noun = NOUNS[Math.floor(hash / ADJECTIVES.length) % NOUNS.length];
  return `${adjective} ${noun}`;
}

/** Reads the guest session id from cookies, if present. Does not mint one — see src/proxy.ts. */
export async function getGuestId(): Promise<string | null> {
  const store = await cookies();
  return store.get(GUEST_ID_COOKIE)?.value ?? null;
}

/** Resolves the display name a guest should be shown under: their custom name if set, else the generated default. */
export async function getGuestDisplayName(guestId: string): Promise<string> {
  const store = await cookies();
  const custom = store.get(GUEST_NAME_COOKIE)?.value?.trim();
  return custom && custom.length > 0 ? custom : generateGuestName(guestId);
}

export { GUEST_COOKIE_MAX_AGE_SECONDS };
