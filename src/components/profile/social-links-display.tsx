import { getSocialPlatform, type SocialPlatformId } from "@/lib/social-links";

/**
 * Issue #29, Section 8: "Do NOT dump raw URLs onto the profile... only
 * show platforms the user has actually connected... compact button/icon
 * treatment." Emoji icons, matching this app's own established icon
 * language (🎙 🙂 🗳 🎁 ☰ ✕ 💬 elsewhere) rather than introducing a new
 * icon library/design system for six glyphs.
 */
const PLATFORM_ICONS: Record<SocialPlatformId, string> = {
  instagram: "📷",
  tiktok: "🎵",
  youtube: "▶️",
  twitter: "𝕏",
  twitch: "🎮",
  website: "🔗",
};

export function SocialLinksDisplay({ socialLinks }: { socialLinks: Record<string, string> }) {
  const entries = Object.entries(socialLinks).filter(([, value]) => value);
  if (entries.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-2" data-testid="social-links">
      {entries.map(([platformId, storedValue]) => {
        const platform = getSocialPlatform(platformId);
        if (!platform) return null;
        return (
          <a
            key={platformId}
            href={platform.buildUrl(storedValue)}
            target="_blank"
            rel="noopener noreferrer"
            data-testid={`social-link-${platformId}`}
            className="flex items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-foreground/5"
          >
            <span aria-hidden="true">{PLATFORM_ICONS[platform.id]}</span>
            <span className="max-w-[8rem] truncate">{platform.formatDisplay(storedValue)}</span>
          </a>
        );
      })}
    </div>
  );
}
