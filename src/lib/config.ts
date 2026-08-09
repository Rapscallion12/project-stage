/**
 * Single toggle point for the prototype's guest-access policy. Every
 * guest-eligible server action checks this instead of hardcoding "allow
 * anonymous" logic inline, so tightening access later (e.g. once
 * reputation/reliability make guest participation less desirable) is a
 * one-line change here, not a hunt through every action file.
 *
 * Per PRODUCT.md's progressive authentication model, this defaults to
 * true and should stay true unless a future milestone explicitly decides
 * otherwise — do not flip it as a side effect of an unrelated change.
 */
export const PROTOTYPE_CONFIG = {
  guestParticipationEnabled: true,
} as const;
