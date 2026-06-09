-- 2026-06-09 — Ручные причина+комментарий по компании для раздела «Отток и спады».
-- Оверлей поверх вычисляемого единого списка (_churnUnified на фронте): строки спадов
-- существуют только на лету (из churn_license_changes), записей под них в churn_records нет,
-- поэтому ручные пометки храним отдельной таблицей с ключом (country, period_month, company_key).
-- Ручная причина перекрывает причину из файла (churn_records.reason) на фронте.
--
-- Прогнать в Supabase Dashboard → SQL Editor → Run (или через MCP apply_migration). Уже применено к проду.

CREATE TABLE IF NOT EXISTS churn_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  country TEXT NOT NULL DEFAULT 'KZ',           -- 'KZ' | 'KG'
  period_month DATE NOT NULL,                   -- месяц (1-е число), как в churn_records
  company_key TEXT NOT NULL,                    -- нормализованный хост (lowercase)
  reason TEXT,                                  -- ручная причина (перекрывает файловую)
  comment TEXT,                                 -- свободный комментарий: о чём договорились / что делаем
  updated_by TEXT,                              -- автор последней правки (x-user-name)
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_churn_notes UNIQUE (country, period_month, company_key)
);

CREATE INDEX IF NOT EXISTS idx_churn_notes_country_month
  ON churn_notes(country, period_month DESC);

ALTER TABLE churn_notes ENABLE ROW LEVEL SECURITY;
