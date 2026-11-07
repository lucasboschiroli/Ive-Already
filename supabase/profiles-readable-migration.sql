-- Lets signed-in accounts read each other's public profile (name, avatar,
-- banner, bio, location, X handle).
--
-- Until now the only SELECT policy on profiles was "profiles select own", so
-- every lookup of SOMEONE ELSE's profile came back empty: member search never
-- found anyone, and followers, comment authors, list owners and the activity
-- feed fell back to "Member" / "Someone". Writes stay owner-only.
--
-- Run once in the Supabase SQL editor. Safe to re-run.
-- Applied to the live project on 2026-11-06 (already in schema.sql).

drop policy if exists "profiles readable by authenticated users" on public.profiles;

create policy "profiles readable by authenticated users"
    on public.profiles for select
    to authenticated
    using (true);
