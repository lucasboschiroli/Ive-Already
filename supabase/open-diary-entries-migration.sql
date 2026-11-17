-- One diary entry per watch-through for shows, books and games: it opens when
-- you start and closes when you finish, so the diary reads "2 Nov -> 15 Nov"
-- (and "watching since 2 Nov" while you're still going).
--
-- An open entry is a whole-title entry_logs row with a start date and no
-- finish date (started_on set, watched_on null). A trigger on entries keeps it
-- in step with the status, so every path counts — the status menu, ticking
-- episodes, "I've watched N episodes", book page progress, other devices:
--   - becomes Watching / Reading / Playing  -> opens one, if none is open.
--     Starting again after finishing opens a new one marked as a rewatch.
--   - becomes Watched / Read / Played / Rewatched -> closes the open one with
--     the finish date (or today when the title's dates are older than its start).
--   - Dropped leaves it open; the app shows it as dropped.
-- Movies are untouched: one dated row per viewing, as before.
-- The app's log window closes the open entry itself when you log a finish,
-- so the trigger finds nothing left to close in that case.
--
-- Also opens an entry now for every show/book/game you're in the middle of.
--
-- Run once in the Supabase SQL editor. Safe to re-run.

create or replace function public.entries_sync_open_log() returns trigger
    language plpgsql security definer
    set search_path to 'public'
as $$
declare
    v_type text;
    v_open public.entry_logs%rowtype;
    v_has_logs boolean;
    v_today date := (now() at time zone 'UTC')::date;
begin
    if tg_op = 'UPDATE' and new.status is not distinct from old.status then return new; end if;
    select media_type into v_type from public.media where id = new.media_id;
    if v_type is null or v_type = 'movie' then return new; end if;

    select * into v_open from public.entry_logs
        where entry_id = new.id and episode_id is null and watched_on is null and started_on is not null
        order by id desc limit 1;

    if new.status = 'in_progress' then
        if v_open.id is null then
            select exists (select 1 from public.entry_logs where entry_id = new.id and episode_id is null) into v_has_logs;
            -- A finish that only lived on the title becomes a real diary row first,
            -- so starting again doesn't hide it.
            if not v_has_logs and new.date_finished is not null then
                insert into public.entry_logs (entry_id, watched_on, started_on, is_rewatch)
                values (new.id, new.date_finished, null, false);
                v_has_logs := true;
            end if;
            -- The title's start date if it belongs to this watch-through, else today.
            insert into public.entry_logs (entry_id, watched_on, started_on, is_rewatch)
            values (new.id, null,
                    coalesce(case when new.date_finished is null or new.date_started > new.date_finished then new.date_started end, v_today),
                    v_has_logs);
        end if;
    elsif new.status in ('completed', 'rewatched') and v_open.id is not null then
        update public.entry_logs set watched_on = case
                when new.date_rewatched >= v_open.started_on then new.date_rewatched
                when new.date_finished >= v_open.started_on then new.date_finished
                else greatest(v_today, v_open.started_on)
            end
        where id = v_open.id;
    end if;
    return new;
end $$;

drop trigger if exists entries_sync_open_log_trg on public.entries;
create trigger entries_sync_open_log_trg after insert or update of status on public.entries
    for each row execute function public.entries_sync_open_log();

-- ---------- titles you're in the middle of right now ----------

-- Keep an earlier finish as a diary row (e.g. a show you're watching again).
insert into public.entry_logs (entry_id, watched_on, started_on, is_rewatch)
select e.id, e.date_finished, null, false
from public.entries e
join public.media m on m.id = e.media_id
where m.media_type <> 'movie'
  and e.status = 'in_progress'
  and e.date_finished is not null
  and not exists (select 1 from public.entry_logs l where l.entry_id = e.id and l.episode_id is null);

insert into public.entry_logs (entry_id, watched_on, started_on, is_rewatch)
select e.id, null,
       coalesce(case when e.date_finished is null or e.date_started > e.date_finished then e.date_started end, e.created_at::date),
       exists (select 1 from public.entry_logs l where l.entry_id = e.id and l.episode_id is null)
from public.entries e
join public.media m on m.id = e.media_id
where m.media_type <> 'movie'
  and e.status = 'in_progress'
  and not exists (select 1 from public.entry_logs l
                  where l.entry_id = e.id and l.episode_id is null and l.watched_on is null and l.started_on is not null);
