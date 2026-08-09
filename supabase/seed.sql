-- Dev/demo data only — NOT a migration. There's no event-creation UI yet
-- (out of scope for this milestone; events are seeded directly), so this
-- gives the app something real to browse. Safe to re-run: it always
-- inserts fresh rows relative to `now()`, so times stay realistic no
-- matter when you run it. Run this manually in the Supabase SQL Editor
-- after applying the migrations, same as the migrations themselves.
insert into public.events (title, description, scheduled_start, lobby_opens_at)
values
  (
    'Strangers, Unscripted',
    'Two people who have never met sit down for an open conversation, live — the audience decides where it goes next.',
    now() + interval '10 minutes',
    now() - interval '5 minutes'
  ),
  (
    'Founders, Unfiltered',
    'Two early-stage founders talk shop in front of a live audience.',
    now() + interval '6 hours',
    now() + interval '6 hours' - interval '30 minutes'
  ),
  (
    'Late Night Debate: Pineapple on Pizza',
    'A deliberately lighthearted prototype test event.',
    now() + interval '2 days',
    now() + interval '2 days' - interval '30 minutes'
  );
