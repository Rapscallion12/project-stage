import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventRoom } from "./event-room";
import type { Identity } from "@/lib/identity";
import type { Event } from "@/lib/repositories/events";
import type { EventSpeaker } from "@/lib/repositories/event-speakers";

/**
 * Issue #18 first-load consistency finding: a seated speaker
 * intermittently landed in the ordinary two-seat/split composition
 * despite the authoritative data already saying they held a seat — most
 * reproducible right after a fresh deployment. Traced to
 * `useOrientation`/`useIsDesktopViewport`'s `useSyncExternalStore`
 * `getServerSnapshot` guessing a fixed default (mobile-portrait) for
 * both the server render and the client's first hydration pass; on a
 * real desktop browser, that guess briefly renders a mobile composition
 * (which does have a role router) before React corrects to the real
 * client value and `EventRoom` switches to `DesktopRoom` — which has no
 * role router at all (an approved, deliberate scope boundary: Speaker
 * View has no desktop equivalent) and never reconsiders role again.
 *
 * This file tests `EventRoom`'s own composition-selection contract
 * directly: `PortraitRoom`/`MobileLandscapeRoom`/`DesktopRoom` are
 * mocked as thin stand-ins that just report which one rendered and with
 * what `participantRole`, and `useHasMountedOnClient`/
 * `useIsDesktopViewport`/`useOrientation` are mocked so each scenario's
 * *sequence* of values can be driven explicitly via `rerender` — the
 * actual React guarantee that a plain `useEffect` only fires after a
 * commit's `useSyncExternalStore` corrections have already landed (see
 * `useHasMountedOnClient`'s own doc comment) is a documented React
 * behavior, not something re-provable by a jsdom test; what's tested
 * here is the *consequence*: EventRoom must never commit to a specific
 * composition on an as-yet-unknown viewport, and once known, must
 * reflect the authoritative role immediately and consistently — no
 * ordering of "viewport known" vs "speaker data known" should ever
 * leave the wrong composition mounted.
 */
const {
  mockHasMountedOnClient,
  mockIsDesktopViewport,
  mockOrientation,
  mockRefetchSpeakers,
  mockJoinOpenSeat,
  mockCanPublish,
} = vi.hoisted(() => ({
  mockHasMountedOnClient: vi.fn(() => false),
  mockIsDesktopViewport: vi.fn(() => false),
  mockOrientation: vi.fn(() => "portrait" as "portrait" | "landscape"),
  mockRefetchSpeakers: vi.fn(async () => {}),
  mockJoinOpenSeat: vi.fn(),
  mockCanPublish: vi.fn(() => false),
}));

vi.mock("@/hooks/use-has-mounted-on-client", () => ({
  useHasMountedOnClient: mockHasMountedOnClient,
}));
vi.mock("@/hooks/use-desktop-viewport", () => ({
  useIsDesktopViewport: mockIsDesktopViewport,
}));
vi.mock("@/hooks/use-orientation", () => ({
  useOrientation: mockOrientation,
}));

vi.mock("@/hooks/use-active-speakers", () => ({
  useActiveSpeakers: (_eventId: string, initialSpeakers: EventSpeaker[]) => ({
    speakers: initialSpeakers,
    roomStatus: "live",
    refetch: mockRefetchSpeakers,
  }),
}));
vi.mock("@/hooks/use-lobby-realtime", () => ({
  useLobbyRealtime: (
    _eventId: string,
    _identity: unknown,
    initialMessages: unknown[],
    initialReactions: Record<string, unknown>,
  ) => ({
    messages: initialMessages,
    reactions: initialReactions,
  }),
}));
vi.mock("@/hooks/use-live-room-connection", () => ({
  useLiveRoomConnection: () => ({
    status: "connected",
    participantCount: 1,
    mediaError: null,
    canPublish: mockCanPublish(),
    needsMediaActivation: false,
    activateMedia: vi.fn(async () => {}),
    getParticipant: () => undefined,
    localVideoTrack: null,
    prepareLocalMedia: vi.fn(async () => {}),
    releaseLocalMedia: vi.fn(),
    microphoneMuted: false,
    cameraMuted: false,
    toggleMicrophone: vi.fn(async () => {}),
    toggleCamera: vi.fn(async () => {}),
  }),
}));
vi.mock("@/hooks/use-automatic-promotion", () => ({
  useAutomaticPromotion: () => ({ countdown: null, cancel: vi.fn() }),
}));
vi.mock("@/hooks/use-speaker-reconnect-grace", () => ({
  useSpeakerReconnectGrace: () => new Set<string>(),
}));
vi.mock("@/hooks/use-now", () => ({
  useNow: () => Date.now(),
}));
vi.mock("@/lib/dev-demo", () => ({
  isDevToolsAvailable: () => false,
}));
vi.mock("@/app/events/[id]/room/actions", () => ({
  joinOpenSeat: mockJoinOpenSeat,
  reportSpeakerMediaActive: vi.fn(),
  reportSpeakerMediaInactive: vi.fn(),
  confirmOwnSeatExpiration: vi.fn(),
  // Issue #21, fourth corrective pass: useStageRoundReconciliation (now
  // wired into EventRoom) calls this whenever occupancy changes — a
  // harmless no-op mock, same as every other action here this file's
  // own composition tests don't otherwise care about.
  reconcileStageRoundAction: vi.fn(),
  // Issue #21, fifth corrective pass: useSpeakerSelectionReconciliation's
  // own equivalent — same reasoning.
  reconcileSpeakerSelectionAction: vi.fn(),
}));

