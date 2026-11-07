-- Stops signed-in accounts from rewriting the shared title cache directly.
--
-- Until now any account could UPDATE any row in `media` (title, poster,
-- overview, ratings…) — and everyone sees that cache. After this:
--   - Direct INSERT/UPDATE on media is no longer allowed. All writes go
--     through three functions the app calls instead:
--       media_upsert(p)                    add a title, or refresh it at most
--                                          every 12 hours
--       media_set_episode_counts(id, s, e) refresh a show's counts, same limit
--       media_set_ratings(id, p)           IMDb / RT numbers, at most every 6 days
--   - A trigger checks every write: images must be TMDB paths or come from
--     the cover/art hosts the app uses, text fields have sane length limits,
--     numbers stay in range, and a row can never change which title it is.
--   - episodes and season_meta stay writable (new episodes and season art
--     have to be cacheable), but go through the same kind of checks.
--
-- This limits the damage a modified client can do (no foreign images, no
-- huge text, no rapid repeated rewrites) — it can't prove the data really
-- came from TMDB. Only server-side fetching could do that.
--
-- Run once in the Supabase SQL editor. Safe to re-run. Run it BEFORE using
-- an app build that calls media_upsert (older builds stop being able to
-- refresh cached titles once this is applied).

-- ---------- validation ----------

create or replace function public.media_image_ok(p text) returns boolean
    language sql immutable
as $$
    select p is null or p = ''
        or p ~ '^/[A-Za-z0-9_-]+\.(jpg|jpeg|png|svg|webp)$'
        or p ~ '^https://(covers\.openlibrary\.org|media\.rawg\.io|(cdn|shared)\.akamai\.steamstatic\.com)/[^\s"''<>]*$';
$$;

create or replace function public.media_validate() returns trigger
    language plpgsql
as $$
begin
    if tg_op = 'UPDATE' and (new.tmdb_id <> old.tmdb_id or new.media_type <> old.media_type) then
        raise exception 'A cached title cannot change which title it is';
    end if;
    if coalesce(length(new.title), 0) = 0 or length(new.title) > 500 then
        raise exception 'Invalid title';
    end if;
    if length(new.original_title) > 500 or length(new.overview) > 20000 or length(new.release_date) > 32
        or length(new.genres) > 10000 or length(new.raw_json) > 2000000
        or length(new.awards_text) > 1000 or length(new.imdb_votes) > 20 then
        raise exception 'A cached title field is too long';
    end if;
    if not public.media_image_ok(new.poster_path) or not public.media_image_ok(new.backdrop_path) then
        raise exception 'Images must come from TMDB, Open Library, RAWG or Steam';
    end if;
    if new.imdb_id is not null and new.imdb_id <> '' and new.imdb_id !~ '^tt[0-9]{1,12}$' then
        raise exception 'Invalid IMDb id';
    end if;
    if new.runtime not between 0 and 100000 or new.number_of_seasons not between 0 and 1000
        or new.number_of_episodes not between 0 and 100000 or new.tmdb_vote_average not between 0 and 10
        or new.imdb_rating not between 0 and 10 or new.rt_tomatometer not between 0 and 100 then
        raise exception 'A cached title number is out of range';
    end if;
    return new;
end $$;

drop trigger if exists media_validate_trg on public.media;
create trigger media_validate_trg before insert or update on public.media
    for each row execute function public.media_validate();

create or replace function public.episodes_validate() returns trigger
    language plpgsql
as $$
begin
    if tg_op = 'UPDATE' and (new.media_id <> old.media_id or new.season_number <> old.season_number
        or new.episode_number <> old.episode_number) then
        raise exception 'A cached episode cannot change which episode it is';
    end if;
    if length(new.name) > 500 or (new.air_date is not null and new.air_date <> '' and new.air_date !~ '^\d{4}-\d{2}-\d{2}$') then
        raise exception 'Invalid episode data';
    end if;
    return new;
end $$;

drop trigger if exists episodes_validate_trg on public.episodes;
create trigger episodes_validate_trg before insert or update on public.episodes
    for each row execute function public.episodes_validate();

create or replace function public.season_meta_validate() returns trigger
    language plpgsql
