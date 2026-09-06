// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServiceClient } from "@/lib/supabase/service";
import {
  requestToSpeakAsGuest,
  withdrawSpeakerRequestAsGuest,
  freezeSpeakerCandidates,
} from "./speaker-requests";

const hasServiceCredentials = Boolean(
  process.env.NEXT_PUBLIC_SUPABASE_URL &&
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY &&
    process.env.SUPABASE_SERVICE_ROLE_KEY,
);

/**
 * Issue #21, eighth corrective pass: while investigating a real-device
 * report ("Selecting next speaker…" persisting indefinitely despite a
 * visibly eligible, currently-requesting candidate), live inspection of
 * the real linked database found a round stuck in `status = 'active'`
 * with no live reservation left in it and a `withdrawn`/`selection_failed`
 * straggler that had never been reserved for any seat. Auditing
 * `withdraw_speaker_request(_as_guest)` found why: the "mark this round
 * exhausted once nothing further can come of it" check lived entirely
 * *inside* the `if v_row.is_current_candidate` branch — it only ever ran
 * when the *withdrawing* request was itself the round's currently-
 * reserved candidate. A frozen-but-never-reserved straggler (an
 * ordinary case: a round freezes more candidates than there are open
 * seats to reserve them for) withdrawing skipped that whole check,
 * leaving the round able to stay `active` with no live reservation and
 * no remaining viable candidate. Because `freeze_speaker_candidates` is
 * deliberately idempotent ("an active round already exists — reuse
 * it"), a round stuck this way makes every later-arriving Request-to-
 * Speak permanently invisible to selection. Fixed in migration
 * 00000000000038. This file proves the fix directly against the real
 * database — not a mock, not a unit test of application code, since the
 * bug lived entirely inside the SQL function itself.
 */
describe.skipIf(!hasServiceCredentials)("a frozen-but-unreserved candidate withdrawing must not permanently strand its own round (issue #21, eighth corrective pass, migration 38)", () => {
  let service: ReturnType<typeof createServiceClient>;
  let eventId: string;

  async function roundStatus(roundId: string): Promise<string | null> {
    const { data } = await service.from("speaker_selection_rounds").select("status").eq("id", roundId).maybeSingle();
    return data?.status ?? null;
  }

  beforeAll(async () => {
    service = createServiceClient();
    const { data: event, error } = await service
      .from("events")
      .insert({
        title: "Issue #21 eighth corrective pass — stale exhausted-round fixture event",
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

  it(
    "the round is marked exhausted once a frozen-but-never-reserved candidate withdraws and no live reservation remains in it — even though the withdrawer itself was never `is_current_candidate`",
    async () => {
      // Reproduces the exact precondition the bug required, directly —
      // going through the ordinary claim/reset pipeline to *naturally*
      // reach "a round with zero live reservations left, containing one
      // never-reserved straggler" is possible but timing-dependent
      // (Section 5/6 already prove the ordinary single/dual-seat paths
      // work correctly elsewhere in this file's own sibling tests); this
      // isolates the exhaustion function's own new branch precisely,
      // the same way a unit test isolates one function from the system
      // around it.
      const strandedGuest = crypto.randomUUID();
      await requestToSpeakAsGuest(eventId, strandedGuest, "Ranked Only", "pick me eventually");

      const { data: round, error: roundErr } = await service
        .from("speaker_selection_rounds")
        .insert({ event_id: eventId })
        .select("id")
        .single();
      if (roundErr || !round) throw new Error(roundErr?.message ?? "failed to create fixture round");
      const roundId = round.id as string;

      // Frozen into the round, ranked, but never reserved for any seat —
      // exactly what a straggler ranked below however many seats were
      // actually open at reservation time looks like. No other request
      // is tied to this round at all, matching "the last live
      // reservation already resolved via some other path."
      await service
        .from("speaker_requests")
        .update({ selection_round_id: roundId, frozen_rank: 1, frozen_vote_count: 0 })
        .eq("event_id", eventId)
        .eq("guest_id", strandedGuest);

      expect(await roundStatus(roundId)).toBe("active");

      // The never-reserved straggler withdraws.
      await withdrawSpeakerRequestAsGuest(eventId, strandedGuest);

      // The fix: exhausted, not stuck 'active' forever — the pre-fix
      // code skipped this check entirely whenever the withdrawer itself
      // wasn't the round's own `is_current_candidate`.
      expect(await roundStatus(roundId)).toBe("exhausted");

      // The real-world consequence this bug caused: freeze_speaker_candidates
      // is deliberately idempotent ("an active round already exists —
      // reuse it") — a request arriving while the round was stuck
      // 'active' would have been silently invisible to selection
      // forever. It's now correctly frozen into a genuinely fresh round.
      const laterGuest = crypto.randomUUID();
      await requestToSpeakAsGuest(eventId, laterGuest, "Arrived Later", "still want to speak");
      const laterCandidates = await freezeSpeakerCandidates(eventId);
      const laterRow = laterCandidates.find((c) => c.guest_id === laterGuest);
      expect(laterRow).toBeDefined();
      expect(laterRow!.round_id).not.toBe(roundId);
    },
    30_000,
  );
});
