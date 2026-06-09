-- 2026-06-09 — billing_host: постоянный ключ связи клиента с биллингом (логин-хост).
-- Сопоставление по названию промахивается («KAT» в базе vs «йокосан» в биллинге),
-- поэтому привязываем стабильный код-хост (bleskkz, aspgroup). Один хост = один клиент (в рамках страны).
-- Заполняется разовой привязкой из «Базы активных клиентов» (хост берётся из скобок имени).
-- Прогнать в Supabase Dashboard → SQL Editor → Run (или MCP apply_migration). Уже применено к проду.

ALTER TABLE clients ADD COLUMN IF NOT EXISTS billing_host TEXT;

-- Partial unique: NULL разрешён многим, непустой хост уникален в рамках страны.
CREATE UNIQUE INDEX IF NOT EXISTS uq_clients_billing_host
  ON clients (country, billing_host)
  WHERE billing_host IS NOT NULL AND billing_host <> '';
