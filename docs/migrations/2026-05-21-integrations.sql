-- 2026-05-21 — Таблица integrations (карты процесса интеграции).
-- Архитектура: client_id из clients = главная карта; integrations = временные карты
-- процессов интеграции, привязанные к клиенту. Подробнее см.
-- memory/project_client_card_architecture.md
--
-- Прогнать в Supabase Dashboard → SQL Editor → Run.

CREATE TABLE IF NOT EXISTS integrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Привязка к главной карте клиента (постоянной)
  client_id TEXT REFERENCES clients(client_id) ON DELETE SET NULL,

  -- Дублируем название компании (на случай если не нашли клиента при импорте)
  company_name TEXT NOT NULL,

  -- Страна (KZ или KG), как в clients
  country VARCHAR(2) DEFAULT 'KZ',

  -- Статус процесса интеграции. Значения договорим точно с интеграторами,
  -- пока берём те что встречаются в Google-таблице.
  -- Возможные: 'Новая', 'В работе', 'Готово', 'Отменено', 'На паузе'
  status TEXT DEFAULT 'Новая',

  -- Тип задачи интегратора (как в Sheets-колонке «Тип»):
  -- 'Интеграция', 'Доработка', 'Разработка'
  type TEXT,

  -- Пакет/тариф интеграции (как в Sheets-колонке «тип интеграции»):
  -- 'Стандарт', 'Стандарт Плюс', 'Премиум', 'ПАКЕТ-1', 'ПАКЕТ-2', 'ПАКЕТ-3'
  package TEXT,

  -- Вид базы клиента: 'бух', '1С 8.3', и т.п.
  db_type TEXT,

  -- Кто из интеграторов работает (имя/ID).
  -- Пока TEXT — позже можно вынести в отдельную таблицу users если будет нужно.
  operator TEXT,

  -- Менеджер продаж который привёл интеграцию (опционально)
  manager TEXT,

  -- Даты процесса
  date_paid DATE,        -- когда оплачена интеграция
  date_taken DATE,       -- когда интегратор взял в работу
  deadline DATE,         -- крайний срок
  date_done DATE,        -- когда сделано

  -- Доступы к серверу клиента (видят все интеграторы)
  login_password TEXT,
  server TEXT,

  -- Контактные лица со стороны клиента (имя, телефон, должность)
  contact_persons TEXT,

  -- Развёрнутый комментарий что именно нужно сделать
  comment TEXT,

  -- Аудит миграции: какая строка в исходной Google-таблице была импортирована.
  -- Пригодится если найдём ошибки переноса и придётся откатывать.
  sheet_row INT,

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Индексы для быстрых выборок на дашборде и в карте клиента
CREATE INDEX IF NOT EXISTS idx_integrations_client_id ON integrations(client_id);
CREATE INDEX IF NOT EXISTS idx_integrations_status ON integrations(status);
CREATE INDEX IF NOT EXISTS idx_integrations_country ON integrations(country);
CREATE INDEX IF NOT EXISTS idx_integrations_operator ON integrations(operator);
CREATE INDEX IF NOT EXISTS idx_integrations_created_at ON integrations(created_at DESC);

-- Триггер на updated_at — автоматически обновляется при любом PATCH
CREATE OR REPLACE FUNCTION integrations_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_integrations_updated_at ON integrations;
CREATE TRIGGER trg_integrations_updated_at
  BEFORE UPDATE ON integrations
  FOR EACH ROW
  EXECUTE FUNCTION integrations_set_updated_at();

-- Готово. После этого можно создавать /api/integrations и импортировать данные из Sheets.
