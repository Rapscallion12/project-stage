// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServiceClient } from "@/lib/supabase/service";
import { recordStageReactionAttempt } from "./stage-reactions";
import {
  REACTION_HEAT_COOLDOWN_EXIT,
  REACTION_HEAT_DRAIN_PER_SECOND,
  REACTION_HEAT_INCREMENT,
  REACTION_HEAT_MAX,
} from "@/lib/reactions/constants";

const hasServiceCredentials = Boolean(
  process.env.NEXT_PUBLIC_SUPABASE_URL &&
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY &&
    process.env.SUPABASE_SERVICE_ROLE_KEY,
);

/**
 * Pre-launch interaction pass, Section 5's "CRITICAL SECURITY RULE": the
 * visible client heat meter is UX only — this file is the real proof that
 * `record_stage_reaction_attempt` (migration
 * 00000000000045_stage_reaction_heat.sql) actually enforces the decay/
 * hysteresis budget against the live linked project, not just against a
 * mocked RPC. Same discipline and backdating technique (direct service-
 * client timestamp mutation instead of a real sleep) as
 * event-speakers-expiration.test.ts.
 */
describe.skipIf(!hasServiceCredentials)("record_stage_reaction_attempt (pre-launch interaction pass, Section 5)", () => {
  let service: ReturnType<typeof createServiceClient>;
  let eventId: string;
  let secondEventId: string;

  async function createTestEvent(title: string) {
    const { data, error } = await service
      .from("events")
      .insert({
        title,
        scheduled_start: new Date(Date.now() + 60_000).toISOString(),
        lobby_opens_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    if (error || !data) throw new Error(error?.message ?? "failed to create test event");
    return data.id as string;
  }

  async function backdate(targetEventId: string, guestId: string, secondsAgo: number) {
    await service
      .from("stage_reaction_heat")
      .update({ updated_at: new Date(Date.now() - secondsAgo * 1000).toISOString() })
      .eq("event_id", targetEventId)
      .eq("guest_id", guestId);
  }

  beforeAll(async () => {
    service = createServiceClient();
    eventId = await createTestEvent("Pre-launch interaction pass: reaction heat test fixture event");
    secondEventId = await createTestEvent("Pre-launch interaction pass: reaction heat test fixture event (second)");
  }, 30_000);

  afterAll(async () => {
    if (eventId) await service.from("events").delete().eq("id", eventId);
    if (secondEventId) await service.from("events").delete().eq("id", secondEventId);
  }, 30_000);

  it("a fresh identity's first reaction is accepted and heat rises by the configured increment", async () => {
    const guestId = crypto.randomUUID();
    const result = await recordStageReactionAttempt(eventId, { type: "guest", id: guestId });
    expect(result.accepted).toBe(true);
    expect(result.heatAfter).toBeCloseTo(REACTION_HEAT_INCREMENT, 5);
    expect(result.inCooldownAfter).toBe(false);
  });

  it("heat decays over elapsed time rather than staying stacked forever", async () => {
    const guestId = crypto.randomUUID();
    await recordStageReactionAttempt(eventId, { type: "guest", id: guestId });
    await backdate(eventId, guestId, 2); // 2s at the configured drain rate

    // Real network round-trips mean the actual elapsed time is "2s plus a
    // little" by the time the RPC computes it, not exactly 2s — assert the
    // decay happened (result is below the no-decay sum) without pinning an
    // exact value.
    const result = await recordStageReactionAttempt(eventId, { type: "guest", id: guestId });
    expect(result.heatAfter).toBeLessThan(2 * REACTION_HEAT_INCREMENT - 1);
    expect(result.heatAfter).toBeGreaterThan(REACTION_HEAT_INCREMENT);
  });

  it("sustained rapid reacting fills the meter to cooldown, and cooldown then rejects further attempts", async () => {
    const guestId = crypto.randomUUID();
    let last: Awaited<ReturnType<typeof recordStageReactionAttempt>> | null = null;
    // Enough back-to-back calls (no time to decay meaningfully between them)
    // to guarantee the cap is reached regardless of the exact increment.
    const attempts = Math.ceil(REACTION_HEAT_MAX / REACTION_HEAT_INCREMENT) + 2;
    for (let i = 0; i < attempts; i += 1) {
      last = await recordStageReactionAttempt(eventId, { type: "guest", id: guestId });
    }
    expect(last?.inCooldownAfter).toBe(true);

    const rejected = await recordStageReactionAttempt(eventId, { type: "guest", id: guestId });
    expect(rejected.accepted).toBe(false);
    expect(rejected.inCooldownAfter).toBe(true);
  });

  it("hysteresis: cooldown does not lift merely by dropping below max — it requires draining to the exit threshold", async () => {
    const guestId = crypto.randomUUID();
    // Seed the row via a real attempt first (the RPC owns the insert — the
    // unique index is on an expression, coalesce(profile_id, guest_id), so
    // a raw upsert here can't target it), then force it straight to the
    // cap so the rest of this test can drive the decay math precisely.
    await recordStageReactionAttempt(eventId, { type: "guest", id: guestId });
    await service
      .from("stage_reaction_heat")
      .update({ heat: REACTION_HEAT_MAX, in_cooldown: true, updated_at: new Date().toISOString() })
      .eq("event_id", eventId)
      .eq("guest_id", guestId);

    // Backdate only enough to drop just under max but still above the exit
    // threshold — must still be rejected (no 99/100 thrashing).
    const justAboveExitSeconds = (REACTION_HEAT_MAX - (REACTION_HEAT_COOLDOWN_EXIT + 5)) / REACTION_HEAT_DRAIN_PER_SECOND;
    await backdate(eventId, guestId, justAboveExitSeconds);
    const stillCooling = await recordStageReactionAttempt(eventId, { type: "guest", id: guestId });
    expect(stillCooling.accepted).toBe(false);
    expect(stillCooling.inCooldownAfter).toBe(true);
    expect(stillCooling.heatAfter).toBeGreaterThan(REACTION_HEAT_COOLDOWN_EXIT);

    // Backdate past the exit threshold — cooldown now lifts and the
    // attempt is accepted again.
    await service
      .from("stage_reaction_heat")
      .update({ heat: REACTION_HEAT_MAX, in_cooldown: true, updated_at: new Date().toISOString() })
      .eq("event_id", eventId)
      .eq("guest_id", guestId);
    const pastExitSeconds = (REACTION_HEAT_MAX - (REACTION_HEAT_COOLDOWN_EXIT - 5)) / REACTION_HEAT_DRAIN_PER_SECOND;
    await backdate(eventId, guestId, pastExitSeconds);
    const resumed = await recordStageReactionAttempt(eventId, { type: "guest", id: guestId });
    expect(resumed.accepted).toBe(true);
    expect(resumed.inCooldownAfter).toBe(false);
  });

  it("moderate, spaced-out reacting never approaches cooldown", async () => {
    const guestId = crypto.randomUUID();
    for (let i = 0; i < 3; i += 1) {
      const result = await recordStageReactionAttempt(eventId, { type: "guest", id: guestId });
      expect(result.accepted).toBe(true);
      expect(result.inCooldownAfter).toBe(false);
      await backdate(eventId, guestId, 5);
    }
  });

  it("a profile identity and a guest identity are tracked independently", async () => {
    // stage_reaction_heat.profile_id has a real FK to profiles(id), which
    // itself FKs to auth.users(id) — same "create a real auth user" fixture
    // technique as event-speakers-transitions.test.ts's createTestProfile.
    const { data: user, error: userError } = await service.auth.admin.createUser({
      email: `test-reaction-heat-${crypto.randomUUID()}@example.invalid`,
      password: `Test-Passw0rd-${crypto.randomUUID()}`,
      email_confirm: true,
    });
    if (userError || !user.user) throw new Error(userError?.message ?? "failed to create test profile");

    try {
      const profileHeat = await recordStageReactionAttempt(eventId, { type: "profile", id: user.user.id });
      const guestHeat = await recordStageReactionAttempt(eventId, { type: "guest", id: crypto.randomUUID() });
      expect(profileHeat.heatAfter).toBeCloseTo(REACTION_HEAT_INCREMENT, 5);
      expect(guestHeat.heatAfter).toBeCloseTo(REACTION_HEAT_INCREMENT, 5);
    } finally {
      await service.auth.admin.deleteUser(user.user.id);
    }
  });

  it("the same identity's heat does not carry over between different events", async () => {
    const guestId = crypto.randomUUID();
    let last: Awaited<ReturnType<typeof recordStageReactionAttempt>> | null = null;
    const attempts = Math.ceil(REACTION_HEAT_MAX / REACTION_HEAT_INCREMENT) + 2;
    for (let i = 0; i < attempts; i += 1) {
      last = await recordStageReactionAttempt(eventId, { type: "guest", id: guestId });
    }
    expect(last?.inCooldownAfter).toBe(true);

    const inOtherEvent = await recordStageReactionAttempt(secondEventId, { type: "guest", id: guestId });
    expect(inOtherEvent.accepted).toBe(true);
    expect(inOtherEvent.inCooldownAfter).toBe(false);
  });

  it("rejects a call identifying neither or both a profile and a guest (identity must be exactly one)", async () => {
    const { error: neitherError } = await service.rpc("record_stage_reaction_attempt", {
      p_event_id: eventId,
      p_profile_id: null as unknown as string,
      p_guest_id: null as unknown as string,
    });
    expect(neitherError).not.toBeNull();

    // The XOR check runs before any FK lookup, so a syntactically-shaped
    // but nonexistent profile id is sufficient here — no real profile
    // fixture needed for this branch.
    const { error: bothError } = await service.rpc("record_stage_reaction_attempt", {
      p_event_id: eventId,
      p_profile_id: "00000000-0000-0000-0000-000000000002" as unknown as string,
      p_guest_id: crypto.randomUUID(),
    });
    expect(bothError).not.toBeNull();
  });
});
