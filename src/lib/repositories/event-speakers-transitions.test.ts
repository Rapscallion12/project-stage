// @vitest-environment node
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@/types/database";
import { createServiceClient } from "@/lib/supabase/service";
import { claimSpeakerSeat, endSpeakerSeat } from "./event-speakers";

const hasServiceCredentials = Boolean(
  process.env.NEXT_PUBLIC_SUPABASE_URL &&
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY &&
    process.env.SUPABASE_SERVICE_ROLE_KEY,
);

/**
 * Integration tests for issue #13's write path, against the real linked
 * Supabase project — same discipline as event-speakers.test.ts's RLS
 * tests, extended to cover the service-client-only functions. Skips
 * gracefully if SUPABASE_SERVICE_ROLE_KEY isn't configured (a fresh clone
 * before it's added to .env.local), rather than failing.
 *
 * Real fixture rows are required, not fake UUIDs: claim_speaker_seat and
 * end_speaker_seat write through actual foreign keys (event_id ->
 * events.id, profile_id -> profiles.id -> auth.users.id), so what's
 * exercised here is real atomicity/race behavior, not just "the function
 * runs." Test profiles are real auth users created via the Auth admin API
 * (the only way to get a row satisfying profiles' FK to auth.users),
 * cleaned up in afterAll. Tests run in sequence and deliberately build on
 * each other's state (a live speaker lineup, not independent fixtures) —
 * see each test's comment for what it assumes going in.
 */
