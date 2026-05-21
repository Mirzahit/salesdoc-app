-- 2026-05-21 (вторая миграция, после основной)
-- Добавляем sheet_month + уникальный индекс — нужно для идемпотентности при автосоздании
-- интеграций по платежам от payment_bot. Без этого бот при ретрае создаст дубль.

ALTER TABLE integrations ADD COLUMN IF NOT EXISTS sheet_month INT;

-- Уникальный индекс гарантирует что одна оплата = одна интеграция в Supabase.
-- Партиальный (только когда оба поля заполнены — для импортированных из Sheets
-- ручных записей они null и не блокируют).
CREATE UNIQUE INDEX IF NOT EXISTS uq_integrations_sheet_idem
  ON integrations(country, sheet_month, sheet_row)
  WHERE sheet_month IS NOT NULL AND sheet_row IS NOT NULL;
