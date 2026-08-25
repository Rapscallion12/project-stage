import { render, screen } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SpeakerTile } from "./speaker-tile";
import { SpeakerMediaActivationPrompt } from "./speaker-media-activation-prompt";
import { createServiceClient } from "@/lib/supabase/service";
import {
  claimSpeakerSeat,
  markSpeakerDisconnected,
  markSpeakerReconnected,
  releaseExpiredDisconnectedSpeaker,
  type EventSpeaker,
} from "@/lib/repositories/event-speakers";

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
 * deadline on the disconnected speaker's tile (`SpeakerTile`). Both
 * surfaces were already unit-tested against synthetic `disconnected_at`
 * strings (`speaker-media-activation-prompt.test.tsx`,
 * `speaker-tile.test.tsx`'s "audience reconnect countdown" describe
 * block) and the DB/RPC layer was already tested against the real linked
 * project (`event-speakers-disconnect-grace.test.ts`) — but nothing
 * closed the gap the user explicitly flagged: "do not assume the hook
 * being correct means the UI has the timestamp."
 *
 * This file closes that gap: it fetches a real row's `disconnected_at`
 * from the real linked Supabase project (a service-client read shaped
 * identically to `listActiveSpeakers` — see
 * `event-speakers-transitions.test.ts`'s own comment for why a direct
 * read stands in for the repository function's own `next/headers`-bound
 * one in a test context) and feeds that *exact* fetched value into both
 * real components' props, asserting they render matching text. If the
 * DB row's shape, the value the client would actually receive, or either
 * component's read of it ever diverges, this fails — unlike a synthetic
 * fixture, which can't catch a real DB/type mismatch.
 */
describe.skipIf(!hasServiceCredentials)("reconnect countdown — full data/render path (issue #18)", () => {
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

  it("a disconnected row's disconnected_at, fetched fresh from the DB, drives matching 'Tap to reconnect · Ns' and 'Speaker reconnecting · Ns' text — the same fetched value, two components", async () => {
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
        activateMedia={async () => {}}
        mediaError={null}
        disconnectedAt={row!.disconnected_at}
      />,
    );
    expect(screen.getByTestId("speaker-reconnect-countdown")).toHaveTextContent(`· ${expectedSeconds}s`);

    render(<SpeakerTile speaker={row} participant={undefined} isLocal={false} isReconnecting={true} />);
    expect(screen.getByTestId("audience-reconnect-countdown")).toHaveTextContent(
      `Speaker reconnecting · ${expectedSeconds}s`,
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
        activateMedia={async () => {}}
        mediaError={null}
        disconnectedAt={row!.disconnected_at}
      />,
    );
    expect(screen.getByTestId("speaker-reconnect-countdown")).toHaveTextContent(`· ${expectedSeconds}s`);
    expect(screen.queryByText(`· ${GRACE_SECONDS}s`)).not.toBeInTheDocument();

    render(<SpeakerTile speaker={row} participant={undefined} isLocal={false} isReconnecting={true} />);
    expect(screen.getByTestId("audience-reconnect-countdown")).toHaveTextContent(
      `Speaker reconnecting · ${expectedSeconds}s`,
    );
  });

  it("reconnecting clears both countdown states immediately — the re-fetched row's null disconnected_at removes the suffix on both surfaces", async () => {
    const guestId = crypto.randomUUID();
    await claimSpeakerSeat(eventId, { type: "guest", id: guestId }, 1, "Full Path Test C");
    await markSpeakerDisconnected(eventId, { type: "guest", id: guestId });
    await backdateDisconnectedAt(guestId, 4);

    // Confirm the countdown is genuinely live before reconnecting.
    const disconnectedRow = await fetchRow(guestId);
    expect(disconnectedRow!.disconnected_at).not.toBeNull();

    await markSpeakerReconnected(eventId, { type: "guest", id: guestId });
    const reconnectedRow = await fetchRow(guestId);
    expect(reconnectedRow).not.toBeNull();
    expect(reconnectedRow!.disconnected_at).toBeNull();

    render(
      <SpeakerMediaActivationPrompt
        needsMediaActivation={true}
        activateMedia={async () => {}}
        mediaError={null}
        disconnectedAt={reconnectedRow!.disconnected_at}
      />,
    );
    expect(screen.queryByTestId("speaker-reconnect-countdown")).not.toBeInTheDocument();

    render(<SpeakerTile speaker={reconnectedRow} participant={undefined} isLocal={false} isReconnecting={false} />);
    expect(screen.queryByTestId("audience-reconnect-countdown")).not.toBeInTheDocument();
  });

  it("expiration releases the seat entirely — the row disappears from a fresh fetch, so both countdown states vanish because there's no seat left to render them for", async () => {
    const guestId = crypto.randomUUID();
    await claimSpeakerSeat(eventId, { type: "guest", id: guestId }, 1, "Full Path Test D");
    await markSpeakerDisconnected(eventId, { type: "guest", id: guestId });
    await backdateDisconnectedAt(guestId, 12); // past the 11s grace

    const released = await releaseExpiredDisconnectedSpeaker(eventId, { type: "guest", id: guestId }, GRACE_SECONDS);
    expect(released?.left_at).not.toBeNull();

    const rowAfterExpiry = await fetchRow(guestId);
    expect(rowAfterExpiry).toBeNull(); // no active seat left to fetch — this is what makes the row vanish from the real client's `speakers` state too

    // The real room, having seen the seat disappear from `speakers`,
    // would render this tile with speaker=null (seat released) — not a
    // stale reconnecting state for a row that no longer exists.
    render(<SpeakerTile speaker={rowAfterExpiry} participant={undefined} isLocal={false} isReconnecting={false} />);
    expect(screen.queryByTestId("audience-reconnect-countdown")).not.toBeInTheDocument();
    expect(screen.getByTestId("empty-seat")).toBeInTheDocument();

    // A late reconnect for the same (now-inactive) identity must not
    // resurrect the row or reintroduce a countdown.
    const staleReconnect = await markSpeakerReconnected(eventId, { type: "guest", id: guestId });
    expect(staleReconnect).toBeNull();
    expect(await fetchRow(guestId)).toBeNull();
  });
});
