-- Backfills the diary and the status history for titles that existed before
-- those features, from the dates already stored on each title, so every
-- title's "Your activity" and the Diary page show its whole story.
--
--   Diary rows (entry_logs), only for titles that have none yet:
--     - one row on date_finished (shows, books and games keep date_started on it)
--     - one rewatch row on date_rewatched
--   Status history (status_events), only where that kind of moment is missing:
--     - added to the watchlist at queued_at
--     - started at date_started (status-history-migration.sql did this once;
--       repeated for titles started since without an event)
--     - dropped at date_finished (the status menu fills it in when dropping),
--       else at the last update
--
-- Day-only dates are placed at noon UTC, so they show as that same day in the
-- Americas and Europe. Nothing is overwritten and nothing is deleted.
--
-- Run once in the Supabase SQL editor. Safe to re-run: every insert checks
-- that the row it would add doesn't exist yet.
-- Applied to the live project on 2026-11-13 (data only — schema.sql unchanged).

-- ---------- diary rows ----------

insert into public.entry_logs (entry_id, watched_on, started_on, is_rewatch)
select e.id, e.date_finished, case when m.media_type <> 'movie' then e.date_started end, false
from public.entries e
join public.media m on m.id = e.media_id
where e.date_finished is not null
  and e.status in ('completed', 'rewatched')
  and not exists (select 1 from public.entry_logs l where l.entry_id = e.id and l.episode_id is null);

-- The rewatch row is checked separately: the insert above has just given these
-- titles a first row, so "no rows yet" would wrongly skip them.
insert into public.entry_logs (entry_id, watched_on, started_on, is_rewatch)
select e.id, e.date_rewatched, null, true
from public.entries e
where e.date_rewatched is not null
  and e.status = 'rewatched'
  and not exists (select 1 from public.entry_logs l where l.entry_id = e.id and l.episode_id is null and l.is_rewatch);

-- ---------- status history ----------

insert into public.status_events (entry_id, user_id, status, happened_at)
select e.id, e.user_id, 'planned', e.queued_at
from public.entries e
where e.queued_at is not null
  and not exists (select 1 from public.status_events s where s.entry_id = e.id and s.status = 'planned');

insert into public.status_events (entry_id, user_id, status, happened_at)
select e.id, e.user_id, 'in_progress', (e.date_started::timestamp + interval '12 hours') at time zone 'UTC'
from public.entries e
where e.date_started is not null
  and not exists (select 1 from public.status_events s where s.entry_id = e.id and s.status = 'in_progress');

insert into public.status_events (entry_id, user_id, status, happened_at)
select e.id, e.user_id, 'dropped',
       coalesce((e.date_finished::timestamp + interval '12 hours') at time zone 'UTC', e.updated_at)
from public.entries e
where e.status = 'dropped'
  and not exists (select 1 from public.status_events s where s.entry_id = e.id and s.status = 'dropped');
