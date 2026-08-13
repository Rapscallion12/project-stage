"use server";

import { redirect } from "next/navigation";
import { resolveIdentity } from "@/lib/identity";
import { isDevToolsAvailable } from "@/lib/dev-demo";
import { createDevDemoEvent, resetDevDemoEvents, seatCurrentUserAsSpeaker } from "@/lib/repositories/dev-demo";

/**
 * Every action in this file is independently gated — the page itself
 * calls `notFound()` when dev tools aren't available, but a Server
 * Action has its own callable endpoint, addressable regardless of
 * whether the page that renders its trigger ever rendered. Hiding the
 * page alone would not stop a direct request to the action; this is
 * what actually does.
 */
function assertDevToolsAvailable() {
  if (!isDevToolsAvailable()) {
    throw new Error("Dev tools are not available in production.");
  }
}

export async function createDemoEvent(formData: FormData): Promise<void> {
  assertDevToolsAvailable();
  const title = String(formData.get("title") ?? "");
  await createDevDemoEvent(title);
  redirect("/dev");
}

/**
 * Seats the *currently signed-in* account — bound with the event id and
 * seat number (`seatMe.bind(null, eventId, seatNumber)`, same pattern
 * `sendMessage.bind(null, eventId)` already uses in the lobby chat
 * panel) before being used as a form's `action`.
 */
// No FormData parameter — React's form-action calling convention always
// passes one when the bound function is invoked from a <form>, but
// neither of these reads it (extra call arguments are simply ignored in
// JS), so it's omitted rather than declared-and-unused.
export async function seatMe(eventId: string, seatNumber: 1 | 2): Promise<void> {
  assertDevToolsAvailable();
  const identity = await resolveIdentity();
  if (identity.type !== "profile") {
    throw new Error("Log in first to seat yourself as a speaker.");
  }
  await seatCurrentUserAsSpeaker(eventId, identity.id, seatNumber);
  redirect("/dev");
}

export async function resetDemoEvents(): Promise<void> {
  assertDevToolsAvailable();
  await resetDevDemoEvents();
  redirect("/dev");
}
