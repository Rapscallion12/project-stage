// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServiceClient } from "@/lib/supabase/service";
import { requestToSpeakAsGuest, withdrawSpeakerRequestAsGuest } from "./speaker-requests";
import {
  claimSpeakerSeat,
  markSpeakerDisconnected,
  markSpeakerMediaInactive,
  markSpeakerReconnected,
} from "./event-speakers";

const hasServiceCredentials = Boolean(
  process.env.NEXT_PUBLIC_SUPABASE_URL &&
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY &&
    process.env.SUPABASE_SERVICE_ROLE_KEY,
);

/**
 * Issue #18 expiration-enforcement finding: a stored deadline
 * (disconnected_at/media_inactive_since) was not enough — nothing
 * guaranteed the row's own left_at got set at the exact moment the
 * deadline passed, so every ownership-relevant read that only checked
 * left_at is null could still treat a logically-expired identity as the
 * legitimate occupant. Migration 00000000000018 introduces
 * is_speaker_seat_active/event_speakers_active (the read side) and
 * release_if_expired (the write side, folded into claim_speaker_seat
 * and request_to_speak_internal). This file tests that surface directly
 * against the real linked project — same discipline as
 * event-speakers-disconnect-grace.test.ts.
 *
 * A direct service-client read of event_speakers_active stands in for
 * getActiveSeatForIdentity/listActiveSpeakers themselves, for the same
 * next/headers reason event-speakers-transitions.test.ts's own comment
 * documents — but it's the *same view*, so this is a real proof of the
 * actual read path, not an approximation of it.
 */
