#!/usr/bin/env node
// Development-only CLI for creating, seating, listing, and resetting test
// events — NOT part of the application. Lives outside src/, never
// imported by application code, never bundled into the Next.js build: no
// new route, no new env var, no schema/RLS/grant change. It authenticates
// with the same SUPABASE_SERVICE_ROLE_KEY the app already uses
// (lib/supabase/service.ts) and drives the same trusted speaker-
// transition primitives issue #13 built and tested
// (claim_speaker_seat/leave_speaker_seat/end_speaker_seat via RPC) — this
// script is simply one more trusted server-side caller of those, not a
// new authorization path. See DECISIONS.md for the full design reasoning.
//
// Requires Node 22.6+ (uses --env-file and --experimental-strip-types,
// both native — no ts-node/tsx dependency added just for this). See
// README.md for full usage.
//
//   node --experimental-strip-types --env-file=.env.local scripts/dev-harness.mts <command> [...args]
//   npm run dev:harness -- <command> [...args]
//
// Commands: create [--phase=ready|lobby_open|upcoming] [title words...]
//           seat <email-or-label> <1|2> [eventId]
//           list
//           reset

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { pathToFileURL } from "node:url";
import type { Database } from "../src/types/database.ts";

type Client = SupabaseClient<Database>;

// ---------------------------------------------------------------------
// Tagging — this is the actual safety mechanism `reset` relies on: it
// only ever touches rows matching these, never anything else in the one
// shared Supabase project this prototype uses. If you `seat` your own
// real account (any email that doesn't end in HARNESS_EMAIL_DOMAIN),
// nothing here will ever create, modify, or delete it.
// ---------------------------------------------------------------------

export const HARNESS_EVENT_PREFIX = "[dev-harness] ";
/** Reserved, non-routable TLD (RFC 2606) — real signups can never collide with this. */
export const HARNESS_EMAIL_DOMAIN = "@dev-harness.invalid";
export const HARNESS_PASSWORD = "dev-harness-not-a-real-password-do-not-reuse-123!";

export function isHarnessEventTitle(title: string): boolean {
  return title.startsWith(HARNESS_EVENT_PREFIX);
}

export function isHarnessTestEmail(email: string): boolean {
  return email.toLowerCase().endsWith(HARNESS_EMAIL_DOMAIN);
}

/** A bare label ("alice") expands to a harness test email; anything containing "@" is passed through unchanged (so you can point `seat` at your own real account). */
export function resolveEmail(labelOrEmail: string): string {
  return labelOrEmail.includes("@") ? labelOrEmail : `${labelOrEmail}${HARNESS_EMAIL_DOMAIN}`;
}

export type Phase = "ready" | "lobby_open" | "upcoming";

/** Timestamps chosen so a freshly-created event is immediately in the requested phase — see lib/events.ts's getEventPhase for the phase boundaries this mirrors. */
export function timingForPhase(phase: Phase, now: Date = new Date()): { scheduled_start: string; lobby_opens_at: string } {
  const ms = now.getTime();
  if (phase === "ready") {
    return {
      scheduled_start: new Date(ms - 60_000).toISOString(),
      lobby_opens_at: new Date(ms - 5 * 60_000).toISOString(),
    };
  }
  if (phase === "lobby_open") {
    return {
      scheduled_start: new Date(ms + 15 * 60_000).toISOString(),
      lobby_opens_at: new Date(ms - 60_000).toISOString(),
    };
  }
  return {
    scheduled_start: new Date(ms + 2 * 60 * 60_000).toISOString(),
    lobby_opens_at: new Date(ms + 60 * 60_000).toISOString(),
  };
}

// ---------------------------------------------------------------------
// Client construction — mirrors lib/supabase/service.ts's pattern
// deliberately without importing it: that module documents an exact,
// short list of legitimate callers (the webhook route, the two
// trusted-server-only event-speakers functions), and this script isn't
// part of the application, so it gets its own copy of the same few lines
// rather than becoming an undocumented fourth caller of an app-internal
// module.
// ---------------------------------------------------------------------

export function getServiceClient(env: NodeJS.ProcessEnv = process.env): Client {
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not configured — see README.md's dev harness section.",
    );
  }
  return createClient<Database>(url, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });
}