vi.mock("@/components/room/portrait-room", () => ({
  // Issue #18 real-device finding (2026-08-27): the tap-empty-seat button
  // is a deliberate addition to this stand-in — only this composition's
  // tests exercise handleTapEmptySeat's "already-speaking" contradiction
  // branch, and every other existing test in this file ignores an
  // unclicked button, so this is safe to add unconditionally rather than
  // needing a second, parallel mock just for that describe block.
  PortraitRoom: (props: { participantRole: string; onTapEmptySeat?: () => void; joinSeatMessage?: string | null }) => (
    <div data-testid="portrait-room" data-role={props.participantRole}>
      <button type="button" data-testid="tap-empty-seat" onClick={() => props.onTapEmptySeat?.()} />
      {props.joinSeatMessage && <p>{props.joinSeatMessage}</p>}
    </div>
  ),
}));
vi.mock("@/components/room/mobile-landscape-room", () => ({
  MobileLandscapeRoom: (props: { participantRole: string }) => (
    <div data-testid="mobile-landscape-room" data-role={props.participantRole} />
  ),
}));
vi.mock("@/components/room/desktop-room", () => ({
  DesktopRoom: (props: { participantRole: string }) => (
    <div data-testid="desktop-room" data-role={props.participantRole} />
  ),
}));

const identity: Identity = { type: "profile", id: "p1", displayName: "Jamie" };

const event: Event = {
  id: "e1",
  title: "Late Night Debate",
  description: "",
  scheduled_start: new Date(Date.now() - 60_000).toISOString(),
  lobby_opens_at: new Date(Date.now() - 120_000).toISOString(),
  created_at: new Date().toISOString(),
  format: "main_stage",
};

function mySeat(overrides: Partial<EventSpeaker> = {}): EventSpeaker {
  return {
    id: "s1",
    event_id: "e1",
    profile_id: "p1",
    guest_id: null,
    seat_number: 1,
    display_name: "Jamie",
    joined_at: new Date().toISOString(),
    left_at: null,
    left_reason: null,
    disconnected_at: null,
    media_inactive_since: null,
    round_number: 1,
    round_started_at: new Date().toISOString(),
    round_ends_at: new Date(Date.now() + 60_000).toISOString(),
    round_phase: "active" as const,
    closing_ends_at: null,
    ...overrides,
  };
}

function renderEventRoom(initialSpeakers: EventSpeaker[]) {
  return render(
    <EventRoom
      event={event}
      identity={identity}
      initialPhase="ready"
      initialToken={null}
      initialSpeakers={initialSpeakers}
      initialMessages={[]}
      initialReactions={{}}
      initialHasPendingRequest={false}
      initialPendingRequests={[]}
      isPreviewBuild={false}
    />,
  );
}

