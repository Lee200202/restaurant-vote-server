-- Run once in Supabase: SQL Editor -> New query -> Run
create table if not exists public.poll_state (
  id int primary key,
  data jsonb not null,
  updated_at timestamptz not null default now()
);

-- Lock the table: browsers (anon key) get no access; only the server's secret key can read/write.
alter table public.poll_state enable row level security;
