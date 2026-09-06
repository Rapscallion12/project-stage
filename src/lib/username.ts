/**
 * Issue #29 (first profile/social-identity pass): username validation,
 * kept in one pure module so the client-side form, the server action,
 * and tests all share exactly one definition — never three
 * independently-drifting copies. The actual authoritative rule is the
 * database's own `username_format`/`username_not_reserved`/`unique`
 * constraints (migration 00000000000044); this exists to give a fast,
 * specific client-side error before ever reaching the server, matching
 * those constraints exactly so a value that passes here never
 * surprises the user by failing there for a reason not already shown.
 *
 * Case-insensitive uniqueness, normalized storage: usernames are always
 * stored lowercase (see the migration's own doc comment for why this,
 * not a separate display-case column, is the simpler correct choice) —
 * `normalizeUsername` is the one place that lowercasing happens.
 */

const USERNAME_PATTERN = /^[a-z0-9_]{3,20}$/;

// Kept in sync by hand with migration 00000000000044's own
// `username_not_reserved` check constraint — the database is the
// authoritative copy; this is what lets the client reject a reserved
// name immediately instead of round-tripping to find out.
const RESERVED_USERNAMES = new Set([
  "admin", "api", "login", "logout", "signup", "events", "profile", "profiles",
  "dev", "join", "auth", "settings", "about", "support", "help", "terms",
  "privacy", "contact", "null", "undefined", "root", "staff", "moderator",
  "system", "virtualstage", "virtual-stage", "home", "www", "mail", "ftp",
  "blog", "app", "static", "public", "assets", "favicon", "me", "you",
]);

export function normalizeUsername(raw: string): string {
  return raw.trim().replace(/^@/, "").toLowerCase();
}

/** `null` means valid; otherwise a specific, user-facing reason. */
export function validateUsername(raw: string): string | null {
  const value = normalizeUsername(raw);
  if (value.length < 3) return "Username must be at least 3 characters.";
  if (value.length > 20) return "Username must be 20 characters or fewer.";
  if (!USERNAME_PATTERN.test(value)) return "Usernames can only use lowercase letters, numbers, and underscores.";
  if (RESERVED_USERNAMES.has(value)) return "That username is reserved.";
  return null;
}
