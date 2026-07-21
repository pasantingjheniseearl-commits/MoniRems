-- =========================================================
-- DEPOT/OS — Supabase schema
-- Run this ONCE in Supabase Dashboard → SQL Editor → New query.
-- Safe to re-run from scratch on an empty project only
-- (it will error on tables/policies that already exist).
-- =========================================================

-- =========================================================
-- ALREADY RAN THE SCHEMA BEFORE? Run this block only.
-- (Skip this and use the CREATE TABLE script above instead if
-- this is a brand-new Supabase project.)
-- =========================================================
--
-- alter table public.profiles add column if not exists approved boolean not null default false;
-- update public.profiles set approved = true where role = 'Admin';
--
-- create or replace function public.handle_new_user()
-- returns trigger
-- language plpgsql
-- security definer set search_path = public
-- as $$
-- declare
--   is_first boolean;
-- begin
--   select not exists(select 1 from public.profiles) into is_first;
--   insert into public.profiles (id, name, username, email, role, approved)
--   values (
--     new.id,
--     coalesce(new.raw_user_meta_data->>'name', split_part(new.email,'@',1)),
--     coalesce(new.raw_user_meta_data->>'username', split_part(new.email,'@',1)),
--     new.email,
--     case when is_first then 'Admin'::public.app_role
--          else coalesce((new.raw_user_meta_data->>'role')::public.app_role, 'Stock Clerk') end,
--     is_first
--   );
--   return new;
-- end;
-- $$;
--
-- create or replace function public.prevent_self_privilege_escalation()
-- returns trigger
-- language plpgsql
-- security definer set search_path = public
-- as $$
-- begin
--   if auth.uid() = old.id and not public.is_admin() then
--     new.role := old.role;
--     new.approved := old.approved;
--   end if;
--   return new;
-- end;
-- $$;
--
-- drop trigger if exists before_profile_update on public.profiles;
-- create trigger before_profile_update
--   before update on public.profiles
--   for each row execute function public.prevent_self_privilege_escalation();
-- =========================================================

-- ---------- role enum ----------
create type public.app_role as enum ('Admin', 'Stock Clerk', 'Selling Clerk');

-- ---------- profiles (1 row per auth user) ----------
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null,
  username text not null unique,
  email text not null unique,
  role public.app_role not null default 'Stock Clerk',
  status text not null default 'offline' check (status in ('online','offline')),
  last_login text default '—',
  -- the very first account ever created is auto-approved as Admin;
  -- everyone after that needs an existing Admin to flip this to true
  -- before they can sign in (see handle_new_user() below).
  approved boolean not null default false,
  created_at timestamptz not null default now()
);

-- auto-create a profile row whenever someone signs up.
-- the first person to ever sign up becomes Admin and is auto-approved;
-- everyone after that gets their requested role but stays unapproved
-- until an Admin approves them from the Users page.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  is_first boolean;
begin
  select not exists(select 1 from public.profiles) into is_first;
  insert into public.profiles (id, name, username, email, role, approved)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'name', split_part(new.email,'@',1)),
    coalesce(new.raw_user_meta_data->>'username', split_part(new.email,'@',1)),
    new.email,
    case when is_first then 'Admin'::public.app_role
         else coalesce((new.raw_user_meta_data->>'role')::public.app_role, 'Stock Clerk') end,
    is_first
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- prevents a non-admin from approving themselves or promoting their own
-- role via a crafted API call — self-updates from the Profile page can
-- only touch name/username; role and approved stay locked unless an
-- Admin is the one making the change.
create or replace function public.prevent_self_privilege_escalation()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if auth.uid() = old.id and not public.is_admin() then
    new.role := old.role;
    new.approved := old.approved;
  end if;
  return new;
end;
$$;

create trigger before_profile_update
  before update on public.profiles
  for each row execute function public.prevent_self_privilege_escalation();

-- role helper functions, used by RLS policies below
create or replace function public.current_role()
returns public.app_role
language sql stable security definer set search_path = public
as $$ select role from public.profiles where id = auth.uid(); $$;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public
as $$ select public.current_role() = 'Admin'; $$;

create or replace function public.is_stock_or_admin()
returns boolean language sql stable security definer set search_path = public
as $$ select public.current_role() in ('Admin','Stock Clerk'); $$;

alter table public.profiles enable row level security;
create policy "profiles_select_all" on public.profiles
  for select to authenticated using (true);
create policy "profiles_update_self_or_admin" on public.profiles
  for update to authenticated using (id = auth.uid() or public.is_admin());
create policy "profiles_delete_admin" on public.profiles
  for delete to authenticated using (public.is_admin());

-- ---------- categories ----------
create table public.categories (
  name text primary key,
  created_at timestamptz not null default now()
);
alter table public.categories enable row level security;
create policy "categories_select" on public.categories for select to authenticated using (true);
create policy "categories_insert" on public.categories for insert to authenticated with check (true);
create policy "categories_delete_admin" on public.categories for delete to authenticated using (public.is_admin());

-- ---------- locators ----------
create table public.locators (
  code text primary key,
  zone text default '',
  description text default '',
  created_at timestamptz not null default now()
);
alter table public.locators enable row level security;
create policy "locators_select" on public.locators for select to authenticated using (true);
create policy "locators_insert_admin" on public.locators for insert to authenticated with check (public.is_admin());
create policy "locators_delete_admin" on public.locators for delete to authenticated using (public.is_admin());

