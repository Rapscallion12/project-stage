import type { EmailOtpType } from "@supabase/supabase-js";
import { redirect } from "next/navigation";
import type { NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * Landing target for the confirmation link Supabase emails on signup.
 *
 * This project's Supabase instance uses the PKCE flow for its default
 * "Confirm signup" template, whose link lands here with a `code` param —
 * verified empirically against a real project (2026-08-06): the account
 * gets confirmed regardless (Supabase does that server-side before
 * redirecting here), but without exchanging the code for a session the
 * user landed on an error page and had to log in manually. Falls back to
 * the older token_hash + type / verifyOtp style (used by some non-signup
 * flows, e.g. password recovery links) if no code is present.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;
  const next = searchParams.get("next") ?? "/";

  const supabase = await createClient();

  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      redirect(next);
    }
  } else if (tokenHash && type) {
    const { error } = await supabase.auth.verifyOtp({
      type,
      token_hash: tokenHash,
    });
    if (!error) {
      redirect(next);
    }
  }

  redirect("/login?error=confirmation-failed");
}
