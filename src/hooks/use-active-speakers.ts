"use client";

import { useCallback, useEffect, useRef, useState } from "react";
// Realtime subscription calls the Supabase client directly, same
// documented exception as useLobbyRealtime — see ARCHITECTURE.md's Vendor
// portability section.
import { createClient } from "@/lib/supabase/client";
import type { EventSpeaker } from "@/lib/repositories/event-speakers";
import { getRoomStatus, type RoomStatus } from "@/lib/room-status";

/**
 * Applies one `event_speakers` row (an INSERT for a new occupant, or an
 * UPDATE when someone's `left_at` gets set) to the current active-speaker
 * map, keyed by seat. A pure function, exported so the merge logic is
 * testable without a live Supabase Realtime connection — same reasoning
 * as `determineCanPublish` in lib/livekit/token.ts.
 */
export function applySpeakerChange(
  current: Record<number, EventSpeaker>,
  row: EventSpeaker,
): Record<number, EventSpeaker> {
  if (row.left_at !== null) {
    // Only remove if this is still the row we have for that seat — an
    // UPDATE for a since-superseded row must not clobber a newer
    // occupant already in state.
    if (current[row.seat_number]?.id !== row.id) return current;
    const next = { ...current };
    delete next[row.seat_number];
    return next;
  }
  return { ...current, [row.seat_number]: row };
}

/**
 * Removes one deleted event_speakers row from the seat map — only ever
 * reached by a hard delete; ordinary seat departure sets `left_at` via
 * UPDATE, already handled by `applySpeakerChange`. The Session
 * Simulator's Reset Session is the one real caller today (see migration
 * 00000000000023 for why `event_speakers` needed `REPLICA IDENTITY
 * FULL` — both for this DELETE's `event_id` filter to evaluate
 * correctly, and so `payload.old` carries `seat_number`, which isn't the
 * table's primary key). Same "don't clobber a newer occupant already in
 * state" guard `applySpeakerChange` uses for its own UPDATE case.
 */
export function removeSpeaker(current: Record<number, EventSpeaker>, deleted: EventSpeaker): Record<number, EventSpeaker> {
  if (current[deleted.seat_number]?.id !== deleted.id) return current;
  const next = { ...current };
  delete next[deleted.seat_number];
  return next;
}

function toBySeat(speakers: EventSpeaker[]): Record<number, EventSpeaker> {
  const map: Record<number, EventSpeaker> = {};
  for (const speaker of speakers) map[speaker.seat_number] = speaker;
  return map;
}

/** Whether a fresh authoritative read actually disagreed with what this hook already had — issue #21, sixteenth corrective pass, for `SpeakerSyncDiagnostics.lastReconcileResult`. Compared by seat-occupant id, the only two seats this product has. */
function seatsDiffer(a: Record<number, EventSpeaker>, b: Record<number, EventSpeaker>): boolean {
  return ([1, 2] as const).some((seatNumber) => a[seatNumber]?.id !== b[seatNumber]?.id);
}

/**
 * Issue #18 real-device finding (2026-08-27): a real-device retest
 * captured a seated speaker (self-preview live, LiveKit `canPublish`
 * granted, `getActiveSeatForIdentity` server-side correctly finding
 * their row) whose *client-side* `mySeatNumber`/`isSpeaker`/
 * `participantRole` had nonetheless settled on "audience" for the rest
 * of the session — provably wrong, since the same identity's own
 * `joinOpenSeat` attempt was rejected with "You're already speaking,"
 * meaning the server's authoritative `event_speakers_active` and this
 * hook's accumulated client-side state had genuinely diverged.
 *
 * Root cause: this hook previously only ever applied *incremental*
 * `postgres_changes` deltas on top of `initialSpeakers`, with no
 * reconciliation mechanism at all. Supabase Realtime's Postgres-CDC
 * subscriptions are not guaranteed to replay events missed during a
 * connection gap (a WebSocket drop and automatic reconnect — common on
 * mobile networks, exactly this project's primary real-device target) —
 * a single missed INSERT or UPDATE could silently leave this hook's
 * state wrong for the rest of the mounted session, with nothing to
 * self-correct it. `mySeatNumber` (`EventRoom`, via `findMySeatNumber`)
 * is the *one* canonical value `participantRole`/`isSpeaker`/the role
 * routers/self-preview eligibility already all derive from — the fix
 * belongs here, at the data source, not in another independent
 * role-ish flag layered on top of it.
 *
 * `fetchActiveSpeakers` reads the same expiration-aware
 * `event_speakers_active` view (migration 00000000000018)
 * `listActiveSpeakers` uses server-side — this hook's state is now
 * genuinely resynced to the same authoritative source
 * `getActiveSeatForIdentity` reads, not just "whatever deltas happened
 * to arrive."
 */
