import { render, screen } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SpeakerTile } from "./speaker-tile";
import { SpeakerMediaActivationPrompt } from "./speaker-media-activation-prompt";
import { createServiceClient } from "@/lib/supabase/service";
import {
  claimSpeakerSeat,
  markSpeakerDisconnected,
  markSpeakerMediaActive,
  markSpeakerMediaInactive,
  markSpeakerReconnected,
  releaseExpiredInactiveSpeaker,
  type EventSpeaker,
} from "@/lib/repositories/event-speakers";
import { inactiveSince } from "@/lib/speaker-presence";

const hasServiceCredentials = Boolean(
  process.env.NEXT_PUBLIC_SUPABASE_URL &&
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY &&
    process.env.SUPABASE_SERVICE_ROLE_KEY,
);

const GRACE_SECONDS = 11;

/**
 * Issue #18 real-device report: "Tap to reconnect" (the returning
 * speaker's own prompt, `SpeakerMediaActivationPrompt`) showed no
 * countdown at all, and the audience had no visibility into the same
 * deadline on the inactive speaker's tile (`SpeakerTile`). Both surfaces
 * were already unit-tested against synthetic timestamps and the DB/RPC
 * layer was already tested against the real linked project — but
 * nothing closed the gap the user explicitly flagged: "do not assume
 * the hook being correct means the UI has the timestamp."
 *
 * This file closes that gap for *both* causes of inactivity (issue #18
 * unified inactive-speaker finding): it fetches a real row's
 * `disconnected_at`/`media_inactive_since` from the real linked
 * Supabase project (a service-client read shaped identically to
 * `listActiveSpeakers` — see `event-speakers-transitions.test.ts`'s own
 * comment for why a direct read stands in for the repository function's
 * own `next/headers`-bound one in a test context) and feeds that *exact*
 * fetched value into both real components' props via `inactiveSince`,
 * asserting they render matching text. If the DB row's shape, the value
 * the client would actually receive, or either component's read of it
 * ever diverges, this fails — unlike a synthetic fixture, which can't
 * catch a real DB/type mismatch.
 */