describe("EventRoom — first-load composition consistency (issue #18 finding)", () => {
  it("page loads fresh while DB already says the viewer owns a seat, but the client hasn't mounted yet: shows the neutral reconnecting state, not any composition", () => {
    mockHasMountedOnClient.mockReturnValue(false);
    mockIsDesktopViewport.mockReturnValue(false);
    mockOrientation.mockReturnValue("portrait");

    renderEventRoom([mySeat()]);

    expect(screen.queryByTestId("portrait-room")).not.toBeInTheDocument();
    expect(screen.queryByTestId("mobile-landscape-room")).not.toBeInTheDocument();
    expect(screen.queryByTestId("desktop-room")).not.toBeInTheDocument();
    expect(screen.getByText("Reconnecting to stage…")).toBeInTheDocument();
  });

  it("the neutral state says nothing extra for an ordinary audience member — no false 'reconnecting' framing for someone who was never seated", () => {
    mockHasMountedOnClient.mockReturnValue(false);
    mockIsDesktopViewport.mockReturnValue(false);
    mockOrientation.mockReturnValue("portrait");

    renderEventRoom([]);

    expect(screen.queryByText("Reconnecting to stage…")).not.toBeInTheDocument();
  });

  it("once mounted, a genuine desktop viewport renders DesktopRoom with the correct speaker role — never stuck on a stale mobile guess", () => {
    mockHasMountedOnClient.mockReturnValue(true);
    mockIsDesktopViewport.mockReturnValue(true);
    mockOrientation.mockReturnValue("portrait");

    renderEventRoom([mySeat()]);

    expect(screen.getByTestId("desktop-room")).toHaveAttribute("data-role", "speaker");
    expect(screen.queryByTestId("portrait-room")).not.toBeInTheDocument();
    expect(screen.queryByTestId("mobile-landscape-room")).not.toBeInTheDocument();
  });

  it("once mounted, mobile portrait renders PortraitRoom with the correct speaker role", () => {
    mockHasMountedOnClient.mockReturnValue(true);
    mockIsDesktopViewport.mockReturnValue(false);
    mockOrientation.mockReturnValue("portrait");

    renderEventRoom([mySeat()]);

    expect(screen.getByTestId("portrait-room")).toHaveAttribute("data-role", "speaker");
  });

  it("once mounted, mobile landscape renders MobileLandscapeRoom with the correct speaker role", () => {
    mockHasMountedOnClient.mockReturnValue(true);
    mockIsDesktopViewport.mockReturnValue(false);
    mockOrientation.mockReturnValue("landscape");

    renderEventRoom([mySeat()]);

    expect(screen.getByTestId("mobile-landscape-room")).toHaveAttribute("data-role", "speaker");
  });

  describe("hydration-order transitions — no frame after authoritative resolution keeps the Audience stage mounted", () => {
    it("viewport becomes known after speaker data was already correct: the very first real composition render already reflects 'speaker', never a mobile flash then a stuck DesktopRoom in the wrong role", () => {
      mockHasMountedOnClient.mockReturnValue(false);
      mockIsDesktopViewport.mockReturnValue(false); // SSR-guessed default
      mockOrientation.mockReturnValue("portrait");
      const { rerender } = renderEventRoom([mySeat()]);
      expect(screen.queryByTestId("desktop-room")).not.toBeInTheDocument();
      expect(screen.queryByTestId("portrait-room")).not.toBeInTheDocument();

      // The mount effect fires and, in the same tick React guarantees,
      // isDesktopViewport has already corrected to the real client value.
      mockHasMountedOnClient.mockReturnValue(true);
      mockIsDesktopViewport.mockReturnValue(true);
      rerender(
        <EventRoom
          event={event}
          identity={identity}
          initialPhase="ready"
          initialToken={null}
          initialSpeakers={[mySeat()]}
          initialMessages={[]}
          initialReactions={{}}
          initialHasPendingRequest={false}
          initialPendingRequests={[]}
          isPreviewBuild={false}
        />,
      );

      expect(screen.getByTestId("desktop-room")).toHaveAttribute("data-role", "speaker");
      expect(screen.queryByTestId("portrait-room")).not.toBeInTheDocument();
    });

    it("initial speaker data arrives one render late (identity resolves to speaker only after a later render): the composition immediately reflects the corrected role, without needing an extra frame of its own", () => {
      mockHasMountedOnClient.mockReturnValue(true);
      mockIsDesktopViewport.mockReturnValue(false);
      mockOrientation.mockReturnValue("portrait");
      const { rerender } = renderEventRoom([]); // not a speaker yet
      expect(screen.getByTestId("portrait-room")).toHaveAttribute("data-role", "audience");

      rerender(
        <EventRoom
          event={event}
          identity={identity}
          initialPhase="ready"
          initialToken={null}
          initialSpeakers={[mySeat()]} // speaker data arrives
          initialMessages={[]}
          initialReactions={{}}
          initialHasPendingRequest={false}
          initialPendingRequests={[]}
          isPreviewBuild={false}
        />,
      );
      expect(screen.getByTestId("portrait-room")).toHaveAttribute("data-role", "speaker");
    });

    it("role changes from unknown/audience to speaker while hydration is still settling: the neutral state (not the audience composition) covers the gap, and the first real render is already correct", () => {
      mockHasMountedOnClient.mockReturnValue(false);
      mockIsDesktopViewport.mockReturnValue(false);
      mockOrientation.mockReturnValue("portrait");
      const { rerender } = renderEventRoom([]);
      expect(screen.queryByTestId("portrait-room")).not.toBeInTheDocument();
      expect(screen.queryByText("Reconnecting to stage…")).not.toBeInTheDocument();

      // Speaker data resolves before the client has finished mounting.
      rerender(
        <EventRoom
          event={event}
          identity={identity}
          initialPhase="ready"
          initialToken={null}
          initialSpeakers={[mySeat()]}
          initialMessages={[]}
          initialReactions={{}}
          initialHasPendingRequest={false}
          initialPendingRequests={[]}
          isPreviewBuild={false}
        />,
      );
      expect(screen.queryByTestId("portrait-room")).not.toBeInTheDocument();
      expect(screen.getByText("Reconnecting to stage…")).toBeInTheDocument();

      mockHasMountedOnClient.mockReturnValue(true);
      rerender(
        <EventRoom
          event={event}
          identity={identity}
          initialPhase="ready"
          initialToken={null}
          initialSpeakers={[mySeat()]}
          initialMessages={[]}
          initialReactions={{}}
          initialHasPendingRequest={false}
          initialPendingRequests={[]}
          isPreviewBuild={false}
        />,
      );
      expect(screen.getByTestId("portrait-room")).toHaveAttribute("data-role", "speaker");
      expect(screen.queryByText("Reconnecting to stage…")).not.toBeInTheDocument();
    });
  });

  describe("ownership contradiction: joinOpenSeat finds an active seat while participantRole/mySeatNumber say audience (issue #18 real-device finding, 2026-08-27)", () => {
    afterEach(() => {
      mockRefetchSpeakers.mockClear();
      mockJoinOpenSeat.mockClear();
    });

    it("reconciles from the server instead of leaving the caller on a dead-end error — there is never a stable render stuck showing 'You're already speaking' while participantRole is audience", async () => {
      mockHasMountedOnClient.mockReturnValue(true);
      mockIsDesktopViewport.mockReturnValue(false);
      mockOrientation.mockReturnValue("portrait");
      // getActiveSeatForIdentity (server, expiration-aware) proves this
      // identity actually owns seat 1 — the exact contradiction the
      // real-device report captured: this render's own participantRole/
      // mySeatNumber (derived from useActiveSpeakers' initialSpeakers=[])
      // says audience/null.
      mockJoinOpenSeat.mockResolvedValue({ ok: false, reason: "already-speaking", seatNumber: 1 });

      renderEventRoom([]); // isSpeaker=false, mySeatNumber=null — the "audience" side of the contradiction
      expect(screen.getByTestId("portrait-room")).toHaveAttribute("data-role", "audience");

      fireEvent.click(screen.getByTestId("tap-empty-seat"));

      await waitFor(() => {
        expect(mockJoinOpenSeat).toHaveBeenCalledWith("e1");
      });
      // The reconciliation trigger — useActiveSpeakers' own resync (see
      // its dedicated test file) is what actually corrects the client's
      // speakers state from here; this proves EventRoom invokes it the
      // instant the contradiction is proven, rather than rendering a
      // generic, unrecoverable error message.
      await waitFor(() => {
        expect(mockRefetchSpeakers).toHaveBeenCalledTimes(1);
      });
      // No dead-end error text anywhere — this is a reconciliation
      // trigger, not an ordinary rejection surfaced to the user as text.
      expect(screen.queryByText("You're already speaking.")).not.toBeInTheDocument();
    });

    it("an ordinary rejection (not the ownership contradiction) still surfaces its own error text and does not trigger a reconciliation refetch", async () => {
      mockHasMountedOnClient.mockReturnValue(true);
      mockIsDesktopViewport.mockReturnValue(false);
      mockOrientation.mockReturnValue("portrait");
      mockJoinOpenSeat.mockResolvedValue({ ok: false, reason: "error", error: "Both seats are currently full." });

      renderEventRoom([]);
      fireEvent.click(screen.getByTestId("tap-empty-seat"));

      await waitFor(() => {
        expect(screen.getByText("Both seats are currently full.")).toBeInTheDocument();
      });
      expect(mockRefetchSpeakers).not.toHaveBeenCalled();
    });
  });

  describe("automatic seat reconciliation — no second Join tap required (issue #18 real-device finding, 2026-08-28: the split-layout bug reproduced again; a second manual Join tap fixed it, proving the reconciliation mechanism existed but nothing triggered it automatically)", () => {
    afterEach(() => {
      mockRefetchSpeakers.mockClear();
      mockJoinOpenSeat.mockClear();
      mockCanPublish.mockReturnValue(false);
    });

    it("a missed Realtime delta after a successful seat claim: canPublish becomes true (LiveKit confirms speaker rights) while participantRole still says audience — refetch fires automatically, with no tap of any kind", async () => {
      mockHasMountedOnClient.mockReturnValue(true);
      mockIsDesktopViewport.mockReturnValue(false);
      mockOrientation.mockReturnValue("portrait");
      mockCanPublish.mockReturnValue(false);

      // initialSpeakers=[] models exactly the captured real-device state:
      // this identity's own seat-claim INSERT never reached this tab's
      // Realtime subscription, so useActiveSpeakers' client state has no
      // row for it at all — participantRole resolves to audience even
      // though the server (and, independently, LiveKit) already know
      // otherwise.
      const { rerender } = renderEventRoom([]);
      expect(screen.getByTestId("portrait-room")).toHaveAttribute("data-role", "audience");
      expect(mockRefetchSpeakers).not.toHaveBeenCalled();

      // LiveKit's own permission push lands independently of the missed
      // Postgres Realtime delta — this is the contradiction
      // useSeatReconciliation's watchdog exists to catch.
      mockCanPublish.mockReturnValue(true);
      rerender(
        <EventRoom
          event={event}
          identity={identity}
          initialPhase="ready"
          initialToken={null}
          initialSpeakers={[]}
          initialMessages={[]}
          initialReactions={{}}
          initialHasPendingRequest={false}
          initialPendingRequests={[]}
          isPreviewBuild={false}
        />,
      );

      await waitFor(() => {
        expect(mockRefetchSpeakers).toHaveBeenCalledTimes(1);
      });
      // No duplicate seat claim — the watchdog only ever reads, it never
      // re-attempts to join.
      expect(mockJoinOpenSeat).not.toHaveBeenCalled();
    });

    it("Speaker View replaces the split layout once the resync's fresh data actually lands, with no tap required at any point in the sequence", async () => {
      mockHasMountedOnClient.mockReturnValue(true);
      mockIsDesktopViewport.mockReturnValue(false);
      mockOrientation.mockReturnValue("portrait");
      mockCanPublish.mockReturnValue(true); // already contradicted from the very first render

      const { rerender } = renderEventRoom([]);
      expect(screen.getByTestId("portrait-room")).toHaveAttribute("data-role", "audience");

      await waitFor(() => {
        expect(mockRefetchSpeakers).toHaveBeenCalledTimes(1);
      });

      // Models what a real refetch() resolving would do: useActiveSpeakers'
      // own state now includes this identity's seat. EventRoom itself
      // never has to be told to "switch to Speaker View" — participantRole
      // and the role router both simply recompute from the corrected data,
      // same as any other speakers-state update.
      rerender(
        <EventRoom
          event={event}
          identity={identity}
          initialPhase="ready"
          initialToken={null}
          initialSpeakers={[mySeat()]}
          initialMessages={[]}
          initialReactions={{}}
          initialHasPendingRequest={false}
          initialPendingRequests={[]}
          isPreviewBuild={false}
        />,
      );
      expect(screen.getByTestId("portrait-room")).toHaveAttribute("data-role", "speaker");
      expect(mockJoinOpenSeat).not.toHaveBeenCalled();
    });

    it("once participantRole already correctly says speaker, canPublish being true triggers no reconciliation at all — the watchdog only reacts to the contradiction, never to the ordinary case", () => {
      mockHasMountedOnClient.mockReturnValue(true);
      mockIsDesktopViewport.mockReturnValue(false);
      mockOrientation.mockReturnValue("portrait");
      mockCanPublish.mockReturnValue(true);

      renderEventRoom([mySeat()]); // participantRole already "speaker" — no contradiction
      expect(screen.getByTestId("portrait-room")).toHaveAttribute("data-role", "speaker");
      expect(mockRefetchSpeakers).not.toHaveBeenCalled();
    });
  });
});
