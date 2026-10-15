-- Stacks: per-user catalogs with photo storage.
--
-- The app is local-first: every device keeps a full copy in IndexedDB and
-- syncs through these tables. Each person's rows are private to them (RLS on
-- user_id), and only emails on the allowed_emails list can read or write at
-- all — anyone can create an account, but an unapproved account sees nothing
-- and can store nothing.

-- ---------------------------------------------------------------- allowlist

create table public.allowed_emails (
  email text primary key check (email = lower(email)),
  added_at timestamptz not null default now()
);

alter table public.allowed_emails enable row level security;
-- No policies: clients can't read or edit the list. It's managed from the
-- Supabase dashboard (or SQL), and checked through is_allowed() below.

create function public.is_allowed()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.allowed_emails
    where email = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

revoke all on function public.is_allowed() from public, anon;
grant execute on function public.is_allowed() to authenticated;

-- -------------------------------------------------------------------- items

-- One row per catalog item. `data` is the item exactly as the app stores it
-- (minus image bytes); `updated_at` is the app's own edit time and decides
-- merges (newest edit wins). Deletions are kept as tombstones so they
-- propagate to every device. `synced_at` is server time, used for
-- incremental pulls.
create table public.items (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  id text not null,
  data jsonb not null default '{}'::jsonb,
  deleted boolean not null default false,
  updated_at timestamptz not null,
  synced_at timestamptz not null default clock_timestamp(),
  primary key (user_id, id)
);

create index items_user_synced_idx on public.items (user_id, synced_at);

-- Server-side newest-edit-wins: an upsert carrying an older edit than the
-- stored row is ignored, so two devices can never clobber a newer change.
create function public.items_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and new.updated_at < old.updated_at then
    return old;
  end if;
  new.synced_at := clock_timestamp();
  return new;
end;
$$;

create trigger items_guard
  before insert or update on public.items
  for each row execute function public.items_guard();

alter table public.items enable row level security;

create policy "items: owner reads" on public.items
  for select to authenticated
  using (user_id = (select auth.uid()) and (select public.is_allowed()));

create policy "items: owner inserts" on public.items
  for insert to authenticated
  with check (user_id = (select auth.uid()) and (select public.is_allowed()));

create policy "items: owner updates" on public.items
  for update to authenticated
  using (user_id = (select auth.uid()) and (select public.is_allowed()))
  with check (user_id = (select auth.uid()) and (select public.is_allowed()));

-- ---------------------------------------------------------------- user_state

-- Per-person settings that follow them between devices: the bookcase list
-- and the optional Discogs / Claude keys (each a {v, ts} pair, newest wins).
create table public.user_state (
  user_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  bookcases jsonb not null default '{"updatedAt": "", "list": []}'::jsonb,
  tokens jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.user_state enable row level security;

create policy "user_state: owner reads" on public.user_state
  for select to authenticated
  using (user_id = (select auth.uid()) and (select public.is_allowed()));

create policy "user_state: owner inserts" on public.user_state
  for insert to authenticated
  with check (user_id = (select auth.uid()) and (select public.is_allowed()));

create policy "user_state: owner updates" on public.user_state
  for update to authenticated
  using (user_id = (select auth.uid()) and (select public.is_allowed()))
  with check (user_id = (select auth.uid()) and (select public.is_allowed()));

-- -------------------------------------------------------------- photo storage

-- Private bucket; every object lives under "<user id>/<item id>/<photo id>.jpg".
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('covers', 'covers', false, 10485760,
        array['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
on conflict (id) do nothing;

create policy "covers: owner reads" on storage.objects
  for select to authenticated
  using (bucket_id = 'covers'
         and (storage.foldername(name))[1] = (select auth.uid())::text
         and (select public.is_allowed()));

create policy "covers: owner uploads" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'covers'
              and (storage.foldername(name))[1] = (select auth.uid())::text
              and (select public.is_allowed()));

create policy "covers: owner replaces" on storage.objects
  for update to authenticated
  using (bucket_id = 'covers'
         and (storage.foldername(name))[1] = (select auth.uid())::text
         and (select public.is_allowed()))
  with check (bucket_id = 'covers'
              and (storage.foldername(name))[1] = (select auth.uid())::text
              and (select public.is_allowed()));

create policy "covers: owner deletes" on storage.objects
  for delete to authenticated
  using (bucket_id = 'covers'
         and (storage.foldername(name))[1] = (select auth.uid())::text
         and (select public.is_allowed()));
