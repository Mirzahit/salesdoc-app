-- 2026-07-09 (v813): центр уведомлений — таблица notifications + Telegram-привязка сотрудников.
-- ПРИМЕНЕНО к Supabase zxrahvoyfcfrphdqabwd в этот же день.
--
-- ВАЖНО (v813-qa): дедуп — ПОЛНЫЙ constraint, не частичный индекс. PostgREST шлёт
-- ON CONFLICT (user_email,dedup_key) без WHERE, а Postgres не подбирает частичный
-- индекс под такой ON CONFLICT → падала бы каждая вставка (42P10).
-- NULL-ключи (упоминания/задачи) не конфликтуют между собой: в Postgres NULL != NULL.

CREATE TABLE notifications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_email  text NOT NULL,
  type        text NOT NULL CHECK (type IN ('intg_deadline','intg_overdue','impl_stuck','mention','task_assigned')),
  title       text NOT NULL,
  body        text,
  entity_type text,          -- 'integration' | 'kanban_card' | 'task' | 'client'
  entity_id   text,
  client_id   text,
  actor       text,          -- имя автора события (для упоминаний/задач), null у крона
  dedup_key   text,          -- только у кроновых напоминаний
  is_read     boolean NOT NULL DEFAULT false,
  tg_sent     boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notifications_user_dedup_uniq UNIQUE (user_email, dedup_key)
);
CREATE INDEX notifications_user_idx ON notifications (user_email, created_at DESC);
CREATE INDEX notifications_user_unread_idx ON notifications (user_email) WHERE is_read = false;

ALTER TABLE employees ADD COLUMN tg_chat_id text;       -- чат бота @salesdoc_reports_bot
ALTER TABLE employees ADD COLUMN tg_link_code text;     -- одноразовый код привязки
ALTER TABLE employees ADD COLUMN tg_link_code_at timestamptz; -- TTL кода 15 минут
