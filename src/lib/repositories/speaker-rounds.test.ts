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
 * Integration tests for issue #21's Continue/Replace speaker-round
 * write path, against the real linked Supabase project — same
 * discipline as speaker-request-voting.test.ts. Round/closing deadlines
 * are always tested by backdating the real `round_ends_at`/
 * `closing_ends_at` columns via the service client (never by actually
 * waiting 60/30 real seconds) — `resolve_speaker_round` re-derives
 * everything from Postgres's own clock, so a backdated deadline is
 * indistinguishable from a genuinely elapsed one as far as the function
 * under test is concerned.
 */
describe.skipIf(!hasServiceCredentials)("speaker rounds (issue #21, Continue/Replace)", () => {
  let service: ReturnType<typeof createServiceClient>;
  const anonUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

  let eventId: string;
  const testUserIds: string[] = [];
  const profiles: Record<"speaker" | "a" | "b" | "c", { id: string; email: string; password: string }> =
    {} as never;

  async function createTestProfile(label: "speaker" | "a" | "b" | "c") {
    const email = `test-round-${label}-${crypto.randomUUID()}@example.invalid`;
    const password = `Test-Passw0rd-${crypto.randomUUID()}`;
    const { data, error } = await service.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { display_name: `Test Round ${label.toUpperCase()}` },
    });
    if (error || !data.user) throw new Error(error?.message ?? `failed to create test profile ${label}`);
    testUserIds.push(data.user.id);
    profiles[label] = { id: data.user.id, email, password };
  }

  async function signInAs(label: "speaker" | "a" | "b" | "c") {
    const { email, password } = profiles[label];
    const anon = createSupabaseClient(anonUrl, anonKey);
    const { data, error } = await anon.auth.signInWithPassword({ email, password });
    if (error || !data.session) throw new Error(error?.message ?? `failed to sign in as ${label}`);
    return createSupabaseClient<Database>(anonUrl, anonKey, {
      global: { headers: { Authorization: `Bearer ${data.session.access_token}` } },
    });
  }

  /** Claims a fresh seat for the "speaker" test profile and returns the new event_speakers row's id. Ends any existing occupancy first so each test starts from a clean seat. */
  async function claimFreshSeat(): Promise<string> {
    await service.from("event_speakers").update({ left_at: new Date().toISOString(), left_reason: "voluntary" }).eq("event_id", eventId).eq("profile_id", profiles.speaker.id).is("left_at", null);
    const row = await claimSpeakerSeat(eventId, { type: "profile", id: profiles.speaker.id }, 1);
    return row.id;
  }

  async function backdateRoundEnd(eventSpeakersId: string) {
    await service.from("event_speakers").update({ round_ends_at: new Date(Date.now() - 1000).toISOString() }).eq("id", eventSpeakersId);
  }

  async function backdateClosingEnd(eventSpeakersId: string) {
    await service.from("event_speakers").update({ closing_ends_at: new Date(Date.now() - 1000).toISOString() }).eq("id", eventSpeakersId);
  }

  /** Casts the same 3-replace/2-continue = 60% split the standalone narrow-loss test uses — strictly between the 50% and 66% thresholds, never accidentally decisive. */
  async function castNarrowLossVotes(eventSpeakersId: string) {
    const asA = await signInAs("a");
    const asB = await signInAs("b");
    const asC = await signInAs("c");
    const asSpeaker = await signInAs("speaker");
    await asA.rpc("cast_speaker_round_vote", { p_event_speakers_id: eventSpeakersId, p_choice: "replace" });
    await asB.rpc("cast_speaker_round_vote", { p_event_speakers_id: eventSpeakersId, p_choice: "replace" });
    await asC.rpc("cast_speaker_round_vote", { p_event_speakers_id: eventSpeakersId, p_choice: "continue" });
    await asSpeaker.rpc("cast_speaker_round_vote", { p_event_speakers_id: eventSpeakersId, p_choice: "continue" });
    await service.rpc("cast_speaker_round_vote_as_guest", {
      p_event_speakers_id: eventSpeakersId,
      p_choice: "replace",
      p_guest_id: crypto.randomUUID(),
    });
  }

  beforeAll(async () => {
    service = createServiceClient();
    const { data: event, error } = await service
      .from("events")
      .insert({
        title: "Issue #21 speaker-round test fixture event",
        scheduled_start: new Date(Date.now() - 60_000).toISOString(),
        lobby_opens_at: new Date(Date.now() - 5 * 60_000).toISOString(),
      })
      .select("id")
      .single();
    if (error || !event) throw new Error(error?.message ?? "failed to create test event");
    eventId = event.id;

    await createTestProfile("speaker");
    await createTestProfile("a");
    await createTestProfile("b");
    await createTestProfile("c");
  }, 30_000);

  afterAll(async () => {
    for (const id of testUserIds) {
      await service.auth.admin.deleteUser(id);
    }
    if (eventId) {
      await service.from("events").delete().eq("id", eventId);
    }
  }, 30_000);

  it("a freshly-claimed seat starts round 1, phase active, with a ~60s deadline", async () => {
    const id = await claimFreshSeat();
    const { data: row } = await service.from("event_speakers").select("*").eq("id", id).single();
    expect(row!.round_number).toBe(1);
    expect(row!.round_phase).toBe("active");
    const remainingMs = new Date(row!.round_ends_at).getTime() - Date.now();
    expect(remainingMs).toBeGreaterThan(55_000);
    expect(remainingMs).toBeLessThanOrEqual(60_000);
  });

  it("resolving before the deadline is a no-op", async () => {
    const id = await claimFreshSeat();
    const { data, error } = await service.rpc("resolve_speaker_round", { p_event_speakers_id: id });
    expect(error).toBeNull();
    expect(data?.[0]?.outcome).toBe("active-not-yet-expired");
    const { data: row } = await service.from("event_speakers").select("*").eq("id", id).single();
    expect(row!.round_phase).toBe("active");
    expect(row!.left_at).toBeNull();
  });

  it("zero votes at the deadline resolves to continue — a fresh round, not eviction", async () => {
    const id = await claimFreshSeat();
    await backdateRoundEnd(id);

    const { data, error } = await service.rpc("resolve_speaker_round", { p_event_speakers_id: id });
    expect(error).toBeNull();
    expect(data?.[0]?.outcome).toBe("continue");

    const { data: row } = await service.from("event_speakers").select("*").eq("id", id).single();
    expect(row!.left_at).toBeNull();
    expect(row!.round_number).toBe(2);
    const remainingMs = new Date(row!.round_ends_at).getTime() - Date.now();
    expect(remainingMs).toBeGreaterThan(55_000);
  });

  it("a vote can be cast, changed, and read back live", async () => {
    const id = await claimFreshSeat();
    const asA = await signInAs("a");

    let { error } = await asA.rpc("cast_speaker_round_vote", { p_event_speakers_id: id, p_choice: "continue" });
    expect(error).toBeNull();
    let { data: votes } = await service.from("speaker_round_votes").select("*").eq("event_speakers_id", id);
    expect(votes).toHaveLength(1);
    expect(votes![0].choice).toBe("continue");

    ({ error } = await asA.rpc("cast_speaker_round_vote", { p_event_speakers_id: id, p_choice: "replace" }));
    expect(error).toBeNull();
    ({ data: votes } = await service.from("speaker_round_votes").select("*").eq("event_speakers_id", id));
    expect(votes).toHaveLength(1); // same voter, changed choice, not a second row
    expect(votes![0].choice).toBe("replace");
  });

  it("an exact 50/50 tie resolves to continue, not narrow-loss", async () => {
    const id = await claimFreshSeat();
    const asA = await signInAs("a");
    const asB = await signInAs("b");
    await asA.rpc("cast_speaker_round_vote", { p_event_speakers_id: id, p_choice: "continue" });
    await asB.rpc("cast_speaker_round_vote", { p_event_speakers_id: id, p_choice: "replace" });
    await backdateRoundEnd(id);

    const { data } = await service.rpc("resolve_speaker_round", { p_event_speakers_id: id });
    expect(data?.[0]?.outcome).toBe("continue");
    const { data: row } = await service.from("event_speakers").select("*").eq("id", id).single();
    expect(row!.round_number).toBe(2);
  });

  it("Replace over 50% but under 66% is a narrow loss: phase becomes closing, seat stays occupied, no new round", async () => {
    const id = await claimFreshSeat();
    // 3 replace, 2 continue = 60% — strictly between the 50%/66% thresholds.
    await castNarrowLossVotes(id);
    await backdateRoundEnd(id);

    const { data, error } = await service.rpc("resolve_speaker_round", { p_event_speakers_id: id });
    expect(error).toBeNull();
    expect(data?.[0]?.outcome).toBe("narrow-loss");

    const { data: row } = await service.from("event_speakers").select("*").eq("id", id).single();
    expect(row!.left_at).toBeNull(); // still occupied — not evicted yet
    expect(row!.round_phase).toBe("closing");
    expect(row!.closing_ends_at).not.toBeNull();
    const remainingMs = new Date(row!.closing_ends_at!).getTime() - Date.now();
    expect(remainingMs).toBeGreaterThan(25_000);
    expect(remainingMs).toBeLessThanOrEqual(30_000);
  });

  it("no new vote is accepted once the round is in its closing period", async () => {
    const id = await claimFreshSeat();
    await castNarrowLossVotes(id);
    await backdateRoundEnd(id);
    const { data: resolved } = await service.rpc("resolve_speaker_round", { p_event_speakers_id: id });
    expect(resolved?.[0]?.outcome).toBe("narrow-loss"); // now closing

    // A brand-new voter, uninvolved in the vote above, still can't cast
    // once the round has moved to closing.
    const { error } = await service.rpc("cast_speaker_round_vote_as_guest", {
      p_event_speakers_id: id,
      p_choice: "continue",
      p_guest_id: crypto.randomUUID(),
    });
    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/no longer accepting votes/);
  });

  it("the closing period expiring replaces the speaker regardless of later activity — a guaranteed outcome, not another vote", async () => {
    const id = await claimFreshSeat();
    await castNarrowLossVotes(id);
    await backdateRoundEnd(id);
    const { data: resolved } = await service.rpc("resolve_speaker_round", { p_event_speakers_id: id });
    expect(resolved?.[0]?.outcome).toBe("narrow-loss"); // now closing

    await backdateClosingEnd(id);
    const { data, error } = await service.rpc("resolve_speaker_round", { p_event_speakers_id: id });
    expect(error).toBeNull();
    expect(data?.[0]?.outcome).toBe("replaced-after-closing");

    const { data: row } = await service.from("event_speakers").select("*").eq("id", id).single();
    expect(row!.left_at).not.toBeNull();
    expect(row!.left_reason).toBe("replaced");

    const { count: remainingVotes } = await service
      .from("speaker_round_votes")
      .select("*", { count: "exact", head: true })
      .eq("event_speakers_id", id);
    expect(remainingVotes).toBe(0);
  });

  it("Replace at or above 66% is decisive — replaced immediately at the round boundary, no closing period", async () => {
    const id = await claimFreshSeat();
    const asA = await signInAs("a");
    const asB = await signInAs("b");
    await asA.rpc("cast_speaker_round_vote", { p_event_speakers_id: id, p_choice: "replace" });
    await asB.rpc("cast_speaker_round_vote", { p_event_speakers_id: id, p_choice: "replace" });
    await backdateRoundEnd(id);

    const { data, error } = await service.rpc("resolve_speaker_round", { p_event_speakers_id: id });
    expect(error).toBeNull();
    expect(data?.[0]?.outcome).toBe("decisive-replace");

    const { data: row } = await service.from("event_speakers").select("*").eq("id", id).single();
    expect(row!.left_at).not.toBeNull();
    expect(row!.left_reason).toBe("replaced");
    expect(row!.round_phase).toBe("active"); // never entered closing
  });

  it("resolve_speaker_round and cast_speaker_round_vote_as_guest are not callable by an ordinary authenticated user", async () => {
    const id = await claimFreshSeat();
    const asA = await signInAs("a");

    const { error: resolveError } = await asA.rpc("resolve_speaker_round", { p_event_speakers_id: id });
    expect(resolveError?.code).toBe("42501");

    const { error: guestVoteError } = await asA.rpc("cast_speaker_round_vote_as_guest", {
      p_event_speakers_id: id,
      p_choice: "continue",
      p_guest_id: crypto.randomUUID(),
    });
    expect(guestVoteError?.code).toBe("42501");
  });
});
