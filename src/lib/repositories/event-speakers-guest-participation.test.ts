// @vitest-environment node
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServiceClient } from "@/lib/supabase/service";
import { claimSpeakerSeat, endSpeakerSeat, leaveSpeakerSeatAsGuest } from "./event-speakers";
import {
  rankPendingSpeakerRequests,
  requestToSpeakAsGuest,
  withdrawSpeakerRequestAsGuest,
} from "./speaker-requests";

const hasServiceCredentials = Boolean(
  process.env.NEXT_PUBLIC_SUPABASE_URL &&
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY &&
    process.env.SUPABASE_SERVICE_ROLE_KEY,
);

/**
 * Integration tests for issue #16's guest speaker participation — an
 * explicit, reversible prototype-testing exception to the account-only
 * speaking rule (see PRODUCT.md/DECISIONS.md), against the real linked
 * Supabase project, same discipline as event-speakers-transitions.test.ts.
 * Guest identity is just a bare UUID (see src/lib/guest.ts) — unlike the
 * profile fixtures in that file, no real auth user/profiles row is
 * needed to exercise these functions, since guest_id has no FK to
 * anything.
 */
describe.skipIf(!hasServiceCredentials)("guest speaker participation (issue #16)", () => {
  let service: ReturnType<typeof createServiceClient>;
  const anonUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

  let eventId: string;

  async function activeSeats(eventIdToCheck: string) {
    const { data } = await service
      .from("event_speakers")
      .select("*")
      .eq("event_id", eventIdToCheck)
      .is("left_at", null)
      .order("seat_number", { ascending: true });
    return data ?? [];
  }

  beforeAll(async () => {
    service = createServiceClient();
    const { data: event, error } = await service
      .from("events")
      .insert({
        title: "Issue #16 guest participation test fixture event",
        scheduled_start: new Date(Date.now() + 60_000).toISOString(),
        lobby_opens_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    if (error || !event) throw new Error(error?.message ?? "failed to create test event");
    eventId = event.id;
  }, 30_000);

  afterAll(async () => {
    if (eventId) {
      await service.from("events").delete().eq("id", eventId);
    }
  }, 30_000);

  it("seats a guest into an empty seat, using the caller-supplied display name (guests have no profiles row to snapshot from)", async () => {
    const guestId = crypto.randomUUID();
    const row = await claimSpeakerSeat(eventId, { type: "guest", id: guestId }, 1, "Curious Fox");
    expect(row.guest_id).toBe(guestId);
    expect(row.profile_id).toBeNull();
    expect(row.display_name).toBe("Curious Fox");
    expect(row.left_at).toBeNull();
  });

  it("rejects claiming a seat for a guest with no display name supplied", async () => {
    await expect(
      claimSpeakerSeat(eventId, { type: "guest", id: crypto.randomUUID() }, 2),
    ).rejects.toThrow(/p_guest_display_name/);
  });

  it("rejects a raw call with both profile_id and guest_id set — the XOR constraint holds even at the RPC layer, not just the table", async () => {
    const { error } = await service.rpc("claim_speaker_seat", {
      p_event_id: eventId,
      p_seat_number: 2,
      p_profile_id: "00000000-0000-0000-0000-000000000000",
      p_guest_id: crypto.randomUUID(),
      p_guest_display_name: "Whoever",
    });
    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/exactly one/);
  });

  it("rejects a raw call with neither identity set", async () => {
    const { error } = await service.rpc("claim_speaker_seat", {
      p_event_id: eventId,
      p_seat_number: 2,
    });
    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/exactly one/);
  });

  it("end_speaker_seat ends a guest's active occupancy, and is a safe no-op if they're not seated", async () => {
    const guestId = crypto.randomUUID();
    await claimSpeakerSeat(eventId, { type: "guest", id: guestId }, 2, "Bold Otter");

    const ended = await endSpeakerSeat(eventId, { type: "guest", id: guestId }, "disconnected");
    expect(ended?.left_reason).toBe("disconnected");
    expect(ended?.guest_id).toBe(guestId);

    const noop = await endSpeakerSeat(eventId, { type: "guest", id: guestId }, "disconnected");
    expect(noop).toBeNull();
  });

  it("leaveSpeakerSeatAsGuest lets a seated guest end their own seat voluntarily", async () => {
    const guestId = crypto.randomUUID();
    await claimSpeakerSeat(eventId, { type: "guest", id: guestId }, 1, "Gentle Heron");

    const left = await leaveSpeakerSeatAsGuest(eventId, guestId);
    expect(left.left_reason).toBe("voluntary");

    const active = await activeSeats(eventId);
    expect(active.find((s) => s.guest_id === guestId)).toBeUndefined();
  });

  it("leaveSpeakerSeatAsGuest rejects when the guest has no active seat", async () => {
    await expect(leaveSpeakerSeatAsGuest(eventId, crypto.randomUUID())).rejects.toThrow(/no active seat/);
  });

  it("claim_speaker_seat/end_speaker_seat/leave_speaker_seat_as_guest are still not callable by anon or an ordinary authenticated user — the guest path stays on the same trusted-server-only tier", async () => {
    const anon = createSupabaseClient(anonUrl, anonKey);
    const guestId = crypto.randomUUID();

    const claimAttempt = await anon.rpc("claim_speaker_seat", {
      p_event_id: eventId,
      p_seat_number: 1,
      p_guest_id: guestId,
      p_guest_display_name: "Sneaky Guest",
    });
    expect(claimAttempt.error?.code).toBe("42501");

    const leaveAttempt = await anon.rpc("leave_speaker_seat_as_guest", {
      p_event_id: eventId,
      p_guest_id: guestId,
    });
    expect(leaveAttempt.error?.code).toBe("42501");
  });

  it("requestToSpeakAsGuest atomically posts a badged chat message and a pending request, same as the account-holder path", async () => {
    const guestId = crypto.randomUUID();
    const { messageId, requestId } = await requestToSpeakAsGuest(eventId, guestId, "Witty Sparrow", "Let me on!");
    expect(messageId).toBeTruthy();
    expect(requestId).toBeTruthy();

    const { data: message } = await service.from("event_chat_messages").select("*").eq("id", messageId).single();
    expect(message?.author_guest_id).toBe(guestId);
    expect(message?.author_profile_id).toBeNull();
    expect(message?.is_speaker_request).toBe(true);

    const { data: request } = await service.from("speaker_requests").select("*").eq("id", requestId).single();
    expect(request?.guest_id).toBe(guestId);
    expect(request?.status).toBe("pending");
  });

  it("rejects a second pending request from the same guest", async () => {
    const guestId = crypto.randomUUID();
    await requestToSpeakAsGuest(eventId, guestId, "Dapper Wolf", "First request");
    await expect(requestToSpeakAsGuest(eventId, guestId, "Dapper Wolf", "Second request")).rejects.toThrow(
      /already has a pending request/,
    );
  });

  it("withdrawSpeakerRequestAsGuest ends the guest's own pending request", async () => {
    const guestId = crypto.randomUUID();
    await requestToSpeakAsGuest(eventId, guestId, "Eager Rabbit", "Pick me");

    const withdrawn = await withdrawSpeakerRequestAsGuest(eventId, guestId);
    // Non-null here: a request was just created above, so there's
    // genuinely something pending to withdraw — null only means "nothing
    // was pending" (see withdrawSpeakerRequestAsGuest's own doc comment).
    expect(withdrawn).not.toBeNull();
    expect(withdrawn?.status).toBe("withdrawn");

    // A withdrawn request frees the guest to request again.
    await expect(requestToSpeakAsGuest(eventId, guestId, "Eager Rabbit", "Again")).resolves.toBeTruthy();
  });

  it("rank_pending_speaker_requests includes guest rows (a left join, not an inner join, on profiles)", async () => {
    const guestId = crypto.randomUUID();
    await requestToSpeakAsGuest(eventId, guestId, "Nimble Deer", "Ranking test");

    const ranked = await rankPendingSpeakerRequests(eventId);
    const mine = ranked.find((r) => r.guest_id === guestId);
    expect(mine).toBeTruthy();
    expect(mine?.profile_id).toBeNull();
    expect(typeof mine?.rank).toBe("number");
  });

  it("request_to_speak_as_guest and withdraw_speaker_request_as_guest are not callable by anon or an ordinary authenticated user", async () => {
    const anon = createSupabaseClient(anonUrl, anonKey);

    const requestAttempt = await anon.rpc("request_to_speak_as_guest", {
      p_event_id: eventId,
      p_guest_id: crypto.randomUUID(),
      p_display_name: "Sneaky Guest",
      p_body: "Let me in",
    });
    expect(requestAttempt.error?.code).toBe("42501");

    const withdrawAttempt = await anon.rpc("withdraw_speaker_request_as_guest", {
      p_event_id: eventId,
      p_guest_id: crypto.randomUUID(),
    });
    expect(withdrawAttempt.error?.code).toBe("42501");
  });
});
