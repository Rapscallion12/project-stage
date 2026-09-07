"use server";

import { cookies } from "next/headers";
import { resolveIdentity } from "@/lib/identity";
import { GUEST_COOKIE_MAX_AGE_SECONDS, GUEST_NAME_COOKIE } from "@/lib/guest";
import { hasSentMessageRecently, insertMessage, insertReaction } from "@/lib/repositories/chat";
import { isPreviewOrDevBuild } from "@/lib/preview-mode";

const MESSAGE_MAX_LENGTH = 500;
/**
 * Real-device report (optimistic-send redesign, Section 6's own
 * explicit "report the exact current rate limit" instruction): the
 * *actual* rule, unchanged by this pass — one message per identity per
 * event every 2 seconds, enforced here by re-querying this identity's
 * own most recent message fresh from the database (`hasSentMessageRecently`
 * below), never a client-trusted clock. This exists as basic anti-spam,
 * not a chat-pacing feature — 2s is well inside "a human typing and
 * hitting send twice in a row" territory, which is exactly the real-
 * device symptom that prompted this whole pass. Not weakened here (an
 * explicit instruction: "do not automatically change security policy
 * without inspecting it") — instead, `useLobbyRealtime`'s own outgoing
 * queue (`MIN_SEND_INTERVAL_MS`, currently 2100ms, a small safety margin
 * over this exact value) paces this *one* tab's own successive
 * dispatches so a normal burst of typing never actually reaches this
 * check fast enough to trip it, while every message still *appears*
 * instantly to the user regardless of that pacing.
 */
const RATE_LIMIT_MS = 2000;

export type SendCommentResult = { ok: boolean; error?: string };

/**
 * Real-device report (optimistic-send redesign): no longer a
 * `useActionState`-shaped `(prevState, formData)` action — the comment
 * composer no longer submits through React's form-action machinery at
 * all (see `useLobbyRealtime`'s own `submitComment` doc comment for why:
 * the optimistic insert/queue/reconciliation model this pass introduces
 * needs to call this directly, from a plain async function it fully
 * controls the timing of, not from a form's own submit lifecycle). A
 * plain, directly-callable async function instead — `eventId`/`body`/
 * `clientMessageId` are all it needs. `submitSpeakerRequest` (mic-request
 * mode, unrelated to this redesign — see this file's own untouched
 * neighbor) keeps its original action shape.
 */
export async function sendMessage(eventId: string, body: string, clientMessageId: string): Promise<SendCommentResult> {
  const trimmed = body.trim();
  if (!trimmed) return { ok: false, error: "Message can't be empty." };
  if (trimmed.length > MESSAGE_MAX_LENGTH) {
    return { ok: false, error: `Keep it under ${MESSAGE_MAX_LENGTH} characters.` };
  }

  const identity = await resolveIdentity();

  if (await hasSentMessageRecently(eventId, identity, RATE_LIMIT_MS)) {
    return { ok: false, error: "You're sending messages too quickly." };
  }

  const { ok, error } = await insertMessage({
    eventId,
    identity,
    displayName: identity.displayName,
    body: trimmed,
    id: clientMessageId,
  });
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
    return { ok: false, error: `Couldn't send your message. Try again.${detail}` };
  }

  return { ok: true };
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
