import { describe, expect, it } from "vitest";
import { getSocialPlatform, normalizeSocialLinks, SocialLinkValidationError, SOCIAL_PLATFORMS } from "@/lib/social-links";

/**
 * Issue #29, Section 24: pure-function coverage for social-link
 * normalization — handle vs. full-URL input, unsafe-scheme rejection for
 * the website field, and the "blank clears the field" contract Section 20
 * requires.
 */
describe("handle-based platforms (instagram/tiktok/youtube/twitter/twitch)", () => {
  it("accepts a bare handle", () => {
    expect(getSocialPlatform("instagram")!.normalize("jaceb")).toBe("jaceb");
  });

  it("strips a leading @", () => {
    expect(getSocialPlatform("instagram")!.normalize("@jaceb")).toBe("jaceb");
  });

  it("strips a recognized profile URL down to the handle", () => {
    expect(getSocialPlatform("instagram")!.normalize("https://instagram.com/jaceb")).toBe("jaceb");
    expect(getSocialPlatform("instagram")!.normalize("https://www.instagram.com/jaceb/")).toBe("jaceb");
  });

  it("accepts both twitter.com and x.com for the X platform", () => {
    expect(getSocialPlatform("twitter")!.normalize("https://twitter.com/jaceb")).toBe("jaceb");
    expect(getSocialPlatform("twitter")!.normalize("https://x.com/jaceb")).toBe("jaceb");
  });

  it("rejects a URL from an unrelated domain", () => {
    expect(getSocialPlatform("instagram")!.normalize("https://tiktok.com/jaceb")).toBeNull();
  });

  it("rejects an empty or whitespace-only value", () => {
    expect(getSocialPlatform("instagram")!.normalize("")).toBeNull();
    expect(getSocialPlatform("instagram")!.normalize("   ")).toBeNull();
  });

  it("rejects invalid handle characters", () => {
    expect(getSocialPlatform("instagram")!.normalize("jace b")).toBeNull();
    expect(getSocialPlatform("instagram")!.normalize("jace/b")).toBeNull();
    expect(getSocialPlatform("instagram")!.normalize("<script>")).toBeNull();
  });

  it("buildUrl and formatDisplay produce the expected outbound shape", () => {
    expect(getSocialPlatform("tiktok")!.buildUrl("jaceb")).toBe("https://tiktok.com/@jaceb");
    expect(getSocialPlatform("tiktok")!.formatDisplay("jaceb")).toBe("@jaceb");
  });
});

describe("website platform", () => {
  it("accepts a full https URL", () => {
    expect(getSocialPlatform("website")!.normalize("https://jaceb.dev")).toBe("https://jaceb.dev/");
  });

  it("accepts a bare domain and adds https://", () => {
    expect(getSocialPlatform("website")!.normalize("jaceb.dev")).toBe("https://jaceb.dev/");
  });

  it("accepts http explicitly", () => {
    expect(getSocialPlatform("website")!.normalize("http://jaceb.dev")).toBe("http://jaceb.dev/");
  });

  it("rejects javascript: and data: schemes", () => {
    expect(getSocialPlatform("website")!.normalize("javascript:alert(1)")).toBeNull();
    expect(getSocialPlatform("website")!.normalize("data:text/html,<script>alert(1)</script>")).toBeNull();
  });

  it("rejects other unsafe or non-http(s) schemes", () => {
    expect(getSocialPlatform("website")!.normalize("file:///etc/passwd")).toBeNull();
    expect(getSocialPlatform("website")!.normalize("vbscript:msgbox(1)")).toBeNull();
    expect(getSocialPlatform("website")!.normalize("ftp://example.com")).toBeNull();
  });

  it("rejects a value with no valid hostname", () => {
    expect(getSocialPlatform("website")!.normalize("https://")).toBeNull();
    expect(getSocialPlatform("website")!.normalize("not a url at all")).toBeNull();
  });

  it("formatDisplay shows the bare hostname without www", () => {
    expect(getSocialPlatform("website")!.formatDisplay("https://www.jaceb.dev/")).toBe("jaceb.dev");
  });
});

describe("normalizeSocialLinks", () => {
  it("normalizes multiple valid links at once", () => {
    const result = normalizeSocialLinks({ instagram: "jaceb", website: "jaceb.dev" });
    expect(result.instagram).toBe("jaceb");
    expect(result.website).toBe("https://jaceb.dev/");
  });

  it("omits blank/whitespace-only fields entirely — clearing a field removes it", () => {
    const result = normalizeSocialLinks({ instagram: "jaceb", tiktok: "", youtube: "   " });
    expect(result).toEqual({ instagram: "jaceb" });
    expect(result).not.toHaveProperty("tiktok");
    expect(result).not.toHaveProperty("youtube");
  });

  it("drops unknown platform keys rather than storing them", () => {
    const result = normalizeSocialLinks({ myspace: "jaceb" } as Record<string, string>);
    expect(result).toEqual({});
  });

  it("throws a SocialLinkValidationError naming the offending platform on invalid input", () => {
    try {
      normalizeSocialLinks({ website: "javascript:alert(1)" });
      expect.unreachable("expected normalizeSocialLinks to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(SocialLinkValidationError);
      expect((err as InstanceType<typeof SocialLinkValidationError>).platformId).toBe("website");
    }
  });

  it("every declared platform round-trips through normalize -> buildUrl -> formatDisplay without throwing", () => {
    for (const platform of SOCIAL_PLATFORMS) {
      const sample = platform.id === "website" ? "example.com" : "sample_handle";
      const normalized = platform.normalize(sample);
      expect(normalized).not.toBeNull();
      expect(() => platform.buildUrl(normalized!)).not.toThrow();
      expect(() => platform.formatDisplay(normalized!)).not.toThrow();
    }
  });
});
