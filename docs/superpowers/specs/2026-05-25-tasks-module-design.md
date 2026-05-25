# Модуль «Задачи» — Design Spec

**Дата:** 2026-05-25
**Статус:** draft
**Источник:** ТЗ от пользователя `TZ_TASKS_SALESDOC.md` + амоCRM-референс DOM
**Связанные памяти:** [[project_integration_migration_state]], [[project_client_card_architecture]]

---

## 1. Контекст и цель

Менеджеры/операторы SalesDoc теряют касания с клиентами. Цель — модуль «Задачи» по образу `amoCRM /todo/line/`: каждый активный клиент имеет открытую задачу с обязательным результатом при закрытии.

Две точки входа:
1. **Глобальная страница «Мои задачи»** (`view-mytasks`) — канбан задач текущего пользователя по бакетам сроков.
2. **Таб «Задачи»** в карточке клиента (рядом со старым табом «Календарь») — inline-форма + список открытых + история.

---

## 2. Адаптации ТЗ под реальный стек

ТЗ написан в нотации «PostgreSQL + Express + React» — это не соответствует фактическому стеку. Ниже — отклонения и обоснование. **Бизнес-правила и UI-логика ТЗ сохраняются дословно.**

| ТЗ | Реализация | Причина |
|---|---|---|
| React-компоненты (`TasksKanban`, `TaskCard`, ...) | JS-namespace в `index.html`: `crmTasksKanbanRender()`, `crmTaskCardHtml()`, `crmTasksFormRender()` | Проект — монолитный SPA, нет сборщика, нет React. Существующие модули (kanban, calendar) сделаны так же. |
| `react-dnd` / `@dnd-kit/core` | Нативный HTML5 drag-and-drop (`draggable=true`, `ondragstart`, `ondrop`). Уже используется в `crmCalDragStartTask` (`index.html:28069`). | Никаких новых зависимостей. PWA через Vercel остаётся самосборной. |
| `Express` + REST routes | Vercel serverless functions в `api/tasks.js`. Один файл, ветвление по HTTP-методу и query (как `api/clients.js`). | Существующий паттерн проекта (Vercel + PostgREST через `_supabase.js`). |
| `PostgreSQL` напрямую | Supabase REST через `_supabase.js` (`sbSelect/sbInsert/sbUpdate/sbDelete`). | Уже используется во всех остальных API. |
| `assignee_id UUID FK → users.id` | `assignee_operator TEXT REFERENCES operators(name)` | В проекте нет таблицы `users`. Идентичность операторов — по имени (см. `clients.curator_operator`, `integrations.operator`). Создавать `users` ради этого модуля — лишний скоуп. |
| `created_by UUID FK → users.id` | `created_by TEXT` (имя оператора). | Аналогично. |
| `client_id UUID FK → clients.id` | `client_id TEXT REFERENCES clients(client_id) ON DELETE SET NULL` | В `clients` PK — `client_id` строкой (`SD-KZ-2026-NNNNN`), не UUID. Подтверждено в `docs/migrations/2026-05-21-integrations.sql`. |
| `lead_id UUID FK → leads.id` | Поле **исключено из MVP** | Таблицы `leads` в проекте нет. Лиды живут в amoCRM. Если понадобится — позже добавим `amo_lead_id TEXT`. |
| Drag-handle для сортировки пресетов | **Не делаем в MVP** | Усложняет до неоправданного. Пресеты в фиксированном порядке: системные → кастомные → корзина. |
| Тесты Jest/Vitest | Ручной чек-лист в конце фазы 1 (curl-команды) + smoke-test в браузере | Проект не имеет автотестов. Заводить тулинг ради одного модуля — out of scope. |
| Авто-задача «Связаться» при создании клиента | **Фаза 5 (после MVP)** | Требует правки `api/clients.js`. Выносим, чтобы не блокировать MVP. |
| `GET /api/clients/without-tasks` | **Фаза 5** | Отдельный отчётный endpoint. Не нужен для основного потока. |

