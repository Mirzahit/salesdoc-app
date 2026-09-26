-- v1006 «Финансист»: агент. SQL утверждён CEO 26.09.2026, применён в Supabase 27.09.2026
-- (миграция finansist_agent_tables). RLS включена без политик: доступ только через сервер
-- (/api/finansist-agent, право view_finansist — admin и accountant).
--
-- Отличие от утверждённого текста: в finansist_missing_data добавлен статус 'superseded' —
-- «после ручной суммы в таблице появилась настоящая строка, ручная больше не учитывается»
-- (защита от двойного учёта по требованию CEO), и поле updated_at.

create table public.finansist_chat_messages (
  id uuid primary key default gen_random_uuid(),
  country text not null default 'KG',
  role text not null check (role in ('user','assistant')),
  content text not null,
  tool_trace jsonb,                       -- какие инструменты вызвал и с какими периодами
  author_email text, author_name text,    -- для user; для assistant null
  model text, input_tokens int, output_tokens int, cost_usd numeric(10,4),
  created_at timestamptz not null default now()
);
alter table public.finansist_chat_messages enable row level security;
create index finansist_chat_messages_created_idx on public.finansist_chat_messages (country, created_at desc);

create table public.finansist_questions (
  id uuid primary key default gen_random_uuid(),
  country text not null default 'KG',
  month text not null,                    -- 'YYYY-MM'
  key text not null,                      -- устойчивый ключ: bank:<payment_id>, dup:<id>, dec:<id>, missing:<item>, odd:<item>, superseded:<item>:<month>
  type text not null,                     -- bank | dup | dec | missing | goal | other
  title text not null, body text not null,
  options jsonb not null,                 -- варианты ответа
  evidence jsonb,                         -- цифры и откуда взяты
  amount numeric,
  status text not null default 'open' check (status in ('open','answered','dismissed')),
  answer_idx smallint, answer_text text, answered_by text, answered_by_name text, answered_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (country, month, key)
);
alter table public.finansist_questions enable row level security;

create table public.finansist_missing_data (
  id uuid primary key default gen_random_uuid(),
  country text not null default 'KG',
  month text not null,
  item_key text not null,                 -- rent | amo | ads | telephony | whatsapp | water | taxi | sim
  item_label text not null,
  status text not null default 'missing' check (status in ('missing','odd','filled','superseded','ignored')),
  expected_amount numeric,                -- медиана трёх прошлых месяцев с данными
  found_amount numeric,                   -- что нашлось в таблице
  note text,                              -- что именно спросить у Гульшан
  amount numeric,                         -- внесла бухгалтер; учитывается, пока status='filled'
  filled_by text, filled_by_name text, filled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (country, month, item_key)
);
alter table public.finansist_missing_data enable row level security;

create table public.finansist_decisions (
  id uuid primary key default gen_random_uuid(),
  country text not null default 'KG',
  key text not null,
  text text not null,
  source text not null,                   -- question | chat
  month text,
  decided_by text, decided_by_name text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (country, key)
);
alter table public.finansist_decisions enable row level security;

-- Снимок расходов из Google-таблицы: Apps Script отвечает 10–20 секунд, агент столько ждать не должен.
-- Текущий месяц обновляется раз в час, прошлые — раз в сутки.
create table public.finansist_expenses_cache (
  month text primary key,                 -- 'YYYY-MM'
  rows jsonb not null,
  fetched_at timestamptz not null default now()
);
alter table public.finansist_expenses_cache enable row level security;

drop table public.finansist_answers;      -- пустая, заменена finansist_questions

-- Настройки в app_settings (без новых таблиц):
--   finansist_agent_limits  {"daily_usd": 10}   — дневной лимит расходов на API
--   finansist_agent_spend   {"YYYY-MM-DD": usd} — факт расхода по дням (пишет сервер)
--   finansist_expected_items                    — зарезервировано под правку обязательных статей без кода
