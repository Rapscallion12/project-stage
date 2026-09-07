import { createClient } from "@/lib/supabase/server";

/** Minimal identity shape this repository needs — not imported from `lib/identity.ts` to avoid coupling this data-access layer to that module's auth/cookie concerns. */
export type AuthorIdentity = { type: "profile" | "guest"; id: string };

export type ChatMessage = {
  id: string;
  author_display_name: string;
  author_profile_id: string | null;
  author_guest_id: string | null;
  body: string;
  created_at: string;
  /**
   * Permanent marker set once at insert by `request_to_speak` (migration
   * 00000000000011, issue #14) — never flipped back, so this reflects
   * "was this submitted as a mic request," not "is it still pending."
   * Ordinary messages inserted via `insertMessage` below always get
   * `false`. See DECISIONS.md for why a request is a chat message with a
   * flag, not a separate entity.
   */
  is_speaker_request: boolean;
};

export type ReactionSummaryRow = {
  message_id: string;
  reactor_profile_id: string | null;
  reactor_guest_id: string | null;
};

function identityColumn(identity: AuthorIdentity) {
  return identity.type === "profile" ? "author_profile_id" : "author_guest_id";
}

export async function listRecentMessages(eventId: string, limit: number): Promise<ChatMessage[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("event_chat_messages")
    .select("id, author_display_name, author_profile_id, author_guest_id, body, created_at, is_speaker_request")
    .eq("event_id", eventId)
    .order("created_at", { ascending: false })
    .limit(limit);
  return data ?? [];
}

export async function listReactionsForMessages(messageIds: string[]): Promise<ReactionSummaryRow[]> {
  if (messageIds.length === 0) return [];
  const supabase = await createClient();
  const { data } = await supabase
    .from("event_chat_message_reactions")
    .select("message_id, reactor_profile_id, reactor_guest_id")
    .in("message_id", messageIds);
  return data ?? [];
}

/** One read, no separate rate-limit table — see ARCHITECTURE.md's guest rate-limiting design. */
export async function hasSentMessageRecently(
  eventId: string,
  identity: AuthorIdentity,
  withinMs: number,
): Promise<boolean> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("event_chat_messages")
    .select("created_at")
    .eq("event_id", eventId)
    .eq(identityColumn(identity), identity.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!data) return false;
  return Date.now() - new Date(data.created_at).getTime() < withinMs;
}

export async function insertMessage(params: {
  eventId: string;
  identity: AuthorIdentity;
  displayName: string;
  body: string;
  /**
   * Real-device report (optimistic-send redesign): client-generated —
   * the exact same id the caller already showed the user optimistically,
   * *before* this insert was even attempted. Passing it through
   * explicitly (rather than leaving the column to its own `default
   * gen_random_uuid()`) is what lets the client's own Realtime
   * subscription recognize its own confirmed row by exact id match,
   * never by guessing from body/display-name/timestamp — and what makes
   * a retry of an already-successful send idempotent (see `error.code
   * === "23505"` below): retrying with a *new* random id would always
   * insert a genuine duplicate row instead of safely no-op'ing against
   * the original.
   */
  id: string;
}): Promise<{ ok: boolean; error?: { message: string; code: string | undefined } }> {
  const supabase = await createClient();
  const { error } = await supabase.from("event_chat_messages").insert({
    id: params.id,
    event_id: params.eventId,
    author_profile_id: params.identity.type === "profile" ? params.identity.id : null,
    author_guest_id: params.identity.type === "guest" ? params.identity.id : null,
    author_display_name: params.displayName,
    body: params.body,
  });

  if (!error) return { ok: true };

  // Idempotent retry, same reasoning `insertReaction` below already
  // established: a primary-key conflict on this exact client-generated
  // id means the *original* attempt actually reached the database —
  // only its acknowledgment was lost (a dropped response, a client
  // retry firing before the first one's result came back) — never a
  // second, genuinely new row. Reported to the caller as success, not a
  // failure to retry again.
  if (error.code === "23505") return { ok: true };

  // Real-device report ("commenting is currently not working"): this
  // used to collapse `error` to a bare boolean, discarding the actual
  // Postgres error (an RLS rejection, an FK violation, a constraint
  // failure) entirely — undiagnosable from the caller's side no matter
  // how many times it failed. The caller (`sendMessage`) decides what a
  // *user* ever sees; this repository's job is just to stop throwing the
  // real reason away.
  return { ok: false, error: { message: error.message, code: error.code } };
}

export async function insertReaction(params: {
  messageId: string;
  identity: AuthorIdentity;
  emoji: string;
}): Promise<{ ok: boolean; alreadyReacted: boolean }> {
  const supabase = await createClient();
  const { error } = await supabase.from("event_chat_message_reactions").insert({
    message_id: params.messageId,
    reactor_profile_id: params.identity.type === "profile" ? params.identity.id : null,
    reactor_guest_id: params.identity.type === "guest" ? params.identity.id : null,
    emoji: params.emoji,
  });

  if (!error) return { ok: true, alreadyReacted: false };

  // Unique-constraint violation just means "already reacted" — not a
  // failure from the caller's point of view.
  const alreadyReacted = error.code === "23505";
  return { ok: alreadyReacted, alreadyReacted };
}