**Сохраняется без изменений:**
- Все цвета и шрифт `'PT Sans', Arial, sans-serif` из секции «Дизайн-токены».
- 19 типов задач (seed-данные `task_types`).
- Бизнес-правило «закрытие требует `result ≥ 3 символов`».
- Логика drag-зон (Послезавтра / След. неделя / След. месяц / Завершить / Удалить).
- Колонки канбана и их видимость по умолчанию.

---

## 3. Архитектура

```
┌────────────────────────────────────────────────────────────────┐
│ index.html  (фронт)                                            │
│                                                                │
│  ┌─────────────────────┐    ┌─────────────────────────────┐   │
│  │ view-mytasks        │    │ карточка клиента → таб      │   │
│  │ (канбан, фильтры,   │    │ "Задачи" (форма+список)     │   │
│  │  пресеты, drag&drop)│    │  crmClientTasksRender()     │   │
│  │  crmTasksKanban*    │    └─────────────────────────────┘   │
│  └──────────┬──────────┘                  │                    │
│             │                             │                    │
│             └──────────┬──────────────────┘                    │
│                        ▼                                       │
│                 fetch('/api/tasks?...')                        │
└────────────────────────┬───────────────────────────────────────┘
                         │
                         ▼
┌────────────────────────────────────────────────────────────────┐
│ api/tasks.js  (Vercel serverless)                              │
│  - GET / POST / PATCH / DELETE  по HTTP-методу                 │
│  - спец-действия через query: ?kanban=1, ?close=1, ?move=1     │
│  - auth: checkAuth (shared APP_TOKEN)                          │
│  - использует _supabase.js (sbSelect/sbInsert/...)             │
└────────────────────────┬───────────────────────────────────────┘
                         │ PostgREST
                         ▼
┌────────────────────────────────────────────────────────────────┐
│ Supabase                                                       │
│   tasks        — основная таблица                              │
│   task_types   — справочник 19 типов (seed)                    │
│   task_presets — кастомные пресеты фильтра пользователя        │
│   (clients и operators — уже существуют)                       │
└────────────────────────────────────────────────────────────────┘
```

**Изоляция от существующего:** ничего не трогаем в `crm_events` (localStorage), глобальный «Календарь» (`view-calendar`) и таб «Календарь» в карточке остаются как есть. Новый модуль живёт параллельно.

---

## 4. Модель данных

### 4.1. `task_types` (справочник)

```sql
CREATE TABLE IF NOT EXISTS task_types (
  id SMALLINT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  icon TEXT NOT NULL,        -- имя SVG-иконки (tabler-style)
  color TEXT NOT NULL,       -- HEX цвета иконки
  sort SMALLINT NOT NULL
);
```

**Seed 19 строк** (точные имена/цвета — см. секцию 4 ТЗ, таблица типов):

```
1  Связаться        phone           #c5cad1
2  Встреча          meeting         #c5cad1
3  Вебинар          webinar         #c5cad1
4  Оплата           payment         #c5cad1
5  Написать         message         #c5cad1
6  Перезвонить      callback        #c5cad1
7  Реанимация       refresh         #c5cad1
8  Видеозвонок      video           #c5cad1
9  Важный Клиент    star            #c5cad1
10 Руководителю     crown           #c5cad1
11 Получить Решение check-square    #c5cad1
12 задача           arrow-up-right  #568FFA
13 Обучение Команды school          #c5cad1
14 Обучение клиента school          #c5cad1
15 срок интеграции  clock           #c5cad1
16 запросы клиентов inbox           #c5cad1
17 Горит            flame           #f51414
18 ждет             hourglass       #c5cad1
19 Желательно       bookmark        #c5cad1
```

ID фиксированные (1..19) — на них завязан клиентский код.

### 4.2. `tasks` (основная)

