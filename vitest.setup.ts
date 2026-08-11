import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

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
