import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { signOut } from "@/app/auth/actions";
import { Button, ButtonLink } from "@/components/ui/button";

export async function SiteHeader() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return (
    <header className="flex items-center justify-between border-b border-border px-6 py-4">
      <div className="flex items-center gap-6">
        <Link href="/" className="text-sm font-semibold tracking-wide">
          VIRTUAL STAGE
        </Link>
        <Link href="/events" className="text-sm text-muted hover:text-foreground">
          Events
        </Link>
      </div>
      {user ? (
        <div className="flex items-center gap-3">
          <span className="hidden text-sm text-muted sm:inline">{user.email}</span>
          <form action={signOut}>
            <Button type="submit" variant="secondary">
              Log out
            </Button>
          </form>
        </div>
      ) : (
        <div className="flex items-center gap-3">
          <ButtonLink href="/login" variant="ghost">
            Log in
          </ButtonLink>
          <ButtonLink href="/signup" variant="primary">
            Sign up
          </ButtonLink>
        </div>
      )}
    </header>
  );
}
