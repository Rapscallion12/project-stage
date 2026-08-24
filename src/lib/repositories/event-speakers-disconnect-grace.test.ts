// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServiceClient } from "@/lib/supabase/service";
import {
  claimSpeakerSeat,
  markSpeakerDisconnected,
  markSpeakerReconnected,
  releaseExpiredDisconnectedSpeaker,
} from "./event-speakers";

const hasServiceCredentials = Boolean(
  process.env.NEXT_PUBLIC_SUPABASE_URL &&
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY &&
    process.env.SUPABASE_SERVICE_ROLE_KEY,
);

const GRACE_SECONDS = 11;

/**
 * Integration tests for issue #18 UX finding's server-authoritative
 * speaker disconnect grace period (migration 00000000000016), against
 * the real linked Supabase project — same discipline as
 * event-speakers-transitions.test.ts. Skips gracefully without
 * SUPABASE_SERVICE_ROLE_KEY configured.
 *
 * Guest identities (random UUIDs, no `profiles`/`auth.users` row needed)
 * are used throughout rather than real auth-user fixtures — the
 * functions under test are identity-shape-agnostic (profile vs. guest is
 * just which column is set), and issue #16 already established guests
 * as a fully supported speaker identity, so this keeps setup minimal
 * without losing coverage.
 */
