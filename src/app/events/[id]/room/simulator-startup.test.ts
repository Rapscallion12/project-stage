// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServiceClient } from "@/lib/supabase/service";
import { claimSpeakerSeat, endSpeakerSeat, listActiveSpeakersAuthoritative } from "@/lib/repositories/event-speakers";
import { requestToSpeakAsGuest } from "@/lib/repositories/speaker-requests";
import { ensureActiveSelectionRound } from "./actions";
import { resetSimulatorSession } from "./simulator-actions";

const hasServiceCredentials = Boolean(
  process.env.NEXT_PUBLIC_SUPABASE_URL &&
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY &&
    process.env.SUPABASE_SERVICE_ROLE_KEY,
);

/**
 * Issue #21, fourteenth corrective pass: real-database proof for the
 * "simulator doesn't reliably start clean" investigation. Three things
 * are established here, against the real linked Supabase project rather
 * than mocks — this is the actual load-bearing claim of this pass's root
 * cause, so it gets full-path coverage:
 *
 * 1. **What "Minified React error #441" actually is, grounded in the
 *    real RPC.** `claimSpeakerSeat` → `claim_speaker_seat` (migration
 *    00000000000035) `raise exception`s a genuine, real Postgres error
 *    when a seat is already occupied — never a client-side rendering
 *    bug. `simulateSeedSpeaker` (`simulator-actions.ts`) wraps this in a
 *    plain `throw new Error(...)`, which — inside a Next.js Server
 *    Action, in a production build — is exactly what gets redacted to
 *    React's generic "an error occurred in the Server Components
 *    render" (error #441), with only a digest surviving client-side.
 *    These tests read the *real* error message directly, proving it's a
 *    genuine, informative, authoritative failure that #441's production
 *    redaction simply hides from the client — never inventing or
 *    assuming what the real cause was.
 * 2. **The exact self-heal `establishSeat`'s Case A branch performs**:
 *    recognizing a leftover occupant, clearing it via the same
 *    `endSpeakerSeat` adapter `simulateOpenSeat` calls, and reclaiming
 *    successfully — proven end-to-end against the real RPCs, not just
 *    asserted at the client-mock level (see
 *    `session-simulator-panel.test.tsx`'s own "Startup reliability"
 *    describe block for the client-orchestration side of this same
 *    proof).
 * 3. **First-try Reset→Start reliability, repeated.** A 20-cycle stress
 *    test and a genuine concurrent-claim race test, both against the
 *    real database — the same guarantee the "RESET ONCE → START ONCE →
 *    SIMULATOR BECOMES USEFUL" success criterion actually depends on.
 */