async function fetchActiveSpeakers(
  supabase: ReturnType<typeof createClient>,
  eventId: string,
): Promise<EventSpeaker[]> {
  const { data } = await supabase.from("event_speakers_active").select("*").eq("event_id", eventId);
  return (data ?? []) as EventSpeaker[];
}

/** Why a reconcile (full authoritative re-read, replacing accumulated state) was triggered — issue #21, sixteenth corrective pass. Surfaced in `SpeakerSyncDiagnostics` and the Session Simulator's own debug snapshot, so a real-device report can show exactly what caused (or should have caused) convergence. */
export type SpeakerReconcileReason = "subscribed" | "visibility" | "focus" | "backstop" | "bootstrap" | "invariant" | "manual";

/**
 * Issue #21, sixteenth corrective pass: a real-device snapshot showed
 * simulator bootstrap's own authoritative confirmation ("Seat 1 = Nimble
 * Lynx, Seat 2 = Dapper Deer") coexisting with this hook's own client
 * state still reporting both seats vacant, 13+ seconds later — the two
 * *canonical* pieces of evidence (this hook's `bySeat`, and whatever a
 * fresh `event_speakers_active` read shows) had genuinely diverged, with
 * nothing in the previous debug snapshot able to distinguish "Realtime
 * hasn't delivered yet" from "a reconcile never ran" from "a reconcile
 * ran but disagreed." These few fields are what make that distinction
 * legible from a single capture, without dumping every internal detail.
 */
export type SpeakerSyncDiagnostics = {
  /** The Realtime channel's own last-reported status (e.g. "SUBSCRIBED", "CHANNEL_ERROR", "CLOSED") — null before the channel has ever reported one. */
  channelStatus: string | null;
  /** ISO timestamp of the most recent SUBSCRIBED callback (initial connect or any automatic reconnect). */
  lastSubscribedAt: string | null;
  /** ISO timestamp of the most recent INSERT/UPDATE/DELETE this hook actually received over Realtime, regardless of what it changed. */
  lastRealtimeEventAt: string | null;
  /** ISO timestamp the most recent authoritative reconcile (a fresh `event_speakers_active` read replacing accumulated state) began. */
  lastReconcileStartedAt: string | null;
  /** ISO timestamp the most recent reconcile finished. */
  lastReconcileCompletedAt: string | null;
  /** What triggered the most recent reconcile. */
  lastReconcileReason: SpeakerReconcileReason | null;
  /** Whether the most recent reconcile's fresh read actually differed from what this hook already had, or just confirmed it. */
  lastReconcileResult: "matched" | "changed" | null;
  /** Where the current `bySeat` state's most recent change actually came from. */
  lastMutationSource: "realtime" | "reconcile" | "initial" | null;
};

/**
 * The room's speaker roster and status, sourced entirely from
 * `event_speakers` — never from LiveKit's participant/track state. See
 * DECISIONS.md's issue #3 entry: this is what keeps the database
 * authoritative for "who is speaking" even if a speaker mutes, loses
 * camera permission, or has a media hiccup — none of that changes this
 * hook's state, only `useLiveRoomConnection`'s.
 *
 * Issue #18 real-device finding (2026-08-27): resyncs a full, fresh read
 * — replacing accumulated state outright, not patching it — on every
 * `SUBSCRIBED` callback from the Realtime channel (the initial
 * subscription *and* every automatic reconnect after a drop), and
 * exposes `refetch` for a caller to trigger the same resync explicitly
 * once it has independent proof of a contradiction (see
 * `joinOpenSeat`'s `already-speaking` result and `EventRoom`'s own
 * handling of it). See `fetchActiveSpeakers`'s own doc comment for the
 * root cause this closes.
 *
 * **Issue #21, sixteenth corrective pass**: on-SUBSCRIBED resync alone
 * has exactly the same blind spot the thirteenth pass already found and
 * fixed for `useActiveSpeakerRequests` — a single WAL message (here, a
 * seat-claim INSERT) silently dropped in transit, on an otherwise-
 * healthy, continuously-visible, never-reconnecting connection, is
 * structurally invisible to a trigger that only fires on SUBSCRIBED. A
 * real-device snapshot caught exactly this: the Session Simulator's own
 * bootstrap authoritatively confirmed both seats occupied, while this
 * hook's own `bySeat` stayed empty for 13+ seconds — the client's
 * *canonical* stage-facing speaker state had a real, provable gap, not
 * a rendering artifact. Three additions close it, all reusing the exact
 * pattern already established and proven for votes/requests:
 *
 * 1. **Visibility/focus resync** (matching `useActiveSpeakerRequests`/
 *    `useSeatReconciliation`) — a backgrounded-then-foregrounded mobile
 *    tab is exactly where a socket can silently degrade without the app
 *    being told.
 * 2. **A bounded 20s backstop** (same precedent) — never the primary
 *    responsiveness path; every real Realtime delta still lands
 *    instantly via the handlers below.
 * 3. **A `reason`-tagged `reconcile`**, reused by every trigger
 *    (SUBSCRIBED, visibility, focus, backstop, and any external caller —
 *    `refetch(reason)`) rather than each duplicating its own fetch-and-
 *    replace logic — this is the "one canonical reconciliation function,
 *    reused everywhere" the investigation that led to this pass asked
 *    for, not a new parallel mechanism. `getSyncDiagnostics()` exposes
 *    what actually happened (channel status, last event/reconcile
 *    timestamps, reason, result) for the Session Simulator's own debug
 *    snapshot — see that component's own doc comment.
 *
 * Deliberately does **not** add a time-based poll as the primary fix —
 * see this pass's own DECISIONS.md entry for why an *event-driven*
 * reconcile (bootstrap's own authoritative confirmation directly calling
 * `refetch("bootstrap")`, plus a stage-round-active/empty-local-seats
 * invariant check in `EventRoom`) is what actually closes the specific
 * gap the real-device report found; the backstop above is defense in
 * depth for the general missed-delta class, unchanged in spirit from the
 * thirteenth pass's own reasoning.
 */