```sql
CREATE TABLE IF NOT EXISTS tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Привязка
  client_id TEXT REFERENCES clients(client_id) ON DELETE SET NULL,
  contact_name TEXT,           -- "Роман", "Шалкар" — лицо со стороны клиента
  stage_label TEXT,            -- "сложности с запуском" — снапшот этапа сделки на момент создания
  stage_color VARCHAR(7),      -- #ff8f92 для проблемных, для остальных NULL

  -- Содержание
  type_id SMALLINT NOT NULL REFERENCES task_types(id),
  text VARCHAR(1000),

  -- Дедлайн
  deadline_at TIMESTAMPTZ NOT NULL,
  deadline_end_at TIMESTAMPTZ,    -- для встреч с интервалом
  is_all_day BOOLEAN NOT NULL DEFAULT false,

  -- Люди (имена операторов, FK на operators(name) опционально — пока TEXT для гибкости)
  assignee_operator TEXT NOT NULL,
  created_by TEXT NOT NULL,

  -- Состояние
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done')),
  result TEXT,                    -- ≥3 символа при закрытии (проверяется в API)

  -- Аудит
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at TIMESTAMPTZ
);

CREATE INDEX idx_tasks_client_status ON tasks(client_id, status);
CREATE INDEX idx_tasks_assignee_deadline ON tasks(assignee_operator, deadline_at) WHERE status = 'open';
CREATE INDEX idx_tasks_deadline_open ON tasks(deadline_at) WHERE status = 'open';
```

**Расчёт `is_overdue` — на лету**, не хранится: `deadline_at < NOW() AND status = 'open'`.

**Бакеты для канбана** (вычисляются в `api/tasks.js`):
- `expire` — `deadline_at < CURRENT_DATE AND status='open'`
- `today` — `deadline_at::date = CURRENT_DATE AND status='open'`
- `tomorrow` — `deadline_at::date = CURRENT_DATE + 1 AND status='open'`
- `this_week` — `deadline_at` в текущей неделе (после завтра) AND `status='open'`
- `next_week` — `deadline_at` в следующей неделе AND `status='open'`
- `this_month` — `deadline_at` в текущем месяце (после след. недели) AND `status='open'`
- `future` — всё остальное `status='open'`
- `completed` — `status='done'`

Неделя считается с понедельника (KZ/RU локаль).

### 4.3. `task_presets` (кастомные фильтр-пресеты пользователя)

```sql
CREATE TABLE IF NOT EXISTS task_presets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_operator TEXT NOT NULL,    -- кому принадлежит
  name TEXT NOT NULL,              -- "запросы Клиентов Горит"
  filter JSONB NOT NULL,           -- {types:[17,4], assignees:["Айдос"], date_from, date_to, ...}
  sort SMALLINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_task_presets_owner ON task_presets(owner_operator, sort);
```

Системные пресеты (Только мои / Просроченные / Выполненные / Все) — захардкожены на фронте, в БД не хранятся.

---

## 5. API (`api/tasks.js`)

Один файл, ветвление по `req.method` и query. Все запросы — через `checkAuth`.

| Метод | Запрос | Эффект |
|---|---|---|
| `GET` | `/api/tasks?client_id=SD-...&status=open\|done\|all` | Задачи клиента (для таба в карточке) |
| `GET` | `/api/tasks?kanban=1&assignee=Айдос&preset=my` | Канбан: возвращает `{expire:[...], today:[...], tomorrow:[...], ...}` |
| `GET` | `/api/tasks?id=UUID` | Одна задача |
| `GET` | `/api/tasks?types=1` | Все 19 типов из справочника (отдаёт `task_types`) |
| `GET` | `/api/tasks-presets?owner=Айдос` | Кастомные пресеты юзера (отдельный файл `api/tasks-presets.js`, потому что Vercel роутит по файлам) |
| `POST` | `/api/tasks` | Создать. Body: `{client_id?, type_id, text, deadline_at, deadline_end_at?, is_all_day, assignee_operator, contact_name?, stage_label?, stage_color?}`. `created_by` берётся из header `x-user-name`. |
| `POST` | `/api/tasks-presets` | Создать пресет. Body: `{name, filter}`. |
| `PATCH` | `/api/tasks?id=UUID` | Изменить (whitelist полей: text/deadline_at/deadline_end_at/is_all_day/type_id/assignee_operator). `updated_at = NOW()`. |
| `PATCH` | `/api/tasks?id=UUID&close=1` | Закрыть. Body: `{result}`. Валидация: `result` строка ≥3 символов после `.trim()`. Иначе 400. Эффект: `status='done', closed_at=NOW(), result=...`. |
| `PATCH` | `/api/tasks?id=UUID&move=TARGET` | Drag-перенос. `TARGET ∈ {today, tomorrow, after_tomorrow, next_week, next_month, done}`. Пересчёт `deadline_at`. `done` без result → 400. |
| `DELETE` | `/api/tasks?id=UUID` | Удалить. Разрешено если header `x-user-name === created_by` ИЛИ `x-user-role === admin`. Иначе 403. |
| `DELETE` | `/api/tasks-presets?id=UUID` | Удалить пресет. Только владелец. |

