import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SpeakerStage } from "./speaker-stage";
import type { LocalVideoTrack } from "livekit-client";
import type { EventSpeaker } from "@/lib/repositories/event-speakers";
import type { StageRound } from "@/lib/repositories/stage-rounds";
import type { RankedPendingRequest } from "@/hooks/use-active-speaker-requests";
import type { Identity } from "@/lib/identity";
import type { MediaReadinessState } from "@/hooks/use-live-room-connection";

const MEDIA_READY: MediaReadinessState = { camera: { ready: true, error: null }, microphone: { ready: true, error: null } };

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
});
