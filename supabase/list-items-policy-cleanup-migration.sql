-- Removes two list_items policies that duplicated others.
--
-- "list_items insert via list ownership" and "list_items delete via list
-- ownership" check exactly what "list_items insert own" / "list_items delete
-- own" already check (the list belongs to you), just inline instead of via
-- is_list_owner(). Postgres ORs policies together, so dropping the copies
-- changes nothing about who can do what.
--
-- Run once in the Supabase SQL editor. Safe to re-run.
-- Applied to the live project on 2026-11-08 (already in schema.sql).

drop policy if exists "list_items insert via list ownership" on public.list_items;
drop policy if exists "list_items delete via list ownership" on public.list_items;