**Идентификация пользователя на сервере:** клиент шлёт `x-user-name` и `x-user-role` в headers (берутся из `currentUser` на фронте). Это **не безопасность** в смысле криптографии — авторизация всего API уже сделана через `APP_TOKEN`. Заголовки нужны только для разграничения «свой/чужой» при удалении/правке. Полноценный JWT-auth — отдельный проект.

**Формат `deadline_at` от клиента:** ISO 8601 (`2026-05-26T15:00:00+05:00`). API не парсит и не пересчитывает таймзону — Postgres хранит `TIMESTAMPTZ`.

---

## 6. UI: Таб «Задачи» в карточке клиента

Добавляем к существующему `crm-tabs` (`index.html:30709`) новый таб `tasks` рядом с `calendar`.

```
crmActivateTab() → if (tab === 'tasks') crmClientTasksRender(card.client_id)
```

### 6.1. Inline-форма создания (бирюзовый бордер `#14b8a6`)

Структура из ТЗ §7 сохраняется дословно. Реализация:

```
[Задача ▾]  на  [Сегодня ▾]  [22:21 - 22:51 ▾]  для  [Айдос ▾]  :  [☎ Связаться ▾] :
─────────────────────────────────────────────────────────────────────────────
Введите описание задачи...
─────────────────────────────────────────────────────────────────────────────
[Поставить]   Отменить                                                  [⌨]
```

- «Задача ▾» — лейбл, при клике открывает дропдаун выбора типа (19 типов).
- Чип даты — выпадашка: `Сегодня / Завтра / Послезавтра / Через неделю / Свободная дата...` → `<input type="date">`.
- Чип времени — поповер с двумя `<input type="time">` (start и end), либо чекбокс «Весь день».
- Ответственный — синяя ссылка `#60a5fa`, дропдаун = список операторов из `operators`.
- Иконка типа + название — синхронизированы с выбранным типом.
- Кнопка «Поставить» — серый `#475569` при пустом тексте, синий `#2563eb` когда текст ≥1 символа.

### 6.2. Список открытых задач

Карточка задачи (открытая) — бирюзовый бордер `#14b8a6`, аватар `⊙` (часы), кнопки «Выполнить» / «⋯» (изменить / удалить).

### 6.3. История

Закрытые задачи — серый бордер `#374151`, opacity 0.6, текст зачёркнут, ниже отдельной строкой: `Результат: ...`.

### 6.4. Модалка «Выполнить» (закрытие задачи)

```
╭──────────────────────────────────────╮
│  Закрыть задачу                    × │
├──────────────────────────────────────┤
│  Задача: Связаться — тест            │
│                                      │
│  Результат (обязательно):            │
│  ┌──────────────────────────────┐   │
│  │ дозвонился, договорились...  │   │
│  └──────────────────────────────┘   │
│  Минимум 3 символа                   │
│                                      │
│  [Закрыть задачу]  Отмена            │
╰──────────────────────────────────────╯
```

Кнопка «Закрыть задачу» disabled пока `result.trim().length < 3`.

После успешного закрытия — попап: «Поставить следующую задачу?» → если да, открыть форму создания с предзаполненным `client_id` и `contact_name`.

---

## 7. UI: Страница «Мои задачи» (`view-mytasks`)

Новый view в навигации (после `view-calendar`). Permission key — `view_mytasks` (по умолчанию `1` для всех ролей кроме `viewer`).

Структура из ТЗ §6 сохраняется. Реализация:

### 7.1. Топ-бар (42px, фон `#0e1626`)

```
[▦] [≡]   День Неделя Месяц   [🔍 Фильтр              N задач]   [⋯]   [+ Добавить задачу]
```

