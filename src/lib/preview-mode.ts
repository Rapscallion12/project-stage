/**
 * Issue #21, Parts 1 & 5: whether this deployment is anything other
 * than the real production site — every other Vercel preview, plus
 * local dev where `VERCEL_ENV` is unset entirely. Governs two things
 * with very different stakes, both explicitly required to be
 * "impossible to accidentally expose on production":
 *
 * 1. **Presentation-only** (Part 1): showing the speaker round's
 *    remaining time for the *entire* round, instead of the real
 *    product's eventual final-~10s-only reveal. No security
 *    implication if this were ever wrong — worst case is a timer
 *    showing when it "shouldn't". Read this value server-side (in a
 *    Server Component, e.g. `page.tsx`) and pass it down as a plain
 *    prop, same as every other piece of room state — never re-derived
 *    independently in a client component.
 *
 * 2. **Authorization-relevant** (Part 5, the Session Simulator): every
 *    simulator Server Action re-checks this itself, server-side, before
 *    doing anything — never trusts a client-supplied flag or the mere
 *    fact that a simulator panel happened to render. This is the actual
 *    security boundary; the panel not rendering in production is
 *    defense in depth, not the enforcement itself.
 *
 * **Why `VERCEL_ENV`, not the existing `NODE_ENV`-based
 * `isDevToolsAvailable()`** (`lib/dev-demo.ts`): Next.js force-sets
 * `NODE_ENV=production` for *every* `next build` output, preview
 * deployments included — that gate would hide this on the preview URL
 * this feature is specifically meant to be tested through, not just on
 * the real production site. `VERCEL_ENV` is Vercel's own per-deployment
 * signal: `"production"` only for the actual `main`-branch deployment,
 * `"preview"` for every other branch, unset locally — set by the
 * platform itself, not app config, so it can't be left wrong by a stray
 * env var the way a hand-maintained flag could.
 */
export function isPreviewOrDevBuild(): boolean {
  return process.env.VERCEL_ENV !== "production";
}
