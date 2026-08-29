// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServiceClient } from "@/lib/supabase/service";
import { claimSpeakerSeat, endSpeakerSeat } from "./event-speakers";
import { requestToSpeakAsGuest, markSpeakerRequestGranted, resetSpeakerCandidatePool } from "./speaker-requests";
import { ensureStageRound, resolveStageRound } from "./stage-rounds";
import { ensureActiveSelectionRound } from "@/app/events/[id]/room/actions";

const hasServiceCredentials = Boolean(
  process.env.NEXT_PUBLIC_SUPABASE_URL &&
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY &&
    process.env.SUPABASE_SERVICE_ROLE_KEY,
);

/**
 * Issue #21, fourth corrective pass: a real-device pass found the
 * simulator could reach a state with two "Selecting next speaker…" seats
 * while a shared round kept counting down — an invariant violation, not
 * merely a slow-selection cosmetic issue. This file proves the
 * *database-level* invariant that closes that gap, against the real
 * linked project, for both scenarios the corrective pass named
 * explicitly:
 *
 * - Section 22: an already-established stage (a prior pairing has
 *   happened), clean/empty seats, seeded back up one seat at a time via
 *   the exact real Request-to-Speak → selection → authorized-claim
 *   pipeline the simulator's own `establishSeat` Case B branch uses —
 *   never `stage_rounds.phase = 'active'` while fewer than 2 seats are
 *   occupied, and exactly one fresh round once both are.
 * - Section 23: an active pairing loses one speaker — no fresh round
 *   begins until the replacement is authorized and actually claims the
 *   seat, at which point exactly one new round begins.
 *
 * `ensure_stage_round` (migration 00000000000028, the current
 * authoritative definition) is what's actually asserted here: it's
 * idempotent and recomputes phase from *real* current occupancy on every
 * call, regardless of what triggered it — these tests exercise it
 * through the same real call sites the simulator/production code path
 * uses (`claim_speaker_seat`'s own side effect, and the exported
 * `ensureStageRound`/`resolveStageRound` used as the reactive backstop),
 * not a mocked stand-in.
 */
