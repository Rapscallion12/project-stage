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
