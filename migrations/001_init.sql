-- 001_init.sql — core schema for Angel Concierge

create table guests (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  guest_info text,
  guest_phone text,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived boolean not null default false,
  check (ends_at > starts_at)
);

create index guests_active_idx on guests (archived, starts_at, ends_at);

create table calls (
  id uuid primary key default gen_random_uuid(),
  agentphone_call_id text unique,
  started_at timestamptz,
  ended_at timestamptz,
  from_number text,
  outcome text check (outcome in
    ('guest_admitted','no_match_transferred','transfer_attempted',
     'message_taken','hangup','error','in_progress')),
  matched_guest_id uuid references guests(id),
  summary text,
  raw_call_ended jsonb
);

create table call_turns (
  id bigserial primary key,
  call_id uuid references calls(id),
  role text check (role in ('caller','agent')),
  text text not null,
  at timestamptz default now()
);

create table messages (
  id uuid primary key default gen_random_uuid(),
  call_id uuid references calls(id),
  body text not null,
  taken_at timestamptz default now(),
  read_at timestamptz
);

create table push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  endpoint text unique not null,
  keys jsonb not null,
  created_at timestamptz default now()
);

-- idempotency ledger for webhook deliveries
create table webhook_events (
  webhook_id text primary key,
  received_at timestamptz default now()
);
