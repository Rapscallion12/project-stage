"use server";

import { cookies } from "next/headers";
import { resolveIdentity } from "@/lib/identity";
import { GUEST_COOKIE_MAX_AGE_SECONDS, GUEST_NAME_COOKIE } from "@/lib/guest";
import { hasSentMessageRecently, insertMessage, insertReaction } from "@/lib/repositories/chat";
import { isPreviewOrDevBuild } from "@/lib/preview-mode";

const MESSAGE_MAX_LENGTH = 500;
const RATE_LIMIT_MS = 2000;

export type SendMessageState = { error: string } | undefined;

export async function sendMessage(
  eventId: string,
  _prevState: SendMessageState,
  formData: FormData,
): Promise<SendMessageState> {
  const body = String(formData.get("body") ?? "").trim();
  if (!body) return { error: "Message can't be empty." };
  if (body.length > MESSAGE_MAX_LENGTH) {
    return { error: `Keep it under ${MESSAGE_MAX_LENGTH} characters.` };
  }

  const identity = await resolveIdentity();

  if (await hasSentMessageRecently(eventId, identity, RATE_LIMIT_MS)) {
    return { error: "You're sending messages too quickly." };
  }

  const { ok, error } = await insertMessage({ eventId, identity, displayName: identity.displayName, body });
  if (!ok) {
    // Real-device report ("commenting is currently not working"): never
    // silently swallow this — always logged server-side (visible in
    // Vercel's function logs / the local dev terminal regardless of
    // environment), and the *actual* Postgres error is surfaced to the
    // caller too, but only on a non-production build
    // (`isPreviewOrDevBuild()` — the same gate the Session Simulator
    // itself already uses) so a real user on the real production site
    // never sees raw backend detail, while this exact internal preview
    // does.
    console.error("[sendMessage] insertMessage failed", { eventId, identityType: identity.type, error });
    const detail = isPreviewOrDevBuild() && error ? ` (${error.code ?? "?"}: ${error.message})` : "";
    return { error: `Couldn't send your message. Try again.${detail}` };
  }

  return undefined;
}

export async function addReaction(messageId: string, emoji: string = "👍"): Promise<{ error?: string }> {
  const identity = await resolveIdentity();
  const { ok } = await insertReaction({ messageId, identity, emoji });
  return ok ? {} : { error: "Couldn't react. Try again." };
}

export async function setGuestName(name: string): Promise<{ error?: string }> {
  const trimmed = name.trim().slice(0, 40);
  if (!trimmed) return { error: "Name can't be empty." };

  const store = await cookies();
  store.set(GUEST_NAME_COOKIE, trimmed, {
    httpOnly: false,
    secure: true,
    sameSite: "lax",
    maxAge: GUEST_COOKIE_MAX_AGE_SECONDS,
    path: "/",
  });

  return {};
}
