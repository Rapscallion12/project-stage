"use client";

import { useActionState } from "react";
import { signup } from "@/app/signup/actions";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";

export function SignupForm() {
  const [state, formAction, pending] = useActionState(signup, undefined);

  if (state?.status === "success") {
    return (
      <p className="rounded-lg border border-border bg-foreground/5 px-4 py-3 text-sm">
        {state.message}
      </p>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <div>
        <Label htmlFor="displayName">Display name</Label>
        <Input id="displayName" name="displayName" type="text" required autoComplete="name" />
      </div>
      <div>
        <Label htmlFor="email">Email</Label>
        <Input id="email" name="email" type="email" required autoComplete="email" />
      </div>
      <div>
        <Label htmlFor="password">Password</Label>
        <Input
          id="password"
          name="password"
          type="password"
          required
          minLength={8}
          autoComplete="new-password"
        />
      </div>
      {state?.status === "error" && (
        <p className="text-sm text-red-500" role="alert">
          {state.error}
        </p>
      )}
      <Button type="submit" disabled={pending} className="mt-2">
        {pending ? "Creating account…" : "Sign up"}
      </Button>
    </form>
  );
}
