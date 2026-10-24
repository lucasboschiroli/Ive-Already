-- I've Already — Supabase (Postgres) schema
-- Run this in the Supabase SQL Editor for your project (ekswnfwrntjkizglqwjl).
--
-- Design:
-- - `media` and `episodes` are a SHARED cache (TMDB data isn't personal —
--   the same movie/show details apply to every account, no point duplicating
--   them per user). Any authenticated user can read/write this cache.
-- - `entries`, `watched_episodes`, `lists`, `list_items` are PERSONAL —
--   Row Level Security ensures an account can only ever see or modify its
--   own rows. This is enforced at the database level, not just in app code,
--   so even a bug in the client can't leak one account's data to another.
-- - There's no custom `users` table — Supabase Auth's built-in `auth.users`
--   is the source of truth for accounts. `entries.user_id` references it.

-- ---------- media (shared cache) ----------

create table if not exists media (
    id bigint generated always as identity primary key,
    tmdb_id integer not null,
    media_type text not null check (media_type in ('movie', 'tv', 'book', 'game')),
    title text not null,
    original_title text,
    poster_path text,
    backdrop_path text,
    release_date text,
    overview text,
    runtime integer,
    number_of_seasons integer,
    number_of_episodes integer,
    genres text,
    tmdb_vote_average real,
    raw_json text,
    cached_at timestamptz not null default now(),
    unique (tmdb_id, media_type)
);

alter table media enable row level security;

create policy "media readable by authenticated users"
    on media for select
    using (auth.role() = 'authenticated');

create policy "media writable by authenticated users"
    on media for insert
    with check (auth.role() = 'authenticated');

create policy "media updatable by authenticated users"
    on media for update
    using (auth.role() = 'authenticated');

-- ---------- entries (personal — status, rating, review, dates) ----------

create table if not exists entries (
    id bigint generated always as identity primary key,
    user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
    media_id bigint not null references media(id) on delete cascade,
    status text not null default 'planned'
        check (status in ('planned', 'in_progress', 'completed', 'dropped', 'rewatched')),
    rating integer,
    review text,
    is_favorite boolean not null default false,
    date_started date,
    date_finished date,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (user_id, media_id)
);

alter table entries enable row level security;

create policy "entries select own" on entries for select using (auth.uid() = user_id);
create policy "entries insert own" on entries for insert with check (auth.uid() = user_id);
create policy "entries update own" on entries for update using (auth.uid() = user_id);
create policy "entries delete own" on entries for delete using (auth.uid() = user_id);

-- keep updated_at current on every UPDATE
create or replace function set_updated_at()
returns trigger as $$
begin
    new.updated_at = now();
    return new;
end;
$$ language plpgsql;

create trigger entries_set_updated_at
    before update on entries
    for each row execute function set_updated_at();

-- ---------- episodes (shared cache, like media) ----------

create table if not exists episodes (
    id bigint generated always as identity primary key,
    media_id bigint not null references media(id) on delete cascade,
    season_number integer not null,
    episode_number integer not null,
    name text,
    air_date text,
    unique (media_id, season_number, episode_number)
);

alter table episodes enable row level security;

create policy "episodes readable by authenticated users"
    on episodes for select
    using (auth.role() = 'authenticated');

create policy "episodes writable by authenticated users"
    on episodes for insert
    with check (auth.role() = 'authenticated');

-- ---------- watched_episodes (personal, via entry ownership) ----------

create table if not exists watched_episodes (
    id bigint generated always as identity primary key,
    entry_id bigint not null references entries(id) on delete cascade,
    episode_id bigint not null references episodes(id) on delete cascade,
    watched_at timestamptz not null default now(),
    unique (entry_id, episode_id)
);

alter table watched_episodes enable row level security;

create policy "watched_episodes select via entry ownership"
    on watched_episodes for select
    using (exists (select 1 from entries e where e.id = entry_id and e.user_id = auth.uid()));

create policy "watched_episodes insert via entry ownership"
    on watched_episodes for insert
    with check (exists (select 1 from entries e where e.id = entry_id and e.user_id = auth.uid()));

create policy "watched_episodes delete via entry ownership"
    on watched_episodes for delete
    using (exists (select 1 from entries e where e.id = entry_id and e.user_id = auth.uid()));

-- ---------- lists / list_items (personal) ----------

create table if not exists lists (
    id bigint generated always as identity primary key,
    user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
    name text not null,
    description text,
    created_at timestamptz not null default now()
);

alter table lists enable row level security;

create policy "lists select own" on lists for select using (auth.uid() = user_id);
create policy "lists insert own" on lists for insert with check (auth.uid() = user_id);
create policy "lists update own" on lists for update using (auth.uid() = user_id);
create policy "lists delete own" on lists for delete using (auth.uid() = user_id);

create table if not exists list_items (
    id bigint generated always as identity primary key,
    list_id bigint not null references lists(id) on delete cascade,
    media_id bigint not null references media(id) on delete cascade,
    added_at timestamptz not null default now(),
    unique (list_id, media_id)
);

alter table list_items enable row level security;

create policy "list_items select via list ownership"
    on list_items for select
    using (exists (select 1 from lists l where l.id = list_id and l.user_id = auth.uid()));

create policy "list_items insert via list ownership"
    on list_items for insert
    with check (exists (select 1 from lists l where l.id = list_id and l.user_id = auth.uid()));

create policy "list_items delete via list ownership"
    on list_items for delete
    using (exists (select 1 from lists l where l.id = list_id and l.user_id = auth.uid()));

-- ---------- indexes ----------

create index if not exists idx_entries_user_status on entries(user_id, status);
create index if not exists idx_media_type on media(media_type);
create index if not exists idx_episodes_media on episodes(media_id, season_number);
create index if not exists idx_list_items_list on list_items(list_id);
