// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServiceClient } from "@/lib/supabase/service";
import { isDevEventTitle } from "@/lib/dev-demo";
import { createDevDemoEvent, listDevDemoEvents, resetDevDemoEvents, seatCurrentUserAsSpeaker } from "./dev-demo";

const hasServiceCredentials = Boolean(
  process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY,
);

/**
 * Integration tests for the /dev page's data layer, against the real
 * linked project — same discipline as scripts/dev-harness.test.ts's own
 * end-to-end safety suite, which this deliberately mirrors: create an
 * untagged "real" fixture alongside tagged ones, run the actual
 * `resetDevDemoEvents`, and assert the untagged fixture survives
 * untouched while the tagged ones are gone. Skips gracefully without
 * SUPABASE_SERVICE_ROLE_KEY.
 */
describe.skipIf(!hasServiceCredentials)("dev-demo repository (the /dev page's data layer)", () => {
  let service: ReturnType<typeof createServiceClient>;
  let realEventId: string;
  let testProfileId: string;

  beforeAll(async () => {
    service = createServiceClient();

    const { data: event, error } = await service
      .from("events")
      .insert({
        title: "Not a dev-demo event — reset must never touch this",
        scheduled_start: new Date(Date.now() + 60_000).toISOString(),
        lobby_opens_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    if (error || !event) throw new Error(error?.message ?? "failed to create real-event fixture");
    realEventId = event.id;

    const { data: user, error: userError } = await service.auth.admin.createUser({
      email: `test-dev-page-${crypto.randomUUID()}@example.invalid`,
      password: `Test-Passw0rd-${crypto.randomUUID()}`,
      email_confirm: true,
      user_metadata: { display_name: "Test Dev Page User" },
    });
    if (userError || !user.user) throw new Error(userError?.message ?? "failed to create test profile");
    testProfileId = user.user.id;
  }, 30_000);

  afterAll(async () => {
    if (testProfileId) await service.auth.admin.deleteUser(testProfileId);
    if (realEventId) await service.from("events").delete().eq("id", realEventId);
  }, 30_000);

  it("createDevDemoEvent creates a tagged, immediately-ready event", async () => {
    const event = await createDevDemoEvent("repository test");
    expect(isDevEventTitle(event.title)).toBe(true);

    const { data: full } = await service
      .from("events")
      .select("scheduled_start")
      .eq("id", event.id)
      .single();
    expect(new Date(full!.scheduled_start).getTime()).toBeLessThan(Date.now());
  });

  it("listDevDemoEvents only reports tagged events, never the untagged fixture", async () => {
    const events = await listDevDemoEvents();
    expect(events.every((e) => isDevEventTitle(e.title))).toBe(true);
    expect(events.some((e) => e.id === realEventId)).toBe(false);
  });

  it("seatCurrentUserAsSpeaker uses the real claimSpeakerSeat primitive — no parallel authorization path", async () => {
    const events = await listDevDemoEvents();
    const event = events[0];
    await seatCurrentUserAsSpeaker(event.id, testProfileId, 1);

    // Direct read via the service client, not listActiveSpeakersForDevEvent
    // — that goes through lib/supabase/server.ts, which calls
    // next/headers' cookies(), only valid inside a real Next.js request
    // (same limitation every other repository test in this project has
    // already hit and documented).
    const { data: speakers } = await service
      .from("event_speakers")
      .select("*")
      .eq("event_id", event.id)
      .is("left_at", null);
    expect(speakers?.find((s) => s.seat_number === 1)?.profile_id).toBe(testProfileId);
  });

  it("resetDevDemoEvents deletes every tagged event and leaves the untagged fixture completely untouched", async () => {
    const { eventsDeleted } = await resetDevDemoEvents();
    expect(eventsDeleted).toBeGreaterThan(0);

    const remaining = await listDevDemoEvents();
    expect(remaining).toEqual([]);

    const { data: realEventStillThere } = await service
      .from("events")
      .select("id")
      .eq("id", realEventId)
      .maybeSingle();
    expect(realEventStillThere?.id).toBe(realEventId);
  });
});
