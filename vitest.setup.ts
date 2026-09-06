import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

// jsdom doesn't implement Element.scrollTo — every scroll-driven component
// (ChatPanel's own message list, ExpandedComments' follow-latest logic)
// needs it not to throw. Global, not per-file, since issue #21's
// ExpandedComments is now reachable from every room composition's own
// test file, not just chat-panel.test.tsx (which used to patch this
// locally) — guarded, since several test files opt into a plain Node
// environment (`// @vitest-environment node`, e.g. LiveKit token/webhook
// tests) where `Element` doesn't exist at all.
if (typeof Element !== "undefined") {
  Element.prototype.scrollTo = vi.fn();
}

// jsdom doesn't implement window.matchMedia at all — pre-launch
// interaction pass's usePrefersReducedMotion (used unconditionally
// inside SpeakerStage, now reachable from essentially every room
// composition's own test file) needs a safe default so tests that don't
// care about motion preference don't have to know it exists. Defaults
// to `matches: false` (full motion) — any test that genuinely needs to
// control the result (e.g. use-orientation.test.ts's own per-test
// `vi.stubGlobal("matchMedia", ...)`, or a future
// use-prefers-reduced-motion.test.ts) overrides this locally the same
// way those tests already override `window.matchMedia` today; a global
// stub here only fills the gap for callers that don't.
if (typeof window !== "undefined" && !window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

// React Testing Library doesn't auto-register its cleanup unless the test
// framework exposes globals (this project's vitest.config.mts doesn't set
// `test.globals: true` — every existing test file explicitly imports
// describe/it/expect from "vitest" instead). Without this, `render()` in
// one test leaves its DOM tree mounted for the next test in the same
// file, and queries like `getByTestId` start matching multiple elements.
// This was never surfaced before speaker-tile.test.tsx (issue #3) — the
// first component-rendering test in the project; use-now.test.tsx only
// exercises a hook, not a rendered tree.
afterEach(() => {
  cleanup();
});
