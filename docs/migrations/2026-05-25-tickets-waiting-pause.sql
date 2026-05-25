-- 2026-05-25 — Поддержка: пауза SLA при «Ждём ответа от клиента».
-- Когда тикет переезжает в waiting_client, SLA не должен тикать — это не наша вина что
-- клиент молчит. Возвращается из ожидания → sla_due_at пушится вперёд на длительность паузы.
-- Также сохраняем накопленное время ожидания для отчётов («сколько суммарно ждали»).
--
-- Прогнать в Supabase Dashboard → SQL Editor → Run.

ALTER TABLE tickets
  ADD COLUMN IF NOT EXISTS waiting_started_at TIMESTAMPTZ,            -- момент входа в waiting_client (NULL если сейчас не в ожидании)
  ADD COLUMN IF NOT EXISTS waiting_total_seconds INT DEFAULT 0;        -- накопленная длительность всех пауз в секундах

-- Индекс под выборку «кто в ожидании»
CREATE INDEX IF NOT EXISTS idx_tickets_waiting_started
  ON tickets(waiting_started_at)
  WHERE waiting_started_at IS NOT NULL;
