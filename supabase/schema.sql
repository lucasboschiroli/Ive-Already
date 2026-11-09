-- I've Already — Supabase schema (public schema only).
--
-- Generated from the live project with:
--   npx supabase db dump --remote=ekswnfwrntjkizglqwjl -s public -f supabase/schema.sql
-- Re-run that after any database change instead of editing this file by hand
-- (re-dumping replaces this header, so add it back).
--
-- Not included in the dump, set up separately on a fresh project:
--   - Storage: a PUBLIC bucket named "avatars" (profile pictures and banners;
--     the app uploads to "<user id>/<file>" and uses getPublicUrl), plus its
--     storage policies.
--   - Any migration in supabase/*-migration.sql that hasn't been run on the
--     live project yet (check each file's header).

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


CREATE SCHEMA IF NOT EXISTS "public";


ALTER SCHEMA "public" OWNER TO "pg_database_owner";


COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE OR REPLACE FUNCTION "public"."can_view_list"("target_list_id" bigint) RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
    select auth.uid() is not null and exists (
        select 1 from public.lists l
        where l.id = target_list_id and (
            l.user_id = auth.uid()
            or l.is_official
            or l.visibility = 'public'
            or (l.visibility = 'friends' and exists (
                select 1 from public.user_follows f
                where f.follower_id = l.user_id and f.followee_id = auth.uid()))
            or exists (
                select 1 from public.list_shares s
                where s.list_id = l.id and s.shared_with_user_id = auth.uid())
        )
    );
$$;


ALTER FUNCTION "public"."can_view_list"("target_list_id" bigint) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."delete_my_account"() RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'auth'
    AS $$
begin
    if auth.uid() is null then raise exception 'Not signed in'; end if;
    delete from auth.users where id = auth.uid();
end;
$$;


ALTER FUNCTION "public"."delete_my_account"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."ensure_favorites_list"("p_user" "uuid") RETURNS bigint
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $_$
declare v_id bigint; v_gtype text;
begin
  select id into v_id from public.lists where user_id = p_user and is_favorites limit 1;
  if v_id is not null then return v_id; end if;
  select data_type into v_gtype from information_schema.columns
    where table_schema = 'public' and table_name = 'lists' and column_name = 'genres';
  begin
    insert into public.lists (user_id, name, description, is_favorites)
    values (p_user, 'Favorite Titles', 'Everything you''ve marked with a heart.', true) returning id into v_id;
  exception when not_null_violation then
    execute format('insert into public.lists (user_id, name, description, is_favorites, genres) values ($1, $2, $3, true, %s) returning id',
      case v_gtype when 'jsonb' then '''[]''::jsonb' when 'ARRAY' then '''{}''::text[]' else '''[]''' end)
      into v_id using p_user, 'Favorite Titles', 'Everything you''ve marked with a heart.';
  end;
  return v_id;
end $_$;


ALTER FUNCTION "public"."ensure_favorites_list"("p_user" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."entries_sync_favorites"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare v_list bigint; v_pos int;
begin
  if tg_op = 'DELETE' then
    select id into v_list from public.lists where user_id = old.user_id and is_favorites;
    if v_list is not null then delete from public.list_items where list_id = v_list and media_id = old.media_id; end if;
    return old;
  end if;
  if tg_op = 'UPDATE' and new.is_favorite is not distinct from old.is_favorite then return new; end if;
  if coalesce(new.is_favorite, false) then
    v_list := public.ensure_favorites_list(new.user_id);
    select coalesce(max(position), 0) + 1 into v_pos from public.list_items where list_id = v_list;
    insert into public.list_items (list_id, media_id, position) values (v_list, new.media_id, v_pos)
      on conflict (list_id, media_id) do nothing;
  else
    select id into v_list from public.lists where user_id = new.user_id and is_favorites;
    if v_list is not null then delete from public.list_items where list_id = v_list and media_id = new.media_id; end if;
  end if;
  return new;
end $$;


ALTER FUNCTION "public"."entries_sync_favorites"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."episodes_validate"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $_$
begin
    if tg_op = 'UPDATE' and (new.media_id <> old.media_id or new.season_number <> old.season_number
        or new.episode_number <> old.episode_number) then
        raise exception 'A cached episode cannot change which episode it is';
    end if;
    if length(new.name) > 500 or (new.air_date is not null and new.air_date <> '' and new.air_date !~ '^\d{4}-\d{2}-\d{2}$') then
        raise exception 'Invalid episode data';
    end if;
    return new;
end $_$;


ALTER FUNCTION "public"."episodes_validate"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_family_peer"("uid" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select exists (
    select 1 from public.family_members a
    join public.family_members b on a.family_id = b.family_id
    where a.user_id = auth.uid() and b.user_id = uid and a.user_id <> b.user_id
  );
$$;


ALTER FUNCTION "public"."is_family_peer"("uid" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_list_owner"("target_list_id" bigint) RETURNS boolean
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select exists (select 1 from lists where id = target_list_id and user_id = auth.uid());
$$;


ALTER FUNCTION "public"."is_list_owner"("target_list_id" bigint) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."list_is_official"("p_list_id" bigint) RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select exists (select 1 from public.lists l where l.id = p_list_id and l.is_official);
$$;


ALTER FUNCTION "public"."list_is_official"("p_list_id" bigint) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."list_social_can_view"("p_list_id" bigint) RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
    select public.can_view_list(p_list_id);
$$;


ALTER FUNCTION "public"."list_social_can_view"("p_list_id" bigint) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."list_social_is_owner"("p_list_id" bigint) RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select exists (select 1 from public.lists l where l.id = p_list_id and l.user_id = auth.uid());
$$;


ALTER FUNCTION "public"."list_social_is_owner"("p_list_id" bigint) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."lists_drop_link_shares"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
    if old.visibility = 'link' and new.visibility <> 'link' then
        delete from public.list_shares where list_id = new.id and via_link;
    end if;
    return new;
end $$;


ALTER FUNCTION "public"."lists_drop_link_shares"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."lists_guard_official"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  if auth.uid() is not null and new.is_official and (tg_op = 'INSERT' or old.is_official is distinct from new.is_official) then
    raise exception 'is_official can only be set by an administrator';
  end if;
  return new;
end $$;


ALTER FUNCTION "public"."lists_guard_official"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."media_image_ok"("p" "text") RETURNS boolean
    LANGUAGE "sql" IMMUTABLE
    AS $_$
    select p is null or p = ''
        or p ~ '^/[A-Za-z0-9_-]+\.(jpg|jpeg|png|svg|webp)$'
        or p ~ '^https://(covers\.openlibrary\.org|media\.rawg\.io|(cdn|shared)\.akamai\.steamstatic\.com)/[^\s"''<>]*$';
$_$;


ALTER FUNCTION "public"."media_image_ok"("p" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."media_set_episode_counts"("p_id" bigint, "p_seasons" integer, "p_episodes" integer) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
    if auth.uid() is null then raise exception 'Not signed in'; end if;
    update public.media set number_of_seasons = p_seasons, number_of_episodes = p_episodes, cached_at = now()
        where id = p_id and media_type = 'tv' and cached_at < now() - interval '12 hours';
end $$;


ALTER FUNCTION "public"."media_set_episode_counts"("p_id" bigint, "p_seasons" integer, "p_episodes" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."media_set_ratings"("p_id" bigint, "p" "jsonb") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
    if auth.uid() is null then raise exception 'Not signed in'; end if;
    update public.media set
        imdb_id = p->>'imdb_id', imdb_rating = (p->>'imdb_rating')::real, imdb_votes = p->>'imdb_votes',
        rt_tomatometer = (p->>'rt_tomatometer')::numeric::int, awards_text = p->>'awards', ratings_checked_at = now()
    where id = p_id and (ratings_checked_at is null or ratings_checked_at < now() - interval '6 days');
end $$;


ALTER FUNCTION "public"."media_set_ratings"("p_id" bigint, "p" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."media_upsert"("p" "jsonb") RETURNS bigint
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
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


ALTER FUNCTION "public"."media_upsert"("p" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."media_validate"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $_$
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
end $_$;


ALTER FUNCTION "public"."media_validate"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."my_family_id"() RETURNS bigint
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
    select family_id from family_members where user_id = auth.uid() limit 1
$$;


ALTER FUNCTION "public"."my_family_id"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."my_favorites_list"() RETURNS bigint
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select public.ensure_favorites_list(auth.uid());
$$;


ALTER FUNCTION "public"."my_favorites_list"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."official_add_item"("p_list_id" bigint, "p_media_id" bigint) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare v_pos int;
begin
  if not public.official_is_admin() then raise exception 'not allowed'; end if;
  if not exists (select 1 from public.lists where id = p_list_id and is_official) then raise exception 'not an official list'; end if;
  select coalesce(max(position), 0) + 1 into v_pos from public.list_items where list_id = p_list_id;
  insert into public.list_items (list_id, media_id, position) values (p_list_id, p_media_id, v_pos)
    on conflict (list_id, media_id) do nothing;
  update public.lists set updated_at = now() where id = p_list_id;
end $$;


ALTER FUNCTION "public"."official_add_item"("p_list_id" bigint, "p_media_id" bigint) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."official_is_admin"() RETURNS boolean
    LANGUAGE "sql" STABLE
    AS $$
  select coalesce(auth.jwt() ->> 'email', '') in ('official@ivealready.app', 'lucasboschiroli2@gmail.com');
$$;


ALTER FUNCTION "public"."official_is_admin"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."open_shared_list"("p_token" "uuid") RETURNS bigint
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare l record;
begin
    if auth.uid() is null then raise exception 'Not signed in'; end if;
    select id, user_id, visibility into l from public.lists where share_token = p_token;
    if not found then raise exception 'This link doesn''t work anymore'; end if;
    if l.user_id = auth.uid() then return l.id; end if;
    if l.visibility = 'link' then
        insert into public.list_shares (list_id, shared_with_user_id, via_link)
            values (l.id, auth.uid(), true)
            on conflict (list_id, shared_with_user_id) do nothing;
        return l.id;
    end if;
    if public.can_view_list(l.id) then return l.id; end if;
    raise exception 'This list is private';
end $$;


ALTER FUNCTION "public"."open_shared_list"("p_token" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."season_meta_validate"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
    if tg_op = 'UPDATE' and (new.media_id <> old.media_id or new.season_number <> old.season_number) then
        raise exception 'Cached season art cannot change which season it is';
    end if;
    if length(new.name) > 500 or not public.media_image_ok(new.poster_path) then
        raise exception 'Invalid season data';
    end if;
    return new;
end $$;


ALTER FUNCTION "public"."season_meta_validate"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
    new.updated_at = now();
    return new;
end;
$$;


ALTER FUNCTION "public"."set_updated_at"() OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."entries" (
    "id" bigint NOT NULL,
    "user_id" "uuid" DEFAULT "auth"."uid"() NOT NULL,
    "media_id" bigint NOT NULL,
    "status" "text" DEFAULT 'planned'::"text" NOT NULL,
    "rating" integer,
    "review" "text",
    "is_favorite" boolean DEFAULT false NOT NULL,
    "date_started" "date",
    "date_finished" "date",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "date_rewatched" "date",
    "quick_saved" boolean DEFAULT false NOT NULL,
    "queued_at" timestamp with time zone,
    "queued_via" "text",
    "review_spoilers" boolean DEFAULT false NOT NULL,
    "current_page" integer,
    "page_total" integer,
    CONSTRAINT "entries_status_check" CHECK (("status" = ANY (ARRAY['planned'::"text", 'in_progress'::"text", 'completed'::"text", 'dropped'::"text", 'rewatched'::"text"])))
);


ALTER TABLE "public"."entries" OWNER TO "postgres";


ALTER TABLE "public"."entries" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."entries_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."entry_logs" (
    "id" bigint NOT NULL,
    "entry_id" bigint NOT NULL,
    "watched_on" "date",
    "started_on" "date",
    "is_rewatch" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "episode_id" bigint,
    "episode_label" "text"
);


ALTER TABLE "public"."entry_logs" OWNER TO "postgres";


ALTER TABLE "public"."entry_logs" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."entry_logs_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."episodes" (
    "id" bigint NOT NULL,
    "media_id" bigint NOT NULL,
    "season_number" integer NOT NULL,
    "episode_number" integer NOT NULL,
    "name" "text",
    "air_date" "text"
);


ALTER TABLE "public"."episodes" OWNER TO "postgres";


ALTER TABLE "public"."episodes" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."episodes_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."families" (
    "id" bigint NOT NULL,
    "owner_id" "uuid" NOT NULL,
    "name" "text" DEFAULT 'My Family'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."families" OWNER TO "postgres";


ALTER TABLE "public"."families" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."families_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."family_invites" (
    "id" bigint NOT NULL,
    "family_id" bigint NOT NULL,
    "invited_email" "text" NOT NULL,
    "invited_by" "uuid" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "family_invites_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'accepted'::"text", 'declined'::"text"])))
);


ALTER TABLE "public"."family_invites" OWNER TO "postgres";


ALTER TABLE "public"."family_invites" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."family_invites_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."family_members" (
    "id" bigint NOT NULL,
    "family_id" bigint NOT NULL,
    "user_id" "uuid" NOT NULL,
    "email" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."family_members" OWNER TO "postgres";


ALTER TABLE "public"."family_members" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."family_members_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."game_achievements" (
    "user_id" "uuid" DEFAULT "auth"."uid"() NOT NULL,
    "media_id" bigint NOT NULL,
    "achievement_id" bigint NOT NULL,
    "unlocked_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."game_achievements" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."list_clones" (
    "id" bigint NOT NULL,
    "list_id" bigint NOT NULL,
    "cloner_id" "uuid" NOT NULL,
    "new_list_id" bigint,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."list_clones" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."list_clones_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."list_clones_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."list_clones_id_seq" OWNED BY "public"."list_clones"."id";



CREATE TABLE IF NOT EXISTS "public"."list_comment_likes" (
    "comment_id" bigint NOT NULL,
    "user_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."list_comment_likes" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."list_comment_mutes" (
    "list_id" bigint NOT NULL,
    "user_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."list_comment_mutes" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."list_comments" (
    "id" bigint NOT NULL,
    "list_id" bigint NOT NULL,
    "user_id" "uuid" NOT NULL,
    "parent_id" bigint,
    "body" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "list_comments_body_check" CHECK ((("char_length"("body") >= 1) AND ("char_length"("body") <= 1000)))
);


ALTER TABLE "public"."list_comments" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."list_comments_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."list_comments_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."list_comments_id_seq" OWNED BY "public"."list_comments"."id";



CREATE TABLE IF NOT EXISTS "public"."list_items" (
    "id" bigint NOT NULL,
    "list_id" bigint NOT NULL,
    "media_id" bigint NOT NULL,
    "added_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "position" integer DEFAULT 0 NOT NULL,
    "note" "text",
    "show_on_profile" boolean DEFAULT true NOT NULL
);


ALTER TABLE "public"."list_items" OWNER TO "postgres";


ALTER TABLE "public"."list_items" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."list_items_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."list_likes" (
    "list_id" bigint NOT NULL,
    "user_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."list_likes" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."list_order" (
    "user_id" "uuid" NOT NULL,
    "list_id" bigint NOT NULL,
    "position" integer NOT NULL
);


ALTER TABLE "public"."list_order" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."list_shares" (
    "id" bigint NOT NULL,
    "list_id" bigint NOT NULL,
    "shared_with_user_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "via_link" boolean DEFAULT false NOT NULL
);


ALTER TABLE "public"."list_shares" OWNER TO "postgres";


ALTER TABLE "public"."list_shares" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."list_shares_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."lists" (
    "id" bigint NOT NULL,
    "user_id" "uuid" DEFAULT "auth"."uid"() NOT NULL,
    "name" "text" NOT NULL,
    "description" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "genres" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "is_ranked" boolean DEFAULT false NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "visibility" "text" DEFAULT 'private'::"text" NOT NULL,
    "is_official" boolean DEFAULT false NOT NULL,
    "is_favorites" boolean DEFAULT false NOT NULL,
    "share_token" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    CONSTRAINT "lists_visibility_check" CHECK (("visibility" = ANY (ARRAY['public'::"text", 'link'::"text", 'friends'::"text", 'private'::"text"])))
);


ALTER TABLE "public"."lists" OWNER TO "postgres";


ALTER TABLE "public"."lists" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."lists_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."media" (
    "id" bigint NOT NULL,
    "tmdb_id" integer NOT NULL,
    "media_type" "text" NOT NULL,
    "title" "text" NOT NULL,
    "original_title" "text",
    "poster_path" "text",
    "backdrop_path" "text",
    "release_date" "text",
    "overview" "text",
    "runtime" integer,
    "number_of_seasons" integer,
    "number_of_episodes" integer,
    "genres" "text",
    "tmdb_vote_average" real,
    "raw_json" "text",
    "cached_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "imdb_id" "text",
    "imdb_rating" real,
    "imdb_votes" "text",
    "rt_tomatometer" integer,
    "ratings_checked_at" timestamp with time zone,
    "awards_text" "text",
    CONSTRAINT "media_media_type_check" CHECK (("media_type" = ANY (ARRAY['movie'::"text", 'tv'::"text", 'book'::"text", 'game'::"text"])))
);


ALTER TABLE "public"."media" OWNER TO "postgres";


ALTER TABLE "public"."media" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."media_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."official_list_items" (
    "id" bigint NOT NULL,
    "list_id" bigint NOT NULL,
    "position" integer NOT NULL,
    "title" "text" NOT NULL,
    "alt_titles" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "year" integer,
    "tmdb_id" integer,
    "media_type" "text",
    "creator" "text"
);


ALTER TABLE "public"."official_list_items" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."official_list_items_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."official_list_items_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."official_list_items_id_seq" OWNED BY "public"."official_list_items"."id";



CREATE TABLE IF NOT EXISTS "public"."official_lists" (
    "id" bigint NOT NULL,
    "slug" "text" NOT NULL,
    "name" "text" NOT NULL,
    "description" "text",
    "position" integer DEFAULT 0 NOT NULL,
    "media_type" "text" DEFAULT 'movie'::"text" NOT NULL,
    "list_id" bigint
);


ALTER TABLE "public"."official_lists" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."official_lists_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."official_lists_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."official_lists_id_seq" OWNED BY "public"."official_lists"."id";



CREATE TABLE IF NOT EXISTS "public"."person_follows" (
    "id" bigint NOT NULL,
    "user_id" "uuid" NOT NULL,
    "tmdb_person_id" integer NOT NULL,
    "person_name" "text" NOT NULL,
    "profile_path" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."person_follows" OWNER TO "postgres";


ALTER TABLE "public"."person_follows" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."person_follows_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."profiles" (
    "id" "uuid" NOT NULL,
    "display_name" "text",
    "avatar_color" "text",
    "bio" "text",
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "avatar_url" "text",
    "banner_url" "text",
    "location" "text",
    "x_handle" "text"
);


ALTER TABLE "public"."profiles" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."season_meta" (
    "id" bigint NOT NULL,
    "media_id" bigint NOT NULL,
    "season_number" integer NOT NULL,
    "name" "text",
    "poster_path" "text"
);


ALTER TABLE "public"."season_meta" OWNER TO "postgres";


ALTER TABLE "public"."season_meta" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."season_meta_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."studio_follows" (
    "id" bigint NOT NULL,
    "user_id" "uuid" NOT NULL,
    "kind" "text" NOT NULL,
    "tmdb_id" bigint NOT NULL,
    "name" "text" NOT NULL,
    "logo_path" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "studio_follows_kind_check" CHECK (("kind" = ANY (ARRAY['company'::"text", 'network'::"text", 'publisher'::"text", 'developer'::"text", 'gpublisher'::"text"])))
);


ALTER TABLE "public"."studio_follows" OWNER TO "postgres";


ALTER TABLE "public"."studio_follows" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."studio_follows_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."user_follows" (
    "follower_id" "uuid" NOT NULL,
    "followee_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "user_follows_check" CHECK (("follower_id" <> "followee_id"))
);


ALTER TABLE "public"."user_follows" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."watched_episodes" (
    "id" bigint NOT NULL,
    "entry_id" bigint NOT NULL,
    "episode_id" bigint NOT NULL,
    "watched_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."watched_episodes" OWNER TO "postgres";


ALTER TABLE "public"."watched_episodes" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."watched_episodes_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



ALTER TABLE ONLY "public"."list_clones" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."list_clones_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."list_comments" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."list_comments_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."official_list_items" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."official_list_items_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."official_lists" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."official_lists_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."entries"
    ADD CONSTRAINT "entries_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."entries"
    ADD CONSTRAINT "entries_user_id_media_id_key" UNIQUE ("user_id", "media_id");



ALTER TABLE ONLY "public"."entry_logs"
    ADD CONSTRAINT "entry_logs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."episodes"
    ADD CONSTRAINT "episodes_media_id_season_number_episode_number_key" UNIQUE ("media_id", "season_number", "episode_number");



ALTER TABLE ONLY "public"."episodes"
    ADD CONSTRAINT "episodes_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."families"
    ADD CONSTRAINT "families_owner_id_key" UNIQUE ("owner_id");



ALTER TABLE ONLY "public"."families"
    ADD CONSTRAINT "families_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."family_invites"
    ADD CONSTRAINT "family_invites_family_id_invited_email_key" UNIQUE ("family_id", "invited_email");



ALTER TABLE ONLY "public"."family_invites"
    ADD CONSTRAINT "family_invites_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."family_members"
    ADD CONSTRAINT "family_members_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."family_members"
    ADD CONSTRAINT "family_members_user_id_key" UNIQUE ("user_id");



ALTER TABLE ONLY "public"."game_achievements"
    ADD CONSTRAINT "game_achievements_pkey" PRIMARY KEY ("user_id", "media_id", "achievement_id");



ALTER TABLE ONLY "public"."list_clones"
    ADD CONSTRAINT "list_clones_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."list_comment_likes"
    ADD CONSTRAINT "list_comment_likes_pkey" PRIMARY KEY ("comment_id", "user_id");



ALTER TABLE ONLY "public"."list_comment_mutes"
    ADD CONSTRAINT "list_comment_mutes_pkey" PRIMARY KEY ("list_id", "user_id");



ALTER TABLE ONLY "public"."list_comments"
    ADD CONSTRAINT "list_comments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."list_items"
    ADD CONSTRAINT "list_items_list_id_media_id_key" UNIQUE ("list_id", "media_id");



ALTER TABLE ONLY "public"."list_items"
    ADD CONSTRAINT "list_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."list_likes"
    ADD CONSTRAINT "list_likes_pkey" PRIMARY KEY ("list_id", "user_id");



ALTER TABLE ONLY "public"."list_order"
    ADD CONSTRAINT "list_order_pkey" PRIMARY KEY ("user_id", "list_id");



ALTER TABLE ONLY "public"."list_shares"
    ADD CONSTRAINT "list_shares_list_id_shared_with_user_id_key" UNIQUE ("list_id", "shared_with_user_id");



ALTER TABLE ONLY "public"."list_shares"
    ADD CONSTRAINT "list_shares_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."lists"
    ADD CONSTRAINT "lists_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."media"
    ADD CONSTRAINT "media_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."media"
    ADD CONSTRAINT "media_tmdb_id_media_type_key" UNIQUE ("tmdb_id", "media_type");



ALTER TABLE ONLY "public"."official_list_items"
    ADD CONSTRAINT "official_list_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."official_lists"
    ADD CONSTRAINT "official_lists_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."official_lists"
    ADD CONSTRAINT "official_lists_slug_key" UNIQUE ("slug");



ALTER TABLE ONLY "public"."person_follows"
    ADD CONSTRAINT "person_follows_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."person_follows"
    ADD CONSTRAINT "person_follows_user_id_tmdb_person_id_key" UNIQUE ("user_id", "tmdb_person_id");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."season_meta"
    ADD CONSTRAINT "season_meta_media_id_season_number_key" UNIQUE ("media_id", "season_number");



ALTER TABLE ONLY "public"."season_meta"
    ADD CONSTRAINT "season_meta_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."studio_follows"
    ADD CONSTRAINT "studio_follows_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."studio_follows"
    ADD CONSTRAINT "studio_follows_user_id_kind_tmdb_id_key" UNIQUE ("user_id", "kind", "tmdb_id");



ALTER TABLE ONLY "public"."user_follows"
    ADD CONSTRAINT "user_follows_pkey" PRIMARY KEY ("follower_id", "followee_id");



ALTER TABLE ONLY "public"."watched_episodes"
    ADD CONSTRAINT "watched_episodes_entry_id_episode_id_key" UNIQUE ("entry_id", "episode_id");



ALTER TABLE ONLY "public"."watched_episodes"
    ADD CONSTRAINT "watched_episodes_pkey" PRIMARY KEY ("id");



CREATE INDEX "entry_logs_entry_idx" ON "public"."entry_logs" USING "btree" ("entry_id");



CREATE UNIQUE INDEX "entry_logs_episode_uniq" ON "public"."entry_logs" USING "btree" ("entry_id", "episode_id") WHERE ("episode_id" IS NOT NULL);



CREATE INDEX "idx_entries_user_status" ON "public"."entries" USING "btree" ("user_id", "status");



CREATE INDEX "idx_episodes_media" ON "public"."episodes" USING "btree" ("media_id", "season_number");



CREATE INDEX "idx_list_items_list" ON "public"."list_items" USING "btree" ("list_id");



CREATE INDEX "idx_list_shares_list" ON "public"."list_shares" USING "btree" ("list_id");



CREATE INDEX "idx_list_shares_user" ON "public"."list_shares" USING "btree" ("shared_with_user_id");



CREATE INDEX "idx_media_type" ON "public"."media" USING "btree" ("media_type");



CREATE INDEX "list_comments_list_idx" ON "public"."list_comments" USING "btree" ("list_id", "created_at");



CREATE UNIQUE INDEX "lists_one_favorites_per_user" ON "public"."lists" USING "btree" ("user_id") WHERE "is_favorites";



CREATE UNIQUE INDEX "lists_share_token_key" ON "public"."lists" USING "btree" ("share_token");



CREATE INDEX "official_list_items_list_idx" ON "public"."official_list_items" USING "btree" ("list_id", "position");



CREATE OR REPLACE TRIGGER "entries_set_updated_at" BEFORE UPDATE ON "public"."entries" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "entries_sync_favorites_trg" AFTER INSERT OR DELETE OR UPDATE OF "is_favorite" ON "public"."entries" FOR EACH ROW EXECUTE FUNCTION "public"."entries_sync_favorites"();



CREATE OR REPLACE TRIGGER "episodes_validate_trg" BEFORE INSERT OR UPDATE ON "public"."episodes" FOR EACH ROW EXECUTE FUNCTION "public"."episodes_validate"();



CREATE OR REPLACE TRIGGER "lists_drop_link_shares_trg" AFTER UPDATE OF "visibility" ON "public"."lists" FOR EACH ROW EXECUTE FUNCTION "public"."lists_drop_link_shares"();



CREATE OR REPLACE TRIGGER "lists_guard_official_trg" BEFORE INSERT OR UPDATE ON "public"."lists" FOR EACH ROW EXECUTE FUNCTION "public"."lists_guard_official"();



CREATE OR REPLACE TRIGGER "lists_set_updated_at" BEFORE UPDATE ON "public"."lists" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "media_validate_trg" BEFORE INSERT OR UPDATE ON "public"."media" FOR EACH ROW EXECUTE FUNCTION "public"."media_validate"();



CREATE OR REPLACE TRIGGER "season_meta_validate_trg" BEFORE INSERT OR UPDATE ON "public"."season_meta" FOR EACH ROW EXECUTE FUNCTION "public"."season_meta_validate"();



ALTER TABLE ONLY "public"."entries"
    ADD CONSTRAINT "entries_media_id_fkey" FOREIGN KEY ("media_id") REFERENCES "public"."media"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."entries"
    ADD CONSTRAINT "entries_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."entry_logs"
    ADD CONSTRAINT "entry_logs_entry_id_fkey" FOREIGN KEY ("entry_id") REFERENCES "public"."entries"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."entry_logs"
    ADD CONSTRAINT "entry_logs_episode_id_fkey" FOREIGN KEY ("episode_id") REFERENCES "public"."episodes"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."episodes"
    ADD CONSTRAINT "episodes_media_id_fkey" FOREIGN KEY ("media_id") REFERENCES "public"."media"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."families"
    ADD CONSTRAINT "families_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."family_invites"
    ADD CONSTRAINT "family_invites_family_id_fkey" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."family_invites"
    ADD CONSTRAINT "family_invites_invited_by_fkey" FOREIGN KEY ("invited_by") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."family_members"
    ADD CONSTRAINT "family_members_family_id_fkey" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."family_members"
    ADD CONSTRAINT "family_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."list_clones"
    ADD CONSTRAINT "list_clones_cloner_id_fkey" FOREIGN KEY ("cloner_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."list_clones"
    ADD CONSTRAINT "list_clones_list_id_fkey" FOREIGN KEY ("list_id") REFERENCES "public"."lists"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."list_clones"
    ADD CONSTRAINT "list_clones_new_list_id_fkey" FOREIGN KEY ("new_list_id") REFERENCES "public"."lists"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."list_comment_likes"
    ADD CONSTRAINT "list_comment_likes_comment_id_fkey" FOREIGN KEY ("comment_id") REFERENCES "public"."list_comments"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."list_comment_likes"
    ADD CONSTRAINT "list_comment_likes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."list_comment_mutes"
    ADD CONSTRAINT "list_comment_mutes_list_id_fkey" FOREIGN KEY ("list_id") REFERENCES "public"."lists"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."list_comment_mutes"
    ADD CONSTRAINT "list_comment_mutes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."list_comments"
    ADD CONSTRAINT "list_comments_list_id_fkey" FOREIGN KEY ("list_id") REFERENCES "public"."lists"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."list_comments"
    ADD CONSTRAINT "list_comments_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "public"."list_comments"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."list_comments"
    ADD CONSTRAINT "list_comments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."list_items"
    ADD CONSTRAINT "list_items_list_id_fkey" FOREIGN KEY ("list_id") REFERENCES "public"."lists"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."list_items"
    ADD CONSTRAINT "list_items_media_id_fkey" FOREIGN KEY ("media_id") REFERENCES "public"."media"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."list_likes"
    ADD CONSTRAINT "list_likes_list_id_fkey" FOREIGN KEY ("list_id") REFERENCES "public"."lists"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."list_likes"
    ADD CONSTRAINT "list_likes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."list_order"
    ADD CONSTRAINT "list_order_list_id_fkey" FOREIGN KEY ("list_id") REFERENCES "public"."lists"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."list_order"
    ADD CONSTRAINT "list_order_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."list_shares"
    ADD CONSTRAINT "list_shares_list_id_fkey" FOREIGN KEY ("list_id") REFERENCES "public"."lists"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."list_shares"
    ADD CONSTRAINT "list_shares_shared_with_user_id_fkey" FOREIGN KEY ("shared_with_user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."lists"
    ADD CONSTRAINT "lists_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."official_list_items"
    ADD CONSTRAINT "official_list_items_list_id_fkey" FOREIGN KEY ("list_id") REFERENCES "public"."official_lists"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."official_lists"
    ADD CONSTRAINT "official_lists_list_id_fkey" FOREIGN KEY ("list_id") REFERENCES "public"."lists"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."person_follows"
    ADD CONSTRAINT "person_follows_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_id_fkey" FOREIGN KEY ("id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."season_meta"
    ADD CONSTRAINT "season_meta_media_id_fkey" FOREIGN KEY ("media_id") REFERENCES "public"."media"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."studio_follows"
    ADD CONSTRAINT "studio_follows_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_follows"
    ADD CONSTRAINT "user_follows_followee_id_fkey" FOREIGN KEY ("followee_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_follows"
    ADD CONSTRAINT "user_follows_follower_id_fkey" FOREIGN KEY ("follower_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."watched_episodes"
    ADD CONSTRAINT "watched_episodes_entry_id_fkey" FOREIGN KEY ("entry_id") REFERENCES "public"."entries"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."watched_episodes"
    ADD CONSTRAINT "watched_episodes_episode_id_fkey" FOREIGN KEY ("episode_id") REFERENCES "public"."episodes"("id") ON DELETE CASCADE;



CREATE POLICY "comment_likes delete own" ON "public"."list_comment_likes" FOR DELETE TO "authenticated" USING (("user_id" = "auth"."uid"()));



CREATE POLICY "comment_likes insert own" ON "public"."list_comment_likes" FOR INSERT TO "authenticated" WITH CHECK (("user_id" = "auth"."uid"()));



CREATE POLICY "comment_likes select" ON "public"."list_comment_likes" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "comment_mutes own" ON "public"."list_comment_mutes" TO "authenticated" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));



ALTER TABLE "public"."entries" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "entries delete own" ON "public"."entries" FOR DELETE USING (("auth"."uid"() = "user_id"));



CREATE POLICY "entries insert own" ON "public"."entries" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "entries select own" ON "public"."entries" FOR SELECT USING (("auth"."uid"() = "user_id"));



CREATE POLICY "entries update own" ON "public"."entries" FOR UPDATE USING (("auth"."uid"() = "user_id"));



ALTER TABLE "public"."entry_logs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."episodes" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "episodes readable by authenticated users" ON "public"."episodes" FOR SELECT USING (("auth"."role"() = 'authenticated'::"text"));



CREATE POLICY "episodes updatable by authenticated users" ON "public"."episodes" FOR UPDATE USING (("auth"."role"() = 'authenticated'::"text"));



CREATE POLICY "episodes writable by authenticated users" ON "public"."episodes" FOR INSERT WITH CHECK (("auth"."role"() = 'authenticated'::"text"));



ALTER TABLE "public"."families" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "families insertable by their own owner" ON "public"."families" FOR INSERT WITH CHECK (("owner_id" = "auth"."uid"()));



CREATE POLICY "families updatable by owner" ON "public"."families" FOR UPDATE USING (("auth"."uid"() = "owner_id"));



CREATE POLICY "families visible to owner or members" ON "public"."families" FOR SELECT USING ((("owner_id" = "auth"."uid"()) OR ("id" = "public"."my_family_id"())));



CREATE POLICY "family entries readable" ON "public"."entries" FOR SELECT TO "authenticated" USING ("public"."is_family_peer"("user_id"));



ALTER TABLE "public"."family_invites" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "family_invites deletable by inviter (revoke)" ON "public"."family_invites" FOR DELETE USING (("invited_by" = "auth"."uid"()));



CREATE POLICY "family_invites insertable by family owner" ON "public"."family_invites" FOR INSERT WITH CHECK ((("invited_by" = "auth"."uid"()) AND ("family_id" IN ( SELECT "families"."id"
   FROM "public"."families"
  WHERE ("families"."owner_id" = "auth"."uid"())))));



CREATE POLICY "family_invites updatable by invitee (accept/decline)" ON "public"."family_invites" FOR UPDATE USING (("invited_email" = ("auth"."jwt"() ->> 'email'::"text")));



CREATE POLICY "family_invites visible to inviter or invitee" ON "public"."family_invites" FOR SELECT USING ((("invited_by" = "auth"."uid"()) OR ("invited_email" = ("auth"."jwt"() ->> 'email'::"text"))));



ALTER TABLE "public"."family_members" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "family_members deletable by self or family owner" ON "public"."family_members" FOR DELETE USING ((("user_id" = "auth"."uid"()) OR ("family_id" IN ( SELECT "families"."id"
   FROM "public"."families"
  WHERE ("families"."owner_id" = "auth"."uid"())))));



CREATE POLICY "family_members insertable by owner-self or accepted invite" ON "public"."family_members" FOR INSERT WITH CHECK ((("user_id" = "auth"."uid"()) AND (("family_id" IN ( SELECT "families"."id"
   FROM "public"."families"
  WHERE ("families"."owner_id" = "auth"."uid"()))) OR (EXISTS ( SELECT 1
   FROM "public"."family_invites" "fi"
  WHERE (("fi"."family_id" = "family_members"."family_id") AND ("fi"."invited_email" = ("auth"."jwt"() ->> 'email'::"text")) AND ("fi"."status" = 'pending'::"text")))))));



CREATE POLICY "family_members visible to same-family accounts" ON "public"."family_members" FOR SELECT USING (("family_id" = "public"."my_family_id"()));



CREATE POLICY "follow as self" ON "public"."user_follows" FOR INSERT TO "authenticated" WITH CHECK (("follower_id" = "auth"."uid"()));



CREATE POLICY "follows readable" ON "public"."user_follows" FOR SELECT TO "authenticated" USING (true);



ALTER TABLE "public"."game_achievements" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "game_achievements own" ON "public"."game_achievements" TO "authenticated" USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



ALTER TABLE "public"."list_clones" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "list_clones insert own" ON "public"."list_clones" FOR INSERT TO "authenticated" WITH CHECK (("cloner_id" = "auth"."uid"()));



CREATE POLICY "list_clones select" ON "public"."list_clones" FOR SELECT TO "authenticated" USING (true);



ALTER TABLE "public"."list_comment_likes" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."list_comment_mutes" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."list_comments" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "list_comments delete" ON "public"."list_comments" FOR DELETE TO "authenticated" USING ((("user_id" = "auth"."uid"()) OR "public"."list_social_is_owner"("list_id")));



CREATE POLICY "list_comments insert" ON "public"."list_comments" FOR INSERT TO "authenticated" WITH CHECK ((("user_id" = "auth"."uid"()) AND "public"."list_social_can_view"("list_id")));



CREATE POLICY "list_comments select" ON "public"."list_comments" FOR SELECT TO "authenticated" USING ("public"."list_social_can_view"("list_id"));



ALTER TABLE "public"."list_items" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "list_items delete own" ON "public"."list_items" FOR DELETE USING ("public"."is_list_owner"("list_id"));



CREATE POLICY "list_items insert own" ON "public"."list_items" FOR INSERT WITH CHECK ("public"."is_list_owner"("list_id"));



CREATE POLICY "list_items select via list ownership or share" ON "public"."list_items" FOR SELECT USING ("public"."can_view_list"("list_id"));



CREATE POLICY "list_items update own" ON "public"."list_items" FOR UPDATE USING ("public"."is_list_owner"("list_id"));



ALTER TABLE "public"."list_likes" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "list_likes delete" ON "public"."list_likes" FOR DELETE TO "authenticated" USING (("user_id" = "auth"."uid"()));



CREATE POLICY "list_likes insert" ON "public"."list_likes" FOR INSERT TO "authenticated" WITH CHECK (("user_id" = "auth"."uid"()));



CREATE POLICY "list_likes read" ON "public"."list_likes" FOR SELECT TO "authenticated" USING (true);



ALTER TABLE "public"."list_order" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "list_order own" ON "public"."list_order" TO "authenticated" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));



ALTER TABLE "public"."list_shares" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "list_shares delete by owner" ON "public"."list_shares" FOR DELETE USING ("public"."is_list_owner"("list_id"));



CREATE POLICY "list_shares insert by owner" ON "public"."list_shares" FOR INSERT WITH CHECK ("public"."is_list_owner"("list_id"));



CREATE POLICY "list_shares select own or owner" ON "public"."list_shares" FOR SELECT USING ((("auth"."uid"() = "shared_with_user_id") OR "public"."is_list_owner"("list_id")));



ALTER TABLE "public"."lists" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "lists delete own" ON "public"."lists" FOR DELETE USING (("auth"."uid"() = "user_id"));



CREATE POLICY "lists insert own" ON "public"."lists" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "lists select own or shared" ON "public"."lists" FOR SELECT USING ("public"."can_view_list"("id"));



CREATE POLICY "lists update own" ON "public"."lists" FOR UPDATE USING (("auth"."uid"() = "user_id"));



ALTER TABLE "public"."media" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "media readable by authenticated users" ON "public"."media" FOR SELECT USING (("auth"."role"() = 'authenticated'::"text"));



CREATE POLICY "mutual follows entries readable" ON "public"."entries" FOR SELECT TO "authenticated" USING (((EXISTS ( SELECT 1
   FROM "public"."user_follows" "f"
  WHERE (("f"."follower_id" = "auth"."uid"()) AND ("f"."followee_id" = "entries"."user_id")))) AND (EXISTS ( SELECT 1
   FROM "public"."user_follows" "f"
  WHERE (("f"."follower_id" = "entries"."user_id") AND ("f"."followee_id" = "auth"."uid"()))))));



CREATE POLICY "official list items readable" ON "public"."list_items" FOR SELECT TO "authenticated" USING ("public"."list_is_official"("list_id"));



CREATE POLICY "official lists readable" ON "public"."lists" FOR SELECT TO "authenticated" USING ("is_official");



ALTER TABLE "public"."official_list_items" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "official_list_items read" ON "public"."official_list_items" FOR SELECT TO "authenticated" USING (true);



ALTER TABLE "public"."official_lists" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "official_lists read" ON "public"."official_lists" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "own logs delete" ON "public"."entry_logs" FOR DELETE TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."entries" "e"
  WHERE (("e"."id" = "entry_logs"."entry_id") AND ("e"."user_id" = "auth"."uid"())))));



CREATE POLICY "own logs insert" ON "public"."entry_logs" FOR INSERT TO "authenticated" WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."entries" "e"
  WHERE (("e"."id" = "entry_logs"."entry_id") AND ("e"."user_id" = "auth"."uid"())))));



CREATE POLICY "own logs select" ON "public"."entry_logs" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."entries" "e"
  WHERE (("e"."id" = "entry_logs"."entry_id") AND ("e"."user_id" = "auth"."uid"())))));



CREATE POLICY "own studio follows" ON "public"."studio_follows" TO "authenticated" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));



ALTER TABLE "public"."person_follows" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "person_follows delete own" ON "public"."person_follows" FOR DELETE USING (("auth"."uid"() = "user_id"));



CREATE POLICY "person_follows insert own" ON "public"."person_follows" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "person_follows select own" ON "public"."person_follows" FOR SELECT USING (("auth"."uid"() = "user_id"));



ALTER TABLE "public"."profiles" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "profiles insert own" ON "public"."profiles" FOR INSERT WITH CHECK (("auth"."uid"() = "id"));



CREATE POLICY "profiles readable by authenticated users" ON "public"."profiles" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "profiles select own" ON "public"."profiles" FOR SELECT USING (("auth"."uid"() = "id"));



CREATE POLICY "profiles update own" ON "public"."profiles" FOR UPDATE USING (("auth"."uid"() = "id"));



ALTER TABLE "public"."season_meta" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "season_meta readable by authenticated users" ON "public"."season_meta" FOR SELECT USING (("auth"."role"() = 'authenticated'::"text"));



CREATE POLICY "season_meta updatable by authenticated users" ON "public"."season_meta" FOR UPDATE USING (("auth"."role"() = 'authenticated'::"text"));



CREATE POLICY "season_meta writable by authenticated users" ON "public"."season_meta" FOR INSERT WITH CHECK (("auth"."role"() = 'authenticated'::"text"));



ALTER TABLE "public"."studio_follows" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "unfollow as self" ON "public"."user_follows" FOR DELETE TO "authenticated" USING (("follower_id" = "auth"."uid"()));



ALTER TABLE "public"."user_follows" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."watched_episodes" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "watched_episodes delete via entry ownership" ON "public"."watched_episodes" FOR DELETE USING ((EXISTS ( SELECT 1
   FROM "public"."entries" "e"
  WHERE (("e"."id" = "watched_episodes"."entry_id") AND ("e"."user_id" = "auth"."uid"())))));



CREATE POLICY "watched_episodes insert via entry ownership" ON "public"."watched_episodes" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."entries" "e"
  WHERE (("e"."id" = "watched_episodes"."entry_id") AND ("e"."user_id" = "auth"."uid"())))));



CREATE POLICY "watched_episodes select via entry ownership" ON "public"."watched_episodes" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."entries" "e"
  WHERE (("e"."id" = "watched_episodes"."entry_id") AND ("e"."user_id" = "auth"."uid"())))));



CREATE POLICY "watched_episodes update via entry ownership" ON "public"."watched_episodes" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."entries" "e"
  WHERE (("e"."id" = "watched_episodes"."entry_id") AND ("e"."user_id" = "auth"."uid"()))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."entries" "e"
  WHERE (("e"."id" = "watched_episodes"."entry_id") AND ("e"."user_id" = "auth"."uid"())))));



GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";



GRANT ALL ON FUNCTION "public"."can_view_list"("target_list_id" bigint) TO "anon";
GRANT ALL ON FUNCTION "public"."can_view_list"("target_list_id" bigint) TO "authenticated";
GRANT ALL ON FUNCTION "public"."can_view_list"("target_list_id" bigint) TO "service_role";



REVOKE ALL ON FUNCTION "public"."delete_my_account"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."delete_my_account"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."delete_my_account"() TO "service_role";



GRANT ALL ON FUNCTION "public"."ensure_favorites_list"("p_user" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."ensure_favorites_list"("p_user" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."ensure_favorites_list"("p_user" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."entries_sync_favorites"() TO "anon";
GRANT ALL ON FUNCTION "public"."entries_sync_favorites"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."entries_sync_favorites"() TO "service_role";



GRANT ALL ON FUNCTION "public"."episodes_validate"() TO "anon";
GRANT ALL ON FUNCTION "public"."episodes_validate"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."episodes_validate"() TO "service_role";



GRANT ALL ON FUNCTION "public"."is_family_peer"("uid" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."is_family_peer"("uid" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_family_peer"("uid" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."is_list_owner"("target_list_id" bigint) TO "anon";
GRANT ALL ON FUNCTION "public"."is_list_owner"("target_list_id" bigint) TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_list_owner"("target_list_id" bigint) TO "service_role";



GRANT ALL ON FUNCTION "public"."list_is_official"("p_list_id" bigint) TO "anon";
GRANT ALL ON FUNCTION "public"."list_is_official"("p_list_id" bigint) TO "authenticated";
GRANT ALL ON FUNCTION "public"."list_is_official"("p_list_id" bigint) TO "service_role";



GRANT ALL ON FUNCTION "public"."list_social_can_view"("p_list_id" bigint) TO "anon";
GRANT ALL ON FUNCTION "public"."list_social_can_view"("p_list_id" bigint) TO "authenticated";
GRANT ALL ON FUNCTION "public"."list_social_can_view"("p_list_id" bigint) TO "service_role";



GRANT ALL ON FUNCTION "public"."list_social_is_owner"("p_list_id" bigint) TO "anon";
GRANT ALL ON FUNCTION "public"."list_social_is_owner"("p_list_id" bigint) TO "authenticated";
GRANT ALL ON FUNCTION "public"."list_social_is_owner"("p_list_id" bigint) TO "service_role";



GRANT ALL ON FUNCTION "public"."lists_drop_link_shares"() TO "anon";
GRANT ALL ON FUNCTION "public"."lists_drop_link_shares"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."lists_drop_link_shares"() TO "service_role";



GRANT ALL ON FUNCTION "public"."lists_guard_official"() TO "anon";
GRANT ALL ON FUNCTION "public"."lists_guard_official"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."lists_guard_official"() TO "service_role";



GRANT ALL ON FUNCTION "public"."media_image_ok"("p" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."media_image_ok"("p" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."media_image_ok"("p" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."media_set_episode_counts"("p_id" bigint, "p_seasons" integer, "p_episodes" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."media_set_episode_counts"("p_id" bigint, "p_seasons" integer, "p_episodes" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."media_set_episode_counts"("p_id" bigint, "p_seasons" integer, "p_episodes" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."media_set_ratings"("p_id" bigint, "p" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."media_set_ratings"("p_id" bigint, "p" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."media_set_ratings"("p_id" bigint, "p" "jsonb") TO "service_role";



REVOKE ALL ON FUNCTION "public"."media_upsert"("p" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."media_upsert"("p" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."media_upsert"("p" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."media_validate"() TO "anon";
GRANT ALL ON FUNCTION "public"."media_validate"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."media_validate"() TO "service_role";



GRANT ALL ON FUNCTION "public"."my_family_id"() TO "anon";
GRANT ALL ON FUNCTION "public"."my_family_id"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."my_family_id"() TO "service_role";



GRANT ALL ON FUNCTION "public"."my_favorites_list"() TO "anon";
GRANT ALL ON FUNCTION "public"."my_favorites_list"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."my_favorites_list"() TO "service_role";



GRANT ALL ON FUNCTION "public"."official_add_item"("p_list_id" bigint, "p_media_id" bigint) TO "anon";
GRANT ALL ON FUNCTION "public"."official_add_item"("p_list_id" bigint, "p_media_id" bigint) TO "authenticated";
GRANT ALL ON FUNCTION "public"."official_add_item"("p_list_id" bigint, "p_media_id" bigint) TO "service_role";



GRANT ALL ON FUNCTION "public"."official_is_admin"() TO "anon";
GRANT ALL ON FUNCTION "public"."official_is_admin"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."official_is_admin"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."open_shared_list"("p_token" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."open_shared_list"("p_token" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."open_shared_list"("p_token" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."season_meta_validate"() TO "anon";
GRANT ALL ON FUNCTION "public"."season_meta_validate"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."season_meta_validate"() TO "service_role";



GRANT ALL ON FUNCTION "public"."set_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."set_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_updated_at"() TO "service_role";



GRANT ALL ON TABLE "public"."entries" TO "anon";
GRANT ALL ON TABLE "public"."entries" TO "authenticated";
GRANT ALL ON TABLE "public"."entries" TO "service_role";



GRANT ALL ON SEQUENCE "public"."entries_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."entries_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."entries_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."entry_logs" TO "anon";
GRANT ALL ON TABLE "public"."entry_logs" TO "authenticated";
GRANT ALL ON TABLE "public"."entry_logs" TO "service_role";



GRANT ALL ON SEQUENCE "public"."entry_logs_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."entry_logs_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."entry_logs_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."episodes" TO "anon";
GRANT ALL ON TABLE "public"."episodes" TO "authenticated";
GRANT ALL ON TABLE "public"."episodes" TO "service_role";



GRANT ALL ON SEQUENCE "public"."episodes_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."episodes_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."episodes_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."families" TO "anon";
GRANT ALL ON TABLE "public"."families" TO "authenticated";
GRANT ALL ON TABLE "public"."families" TO "service_role";



GRANT ALL ON SEQUENCE "public"."families_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."families_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."families_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."family_invites" TO "anon";
GRANT ALL ON TABLE "public"."family_invites" TO "authenticated";
GRANT ALL ON TABLE "public"."family_invites" TO "service_role";



GRANT ALL ON SEQUENCE "public"."family_invites_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."family_invites_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."family_invites_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."family_members" TO "anon";
GRANT ALL ON TABLE "public"."family_members" TO "authenticated";
GRANT ALL ON TABLE "public"."family_members" TO "service_role";



GRANT ALL ON SEQUENCE "public"."family_members_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."family_members_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."family_members_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."game_achievements" TO "anon";
GRANT ALL ON TABLE "public"."game_achievements" TO "authenticated";
GRANT ALL ON TABLE "public"."game_achievements" TO "service_role";



GRANT ALL ON TABLE "public"."list_clones" TO "anon";
GRANT ALL ON TABLE "public"."list_clones" TO "authenticated";
GRANT ALL ON TABLE "public"."list_clones" TO "service_role";



GRANT ALL ON SEQUENCE "public"."list_clones_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."list_clones_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."list_clones_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."list_comment_likes" TO "anon";
GRANT ALL ON TABLE "public"."list_comment_likes" TO "authenticated";
GRANT ALL ON TABLE "public"."list_comment_likes" TO "service_role";



GRANT ALL ON TABLE "public"."list_comment_mutes" TO "anon";
GRANT ALL ON TABLE "public"."list_comment_mutes" TO "authenticated";
GRANT ALL ON TABLE "public"."list_comment_mutes" TO "service_role";



GRANT ALL ON TABLE "public"."list_comments" TO "anon";
GRANT ALL ON TABLE "public"."list_comments" TO "authenticated";
GRANT ALL ON TABLE "public"."list_comments" TO "service_role";



GRANT ALL ON SEQUENCE "public"."list_comments_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."list_comments_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."list_comments_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."list_items" TO "anon";
GRANT ALL ON TABLE "public"."list_items" TO "authenticated";
GRANT ALL ON TABLE "public"."list_items" TO "service_role";



GRANT ALL ON SEQUENCE "public"."list_items_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."list_items_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."list_items_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."list_likes" TO "anon";
GRANT ALL ON TABLE "public"."list_likes" TO "authenticated";
GRANT ALL ON TABLE "public"."list_likes" TO "service_role";



GRANT ALL ON TABLE "public"."list_order" TO "anon";
GRANT ALL ON TABLE "public"."list_order" TO "authenticated";
GRANT ALL ON TABLE "public"."list_order" TO "service_role";



GRANT ALL ON TABLE "public"."list_shares" TO "anon";
GRANT ALL ON TABLE "public"."list_shares" TO "authenticated";
GRANT ALL ON TABLE "public"."list_shares" TO "service_role";



GRANT ALL ON SEQUENCE "public"."list_shares_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."list_shares_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."list_shares_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."lists" TO "anon";
GRANT ALL ON TABLE "public"."lists" TO "authenticated";
GRANT ALL ON TABLE "public"."lists" TO "service_role";



GRANT ALL ON SEQUENCE "public"."lists_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."lists_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."lists_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."media" TO "anon";
GRANT ALL ON TABLE "public"."media" TO "authenticated";
GRANT ALL ON TABLE "public"."media" TO "service_role";



GRANT ALL ON SEQUENCE "public"."media_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."media_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."media_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."official_list_items" TO "anon";
GRANT ALL ON TABLE "public"."official_list_items" TO "authenticated";
GRANT ALL ON TABLE "public"."official_list_items" TO "service_role";



GRANT ALL ON SEQUENCE "public"."official_list_items_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."official_list_items_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."official_list_items_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."official_lists" TO "anon";
GRANT ALL ON TABLE "public"."official_lists" TO "authenticated";
GRANT ALL ON TABLE "public"."official_lists" TO "service_role";



GRANT ALL ON SEQUENCE "public"."official_lists_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."official_lists_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."official_lists_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."person_follows" TO "anon";
GRANT ALL ON TABLE "public"."person_follows" TO "authenticated";
GRANT ALL ON TABLE "public"."person_follows" TO "service_role";



GRANT ALL ON SEQUENCE "public"."person_follows_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."person_follows_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."person_follows_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."profiles" TO "anon";
GRANT ALL ON TABLE "public"."profiles" TO "authenticated";
GRANT ALL ON TABLE "public"."profiles" TO "service_role";



GRANT ALL ON TABLE "public"."season_meta" TO "anon";
GRANT ALL ON TABLE "public"."season_meta" TO "authenticated";
GRANT ALL ON TABLE "public"."season_meta" TO "service_role";



GRANT ALL ON SEQUENCE "public"."season_meta_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."season_meta_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."season_meta_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."studio_follows" TO "anon";
GRANT ALL ON TABLE "public"."studio_follows" TO "authenticated";
GRANT ALL ON TABLE "public"."studio_follows" TO "service_role";



GRANT ALL ON SEQUENCE "public"."studio_follows_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."studio_follows_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."studio_follows_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."user_follows" TO "anon";
GRANT ALL ON TABLE "public"."user_follows" TO "authenticated";
GRANT ALL ON TABLE "public"."user_follows" TO "service_role";



GRANT ALL ON TABLE "public"."watched_episodes" TO "anon";
GRANT ALL ON TABLE "public"."watched_episodes" TO "authenticated";
GRANT ALL ON TABLE "public"."watched_episodes" TO "service_role";



GRANT ALL ON SEQUENCE "public"."watched_episodes_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."watched_episodes_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."watched_episodes_id_seq" TO "service_role";



ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";







