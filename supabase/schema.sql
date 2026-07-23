-- Tripel S AI — run this once in Supabase SQL Editor (Dashboard → SQL Editor → New query)

-- ============ profiles: one row per user, holds the credit balance ============
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  credits int not null default 20,        -- free tier allowance
  plan text not null default 'free',
  created_at timestamptz not null default now()
);
alter table public.profiles enable row level security;
create policy "read own profile" on public.profiles
  for select using (auth.uid() = id);

-- auto-create a profile whenever a new user signs up
create function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email) values (new.id, new.email);
  return new;
end; $$;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ============ jobs: one row per render job ============
create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  workflow text not null,                 -- 'magnific' | 'sss'
  status text not null default 'PENDING', -- PENDING | IN_PROGRESS | COMPLETED | FAILED
  runpod_job_id text,
  cost int not null default 1,
  output_url text,
  error text,
  created_at timestamptz not null default now()
);
create index jobs_user_created_idx on public.jobs (user_id, created_at desc);
alter table public.jobs enable row level security;
create policy "read own jobs" on public.jobs
  for select using (auth.uid() = user_id);
-- inserts/updates happen only from the backend with the service-role key (bypasses RLS)

-- ============ atomic credit spend/refund ============
-- positive p_amount = spend (fails by returning null if balance insufficient)
-- negative p_amount = refund
create function public.spend_credits(p_user_id uuid, p_amount int)
returns int language plpgsql security definer set search_path = public as $$
declare new_balance int;
begin
  update public.profiles
     set credits = credits - p_amount
   where id = p_user_id and credits >= p_amount
  returning credits into new_balance;
  return new_balance;  -- null means insufficient credits
end; $$;

-- ============ storage buckets ============
insert into storage.buckets (id, name, public) values ('inputs', 'inputs', false)
  on conflict (id) do nothing;
insert into storage.buckets (id, name, public) values ('outputs', 'outputs', true)
  on conflict (id) do nothing;

-- users may upload inputs only into their own folder: inputs/<their-uid>/...
create policy "upload own inputs" on storage.objects
  for insert with check (
    bucket_id = 'inputs'
    and auth.role() = 'authenticated'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
create policy "read own inputs" on storage.objects
  for select using (
    bucket_id = 'inputs'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
-- outputs bucket is public-read; writes happen via service role only
create policy "public read outputs" on storage.objects
  for select using (bucket_id = 'outputs');
