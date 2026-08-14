-- 004_call_acks.sql — transfer acknowledgments.
-- Cold transfers are one-way (a declined transfer strands the caller in
-- voicemail), so the AI holds the concierge and transfers only after Scott or
-- Monica taps the ack link in the priority notification.

create table call_acks (
  call_id uuid primary key references calls(id),
  target text not null check (target in ('scott','monica')),
  acked_at timestamptz not null default now()
);