as $$
begin
    if tg_op = 'UPDATE' and (new.media_id <> old.media_id or new.season_number <> old.season_number) then
        raise exception 'Cached season art cannot change which season it is';
    end if;
    if length(new.name) > 500 or not public.media_image_ok(new.poster_path) then
        raise exception 'Invalid season data';
    end if;
    return new;
end $$;

drop trigger if exists season_meta_validate_trg on public.season_meta;
create trigger season_meta_validate_trg before insert or update on public.season_meta
    for each row execute function public.season_meta_validate();

-- ---------- writes go through functions ----------

drop policy if exists "media writable by authenticated users" on public.media;
drop policy if exists "media updatable by authenticated users" on public.media;

create or replace function public.media_upsert(p jsonb) returns bigint
    language plpgsql security definer
    set search_path to 'public'
as $$
declare v_id bigint; v_cached timestamptz;
begin
    if auth.uid() is null then raise exception 'Not signed in'; end if;
    select id, cached_at into v_id, v_cached from public.media
        where tmdb_id = (p->>'tmdb_id')::int and media_type = p->>'media_type';
    if v_id is null then
        insert into public.media (tmdb_id, media_type, title, original_title, poster_path, backdrop_path, release_date,
            overview, runtime, number_of_seasons, number_of_episodes, genres, tmdb_vote_average, raw_json)
        values ((p->>'tmdb_id')::int, p->>'media_type', p->>'title', p->>'original_title', p->>'poster_path',
            p->>'backdrop_path', p->>'release_date', p->>'overview', (p->>'runtime')::numeric::int,
            (p->>'number_of_seasons')::numeric::int, (p->>'number_of_episodes')::numeric::int, p->>'genres',
            (p->>'tmdb_vote_average')::real, p->>'raw_json')
        on conflict (tmdb_id, media_type) do nothing
        returning id into v_id;
        if v_id is null then -- another account cached it at the same moment
            select id into v_id from public.media where tmdb_id = (p->>'tmdb_id')::int and media_type = p->>'media_type';
        end if;
        return v_id;
    end if;
    if v_cached < now() - interval '12 hours' then
        update public.media set
            title = p->>'title', original_title = p->>'original_title', poster_path = p->>'poster_path',
            backdrop_path = p->>'backdrop_path', release_date = p->>'release_date', overview = p->>'overview',
            runtime = (p->>'runtime')::numeric::int, number_of_seasons = (p->>'number_of_seasons')::numeric::int,
            number_of_episodes = (p->>'number_of_episodes')::numeric::int, genres = p->>'genres',
            tmdb_vote_average = (p->>'tmdb_vote_average')::real, raw_json = p->>'raw_json', cached_at = now()
        where id = v_id;
    end if;
    return v_id;
end $$;

create or replace function public.media_set_episode_counts(p_id bigint, p_seasons int, p_episodes int) returns void
    language plpgsql security definer
    set search_path to 'public'
as $$
begin
    if auth.uid() is null then raise exception 'Not signed in'; end if;
    update public.media set number_of_seasons = p_seasons, number_of_episodes = p_episodes, cached_at = now()
        where id = p_id and media_type = 'tv' and cached_at < now() - interval '12 hours';
end $$;

create or replace function public.media_set_ratings(p_id bigint, p jsonb) returns void
    language plpgsql security definer
    set search_path to 'public'
as $$
begin
    if auth.uid() is null then raise exception 'Not signed in'; end if;
    update public.media set
        imdb_id = p->>'imdb_id', imdb_rating = (p->>'imdb_rating')::real, imdb_votes = p->>'imdb_votes',
        rt_tomatometer = (p->>'rt_tomatometer')::numeric::int, awards_text = p->>'awards', ratings_checked_at = now()
    where id = p_id and (ratings_checked_at is null or ratings_checked_at < now() - interval '6 days');
end $$;

revoke all on function public.media_upsert(jsonb) from public, anon;
revoke all on function public.media_set_episode_counts(bigint, int, int) from public, anon;
revoke all on function public.media_set_ratings(bigint, jsonb) from public, anon;
grant execute on function public.media_upsert(jsonb) to authenticated;
grant execute on function public.media_set_episode_counts(bigint, int, int) to authenticated;
grant execute on function public.media_set_ratings(bigint, jsonb) to authenticated;
