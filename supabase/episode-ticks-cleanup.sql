-- Removes episode diary rows created by filling in a finished show's episodes
-- after the fact (before the app stopped dating those ticks): they made it
-- look like you watched everything on the day you ticked them.
--
-- Only rows that match all of these go:
--   - the show is finished (Watched or Rewatched),
--   - the row is dated after you finished it (after the rewatch, for rewatches),
--   - 5 or more of that show's episode rows share that same day.
-- Episodes ticked while you were actually watching the show are untouched,
-- and so are the ticks themselves (watched_episodes) — only the diary rows go.
--
-- Run on the live project on 2026-11-16 (one-off; data only).
--
-- Step 1: PREVIEW. Run just this SELECT first to see what would be removed.

select m.title, l.watched_on, count(*) as episode_rows
from public.entry_logs l
join public.entries e on e.id = l.entry_id
join public.media m on m.id = e.media_id
where l.episode_id is not null
  and e.status in ('completed', 'rewatched')
  and l.watched_on > coalesce(greatest(e.date_finished, e.date_rewatched), '-infinity'::date)
group by m.title, l.watched_on
having count(*) >= 5
order by m.title, l.watched_on;

-- Step 2: DELETE. When the preview looks right, run this.

delete from public.entry_logs l
using public.entries e
where e.id = l.entry_id
  and l.episode_id is not null
  and e.status in ('completed', 'rewatched')
  and l.watched_on > coalesce(greatest(e.date_finished, e.date_rewatched), '-infinity'::date)
  and (select count(*) from public.entry_logs l2
       where l2.entry_id = l.entry_id and l2.episode_id is not null and l2.watched_on = l.watched_on) >= 5;
