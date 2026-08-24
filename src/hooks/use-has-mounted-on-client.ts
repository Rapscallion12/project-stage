"use client";

import { useSyncExternalStore } from "react";

function subscribe() {
  // Never changes again once mounted — nothing to subscribe to.
  return () => {};
}

function getSnapshot() {
  return true;
}

function getServerSnapshot() {
  return false;
}

/**
 * Issue #18 first-load consistency finding (real-device report:
 * intermittently landing in the ordinary two-seat/split composition
 * despite already holding a speaker seat — most reproducible right
 * after a fresh deployment/build).
 *
 * **Root cause**: `useOrientation`/`useIsDesktopViewport` are
 * `useSyncExternalStore`-based (correctly — they watch genuinely
 * external, mutable browser state, see their own doc comments), but
 * their `getServerSnapshot` — used for both the actual server render
 * *and* the client's first hydration pass, to avoid a hydration
 * mismatch — returns a fixed guess (`"portrait"`, `false`/mobile), not
 * "unknown." On a real desktop browser, that first render therefore
 * always renders one of the *mobile* compositions first; React then
 * corrects the snapshot to the real client value and re-renders,
 * switching `EventRoom` to `DesktopRoom` — which has no role router at
 * all (an intentional, approved scope boundary: Speaker View has no
 * desktop equivalent) and never reconsiders role again. A seated
 * speaker's very first paint could briefly show the correct Speaker
 * View, then get silently replaced by `DesktopRoom`'s ordinary
 * two-tile-plus-sidebar layout for the rest of the session. The same
 * guessed-default mechanism can also cause an unnecessary
 * Portrait→MobileLandscape (or reverse) composition swap immediately
 * after mount, even though both of those specific compositions do have
 * their own role router.
 *
 * **The fix**: don't let `EventRoom` commit to *any* of the three room
 * compositions until the client has actually settled — this hook
 * deliberately uses the *same* `useSyncExternalStore` mechanism
 * `useOrientation`/`useIsDesktopViewport` do (rather than
 * `useState`+`useEffect`, which the codebase's own
 * `react-hooks/set-state-in-effect` lint rule already steers away from
 * for exactly this "recompute something the initial render already
 * knew" shape — see `useLiveRoomConnection`'s own comment on that
 * rule): `getSnapshot` always returns `true`, `getServerSnapshot`
 * always returns `false`. React settles all of a commit's
 * `useSyncExternalStore` corrections — this one included — before any
 * passive `useEffect` runs, so by the time this hook (or any other
 * `useSyncExternalStore` hook) reports its corrected value,
 * `useOrientation`/`useIsDesktopViewport` are already reporting theirs
 * too — no cross-hook timing coordination required, and neither of
 * those hooks' own contracts need to change. Callers should render a
 * brief neutral/loading state while this is `false`, never guess a
 * composition and let it swap later.
 *
 * Deliberately not a new "role" signal of any kind — this only gates
 * *when* the existing, single-source `participantRole` is allowed to
 * pick a composition, never a second thing that decides *what* role
 * someone has.
 */
export function useHasMountedOnClient(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
