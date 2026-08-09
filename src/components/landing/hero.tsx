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
        <ButtonLink href="/events" className="w-full sm:w-auto">
          Browse events
        </ButtonLink>
        <ButtonLink href="#how-it-works" variant="secondary" className="w-full sm:w-auto">
          See how it works
        </ButtonLink>
      </div>
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
