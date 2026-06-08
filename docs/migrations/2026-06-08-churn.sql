-- 2026-06-08 — Отток и спады клиентов. Источник: ручная выгрузка из биллинга
-- (billing.salesdoc.io/report/churn). Два файла → две таблицы:
--   churn_records          — основной отчёт (Файл 2 «Отток»): клиент, тип, суммы, причина.
--   churn_license_changes  — детализация по типам лицензий (Файл 1 «pivot»).
-- Связь файлов: company_key = хост (в Файле 2 берётся из скобок имени клиента,
-- в Файле 1 это колонка «Хост»). period_month — месяц, выбранный при загрузке.
--
-- Прогнать в Supabase Dashboard → SQL Editor → Run (или применено через MCP apply_migration).

-- === Основной отчёт по оттоку/спаду (Файл 2) ===
CREATE TABLE IF NOT EXISTS churn_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  country TEXT NOT NULL DEFAULT 'KZ',          -- 'KZ' | 'KG'
  period_month DATE NOT NULL,                  -- месяц отчёта (1-е число), выбирается при загрузке
  company_name TEXT NOT NULL,                  -- полное имя клиента
  company_key TEXT,                            -- нормализованный хост для склейки с лицензиями
  kind TEXT NOT NULL,                          -- churn (Отток) | decline (Спад) | growth (Прирост) | new (Новый)
  prev_count INT,                              -- подписок в пред. месяце
  prev_amount NUMERIC,                         -- сумма пред. подписки
  cur_count INT,                               -- подписок в текущем месяце
  cur_amount NUMERIC,                          -- сумма текущей подписки
  diff INT,                                    -- разница подписок
  reason TEXT,                                 -- причина (нормализованная)
  reason_raw TEXT,                             -- причина как в файле
  currency TEXT DEFAULT 'KZT',
  source TEXT DEFAULT 'file_import',
  upload_batch_id TEXT,                        -- группировка одной загрузки (для отката)
  uploaded_by TEXT,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  row_hash TEXT UNIQUE,                         -- country|period_month|company_key — дедуп
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_churn_records_country_month
  ON churn_records(country, period_month DESC);
CREATE INDEX IF NOT EXISTS idx_churn_records_kind
  ON churn_records(kind);

-- === Детализация по типам лицензий (Файл 1 pivot) ===
CREATE TABLE IF NOT EXISTS churn_license_changes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  country TEXT NOT NULL DEFAULT 'KZ',
  period_month DATE NOT NULL,
  company_key TEXT NOT NULL,                    -- хост
  license_type TEXT NOT NULL,                   -- admin/agent/vansel/dastavchik/...
  m1_count INT,                                 -- было (пред. месяц)
  m2_count INT,                                 -- стало (текущий месяц)
  diff INT,                                     -- m2 - m1 (минус = потеряли)
  source TEXT DEFAULT 'file_import',
  upload_batch_id TEXT,
  uploaded_by TEXT,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  row_hash TEXT UNIQUE,                          -- country|period_month|company_key|license_type
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_churn_lic_country_month
  ON churn_license_changes(country, period_month DESC);
CREATE INDEX IF NOT EXISTS idx_churn_lic_type
  ON churn_license_changes(license_type);
