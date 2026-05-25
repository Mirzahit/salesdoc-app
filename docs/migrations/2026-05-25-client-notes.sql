-- 2026-05-25 — Примечания (заметки) по клиенту. Отдельно от tasks: у заметок нет дедлайна
-- и ответственного, они immutable после создания. Соответствует амоCRM «Примечание».
-- Spec: docs/superpowers/specs/2026-05-25-tasks-module-design.md (раздел добавлен v453).
--
-- Прогнать в Supabase Dashboard → SQL Editor → Run.

CREATE TABLE IF NOT EXISTS client_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Привязка к клиенту. ON DELETE SET NULL — заметка остаётся в истории даже если клиента
  -- архивируют (см. tasks с тем же подходом).
  client_id TEXT REFERENCES clients(client_id) ON DELETE SET NULL,

  -- Содержимое заметки (краткая запись «дозвонился — попросил перезвонить во вторник»).
  text TEXT NOT NULL CHECK (length(text) >= 1),

  -- Автор. Имя оператора (как clients.curator_operator, tasks.created_by).
  created_by TEXT NOT NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Индекс под основной запрос «История по клиенту».
CREATE INDEX IF NOT EXISTS idx_client_notes_client_created
  ON client_notes(client_id, created_at DESC);
