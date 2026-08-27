/**
 * Issue #21, Part 5 (Session Simulator): pure content generation only —
 * no Supabase, no I/O, same discipline as `lib/dev-demo.ts`. Every
 * string here is deliberately benign/test-flavored (Part 6's explicit
 * requirement) — this is content a simulated identity posts through the
 * *real* comment/request pathways, not a label describing the simulator
 * itself.
 */

const ORDINARY_COMMENT_TEMPLATES = [
  "this is a great conversation",
  "didn't expect that take, interesting",
  "lol",
  "wait can you say that again",
  "agreed 100%",
  "not sure I follow but ok",
  "this is exactly why I tuned in",
  "haha true",
  "good point actually",
  "hmm, I see it differently",
  "keep going!",
  "this test comment is doing its job",
  "solid point",
  "no notes, love this",
  "curious where this goes next",
];

const SPEAKER_REQUEST_TEMPLATES = [
  "I'd like to add a counterpoint to this",
  "can I jump in with a quick story?",
  "I have thoughts on this topic",
  "let me in, I promise it's relevant",
  "this is my area, let me weigh in",
  "quick take I want to share",
  "I disagree and want to explain why",
  "adding a different angle here",
];

function pick<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}

export function randomOrdinaryComment(): string {
  return pick(ORDINARY_COMMENT_TEMPLATES);
}

export function randomSpeakerRequestComment(): string {
  return pick(SPEAKER_REQUEST_TEMPLATES);
}

/** A jittered delay, never perfectly periodic (Part 6's explicit requirement) — uniform between [minMs, maxMs). */
export function jitteredDelayMs(minMs: number, maxMs: number): number {
  return minMs + Math.random() * (maxMs - minMs);
}
