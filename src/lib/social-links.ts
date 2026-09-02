/**
 * Issue #29 (first profile/social-identity pass): normalization for
 * profile social links. Pure functions, no I/O — testable without a
 * database, and reused identically by the save-profile server action
 * (writing `profiles.social_links`) and the public profile page
 * (rendering the outbound links) so there is exactly one definition of
 * "what counts as a valid handle" and "what URL a handle resolves to."
 *
 * **Storage shape**: `profiles.social_links` is a single `jsonb` column,
 * `{ [platformId]: string }` — a normalized handle for handle-based
 * platforms, a normalized `https://…` URL for `website`. Adding a new
 * platform later is one more entry in `SOCIAL_PLATFORMS` below, never a
 * schema migration — the explicit design goal this pass asked for
 * ("architect this so another platform can be added later without
 * redesigning the entire profile").
 */

export type SocialPlatformId = "instagram" | "tiktok" | "youtube" | "twitter" | "twitch" | "website";

export type SocialPlatform = {
  id: SocialPlatformId;
  label: string;
  /** Accepts a raw handle, an `@handle`, or a full profile URL (any of the domains a real user might paste) and returns the normalized stored value, or `null` if the input doesn't look like a valid identifier for this platform at all. */
  normalize: (raw: string) => string | null;
  /** The stored value → the actual outbound URL a viewer's tap should open. */
  buildUrl: (stored: string) => string;
  /** How the stored value is shown next to the platform icon on a profile — usually `@handle`, but the website platform shows the bare domain instead. */
  formatDisplay: (stored: string) => string;
};

/** Shared handle charset — letters, numbers, underscore, dot; generous enough to cover every platform's real rules without needing a bespoke regex per platform for a V1. */
const HANDLE_PATTERN = /^[a-zA-Z0-9._]{1,30}$/;

function normalizeHandle(raw: string, knownDomains: string[]): string | null {
  let value = raw.trim();
  if (value === "") return null;

  // A pasted full URL — strip scheme + domain, keep whatever path segment
  // is left (the handle). Only recognized domains for this platform are
  // stripped; an unrelated URL pasted into the wrong field correctly
  // fails validation below rather than being silently accepted.
  const urlMatch = value.match(/^https?:\/\/(?:www\.)?([^/]+)\/(.+?)\/?$/i);
  if (urlMatch) {
    const domain = urlMatch[1].toLowerCase();
    if (!knownDomains.includes(domain)) return null;
    value = urlMatch[2];
  }

  value = value.replace(/^@/, "").replace(/\/+$/, "");
  if (!HANDLE_PATTERN.test(value)) return null;
  return value;
}

/** website is the one non-handle platform — a real http(s) URL, no javascript:/data:/other schemes, ever. */
function normalizeWebsite(raw: string): string | null {
  let value = raw.trim();
  if (value === "") return null;
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  // Explicit allow-list, not a denial list — the only two schemes a
  // profile link should ever resolve to. Blocks javascript:, data:,
  // file:, vbscript:, and anything else by construction, not by trying
  // to enumerate every unsafe scheme.
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!url.hostname || !url.hostname.includes(".")) return null;
  return url.toString();
}

export const SOCIAL_PLATFORMS: SocialPlatform[] = [
  {
    id: "instagram",
    label: "Instagram",
    normalize: (raw) => normalizeHandle(raw, ["instagram.com"]),
    buildUrl: (handle) => `https://instagram.com/${handle}`,
    formatDisplay: (handle) => `@${handle}`,
  },
  {
    id: "tiktok",
    label: "TikTok",
    normalize: (raw) => normalizeHandle(raw, ["tiktok.com"]),
    buildUrl: (handle) => `https://tiktok.com/@${handle}`,
    formatDisplay: (handle) => `@${handle}`,
  },
  {
    id: "youtube",
    label: "YouTube",
    normalize: (raw) => normalizeHandle(raw, ["youtube.com"]),
    buildUrl: (handle) => `https://youtube.com/@${handle}`,
    formatDisplay: (handle) => `@${handle}`,
  },
  {
    id: "twitter",
    label: "X",
    normalize: (raw) => normalizeHandle(raw, ["twitter.com", "x.com"]),
    buildUrl: (handle) => `https://x.com/${handle}`,
    formatDisplay: (handle) => `@${handle}`,
  },
  {
    id: "twitch",
    label: "Twitch",
    normalize: (raw) => normalizeHandle(raw, ["twitch.tv"]),
    buildUrl: (handle) => `https://twitch.tv/${handle}`,
    formatDisplay: (handle) => `@${handle}`,
  },
  {
    id: "website",
    label: "Website",
    normalize: normalizeWebsite,
    buildUrl: (url) => url,
    formatDisplay: (url) => {
      try {
        return new URL(url).hostname.replace(/^www\./, "");
      } catch {
        return url;
      }
    },
  },
];

export function getSocialPlatform(id: string): SocialPlatform | undefined {
  return SOCIAL_PLATFORMS.find((p) => p.id === id);
}

/**
 * Normalizes a full `{ platformId: rawInput }` form submission into the
 * shape actually stored in `profiles.social_links` — drops any unknown
 * platform key (defense in depth; the form itself only ever submits
 * known keys) and any blank/whitespace-only value (an emptied field
 * means "remove this link," per Section 20's explicit requirement, not
 * "store an empty string"). Throws with a specific, field-addressable
 * message on the first value that fails its platform's own validation,
 * rather than silently dropping a real typo.
 */
export function normalizeSocialLinks(input: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [platformId, rawValue] of Object.entries(input)) {
    const platform = getSocialPlatform(platformId);
    if (!platform) continue;
    const trimmed = rawValue.trim();
    if (trimmed === "") continue; // removed/cleared — omit from the stored object entirely
    const normalized = platform.normalize(trimmed);
    if (normalized === null) {
      throw new SocialLinkValidationError(platformId, `That doesn't look like a valid ${platform.label} ${platformId === "website" ? "URL" : "handle or profile URL"}.`);
    }
    result[platformId] = normalized;
  }
  return result;
}

export class SocialLinkValidationError extends Error {
  constructor(
    public readonly platformId: string,
    message: string,
  ) {
    super(message);
    this.name = "SocialLinkValidationError";
  }
}