describe.skipIf(!hasServiceCredentials)("event_speakers write path (issue #13)", () => {
  // Lazily constructed in beforeAll, not here — this describe callback
  // still runs (just its `it`s get skipped) even when skipIf is true, so
  // calling createServiceClient() at this level would throw on a fresh
  // clone with no SUPABASE_SERVICE_ROLE_KEY, defeating the graceful skip.
  let service: ReturnType<typeof createServiceClient>;
  const anonUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

  let eventId: string;
  const testUserIds: string[] = [];
  const profiles: Record<"a" | "b" | "c" | "d", { id: string; email: string; password: string }> = {} as never;

  async function createTestProfile(label: "a" | "b" | "c" | "d") {
    const email = `test-speaker-${label}-${crypto.randomUUID()}@example.invalid`;
    const password = `Test-Passw0rd-${crypto.randomUUID()}`;
    const { data, error } = await service.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { display_name: `Test Speaker ${label.toUpperCase()}` },
    });
    if (error || !data.user) throw new Error(error?.message ?? `failed to create test profile ${label}`);
    testUserIds.push(data.user.id);
    profiles[label] = { id: data.user.id, email, password };
  }

  /**
   * A direct read via the service client, not `listActiveSpeakers()` —
   * that repository function goes through lib/supabase/server.ts, which
   * calls next/headers' cookies(), only valid inside a real Next.js
   * request lifecycle (same limitation event-speakers.test.ts's own
   * comment already documents). What's under test here is the write
   * functions' effect on the table, which a direct read verifies just as
   * well.
   */
  async function activeSeats(eventIdToCheck: string) {
    const { data } = await service
      .from("event_speakers")
      .select("*")
      .eq("event_id", eventIdToCheck)
      .is("left_at", null)
      .order("seat_number", { ascending: true });
    return data ?? [];
  }

  /** A client authenticated as an ordinary account holder — never service_role. */
  async function signInAs(label: "a" | "b" | "c" | "d") {
    const { email, password } = profiles[label];
    const anon = createSupabaseClient(anonUrl, anonKey);
    const { data, error } = await anon.auth.signInWithPassword({ email, password });
    if (error || !data.session) throw new Error(error?.message ?? `failed to sign in as ${label}`);
    return createSupabaseClient<Database>(anonUrl, anonKey, {
      global: { headers: { Authorization: `Bearer ${data.session.access_token}` } },
    });
  }

  beforeAll(async () => {
    service = createServiceClient();
    const { data: event, error } = await service
      .from("events")
      .insert({
        title: "Issue #13 test fixture event",
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

  it("seats a profile into an empty seat, snapshotting display_name from profiles (issue #3)", async () => {
    const row = await claimSpeakerSeat(eventId, profiles.a.id, 1);
    expect(row.profile_id).toBe(profiles.a.id);
    expect(row.seat_number).toBe(1);
    expect(row.left_at).toBeNull();
    // claim_speaker_seat reads this from profiles.display_name itself —
    // never accepted as a caller-supplied parameter — so guests (who
    // can't read profiles under RLS) can still see who's speaking. See
    // migration 00000000000010 and DECISIONS.md.
    expect(row.display_name).toBe("Test Speaker A");
  });

  it("rejects claiming a seat for a profile that doesn't exist, with a clear error rather than a bare FK violation", async () => {
    await expect(claimSpeakerSeat(eventId, "00000000-0000-0000-0000-000000000000", 2)).rejects.toThrow(/does not exist/);
  });

  it("replacing the occupant ends their row as 'replaced' (preserved, not deleted) and leaves exactly one active row for the seat", async () => {
    const newRow = await claimSpeakerSeat(eventId, profiles.b.id, 1);
    expect(newRow.profile_id).toBe(profiles.b.id);
    expect(newRow.left_at).toBeNull();
    expect(newRow.display_name).toBe("Test Speaker B");

    const { data: previous } = await service
      .from("event_speakers")
      .select("*")
      .eq("event_id", eventId)
      .eq("profile_id", profiles.a.id)
      .single();
    expect(previous?.left_at).not.toBeNull();
    expect(previous?.left_reason).toBe("replaced");

    const active = await activeSeats(eventId);
    expect(active.filter((s) => s.seat_number === 1)).toHaveLength(1);
    expect(active.find((s) => s.seat_number === 1)?.profile_id).toBe(profiles.b.id);
  });

  it("rejects claiming a second seat for a profile that already holds one", async () => {
    await expect(claimSpeakerSeat(eventId, profiles.b.id, 2)).rejects.toThrow();

    const active = await activeSeats(eventId);
    expect(active.find((s) => s.seat_number === 2)).toBeUndefined();
  });

  it("race safety: two concurrent claims for the same open seat — the seat is never double-booked", async () => {
    // Two outcomes are both correct here, and which one happens is a
    // timing artifact, not something this test can control: if the two
    // calls' transactions genuinely overlap at the DB layer, the loser's
    // INSERT hits the partial unique index and its promise rejects. If
    // they land closely enough together that the first fully commits
    // before the second's UPDATE step runs, claim_speaker_seat's own
    // "replace whoever's there" semantics mean the second call
    // legitimately ends the first's brand-new row and both promises
    // fulfill. Either way, the property that actually matters — and the
    // only one this test asserts on — is that seat 2 never ends up with
    // more than one *active* row, and every row that was ended along the
    // way is preserved as history, not lost.
    const results = await Promise.allSettled([
      claimSpeakerSeat(eventId, profiles.c.id, 2),
      claimSpeakerSeat(eventId, profiles.d.id, 2),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);

    const active = await activeSeats(eventId);
    const seat2 = active.filter((s) => s.seat_number === 2);
    expect(seat2).toHaveLength(1); // never double-booked, regardless of interleaving
    expect([profiles.c.id, profiles.d.id]).toContain(seat2[0].profile_id);

    const { data: allSeat2Rows } = await service
      .from("event_speakers")
      .select("profile_id, left_at, left_reason")
      .eq("event_id", eventId)
      .eq("seat_number", 2);
    for (const row of allSeat2Rows ?? []) {
      if (row.profile_id !== seat2[0].profile_id) {
        // Whoever didn't end up active either never got inserted (their
        // call was rejected) or was cleanly replaced — never left
        // dangling as an active row.
        expect(row.left_at).not.toBeNull();
        expect(row.left_reason).toBe("replaced");
      }
    }
  });

  it("end_speaker_seat ends an active occupant with the given reason, and is a safe no-op if they're not seated", async () => {
    const active = await activeSeats(eventId);
    const seat2Occupant = active.find((s) => s.seat_number === 2)!.profile_id;

    const ended = await endSpeakerSeat(eventId, seat2Occupant, "disconnected");
    expect(ended?.left_reason).toBe("disconnected");
    expect(ended?.left_at).not.toBeNull();

    // Firing again (e.g. a duplicate/retried webhook, or a profile who was
    // never seated) must not throw — it's a no-op, not an error.
    const noop = await endSpeakerSeat(eventId, seat2Occupant, "disconnected");
    expect(noop).toBeNull();
  });

  it("claim_speaker_seat and end_speaker_seat are not callable by an ordinary authenticated user — only leave_speaker_seat is", async () => {
    const asA = await signInAs("a");

    const claimAttempt = await asA.rpc("claim_speaker_seat", {
      p_event_id: eventId,
      p_profile_id: profiles.a.id,
      p_seat_number: 1,
    });
    expect(claimAttempt.error).not.toBeNull();
    expect(claimAttempt.error?.code).toBe("42501");

    const endAttempt = await asA.rpc("end_speaker_seat", {
      p_event_id: eventId,
      p_profile_id: profiles.b.id,
      p_reason: "moderator_removed",
    });
    expect(endAttempt.error).not.toBeNull();
    expect(endAttempt.error?.code).toBe("42501");
  });

  it("leave_speaker_seat lets a speaker end their own seat, self-service", async () => {
    const asB = await signInAs("b"); // b is still active in seat 1 from an earlier test
    const { data, error } = await asB.rpc("leave_speaker_seat", { p_event_id: eventId });
    expect(error).toBeNull();
    expect(data?.profile_id).toBe(profiles.b.id);
    expect(data?.left_reason).toBe("voluntary");

    const active = await activeSeats(eventId);
    expect(active.find((s) => s.profile_id === profiles.b.id)).toBeUndefined();
  });

  it("leave_speaker_seat rejects when the caller has no active seat", async () => {
    const asB = await signInAs("b"); // b already left in the previous test
    const { error } = await asB.rpc("leave_speaker_seat", { p_event_id: eventId });
    expect(error).not.toBeNull();
  });
});
