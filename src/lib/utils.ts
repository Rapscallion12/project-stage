import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Merges conditional class names and resolves conflicting Tailwind utility classes. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Absolute site URL, used for building links (e.g. email confirmation
 * redirects) that must be absolute even in server code. Falls back through
 * an explicit env var, then Vercel's automatic deployment URL, then
 * localhost for local dev.
 */
export function getSiteURL() {
  const url =
    process.env.NEXT_PUBLIC_SITE_URL ??
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null) ??
    "http://localhost:3000";
  return url.endsWith("/") ? url : `${url}/`;
}