// ---------------------------------------------------------------------
// Actions — each takes the client as a parameter (not module-level
// singleton) so tests can call them directly against real fixture data,
// same discipline as the app's own integration tests.
// ---------------------------------------------------------------------

export async function createHarnessEvent(client: Client, phase: Phase, titleSuffix: string) {
  const title = `${HARNESS_EVENT_PREFIX}${titleSuffix || phase}`;
  const { scheduled_start, lobby_opens_at } = timingForPhase(phase);
  const { data, error } = await client
    .from("events")
    .insert({
      title,
      description: "Created by scripts/dev-harness.mts — safe to delete, never real content.",
      scheduled_start,
      lobby_opens_at,
    })
    .select("*")
    .single();
  if (error || !data) throw new Error(error?.message ?? "failed to create harness event");
  return data;
}

async function findUserByEmail(client: Client, email: string) {
  // No direct "get user by email" in the Admin API — list and filter.
  // Fine for a dev tool against this prototype's small user base; not
  // something the app itself ever needs to do.
  const { data, error } = await client.auth.admin.listUsers({ perPage: 1000 });
  if (error) throw new Error(error.message);
  return data.users.find((u) => u.email?.toLowerCase() === email.toLowerCase()) ?? null;
}

/**
 * Resolves an email to an existing profile, or creates one — but only
 * ever creates one for a harness-tagged email. Passing a real email that
 * doesn't exist yet is a clear error, not a silent account creation: an
 * untagged account `reset` could never find and clean up would be exactly
 * the leak this tool is designed not to have.
 */
export async function resolveOrCreateProfile(client: Client, emailOrLabel: string) {
  const email = resolveEmail(emailOrLabel);
  const existing = await findUserByEmail(client, email);
  if (existing) return { id: existing.id, email, created: false };

  if (!isHarnessTestEmail(email)) {
    throw new Error(
      `No existing account for ${email}. Pass a harness label (e.g. "alice", expands to alice${HARNESS_EMAIL_DOMAIN}) to auto-create a throwaway test account, or sign up for that email first.`,
    );
  }

  const label = email.slice(0, email.indexOf("@"));
  const { data, error } = await client.auth.admin.createUser({
    email,
    password: HARNESS_PASSWORD,
    email_confirm: true,
    user_metadata: { display_name: `${HARNESS_EVENT_PREFIX}${label}` },
  });
  if (error || !data.user) throw new Error(error?.message ?? `failed to create test account ${email}`);
  return { id: data.user.id, email, created: true };
}

async function mostRecentHarnessEvent(client: Client) {
  const { data, error } = await client
    .from("events")
    .select("*")
    .ilike("title", `${HARNESS_EVENT_PREFIX}%`)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("No dev-harness event exists yet — run `create` first, or pass an explicit eventId.");
  return data;
}

export async function seatSpeaker(client: Client, emailOrLabel: string, seatNumber: 1 | 2, eventId?: string) {
  const profile = await resolveOrCreateProfile(client, emailOrLabel);
  const event = eventId ? { id: eventId } : await mostRecentHarnessEvent(client);

  const { data, error } = await client.rpc("claim_speaker_seat", {
    p_event_id: event.id,
    p_profile_id: profile.id,
    p_seat_number: seatNumber,
  });
  if (error || !data) throw new Error(error?.message ?? "claim_speaker_seat returned no row");
  return { profile, eventId: event.id, row: data };
}

export async function listHarnessState(client: Client) {
  const { data: events, error } = await client
    .from("events")
    .select("*")
    .ilike("title", `${HARNESS_EVENT_PREFIX}%`)
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  if (!events || events.length === 0) return [];

  const { data: speakers, error: speakersError } = await client
    .from("event_speakers")
    .select("*")
    .in("event_id", events.map((e) => e.id))
    .is("left_at", null);
  if (speakersError) throw new Error(speakersError.message);

  return events.map((event) => ({
    event,
    speakers: (speakers ?? []).filter((s) => s.event_id === event.id).sort((a, b) => a.seat_number - b.seat_number),
  }));
}

