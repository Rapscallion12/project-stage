// @vitest-environment node
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@/types/database";
import { createServiceClient } from "@/lib/supabase/service";
import { claimSpeakerSeat } from "./event-speakers";

const hasServiceCredentials = Boolean(
  process.env.NEXT_PUBLIC_SUPABASE_URL &&
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY &&
    process.env.SUPABASE_SERVICE_ROLE_KEY,
);

/**
 * Integration tests for issue #14's write path, against the real linked
 * Supabase project — same discipline as event-speakers-transitions.test.ts.
 * Skips gracefully without SUPABASE_SERVICE_ROLE_KEY. Tests run in
 * sequence and build on shared fixture state; see each test's comment
 * for what it assumes going in.
 */
describe.skipIf(!hasServiceCredentials)("speaker_requests write path (issue #14)", () => {
  let service: ReturnType<typeof createServiceClient>;
  const anonUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

  let eventId: string;
  const testUserIds: string[] = [];
  const profiles: Record<"a" | "b" | "c" | "d", { id: string; email: string; password: string }> = {} as never;

  async function createTestProfile(label: "a" | "b" | "c" | "d") {
    const email = `test-requester-${label}-${crypto.randomUUID()}@example.invalid`;
    const password = `Test-Passw0rd-${crypto.randomUUID()}`;
    const { data, error } = await service.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { display_name: `Test Requester ${label.toUpperCase()}` },
    });
    if (error || !data.user) throw new Error(error?.message ?? `failed to create test profile ${label}`);
    testUserIds.push(data.user.id);
    profiles[label] = { id: data.user.id, email, password };
  }

  async function signInAs(label: "a" | "b" | "c" | "d") {
    const { email, password } = profiles[label];
    const anon = createSupabaseClient(anonUrl, anonKey);
    const { data, error } = await anon.auth.signInWithPassword({ email, password });
    if (error || !data.session) throw new Error(error?.message ?? `failed to sign in as ${label}`);
    return createSupabaseClient<Database>(anonUrl, anonKey, {
      global: { headers: { Authorization: `Bearer ${data.session.access_token}` } },
    });
  }

  async function messagesFor(profileLabel: "a" | "b" | "c" | "d") {
    const { data } = await service
      .from("event_chat_messages")
      .select("id, is_speaker_request")
      .eq("event_id", eventId)
      .eq("author_profile_id", profiles[profileLabel].id);
    return data ?? [];
  }

  async function requestsFor(profileLabel: "a" | "b" | "c" | "d") {
    const { data } = await service
      .from("speaker_requests")
      .select("*")
      .eq("event_id", eventId)
      .eq("profile_id", profiles[profileLabel].id);
    return data ?? [];
  }

  beforeAll(async () => {
    service = createServiceClient();
    const { data: event, error } = await service
      .from("events")
      .insert({
        title: "Issue #14 test fixture event",
        scheduled_start: new Date(Date.now() + 60_000).toISOString(),
        lobby_opens_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    if (error || !event) throw new Error(error?.message ?? "failed to create test event");
    eventId = event.id;

    await createTestProfile("a");
    await createTestProfile("b");
    await createTestProfile("c");
    await createTestProfile("d");
  }, 30_000);

  afterAll(async () => {
    for (const id of testUserIds) {
      await service.auth.admin.deleteUser(id);
    }
    if (eventId) {
      await service.from("events").delete().eq("id", eventId);
    }
  }, 30_000);

  it("request_to_speak atomically creates a chat message and a pending request", async () => {
    const asA = await signInAs("a");
    const { data, error } = await asA.rpc("request_to_speak", {
      p_event_id: eventId,
      p_body: "I have thoughts on pineapple pizza.",
    });
    expect(error).toBeNull();
    const row = data?.[0];
    expect(row).toBeDefined();

    const { data: message } = await service
      .from("event_chat_messages")
      .select("*")
      .eq("id", row!.message_id)
      .single();
    expect(message?.is_speaker_request).toBe(true);
    expect(message?.body).toBe("I have thoughts on pineapple pizza.");

    const { data: request } = await service.from("speaker_requests").select("*").eq("id", row!.request_id).single();
    expect(request?.status).toBe("pending");
    expect(request?.message_id).toBe(row!.message_id);
    expect(request?.profile_id).toBe(profiles.a.id);
  });

  it("rejects a second pending request from the same profile", async () => {
    const asA = await signInAs("a");
    const { error } = await asA.rpc("request_to_speak", { p_event_id: eventId, p_body: "again" });
    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/already has a pending request/);
  });

  it("rejects a request from a profile who's currently an active speaker", async () => {
    await claimSpeakerSeat(eventId, profiles.b.id, 1);
    const asB = await signInAs("b");
    const { error } = await asB.rpc("request_to_speak", { p_event_id: eventId, p_body: "let me talk more" });
    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/already an active speaker/);
  });

  it("request creation is atomic: a losing concurrent request never leaves an orphaned message", async () => {
    const asC = await signInAs("c");
    const results = await Promise.allSettled([
      asC.rpc("request_to_speak", { p_event_id: eventId, p_body: "first attempt" }),
      asC.rpc("request_to_speak", { p_event_id: eventId, p_body: "second attempt" }),
    ]);

    // Both calls resolve without throwing (Postgres errors surface via
    // the RPC result's `error` field, not a JS exception) — what matters
    // is how many of them actually succeeded at the Postgres level.
    const succeeded = results.filter((r) => r.status === "fulfilled" && r.value.error === null);
    expect(succeeded.length).toBe(1); // the active-request partial unique index allows exactly one

    const messages = await messagesFor("c");
    const requests = await requestsFor("c");
    // The critical invariant: every message this profile posted as a
    // request has a corresponding speaker_requests row, and vice versa —
    // if the losing call's message insert hadn't been rolled back
    // alongside its failed speaker_requests insert (the atomicity this
    // migration exists to guarantee), this count would be 2 messages
    // against only 1 request row.
    expect(messages).toHaveLength(1);
    expect(requests).toHaveLength(1);
    expect(requests[0].message_id).toBe(messages[0].id);
  });

  it("withdraw_speaker_request ends the caller's own pending request and stamps resolved_at", async () => {
    const asA = await signInAs("a");
    const { data, error } = await asA.rpc("withdraw_speaker_request", { p_event_id: eventId });
    expect(error).toBeNull();
    expect(data?.status).toBe("withdrawn");
    expect(data?.resolved_at).not.toBeNull();
  });

  it("rejects withdrawal when the caller has no pending request", async () => {
    const asA = await signInAs("a"); // a already withdrew in the previous test
    const { error } = await asA.rpc("withdraw_speaker_request", { p_event_id: eventId });
    expect(error).not.toBeNull();
  });

  it("a profile can submit a new request after withdrawing their previous one", async () => {
    const asA = await signInAs("a");
    const { error } = await asA.rpc("request_to_speak", { p_event_id: eventId, p_body: "second try" });
    expect(error).toBeNull(); // the partial unique index only blocks a *pending* duplicate, not a withdrawn one
  });

  it("rank_pending_speaker_requests orders by reaction count, then recency", async () => {
    // a already has a pending request (0 reactions) from the previous test.
    const asD = await signInAs("d");
    const { data: dRequest } = await asD.rpc("request_to_speak", { p_event_id: eventId, p_body: "d's pitch" });
    const dMessageId = dRequest?.[0]?.message_id;
    if (!dMessageId) throw new Error("request_to_speak returned no message_id for d");

    // Give d's message two reactions so it should outrank a's zero-reaction request.
    await service.from("event_chat_message_reactions").insert([
      { message_id: dMessageId, reactor_profile_id: profiles.b.id, emoji: "👍" },
      { message_id: dMessageId, reactor_profile_id: profiles.c.id, emoji: "🔥" },
    ]);

    const { data: ranked, error } = await service.rpc("rank_pending_speaker_requests", { p_event_id: eventId });
    expect(error).toBeNull();
    expect(ranked?.[0]?.profile_id).toBe(profiles.d.id);
    expect(ranked?.[0]?.rank).toBe(1);
  });

  it("rank_pending_speaker_requests is not callable by an ordinary authenticated user — trusted-server-only", async () => {
    const asA = await signInAs("a");
    const { error } = await asA.rpc("rank_pending_speaker_requests", { p_event_id: eventId });
    expect(error).not.toBeNull();
    expect(error?.code).toBe("42501");
  });
});
