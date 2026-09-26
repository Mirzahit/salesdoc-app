-- v1005 «Финансист»: ответы на вопросы агента и настройки (остаток по счетам).
-- Применено в Supabase 26.09.2026 (миграция finansist_answers_and_settings).
-- Доступ только через /api/finansist (право view_finansist: admin и accountant).
-- RLS включена без политик: напрямую с anon-ключом таблицы не читаются и не пишутся,
-- сервер ходит сервисным ключом.
create table if not exists public.finansist_answers (
  id uuid primary key default gen_random_uuid(),
  country text not null default 'KG',
  month text not null,                 -- 'YYYY-MM'
  question_id text not null,           -- '2026-09:bank' и т.п.
  answer_idx smallint not null,
  answer_text text,
  answered_by text not null,           -- email
  answered_by_name text,
  answered_at timestamptz not null default now(),
  unique (country, month, question_id)
);
alter table public.finansist_answers enable row level security;

create table if not exists public.finansist_settings (
  key text primary key,                -- 'balance_KG'
  value jsonb not null default '{}'::jsonb,
  updated_by text,
  updated_by_name text,
  updated_at timestamptz not null default now()
);
alter table public.finansist_settings enable row level security;
