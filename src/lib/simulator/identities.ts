/**
 * Issue #21, Part 5 (Session Simulator), Part 5's "stable fake guest
 * identities during a simulation run" requirement: a simulated identity
 * is exactly what a real guest identity already is in this app — a bare
 * UUID, nothing more (see `lib/guest.ts`) — generated once, held in
 * memory for the run's duration, reused for every action that identity
 * takes.
 *
 * `generateGuestName` below is a deliberate, minimal duplicate of the
 * identical function in `lib/guest.ts` (same hash, same word lists),
 * not a reuse via import — that file also exports `getGuestId`/
 * `getGuestDisplayName`, which read `next/headers`' `cookies()` and
 * cannot be pulled into client bundle code (this module is used from
 * the client-side simulator panel, for instant identity generation with
 * no server round-trip). Keeping the two in sync by hand is an accepted
 * cost for a preview-only tool; a real guest's name and a simulated
 * one's name happening to look identical in style is the point, not a
 * risk.
 */

const ADJECTIVES = [
  "Curious", "Quiet", "Bold", "Cheerful", "Restless", "Witty",
  "Gentle", "Sly", "Eager", "Calm", "Dapper", "Nimble",
] as const;

const NOUNS = [
  "Fox", "Otter", "Heron", "Falcon", "Badger", "Lynx",
  "Sparrow", "Wolf", "Rabbit", "Owl", "Raven", "Deer",
] as const;

function hashString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  }
  return hash;
}

function generateGuestName(guestId: string): string {
  const hash = hashString(guestId);
  const adjective = ADJECTIVES[hash % ADJECTIVES.length];
  const noun = NOUNS[Math.floor(hash / ADJECTIVES.length) % NOUNS.length];
  return `${adjective} ${noun}`;
}

export type SimulatedIdentity = { id: string; displayName: string };

export function createSimulatedIdentity(): SimulatedIdentity {
  const id = crypto.randomUUID();
  return { id, displayName: generateGuestName(id) };
}

export function createSimulatedAudience(count: number): SimulatedIdentity[] {
  return Array.from({ length: count }, () => createSimulatedIdentity());
}

export function randomIdentity(pool: readonly SimulatedIdentity[]): SimulatedIdentity {
  return pool[Math.floor(Math.random() * pool.length)];
}

/** A random subset (without replacement), size clamped to the pool — used for "not every fake viewer votes" (Part 10). */
export function randomSubset<T>(pool: readonly T[], count: number): T[] {
  const shuffled = [...pool].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, Math.min(count, pool.length));
}
