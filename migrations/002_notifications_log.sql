-- 002_notifications_log.sql — audit log of every notification fan-out

create table notifications (
  id bigserial primary key,
  event text not null,
  title text not null,
  message text not null,
  pushover_ok boolean,
  webpush_sent int,
  created_at timestamptz not null default now()
);
