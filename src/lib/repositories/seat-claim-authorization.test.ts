// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServiceClient } from "@/lib/supabase/service";
import { claimSpeakerSeat, endSpeakerSeat } from "./event-speakers";
import {
  requestToSpeakAsGuest,
  castSpeakerRequestVoteAsGuest,
  withdrawSpeakerRequestAsGuest,
  markSpeakerRequestGranted,
  resetSpeakerCandidatePool,
} from "./speaker-requests";
import { resolveStageRound } from "./stage-rounds";
import { ensureActiveSelectionRound } from "@/app/events/[id]/room/actions";

const hasServiceCredentials = Boolean(
  process.env.NEXT_PUBLIC_SUPABASE_URL &&
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY &&
    process.env.SUPABASE_SERVICE_ROLE_KEY,
);

/**
 * Issue #21, third corrective pass: real-device finding — after a
 * speaker was removed, tapping the newly-open seat let the tapper become
 * the next speaker directly, bypassing Request-to-Speak selection
 * entirely. Migration 00000000000029 closes this at the database layer
 * (`claim_speaker_seat` itself, not just the UI); this file proves it
 * against the real linked project, including the exact race the report
 * described (an unauthorized direct claim submitted concurrently with
 * the authorized candidate's own claim). Also covers the deterministic
 * (no longer weighted-random) selection this same pass introduced —
 * highest vote count wins, earliest active request breaks a tie — since
 * that's the mechanism `claim_speaker_seat`'s authorization check
 * actually authorizes against.
 */
