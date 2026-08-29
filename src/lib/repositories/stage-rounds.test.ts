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

type Label = "speaker1" | "speaker2" | "a" | "b" | "c";

/**
 * Integration tests for issue #21's corrective pass — the shared
 * `stage_rounds` clock and `claim_speaker_seat`'s new race guard —
 * against the real linked Supabase project, same discipline as
 * speaker-request-voting.test.ts (this file replaces the old
 * speaker-rounds.test.ts, whose subject, the per-speaker
 * `resolve_speaker_round` RPC, migration 00000000000024 drops
 * entirely). Every deadline is tested by backdating the real
 * `stage_rounds.ends_at`/`event_speakers.closing_ends_at` columns via
 * the service client, never by actually waiting 60/30 real seconds —
 * `resolve_stage_round`/`resolve_seat_closing` re-derive everything from
 * Postgres's own clock, so a backdated deadline is indistinguishable
 * from a genuinely elapsed one as far as the functions under test are
 * concerned.
 */
describe.skipIf(!hasServiceCredentials)("stage rounds (issue #21 corrective pass — shared round clock)", () => {
  let service: ReturnType<typeof createServiceClient>;
  const anonUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

  let eventId: string;
  const testUserIds: string[] = [];
  const profiles: Record<Label, { id: string; email: string; password: string }> = {} as never;

  async function createTestProfile(label: Label) {
    const email = `test-stage-round-${label}-${crypto.randomUUID()}@example.invalid`;
    const password = `Test-Passw0rd-${crypto.randomUUID()}`;
    const { data, error } = await service.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { display_name: `Test Stage Round ${label}` },
    });
    if (error || !data.user) throw new Error(error?.message ?? `failed to create test profile ${label}`);
    testUserIds.push(data.user.id);
    profiles[label] = { id: data.user.id, email, password };
  }

  async function signInAs(label: Label) {
    const { email, password } = profiles[label];
    const anon = createSupabaseClient(anonUrl, anonKey);
    const { data, error } = await anon.auth.signInWithPassword({ email, password });
    if (error || !data.session) throw new Error(error?.message ?? `failed to sign in as ${label}`);
    return createSupabaseClient<Database>(anonUrl, anonKey, {
      global: { headers: { Authorization: `Bearer ${data.session.access_token}` } },
    });
  }

  async function endExistingSeat(label: "speaker1" | "speaker2") {
    await service
      .from("event_speakers")
      .update({ left_at: new Date().toISOString(), left_reason: "voluntary" })
      .eq("event_id", eventId)
      .eq("profile_id", profiles[label].id)
      .is("left_at", null);
  }

  /**
   * Claims a fresh seat 1 for speaker1 only — vacates BOTH seat numbers
   * first (position-independent, safe to call regardless of what an
   * earlier test left behind), then leaves seat 2 vacant so the stage
   * stays awaiting_pairing. Passes `bypassSelectionAuthorization: true`
   * (issue #21, third corrective pass) — this file is about the shared
   * round clock, not about Request-to-Speak selection authorization
   * (which has its own dedicated test file,
   * seat-claim-authorization.test.ts), and this same shared event
   * legitimately becomes "established" partway through this file's own
   * test sequence, which would otherwise make every later claim here
   * fail a check unrelated to what's actually under test.
   */
  async function claimSeat1Only(): Promise<string> {
    await endExistingSeat("speaker1");
    await endExistingSeat("speaker2");
    await service.from("event_speakers").update({ left_at: new Date().toISOString(), left_reason: "voluntary" }).eq("event_id", eventId).in("seat_number", [1, 2]).is("left_at", null);
    const row = await claimSpeakerSeat(eventId, { type: "profile", id: profiles.speaker1.id }, 1, undefined, true);
    return row.id;
  }

  /** Claims fresh seats for both speaker1 (seat 1) and speaker2 (seat 2) — the pairing that starts the shared round. Ends any existing occupant of either seat number first, same "clean seat" discipline as the old file's claimFreshSeat. Bypasses selection authorization — see `claimSeat1Only`'s own doc comment for why. */
  async function claimBothSeats(): Promise<[string, string]> {
    await endExistingSeat("speaker1");
    await endExistingSeat("speaker2");
    await service.from("event_speakers").update({ left_at: new Date().toISOString(), left_reason: "voluntary" }).eq("event_id", eventId).in("seat_number", [1, 2]).is("left_at", null);
    const row1 = await claimSpeakerSeat(eventId, { type: "profile", id: profiles.speaker1.id }, 1, undefined, true);
    const row2 = await claimSpeakerSeat(eventId, { type: "profile", id: profiles.speaker2.id }, 2, undefined, true);
    return [row1.id, row2.id];
  }

  async function getStageRound() {
    const { data } = await service.from("stage_rounds").select("*").eq("event_id", eventId).single();
    return data!;
  }

  async function backdateStageRound() {
    await service.from("stage_rounds").update({ ends_at: new Date(Date.now() - 1000).toISOString() }).eq("event_id", eventId).eq("phase", "active");
  }

  async function backdateClosingEnd(eventSpeakersId: string) {
    await service.from("event_speakers").update({ closing_ends_at: new Date(Date.now() - 1000).toISOString() }).eq("id", eventSpeakersId);
  }

  /** 2 continue votes, 0 replace — a clean majority-continue outcome. */
  async function castContinueVotes(eventSpeakersId: string) {
    const asA = await signInAs("a");
    const asB = await signInAs("b");
    await asA.rpc("cast_speaker_round_vote", { p_event_speakers_id: eventSpeakersId, p_choice: "continue" });
    await asB.rpc("cast_speaker_round_vote", { p_event_speakers_id: eventSpeakersId, p_choice: "continue" });
  }

  /** 3 replace / 2 continue = 60% — strictly between the 50%/66% thresholds, never accidentally decisive. */
  async function castNarrowLossVotes(eventSpeakersId: string) {
    const asA = await signInAs("a");
    const asB = await signInAs("b");
    const asC = await signInAs("c");
    await asA.rpc("cast_speaker_round_vote", { p_event_speakers_id: eventSpeakersId, p_choice: "replace" });
    await asB.rpc("cast_speaker_round_vote", { p_event_speakers_id: eventSpeakersId, p_choice: "replace" });
    await asC.rpc("cast_speaker_round_vote", { p_event_speakers_id: eventSpeakersId, p_choice: "continue" });
    await service.rpc("cast_speaker_round_vote_as_guest", {
      p_event_speakers_id: eventSpeakersId,
      p_choice: "replace",
      p_guest_id: crypto.randomUUID(),
    });
    await service.rpc("cast_speaker_round_vote_as_guest", {
      p_event_speakers_id: eventSpeakersId,
      p_choice: "continue",
      p_guest_id: crypto.randomUUID(),
    });
  }

  /** 2 replace, 0 continue — 100% Replace, well past the 66% decisive threshold. */
  async function castDecisiveReplaceVotes(eventSpeakersId: string) {
    const asA = await signInAs("a");
    const asB = await signInAs("b");
    await asA.rpc("cast_speaker_round_vote", { p_event_speakers_id: eventSpeakersId, p_choice: "replace" });
    await asB.rpc("cast_speaker_round_vote", { p_event_speakers_id: eventSpeakersId, p_choice: "replace" });
  }

  beforeAll(async () => {
    service = createServiceClient();
    const { data: event, error } = await service
      .from("events")
      .insert({
        title: "Issue #21 corrective-pass stage-round test fixture event",
        scheduled_start: new Date(Date.now() - 60_000).toISOString(),
        lobby_opens_at: new Date(Date.now() - 5 * 60_000).toISOString(),
      })
      .select("id")
      .single();
    if (error || !event) throw new Error(error?.message ?? "failed to create test event");
    eventId = event.id;

    await createTestProfile("speaker1");
    await createTestProfile("speaker2");
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

  it("claiming the second seat starts the shared round: round 1, active, ~60s deadline, synced onto both seats — run first, before this event's stage_rounds row has ever existed", async () => {
    const [id1, id2] = await claimBothSeats();
    const round = await getStageRound();
    expect(round.phase).toBe("active");
    expect(round.round_number).toBe(1);
    const remainingMs = new Date(round.ends_at).getTime() - Date.now();
    expect(remainingMs).toBeGreaterThan(55_000);
    expect(remainingMs).toBeLessThanOrEqual(60_000);

    const { data: seat1 } = await service.from("event_speakers").select("*").eq("id", id1).single();
    const { data: seat2 } = await service.from("event_speakers").select("*").eq("id", id2).single();
    expect(seat1!.round_number).toBe(1);
    expect(seat1!.round_ends_at).toBe(round.ends_at);
    expect(seat2!.round_number).toBe(1);
    expect(seat2!.round_ends_at).toBe(round.ends_at);
  });

  it("claiming only one seat leaves the stage awaiting_pairing — no ticking countdown with only one speaker seated", async () => {
    await claimSeat1Only();
    const round = await getStageRound();
    expect(round.phase).toBe("awaiting_pairing");
  });

  it("resolving before the deadline is a no-op — the round stays active, nobody is evicted", async () => {
    const [id1, id2] = await claimBothSeats();
    const { data, error } = await service.rpc("resolve_stage_round", { p_event_id: eventId });
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
    const round = await getStageRound();
    expect(round.phase).toBe("active");
    const { data: seat1 } = await service.from("event_speakers").select("left_at").eq("id", id1).single();
    const { data: seat2 } = await service.from("event_speakers").select("left_at").eq("id", id2).single();
    expect(seat1!.left_at).toBeNull();
    expect(seat2!.left_at).toBeNull();
  });

  it("A continues while B decisively replaces at the same shared boundary — independent per-speaker outcomes, one shared deadline", async () => {
    const [id1, id2] = await claimBothSeats();
    await castContinueVotes(id1);
    await castDecisiveReplaceVotes(id2);
    await backdateStageRound();

    const { data, error } = await service.rpc("resolve_stage_round", { p_event_id: eventId });
    expect(error).toBeNull();
    const bySeat = new Map(data!.map((r) => [r.out_event_speakers_id, r.out_outcome]));
    expect(bySeat.get(id1)).toBe("continue");
    expect(bySeat.get(id2)).toBe("decisive-replace");

    const { data: seat1 } = await service.from("event_speakers").select("*").eq("id", id1).single();
    const { data: seat2 } = await service.from("event_speakers").select("*").eq("id", id2).single();
    expect(seat1!.left_at).toBeNull();
    expect(seat2!.left_at).not.toBeNull();
    expect(seat2!.left_reason).toBe("replaced");

    // Only one seat remains occupied — the pairing waits for a
    // replacement rather than starting a fresh round for the lone
    // continuing speaker (Part 5: no independent timer while waiting for
    // the partner's replacement).
    const round = await getStageRound();
    expect(round.phase).toBe("awaiting_pairing");
  });

  it("both speakers continuing starts a fresh shared round for both, still paired", async () => {
    const [id1, id2] = await claimBothSeats();
    const roundBefore = await getStageRound();
    await castContinueVotes(id1);
    await castContinueVotes(id2);
    await backdateStageRound();

    const { data } = await service.rpc("resolve_stage_round", { p_event_id: eventId });
    expect(data!.every((r) => r.out_outcome === "continue")).toBe(true);

    const round = await getStageRound();
    expect(round.phase).toBe("active");
    expect(round.round_number).toBe(roundBefore.round_number + 1);

    const { data: seat1 } = await service.from("event_speakers").select("*").eq("id", id1).single();
    const { data: seat2 } = await service.from("event_speakers").select("*").eq("id", id2).single();
    expect(seat1!.left_at).toBeNull();
    expect(seat1!.round_number).toBe(round.round_number);
    expect(seat1!.round_ends_at).toBe(round.ends_at);
    expect(seat2!.left_at).toBeNull();
    expect(seat2!.round_number).toBe(round.round_number);
    expect(seat2!.round_ends_at).toBe(round.ends_at);
  });

  it("both speakers decisively replaced empties the stage — awaiting_pairing until refilled", async () => {
    const [id1, id2] = await claimBothSeats();
    await castDecisiveReplaceVotes(id1);
    await castDecisiveReplaceVotes(id2);
    await backdateStageRound();

    const { data } = await service.rpc("resolve_stage_round", { p_event_id: eventId });
    expect(data!.every((r) => r.out_outcome === "decisive-replace")).toBe(true);

    const { data: seat1 } = await service.from("event_speakers").select("left_at").eq("id", id1).single();
    const { data: seat2 } = await service.from("event_speakers").select("left_at").eq("id", id2).single();
    expect(seat1!.left_at).not.toBeNull();
    expect(seat2!.left_at).not.toBeNull();

    const round = await getStageRound();
    expect(round.phase).toBe("awaiting_pairing");
  });

  it("a narrow loss produces individual closing for that seat only — the continuing partner does not get a fresh independent timer meanwhile", async () => {
    const [id1, id2] = await claimBothSeats();
    await castContinueVotes(id1);
    // 3 replace / 2 continue = 60% for seat 2 — strictly between thresholds.
    await castNarrowLossVotes(id2);
    await backdateStageRound();

    const { data } = await service.rpc("resolve_stage_round", { p_event_id: eventId });
    const bySeat = new Map(data!.map((r) => [r.out_event_speakers_id, r.out_outcome]));
    expect(bySeat.get(id1)).toBe("continue");
    expect(bySeat.get(id2)).toBe("narrow-loss");

    const { data: seat1 } = await service.from("event_speakers").select("*").eq("id", id1).single();
    const { data: seat2 } = await service.from("event_speakers").select("*").eq("id", id2).single();
    expect(seat1!.left_at).toBeNull();
    expect(seat2!.left_at).toBeNull(); // still occupied — closing, not evicted yet
    expect(seat2!.round_phase).toBe("closing");
    expect(seat2!.closing_ends_at).not.toBeNull();

    // The shared round backs off to awaiting_pairing while one seat is
    // closing — seat1 (the continuing speaker) is NOT given a fresh
    // round_number/round_ends_at while this is happening.
    const round = await getStageRound();
    expect(round.phase).toBe("awaiting_pairing");
    expect(seat1!.round_number).toBe(round.round_number);
  });

  it("the closing period expiring replaces that one seat regardless of later activity, and the next shared round begins only once the vacancy is refilled", async () => {
    const [id1, id2] = await claimBothSeats();
    await castContinueVotes(id1);
    await castNarrowLossVotes(id2);
    await backdateStageRound();
    await service.rpc("resolve_stage_round", { p_event_id: eventId }); // seat2 now closing

    await backdateClosingEnd(id2);
    const { data, error } = await service.rpc("resolve_seat_closing", { p_event_speakers_id: id2 });
    expect(error).toBeNull();
    expect(data?.[0]?.out_outcome).toBe("replaced-after-closing");

    const { data: seat2 } = await service.from("event_speakers").select("left_at, left_reason").eq("id", id2).single();
    expect(seat2!.left_at).not.toBeNull();
    expect(seat2!.left_reason).toBe("replaced");

    const { count: remainingVotes } = await service
      .from("speaker_round_votes")
      .select("*", { count: "exact", head: true })
      .eq("event_speakers_id", id2);
    expect(remainingVotes).toBe(0);

    // Still only one seat occupied — stage waits.
    let round = await getStageRound();
    expect(round.phase).toBe("awaiting_pairing");
    const roundNumberWhileWaiting = round.round_number;

    // Refilling seat 2 starts the next shared round for the resulting
    // pairing. Bypasses selection authorization — see `claimSeat1Only`'s
    // own doc comment; this test is about round bookkeeping, not
    // Request-to-Speak selection.
    const newSeat2 = await claimSpeakerSeat(eventId, { type: "profile", id: profiles.speaker2.id }, 2, undefined, true);
    round = await getStageRound();
    expect(round.phase).toBe("active");
    expect(round.round_number).toBe(roundNumberWhileWaiting + 1);

    const { data: seat1 } = await service.from("event_speakers").select("round_number, round_ends_at").eq("id", id1).single();
    expect(seat1!.round_number).toBe(round.round_number);
    expect(seat1!.round_ends_at).toBe(round.ends_at);
    const { data: seat2Fresh } = await service.from("event_speakers").select("round_number, round_ends_at").eq("id", newSeat2.id).single();
    expect(seat2Fresh!.round_number).toBe(round.round_number);
    expect(seat2Fresh!.round_ends_at).toBe(round.ends_at);
  });

  it("claim_speaker_seat refuses to steal an already-occupied seat — the corrective pass's race fix", async () => {
    await claimBothSeats();
    await expect(claimSpeakerSeat(eventId, { type: "guest", id: crypto.randomUUID() }, 1, "Late Claimant")).rejects.toThrow(/already occupied/);
  });

  it("resolve_stage_round, resolve_seat_closing, and ensure_stage_round are not callable by an ordinary authenticated user", async () => {
    await claimBothSeats();
    const asA = await signInAs("a");

    const { error: resolveError } = await asA.rpc("resolve_stage_round", { p_event_id: eventId });
    expect(resolveError?.code).toBe("42501");

    const { error: closingError } = await asA.rpc("resolve_seat_closing", { p_event_speakers_id: crypto.randomUUID() });
    expect(closingError?.code).toBe("42501");

    const { error: ensureError } = await asA.rpc("ensure_stage_round", { p_event_id: eventId });
    expect(ensureError?.code).toBe("42501");
  });
});

