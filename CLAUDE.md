# SalesDoc Dashboard — внутренний BI/CRM SPA

**Что это:** Монолитный Single Page Application для управления продажами SalesDoc.io. Дашборды, маркетинг, операторы внедрения, статистика по странам.

**Архитектура:**
- **Один файл — `index.html`** (монолитный SPA, всё в нём: HTML + CSS + JS)
- Бэкенд: **Google Sheets** (через Apps Script API)
- Деплой: **Vercel** (auto-deploy on push в `main`)
- PWA: `manifest.json`, `sw.js`, иконки `icon-192.svg`, `icon-512.svg`

**Репозиторий:** `Mirzahit/salesdoc-app` на GitHub
**Деплой:** Vercel автоматически при push в main → продакшн URL

**Ключевые файлы:**
- `index.html` — **главный файл фронта**. Все правки UI идут сюда. Структурирован по секциям: Дашборд, Маркетинг (с подразделами), Внедрение, Финансы, Ассистент и т.д.
- `sw.js` — service worker для PWA
- `manifest.json` — PWA-манифест
- `package.json` — Node 20.x для Vercel serverless API
- `api/chat.js` — Vercel serverless endpoint, проксирует к Anthropic API (Messages API + prompt caching). Нужен env `ANTHROPIC_API_KEY` в Vercel.
- `api/agents.json` — промпты агентов. Чтобы менять поведение агента — править ТОЛЬКО этот файл, не код.

**Ассистент:** страница `Инструменты → Ассистент` (`view-assistant`). UI: sidebar с агентами + чат. Бэк — `/api/chat`. Контекст текущего периода (платежи, статусы, топ-менеджеры) автоматически подмешивается в первое user-сообщение каждого запроса через функцию `asstBuildContext()`. История чата на агента — в `localStorage` (`asst_history`).

**Service Worker — ВАЖНОЕ ПРАВИЛО:**
В `sw.js` есть `var CACHE_NAME = 'salesdoc-vNNN'`. **При каждом значимом релизе нужно бампать его синхронно с версией в `<title>` `index.html`** (например, v436 → v437 в обоих местах). Иначе SW отдаёт пользователям закэшированный старый `index.html`, и новые фичи становятся видны только после ручного `Ctrl+Shift+R`.

**Как вносить изменения:**
1. Редактируешь `index.html` (или говоришь мне — я делаю точечные правки)
2. `git commit && git push` в main
3. Vercel сам собирает и деплоит за ~30 секунд

**Источник данных:** Google Sheets — несколько таблиц, главная "Доходы 2026". Доступ через Apps Script Web App URL (внутри `index.html`). Часть данных переезжает в Supabase (см. память `project_integration_migration_state`).

**Партнёрские правила работы (важно):**
- НЕ читать `index.html` целиком без необходимости — он большой, токены
- Точечные правки через Edit, а не Write
- Версионировать (комментарии при значимых изменениях)
- Перед изменениями уточнять что именно правим
