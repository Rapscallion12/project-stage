const RULES = [
  {
    title: "Watch free, no account needed",
    body: "Join any live event as a guest — watch, react, and vote on what happens next.",
  },
  {
    title: "The audience controls the stage",
    body: "Continue, replace, or extend — every call is a live vote, not a host's decision.",
  },
  {
    title: "Great conversations earn more time",
    body: "There's no fixed slot. Engagement extends the clock; silence ends it.",
  },
  {
    title: "Anyone can earn the microphone",
    body: "Create an account to join the request queue. No invites, no gatekeeping.",
  },
  {
    title: "Reputation earns opportunity, not control",
    body: "A good track record moves you up the queue — it never buys extra votes.",
  },
] as const;

export function HowItWorks() {
  return (
    <section id="how-it-works" className="mx-auto max-w-4xl px-6 py-16 scroll-mt-20">
      <h2 className="mb-10 text-center text-sm font-medium tracking-wide text-muted">
        HOW IT WORKS
      </h2>
      <div className="grid gap-8 sm:grid-cols-2">
        {RULES.map((rule) => (
          <div key={rule.title}>
            <h3 className="mb-2 text-base font-semibold">{rule.title}</h3>
            <p className="text-sm text-muted">{rule.body}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