/**
 * Issue #21, second corrective pass: real-device testing found "Start
 * Simulated Session" intermittently produced only one occupied seat,
 * fixed by Stop/Start again — the signature of a lost race, not a flaky
 * UI. Traced to `ensure_stage_round`'s cold-start INSERT having no
 * conflict handling: two seats claimed at nearly the same instant (the
 * simulator's own former `Promise.allSettled` seeding, or two real
 * people tapping both open seats together) could both reach
 * `ensure_stage_round` with no `stage_rounds` row yet visible to either
 * transaction, and the loser's uncaught unique-constraint violation
 * rolled back its *entire* transaction — including the seat claim
 * itself. Migration 00000000000028 fixes this at the database layer.
 * This test needs its own fresh event (not the shared one above) — the
 * scenario under test specifically requires *no* stage_rounds row to
 * exist yet, which is only true once, before any other test in this
 * file has touched the event.
 */
describe.skipIf(!hasServiceCredentials)("stage rounds — concurrent cold-start race (migration 00000000000028 regression)", () => {
  let service: ReturnType<typeof createServiceClient>;
  let eventId: string;

  beforeAll(async () => {
    service = createServiceClient();
    const { data: event, error } = await service
      .from("events")
      .insert({
        title: "Issue #21 second corrective pass — concurrent seat-claim race fixture event",
        scheduled_start: new Date(Date.now() - 60_000).toISOString(),
        lobby_opens_at: new Date(Date.now() - 5 * 60_000).toISOString(),
      })
      .select("id")
      .single();
    if (error || !event) throw new Error(error?.message ?? "failed to create test event");
    eventId = event.id;
  }, 30_000);

  afterAll(async () => {
    if (eventId) await service.from("events").delete().eq("id", eventId);
  }, 30_000);

  it("two seats claimed at the exact same instant, on a brand-new event with no prior stage_rounds row, both succeed and the shared round starts active", async () => {
    const [seat1, seat2] = await Promise.all([
      claimSpeakerSeat(eventId, { type: "guest", id: crypto.randomUUID() }, 1, "Concurrent Claimant A"),
      claimSpeakerSeat(eventId, { type: "guest", id: crypto.randomUUID() }, 2, "Concurrent Claimant B"),
    ]);

    expect(seat1.left_at).toBeNull();
    expect(seat2.left_at).toBeNull();

    const { data: round } = await service.from("stage_rounds").select("*").eq("event_id", eventId).single();
    expect(round).not.toBeNull();
    expect(round!.phase).toBe("active");

    const { data: seat1Row } = await service.from("event_speakers").select("round_number, round_ends_at").eq("id", seat1.id).single();
    const { data: seat2Row } = await service.from("event_speakers").select("round_number, round_ends_at").eq("id", seat2.id).single();
    expect(seat1Row!.round_number).toBe(round!.round_number);
    expect(seat1Row!.round_ends_at).toBe(round!.ends_at);
    expect(seat2Row!.round_number).toBe(round!.round_number);
    expect(seat2Row!.round_ends_at).toBe(round!.ends_at);
  });
});