describe.skipIf(!hasServiceCredentials)("speaker seat expiration enforcement (issue #18)", () => {
  let service: ReturnType<typeof createServiceClient>;
  let eventId: string;

  async function activeViewRow(guestId: string) {
    const { data } = await service
      .from("event_speakers_active")
      .select("*")
      .eq("event_id", eventId)
      .eq("guest_id", guestId)
      .maybeSingle();
    return data;
  }

  async function rawRow(guestId: string) {
    const { data } = await service
      .from("event_speakers")
      .select("*")
      .eq("event_id", eventId)
      .eq("guest_id", guestId)
      .is("left_at", null)
      .maybeSingle();
    return data;
  }

  async function backdateDisconnectedAt(guestId: string, secondsAgo: number) {
    await service
      .from("event_speakers")
      .update({ disconnected_at: new Date(Date.now() - secondsAgo * 1000).toISOString() })
      .eq("event_id", eventId)
      .eq("guest_id", guestId)
      .is("left_at", null);
  }

  beforeAll(async () => {
    service = createServiceClient();
    const { data: event, error } = await service
      .from("events")
      .insert({
        title: "Issue #18 expiration-enforcement test fixture event",
        scheduled_start: new Date(Date.now() + 60_000).toISOString(),
        lobby_opens_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    if (error || !event) throw new Error(error?.message ?? "failed to create test event");
    eventId = event.id;
  }, 30_000);

  afterAll(async () => {
    if (eventId) await service.from("events").delete().eq("id", eventId);
  }, 30_000);

  describe("event_speakers_active — the read-side expiration-aware view", () => {
    it("deadline not reached: the row is still visible in the active view (reconnect would succeed)", async () => {
      const guestId = crypto.randomUUID();
      await claimSpeakerSeat(eventId, { type: "guest", id: guestId }, 1, "Expiration Test A");
      await markSpeakerDisconnected(eventId, { type: "guest", id: guestId });
      await backdateDisconnectedAt(guestId, 8); // 8s of 11s elapsed — not yet expired

      expect(await activeViewRow(guestId)).not.toBeNull();
    });

    it("database time beyond deadline: the row disappears from the active view even though the physical row (left_at is null) still exists", async () => {
      const guestId = crypto.randomUUID();
      await claimSpeakerSeat(eventId, { type: "guest", id: guestId }, 1, "Expiration Test B");
      await markSpeakerDisconnected(eventId, { type: "guest", id: guestId });
      await backdateDisconnectedAt(guestId, 15); // past the 11s grace, but nothing has released it yet

      expect(await rawRow(guestId)).not.toBeNull(); // still physically "active" by left_at alone
      expect(await activeViewRow(guestId)).toBeNull(); // but logically expired — a reconnect attempt reading this view is correctly rejected
    });

    it("the same expiration awareness applies to the media-inactive cause, not just disconnected_at", async () => {
      const guestId = crypto.randomUUID();
      await claimSpeakerSeat(eventId, { type: "guest", id: guestId }, 1, "Expiration Test C");
      await markSpeakerMediaInactive(eventId, { type: "guest", id: guestId });
      await service
        .from("event_speakers")
        .update({ media_inactive_since: new Date(Date.now() - 15_000).toISOString() })
        .eq("event_id", eventId)
        .eq("guest_id", guestId)
        .is("left_at", null);

      expect(await rawRow(guestId)).not.toBeNull();
      expect(await activeViewRow(guestId)).toBeNull();
    });

    it("a genuine reconnect (disconnected_at cleared) immediately restores visibility in the active view", async () => {
      const guestId = crypto.randomUUID();
      await claimSpeakerSeat(eventId, { type: "guest", id: guestId }, 1, "Expiration Test D");
      await markSpeakerDisconnected(eventId, { type: "guest", id: guestId });
      await backdateDisconnectedAt(guestId, 15); // past grace
      expect(await activeViewRow(guestId)).toBeNull();

      await markSpeakerReconnected(eventId, { type: "guest", id: guestId });
      expect(await activeViewRow(guestId)).not.toBeNull();
    });
  });

  describe("claim_speaker_seat — the write-side guard (release_if_expired)", () => {
    it("expired seat is treated as available to another claimant — claiming the same seat number succeeds and evicts the stale row", async () => {
      const staleGuestId = crypto.randomUUID();
      const newGuestId = crypto.randomUUID();
      await claimSpeakerSeat(eventId, { type: "guest", id: staleGuestId }, 2, "Expiration Test — stale occupant");
      await markSpeakerDisconnected(eventId, { type: "guest", id: staleGuestId });
      await backdateDisconnectedAt(staleGuestId, 15); // expired, but never actually released

      const claimed = await claimSpeakerSeat(eventId, { type: "guest", id: newGuestId }, 2, "Expiration Test — new occupant");
      expect(claimed.seat_number).toBe(2);
      expect(claimed.guest_id).toBe(newGuestId);

      // The stale occupant's row is now genuinely ended, not just logically expired.
      const staleRowAfter = await rawRow(staleGuestId);
      expect(staleRowAfter).toBeNull();
    });

    it("old identity cannot reclaim after another identity gets the seat — a stale reconnect for the original occupant finds nothing to touch", async () => {
      const staleGuestId = crypto.randomUUID();
      const newGuestId = crypto.randomUUID();
      await claimSpeakerSeat(eventId, { type: "guest", id: staleGuestId }, 1, "Expiration Test — original");
      await markSpeakerDisconnected(eventId, { type: "guest", id: staleGuestId });
      await backdateDisconnectedAt(staleGuestId, 15);
      await claimSpeakerSeat(eventId, { type: "guest", id: newGuestId }, 1, "Expiration Test — replacement");

      // The original identity's own "reconnect" (participant_joined-style signal) now has nothing to touch.
      const staleReconnect = await markSpeakerReconnected(eventId, { type: "guest", id: staleGuestId });
      expect(staleReconnect).toBeNull();

      const newOccupant = await activeViewRow(newGuestId);
      expect(newOccupant?.left_at).toBeNull();
      expect(newOccupant?.seat_number).toBe(1);
    });

    it("release_if_expired's guard is idempotent: claiming a different seat twice in a row for the same already-expired identity never errors on the second attempt", async () => {
      const staleGuestId = crypto.randomUUID();
      await claimSpeakerSeat(eventId, { type: "guest", id: staleGuestId }, 1, "Expiration Test — idempotent A");
      await markSpeakerDisconnected(eventId, { type: "guest", id: staleGuestId });
      await backdateDisconnectedAt(staleGuestId, 15);

      // First re-claim releases the stale row and succeeds.
      const first = await claimSpeakerSeat(eventId, { type: "guest", id: staleGuestId }, 1, "Expiration Test — idempotent B");
      expect(first.seat_number).toBe(1);

      // The identity is now genuinely active again (a fresh row) — claiming
      // a second time without any further disconnect must fail the
      // ordinary "already holds an active seat" guard, same as always.
      await expect(
        claimSpeakerSeat(eventId, { type: "guest", id: staleGuestId }, 2, "Expiration Test — idempotent C"),
      ).rejects.toThrow(/already holds an active seat/);
    });

    it("a genuinely active (not expired) existing seat still correctly blocks a duplicate claim — the guard only bypasses a logically-expired row, never a real one", async () => {
      const guestId = crypto.randomUUID();
      await claimSpeakerSeat(eventId, { type: "guest", id: guestId }, 1, "Expiration Test — genuinely active");
      // No disconnect, no media-inactivity — this row is fully active.
      await expect(
        claimSpeakerSeat(eventId, { type: "guest", id: guestId }, 2, "Expiration Test — should be blocked"),
      ).rejects.toThrow(/already holds an active seat/);
    });
  });

  describe("request_to_speak_internal — the same guard for the mic-request path", () => {
    it("a genuinely-expired identity can request the mic again instead of being told it's already an active speaker", async () => {
      const guestId = crypto.randomUUID();
      await claimSpeakerSeat(eventId, { type: "guest", id: guestId }, 1, "Expiration Test — request path");
      await markSpeakerDisconnected(eventId, { type: "guest", id: guestId });
      await backdateDisconnectedAt(guestId, 15);

      const result = await requestToSpeakAsGuest(eventId, guestId, "Expiration Test — request path", "let me back in");
      expect(result.requestId).toBeTruthy();

      // Clean up the request so it doesn't leak into other tests' ranking queries.
      await withdrawSpeakerRequestAsGuest(eventId, guestId);
    });

    it("a genuinely active existing speaker is still correctly blocked from also requesting the mic", async () => {
      const guestId = crypto.randomUUID();
      await claimSpeakerSeat(eventId, { type: "guest", id: guestId }, 1, "Expiration Test — active blocks request");
      await expect(
        requestToSpeakAsGuest(eventId, guestId, "Expiration Test — active blocks request", "let me speak too"),
      ).rejects.toThrow(/already an active speaker/);
    });
  });
});