describe.skipIf(!hasServiceCredentials)("shared-round invariant: no active round without an established two-speaker pairing (issue #21, fourth corrective pass)", () => {
  let service: ReturnType<typeof createServiceClient>;
  let eventId: string;

  async function activeSeats() {
    const { data } = await service.from("event_speakers").select("*").eq("event_id", eventId).is("left_at", null).order("seat_number");
    return data ?? [];
  }

  async function vacateAllSeats() {
    await service.from("event_speakers").update({ left_at: new Date().toISOString(), left_reason: "voluntary" }).eq("event_id", eventId).is("left_at", null);
    // Mirrors the real vacancy path's own `ensure_stage_round` call
    // (`end_speaker_seat`/`leave_speaker_seat`) — this helper updates
    // rows directly for test setup speed, so it re-triggers the same
    // reconciliation those RPCs would have.
    await ensureStageRound(eventId);
  }

  async function stageRoundRow() {
    const { data } = await service.from("stage_rounds").select("round_number, phase").eq("event_id", eventId).maybeSingle();
    return data;
  }

  async function stageEstablished(): Promise<boolean> {
    const row = await stageRoundRow();
    return (row?.round_number ?? 0) >= 1;
  }

  /** The simulator's own Case B branch, reproduced exactly (Request-to-Speak → selection → authorized claim) — see `establishSeat` in session-simulator-panel.tsx. */
  async function establishSeatViaAuthorizedSelection(seatNumber: 1 | 2, displayName: string): Promise<string> {
    const guestId = crypto.randomUUID();
    const { requestId } = await requestToSpeakAsGuest(eventId, guestId, displayName, "let me speak");
    await ensureActiveSelectionRound(eventId);
    const row = await claimSpeakerSeat(eventId, { type: "guest", id: guestId }, seatNumber, displayName);
    await markSpeakerRequestGranted(requestId);
    await resetSpeakerCandidatePool(eventId, requestId);
    expect(row.left_at).toBeNull();
    return guestId;
  }

  beforeAll(async () => {
    service = createServiceClient();
    const { data: event, error } = await service
      .from("events")
      .insert({
        title: "Issue #21 fourth corrective pass — shared-round invariant test fixture event",
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

  it("Section 22: an established stage with both seats freshly empty never shows an active round until both seats are re-authorized and occupied", async () => {
    // Establish the stage once via ordinary initial-formation direct
    // joins, exactly like a real event's first pairing.
    await claimSpeakerSeat(eventId, { type: "guest", id: crypto.randomUUID() }, 1, "Seed Speaker A");
    await claimSpeakerSeat(eventId, { type: "guest", id: crypto.randomUUID() }, 2, "Seed Speaker B");
    expect(await stageEstablished()).toBe(true);
    expect((await stageRoundRow())?.phase).toBe("active");

    // Zero speakers → no active round.
    await vacateAllSeats();
    expect(await activeSeats()).toHaveLength(0);
    expect((await stageRoundRow())?.phase).toBe("awaiting_pairing");
    expect(await stageEstablished()).toBe(true); // permanent — never un-set by vacancy

    const roundBeforeReseed = (await stageRoundRow())?.round_number ?? 0;

    // One speaker → still no active round (this is the exact case the
    // real-device report caught: must never show as an active,
    // counting-down round).
    await establishSeatViaAuthorizedSelection(1, "Reseeded Speaker A");
    expect(await activeSeats()).toHaveLength(1);
    expect((await stageRoundRow())?.phase).toBe("awaiting_pairing");

    // Two speakers → exactly one new active round.
    await establishSeatViaAuthorizedSelection(2, "Reseeded Speaker B");
    const finalSeats = await activeSeats();
    expect(finalSeats).toHaveLength(2);
    const finalRound = await stageRoundRow();
    expect(finalRound?.phase).toBe("active");
    expect(finalRound?.round_number).toBe(roundBeforeReseed + 1);

    await endSpeakerSeat(eventId, { type: "guest", id: finalSeats[0].guest_id! }, "moderator_removed");
    await endSpeakerSeat(eventId, { type: "guest", id: finalSeats[1].guest_id! }, "moderator_removed");
  }, 20_000);

  it("Section 23: a speaker leaving an active round does not start a fresh round until the replacement is authorized and actually claims the seat", async () => {
    await vacateAllSeats();
    const a = await claimSpeakerSeat(eventId, { type: "guest", id: crypto.randomUUID() }, 1, "Speaker A", true);
    const b = await claimSpeakerSeat(eventId, { type: "guest", id: crypto.randomUUID() }, 2, "Speaker B", true);
    expect((await stageRoundRow())?.phase).toBe("active");
    const roundBeforeLoss = (await stageRoundRow())?.round_number ?? 0;

    // B loses decisively and leaves — round resolves, seat vacates.
    const voterIds = [crypto.randomUUID(), crypto.randomUUID()];
    await service.rpc("cast_speaker_round_vote_as_guest", { p_event_speakers_id: b.id, p_choice: "replace", p_guest_id: voterIds[0] });
    await service.rpc("cast_speaker_round_vote_as_guest", { p_event_speakers_id: b.id, p_choice: "replace", p_guest_id: voterIds[1] });
    await service.from("stage_rounds").update({ ends_at: new Date(Date.now() - 1000).toISOString() }).eq("event_id", eventId).eq("phase", "active");
    const resolutions = await resolveStageRound(eventId);
    expect(resolutions.some((r) => r.eventSpeakersId === b.id && r.outcome === "decisive-replace")).toBe(true);

    // A + replacement-pending — no fresh round yet, even though A is
    // still seated (this is the "1 speaker → no active round" case,
    // reached via replacement rather than fresh seeding).
    expect(await activeSeats()).toHaveLength(1);
    expect((await stageRoundRow())?.phase).toBe("awaiting_pairing");

    // Candidate C is selected, authorized, and claims B's old seat — the
    // resulting A + C pairing is established, and exactly one new shared
    // round begins.
    const c = await establishSeatViaAuthorizedSelection(2, "Speaker C");
    const finalSeats = await activeSeats();
    expect(finalSeats.map((s) => s.guest_id).sort()).toEqual([a.guest_id, c].sort());
    const finalRound = await stageRoundRow();
    expect(finalRound?.phase).toBe("active");
    expect(finalRound?.round_number).toBe(roundBeforeLoss + 1);

    await endSpeakerSeat(eventId, { type: "guest", id: a.guest_id! }, "moderator_removed");
    await endSpeakerSeat(eventId, { type: "guest", id: c }, "moderator_removed");
  }, 20_000);

  it("Section 23 (both leave): if both speakers leave at once, no new round begins until a fresh two-speaker pairing is re-established", async () => {
    await vacateAllSeats();
    const a = await claimSpeakerSeat(eventId, { type: "guest", id: crypto.randomUUID() }, 1, "Speaker D", true);
    const b = await claimSpeakerSeat(eventId, { type: "guest", id: crypto.randomUUID() }, 2, "Speaker E", true);
    expect((await stageRoundRow())?.phase).toBe("active");
    const roundBeforeLoss = (await stageRoundRow())?.round_number ?? 0;

    await endSpeakerSeat(eventId, { type: "guest", id: a.guest_id! }, "moderator_removed");
    await endSpeakerSeat(eventId, { type: "guest", id: b.guest_id! }, "moderator_removed");
    expect(await activeSeats()).toHaveLength(0);
    expect((await stageRoundRow())?.phase).toBe("awaiting_pairing");

    // Re-establishing one seat at a time — still no active round with
    // only one occupied.
    const f = await establishSeatViaAuthorizedSelection(1, "Speaker F");
    expect((await stageRoundRow())?.phase).toBe("awaiting_pairing");

    const g = await establishSeatViaAuthorizedSelection(2, "Speaker G");
    const finalRound = await stageRoundRow();
    expect(finalRound?.phase).toBe("active");
    expect(finalRound?.round_number).toBe(roundBeforeLoss + 1);

    await endSpeakerSeat(eventId, { type: "guest", id: f }, "moderator_removed");
    await endSpeakerSeat(eventId, { type: "guest", id: g }, "moderator_removed");
  }, 20_000);
});
