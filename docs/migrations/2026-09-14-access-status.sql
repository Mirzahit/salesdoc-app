-- 2026-09-14 (v961) — статус доступа считает сервер, а не каждый экран по-своему.
-- access_until / access_status пересчитывает recalcBillingForCountry (крон после импорта оплат)
-- для ВСЕХ статусов клиента; next_billing_at = access_until + 1 день, если дату не поставил
-- человек (next_billing_source = 'manual'). next_step_* — «следующий шаг» оператора из списка
-- «Действующие» (этап 3). Применено к проду через MCP apply_migration.

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS access_until DATE,
  ADD COLUMN IF NOT EXISTS access_status TEXT,          -- active | expiring | grace | overdue | none
  ADD COLUMN IF NOT EXISTS next_billing_source TEXT,    -- calc | bot | manual
  ADD COLUMN IF NOT EXISTS churned_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS next_step_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS next_step_text TEXT;

CREATE INDEX IF NOT EXISTS idx_clients_country_status_access
  ON clients (country, status, access_status);

-- Последний контакт и ближайшая открытая задача по клиенту — для колонок списка и правила «Горит».
CREATE OR REPLACE VIEW client_activity AS
SELECT
  c.client_id,
  GREATEST(
    (SELECT max(h.created_at) FROM card_history h
       WHERE h.client_id = c.client_id AND h.event_type IN ('note','call','whatsapp')),
    (SELECT max(n.created_at) FROM client_notes n WHERE n.client_id = c.client_id)
  ) AS last_contact_at,
  (SELECT min(t.deadline_at) FROM tasks t WHERE t.client_id = c.client_id AND t.status = 'open') AS next_task_at,
  (SELECT count(*) FROM tasks t WHERE t.client_id = c.client_id AND t.status = 'open') AS open_tasks
FROM clients c;
