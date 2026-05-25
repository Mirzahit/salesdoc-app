-- 2026-05-25 — Модуль «Задачи» (amoCRM-style follow-up tasks).
-- Spec: docs/superpowers/specs/2026-05-25-tasks-module-design.md
--
-- Архитектура: задачи привязаны к клиенту по client_id (TEXT FK на clients).
-- Идентичность пользователя — по имени оператора (operators.name), без UUID-users.
-- Просрочка считается на лету (deadline_at < NOW() AND status='open'), в БД не хранится.
--
-- Прогнать в Supabase Dashboard → SQL Editor → Run.

-- ============================================================================
-- 1) task_types — справочник 19 типов (фиксированные id, копия из amoCRM DOM)
-- ============================================================================
CREATE TABLE IF NOT EXISTS task_types (
  id   SMALLINT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  icon TEXT NOT NULL,            -- имя SVG-иконки (tabler-style)
  color VARCHAR(7) NOT NULL,     -- HEX цвета иконки
  sort SMALLINT NOT NULL
);

-- Seed (идентификаторы 1..19 — на них завязан фронт, не менять).
-- ON CONFLICT гарантирует идемпотентность миграции.
INSERT INTO task_types (id, name, icon, color, sort) VALUES
  (1,  'Связаться',        'phone',          '#c5cad1', 1),
  (2,  'Встреча',           'meeting',        '#c5cad1', 2),
  (3,  'Вебинар',           'webinar',        '#c5cad1', 3),
  (4,  'Оплата',            'payment',        '#c5cad1', 4),
  (5,  'Написать',          'message',        '#c5cad1', 5),
  (6,  'Перезвонить',       'callback',       '#c5cad1', 6),
  (7,  'Реанимация',        'refresh',        '#c5cad1', 7),
  (8,  'Видеозвонок',       'video',          '#c5cad1', 8),
  (9,  'Важный Клиент',     'star',           '#c5cad1', 9),
  (10, 'Руководителю',      'crown',          '#c5cad1', 10),
  (11, 'Получить Решение',  'check-square',   '#c5cad1', 11),
  (12, 'задача',            'arrow-up-right', '#568FFA', 12),
  (13, 'Обучение Команды',  'school',         '#c5cad1', 13),
  (14, 'Обучение клиента',  'school',         '#c5cad1', 14),
  (15, 'срок интеграции',   'clock',          '#c5cad1', 15),
  (16, 'запросы клиентов',  'inbox',          '#c5cad1', 16),
  (17, 'Горит',             'flame',          '#f51414', 17),
  (18, 'ждет',              'hourglass',      '#c5cad1', 18),
  (19, 'Желательно',        'bookmark',       '#c5cad1', 19)
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  icon = EXCLUDED.icon,
  color = EXCLUDED.color,
  sort = EXCLUDED.sort;

-- ============================================================================
-- 2) tasks — основная таблица
-- ============================================================================
CREATE TABLE IF NOT EXISTS tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Привязка к клиенту. ON DELETE SET NULL — если клиента удалят, задача остаётся
  -- (полезно для аудита: «эта задача была у Roko, потом клиента закрыли»).
  client_id TEXT REFERENCES clients(client_id) ON DELETE SET NULL,

  -- Контактное лицо со стороны клиента ("Роман", "Шалкар"). Снапшот, не FK.
  contact_name TEXT,

  -- Снапшот этапа сделки на момент создания задачи (для бейджа в карточке).
  -- "сложности с запуском", "Отзыв Получен", "Закрытая база" и т.д.
  stage_label TEXT,
  stage_color VARCHAR(7),         -- #ff8f92 для проблемных, NULL для обычных

  -- Содержание
  type_id SMALLINT NOT NULL REFERENCES task_types(id),
  text VARCHAR(1000),

  -- Дедлайн. TIMESTAMPTZ — храним с таймзоной, клиент шлёт ISO 8601.
  deadline_at TIMESTAMPTZ NOT NULL,
  deadline_end_at TIMESTAMPTZ,    -- для встреч с интервалом (15:00 - 15:30)
  is_all_day BOOLEAN NOT NULL DEFAULT false,

  -- Люди. Имена операторов (как clients.curator_operator, integrations.operator).
  -- Не FK на operators(name), чтобы переименование оператора не валило задачи —
  -- историчность важнее ссылочной целостности.
  assignee_operator TEXT NOT NULL,
  created_by TEXT NOT NULL,

  -- Состояние
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done')),
  result TEXT,                    -- ≥3 символа при закрытии (валидируется в API)

  -- Аудит
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at TIMESTAMPTZ
);

-- Индексы под основные запросы.
-- 1) Таб «Задачи» в карточке клиента — выборка по client_id + сортировка.
CREATE INDEX IF NOT EXISTS idx_tasks_client_status
  ON tasks(client_id, status);

-- 2) «Мои задачи» канбан — выборка по ответственному, только открытые.
CREATE INDEX IF NOT EXISTS idx_tasks_assignee_deadline
  ON tasks(assignee_operator, deadline_at)
  WHERE status = 'open';

-- 3) Расчёт бакетов канбана (today/tomorrow/expire/...) — фильтр по дате.
CREATE INDEX IF NOT EXISTS idx_tasks_deadline_open
  ON tasks(deadline_at)
  WHERE status = 'open';

-- Триггер на updated_at
CREATE OR REPLACE FUNCTION tasks_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_tasks_updated_at ON tasks;
CREATE TRIGGER trg_tasks_updated_at
  BEFORE UPDATE ON tasks
  FOR EACH ROW
  EXECUTE FUNCTION tasks_set_updated_at();

-- ============================================================================
-- 3) task_presets — кастомные пресеты фильтра пользователя
-- ============================================================================
-- Системные пресеты (Только мои / Просроченные / Выполненные / Все) — на фронте,
-- в БД не храним. Здесь только пользовательские (как "запросы Клиентов Горит").
CREATE TABLE IF NOT EXISTS task_presets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_operator TEXT NOT NULL,    -- имя оператора-владельца
  name TEXT NOT NULL,              -- "запросы Клиентов Горит"
  -- {types:[17,4], assignees:["Айдос"], date_from:"2026-01-01", date_to:..., statuses:["uncompl"]}
  filter JSONB NOT NULL,
  sort SMALLINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_task_presets_owner
  ON task_presets(owner_operator, sort);

-- Готово. Далее: api/tasks.js + api/tasks-presets.js.