describe.skipIf(!hasServiceCredentials)("seat-claim authorization after initial stage formation (issue #21, third corrective pass)", () => {
  let service: ReturnType<typeof createServiceClient>;
  let eventId: string;

  async function activeSeats() {
    const { data } = await service.from("event_speakers").select("*").eq("event_id", eventId).is("left_at", null).order("seat_number");
    return data ?? [];
  }

  async function vacateAllSeats() {
    await service.from("event_speakers").update({ left_at: new Date().toISOString(), left_reason: "voluntary" }).eq("event_id", eventId).is("left_at", null);
  }

  /**
   * Same fact `isStageEstablished` (lib/repositories/stage-rounds.ts)
   * reads, via the service client instead — that function's own
   * `createClient()` is request-scoped (calls Next's `cookies()`), which
   * has no meaning in this bare Vitest test, same reasoning
   * `event-speakers-transitions.test.ts`'s own comment documents for the
   * identical class of issue.
   */
  async function stageEstablished(): Promise<boolean> {
    const { data } = await service.from("stage_rounds").select("round_number").eq("event_id", eventId).maybeSingle();
    return (data?.round_number ?? 0) >= 1;
  }

  /**
   * This file calls `claimSpeakerSeat` directly (the repository/RPC
   * layer under test) rather than the `claimOpenSeat` Server Action —
   * which means the follow-up bookkeeping that action normally performs
   * (`markSpeakerRequestGranted`, `resetSpeakerCandidatePool`) has to be
   * done explicitly here too, or a claimed request would be left
   * `is_current_candidate: true` forever, silently blocking every later
   * test's own selection from ever picking a *new* candidate (caught
   * live while writing this file: `ensureActiveSelectionRound` correctly
   * refuses to re-decide an already-decided round).
   */
  async function claimAsAuthorizedCandidate(guestId: string, seatNumber: 1 | 2, displayName: string, requestId: string) {
    const row = await claimSpeakerSeat(eventId, { type: "guest", id: guestId }, seatNumber, displayName);
    await markSpeakerRequestGranted(requestId);
    await resetSpeakerCandidatePool(eventId, requestId);
    return row;
  }

  beforeAll(async () => {
    service = createServiceClient();
    const { data: event, error } = await service
      .from("events")
      .insert({
        title: "Issue #21 third corrective pass — seat-claim authorization test fixture event",
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

  it("initial stage formation: direct claims are permitted for both seats, and the stage is not yet established", async () => {
    expect(await stageEstablished()).toBe(false);

    const a = await claimSpeakerSeat(eventId, { type: "guest", id: crypto.randomUUID() }, 1, "Initial Speaker A");
    const b = await claimSpeakerSeat(eventId, { type: "guest", id: crypto.randomUUID() }, 2, "Initial Speaker B");
    expect(a.left_at).toBeNull();
    expect(b.left_at).toBeNull();
  });

  it("the initial two-speaker pairing authoritatively transitions the stage to established — permanently", async () => {
    expect(await stageEstablished()).toBe(true);
  });

  it("after establishment, a direct claim by an ordinary viewer with no Request-to-Speak authorization is rejected", async () => {
    // The pairing from the previous test is still seated — end one seat
    // to open a genuine vacancy, same as a real replacement.
    const seats = await activeSeats();
    await endSpeakerSeat(eventId, { type: "guest", id: seats[1].guest_id! }, "moderator_removed");

    await expect(
      claimSpeakerSeat(eventId, { type: "guest", id: crypto.randomUUID() }, 2, "Unauthorized Viewer"),
    ).rejects.toThrow(/selection authorization/);

    // The seat genuinely stays open — not silently claimed by anyone.
    const seatsAfter = await activeSeats();
    expect(seatsAfter).toHaveLength(1);
  });

  it("the currently authorized Request-to-Speak candidate can claim the open seat", async () => {
    const guestId = crypto.randomUUID();
    const { requestId } = await requestToSpeakAsGuest(eventId, guestId, "Authorized Candidate", "let me speak");
    await ensureActiveSelectionRound(eventId);

    const row = await claimAsAuthorizedCandidate(guestId, 2, "Authorized Candidate", requestId);
    expect(row.left_at).toBeNull();
    expect(row.guest_id).toBe(guestId);
  });

  it("an unauthorized direct claim loses even when submitted concurrently with the authorized candidate's own claim — never a race, always rejected", async () => {
    // Vacate the pairing established above, then set up a fresh eligible
    // candidate for this test's own race.
    await vacateAllSeats();
    const a = await claimSpeakerSeat(eventId, { type: "guest", id: crypto.randomUUID() }, 1, "Race Test Speaker A", true);
    const authorizedGuestId = crypto.randomUUID();
    const { requestId } = await requestToSpeakAsGuest(eventId, authorizedGuestId, "Race Test Authorized", "let me speak");
    await ensureActiveSelectionRound(eventId);
    expect(await stageEstablished()).toBe(true); // still established from earlier tests' pairing

    const unauthorizedGuestId = crypto.randomUUID();
    const results = await Promise.allSettled([
      claimSpeakerSeat(eventId, { type: "guest", id: unauthorizedGuestId }, 2, "Race Test Unauthorized"),
      claimSpeakerSeat(eventId, { type: "guest", id: authorizedGuestId }, 2, "Race Test Authorized"),
    ]);

    expect(results[0].status).toBe("rejected");
    expect(results[1].status).toBe("fulfilled");
    await markSpeakerRequestGranted(requestId);
    await resetSpeakerCandidatePool(eventId, requestId);

    const seats = await activeSeats();
    const seat2 = seats.find((s) => s.seat_number === 2);
    expect(seat2?.guest_id).toBe(authorizedGuestId);
    expect(seat2?.guest_id).not.toBe(unauthorizedGuestId);

    await endSpeakerSeat(eventId, { type: "guest", id: a.guest_id! }, "moderator_removed");
    await endSpeakerSeat(eventId, { type: "guest", id: authorizedGuestId }, "moderator_removed");
  });

  it("full regression: A + B established, B replaced via round resolution, an unauthorized tap is rejected, the highest-voted candidate is authorized and claims the seat, next shared round begins", async () => {
    await vacateAllSeats();
    const a = await claimSpeakerSeat(eventId, { type: "guest", id: crypto.randomUUID() }, 1, "Speaker A", true);
    const b = await claimSpeakerSeat(eventId, { type: "guest", id: crypto.randomUUID() }, 2, "Speaker B", true);
    expect(await stageEstablished()).toBe(true);

    // Speaker B decisively replaced via the real shared-round resolver
    // (not a raw update) — backdate the shared deadline and cast a
    // decisive-replace split for B.
    const voterIds = [crypto.randomUUID(), crypto.randomUUID()];
    await service.rpc("cast_speaker_round_vote_as_guest", { p_event_speakers_id: b.id, p_choice: "replace", p_guest_id: voterIds[0] });
    await service.rpc("cast_speaker_round_vote_as_guest", { p_event_speakers_id: b.id, p_choice: "replace", p_guest_id: voterIds[1] });
    await service.from("stage_rounds").update({ ends_at: new Date(Date.now() - 1000).toISOString() }).eq("event_id", eventId).eq("phase", "active");
    const resolutions = await resolveStageRound(eventId);
    expect(resolutions.some((r) => r.eventSpeakersId === b.id && r.outcome === "decisive-replace")).toBe(true);

    // Seat 2 is now vacant — an ordinary viewer tapping it is rejected.
    const viewerX = crypto.randomUUID();
    await expect(claimSpeakerSeat(eventId, { type: "guest", id: viewerX }, 2, "Viewer X")).rejects.toThrow(/selection authorization/);

    // Two candidates request the mic; Y has more votes, so Y is
    // authorized (highest-votes-wins, deterministic — no weighted draw).
    const candidateZ = crypto.randomUUID();
    const { messageId: zMessageId } = await requestToSpeakAsGuest(eventId, candidateZ, "Candidate Z", "pick me");
    const candidateY = crypto.randomUUID();
    const { messageId: yMessageId, requestId: yRequestId } = await requestToSpeakAsGuest(eventId, candidateY, "Candidate Y", "pick me instead");
    await castSpeakerRequestVoteAsGuest(eventId, yMessageId, crypto.randomUUID());
    await castSpeakerRequestVoteAsGuest(eventId, yMessageId, crypto.randomUUID());
    await castSpeakerRequestVoteAsGuest(eventId, zMessageId, crypto.randomUUID());
    await ensureActiveSelectionRound(eventId);

    // Only Y (the authorized candidate) can claim — Viewer X is still rejected.
    await expect(claimSpeakerSeat(eventId, { type: "guest", id: viewerX }, 2, "Viewer X")).rejects.toThrow(/selection authorization/);
    const claimedY = await claimAsAuthorizedCandidate(candidateY, 2, "Candidate Y", yRequestId);
    expect(claimedY.guest_id).toBe(candidateY);

    // A + Y is the new pairing; a fresh shared round begins.
    const { data: round } = await service.from("stage_rounds").select("*").eq("event_id", eventId).single();
    expect(round!.phase).toBe("active");
    const seats = await activeSeats();
    expect(seats.map((s) => s.guest_id).sort()).toEqual([a.guest_id, candidateY].sort());

    await endSpeakerSeat(eventId, { type: "guest", id: a.guest_id! }, "moderator_removed");
    await endSpeakerSeat(eventId, { type: "guest", id: candidateY }, "moderator_removed");
  });

  it("simulateSeedSpeaker-style bypass still cannot steal an already-occupied seat, only an authentically open one", async () => {
    await vacateAllSeats();
    const a = await claimSpeakerSeat(eventId, { type: "guest", id: crypto.randomUUID() }, 1, "Bypass Test A", true);
    await expect(
      claimSpeakerSeat(eventId, { type: "guest", id: crypto.randomUUID() }, 1, "Bypass Test Intruder", true),
    ).rejects.toThrow(/already occupied/);
    await endSpeakerSeat(eventId, { type: "guest", id: a.guest_id! }, "moderator_removed");
  });
});

describe.skipIf(!hasServiceCredentials)("deterministic Request-to-Speak selection (issue #21, third corrective pass — highest votes wins)", () => {
  let service: ReturnType<typeof createServiceClient>;
  let eventId: string;

  beforeAll(async () => {
    service = createServiceClient();
    const { data: event, error } = await service
      .from("events")
      .insert({
        title: "Issue #21 third corrective pass — deterministic selection test fixture event",
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

  async function currentCandidateGuestId(): Promise<string | null> {
    const { data } = await service.from("speaker_requests").select("guest_id").eq("event_id", eventId).eq("status", "pending").eq("is_current_candidate", true).maybeSingle();
    return data?.guest_id ?? null;
  }

  it("the candidate with the most votes is selected — never a random draw among the eligible pool", async () => {
    const low = crypto.randomUUID();
    const high = crypto.randomUUID();
    const { messageId: lowMessageId } = await requestToSpeakAsGuest(eventId, low, "Low Votes", "a");
    const { messageId: highMessageId } = await requestToSpeakAsGuest(eventId, high, "High Votes", "b");
    await castSpeakerRequestVoteAsGuest(eventId, highMessageId, crypto.randomUUID());
    await castSpeakerRequestVoteAsGuest(eventId, highMessageId, crypto.randomUUID());
    await castSpeakerRequestVoteAsGuest(eventId, highMessageId, crypto.randomUUID());
    await castSpeakerRequestVoteAsGuest(eventId, lowMessageId, crypto.randomUUID());

    await ensureActiveSelectionRound(eventId);
    expect(await currentCandidateGuestId()).toBe(high);

    await withdrawSpeakerRequestAsGuest(eventId, low);
    await withdrawSpeakerRequestAsGuest(eventId, high);
  });

  it("an exact vote tie is broken by the earliest active request, never randomly", async () => {
    const earlier = crypto.randomUUID();
    const { messageId: earlierMessageId } = await requestToSpeakAsGuest(eventId, earlier, "Earlier Request", "a");
    await new Promise((resolve) => setTimeout(resolve, 1100)); // guarantee a distinct created_at
    const later = crypto.randomUUID();
    const { messageId: laterMessageId } = await requestToSpeakAsGuest(eventId, later, "Later Request", "b");
    await castSpeakerRequestVoteAsGuest(eventId, earlierMessageId, crypto.randomUUID());
    await castSpeakerRequestVoteAsGuest(eventId, earlierMessageId, crypto.randomUUID());
    await castSpeakerRequestVoteAsGuest(eventId, laterMessageId, crypto.randomUUID());
    await castSpeakerRequestVoteAsGuest(eventId, laterMessageId, crypto.randomUUID());

    await ensureActiveSelectionRound(eventId);
    expect(await currentCandidateGuestId()).toBe(earlier);

    await withdrawSpeakerRequestAsGuest(eventId, earlier);
    await withdrawSpeakerRequestAsGuest(eventId, later);
  }, 10_000);

  it("withdrawing before selection removes a candidate from ranking — the next-highest-voted eligible candidate wins instead", async () => {
    const leader = crypto.randomUUID();
    const runnerUp = crypto.randomUUID();
    const { messageId: leaderMessageId } = await requestToSpeakAsGuest(eventId, leader, "Leader", "a");
    await requestToSpeakAsGuest(eventId, runnerUp, "Runner Up", "b");
    await castSpeakerRequestVoteAsGuest(eventId, leaderMessageId, crypto.randomUUID());
    await castSpeakerRequestVoteAsGuest(eventId, leaderMessageId, crypto.randomUUID());

    // Leader withdraws before any freeze/selection ever happens.
    await withdrawSpeakerRequestAsGuest(eventId, leader);

    await ensureActiveSelectionRound(eventId);
    expect(await currentCandidateGuestId()).toBe(runnerUp);

    await withdrawSpeakerRequestAsGuest(eventId, runnerUp);
  });

  it("the selected candidate withdrawing (declining during Going Live) advances to the next eligible candidate by the same frozen ranking — never a fresh random draw", async () => {
    const winner = crypto.randomUUID();
    const nextUp = crypto.randomUUID();
    const { messageId: winnerMessageId } = await requestToSpeakAsGuest(eventId, winner, "Winner", "a");
    await requestToSpeakAsGuest(eventId, nextUp, "Next Up", "b");
    await castSpeakerRequestVoteAsGuest(eventId, winnerMessageId, crypto.randomUUID());
    await castSpeakerRequestVoteAsGuest(eventId, winnerMessageId, crypto.randomUUID());

    await ensureActiveSelectionRound(eventId);
    expect(await currentCandidateGuestId()).toBe(winner);

    // Declines during their own Going Live opportunity.
    await withdrawSpeakerRequestAsGuest(eventId, winner);
    expect(await currentCandidateGuestId()).toBe(nextUp);

    // That withdrawn request can never subsequently be promoted.
    const { data: winnerRow } = await service.from("speaker_requests").select("status, is_current_candidate").eq("guest_id", winner).eq("event_id", eventId).single();
    expect(winnerRow!.status).toBe("withdrawn");
    expect(winnerRow!.is_current_candidate).toBe(false);

    await withdrawSpeakerRequestAsGuest(eventId, nextUp);
  });

  it("if everyone in the frozen round declines, the seat has no authorized candidate and a brand-new request starts a fresh round", async () => {
    const onlyCandidate = crypto.randomUUID();
    await requestToSpeakAsGuest(eventId, onlyCandidate, "Only Candidate", "a");
    await ensureActiveSelectionRound(eventId);
    expect(await currentCandidateGuestId()).toBe(onlyCandidate);

    await withdrawSpeakerRequestAsGuest(eventId, onlyCandidate);
    expect(await currentCandidateGuestId()).toBeNull(); // round exhausted, nobody eligible

    const fresh = crypto.randomUUID();
    await requestToSpeakAsGuest(eventId, fresh, "Fresh Candidate", "b");
    await ensureActiveSelectionRound(eventId);
    expect(await currentCandidateGuestId()).toBe(fresh);

    await withdrawSpeakerRequestAsGuest(eventId, fresh);
  });
});
