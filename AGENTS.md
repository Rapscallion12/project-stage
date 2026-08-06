<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Virtual Stage — project agent rules

Read [README.md](./README.md) first; it maps the rest of the docs
(PRODUCT.md, ARCHITECTURE.md, ROADMAP.md, DECISIONS.md, CHANGELOG.md,
SESSION_LOG.md). Everything you need to continue this project without prior
conversation context lives in those files — read `SESSION_LOG.md`
last-entry-first before starting work.

A few rules that are easy to violate by defaulting to generic habits:

- **Every screen is responsive by requirement, not by convenience.**
  Desktop and smartphone are both first-class targets, built with layouts
  intentionally designed per screen size sharing the same business logic —
  never one platform's layout stretched or squeezed for the other. See
  PRODUCT.md's responsive design principle and ARCHITECTURE.md's testing
  checklist before marking any UI work done.
- **Never build a feature that isn't in PRODUCT.md's MVP scope** (or a
  future session's explicit instruction) — check the out-of-scope list
  before adding anything that smells like a "nice to have."
- **RLS is enabled on every table, from its first migration** — no
  exceptions, no "add it later." See DECISIONS.md for why.
- **`src/types/database.ts` is hand-maintained** until a real Supabase
  project exists — any migration you add must update it in the same commit.
- **Never work on `main` directly** — branch, commit, and keep
  ROADMAP.md/CHANGELOG.md/SESSION_LOG.md in sync with what actually shipped.
