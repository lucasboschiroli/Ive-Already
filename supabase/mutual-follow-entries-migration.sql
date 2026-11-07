-- Limits who can read your library (entries: statuses, ratings, reviews) to
-- mutual follows.
--
-- Until now the "followed users entries readable" policy let ANYONE who
-- followed you read every entry, and following needs no approval. After this,
-- they can only read your entries if you follow them back. Family members keep
-- their own access through "family entries readable" (unchanged).
--
-- Run once in the Supabase SQL editor. Safe to re-run.
-- Applied to the live project on 2026-11-06 (already in schema.sql).

drop policy if exists "followed users entries readable" on public.entries;
drop policy if exists "mutual follows entries readable" on public.entries;

create policy "mutual follows entries readable"
    on public.entries for select
    to authenticated
    using (
        exists (select 1 from public.user_follows f
                where f.follower_id = auth.uid() and f.followee_id = entries.user_id)
        and exists (select 1 from public.user_follows f
                    where f.follower_id = entries.user_id and f.followee_id = auth.uid())
    );