describe.skipIf(!hasServiceCredentials)("speaker disconnect grace period (issue #18 UX finding)", () => {
  let service: ReturnType<typeof createServiceClient>;
  let eventId: string;

  /** Backdates a row's own disconnected_at directly — the service client bypasses RLS, so this is a legitimate way to set up "already been disconnected N seconds" fixture state without waiting real wall-clock time. */
  async function backdateDisconnectedAt(guestId: string, secondsAgo: number) {
    const disconnectedAt = new Date(Date.now() - secondsAgo * 1000).toISOString();
    await service
      .from("event_speakers")
      .update({ disconnected_at: disconnectedAt })
      .eq("event_id", eventId)
      .eq("guest_id", guestId)
      .is("left_at", null);
  }

  async function activeSeat(guestId: string) {
    const { data } = await service
      .from("event_speakers")
      .select("*")
      .eq("event_id", eventId)
      .eq("guest_id", guestId)
      .is("left_at", null)
      .maybeSingle();
    return data;
  }

  beforeAll(async () => {
    service = createServiceClient();
    const { data: event, error } = await service
      .from("events")
      .insert({
        title: "Issue #18 disconnect-grace test fixture event",
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

  it("markSpeakerDisconnected sets disconnected_at on the active seat, and is a safe no-op for an identity with no active seat", async () => {
    const guestId = crypto.randomUUID();
    const noSeat = await markSpeakerDisconnected(eventId, { type: "guest", id: guestId });
    expect(noSeat).toBeNull();

    await claimSpeakerSeat(eventId, { type: "guest", id: guestId }, 1, "Disconnect Test A");
    const row = await markSpeakerDisconnected(eventId, { type: "guest", id: guestId });
    expect(row?.disconnected_at).not.toBeNull();
    expect(row?.left_at).toBeNull();
  });

  it("markSpeakerDisconnected is idempotent — a duplicate delivery never restarts the clock", async () => {
    const guestId = crypto.randomUUID();
    await claimSpeakerSeat(eventId, { type: "guest", id: guestId }, 1, "Disconnect Test B");

    const first = await markSpeakerDisconnected(eventId, { type: "guest", id: guestId });
    const firstTimestamp = first?.disconnected_at;
    expect(firstTimestamp).not.toBeNull();

    await new Promise((resolve) => setTimeout(resolve, 50));
    const second = await markSpeakerDisconnected(eventId, { type: "guest", id: guestId });
    expect(second?.disconnected_at).toBe(firstTimestamp);
  });

  it("markSpeakerReconnected clears disconnected_at, and is a safe no-op for an identity with no active seat", async () => {
    const guestId = crypto.randomUUID();
    const noSeat = await markSpeakerReconnected(eventId, { type: "guest", id: guestId });
    expect(noSeat).toBeNull();

    await claimSpeakerSeat(eventId, { type: "guest", id: guestId }, 1, "Reconnect Test A");
    await markSpeakerDisconnected(eventId, { type: "guest", id: guestId });

    const row = await markSpeakerReconnected(eventId, { type: "guest", id: guestId });
    expect(row?.disconnected_at).toBeNull();
    expect(row?.left_at).toBeNull();
  });

  describe("releaseExpiredDisconnectedSpeaker — the atomic, server-authoritative expiration", () => {
    it("does not release a seat that was never marked disconnected", async () => {
      const guestId = crypto.randomUUID();
      await claimSpeakerSeat(eventId, { type: "guest", id: guestId }, 1, "Grace Test — never disconnected");

      const released = await releaseExpiredDisconnectedSpeaker(eventId, { type: "guest", id: guestId }, GRACE_SECONDS);
      expect(released).toBeNull();
      expect((await activeSeat(guestId))?.left_at).toBeNull();
    });

    it("reconnect at ~10 seconds retains the seat — not yet expired at that point", async () => {
      const guestId = crypto.randomUUID();
      await claimSpeakerSeat(eventId, { type: "guest", id: guestId }, 1, "Grace Test — retains at 10s");
      await markSpeakerDisconnected(eventId, { type: "guest", id: guestId });
      await backdateDisconnectedAt(guestId, 10); // disconnected 10s ago, 11s grace — not expired yet

      const released = await releaseExpiredDisconnectedSpeaker(eventId, { type: "guest", id: guestId }, GRACE_SECONDS);
      expect(released).toBeNull();
      expect((await activeSeat(guestId))?.left_at).toBeNull();
    });

    it("disconnect → no return → releases once the grace period has genuinely elapsed", async () => {
      const guestId = crypto.randomUUID();
      await claimSpeakerSeat(eventId, { type: "guest", id: guestId }, 1, "Grace Test — releases at 11s");
      await markSpeakerDisconnected(eventId, { type: "guest", id: guestId });
      await backdateDisconnectedAt(guestId, 12); // disconnected 12s ago, past the 11s grace

      const released = await releaseExpiredDisconnectedSpeaker(eventId, { type: "guest", id: guestId }, GRACE_SECONDS);
      expect(released?.left_at).not.toBeNull();
      expect(released?.left_reason).toBe("disconnected");
      expect(await activeSeat(guestId)).toBeNull();
    });

    it("disconnect → reconnect inside the grace period → release attempt no-ops even though the original disconnect time has since passed the threshold", async () => {
      const guestId = crypto.randomUUID();
      await claimSpeakerSeat(eventId, { type: "guest", id: guestId }, 1, "Grace Test — reconnected in time");
      await markSpeakerDisconnected(eventId, { type: "guest", id: guestId });
      await backdateDisconnectedAt(guestId, 12); // would be expired...
      await markSpeakerReconnected(eventId, { type: "guest", id: guestId }); // ...but they reconnected

      const released = await releaseExpiredDisconnectedSpeaker(eventId, { type: "guest", id: guestId }, GRACE_SECONDS);
      expect(released).toBeNull();
      expect((await activeSeat(guestId))?.left_at).toBeNull();
    });

    it("stale timeout after successful reconnection: a late release attempt arriving after mark_speaker_reconnected already cleared the clock is a pure no-op — the single atomic WHERE clause is the race guard, not a separate check-then-write", async () => {
      const guestId = crypto.randomUUID();
      await claimSpeakerSeat(eventId, { type: "guest", id: guestId }, 1, "Grace Test — stale timeout race");
      await markSpeakerDisconnected(eventId, { type: "guest", id: guestId });
      await backdateDisconnectedAt(guestId, 20); // well past expiry

      // Reconnect lands first (e.g. participant_joined beat a stale
      // client-scheduled release trigger).
      await markSpeakerReconnected(eventId, { type: "guest", id: guestId });

      // The stale trigger fires anyway — must not evict.
      const released = await releaseExpiredDisconnectedSpeaker(eventId, { type: "guest", id: guestId }, GRACE_SECONDS);
      expect(released).toBeNull();

      const seat = await activeSeat(guestId);
      expect(seat?.left_at).toBeNull();
      expect(seat?.disconnected_at).toBeNull();
    });

    it("reconnect after expiration: once genuinely released, a later reconnect signal for the same (now-inactive) row does not resurrect it", async () => {
      const guestId = crypto.randomUUID();
      await claimSpeakerSeat(eventId, { type: "guest", id: guestId }, 1, "Grace Test — reconnect after release");
      await markSpeakerDisconnected(eventId, { type: "guest", id: guestId });
      await backdateDisconnectedAt(guestId, 15);
      const released = await releaseExpiredDisconnectedSpeaker(eventId, { type: "guest", id: guestId }, GRACE_SECONDS);
      expect(released?.left_at).not.toBeNull();

      // A late participant_joined for the same identity — the row it
      // would touch already has left_at set, so this can't match it.
      const reconnectAttempt = await markSpeakerReconnected(eventId, { type: "guest", id: guestId });
      expect(reconnectAttempt).toBeNull();
      expect(await activeSeat(guestId)).toBeNull(); // still no active seat
    });

    it("a late reconnect must not reclaim the seat from whoever received it afterward", async () => {
      const originalGuestId = crypto.randomUUID();
      const newGuestId = crypto.randomUUID();
      await claimSpeakerSeat(eventId, { type: "guest", id: originalGuestId }, 2, "Grace Test — original occupant");
      await markSpeakerDisconnected(eventId, { type: "guest", id: originalGuestId });
      await backdateDisconnectedAt(originalGuestId, 15);
      const released = await releaseExpiredDisconnectedSpeaker(
        eventId,
        { type: "guest", id: originalGuestId },
        GRACE_SECONDS,
      );
      expect(released?.left_at).not.toBeNull();

      // Someone else claims the now-open seat.
      await claimSpeakerSeat(eventId, { type: "guest", id: newGuestId }, 2, "Grace Test — new occupant");

      // The original occupant's browser finally reconnects.
      const staleReconnect = await markSpeakerReconnected(eventId, { type: "guest", id: originalGuestId });
      expect(staleReconnect).toBeNull(); // no active row for the original identity to touch

      // The new occupant is completely unaffected.
      const newOccupant = await activeSeat(newGuestId);
      expect(newOccupant?.left_at).toBeNull();
      expect(newOccupant?.seat_number).toBe(2);
    });

    it("releasing is idempotent — a second release attempt on an already-released seat is a no-op, not an error", async () => {
      const guestId = crypto.randomUUID();
      await claimSpeakerSeat(eventId, { type: "guest", id: guestId }, 1, "Grace Test — double release");
      await markSpeakerDisconnected(eventId, { type: "guest", id: guestId });
      await backdateDisconnectedAt(guestId, 15);

      const first = await releaseExpiredDisconnectedSpeaker(eventId, { type: "guest", id: guestId }, GRACE_SECONDS);
      expect(first?.left_at).not.toBeNull();

      const second = await releaseExpiredDisconnectedSpeaker(eventId, { type: "guest", id: guestId }, GRACE_SECONDS);
      expect(second).toBeNull();
    });
  });
});
