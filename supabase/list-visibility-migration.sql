-- Makes a list's "visibility" setting actually control who can open it.
--
-- Until now lists and list_items were readable only by the owner, people the
-- list was shared with, and (via separate policies) official lists — so
-- "Public", "Anyone with share link" and "Friends" did nothing. Comments used
-- a different rule (list_social_can_view) that already treated public/link
-- lists as visible, so the two disagreed.
--
-- After this, both functions use the same rule. A signed-in account can view
-- a list when it is:
--   - their own, or shared with them (list_shares), or official;
--   - 'public' or 'link' (the app has no secret link tokens, so a link list is
--     readable by any signed-in account that knows its id);
--   - 'friends' and the list's owner follows them ("people you follow").
-- 'private' lists stay owner + explicit shares only. Signed-out (anon)
-- requests only ever see nothing.
--
-- Run once in the Supabase SQL editor. Safe to re-run.
-- Applied to the live project on 2026-11-06 (already in schema.sql).

create or replace function public.can_view_list(target_list_id bigint) returns boolean
    language sql stable security definer
    set search_path to 'public'
as $$
    select auth.uid() is not null and exists (
        select 1 from public.lists l
        where l.id = target_list_id and (
            l.user_id = auth.uid()
            or l.is_official
            or l.visibility in ('public', 'link')
            or (l.visibility = 'friends' and exists (
                select 1 from public.user_follows f
                where f.follower_id = l.user_id and f.followee_id = auth.uid()))
            or exists (
                select 1 from public.list_shares s
                where s.list_id = l.id and s.shared_with_user_id = auth.uid())
        )
    );
$$;

-- Comments follow exactly the same rule as the list itself.
create or replace function public.list_social_can_view(p_list_id bigint) returns boolean
    language sql stable security definer
    set search_path to 'public'
as $$
    select public.can_view_list(p_list_id);
$$;