-- ---------- inventory ----------
create table public.inventory (
  sku text primary key,
  description text not null default '',
  category text references public.categories(name) on update cascade on delete set null,
  locator text references public.locators(code) on update cascade on delete set null,
  qty integer not null default 0,
  unit_value numeric(12,2) not null default 0,
  reorder integer not null default 0,
  updated_at timestamptz not null default now()
);
create index inventory_category_idx on public.inventory(category);
create index inventory_locator_idx on public.inventory(locator);
create index inventory_description_idx on public.inventory using gin (to_tsvector('simple', description));
alter table public.inventory enable row level security;
create policy "inventory_select" on public.inventory for select to authenticated using (true);
-- any signed-in role can add/adjust stock (Stock In/Out and Adjustments pages
-- already gate this in the UI); only Admin can delete a SKU outright.
create policy "inventory_insert" on public.inventory for insert to authenticated with check (true);
create policy "inventory_update" on public.inventory for update to authenticated using (true);
create policy "inventory_delete_admin" on public.inventory for delete to authenticated using (public.is_admin());

-- ---------- transactions (stock in / out log) ----------
create table public.transactions (
  id text primary key,
  type text not null check (type in ('IN','OUT')),
  sku text not null,
  description text,
  qty integer not null,
  locator text,
  notes text,
  user_name text not null,
  user_id uuid references public.profiles(id) on delete set null,
  value numeric(12,2) not null default 0,
  timestamp text not null,
  input_method text default 'manual-form',
  prefix text,
  suffix text,
  full_barcode_formatted text,
  raw_input text,
  created_at timestamptz not null default now()
);
create index transactions_sku_idx on public.transactions(sku);
create index transactions_created_idx on public.transactions(created_at desc);
alter table public.transactions enable row level security;
create policy "transactions_select" on public.transactions for select to authenticated using (true);
create policy "transactions_insert" on public.transactions for insert to authenticated with check (true);

-- ---------- adjustments (write-offs, shrinkage, manual overrides) ----------
create table public.adjustments (
  id text primary key,
  sku text not null,
  description text,
  reason text not null,
  delta integer not null,
  qty_before integer not null,
  qty_after integer not null,
  notes text not null,
  user_name text not null,
  user_id uuid references public.profiles(id) on delete set null,
  timestamp text not null,
  created_at timestamptz not null default now()
);
create index adjustments_created_idx on public.adjustments(created_at desc);
alter table public.adjustments enable row level security;
create policy "adjustments_select" on public.adjustments for select to authenticated using (true);
create policy "adjustments_insert" on public.adjustments for insert to authenticated with check (public.is_stock_or_admin());

-- ---------- login / logout audit ----------
create table public.login_logs (
  id bigint generated always as identity primary key,
  user_name text not null,
  role text,
  action text not null,
  timestamp text not null,
  created_at timestamptz not null default now()
);
create index login_logs_created_idx on public.login_logs(created_at desc);
alter table public.login_logs enable row level security;
create policy "login_logs_select" on public.login_logs for select to authenticated using (true);
create policy "login_logs_insert" on public.login_logs for insert to authenticated with check (true);

-- ---------- direct messages (team chat, auto-purged after 90 days) ----------
create table public.messages (
  id text primary key,
  from_id uuid not null references public.profiles(id) on delete cascade,
  to_id uuid not null references public.profiles(id) on delete cascade,
  text text not null,
  timestamp text not null,
  created_at timestamptz not null default now()
);
create index messages_pair_idx on public.messages(from_id, to_id);
alter table public.messages enable row level security;
create policy "messages_select_own" on public.messages for select to authenticated
  using (from_id = auth.uid() or to_id = auth.uid());
create policy "messages_insert_own" on public.messages for insert to authenticated
  with check (from_id = auth.uid());

-- Realtime: let the client subscribe to live changes for
-- "who's online", live chat, and live stock updates.
alter publication supabase_realtime add table public.profiles;
alter publication supabase_realtime add table public.messages;
alter publication supabase_realtime add table public.inventory;
alter publication supabase_realtime add table public.transactions;

-- =========================================================
-- OPTIONAL: hard-delete messages older than 90 days on a
-- daily schedule. Requires the pg_cron extension, which you
-- enable once under Dashboard → Database → Extensions.
-- Uncomment and run separately after enabling pg_cron:
--
-- select cron.schedule(
--   'purge-old-messages',
--   '0 3 * * *',
--   $$ delete from public.messages where created_at < now() - interval '90 days'; $$
-- );
-- =========================================================

-- =========================================================
-- ACCOUNTS
-- There are no seed/sample accounts in this schema on purpose —
-- every user signs up through the app's "Create account" form,
-- which calls supabase.auth.signUp(). The trigger above creates
-- their profiles row automatically:
--   • the FIRST account ever created is auto-approved as Admin
--   • every account after that is created with approved = false
--     and can't sign in until an Admin approves them from the
--     Users page in the app
--
-- Turn OFF "Confirm email" (Authentication → Providers → Email)
-- so sign-up doesn't also require an email confirmation step —
-- approval alone is enough to gate access.
-- =========================================================