- `▦`/`≡` — два режима: канбан (по умолчанию) и список. День/Неделя/Месяц — пока **заглушки** (не блокируют MVP, открывают `view-calendar` со старым календарём).
- Поле «Фильтр» — кликабельное, по клику раскрывается панель фильтра поверх канбана.
- `⋯` — контекстное меню: «Управление типами задач», «Экспорт», «Автообновление» (toggle). «Экспорт» и «Управление типами» в MVP — заглушки или скрытые пункты.

### 7.2. Канбан (3 видимые колонки по умолчанию)

По умолчанию: `expire`, `today`, `tomorrow`. При выборе пресета «Все задачи» или «Выполненные» — показываем нужные колонки.

Точная палитра колонок — из секции «Дизайн-токены» ТЗ (#f37575 / #6CC09C / #c3c2c3 / #92989b). Полоска под заголовком — `height: 2px`, без скругления.

### 7.3. Карточка задачи на канбане

Структура из ТЗ §6 «Карточка задачи на канбане» — порядок полей 1-5 сохраняется дословно.

### 7.4. Drag-and-drop

- Между колонками канбана → `PATCH /api/tasks?id=X&move=today|tomorrow`.
- В drop-зону футера («Послезавтра», «След. неделя», «След. месяц», «Завершить», «🗑 Удалить») → `PATCH ?move=after_tomorrow|next_week|next_month|done` или `DELETE`.
- При drop на «Завершить» → открываем модалку закрытия (вместо мгновенного move).
- При drop на «🗑» → `confirm('Удалить задачу?')` → DELETE.

### 7.5. Панель фильтра

Раскрывается оверлеем поверх канбана. Структура из ТЗ §6 «Панель фильтра» сохраняется. В MVP — без drag-handle сортировки пресетов, без редактирования имени пресета (только создать/удалить).

---

## 8. Бизнес-правила (из ТЗ §8 — без изменений)

1. Нельзя закрыть задачу без `result.trim().length ≥ 3`.
2. Один клиент может иметь несколько открытых задач.
3. Удалять задачи может только `created_by` или роль `admin`.
4. После закрытия — попап «Поставить следующую задачу?».
5. Просрочка считается динамически (не хранится).
6. Drag в зону → меняет `deadline_at`:
   - `Сегодня` → `CURRENT_DATE` + сохраняем существующее время дня.
   - `Завтра` → `CURRENT_DATE + 1`.
   - `Послезавтра` → `CURRENT_DATE + 2`.
   - `След. неделя` → ближайший понедельник.
   - `След. месяц` → 1-е число следующего месяца, время 09:00.
   - `Завершить` → модалка с `result`.

**Перенесено в фазу 5** (out of MVP):
- 7. Авто-задача «Связаться» при создании клиента.
- 8. Отчёт «клиенты без задач старше 3 дней».

---

## 9. Дизайн-токены

Используются как в ТЗ §3. Кратко:

- Фон страницы — `#0b1220`, фон карточек — `#0e1626`, бордер — `#1e2837`, активный бордер — `#2a3a52`.
- Текст — `#e5e7eb` / `#c5cad1` / `#9ca3af` / `#6b7280`.
- Акцент — `#2563eb` (синий), бирюза — `#14b8a6` (только для активной формы создания).
- Полоски колонок — `#f37575` / `#6CC09C` / `#c3c2c3` / `#92989b` (точные из реального DOM amoCRM).
- Шрифт — `'PT Sans', Arial, sans-serif`.
- **Никаких золотых акцентов** (это не CEO Dashboard).
- **Никаких эмодзи** в UI — только SVG-иконки (Tabler-style sprite либо встроенные path).

---

## 10. Очерёдность реализации

**Фаза 1 — БД + API** (~1 день)
1. Миграция `2026-05-25-tasks.sql`: `task_types`, `tasks`, `task_presets` + индексы + seed 19 типов.
2. `api/tasks.js`: GET (client/kanban/single/types) + POST + PATCH (edit/close/move) + DELETE.
3. `api/tasks-presets.js`: GET / POST / DELETE.
4. **Demo:** curl-чек-лист (см. §11) + ручной тест через REST-консоль.

**Чек-пойнт:** показываю миграцию + примеры curl-запросов **до начала фазы 2.**

**Фаза 2 — Таб «Задачи» в карточке клиента** (~1-2 дня)
1. Добавить вкладку `tasks` в `crm-tabs` (после `calendar`).
2. `crmClientTasksRender(client_id)` — fetch GET `/api/tasks?client_id=X&status=all`.
3. Inline-форма создания.
4. Карточка открытой задачи + карточка закрытой.
5. Модалка «Выполнить» + попап «Поставить следующую?».

**Фаза 3 — Страница «Мои задачи»** (~2-3 дня)
1. Permission `view_mytasks` + пункт меню.
2. `view-mytasks` шаблон, топ-бар, 3-колоночный канбан.
3. Карточка задачи на канбане.
4. Native drag-and-drop между колонками + drop-зоны футера.

**Фаза 4 — Фильтры и пресеты** (~1-2 дня)
1. Панель фильтра (overlay).
2. Системные пресеты (My / Failed / Compl / Uncompl).
3. Кастомные пресеты — CRUD через `task_presets`.

**Фаза 5 — Auto-flow и отчёты** (~1 день, after MVP)
1. Авто-задача «Связаться» при POST `/api/clients`.
2. `GET /api/clients/without-tasks` + индикатор в реестре клиентов.

---

## 11. Чек-лист проверки фазы 1 (вместо автотестов)

```bash
# 1. POST создаёт задачу
curl -X POST $BASE/api/tasks \
  -H "x-app-token: $TOKEN" -H "x-user-name: Айдос" \
  -d '{"client_id":"SD-KZ-2026-00001","type_id":1,"text":"тест","deadline_at":"2026-05-26T15:00:00+05:00","is_all_day":false,"assignee_operator":"Айдос"}'
# → 201, возвращает {id, ...}

# 2. Закрытие без result → 400
curl -X PATCH "$BASE/api/tasks?id=UUID&close=1" -H "..." -d '{}'
# → 400, error: "result обязателен (мин 3 символа)"

# 3. Закрытие с коротким result → 400
curl -X PATCH "$BASE/api/tasks?id=UUID&close=1" -H "..." -d '{"result":"ок"}'
# → 400

# 4. Закрытие валидное → 200, status=done
curl -X PATCH "$BASE/api/tasks?id=UUID&close=1" -H "..." -d '{"result":"дозвонился"}'
# → 200, {status:"done", closed_at:"..."}

# 5. Канбан группирует
curl "$BASE/api/tasks?kanban=1&assignee=Айдос" -H "..."
# → {expire:[...], today:[...], tomorrow:[...]}

# 6. Move меняет deadline
curl -X PATCH "$BASE/api/tasks?id=UUID&move=next_week" -H "..."
# → deadline_at = ближайший понедельник, 09:00

# 7. DELETE от не-автора → 403
curl -X DELETE "$BASE/api/tasks?id=UUID" \
  -H "x-app-token: $TOKEN" -H "x-user-name: Другой" -H "x-user-role: manager"
# → 403

# 8. Types endpoint
curl "$BASE/api/tasks?types=1" -H "..."
# → массив из 19 типов
```

---

## 12. Открытые вопросы (решаются по ходу, не блокирующие)

- **Real-time апдейты канбана** при изменении в другом окне — пока polling каждые 60 сек (есть toggle «Автообновление» в `⋯` меню). Supabase Realtime — отдельный проект.
- **Экспорт задач** (CSV) — в MVP заглушка. Сделать в фазе 5 или по запросу.
- **Управление типами задач** через UI — `task_types` пока через SQL. Админка типов — отдельный проект.
- **Уведомления об overdue** (push / email / Telegram-бот) — отдельный проект, не входит в этот spec.

---

## 13. Связь с памятью

- [[project_client_card_architecture]] — добавится секция «Tasks tab is parallel to Calendar tab in client card».
- [[project_integration_migration_state]] — `tasks` будет третьей сущностью «по клиенту» рядом с `integrations` и `kanban_cards`.
- Новая память после фазы 1: `project_tasks_module_v1` — где живут эндпоинты, какие правила валидации, какие seed-типы.
