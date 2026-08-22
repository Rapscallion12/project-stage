import Link from "next/link";
import { ButtonLink } from "@/components/ui/button";

export function Hero() {
  return (
    <section className="mx-auto flex max-w-3xl flex-col items-center px-6 py-16 text-center sm:py-24">
      <p className="mb-4 text-sm font-medium tracking-wide text-accent">
        A LIVE SOCIAL EXPERIMENT
      </p>
      <h1 className="text-3xl font-semibold tracking-tight sm:text-5xl">
        Strangers talk. The audience decides what happens next.
      </h1>
      <p className="mt-6 max-w-xl text-base text-muted sm:text-lg">
        Two people, one live conversation, and a crowd that controls the
        stage — who stays, who&apos;s next, and how long it runs.
      </p>
      {/* No account required to watch — see PRODUCT.md's progressive authentication model. */}
      <div className="mt-10 flex w-full flex-col items-center gap-3 sm:w-auto sm:flex-row sm:gap-4">
        <div className="flex w-full flex-col items-center gap-1.5 sm:w-auto">
          {/* One-click direct-to-room fast path (issue #26) — a plain GET
              redirect (/join), not a page: no intermediate confirmation
              screen, no account requirement, lands as audience. "Join Live
              Audience", not "Join Now" — the latter reads as signup/
              registration/speaker-join, not "watch what's happening now". */}
          <ButtonLink href="/join" className="w-full sm:w-auto">
            Join Live Audience
          </ButtonLink>
          <p className="text-xs text-muted">Jump straight into an active room</p>
        </div>
        <ButtonLink href="/events" variant="secondary" className="w-full sm:w-auto">
          Browse events
        </ButtonLink>
      </div>
      <ButtonLink href="#how-it-works" variant="ghost" className="mt-3">
        See how it works
      </ButtonLink>
      <p className="mt-6 text-sm text-muted">
        No account needed to watch.{" "}
        <Link href="/signup" className="text-accent hover:underline">
          Create an account
        </Link>{" "}
        to request the mic, comment, and start building reputation.
      </p>
    </section>
  );
}