export function useActiveSpeakers(
  eventId: string,
  initialSpeakers: EventSpeaker[],
): {
  speakers: EventSpeaker[];
  roomStatus: RoomStatus;
  refetch: (reason?: SpeakerReconcileReason) => Promise<EventSpeaker[]>;
  getSyncDiagnostics: () => SpeakerSyncDiagnostics;
} {
  const [bySeat, setBySeat] = useState<Record<number, EventSpeaker>>(() => toBySeat(initialSpeakers));
  const supabaseRef = useRef<ReturnType<typeof createClient> | null>(null);

  // Sync diagnostics — plain refs, never trigger a re-render on their
  // own. Read on demand via `getSyncDiagnostics()` (called from an event
  // handler — the Session Simulator's Copy Debug Snapshot tap, or a
  // future caller), so they're always exactly current at the moment
  // asked, independent of render timing.
  const channelStatusRef = useRef<string | null>(null);
  const lastSubscribedAtRef = useRef<string | null>(null);
  const lastRealtimeEventAtRef = useRef<string | null>(null);
  const lastReconcileStartedAtRef = useRef<string | null>(null);
  const lastReconcileCompletedAtRef = useRef<string | null>(null);
  const lastReconcileReasonRef = useRef<SpeakerReconcileReason | null>(null);
  const lastReconcileResultRef = useRef<"matched" | "changed" | null>(null);
  const lastMutationSourceRef = useRef<"realtime" | "reconcile" | "initial" | null>(null);
  // Issue #21, sixteenth corrective pass: a monotonic sequence number —
  // multiple reconciles can genuinely overlap (e.g. the on-SUBSCRIBED
  // resync and a bootstrap-triggered one, moments apart), and without
  // this an *older*, slower-to-resolve read could complete *after* a
  // newer one and clobber it with staler data — a real "stale fetch"
  // race, not a hypothetical (this is exactly the shape the "STALE
  // INITIAL FETCH RACE" test below proves is now closed). Each call
  // captures the sequence number current at its own *start*; only the
  // reconcile whose captured number still matches the ref when its fetch
  // resolves is allowed to apply its result — i.e., only the most
  // recently *started* reconcile ever wins, regardless of completion
  // order.
  const reconcileSeqRef = useRef(0);

  /**
   * The one canonical reconcile — a fresh, authoritative
   * `event_speakers_active` read, replacing (never patching) this hook's
   * own state, tagged with why it ran. Every trigger below (SUBSCRIBED,
   * visibility, focus, the backstop, and any external `refetch(reason)`
   * caller — bootstrap, the active-round/empty-seats invariant check)
   * calls this same function; none of them duplicate the fetch-and-
   * replace logic themselves. Returns the fresh rows directly (not just
   * `void`) so a caller that needs to *verify* convergence — bootstrap,
   * specifically — can inspect the result without waiting on its own
   * next render to see the updated `speakers` prop. Always returns the
   * rows it actually fetched, even on the rare occasion a newer reconcile
   * supersedes it before `setBySeat` — a caller verifying convergence
   * should trust what it just read, not silently get nothing back.
   */
  const reconcile = useCallback(
    async (reason: SpeakerReconcileReason): Promise<EventSpeaker[]> => {
      const supabase = supabaseRef.current;
      if (!supabase) return [];
      const mySeq = ++reconcileSeqRef.current;
      lastReconcileStartedAtRef.current = new Date().toISOString();
      lastReconcileReasonRef.current = reason;
      const fresh = await fetchActiveSpeakers(supabase, eventId);
      if (reconcileSeqRef.current === mySeq) {
        const nextBySeat = toBySeat(fresh);
        setBySeat((prev) => {
          lastReconcileResultRef.current = seatsDiffer(prev, nextBySeat) ? "changed" : "matched";
          return nextBySeat;
        });
        lastReconcileCompletedAtRef.current = new Date().toISOString();
        lastMutationSourceRef.current = "reconcile";
      }
      return fresh;
    },
    [eventId],
  );

  useEffect(() => {
    const supabase = createClient();
    supabaseRef.current = supabase;

    function applyRealtimeChange(mutator: (prev: Record<number, EventSpeaker>) => Record<number, EventSpeaker>) {
      lastRealtimeEventAtRef.current = new Date().toISOString();
      lastMutationSourceRef.current = "realtime";
      setBySeat(mutator);
    }

    const channel = supabase
      .channel(`event-speakers:${eventId}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "event_speakers", filter: `event_id=eq.${eventId}` },
        (payload) => applyRealtimeChange((prev) => applySpeakerChange(prev, payload.new as EventSpeaker)),
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "event_speakers", filter: `event_id=eq.${eventId}` },
        (payload) => applyRealtimeChange((prev) => applySpeakerChange(prev, payload.new as EventSpeaker)),
      )
      .on(
        // Session Simulator Reset Session follow-up — see
        // removeSpeaker's own doc comment for why this exists.
        "postgres_changes",
        { event: "DELETE", schema: "public", table: "event_speakers", filter: `event_id=eq.${eventId}` },
        (payload) => applyRealtimeChange((prev) => removeSpeaker(prev, payload.old as EventSpeaker)),
      )
      .subscribe((status) => {
        channelStatusRef.current = status;
        // Fires on the initial successful subscription *and* on every
        // automatic reconnect after a drop — both are moments this
        // hook's accumulated deltas could already be stale, so both get
        // a full resync rather than trusting whatever was accumulated
        // going in. See this module's own doc comment.
        if (status === "SUBSCRIBED") {
          lastSubscribedAtRef.current = new Date().toISOString();
          void reconcile("subscribed");
        }
      });

    // Issue #21, sixteenth corrective pass: visibility/focus resync,
    // matching `useActiveSpeakerRequests`'/`useSeatReconciliation`'s own
    // established pattern for the identical class of problem — see this
    // module's own doc comment.
    function handleVisibilityRestored() {
      if (document.visibilityState === "visible") void reconcile("visibility");
    }
    function handleFocus() {
      void reconcile("focus");
    }
    document.addEventListener("visibilitychange", handleVisibilityRestored);
    window.addEventListener("focus", handleFocus);

    // The bounded backstop — 20s, matching the thirteenth pass's own
    // precedent for votes/requests. Never the primary responsiveness
    // path; only ever needs to catch a rare per-message loss eventually.
    const backstopInterval = setInterval(() => void reconcile("backstop"), 20_000);

    return () => {
      supabaseRef.current = null;
      supabase.removeChannel(channel);
      document.removeEventListener("visibilitychange", handleVisibilityRestored);
      window.removeEventListener("focus", handleFocus);
      clearInterval(backstopInterval);
    };
  }, [eventId, reconcile]);

  const refetch = useCallback(
    (reason: SpeakerReconcileReason = "manual") => reconcile(reason),
    [reconcile],
  );

  const getSyncDiagnostics = useCallback(
    (): SpeakerSyncDiagnostics => ({
      channelStatus: channelStatusRef.current,
      lastSubscribedAt: lastSubscribedAtRef.current,
      lastRealtimeEventAt: lastRealtimeEventAtRef.current,
      lastReconcileStartedAt: lastReconcileStartedAtRef.current,
      lastReconcileCompletedAt: lastReconcileCompletedAtRef.current,
      lastReconcileReason: lastReconcileReasonRef.current,
      lastReconcileResult: lastReconcileResultRef.current,
      lastMutationSource: lastMutationSourceRef.current,
    }),
    [],
  );

  const speakers = Object.values(bySeat).sort((a, b) => a.seat_number - b.seat_number);
  return { speakers, roomStatus: getRoomStatus(speakers.length), refetch, getSyncDiagnostics };
}