describe.skipIf(!hasServiceCredentials)("inactive-speaker countdown — full data/render path (issue #18)", () => {
  let service: ReturnType<typeof createServiceClient>;
  let eventId: string;

  /** Same query shape as `listActiveSpeakers` (select("*"), left_at is null) — see this file's doc comment for why a direct service-client read stands in for the repository function itself here. */
  async function fetchRow(guestId: string): Promise<EventSpeaker | null> {
    const { data } = await service
      .from("event_speakers")
      .select("*")
      .eq("event_id", eventId)
      .eq("guest_id", guestId)
      .is("left_at", null)
      .maybeSingle();
    return data as EventSpeaker | null;
  }

  async function backdateDisconnectedAt(guestId: string, secondsAgo: number) {
    const disconnectedAt = new Date(Date.now() - secondsAgo * 1000).toISOString();
    await service
      .from("event_speakers")
      .update({ disconnected_at: disconnectedAt })
      .eq("event_id", eventId)
      .eq("guest_id", guestId)
      .is("left_at", null);
  }

  async function backdateMediaInactiveSince(guestId: string, secondsAgo: number) {
    const mediaInactiveSince = new Date(Date.now() - secondsAgo * 1000).toISOString();
    await service
      .from("event_speakers")
      .update({ media_inactive_since: mediaInactiveSince })
      .eq("event_id", eventId)
      .eq("guest_id", guestId)
      .is("left_at", null);
  }

  beforeAll(async () => {
    service = createServiceClient();
    const { data: event, error } = await service
      .from("events")
      .insert({
        title: "Issue #18 countdown full-path test fixture event",
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

  describe("cause A: a genuine LiveKit disconnect", () => {
    it("a disconnected row's disconnected_at, fetched fresh from the DB, drives matching 'Tap to reconnect · Ns' and 'Speaker inactive · Ns' text — the same fetched value, two components", async () => {
      const guestId = crypto.randomUUID();
      await claimSpeakerSeat(eventId, { type: "guest", id: guestId }, 1, "Full Path Test A");
      await markSpeakerDisconnected(eventId, { type: "guest", id: guestId });
      await backdateDisconnectedAt(guestId, 3);

      const row = await fetchRow(guestId);
      expect(row).not.toBeNull();
      expect(row!.disconnected_at).not.toBeNull();

      const expectedSeconds = GRACE_SECONDS - 3;

      render(
        <SpeakerMediaActivationPrompt
          needsMediaActivation={true}
          bothMediaMuted={false}
          activateMedia={async () => {}}
          mediaError={null}
          inactiveSince={inactiveSince(row)}
        />,
      );
      expect(screen.getByTestId("speaker-reconnect-countdown")).toHaveTextContent(`· ${expectedSeconds}s`);

      render(<SpeakerTile speaker={row} participant={undefined} isLocal={false} isInactive={true} />);
      expect(screen.getByTestId("audience-inactive-countdown")).toHaveTextContent(
        `Speaker inactive · ${expectedSeconds}s`,
      );
    });

    it("reopening ~5 seconds into the grace period shows ~5 seconds on both surfaces, not a fresh restart at 11", async () => {
      const guestId = crypto.randomUUID();
      await claimSpeakerSeat(eventId, { type: "guest", id: guestId }, 1, "Full Path Test B");
      await markSpeakerDisconnected(eventId, { type: "guest", id: guestId });
      await backdateDisconnectedAt(guestId, 5); // simulates the tab having been closed/backgrounded for 5s

      const row = await fetchRow(guestId);
      const expectedSeconds = GRACE_SECONDS - 5;

      render(
        <SpeakerMediaActivationPrompt
          needsMediaActivation={true}
          bothMediaMuted={false}
          activateMedia={async () => {}}
          mediaError={null}
          inactiveSince={inactiveSince(row)}
        />,
      );
      expect(screen.getByTestId("speaker-reconnect-countdown")).toHaveTextContent(`· ${expectedSeconds}s`);
      expect(screen.queryByText(`· ${GRACE_SECONDS}s`)).not.toBeInTheDocument();

      render(<SpeakerTile speaker={row} participant={undefined} isLocal={false} isInactive={true} />);
      expect(screen.getByTestId("audience-inactive-countdown")).toHaveTextContent(
        `Speaker inactive · ${expectedSeconds}s`,
      );
    });

    it("reconnecting clears both countdown states immediately — the re-fetched row's null disconnected_at removes the suffix on both surfaces", async () => {
      const guestId = crypto.randomUUID();
      await claimSpeakerSeat(eventId, { type: "guest", id: guestId }, 1, "Full Path Test C");
      await markSpeakerDisconnected(eventId, { type: "guest", id: guestId });
      await backdateDisconnectedAt(guestId, 4);

      const disconnectedRow = await fetchRow(guestId);
      expect(disconnectedRow!.disconnected_at).not.toBeNull();

      await markSpeakerReconnected(eventId, { type: "guest", id: guestId });
      const reconnectedRow = await fetchRow(guestId);
      expect(reconnectedRow).not.toBeNull();
      expect(reconnectedRow!.disconnected_at).toBeNull();

      render(
        <SpeakerMediaActivationPrompt
          needsMediaActivation={true}
          bothMediaMuted={false}
          activateMedia={async () => {}}
          mediaError={null}
          inactiveSince={inactiveSince(reconnectedRow)}
        />,
      );
      expect(screen.queryByTestId("speaker-reconnect-countdown")).not.toBeInTheDocument();

      render(<SpeakerTile speaker={reconnectedRow} participant={undefined} isLocal={false} isInactive={false} />);
      expect(screen.queryByTestId("audience-inactive-countdown")).not.toBeInTheDocument();
    });

    it("expiration releases the seat entirely — the row disappears from a fresh fetch, so both countdown states vanish because there's no seat left to render them for", async () => {
      const guestId = crypto.randomUUID();
      await claimSpeakerSeat(eventId, { type: "guest", id: guestId }, 1, "Full Path Test D");
      await markSpeakerDisconnected(eventId, { type: "guest", id: guestId });
      await backdateDisconnectedAt(guestId, 12); // past the 11s grace

      const released = await releaseExpiredInactiveSpeaker(eventId, { type: "guest", id: guestId }, GRACE_SECONDS);
      expect(released?.left_at).not.toBeNull();
      expect(released?.left_reason).toBe("disconnected");

      const rowAfterExpiry = await fetchRow(guestId);
      expect(rowAfterExpiry).toBeNull();

      render(<SpeakerTile speaker={rowAfterExpiry} participant={undefined} isLocal={false} isInactive={false} />);
      expect(screen.queryByTestId("audience-inactive-countdown")).not.toBeInTheDocument();
      expect(screen.getByTestId("empty-seat")).toBeInTheDocument();

      const staleReconnect = await markSpeakerReconnected(eventId, { type: "guest", id: guestId });
      expect(staleReconnect).toBeNull();
      expect(await fetchRow(guestId)).toBeNull();
    });

    it("a late reconnect must not reclaim the seat from whoever received it afterward", async () => {
      const originalGuestId = crypto.randomUUID();
      const newGuestId = crypto.randomUUID();
      await claimSpeakerSeat(eventId, { type: "guest", id: originalGuestId }, 2, "Full Path Test — original occupant");
      await markSpeakerDisconnected(eventId, { type: "guest", id: originalGuestId });
      await backdateDisconnectedAt(originalGuestId, 15);
      const released = await releaseExpiredInactiveSpeaker(
        eventId,
        { type: "guest", id: originalGuestId },
        GRACE_SECONDS,
      );
      expect(released?.left_at).not.toBeNull();

      await claimSpeakerSeat(eventId, { type: "guest", id: newGuestId }, 2, "Full Path Test — new occupant");

      const staleReconnect = await markSpeakerReconnected(eventId, { type: "guest", id: originalGuestId });
      expect(staleReconnect).toBeNull();

      const newOccupant = await fetchRow(newGuestId);
      expect(newOccupant?.left_at).toBeNull();
      expect(newOccupant?.seat_number).toBe(2);
    });
  });

  describe("cause B: connected but both camera and mic off/muted (issue #18 unified inactive-speaker finding)", () => {
    it("a media-inactive row's media_inactive_since, fetched fresh from the DB, drives matching 'Resume speaking · Ns' and 'Speaker inactive · Ns' text — the same fetched value, two components", async () => {
      const guestId = crypto.randomUUID();
      await claimSpeakerSeat(eventId, { type: "guest", id: guestId }, 1, "Full Path Test E");
      await markSpeakerMediaInactive(eventId, { type: "guest", id: guestId });
      await backdateMediaInactiveSince(guestId, 3);

      const row = await fetchRow(guestId);
      expect(row).not.toBeNull();
      expect(row!.media_inactive_since).not.toBeNull();
      expect(row!.disconnected_at).toBeNull();

      const expectedSeconds = GRACE_SECONDS - 3;

      render(
        <SpeakerMediaActivationPrompt
          needsMediaActivation={false}
          bothMediaMuted={true}
          activateMedia={async () => {}}
          mediaError={null}
          inactiveSince={inactiveSince(row)}
        />,
      );
      expect(screen.getByTestId("speaker-resume-speaking")).toBeInTheDocument();
      expect(screen.getByTestId("speaker-reconnect-countdown")).toHaveTextContent(`· ${expectedSeconds}s`);

      render(<SpeakerTile speaker={row} participant={undefined} isLocal={false} isInactive={true} />);
      expect(screen.getByTestId("audience-inactive-countdown")).toHaveTextContent(
        `Speaker inactive · ${expectedSeconds}s`,
      );
    });

    it("restoring either media source (mark_speaker_media_active) clears the deadline immediately on both surfaces", async () => {
      const guestId = crypto.randomUUID();
      await claimSpeakerSeat(eventId, { type: "guest", id: guestId }, 1, "Full Path Test F");
      await markSpeakerMediaInactive(eventId, { type: "guest", id: guestId });
      await backdateMediaInactiveSince(guestId, 4);

      const inactiveRow = await fetchRow(guestId);
      expect(inactiveRow!.media_inactive_since).not.toBeNull();

      await markSpeakerMediaActive(eventId, { type: "guest", id: guestId });
      const activeRow = await fetchRow(guestId);
      expect(activeRow).not.toBeNull();
      expect(activeRow!.media_inactive_since).toBeNull();

      render(<SpeakerTile speaker={activeRow} participant={undefined} isLocal={false} isInactive={false} />);
      expect(screen.queryByTestId("audience-inactive-countdown")).not.toBeInTheDocument();
    });

    it("restoring before expiry, even backdated past what would have been the threshold, prevents release — the atomic WHERE clause re-checks media_inactive_since fresh, never trusts a stale caller estimate", async () => {
      const guestId = crypto.randomUUID();
      await claimSpeakerSeat(eventId, { type: "guest", id: guestId }, 1, "Full Path Test — media restored in time");
      await markSpeakerMediaInactive(eventId, { type: "guest", id: guestId });
      await backdateMediaInactiveSince(guestId, 12); // would be expired...
      await markSpeakerMediaActive(eventId, { type: "guest", id: guestId }); // ...but media was restored

      const released = await releaseExpiredInactiveSpeaker(eventId, { type: "guest", id: guestId }, GRACE_SECONDS);
      expect(released).toBeNull();
      expect((await fetchRow(guestId))?.left_at).toBeNull();
    });

    it("remaining inactive through expiry releases the seat, with left_reason recording the media cause", async () => {
      const guestId = crypto.randomUUID();
      await claimSpeakerSeat(eventId, { type: "guest", id: guestId }, 1, "Full Path Test G");
      await markSpeakerMediaInactive(eventId, { type: "guest", id: guestId });
      await backdateMediaInactiveSince(guestId, 12); // past the 11s grace

      const released = await releaseExpiredInactiveSpeaker(eventId, { type: "guest", id: guestId }, GRACE_SECONDS);
      expect(released?.left_at).not.toBeNull();
      expect(released?.left_reason).toBe("inactive");

      const rowAfterExpiry = await fetchRow(guestId);
      expect(rowAfterExpiry).toBeNull();

      render(<SpeakerTile speaker={rowAfterExpiry} participant={undefined} isLocal={false} isInactive={false} />);
      expect(screen.queryByTestId("audience-inactive-countdown")).not.toBeInTheDocument();
      expect(screen.getByTestId("empty-seat")).toBeInTheDocument();
    });

    it("idempotent: a duplicate mark_speaker_media_inactive report never restarts the clock", async () => {
      const guestId = crypto.randomUUID();
      await claimSpeakerSeat(eventId, { type: "guest", id: guestId }, 1, "Full Path Test H");
      const first = await markSpeakerMediaInactive(eventId, { type: "guest", id: guestId });
      const firstTimestamp = first?.media_inactive_since;
      expect(firstTimestamp).not.toBeNull();

      await new Promise((resolve) => setTimeout(resolve, 50));
      const second = await markSpeakerMediaInactive(eventId, { type: "guest", id: guestId });
      expect(second?.media_inactive_since).toBe(firstTimestamp);
    });

    it("does not release a seat whose media_inactive_since hasn't crossed the threshold yet", async () => {
      const guestId = crypto.randomUUID();
      await claimSpeakerSeat(eventId, { type: "guest", id: guestId }, 1, "Full Path Test I");
      await markSpeakerMediaInactive(eventId, { type: "guest", id: guestId });
      await backdateMediaInactiveSince(guestId, 9); // 9s of 11s elapsed — not yet expired

      const released = await releaseExpiredInactiveSpeaker(eventId, { type: "guest", id: guestId }, GRACE_SECONDS);
      expect(released).toBeNull();
      expect((await fetchRow(guestId))?.left_at).toBeNull();
    });
  });
});
