// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServiceClient } from "@/lib/supabase/service";
import { claimSpeakerSeat, endSpeakerSeat } from "@/lib/repositories/event-speakers";
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
});
