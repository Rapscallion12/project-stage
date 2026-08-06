"use server";

import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { getSiteURL } from "@/lib/utils";

const signupSchema = z.object({
  displayName: z.string().trim().min(2, "Display name must be at least 2 characters."),
  email: z.string().trim().email("Enter a valid email address."),
  password: z.string().min(8, "Password must be at least 8 characters."),
});

export type SignupState =
  | { status: "error"; error: string }
  | { status: "success"; message: string }
  | undefined;

export async function signup(
  _prevState: SignupState,
  formData: FormData,
): Promise<SignupState> {
  const parsed = signupSchema.safeParse({
    displayName: formData.get("displayName"),
    email: formData.get("email"),
    password: formData.get("password"),
  });

  if (!parsed.success) {
    return { status: "error", error: parsed.error.issues[0].message };
  }

  const { displayName, email, password } = parsed.data;
  const supabase = await createClient();

  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: { display_name: displayName },
      emailRedirectTo: `${getSiteURL()}auth/confirm`,
    },
  });

  if (error) {
    return { status: "error", error: error.message };
  }

  // Supabase returns a user with an empty identities array when the email
  // is already registered, without surfacing it as an error (to avoid
  // leaking which emails are registered).
  if (data.user && data.user.identities && data.user.identities.length === 0) {
    return {
      status: "error",
      error: "An account with this email already exists. Try logging in instead.",
    };
  }

  return {
    status: "success",
    message: "Check your email to confirm your account before logging in.",
  };
}
