-- ============================================================
--  FloraForce CRM — Supabase Schema
--  Cole no SQL Editor do Supabase e clique "Run"
-- ============================================================

-- 1. Profiles (extends auth.users)
create table if not exists public.profiles (
  id          uuid references auth.users(id) on delete cascade primary key,
  name        text not null,
  role        text not null default 'vendor', -- 'admin' | 'vendor'
  created_at  timestamptz default now()
);

-- RLS
alter table public.profiles enable row level security;
create policy "Users can read all profiles"  on public.profiles for select using (true);
create policy "Users can update own profile" on public.profiles for update using (auth.uid() = id);
create policy "Admin can insert profiles"    on public.profiles for insert with check (true);

-- 2. Lead states
create table if not exists public.lead_states (
  id            bigserial primary key,
  lead_id       integer not null unique,
  responsible   text,
  cs            text default 'novo',
  tags          jsonb default '[]',
  priority      boolean default false,
  call_count    integer default 0,
  last_call     timestamptz,
  converted     boolean default false,
  notes         text default '',
  timeline      jsonb default '[]',
  updated_by    uuid references auth.users(id),
  updated_at    timestamptz default now()
);

alter table public.lead_states enable row level security;
-- Admin sees all, vendor sees only their leads
create policy "Admin reads all lead_states" on public.lead_states
  for select using (
    exists (select 1 from public.profiles where id = auth.uid() and role = 'admin')
  );
create policy "Vendor reads own lead_states" on public.lead_states
  for select using (
    exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role = 'vendor'
      and responsible = p.name
    )
  );
create policy "Authenticated can upsert lead_states" on public.lead_states
  for all using (auth.uid() is not null);

-- 3. Call counts
create table if not exists public.call_counts (
  id          bigserial primary key,
  user_id     uuid references auth.users(id) on delete cascade,
  vendor_name text not null,
  week_key    text not null,
  calls       integer default 0,
  updated_at  timestamptz default now(),
  unique(user_id, week_key)
);

alter table public.call_counts enable row level security;
create policy "Users manage own call_counts" on public.call_counts
  for all using (auth.uid() = user_id);
create policy "Admin reads all call_counts" on public.call_counts
  for select using (
    exists (select 1 from public.profiles where id = auth.uid() and role = 'admin')
  );

-- 4. Activity log
create table if not exists public.activity_log (
  id          bigserial primary key,
  user_id     uuid references auth.users(id) on delete set null,
  user_name   text,
  lead_id     integer,
  lead_name   text,
  action      text not null,  -- 'call' | 'status_change' | 'comment' | 'tag' | 'transfer' | 'login'
  detail      text,
  created_at  timestamptz default now()
);

alter table public.activity_log enable row level security;
create policy "Admin reads all activity" on public.activity_log
  for select using (
    exists (select 1 from public.profiles where id = auth.uid() and role = 'admin')
  );
create policy "Vendor reads own activity" on public.activity_log
  for select using (auth.uid() = user_id);
create policy "Authenticated can insert activity" on public.activity_log
  for insert with check (auth.uid() is not null);

-- 5. Helper function: is_admin
create or replace function public.is_admin()
returns boolean language sql security definer as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin'
  );
$$;

-- Done!
select 'Schema created successfully! ✅' as status;
