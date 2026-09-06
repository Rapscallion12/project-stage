import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SpeakerStage } from "./speaker-stage";
import type { LocalVideoTrack, Participant, TrackPublication } from "livekit-client";
import type { EventSpeaker } from "@/lib/repositories/event-speakers";
import type { StageRound } from "@/lib/repositories/stage-rounds";
import type { RankedPendingRequest } from "@/hooks/use-active-speaker-requests";
import type { Identity } from "@/lib/identity";
import type { MediaReadinessState } from "@/hooks/use-live-room-connection";
import type { ReactionsController } from "@/hooks/use-stage-reactions";

const MOCK_STAGE_REACTIONS_BASE: ReactionsController = {
  selectedEmoji: "❤️",
  setSelectedEmoji: vi.fn(),
  displayMode: "on-speaker",
  setDisplayMode: vi.fn(),
  showReactions: true,
  setShowReactions: vi.fn(),
  incoming: [],
  send: vi.fn(async () => ({ ok: true as const, heatAfter: 0, inCooldownAfter: false })),
  heat: 0,
  heatFraction: 0,
  inCooldown: false,
  canSend: true,
  // A third-party viewer, distinct from every speaker identity used below
  // (p1/p2/alice/bob/me/remote/someone-else/etc.) — the safe default for
  // tests that don't specifically care about the sender/others split.
  myIdentity: "profile:viewer",
};

// Media rendering bugfix pass (real-device report): jsdom has no real Web
// Audio API — see speaker-tile.test.tsx's identical mock for why this is
// a harmless stand-in, not something that tests the analyser's own math.
vi.mock("livekit-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("livekit-client")>();
  return {
    ...actual,
    createAudioAnalyser: vi.fn(() => ({
      calculateVolume: () => 0,
      analyser: { context: { state: "running", resume: vi.fn(async () => {}) } } as unknown as AnalyserNode,
      cleanup: vi.fn(async () => {}),
    })),
  };
});

const MEDIA_READY: MediaReadinessState = { camera: { ready: true, error: null }, microphone: { ready: true, error: null } };

/** A minimal stand-in for a real Participant — only getTrackPublication is ever called on it. */
function fakeParticipant(publications: Partial<Record<"camera" | "microphone", Partial<TrackPublication>>>): Participant {
  return {
    getTrackPublication: (source: string) => {
      if (source === "camera") return publications.camera as TrackPublication | undefined;
      if (source === "microphone") return publications.microphone as TrackPublication | undefined;
      return undefined;
    },
  } as unknown as Participant;
}

function pendingRequest(overrides: Partial<RankedPendingRequest> = {}): RankedPendingRequest {
  return {
    id: "r1",
    event_id: "e1",
    profile_id: null,
    guest_id: "g1",
    message_id: "m1",
    status: "pending",
    created_at: new Date().toISOString(),
    resolved_at: null,
    selection_round_id: null,
    frozen_rank: null,
    frozen_vote_count: null,
    is_current_candidate: false,
    selection_failed: false,
    reserved_seat_number: null,
    voteCount: 0,
    isMyVote: false,
    ...overrides,
  };
}

function stageRoundFixture(overrides: Partial<StageRound> = {}): StageRound {
  return {
    id: "sr1",
    event_id: "e1",
    round_number: 1,
    started_at: new Date().toISOString(),
    ends_at: new Date(Date.now() + 60_000).toISOString(),
    phase: "active",
    updated_at: new Date().toISOString(),
    fallback_excluded_profile_ids: [],
    fallback_excluded_guest_ids: [],
    ...overrides,
  };
}

/** A minimal stand-in for a real LocalVideoTrack — SelfPreview only ever calls attach/detach on it. */
function fakeVideoTrack(): LocalVideoTrack {
  return { attach: vi.fn(), detach: vi.fn() } as unknown as LocalVideoTrack;
}

