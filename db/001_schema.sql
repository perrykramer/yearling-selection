-- West Paces Sale Book — schema
--
-- One four-person operation, not a multi-tenant SaaS: any authenticated user reads and
-- writes every row (BUILD_BRIEF §3). The only write restriction is that you cannot forge
-- authorship — verdicts.user_id, notes.user_id and list_items.added_by must be your own
-- auth.uid(). That is what makes "Conor marked this In" true, which is the whole point.
--
-- Every synced table carries updated_at with a trigger and an index on it. The client pulls
-- `updated_at > cursor` per table, so sync stays cheap and incremental.
--
-- Nothing is ever hard-deleted from a synced table. A hard delete is invisible to an
-- updated_at pull, so a row cleared on Conor's phone would resurrect from Nick's cache.
-- Verdicts clear to NULL; notes, lists and list_items soft-delete.

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------- updated_at

create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- ---------------------------------------------------------------- people

create table if not exists public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  display_name text not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- A new auth user gets a profile automatically. display_name comes from the metadata set
-- when the account is created; falls back to the local part of the email so a row created
-- by hand in the dashboard is never nameless.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(nullif(new.raw_user_meta_data->>'display_name', ''), split_part(new.email, '@', 1)))
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------- verdicts
-- One row per person per horse: no conflict is possible by construction, and last write
-- from that person wins. verdict IS NULL means "cleared" — the app toggles a verdict off by
-- tapping it again, and that clearing has to sync like any other change.

create table if not exists public.verdicts (
  hip        integer not null,
  user_id    uuid    not null references auth.users(id) on delete cascade,
  verdict    text    check (verdict in ('in','maybe','out')),
  updated_at timestamptz not null default now(),
  primary key (hip, user_id)
);

-- ---------------------------------------------------------------- notes

create table if not exists public.notes (
  id         uuid primary key,
  hip        integer not null,
  user_id    uuid    not null references auth.users(id) on delete cascade,
  body       text    not null,
  created_at timestamptz not null default now(),
  edited_at  timestamptz,
  deleted_at timestamptz,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- shortlists
-- Item rows, not an array column: two people adding different horses to the same list must
-- not clobber each other (BUILD_BRIEF §3, acceptance test 4).

create table if not exists public.lists (
  id         uuid primary key,
  name       text not null,
  owner_id   uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists public.list_items (
  list_id    uuid    not null references public.lists(id) on delete cascade,
  hip        integer not null,
  added_by   uuid    not null references auth.users(id) on delete cascade,
  added_at   timestamptz not null default now(),
  position   integer not null default 0,
  removed_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (list_id, hip)
);

-- ---------------------------------------------------------------- deep pedigree
-- Empty for now. The full catalog page text per hip (3rd and 4th dams included) lands here
-- when full.txt is regenerated from the Keeneland PDF; the client fetches per hip on demand
-- and caches locally. See tools/extract.py.

create table if not exists public.horse_pages (
  hip        integer primary key,
  body       text not null,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- indexes

create index if not exists verdicts_updated_at_idx   on public.verdicts   (updated_at);
create index if not exists notes_updated_at_idx      on public.notes      (updated_at);
create index if not exists lists_updated_at_idx      on public.lists      (updated_at);
create index if not exists list_items_updated_at_idx on public.list_items (updated_at);
create index if not exists profiles_updated_at_idx   on public.profiles   (updated_at);
create index if not exists notes_hip_idx             on public.notes      (hip) where deleted_at is null;
create index if not exists list_items_list_idx       on public.list_items (list_id) where removed_at is null;

-- ---------------------------------------------------------------- updated_at triggers

do $$
declare t text;
begin
  foreach t in array array['profiles','verdicts','notes','lists','list_items','horse_pages'] loop
    execute format('drop trigger if exists set_updated_at on public.%I', t);
    -- INSERT as well as UPDATE: updated_at drives incremental sync, so the server must
    -- own it. If the client sets it, work done offline uploads carrying the time it was
    -- made, and a teammate whose cursor has passed that moment never receives it.
    execute format('create trigger set_updated_at before insert or update on public.%I
                    for each row execute function public.set_updated_at()', t);
  end loop;
end $$;

-- ---------------------------------------------------------------- RLS

alter table public.profiles    enable row level security;
alter table public.verdicts    enable row level security;
alter table public.notes       enable row level security;
alter table public.lists       enable row level security;
alter table public.list_items  enable row level security;
alter table public.horse_pages enable row level security;

do $$
declare t text;
begin
  foreach t in array array['profiles','verdicts','notes','lists','list_items','horse_pages'] loop
    execute format('drop policy if exists read_all on public.%I', t);
    execute format('drop policy if exists write_all on public.%I', t);
    execute format('drop policy if exists insert_own on public.%I', t);
    execute format('drop policy if exists update_own on public.%I', t);
    -- everyone signed in sees everything
    execute format('create policy read_all on public.%I for select to authenticated using (true)', t);
  end loop;
end $$;

-- Authorship is the one thing you cannot forge.
create policy insert_own on public.verdicts for insert to authenticated with check (user_id = auth.uid());
create policy update_own on public.verdicts for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy insert_own on public.notes for insert to authenticated with check (user_id = auth.uid());
create policy update_own on public.notes for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Shortlists are shared working documents: anyone may create one, and anyone may rename,
-- add to, remove from or delete one. That is how the team actually uses them.
create policy insert_own on public.lists for insert to authenticated with check (owner_id = auth.uid());
create policy write_all  on public.lists for update to authenticated using (true) with check (true);

create policy insert_own on public.list_items for insert to authenticated with check (added_by = auth.uid());
create policy write_all  on public.list_items for update to authenticated using (true) with check (true);

create policy update_own on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

-- No deletes and no anon access anywhere: absence of a policy denies.

-- ---------------------------------------------------------------- hardening
-- Pin the search_path on both trigger functions, and stop them being reachable as
-- RPC endpoints — nothing should be able to call them but the triggers themselves.
alter function public.set_updated_at()  set search_path = public, pg_temp;
alter function public.handle_new_user() set search_path = public, pg_temp;
revoke execute on function public.handle_new_user() from anon, authenticated, public;
revoke execute on function public.set_updated_at()  from anon, authenticated, public;
