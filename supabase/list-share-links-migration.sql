-- Real share links for lists.
--
-- Until now a list's link was ivealready://list/<list id> — guessable, and
-- "Anyone with share link" lists were readable by any signed-in account that
-- knew the id. After this:
--   - Every list gets a random share_token; the link is ivealready://list/<token>.
--   - A 'link' list is no longer readable just by knowing its id. Opening the
--     link (open_shared_list) adds the list to that account's "Shared with
--     me" (a list_shares row marked via_link), which is what grants access.
--   - Switching a list away from 'link' removes everyone who only got in
--     through the link. Family shares are untouched.
--   - Opening the link to a 'public' list just opens it; a 'friends' list
--     opens only for people the owner follows; a 'private' list never opens.
--
-- Run once in the Supabase SQL editor. Safe to re-run. Run it BEFORE using an
-- app build that shows token links.
-- Applied to the live project on 2026-11-08 (already in schema.sql).

alter table public.lists add column if not exists share_token uuid not null default gen_random_uuid();
create unique index if not exists lists_share_token_key on public.lists (share_token);

alter table public.list_shares add column if not exists via_link boolean not null default false;

-- Same as list-visibility-migration.sql, minus "'link' lists are readable by
-- anyone": link access now comes from the list_shares row added when opening it.
create or replace function public.can_view_list(target_list_id bigint) returns boolean
    language sql stable security definer
    set search_path to 'public'
as $$
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

create or replace function public.open_shared_list(p_token uuid) returns bigint
    language plpgsql security definer
    set search_path to 'public'
as $$
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

revoke all on function public.open_shared_list(uuid) from public, anon;
grant execute on function public.open_shared_list(uuid) to authenticated;

create or replace function public.lists_drop_link_shares() returns trigger
    language plpgsql security definer
    set search_path to 'public'
as $$
begin
    if old.visibility = 'link' and new.visibility <> 'link' then
        delete from public.list_shares where list_id = new.id and via_link;
    end if;
    return new;
end $$;

drop trigger if exists lists_drop_link_shares_trg on public.lists;
create trigger lists_drop_link_shares_trg after update of visibility on public.lists
    for each row execute function public.lists_drop_link_shares();