function speaker(overrides: Partial<EventSpeaker> = {}): EventSpeaker {
  return {
    id: "s1",
    event_id: "e1",
    profile_id: "p1",
    guest_id: null,
    seat_number: 1,
    display_name: "Jamie Rivera",
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

// Issue #18 consistency fix: isSpeaker/mySeatNumber are now plain props
// (computed once in EventRoom via lib/participant-role.ts), not derived
// internally from speakers/myIdentity — see that file's own doc comment
// for the investigation this closes. Tests below pass them explicitly,
// matching whatever the old internal derivation would have produced for
// the same speakers/myIdentity, unless a test says otherwise.
const baseProps = {
  getParticipant: () => undefined,
  myIdentity: "profile:someone-else",
  isSpeaker: false,
  mySeatNumber: null as 1 | 2 | null,
  needsMediaActivation: false,
  activateMedia: vi.fn(async () => MEDIA_READY),
  mediaError: null,
  onTapEmptySeat: vi.fn(),
  isJoiningSeat: false,
  localVideoTrack: null,
  reconnectingIdentities: new Set<string>(),
};

describe("SpeakerStage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("always renders both seats, occupied or not — issue #20's two-seat framing", () => {
    render(<SpeakerStage speakers={[speaker({ seat_number: 1 })]} orientation="portrait" {...baseProps} />);
    expect(screen.getByTestId("speaker-tile")).toBeInTheDocument();
    expect(screen.getByTestId("empty-seat")).toBeInTheDocument();
  });

  it("establishes a structural divider between the two seats, rendered but inert (issue #25 attaches real behavior later)", () => {
    render(<SpeakerStage speakers={[]} orientation="portrait" {...baseProps} />);
    const divider = screen.getByTestId("speaker-divider");
    expect(divider).toBeInTheDocument();
    // Not yet a button/interactive control — it has no function to expose
    // to assistive tech until #25 gives it one.
    expect(divider.tagName).toBe("DIV");
    expect(divider).toHaveAttribute("aria-hidden", "true");
  });

  it("lays the divider out horizontally between stacked seats in portrait, vertically between side-by-side seats in landscape", () => {
    const { rerender } = render(<SpeakerStage speakers={[]} orientation="portrait" {...baseProps} />);
    expect(screen.getByTestId("speaker-divider").className).toMatch(/\bh-2\b/);

    rerender(<SpeakerStage speakers={[]} orientation="landscape" {...baseProps} />);
    expect(screen.getByTestId("speaker-divider").className).toMatch(/\bw-2\b/);
  });

  // Issue #21, seventh corrective pass, Sections 1-5: the "landscape"
  // tile orientation (DesktopRoom/MobileLandscapeRoom) additionally
  // opts into a container-query-driven stacked mode once the stage's
  // own available geometry gets too narrow for useful side-by-side
  // video — see globals.css's own doc comment for the actual container
  // query (jsdom doesn't implement container queries, so this only
  // verifies the correct hook classes are present, not the resulting
  // layout at any particular size — that's a real-browser/real-device
  // concern). Portrait is untouched: mobile always stacks by deliberate
  // product decision, independent of geometry.
  it("marks the stage as a size query container, and only the landscape tile orientation opts its own tiles/divider into the geometry-driven stacking query", () => {
    const { rerender } = render(<SpeakerStage speakers={[]} orientation="portrait" {...baseProps} />);
    expect(screen.getByTestId("room-stage").className).toMatch(/\bstage-container\b/);
    expect(screen.getByTestId("speaker-divider").className).not.toMatch(/\bstage-divider-landscape\b/);

    rerender(<SpeakerStage speakers={[]} orientation="landscape" {...baseProps} />);
    expect(screen.getByTestId("room-stage").className).toMatch(/\bstage-container\b/);
    expect(screen.getByTestId("speaker-divider").className).toMatch(/\bstage-divider-landscape\b/);
  });

  it("renders no self-preview at all when there's no local video track — hidden entirely for an ordinary audience member, not an empty placeholder (issue #22)", () => {
    render(<SpeakerStage speakers={[]} orientation="portrait" {...baseProps} />);
    expect(screen.queryByTestId("self-preview")).not.toBeInTheDocument();
  });

  it("renders the real self-preview, anchored top-right, once a local video track is held (issue #22)", () => {
    render(<SpeakerStage speakers={[]} orientation="portrait" {...baseProps} localVideoTrack={fakeVideoTrack()} />);
    const slot = screen.getByTestId("self-preview");
    expect(slot).toBeInTheDocument();
    expect(slot.className).toMatch(/\btop-3\b/);
    expect(slot.className).not.toMatch(/\bbottom-3\b/);
  });

  describe("self-view corner slot: video vs. audio-only visualizer vs. nothing (media rendering bugfix pass, real-device report)", () => {
    const localIdentity = "profile:me";

    it("shows real video (not the visualizer) once the local participant's own camera publication is genuinely published and unmuted, even though localVideoTrack was already held pre-claim", () => {
      const participant = fakeParticipant({ camera: { track: {} as never, isMuted: false } });
      render(
        <SpeakerStage
          speakers={[]}
          orientation="portrait"
          {...baseProps}
          myIdentity={localIdentity}
          getParticipant={() => participant}
          localVideoTrack={fakeVideoTrack()}
        />,
      );
      expect(screen.getByTestId("self-preview")).toBeInTheDocument();
      expect(screen.queryByTestId("self-preview-audio-only")).not.toBeInTheDocument();
    });

    it("still shows self-preview from the raw prepared localVideoTrack before anything is published — the pre-claim candidate self-preview (issue #22) is unaffected", () => {
      // No camera publication exists at all yet (participant undefined,
      // as an unconnected/unclaimed candidate's own identity would look
      // up) — only the raw prepared track is held.
      render(
        <SpeakerStage
          speakers={[]}
          orientation="portrait"
          {...baseProps}
          myIdentity={localIdentity}
          getParticipant={() => undefined}
          localVideoTrack={fakeVideoTrack()}
        />,
      );
      expect(screen.getByTestId("self-preview")).toBeInTheDocument();
    });

    it("shows the audio-only visualizer instead of a dead localVideoTrack once the camera publication authoritatively reports muted (camera toggled off post-claim)", () => {
      const participant = fakeParticipant({
        camera: { track: {} as never, isMuted: true },
        microphone: { track: {} as never, isMuted: false },
      });
      render(
        <SpeakerStage
          speakers={[]}
          orientation="portrait"
          {...baseProps}
          myIdentity={localIdentity}
          getParticipant={() => participant}
          // A stale/already-held localVideoTrack must not win once the
          // publication itself says the camera is authoritatively off —
          // see this component's own doc comment on why the publication,
          // not localVideoTrack, is the source of truth once published.
          localVideoTrack={fakeVideoTrack()}
        />,
      );
      expect(screen.queryByTestId("self-preview")).not.toBeInTheDocument();
      expect(screen.getByTestId("self-preview-audio-only")).toBeInTheDocument();
    });

    it("renders nothing in the corner slot once camera is published-muted and mic has no live publication either", () => {
      const participant = fakeParticipant({ camera: { track: {} as never, isMuted: true } });
      render(
        <SpeakerStage
          speakers={[]}
          orientation="portrait"
          {...baseProps}
          myIdentity={localIdentity}
          getParticipant={() => participant}
          localVideoTrack={fakeVideoTrack()}
        />,
      );
      expect(screen.queryByTestId("self-preview")).not.toBeInTheDocument();
      expect(screen.queryByTestId("self-preview-audio-only")).not.toBeInTheDocument();
    });

    it("never shows the audio-only visualizer before the camera has ever been published — no premature fallback for an ordinary pre-claim candidate", () => {
      render(
        <SpeakerStage
          speakers={[]}
          orientation="portrait"
          {...baseProps}
          myIdentity={localIdentity}
          getParticipant={() => undefined}
          localVideoTrack={null}
        />,
      );
      expect(screen.queryByTestId("self-preview-audio-only")).not.toBeInTheDocument();
    });
  });

  it("establishes the scrim, invisible and inert by default so it never blocks a tap on a tile underneath", () => {
    render(<SpeakerStage speakers={[]} orientation="portrait" {...baseProps} />);
    const scrim = screen.getByTestId("room-scrim");
    expect(scrim).toBeInTheDocument();
    expect(scrim.style.opacity).toBe("0");
    expect(scrim.className).toMatch(/\bpointer-events-none\b/);
  });

  describe("scrim opacity (issue #21, driven by MobileLandscapeRoom/PortraitRoom's Comments Mode)", () => {
    it("renders whatever opacity the caller passes", () => {
      render(<SpeakerStage speakers={[]} orientation="portrait" {...baseProps} scrimOpacity={0.4} />);
      expect(screen.getByTestId("room-scrim").style.opacity).toBe("0.4");
    });

    it("includes the settle transition by default, omits it only when the caller marks a live drag frame as instant", () => {
      const { rerender } = render(<SpeakerStage speakers={[]} orientation="portrait" {...baseProps} scrimOpacity={0.3} />);
      expect(screen.getByTestId("room-scrim").className).toMatch(/\btransition-opacity\b/);

      rerender(<SpeakerStage speakers={[]} orientation="portrait" {...baseProps} scrimOpacity={0.3} scrimInstant />);
      expect(screen.getByTestId("room-scrim").className).not.toMatch(/\btransition-opacity\b/);
    });
  });

  describe("layering (real-device fix: the divider was bleeding across chat/controls)", () => {
    it("gives the stage its own contained stacking context (z-0, not just relative) so nothing inside it can escape to paint over a sibling overlay", () => {
      render(<SpeakerStage speakers={[]} orientation="portrait" {...baseProps} />);
      expect(screen.getByTestId("room-stage").className).toMatch(/\bz-0\b/);
    });

    it("the divider carries no z-index of its own — it doesn't overlap the tiles, and the stage's own containment is what keeps it from crossing foreground UI, not a z-index race", () => {
      render(<SpeakerStage speakers={[]} orientation="portrait" {...baseProps} />);
      expect(screen.getByTestId("speaker-divider").className).not.toMatch(/\bz-\d/);
    });

    it("the divider's center dot/handle is not rendered — no user-facing function yet, and it was part of the visual clutter real-device testing flagged", () => {
      render(<SpeakerStage speakers={[]} orientation="portrait" {...baseProps} />);
      expect(screen.getByTestId("speaker-divider")).toBeEmptyDOMElement();
    });
  });

  describe("direct empty-seat join (issue #27)", () => {
    it("wires onTapEmptySeat into an empty tile's tap handler when the viewer isn't already speaking", () => {
      render(<SpeakerStage speakers={[]} orientation="portrait" {...baseProps} />);
      const [firstSeat] = screen.getAllByTestId("empty-seat");
      expect(firstSeat.tagName).toBe("BUTTON");

      fireEvent.click(firstSeat);
      expect(baseProps.onTapEmptySeat).toHaveBeenCalledTimes(1);
    });

    it("never offers the tap-to-join affordance on a viewer who already holds the other seat", () => {
      const onTapEmptySeat = vi.fn();
      render(
        <SpeakerStage
          speakers={[speaker({ seat_number: 1, profile_id: "p1" })]}
          orientation="portrait"
          {...baseProps}
          myIdentity="profile:p1"
          isSpeaker
          mySeatNumber={1}
          onTapEmptySeat={onTapEmptySeat}
        />,
      );
      const emptySeat = screen.getByTestId("empty-seat");
      expect(emptySeat.tagName).toBe("DIV");
      fireEvent.click(emptySeat);
      expect(onTapEmptySeat).not.toHaveBeenCalled();
    });
  });

  describe("established-stage empty seat is never tappable (issue #21, third corrective pass — no bypassing Request-to-Speak)", () => {
    it("stays a tappable direct-join CTA during initial stage formation (stageRound null — never established)", () => {
      render(<SpeakerStage speakers={[]} orientation="portrait" {...baseProps} stageRound={null} />);
      const [firstSeat] = screen.getAllByTestId("empty-seat");
      expect(firstSeat.tagName).toBe("BUTTON");
      expect(firstSeat).toHaveTextContent("Seat open");
    });

    it("stops being tappable, and reads 'Selecting next speaker…', once the stage is established and an eligible candidate exists (issue #21, fifth corrective pass)", () => {
      const onTapEmptySeat = vi.fn();
      render(
        <SpeakerStage
          speakers={[speaker({ seat_number: 1 })]}
          orientation="portrait"
          {...baseProps}
          onTapEmptySeat={onTapEmptySeat}
          stageRound={stageRoundFixture({ phase: "awaiting_pairing", round_number: 3 })}
          pendingRequests={[pendingRequest()]}
        />,
      );
      const emptySeat = screen.getByTestId("empty-seat");
      expect(emptySeat.tagName).toBe("DIV");
      expect(emptySeat).toHaveTextContent("Selecting next speaker…");
      fireEvent.click(emptySeat);
      expect(onTapEmptySeat).not.toHaveBeenCalled();
    });

    it("advances to 'Joining…' — never stays on 'Selecting next speaker…' — once a candidate is actually reserved for this seat (issue #21, sixth corrective pass, Section 14)", () => {
      const onTapEmptySeat = vi.fn();
      render(
        <SpeakerStage
          speakers={[speaker({ seat_number: 1 })]}
          orientation="portrait"
          {...baseProps}
          onTapEmptySeat={onTapEmptySeat}
          stageRound={stageRoundFixture({ phase: "awaiting_pairing", round_number: 3 })}
          pendingRequests={[pendingRequest({ is_current_candidate: true, reserved_seat_number: 2 })]}
        />,
      );
      const emptySeat = screen.getByTestId("empty-seat");
      expect(emptySeat.tagName).toBe("DIV");
      expect(emptySeat).toHaveTextContent("Joining…");
      expect(emptySeat).not.toHaveTextContent("Selecting next speaker…");
      fireEvent.click(emptySeat);
      expect(onTapEmptySeat).not.toHaveBeenCalled();
    });

    it("still reads 'Selecting next speaker…' for a seat with no reservation of its own, even while the *other* seat already has a reserved candidate", () => {
      render(
        <SpeakerStage
          speakers={[]}
          orientation="portrait"
          {...baseProps}
          stageRound={stageRoundFixture({ phase: "awaiting_pairing", round_number: 3 })}
          pendingRequests={[
            pendingRequest({ id: "r1", is_current_candidate: true, reserved_seat_number: 1 }),
          ]}
        />,
      );
      const seats = screen.getAllByTestId("empty-seat");
      // Seat 1 has its own reservation; seat 2 doesn't yet — each seat's
      // own label reflects its own reservation state, never the other
      // seat's.
      expect(seats.some((s) => s.textContent?.includes("Joining…"))).toBe(true);
      expect(seats.some((s) => s.textContent?.includes("Selecting next speaker…"))).toBe(true);
    });

    it("shows 'Waiting for speaker requests…' — never 'Selecting…' — when the stage is established, one seat is empty, and nobody is currently eligible (issue #21, fifth corrective pass, Section 2)", () => {
      render(
        <SpeakerStage
          speakers={[speaker({ seat_number: 1 })]}
          orientation="portrait"
          {...baseProps}
          stageRound={stageRoundFixture({ phase: "awaiting_pairing", round_number: 3 })}
          pendingRequests={[]}
        />,
      );
      const emptySeat = screen.getByTestId("empty-seat");
      expect(emptySeat.tagName).toBe("DIV");
      expect(emptySeat).toHaveTextContent("Waiting for speaker requests…");
      expect(emptySeat).not.toHaveTextContent("Selecting next speaker…");
    });

    it("never visually promotes the open seat (order-first) once established — that priority was for a genuinely tappable opportunity", () => {
      render(
        <SpeakerStage
          speakers={[speaker({ seat_number: 1 })]}
          orientation="portrait"
          {...baseProps}
          stageRound={stageRoundFixture({ round_number: 2 })}
        />,
      );
      const emptySeat = screen.getByTestId("empty-seat");
      expect(emptySeat.closest('[class*="min-h-0"]')?.className).not.toMatch(/\border-first\b/);
    });

    it("a round that never went active (round_number 0, still awaiting its first pairing) does not count as established", () => {
      render(<SpeakerStage speakers={[]} orientation="portrait" {...baseProps} stageRound={stageRoundFixture({ phase: "awaiting_pairing", round_number: 0 })} />);
      const [firstSeat] = screen.getAllByTestId("empty-seat");
      expect(firstSeat.tagName).toBe("BUTTON");
    });
  });

  describe("small-room fallback display (issue #21, fifth corrective pass, Sections 8-15)", () => {
    const established = stageRoundFixture({ phase: "awaiting_pairing", round_number: 4 });
    const viewerProfile: Identity = { type: "profile", id: "viewer-1", displayName: "Viewer", username: null };

    it("both seats empty + zero eligible requests: shows a tappable 'Stage open' CTA (Section 8, Case C)", () => {
      const onTapEmptySeat = vi.fn();
      render(
        <SpeakerStage
          speakers={[]}
          orientation="portrait"
          {...baseProps}
          onTapEmptySeat={onTapEmptySeat}
          stageRound={established}
          pendingRequests={[]}
          viewerIdentity={viewerProfile}
        />,
      );
      for (const seat of screen.getAllByTestId("empty-seat")) {
        expect(seat.tagName).toBe("BUTTON");
        expect(seat).toHaveTextContent("Stage open");
      }
      fireEvent.click(screen.getAllByTestId("empty-seat")[0]);
      expect(onTapEmptySeat).toHaveBeenCalledTimes(1);
    });

    it("one seat occupied + zero requests: fallback does NOT activate — stays 'Waiting for speaker requests…' (Section 9, Case A)", () => {
      render(
        <SpeakerStage
          speakers={[speaker({ seat_number: 1 })]}
          orientation="portrait"
          {...baseProps}
          stageRound={established}
          pendingRequests={[]}
          viewerIdentity={viewerProfile}
        />,
      );
      const emptySeat = screen.getByTestId("empty-seat");
      expect(emptySeat.tagName).toBe("DIV");
      expect(emptySeat).toHaveTextContent("Waiting for speaker requests…");
    });

    it("both seats empty + an eligible request exists: fallback does NOT activate — Request-to-Speak still governs (Section 9, Case B)", () => {
      render(
        <SpeakerStage
          speakers={[]}
          orientation="portrait"
          {...baseProps}
          stageRound={established}
          pendingRequests={[pendingRequest()]}
          viewerIdentity={viewerProfile}
        />,
      );
      for (const seat of screen.getAllByTestId("empty-seat")) {
        expect(seat.tagName).toBe("DIV");
        expect(seat).toHaveTextContent("Selecting next speaker…");
      }
    });

    it("a recently-removed speaker is excluded from the fallback CTA — non-interactive instead of tappable (Section 10)", () => {
      const excludedRound: StageRound = {
        ...established,
        fallback_excluded_profile_ids: [viewerProfile.id],
        fallback_excluded_guest_ids: [],
      };
      render(
        <SpeakerStage
          speakers={[]}
          orientation="portrait"
          {...baseProps}
          stageRound={excludedRound}
          pendingRequests={[]}
          viewerIdentity={viewerProfile}
        />,
      );
      for (const seat of screen.getAllByTestId("empty-seat")) {
        expect(seat.tagName).toBe("DIV");
        expect(seat).not.toHaveTextContent("Stage open");
      }
    });

    it("a viewer NOT in the exclusion list can still see the tappable fallback CTA even while others are excluded", () => {
      const excludedRound: StageRound = {
        ...established,
        fallback_excluded_profile_ids: ["someone-else"],
        fallback_excluded_guest_ids: [],
      };
      render(
        <SpeakerStage
          speakers={[]}
          orientation="portrait"
          {...baseProps}
          stageRound={excludedRound}
          pendingRequests={[]}
          viewerIdentity={viewerProfile}
        />,
      );
      const [firstSeat] = screen.getAllByTestId("empty-seat");
      expect(firstSeat.tagName).toBe("BUTTON");
      expect(firstSeat).toHaveTextContent("Stage open");
    });

    it("without a viewerIdentity prop, the exclusion check is simply skipped (defensive default — never crashes, never falsely grants fallback either without the DB's own authoritative check)", () => {
      render(
        <SpeakerStage
          speakers={[]}
          orientation="portrait"
          {...baseProps}
          stageRound={established}
          pendingRequests={[]}
        />,
      );
      // No viewerIdentity means amIExcludedFromFallback can't be computed
      // as true, so this defaults to showing the fallback CTA — the real
      // authority is always claim_speaker_seat itself (migration
      // 00000000000033), never this display-only computation.
      const [firstSeat] = screen.getAllByTestId("empty-seat");
      expect(firstSeat.tagName).toBe("BUTTON");
    });
  });

  describe("open-seat visual priority (real-device finding: keeps the tappable seat out of the bottom overlay's territory)", () => {
    it("visually promotes the open seat to the front when exactly one seat is empty and the viewer can actually tap it", () => {
      render(<SpeakerStage speakers={[speaker({ seat_number: 1 })]} orientation="portrait" {...baseProps} />);
      const emptySeat = screen.getByTestId("empty-seat");
      expect(emptySeat.parentElement?.className).toMatch(/\border-first\b/);
    });

    it("does not reorder when both seats are empty — no single actionable seat to prioritize over the other", () => {
      render(<SpeakerStage speakers={[]} orientation="portrait" {...baseProps} />);
      for (const seat of screen.getAllByTestId("empty-seat")) {
        expect(seat.parentElement?.className).not.toMatch(/\border-first\b/);
      }
    });

    it("does not reorder when both seats are occupied", () => {
      render(
        <SpeakerStage
          speakers={[
            speaker({ id: "s1", seat_number: 1, profile_id: "p1" }),
            speaker({ id: "s2", seat_number: 2, profile_id: "p2" }),
          ]}
          orientation="portrait"
          {...baseProps}
        />,
      );
      expect(screen.queryByTestId("empty-seat")).not.toBeInTheDocument();
      const tiles = screen.getAllByTestId("speaker-tile");
      for (const tile of tiles) {
        expect(tile.parentElement?.className).not.toMatch(/\border-first\b/);
      }
    });

    it("does not reorder the remaining open seat from the active speaker's own view — nothing there is actionable for them", () => {
      render(
        <SpeakerStage
          speakers={[speaker({ seat_number: 1, profile_id: "p1" })]}
          orientation="portrait"
          {...baseProps}
          myIdentity="profile:p1"
          isSpeaker
          mySeatNumber={1}
        />,
      );
      const emptySeat = screen.getByTestId("empty-seat");
      expect(emptySeat.parentElement?.className).not.toMatch(/\border-first\b/);
    });

    it("also applies in landscape (shared component, same rule) — order-first shifts it to the leading side-by-side position", () => {
      render(<SpeakerStage speakers={[speaker({ seat_number: 2 })]} orientation="landscape" {...baseProps} />);
      const emptySeat = screen.getByTestId("empty-seat");
      expect(emptySeat.parentElement?.className).toMatch(/\border-first\b/);
    });
  });

  describe("soloMode (issue #18, Speaker View Phase 1 — full-bleed remote speaker)", () => {
    it("renders only the other seat's tile, no divider, when the viewer holds a seat", () => {
      render(
        <SpeakerStage
          speakers={[
            speaker({ id: "s1", seat_number: 1, profile_id: "p1" }),
            speaker({ id: "s2", seat_number: 2, profile_id: "p2" }),
          ]}
          orientation="portrait"
          {...baseProps}
          myIdentity="profile:p1"
          isSpeaker
          mySeatNumber={1}
          soloMode
        />,
      );
      expect(screen.queryByTestId("speaker-divider")).not.toBeInTheDocument();
      const tiles = screen.getAllByTestId("speaker-tile");
      expect(tiles).toHaveLength(1);
    });

    it("renders the ordinary two-tile layout (with divider) when soloMode is false, same speakers", () => {
      render(
        <SpeakerStage
          speakers={[
            speaker({ id: "s1", seat_number: 1, profile_id: "p1" }),
            speaker({ id: "s2", seat_number: 2, profile_id: "p2" }),
          ]}
          orientation="portrait"
          {...baseProps}
          myIdentity="profile:p1"
          isSpeaker
          mySeatNumber={1}
        />,
      );
      expect(screen.getByTestId("speaker-divider")).toBeInTheDocument();
      expect(screen.getAllByTestId("speaker-tile")).toHaveLength(2);
    });

    it("shows the ordinary empty-seat placeholder, full-size, when the other seat is empty — no separate 'waiting' UI", () => {
      render(
        <SpeakerStage
          speakers={[speaker({ id: "s1", seat_number: 1, profile_id: "p1" })]}
          orientation="portrait"
          {...baseProps}
          myIdentity="profile:p1"
          isSpeaker
          mySeatNumber={1}
          soloMode
        />,
      );
      expect(screen.queryByTestId("speaker-divider")).not.toBeInTheDocument();
      expect(screen.getByTestId("empty-seat")).toBeInTheDocument();
      expect(screen.queryByTestId("speaker-tile")).not.toBeInTheDocument();
    });

    it("the empty other seat is not offered as tappable to the seated viewer themselves — same rule soloMode inherits unchanged from the ordinary layout", () => {
      const onTapEmptySeat = vi.fn();
      render(
        <SpeakerStage
          speakers={[speaker({ id: "s1", seat_number: 1, profile_id: "p1" })]}
          orientation="portrait"
          {...baseProps}
          myIdentity="profile:p1"
          isSpeaker
          mySeatNumber={1}
          onTapEmptySeat={onTapEmptySeat}
          soloMode
        />,
      );
      const emptySeat = screen.getByTestId("empty-seat");
      expect(emptySeat.tagName).toBe("DIV");
      fireEvent.click(emptySeat);
      expect(onTapEmptySeat).not.toHaveBeenCalled();
    });

    it("required test (issue #18 real-device finding): repeatedly tapping the large empty remote seat while seated never invokes onTapEmptySeat and never brings back the divider/local tile", () => {
      const onTapEmptySeat = vi.fn();
      render(
        <SpeakerStage
          speakers={[speaker({ id: "s1", seat_number: 1, profile_id: "p1" })]}
          orientation="portrait"
          {...baseProps}
          myIdentity="profile:p1"
          isSpeaker
          mySeatNumber={1}
          onTapEmptySeat={onTapEmptySeat}
          soloMode
        />,
      );
      const emptySeat = screen.getByTestId("empty-seat");
      for (let i = 0; i < 10; i++) {
        fireEvent.click(emptySeat);
      }
      expect(onTapEmptySeat).not.toHaveBeenCalled();
      // Still solo, still full-bleed — no divider, no second (local) tile
      // ever appeared as a result of any of those taps.
      expect(screen.queryByTestId("speaker-divider")).not.toBeInTheDocument();
      expect(screen.queryByTestId("speaker-tile")).not.toBeInTheDocument();
      expect(screen.getByTestId("empty-seat")).toBeInTheDocument();
    });

    it("still renders the self-preview corner slot in soloMode when a local video track is held", () => {
      render(
        <SpeakerStage
          speakers={[
            speaker({ id: "s1", seat_number: 1, profile_id: "p1" }),
            speaker({ id: "s2", seat_number: 2, profile_id: "p2" }),
          ]}
          orientation="portrait"
          {...baseProps}
          myIdentity="profile:p1"
          isSpeaker
          mySeatNumber={1}
          localVideoTrack={fakeVideoTrack()}
          soloMode
        />,
      );
      expect(screen.getByTestId("self-preview")).toBeInTheDocument();
    });

    it("falls back to the ordinary two-tile layout if soloMode is true but mySeatNumber is null (defensive — should not happen in practice, see the consistency describe block below for the dev-mode assertion this also now triggers)", () => {
      render(
        <SpeakerStage
          speakers={[speaker({ id: "s1", seat_number: 1, profile_id: "someone-else" })]}
          orientation="portrait"
          {...baseProps}
          myIdentity="profile:not-a-speaker"
          soloMode
        />,
      );
      expect(screen.getByTestId("speaker-divider")).toBeInTheDocument();
    });

    describe("local-seat permutation symmetry (real-device report, issue #18: 'claiming seat 1 works, claiming seat 2 doesn't') — every case run for BOTH permutations, not just seat 1", () => {
      it.each([
        { mine: 1 as const, other: 2 as const },
        { mine: 2 as const, other: 1 as const },
      ])("viewer owns seat $mine, remote seat $other empty → only the empty seat $other's tile renders, no divider, no local tile", ({ mine }) => {
        render(
          <SpeakerStage
            speakers={[speaker({ id: `s${mine}`, seat_number: mine, profile_id: "me" })]}
            orientation="portrait"
            {...baseProps}
            myIdentity="profile:me"
            isSpeaker
            mySeatNumber={mine}
            soloMode
          />,
        );
        expect(screen.queryByTestId("speaker-divider")).not.toBeInTheDocument();
        expect(screen.queryByTestId("speaker-tile")).not.toBeInTheDocument();
        const emptySeat = screen.getByTestId("empty-seat");
        expect(emptySeat).toBeInTheDocument();
        expect(emptySeat.tagName).toBe("DIV");
      });

      it.each([
        { mine: 1 as const, other: 2 as const },
        { mine: 2 as const, other: 1 as const },
      ])("viewer owns seat $mine, remote seat $other occupied → only seat $other's tile renders full-bleed, no divider, no local tile", ({ mine, other }) => {
        render(
          <SpeakerStage
            speakers={[
              speaker({ id: `s${mine}`, seat_number: mine, profile_id: "me" }),
              speaker({ id: `s${other}`, seat_number: other, profile_id: "remote" }),
            ]}
            orientation="portrait"
            {...baseProps}
            myIdentity="profile:me"
            isSpeaker
            mySeatNumber={mine}
            soloMode
          />,
        );
        expect(screen.queryByTestId("speaker-divider")).not.toBeInTheDocument();
        expect(screen.getAllByTestId("speaker-tile")).toHaveLength(1);
        expect(screen.queryByTestId("empty-seat")).not.toBeInTheDocument();
      });

      it.each([
        { mine: 1 as const, other: 2 as const },
        { mine: 2 as const, other: 1 as const },
      ])("viewer owns seat $mine → the remote empty seat $other is never tappable by the viewer themselves, repeated taps included", ({ mine }) => {
        const onTapEmptySeat = vi.fn();
        render(
          <SpeakerStage
            speakers={[speaker({ id: `s${mine}`, seat_number: mine, profile_id: "me" })]}
            orientation="portrait"
            {...baseProps}
            myIdentity="profile:me"
            isSpeaker
            mySeatNumber={mine}
            onTapEmptySeat={onTapEmptySeat}
            soloMode
          />,
        );
        const emptySeat = screen.getByTestId("empty-seat");
        for (let i = 0; i < 5; i++) fireEvent.click(emptySeat);
        expect(onTapEmptySeat).not.toHaveBeenCalled();
        expect(screen.queryByTestId("speaker-divider")).not.toBeInTheDocument();
      });

      it.each([1 as const, 2 as const])(
        "viewer owns seat %i → self-preview still renders when a local video track is held",
        (mine) => {
          render(
            <SpeakerStage
              speakers={[speaker({ id: `s${mine}`, seat_number: mine, profile_id: "me" })]}
              orientation="portrait"
              {...baseProps}
              myIdentity="profile:me"
              isSpeaker
              mySeatNumber={mine}
              localVideoTrack={fakeVideoTrack()}
              soloMode
            />,
          );
          expect(screen.getByTestId("self-preview")).toBeInTheDocument();
        },
      );
    });
  });

  describe("isSpeaker/mySeatNumber consistency (issue #18 fix — received as props, never re-derived)", () => {
    it("trusts the isSpeaker/mySeatNumber props directly, even when speakers/myIdentity alone wouldn't imply them — proves there's no independent re-derivation left inside this component", () => {
      render(
        <SpeakerStage
          speakers={[]}
          orientation="portrait"
          {...baseProps}
          myIdentity="profile:someone-else"
          isSpeaker
          mySeatNumber={1}
          soloMode
        />,
      );
      // soloMode + mySeatNumber=1 renders seat 2's tile (the "other" seat)
      // full-bleed, purely from the props — nothing here comes from
      // matching speakers/myIdentity, since speakers is empty.
      expect(screen.queryByTestId("speaker-divider")).not.toBeInTheDocument();
      expect(screen.getByTestId("empty-seat")).toBeInTheDocument();
    });

    it("dev-mode: logs an error when soloMode=true but isSpeaker=false — the caller contract is violated", () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      render(<SpeakerStage speakers={[]} orientation="portrait" {...baseProps} soloMode isSpeaker={false} />);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("soloMode=true but isSpeaker=false"));
    });

    it("dev-mode: does not log when soloMode=true and isSpeaker=true (the expected, well-formed case)", () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      render(
        <SpeakerStage
          speakers={[speaker({ seat_number: 1, profile_id: "p1" })]}
          orientation="portrait"
          {...baseProps}
          myIdentity="profile:p1"
          isSpeaker
          mySeatNumber={1}
          soloMode
        />,
      );
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it("dev-mode: does not log when soloMode is false, regardless of isSpeaker", () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      render(<SpeakerStage speakers={[]} orientation="portrait" {...baseProps} isSpeaker={false} />);
      render(
        <SpeakerStage
          speakers={[speaker({ seat_number: 1, profile_id: "p1" })]}
          orientation="portrait"
          {...baseProps}
          myIdentity="profile:p1"
          isSpeaker
          mySeatNumber={1}
        />,
      );
      expect(errorSpy).not.toHaveBeenCalled();
    });
  });

  describe("simulatedGuestIds (Session Simulator real-device follow-up)", () => {
    it("marks only the seat whose guest_id is in the set as simulated", () => {
      render(
        <SpeakerStage
          speakers={[
            speaker({ id: "s1", seat_number: 1, profile_id: null, guest_id: "sim-guest-1" }),
            speaker({ id: "s2", seat_number: 2, profile_id: null, guest_id: "real-guest-2" }),
          ]}
          orientation="portrait"
          {...baseProps}
          simulatedGuestIds={new Set(["sim-guest-1"])}
        />,
      );
      expect(screen.getAllByTestId("simulated-speaker-placeholder")).toHaveLength(1);
      expect(screen.getAllByTestId("no-video-placeholder")).toHaveLength(1);
    });

    it("marks no seat as simulated when the set is omitted (every existing caller unaffected)", () => {
      render(
        <SpeakerStage
          speakers={[speaker({ id: "s1", seat_number: 1, profile_id: null, guest_id: "some-guest" })]}
          orientation="portrait"
          {...baseProps}
        />,
      );
      expect(screen.queryByTestId("simulated-speaker-placeholder")).not.toBeInTheDocument();
      expect(screen.getByTestId("no-video-placeholder")).toBeInTheDocument();
    });

    it("never marks a real profile-held seat as simulated, even if its id happened to appear in the set", () => {
      render(
        <SpeakerStage
          speakers={[speaker({ id: "s1", seat_number: 1, profile_id: "p1", guest_id: null })]}
          orientation="portrait"
          {...baseProps}
          simulatedGuestIds={new Set(["p1"])}
        />,
      );
      expect(screen.queryByTestId("simulated-speaker-placeholder")).not.toBeInTheDocument();
      expect(screen.getByTestId("no-video-placeholder")).toBeInTheDocument();
    });
  });

  describe("inactivity grace period (real-device finding)", () => {
    it("passes isInactive through to the matching seat's tile only", () => {
      render(
        <SpeakerStage
          speakers={[
            speaker({ id: "s1", seat_number: 1, profile_id: "p1" }),
            speaker({ id: "s2", seat_number: 2, profile_id: "p2" }),
          ]}
          orientation="portrait"
          {...baseProps}
          reconnectingIdentities={new Set(["profile:p2"])}
        />,
      );
      expect(screen.getByTestId("speaker-inactive")).toBeInTheDocument();
      // Only one tile should show it — the other seat's occupant isn't in the set.
      expect(screen.getAllByTestId("speaker-inactive")).toHaveLength(1);
    });

    it("shows nothing special when the reconnecting set is empty", () => {
      render(
        <SpeakerStage
          speakers={[speaker({ seat_number: 1, profile_id: "p1" })]}
          orientation="portrait"
          {...baseProps}
        />,
      );
      expect(screen.queryByTestId("speaker-inactive")).not.toBeInTheDocument();
    });
  });

  describe("hard invariant: renderSolo=true structurally cannot render the two-tile subtree (issue #18 real-device finding, 2026-08-26)", () => {
    it("renders exactly one speaker-tile and no divider when renderSolo is true (soloMode + a resolved own seat)", () => {
      render(
        <SpeakerStage
          speakers={[
            speaker({ id: "s1", seat_number: 1, profile_id: "p1" }),
            speaker({ id: "s2", seat_number: 2, profile_id: "p2" }),
          ]}
          orientation="portrait"
          {...baseProps}
          isSpeaker={true}
          mySeatNumber={1}
          soloMode
        />,
      );
      expect(screen.getAllByTestId("speaker-tile")).toHaveLength(1);
      expect(screen.queryByTestId("speaker-divider")).not.toBeInTheDocument();
    });

    it("renders exactly two speaker-tile wrappers and a divider when renderSolo is false (ordinary two-tile layout)", () => {
      render(
        <SpeakerStage
          speakers={[
            speaker({ id: "s1", seat_number: 1, profile_id: "p1" }),
            speaker({ id: "s2", seat_number: 2, profile_id: "p2" }),
          ]}
          orientation="portrait"
          {...baseProps}
          isSpeaker={false}
          mySeatNumber={null}
          soloMode={false}
        />,
      );
      expect(screen.getAllByTestId("speaker-tile")).toHaveLength(2);
      expect(screen.getByTestId("speaker-divider")).toBeInTheDocument();
    });
  });

  describe("tap-center-timer speaker swap (pre-launch interaction pass, Section 7): purely local visual ordering, never authoritative state", () => {
    const twoSpeakers = [
      speaker({ id: "s1", seat_number: 1, profile_id: "alice", display_name: "Alice" }),
      speaker({ id: "s2", seat_number: 2, profile_id: "bob", display_name: "Bob" }),
    ];

    it("the timer is a plain, non-interactive badge when only one seat is occupied — no meaningless swap for a single speaker", () => {
      render(
        <SpeakerStage
          speakers={[speaker({ id: "s1", seat_number: 1, profile_id: "alice" })]}
          orientation="portrait"
          {...baseProps}
          stageRound={stageRoundFixture()}
          isPreviewBuild
        />,
      );
      const timer = screen.getByTestId("stage-round-timer");
      expect(timer.tagName).toBe("DIV");
    });

    it("the timer is a plain, non-interactive badge in landscape (side-by-side — no top/bottom relationship to swap), even with both seats occupied", () => {
      render(
        <SpeakerStage
          speakers={twoSpeakers}
          orientation="landscape"
          {...baseProps}
          stageRound={stageRoundFixture()}
          isPreviewBuild
        />,
      );
      const timer = screen.getByTestId("stage-round-timer");
      expect(timer.tagName).toBe("DIV");
    });

    it("becomes a real, tappable button in portrait once both seats are occupied", () => {
      render(
        <SpeakerStage
          speakers={twoSpeakers}
          orientation="portrait"
          {...baseProps}
          stageRound={stageRoundFixture()}
          isPreviewBuild
        />,
      );
      const timer = screen.getByTestId("stage-round-timer");
      expect(timer.tagName).toBe("BUTTON");
      expect(timer).toHaveAccessibleName(/tap to swap/i);
    });

    it("still shows the same authoritative round text whether or not it's tappable", () => {
      render(
        <SpeakerStage
          speakers={twoSpeakers}
          orientation="portrait"
          {...baseProps}
          stageRound={stageRoundFixture({ round_number: 3 })}
          isPreviewBuild
        />,
      );
      expect(screen.getByTestId("stage-round-timer")).toHaveTextContent("Round 3");
    });

    it("one tap visually swaps which seat's tile renders first (top); a second tap restores the original order", () => {
      render(
        <SpeakerStage
          speakers={twoSpeakers}
          orientation="portrait"
          {...baseProps}
          stageRound={stageRoundFixture()}
          isPreviewBuild
        />,
      );
      const tiles = () => screen.getAllByTestId("speaker-tile");
      expect(tiles()[0]).toHaveTextContent("Alice");
      expect(tiles()[1]).toHaveTextContent("Bob");

      fireEvent.click(screen.getByTestId("stage-round-timer"));
      expect(tiles()[0]).toHaveTextContent("Bob");
      expect(tiles()[1]).toHaveTextContent("Alice");

      fireEvent.click(screen.getByTestId("stage-round-timer"));
      expect(tiles()[0]).toHaveTextContent("Alice");
      expect(tiles()[1]).toHaveTextContent("Bob");
    });

    it("swapping never changes the authoritative seat identity a double-tap reaction targets — it still follows the person, not the visual slot", () => {
      const send = vi.fn(async () => ({ ok: true as const, heatAfter: 0, inCooldownAfter: false }));
      const stageReactions = { ...MOCK_STAGE_REACTIONS_BASE, send };
      render(
        <SpeakerStage
          speakers={twoSpeakers}
          orientation="portrait"
          {...baseProps}
          stageRound={stageRoundFixture()}
          isPreviewBuild
          stageReactions={stageReactions}
        />,
      );

      // Swap so Bob now renders first (top).
      fireEvent.click(screen.getByTestId("stage-round-timer"));
      const topTile = screen.getAllByTestId("speaker-tile")[0];
      expect(topTile).toHaveTextContent("Bob");

      // Double-tap the now-top tile (visually Bob's position) — the
      // reaction must still target Bob's own authoritative identity,
      // derived from seat_number/profile_id, never "whichever tile is
      // first in the DOM right now."
      const rect = { left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100 } as DOMRect;
      vi.spyOn(topTile, "getBoundingClientRect").mockReturnValue(rect);
      fireEvent.pointerUp(topTile, { clientX: 50, clientY: 50 });
      fireEvent.pointerUp(topTile, { clientX: 50, clientY: 50 });

      expect(send).toHaveBeenCalledWith("profile:bob", expect.any(String), expect.any(Number), expect.any(Number));
    });

    it("swapping does not remount either tile — the same speaker-tile DOM node is reused, just repositioned (no fresh media attach/stale-preview regression)", () => {
      render(
        <SpeakerStage
          speakers={twoSpeakers}
          orientation="portrait"
          {...baseProps}
          stageRound={stageRoundFixture()}
          isPreviewBuild
        />,
      );
      const aliceTileBefore = screen.getAllByTestId("speaker-tile").find((el) => el.textContent?.includes("Alice"));
      fireEvent.click(screen.getByTestId("stage-round-timer"));
      const aliceTileAfter = screen.getAllByTestId("speaker-tile").find((el) => el.textContent?.includes("Alice"));
      expect(aliceTileAfter).toBe(aliceTileBefore);
    });

    it("respects prefers-reduced-motion — the reorder still happens, just without the FLIP transform animation", () => {
      vi.stubGlobal("matchMedia", (query: string) => ({
        matches: query.includes("prefers-reduced-motion"),
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }));
      render(
        <SpeakerStage
          speakers={twoSpeakers}
          orientation="portrait"
          {...baseProps}
          stageRound={stageRoundFixture()}
          isPreviewBuild
        />,
      );
      fireEvent.click(screen.getByTestId("stage-round-timer"));
      expect(screen.getAllByTestId("speaker-tile")[0]).toHaveTextContent("Bob");
      vi.unstubAllGlobals();
    });

    describe("Side mode: sender/others split + region follows local visual swap (real-device follow-up)", () => {
      function reactionsWith(overrides: Partial<typeof MOCK_STAGE_REACTIONS_BASE> = {}) {
        return { ...MOCK_STAGE_REACTIONS_BASE, displayMode: "side" as const, myIdentity: "profile:viewer", ...overrides };
      }

      it("On Speaker mode (default): a reaction from anyone renders on the targeted speaker's own tile", () => {
        const stageReactions = {
          ...MOCK_STAGE_REACTIONS_BASE,
          incoming: [
            { id: "r1", targetIdentity: "profile:alice", emoji: "🔥", x: 0.5, y: 0.5, senderIdentity: "profile:someone-random", ts: Date.now() },
          ],
        };
        render(
          <SpeakerStage speakers={twoSpeakers} orientation="portrait" {...baseProps} stageReactions={stageReactions} />,
        );
        const tiles = screen.getAllByTestId("speaker-tile");
        expect(tiles[0]).toHaveTextContent("🔥"); // Alice, first slot, unswapped
        expect(screen.queryByTestId("reaction-side-lane-top")).not.toBeInTheDocument();
        expect(screen.queryByTestId("reaction-side-lane-bottom")).not.toBeInTheDocument();
      });

      it("Side mode: another viewer's reaction to the speaker currently on top renders in the top region, not the bottom, and not on-speaker", () => {
        const stageReactions = reactionsWith({
          incoming: [
            { id: "r1", targetIdentity: "profile:alice", emoji: "🔥", x: 0.5, y: 0.5, senderIdentity: "profile:someone-else-entirely", ts: Date.now() },
          ],
        });
        render(
          <SpeakerStage speakers={twoSpeakers} orientation="portrait" {...baseProps} stageReactions={stageReactions} />,
        );
        expect(screen.getByTestId("reaction-side-lane-top")).toHaveTextContent("🔥");
        expect(screen.getByTestId("reaction-side-lane-bottom")).not.toHaveTextContent("🔥");
        expect(screen.getAllByTestId("speaker-tile").every((t) => !t.textContent?.includes("🔥"))).toBe(true);
      });

      it("Side mode: another viewer's reaction to the speaker currently on bottom renders in the bottom region", () => {
        const stageReactions = reactionsWith({
          incoming: [
            { id: "r1", targetIdentity: "profile:bob", emoji: "😂", x: 0.5, y: 0.5, senderIdentity: "profile:someone-else-entirely", ts: Date.now() },
          ],
        });
        render(
          <SpeakerStage speakers={twoSpeakers} orientation="portrait" {...baseProps} stageReactions={stageReactions} />,
        );
        expect(screen.getByTestId("reaction-side-lane-bottom")).toHaveTextContent("😂");
        expect(screen.getByTestId("reaction-side-lane-top")).not.toHaveTextContent("😂");
      });

      it("Side mode: MY OWN reaction renders on-speaker at my tap location, never in either side lane, never duplicated", () => {
        const stageReactions = reactionsWith({
          incoming: [
            { id: "r1", targetIdentity: "profile:alice", emoji: "❤️", x: 0.64, y: 0.31, senderIdentity: "profile:viewer", ts: Date.now() },
          ],
        });
        render(
          <SpeakerStage speakers={twoSpeakers} orientation="portrait" {...baseProps} stageReactions={stageReactions} />,
        );
        const hearts = screen.getAllByText("❤️");
        expect(hearts).toHaveLength(1); // exactly once, on-speaker — never also in a side lane
        const tiles = screen.getAllByTestId("speaker-tile");
        expect(tiles[0]).toHaveTextContent("❤️");
        expect(screen.getByTestId("reaction-side-lane-top")).not.toHaveTextContent("❤️");
        expect(screen.getByTestId("reaction-side-lane-bottom")).not.toHaveTextContent("❤️");
      });

      it("Side mode + local timer swap: an incoming reaction targeting Alice follows her to the bottom region once she's swapped there", () => {
        const stageReactions = reactionsWith({
          incoming: [
            { id: "r1", targetIdentity: "profile:alice", emoji: "🔥", x: 0.5, y: 0.5, senderIdentity: "profile:someone-else-entirely", ts: Date.now() },
          ],
        });
        render(
          <SpeakerStage speakers={twoSpeakers} orientation="portrait" {...baseProps} stageRound={stageRoundFixture()} isPreviewBuild stageReactions={stageReactions} />,
        );
        // Before swap: Alice is on top.
        expect(screen.getByTestId("reaction-side-lane-top")).toHaveTextContent("🔥");

        fireEvent.click(screen.getByTestId("stage-round-timer"));
        expect(screen.getAllByTestId("speaker-tile")[0]).toHaveTextContent("Bob"); // confirms the swap actually happened

        // After swap: same reaction, same authoritative target (Alice),
        // now follows her to the bottom region — never re-targeted to
        // "whichever seat is on top."
        expect(screen.getByTestId("reaction-side-lane-bottom")).toHaveTextContent("🔥");
        expect(screen.getByTestId("reaction-side-lane-top")).not.toHaveTextContent("🔥");
      });

      it("Hidden mode: neither my own reaction nor another viewer's renders anywhere — on-speaker or side", () => {
        const stageReactions = {
          ...MOCK_STAGE_REACTIONS_BASE,
          showReactions: false,
          displayMode: "side" as const,
          myIdentity: "profile:viewer",
          incoming: [
            { id: "r1", targetIdentity: "profile:alice", emoji: "🔥", x: 0.5, y: 0.5, senderIdentity: "profile:viewer", ts: Date.now() },
            { id: "r2", targetIdentity: "profile:bob", emoji: "😂", x: 0.5, y: 0.5, senderIdentity: "profile:someone-else-entirely", ts: Date.now() },
          ],
        };
        render(
          <SpeakerStage speakers={twoSpeakers} orientation="portrait" {...baseProps} stageReactions={stageReactions} />,
        );
        expect(screen.queryByText("🔥")).not.toBeInTheDocument();
        expect(screen.queryByText("😂")).not.toBeInTheDocument();
        expect(screen.queryByTestId("reaction-side-lane-top")).not.toBeInTheDocument();
        expect(screen.queryByTestId("reaction-side-lane-bottom")).not.toBeInTheDocument();
      });

      it("Hidden mode: sending remains possible even though nothing renders locally — double-tap still calls send()", () => {
        const send = vi.fn(async () => ({ ok: true as const, heatAfter: 0, inCooldownAfter: false }));
        const stageReactions = { ...MOCK_STAGE_REACTIONS_BASE, showReactions: false, myIdentity: "profile:viewer", send };
        render(
          <SpeakerStage speakers={twoSpeakers} orientation="portrait" {...baseProps} stageReactions={stageReactions} />,
        );
        const topTile = screen.getAllByTestId("speaker-tile")[0];
        const rect = { left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100 } as DOMRect;
        vi.spyOn(topTile, "getBoundingClientRect").mockReturnValue(rect);
        fireEvent.pointerUp(topTile, { clientX: 50, clientY: 50 });
        fireEvent.pointerUp(topTile, { clientX: 50, clientY: 50 });

        expect(send).toHaveBeenCalledWith("profile:alice", expect.any(String), expect.any(Number), expect.any(Number));
      });

      it("Landscape: keeps a single unsplit Side lane (unchanged scope), but still excludes the sender's own reaction", () => {
        const stageReactions = reactionsWith({
          incoming: [
            { id: "r1", targetIdentity: "profile:alice", emoji: "🔥", x: 0.5, y: 0.5, senderIdentity: "profile:someone-else-entirely", ts: Date.now() },
            { id: "r2", targetIdentity: "profile:bob", emoji: "❤️", x: 0.5, y: 0.5, senderIdentity: "profile:viewer", ts: Date.now() },
          ],
        });
        render(
          <SpeakerStage speakers={twoSpeakers} orientation="landscape" {...baseProps} stageReactions={stageReactions} />,
        );
        expect(screen.queryByTestId("reaction-side-lane-top")).not.toBeInTheDocument();
        expect(screen.queryByTestId("reaction-side-lane-bottom")).not.toBeInTheDocument();
        const lane = screen.getByTestId("reaction-side-lane");
        expect(lane).toHaveTextContent("🔥"); // someone else's, shown
        expect(lane).not.toHaveTextContent("❤️"); // mine, excluded — renders on-speaker instead
        expect(screen.getAllByTestId("speaker-tile")[1]).toHaveTextContent("❤️");
      });
    });
  });
});
