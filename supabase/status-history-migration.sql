-- Status history: every time a title's status changes (added to the
-- watchlist, started, dropped, finished, rewatched), keep a row with when it
-- happened, so the Diary and the activity window can show the whole story —
-- not just the finish dates the diary logs.
--
--   - A trigger on entries records the changes, so every path counts: the
--     status menu, ticking episodes, imports, other devices. The app never
--     inserts these rows itself.
--   - happened_at is a real timestamp (UTC); the app shows it in local time,
--     so a change late at night lands on the right day.
--   - You can re-date or delete your own events (fixing a wrong date), and
--     only the date: the column grant below keeps status/entry fixed.
--   - Existing titles get a starting history from dates already stored:
--     "Started" from date_started, and "Watchlist" for titles still planned.
--     Nothing older than that can be recovered.
--
-- Run once in the Supabase SQL editor. Safe to re-run.

create table if not exists public.status_events (
    id bigint generated always as identity primary key,
    entry_id bigint not null references public.entries(id) on delete cascade,
    user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
    status text not null check (status in ('planned', 'in_progress', 'completed', 'dropped', 'rewatched')),
    happened_at timestamptz not null default now()
);
create index if not exists status_events_entry_idx on public.status_events (entry_id, happened_at);
create index if not exists status_events_user_idx on public.status_events (user_id, happened_at);

alter table public.status_events enable row level security;

drop policy if exists "status_events select own" on public.status_events;
drop policy if exists "status_events update own" on public.status_events;
drop policy if exists "status_events delete own" on public.status_events;
create policy "status_events select own" on public.status_events for select to authenticated using (user_id = auth.uid());
create policy "status_events update own" on public.status_events for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "status_events delete own" on public.status_events for delete to authenticated using (user_id = auth.uid());

-- No insert grant: only the trigger creates events. Updates may only re-date one.
revoke insert, update on public.status_events from anon, authenticated;
grant select, delete on public.status_events to authenticated;
grant update (happened_at) on public.status_events to authenticated;

create or replace function public.entries_record_status() returns trigger
    language plpgsql security definer
    set search_path to 'public'
as $$
begin
    if tg_op = 'INSERT' or new.status is distinct from old.status then
        insert into public.status_events (entry_id, user_id, status) values (new.id, new.user_id, new.status);
    end if;
    return new;
end $$;

drop trigger if exists entries_record_status_trg on public.entries;
create trigger entries_record_status_trg after insert or update of status on public.entries
    for each row execute function public.entries_record_status();

-- Starting history for titles that existed before this migration. Dates are
-- placed at noon UTC so they show as that same day in the Americas and Europe.
insert into public.status_events (entry_id, user_id, status, happened_at)
select e.id, e.user_id, 'in_progress', (e.date_started::timestamp + interval '12 hours') at time zone 'UTC'
from public.entries e
where e.date_started is not null
  and not exists (select 1 from public.status_events s where s.entry_id = e.id and s.status = 'in_progress');

insert into public.status_events (entry_id, user_id, status, happened_at)
select e.id, e.user_id, 'planned', coalesce(e.queued_at, e.created_at)
from public.entries e
where e.status = 'planned'
  and not exists (select 1 from public.status_events s where s.entry_id = e.id and s.status = 'planned');