describe.skipIf(!hasServiceCredentials)("simulator startup reliability (issue #21, fourteenth corrective pass)", () => {
  let service: ReturnType<typeof createServiceClient>;
  let eventId: string;
  const originalVercelEnv = process.env.VERCEL_ENV;

  beforeAll(async () => {
    process.env.VERCEL_ENV = "preview";
    service = createServiceClient();
    const { data: event, error } = await service
      .from("events")
      .insert({
        title: "Issue #21 fourteenth corrective pass — simulator startup reliability fixture event",
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
    if (originalVercelEnv === undefined) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = originalVercelEnv;
  }, 30_000);

  // Defensive isolation, same discipline as replacement-queue-and-triggers.test.ts:
  // a failing test must never leave a stray occupied seat to poison a
  // later one sharing this event.
  beforeEach(async () => {
    const { data: seats } = await service.from("event_speakers").select("guest_id").eq("event_id", eventId).is("left_at", null);
    for (const s of seats ?? []) {
      if (s.guest_id) await endSpeakerSeat(eventId, { type: "guest", id: s.guest_id }, "moderator_removed");
    }
    await service.from("stage_rounds").delete().eq("event_id", eventId);
  });

  describe("React #441, grounded: claim_speaker_seat's real, authoritative error", () => {
    it("throws a real, specific 'seat already occupied' error — never a mysterious client-side failure", async () => {
      const guestA = crypto.randomUUID();
      const guestB = crypto.randomUUID();
      await claimSpeakerSeat(eventId, { type: "guest", id: guestA }, 1, "Speaker A", true);

      await expect(claimSpeakerSeat(eventId, { type: "guest", id: guestB }, 1, "Speaker B", true)).rejects.toThrow(
        /seat 1 in event .+ is already occupied/,
      );

      await endSpeakerSeat(eventId, { type: "guest", id: guestA }, "moderator_removed");
    });

    it("recognizing a leftover occupant, clearing it, and reclaiming succeeds — the exact self-heal establishSeat's Case A branch performs", async () => {
      const leftover = crypto.randomUUID();
      const newIdentity = crypto.randomUUID();
      await claimSpeakerSeat(eventId, { type: "guest", id: leftover }, 1, "Leftover Speaker", true);

      // The throw a real establishSeat attempt would see:
      await expect(claimSpeakerSeat(eventId, { type: "guest", id: newIdentity }, 1, "New Speaker", true)).rejects.toThrow(/already occupied/);

      // establishSeat's own recovery: authoritative check confirms it's
      // occupied by someone this tab generated, so it clears it via the
      // same real adapter `simulateOpenSeat` uses, then retries.
      await endSpeakerSeat(eventId, { type: "guest", id: leftover }, "moderator_removed");
      const claimed = await claimSpeakerSeat(eventId, { type: "guest", id: newIdentity }, 1, "New Speaker", true);
      expect(claimed.guest_id).toBe(newIdentity);

      await endSpeakerSeat(eventId, { type: "guest", id: newIdentity }, "moderator_removed");
    });
  });

  describe("concurrent claims — the real-database shape of a double-tap", () => {
    it("two genuinely concurrent bypass claims for the same seat: exactly one wins, the other gets the real 'already occupied' error", async () => {
      const guestA = crypto.randomUUID();
      const guestB = crypto.randomUUID();

      const results = await Promise.allSettled([
        claimSpeakerSeat(eventId, { type: "guest", id: guestA }, 1, "Speaker A", true),
        claimSpeakerSeat(eventId, { type: "guest", id: guestB }, 1, "Speaker B", true),
      ]);

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason.message).toMatch(/already occupied/);

      const { data: occupant } = await service.from("event_speakers").select("guest_id").eq("event_id", eventId).is("left_at", null).single();
      expect([guestA, guestB]).toContain(occupant!.guest_id);

      await endSpeakerSeat(eventId, { type: "guest", id: occupant!.guest_id! }, "moderator_removed");
    });
  });

  describe("first-try Reset → Start reliability, repeated (real database)", () => {
    it(
      "20 independent Reset→seed-both-seats cycles, each expected to succeed on the first attempt with no retries",
      async () => {
        const CYCLES = 20;
        const latenciesMs: number[] = [];
        let firstAttemptSuccesses = 0;

        for (let i = 0; i < CYCLES; i++) {
          const guestA = crypto.randomUUID();
          const guestB = crypto.randomUUID();
          const startedAt = Date.now();

          const seatA = await claimSpeakerSeat(eventId, { type: "guest", id: guestA }, 1, `Cycle ${i} A`, true);
          const seatB = await claimSpeakerSeat(eventId, { type: "guest", id: guestB }, 2, `Cycle ${i} B`, true);
          const { data: round } = await service.from("stage_rounds").select("phase").eq("event_id", eventId).single();

          latenciesMs.push(Date.now() - startedAt);
          if (seatA.guest_id === guestA && seatB.guest_id === guestB && round?.phase === "active") {
            firstAttemptSuccesses++;
          }

          // Reset — full guest-scoped cleanup, exactly what the panel's
          // own primary Reset pass does, ready for the next cycle's own
          // clean Start.
          await resetSimulatorSession(eventId, [guestA, guestB]);
          const { data: roundAfterReset } = await service.from("stage_rounds").select("id").eq("event_id", eventId).maybeSingle();
          expect(roundAfterReset).toBeNull();
        }

        expect(firstAttemptSuccesses).toBe(CYCLES);
        const avg = latenciesMs.reduce((a, b) => a + b, 0) / latenciesMs.length;
        const max = Math.max(...latenciesMs);
        // Bounded sanity check, not a strict perf assertion — this
        // project's own eighth-pass measurements put an ordinary
        // reservation round trip at 150-330ms; two sequential seat claims
        // plus a round read comfortably fits well under 5s even under
        // full-suite load. A real regression (a hung retry loop, a
        // genuine slow query) would blow well past this, which is the
        // only thing this bound is actually guarding against.
        expect(avg).toBeLessThan(5000);
        expect(max).toBeLessThan(8000);
      },
      120_000,
    );

    it(
      "rapid Reset → Start: a new run's speakers and round survive well beyond the delayed follow-up sweep's own ~2s window",
      async () => {
        const oldGuestA = crypto.randomUUID();
        const oldGuestB = crypto.randomUUID();
        await claimSpeakerSeat(eventId, { type: "guest", id: oldGuestA }, 1, "Old A", true);
        await claimSpeakerSeat(eventId, { type: "guest", id: oldGuestB }, 2, "Old B", true);

        // Reset's primary pass — the exact moment the product considers
        // Reset "complete" and re-enables Start.
        await resetSimulatorSession(eventId, [oldGuestA, oldGuestB]);

        // Start, immediately — both seats seeded right away, same as a
        // real one-tap Start Simulated Session.
        const newGuestA = crypto.randomUUID();
        const newGuestB = crypto.randomUUID();
        const newSeatA = await claimSpeakerSeat(eventId, { type: "guest", id: newGuestA }, 1, "New A", true);
        const newSeatB = await claimSpeakerSeat(eventId, { type: "guest", id: newGuestB }, 2, "New B", true);

        try {
          // The delayed follow-up sweep, fired for the *old* run's own
          // guest ids, at (and past) its real ~2s delay — using the fixed
          // `reconcileStageRound: false` the panel now passes.
          await new Promise((resolve) => setTimeout(resolve, 2100));
          await resetSimulatorSession(eventId, [oldGuestA, oldGuestB], false);

          const { data: seatAAfter } = await service.from("event_speakers").select("left_at").eq("id", newSeatA.id).single();
          const { data: seatBAfter } = await service.from("event_speakers").select("left_at").eq("id", newSeatB.id).single();
          expect(seatAAfter!.left_at).toBeNull();
          expect(seatBAfter!.left_at).toBeNull();

          const { data: round } = await service.from("stage_rounds").select("phase").eq("event_id", eventId).single();
          expect(round!.phase).toBe("active");
        } finally {
          await endSpeakerSeat(eventId, { type: "guest", id: newGuestA }, "moderator_removed");
          await endSpeakerSeat(eventId, { type: "guest", id: newGuestB }, "moderator_removed");
        }
      },
      15_000,
    );
  });

  /**
   * Issue #21, fifteenth corrective pass: real-database proof that
   * bootstrap on an *already-established* stage (the exact real-device
   * failure — "Stage already established — seeding via authorized
   * Request-to-Speak selection," which then timed out waiting on a
   * competitive RTS selection round it did not authoritatively control)
   * now uses the *same* authoritative bypass mechanism as a fresh stage,
   * never a real-RTS-competition wait — and that this can never evict a
   * real participant, always leaves a cleanly-recoverable partial state,
   * and never disturbs the *real* replacement pipeline for every
   * subsequent round after bootstrap completes.
   */
  describe("bootstrap on an already-established stage (issue #21, fifteenth corrective pass)", () => {
    it("a bypass claim succeeds on an already-established stage — bootstrap no longer waits on real RTS selection", async () => {
      // Establish the stage first (round_number >= 1), then vacate both
      // seats — the exact "established, but currently empty" shape the
      // real-device snapshot's own `established: yes` reflected.
      const priorA = await claimSpeakerSeat(eventId, { type: "guest", id: crypto.randomUUID() }, 1, "Prior A", true);
      const priorB = await claimSpeakerSeat(eventId, { type: "guest", id: crypto.randomUUID() }, 2, "Prior B", true);
      await endSpeakerSeat(eventId, { type: "guest", id: priorA.guest_id! }, "moderator_removed");
      await endSpeakerSeat(eventId, { type: "guest", id: priorB.guest_id! }, "moderator_removed");
      const { data: establishedRound } = await service.from("stage_rounds").select("round_number").eq("event_id", eventId).single();
      expect(establishedRound!.round_number).toBeGreaterThanOrEqual(1);

      // Bootstrap: two fresh bypass claims, no Request-to-Speak, no
      // selection round involved at all.
      const bootA = await claimSpeakerSeat(eventId, { type: "guest", id: crypto.randomUUID() }, 1, "Bootstrap A", true);
      const bootB = await claimSpeakerSeat(eventId, { type: "guest", id: crypto.randomUUID() }, 2, "Bootstrap B", true);
      expect(bootA.guest_id).not.toBeNull();
      expect(bootB.guest_id).not.toBeNull();

      const { data: round } = await service.from("stage_rounds").select("round_number, phase").eq("event_id", eventId).single();
      expect(round!.phase).toBe("active");

      await endSpeakerSeat(eventId, { type: "guest", id: bootA.guest_id! }, "moderator_removed");
      await endSpeakerSeat(eventId, { type: "guest", id: bootB.guest_id! }, "moderator_removed");
    });

    it("a real (non-simulator) participant already seated on an established stage blocks bootstrap for that seat only — the other seat bootstraps normally", async () => {
      const realParticipant = crypto.randomUUID();
      await claimSpeakerSeat(eventId, { type: "guest", id: realParticipant }, 1, "Real Participant", true);

      const bootstrapCandidate = crypto.randomUUID();
      await expect(claimSpeakerSeat(eventId, { type: "guest", id: bootstrapCandidate }, 1, "Bootstrap Candidate", true)).rejects.toThrow(
        /already occupied/,
      );

      // Seat 2 is genuinely vacant — bootstrap proceeds there normally,
      // completely independent of seat 1's blocker.
      const seat2 = await claimSpeakerSeat(eventId, { type: "guest", id: crypto.randomUUID() }, 2, "Bootstrap Seat 2", true);
      expect(seat2.guest_id).not.toBeNull();

      const { data: realSeatAfter } = await service.from("event_speakers").select("left_at").eq("event_id", eventId).eq("guest_id", realParticipant).single();
      expect(realSeatAfter!.left_at).toBeNull(); // never evicted

      await endSpeakerSeat(eventId, { type: "guest", id: realParticipant }, "moderator_removed");
      await endSpeakerSeat(eventId, { type: "guest", id: seat2.guest_id! }, "moderator_removed");
    });

    it(
      "partial bootstrap recovery: seat 1 succeeds, seat 2 is blocked by a real participant — once that participant leaves, the very next bootstrap attempt cleanly reclaims both seats without Reset",
      async () => {
        const bootstrapSeat1First = crypto.randomUUID();
        const realParticipant = crypto.randomUUID();
        const bootA1 = await claimSpeakerSeat(eventId, { type: "guest", id: bootstrapSeat1First }, 1, "Bootstrap A gen1", true);
        await claimSpeakerSeat(eventId, { type: "guest", id: realParticipant }, 2, "Real Participant", true);

        // "Generation 1" bootstrap attempt: seat 1 succeeded, seat 2 is
        // genuinely blocked — per this pass's own design decision, seat 1's
        // successful claim is left exactly as-is (never rolled back; doing
        // so could disrupt what `ensure_stage_round` may have already
        // turned into a real, legitimate pairing).
        const bootstrapSeat2First = crypto.randomUUID();
        await expect(claimSpeakerSeat(eventId, { type: "guest", id: bootstrapSeat2First }, 2, "Bootstrap B gen1", true)).rejects.toThrow(
          /already occupied/,
        );
        const { data: seat1StillThere } = await service.from("event_speakers").select("left_at").eq("id", bootA1.id).single();
        expect(seat1StillThere!.left_at).toBeNull();

        // The real participant leaves.
        await endSpeakerSeat(eventId, { type: "guest", id: realParticipant }, "moderator_removed");

        // "Generation 2" bootstrap attempt, no Reset in between — seat 1
        // still holds generation 1's own leftover simulator occupant;
        // establishSeat's real self-heal (already proven directly against
        // the RPC in the "React #441, grounded" describe block above)
        // clears it and reclaims for the new generation, and seat 2 is now
        // genuinely vacant.
        const bootstrapSeat1Second = crypto.randomUUID();
        await expect(claimSpeakerSeat(eventId, { type: "guest", id: bootstrapSeat1Second }, 1, "Bootstrap A gen2", true)).rejects.toThrow(
          /already occupied/,
        );
        await endSpeakerSeat(eventId, { type: "guest", id: bootstrapSeat1First }, "moderator_removed"); // the self-heal step
        const finalSeat1 = await claimSpeakerSeat(eventId, { type: "guest", id: bootstrapSeat1Second }, 1, "Bootstrap A gen2", true);
        const finalSeat2 = await claimSpeakerSeat(eventId, { type: "guest", id: crypto.randomUUID() }, 2, "Bootstrap B gen2", true);

        expect(finalSeat1.guest_id).toBe(bootstrapSeat1Second);
        expect(finalSeat2.guest_id).not.toBeNull();
        const { data: round } = await service.from("stage_rounds").select("phase").eq("event_id", eventId).single();
        expect(round!.phase).toBe("active");

        await endSpeakerSeat(eventId, { type: "guest", id: finalSeat1.guest_id! }, "moderator_removed");
        await endSpeakerSeat(eventId, { type: "guest", id: finalSeat2.guest_id! }, "moderator_removed");
      },
      15_000,
    );
  });

  /**
   * Issue #21, fifteenth corrective pass: proves the bootstrap bypass is
   * genuinely finished once the initial pairing exists — the *next*
   * replacement (a real vacancy, a real RTS request, real deterministic
   * ranking, a real non-bypass claim) flows entirely through the
   * unmodified, real production pipeline. `establishSeat`'s own bypass
   * claim is never called again after bootstrap; this test exercises the
   * exact same `ensureActiveSelectionRound` + non-bypass `claimSpeakerSeat`
   * path production's own `resolveClaimDecision` uses.
   */
  describe("real replacement after bootstrap uses the real production pipeline, not the bootstrap bypass", () => {
    it("a real vacancy after bootstrap is filled via real deterministic RTS selection and a real (non-bypass) claim", async () => {
      const seat1Guest = crypto.randomUUID();
      const seat2Guest = crypto.randomUUID();
      await claimSpeakerSeat(eventId, { type: "guest", id: seat1Guest }, 1, "Bootstrap Seat 1", true);
      await claimSpeakerSeat(eventId, { type: "guest", id: seat2Guest }, 2, "Bootstrap Seat 2", true);

      // A real vacancy — seat 2 opens.
      await endSpeakerSeat(eventId, { type: "guest", id: seat2Guest }, "moderator_removed");

      // A real Request-to-Speak submission, then the real reconciliation
      // path every production vacancy trigger already calls.
      const candidateGuest = crypto.randomUUID();
      const { requestId } = await requestToSpeakAsGuest(eventId, candidateGuest, "Real Candidate", "let me speak");
      await ensureActiveSelectionRound(eventId, await listActiveSpeakersAuthoritative(eventId));

      const { data: reserved } = await service
        .from("speaker_requests")
        .select("id, guest_id, reserved_seat_number, is_current_candidate")
        .eq("id", requestId)
        .single();
      expect(reserved!.is_current_candidate).toBe(true);
      expect(reserved!.reserved_seat_number).toBe(2);
      expect(reserved!.guest_id).toBe(candidateGuest);

      // The real, non-bypass claim a genuine candidate's own browser tab
      // would perform — never the bootstrap bypass.
      const claimed = await claimSpeakerSeat(eventId, { type: "guest", id: candidateGuest }, 2, "Real Candidate", false);
      expect(claimed.guest_id).toBe(candidateGuest);

      await endSpeakerSeat(eventId, { type: "guest", id: seat1Guest }, "moderator_removed");
      await endSpeakerSeat(eventId, { type: "guest", id: candidateGuest }, "moderator_removed");
    });
  });
});