export async function resetHarness(client: Client) {
  const { data: events, error: eventsReadError } = await client
    .from("events")
    .select("id")
    .ilike("title", `${HARNESS_EVENT_PREFIX}%`);
  if (eventsReadError) throw new Error(eventsReadError.message);

  let eventsDeleted = 0;
  if (events && events.length > 0) {
    // Deleted by id, not by the ilike filter directly — an explicit id
    // list is what's actually verified against the tag, rather than
    // trusting a second identical-looking filter at delete time.
    const { error: deleteEventsError, count } = await client
      .from("events")
      .delete({ count: "exact" })
      .in("id", events.map((e) => e.id));
    if (deleteEventsError) throw new Error(deleteEventsError.message);
    eventsDeleted = count ?? events.length;
  }

  const { data: usersPage, error: usersError } = await client.auth.admin.listUsers({ perPage: 1000 });
  if (usersError) throw new Error(usersError.message);
  const harnessUsers = usersPage.users.filter((u) => u.email && isHarnessTestEmail(u.email));

  let usersDeleted = 0;
  for (const user of harnessUsers) {
    const { error: deleteUserError } = await client.auth.admin.deleteUser(user.id);
    if (deleteUserError) throw new Error(deleteUserError.message);
    usersDeleted += 1;
  }

  return { eventsDeleted, usersDeleted };
}

// ---------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------

export function parseArgs(args: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (const arg of args) {
    if (arg.startsWith("--")) {
      const [key, value] = arg.slice(2).split("=");
      flags[key] = value ?? "true";
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000";

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const client = getServiceClient();

  if (command === "create") {
    const { positional, flags } = parseArgs(rest);
    const phase = (flags.phase as Phase) ?? "ready";
    if (!["ready", "lobby_open", "upcoming"].includes(phase)) {
      throw new Error(`--phase must be one of ready|lobby_open|upcoming, got "${phase}"`);
    }
    const event = await createHarnessEvent(client, phase, positional.join(" "));
    console.log(`Created "${event.title}" (${phase})`);
    console.log(`  id:   ${event.id}`);
    console.log(`  page: ${SITE_URL}/events/${event.id}`);
    console.log(`  room: ${SITE_URL}/events/${event.id}/room`);
    return;
  }

  if (command === "seat") {
    const [emailOrLabel, seatArg, eventId] = rest;
    const seatNumber = Number(seatArg);
    if (!emailOrLabel || (seatNumber !== 1 && seatNumber !== 2)) {
      throw new Error("Usage: seat <email-or-label> <1|2> [eventId]");
    }
    const result = await seatSpeaker(client, emailOrLabel, seatNumber, eventId);
    console.log(`Seated ${result.profile.email} in seat ${seatNumber} of event ${result.eventId}`);
    if (result.profile.created) {
      console.log(`  Created a new dev-harness account:`);
      console.log(`    email:    ${result.profile.email}`);
      console.log(`    password: ${HARNESS_PASSWORD}`);
      console.log(`  Log in with these in a second browser/incognito session to test as this speaker.`);
    }
    return;
  }

  if (command === "list") {
    const state = await listHarnessState(client);
    if (state.length === 0) {
      console.log("No dev-harness events exist. Run `create` first.");
      return;
    }
    for (const { event, speakers } of state) {
      console.log(`${event.title}  (${event.id})`);
      console.log(`  ${SITE_URL}/events/${event.id}/room`);
      if (speakers.length === 0) {
        console.log("  no active speakers");
      } else {
        for (const s of speakers) console.log(`  seat ${s.seat_number}: ${s.display_name}`);
      }
    }
    return;
  }

  if (command === "reset") {
    const { eventsDeleted, usersDeleted } = await resetHarness(client);
    console.log(`Deleted ${eventsDeleted} dev-harness event(s) and ${usersDeleted} dev-harness test account(s).`);
    return;
  }

  console.log(
    [
      "Usage: npm run dev:harness -- <command> [...args]",
      "",
      "  create [--phase=ready|lobby_open|upcoming] [title words...]",
      "  seat <email-or-label> <1|2> [eventId]",
      "  list",
      "  reset",
    ].join("\n"),
  );
  process.exitCode = command ? 1 : 0;
}

// Only run the CLI when this file is executed directly (`node
// scripts/dev-harness.mts ...`) — not when a test imports it for its
// exported functions. pathToFileURL (not a plain `new URL(path,
// "file://")`) is what correctly handles a Windows path's backslashes
// and drive letter here.
const isMainModule = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]!).href;
if (isMainModule) {
  main().catch((error: unknown) => {
    console.error(`dev-harness: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
