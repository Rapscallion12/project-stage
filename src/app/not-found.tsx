import Link from "next/link";
import { ButtonLink } from "@/components/ui/button";

export default function NotFound() {
  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col items-center justify-center px-6 py-16 text-center">
      <h1 className="mb-2 text-2xl font-semibold">Page not found</h1>
      <p className="mb-8 text-sm text-muted">
        Whatever you were looking for isn&apos;t here — it may have been a bad
        link, or the event may no longer exist.
      </p>
      <div className="flex flex-col gap-3 sm:flex-row">
        <ButtonLink href="/events">Browse events</ButtonLink>
        <Link
          href="/"
          className="flex items-center justify-center text-sm text-muted hover:underline"
        >
          Back to home
        </Link>
      </div>
    </main>
  );
}
