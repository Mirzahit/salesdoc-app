# CRM операторов техподдержки — Implementation Plan (Phase 0 + Phase 1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** превратить раздел «Внедрение» в полноценный CRM для операторов техподдержки (расширенная карточка клиента + календарь задач TickTick-стиль) и перевести всю программу на iOS systemBlue палитру.

**Architecture:** монолитный SPA `index.html` (~26K строк). Все правки CSS/JS — точечно через Edit с уникальными якорями. Backend — отдельный Google Apps Script (`KB_SCRIPT_URL`), новые actions добавляются вручную пользователем в Apps Script Editor. Файлы — DriveApp.

**Tech Stack:** Vanilla HTML/CSS/JS, Google Sheets через Apps Script Web App, Google Drive через DriveApp, Vercel auto-deploy, PWA Service Worker.

**UX-принципы:**
1. Каждая версия — видимый пользовательский результат
2. Порядок: визуал → UI без бэка → бэк → полировка
3. Backwards-compatible
4. Все hardcoded цвета JS-рендеров переписываются на CSS-токены
5. Каждое действие — с индикатором прогресса (toast/спиннер/success-чек)

**Spec:** `docs/superpowers/specs/2026-05-10-crm-implementation-design.md`
**Mockup:** `mockup-crm.html`

**Замечание про DOM-рендер:** проект использует паттерн `element.innerHTML = шаблонная_строка` повсеместно (закреплённый стиль codebase). Источник данных Google Sheets контролируется владельцем. Эскейпинг — через хелпер `kbEsc()` (line ~17500) применяется к строкам которые вводят операторы (имена, заголовки, заметки). В описаниях шагов ниже фраза «отрендерить шаблон в контейнер» означает именно этот паттерн.

---

## File Structure

| Зона | Что меняем | Версия |
|------|------------|--------|
| `<title>` line 10 | bump v223→v224→...→v231 | каждая |
| `:root` блок v215 | iOS systemBlue токены | v224 |
| Legacy gold-* override | синхронизация | v224 |
| `.bar.type-*` гистограмма | blue/indigo/teal | v224 |
| JS-рендер интеграций | iOS-цвета | v224 |
| JS-рендер канбана (KB_OP_COLORS, kbStageColor, progColor, АВР) | blue + green status | v224 |
| `view-kb-card` markup ~18146+ | pipeline + 5 табов | v225 |
| Новые CSS-блоки v225-v231 | компоненты CRM | v225-v231 |
| Sidebar пункт `data-view="calendar"` | новый раздел | v229 |
| Новый `<div id="view-calendar">` | страница календаря | v229 |
| JS-модули `crmContacts/Files/Events/Calendar` | новые модули | v226-v229 |
| `sw.js:4` `CACHE_NAME` | bump | каждая |
| **Apps Script (вне репо)** | 9 actions | v226-v229 |
| **Google Sheets** | 3 вкладки | v226-v229 |

---

## Тестирование

Автотестов нет. После каждой версии — headless screenshot:
```bash
node "C:/tmp/sdpup/snap.js"
```

Тест-аккаунт: `office@salesdoc.io` / `admin`. Cache-bust: `?cb=NNNN` или `Ctrl+Shift+R`.

---

# PHASE 0 — глобальная перекраска

## Task 0.1: v224 — Emerald → iOS systemBlue

**UX-цель:** оператор открывает программу — все акценты как Apple Mail/Notes (синий). Зелёный остаётся ТОЛЬКО для статусов «выполнено».

### Edit 1: Корневые токены v215

- [ ] **Step 1:** Найти `DESIGN SYSTEM v215 — iOS Foundation`. В `:root{...}` заменить значения:
  - `--accent:#0A84FF` (был `#28623A`)
  - `--accent-bright:#5AC8FA` (был `#4DAB68`)
  - `--accent-deep:#003D7A` (был `#0F2027`)
  - `--accent-bg:rgba(10,132,255,.16)`
  - `--accent-text:#5AC8FA`
  - `--gradient-deep:linear-gradient(135deg,#0A84FF 0%,#003D7A 100%)`
  - **Добавить новые:** `--done:#30D158;--done-bg:rgba(48,209,88,.18);--p1:#FF453A;--p2:#FF9F0A;--p3:#FFD60A;--p4:#0A84FF`
  - `--ds-success:#30D158;--ds-success-text:#30D158;--ds-success-bg:rgba(48,209,88,.18)`
  - `--ds-info:#0A84FF;--ds-info-text:#5AC8FA;--ds-info-bg:rgba(10,132,255,.16);--ds-info-deep:#003D7A`
  - `--ds-danger:#FF453A;--ds-danger-text:#FF6B5C;--ds-danger-bg:rgba(255,69,58,.16)`
  - `--ds-warning:#FF9F0A;--ds-warning-text:#FFB340;--ds-warning-bg:rgba(255,159,10,.18)`

### Edit 2: Light v217

- [ ] **Step 2:** Найти `DESIGN SYSTEM v217 — light`. В `body.light{...}`:
  - `--accent:#007AFF` (light variant — AA-контраст)
  - `--accent-bright:#0A84FF;--accent-bg:rgba(0,122,255,.10);--accent-text:#007AFF`
  - `--done:#34C759`
  - `--p1:#FF3B30;--p2:#FF9500;--p3:#FFCC00;--p4:#007AFF`
  - `--ds-info:#007AFF;--ds-info-text:#007AFF;--ds-info-bg:rgba(0,122,255,.10)`
  - `--ds-danger:#FF3B30;--ds-warning:#FF9500`

### Edit 3: Legacy gold-*

- [ ] **Step 3:** Найти `DESIGN SYSTEM v217 — переопределение legacy`. Заменить:
  - `--gold-bright:#5AC8FA;--gold-mid:#0A84FF;--gold-deep:#003D7A;--gold-light:#7DD3FC`
  - `--gold-gradient:linear-gradient(180deg,#5AC8FA 0%,#0A84FF 50%,#003D7A 100%)`
  - `--success:#30D158;--info:#0A84FF;--warning:#FF9F0A;--danger:#FF453A`
  
  В body.light: `--gold-bright:#007AFF;--gold-mid:#0A84FF;--gold-deep:#003D7A;--success:#34C759;--info:#007AFF`.

### Edit 4: Гистограмма дашборда

- [ ] **Step 4:** Найти `v217: гистограмма дашборда`. Заменить:
  ```css
  .bar.type-license{background:linear-gradient(180deg,#5AC8FA,#0A84FF)}
  .bar.type-sub{background:linear-gradient(180deg,#5E5CE0,#3634A3)}
  .bar.type-impl{background:linear-gradient(180deg,#64D2FF,#0077B6)}
  ```

### Edit 5: KB_OP_COLORS

- [ ] **Step 5:** Найти `var KB_OP_COLORS`. Заменить:
  ```js
  var KB_OP_COLORS = {'Айдос':'#0A84FF','Акбар':'#5E5CE0','Самат':'#FF9F0A'};
  ```

### Edit 6: KB_DEFAULT_COL_COLORS

- [ ] **Step 6:** Найти `var KB_DEFAULT_COL_COLORS`. Заменить:
  ```js
  var KB_DEFAULT_COL_COLORS = ['#5AC8FA','#0A84FF','#0040DD','#5E5CE0','#3634A3','#64D2FF','#7DD3FC','#30D158'];
  ```

### Edit 7: kbStageColor

- [ ] **Step 7:** Найти `function kbStageColor`. Тело:
  ```js
  function kbStageColor(days){
   if(days > KB_SLA_DANGER) return '#FF453A';
   if(days > KB_SLA_WARN) return '#FF9F0A';
   return '#30D158';
  }
  ```

### Edit 8: progColor

- [ ] **Step 8:** Найти `progColor = progPct === 100`. Заменить:
  ```js
  var progColor = progPct === 100 ? '#30D158' : progPct > 50 ? '#FF9F0A' : '#0A84FF';
  ```

### Edit 9: АВР inline-цвета

- [ ] **Step 9:** Заменить в трёх строках АВР и одной «Активирован»:
  - `#4DAB68` → `#30D158`
  - `#C49A52` → `#FF9F0A`
  - `#C13A40` → `#FF453A`

### Edit 10: typeColors / typeBorder

- [ ] **Step 10:** Найти `var typeColors = {'Интеграция'`. Заменить (и аналогично `var typeBorder`):
  ```js
  var typeColors = {'Интеграция':'#0A84FF','Доработка':'#FF9F0A','Разработка':'#5E5CE0'};
  ```

### Edit 11: pkgStyleMap / pkgColors

- [ ] **Step 11:** Найти `var pkgStyleMap` и `var pkgColors` в buildCard. Значения:
  - Стандарт: `['#8E8E93','rgba(142,142,147,.12)']`
  - Стандарт+/Стандарт Плюс: `['#5AC8FA','rgba(90,200,250,.14)']`
  - Премиум: `['#5E5CE0','rgba(94,92,224,.18)']`
  - Не указан: `['#636366','rgba(255,255,255,.04)']`

### Edit 12: barColor в JS-рендере интеграций

- [ ] **Step 12:** Найти `pct >= 80 ? '#4DAB68'`. Заменить:
  ```js
  pct >= 80 ? '#30D158' : pct >= 50 ? '#FF9F0A' : '#FF453A' : '#30D158'
  ```

### Edit 13: countryBadge

- [ ] **Step 13:** Найти `country==='KG'?'rgba(90,133,181`. Заменить background-условие на:
  ```
  'rgba(94,92,224,.18)':'rgba(10,132,255,.16)'
  ```
  И color-условие `'#5A85B5':'#4DAB68'` → `'#5E5CE0':'#0A84FF'`.

### Edit 14: Inline статистика интеграций

- [ ] **Step 14:** В трёх местах с inline-цветом (выполнено / в работе / отменено) заменить:
  - `#4DAB68` → `#30D158`
  - `#C49A52` → `#FF9F0A`
  - `#C13A40` → `#FF453A`

### Edit 15: Login кнопка

- [ ] **Step 15:** Найти `v221: login кнопка`. Заменить градиент `#28623A,#0F2027` → `#0A84FF,#003D7A`. Box-shadow `rgba(40,98,58,.30)` → `rgba(10,132,255,.30)`. Hover gradient `#34794A,#1F4D2D` → `#5AC8FA,#0A84FF`. Light: `#28623A,#1F4D2D` → `#007AFF,#003D7A`.

### Edit 16: Splash логотип

- [ ] **Step 16:** Найти `#sd-splash .sd-splash-logo`. Заменить gradient `#28623A,#0F2027` → `#0A84FF,#003D7A`. Box-shadow `rgba(40,98,58,.40)` → `rgba(10,132,255,.40)`. Spinner border-top-color `#4DAB68` → `#5AC8FA`.

### Edit 17: SW update тост

- [ ] **Step 17:** Найти `sd-update-btn` стилизацию. `background:#28623A` → `background:#0A84FF`.

### Edit 18: Bump версии

- [ ] **Step 18:** title v223→v224, sw.js CACHE_NAME 'salesdoc-v223'→'salesdoc-v224'.

### Verification

- [ ] **Step 19:** `node "C:/tmp/sdpup/snap.js"`. Ожидаемое: sidebar активный синий, кнопки синие, гистограмма blue/indigo/cyan, чипы канбана семантические red/orange/green, splash синий. Зелёный остался ТОЛЬКО на «Активирован», АВР подтверждён, чекбоксы выполненных.

### Commit

- [ ] **Step 20:**
  ```bash
  cd "/c/Users/Мирзахит/Downloads/CRM и продажи/Дашборды и BI/salesdoc-app"
  git add index.html sw.js
  git commit -m "feat(v224): глобальная перекраска Emerald → iOS systemBlue"
  git push origin main
  ```

---

# PHASE 1 — CRM функционал

## Task 1.1: v225 — карточка клиента: pipeline + 5 табов (UI без бэка)

**UX-цель:** оператор открывает fullscreen-карточку → видит pipeline + 5 табов. Контакты/Файлы/Календарь — empty-state с подсказкой про следующий релиз.

### Edit 1: CSS-блок v225

- [ ] **Step 1:** Найти конец блока `DESIGN SYSTEM v218 — CATCH-ALL`. После него вставить блок `DESIGN SYSTEM v225 — CRM карточка`. Селекторы:
  - `.crm-card-head` — grid 1fr/auto с border-bottom hairline
  - `.crm-card-name` — 24px bold + `.badge-stage` (accent-bg/accent-text)
  - `.crm-card-meta` — flex 18px gap, font 13px text-2
  - `.crm-card-actions` + `.crm-action` (фон accent-bg, hover→accent solid) + `.crm-action.outline` + `.crm-action:disabled` (.4 opacity)
  - `.crm-pipeline` — flex gap 6px, padding 16/32, surface-3 background, scroll-x
  - `.crm-pipe-step` (default), `.done` (done-bg/done text + ✓ ::after), `.active` (text background, accent ::after)
  - `.crm-tabs` — flex с border-bottom hairline. `.crm-tab` — 14/18 padding, 14px font, border-bottom 2px transparent. `.active` — accent border-bottom + colour. `.count` — pill chip.
  - `.crm-tab-pane` — 24/32 padding, min-height 400px. `[hidden]{display:none}`
  - `.crm-empty` — центр 60px padding, иконка 36px, text-soft

  Эталон значений в `mockup-crm.html` строки 37-65.

### Edit 2: Реструктура kbOpenCardPage

- [ ] **Step 2:** Найти `function kbOpenCardPage(card)`. Прочитать тело — определить где сейчас рендерится header/чеклист/история/АВР/задачи.

- [ ] **Step 3:** В начало функции добавить `window._kbCurrentCard = card;`.

- [ ] **Step 4:** Структура нового рендера (отрендерить шаблонную строку в `view-kb-card`):
  1. Header (как было) с классом `crm-card-head` + кнопка с `data-action="activate"`
  2. После header — `<div class="crm-pipeline">` + цикл по `kbColumns`. Для каждого этапа `<div class="crm-pipe-step ${cls}">`, где cls = `done` (idx<curIdx), `active` (idx===curIdx), пусто (idx>curIdx). Внутри: `<span class="pipe-label">Этап N</span><span class="pipe-name">${kbEsc(stageName)}</span>`.
  3. После pipeline — `<div class="crm-tabs">` с 5 кнопками: data-tab=checklists/contacts/files/calendar/history, onclick=crmActivateTab(this). Counters в `<span class="count" id="crm-cnt-cl/cn/fi/ev">—</span>`.
  4. После tabs — 5 panes с data-pane атрибутом. Все hidden кроме checklists.
  5. **Существующий контент** чеклиста+задач+АВР+комментариев — переехать в pane checklists. Существующая history-лента — в pane history. В contacts/files/calendar — empty-state с подсказкой «Подключение в v226/v227/v229».

  Тексты пользовательских данных (имя клиента, оператор) эскейпить через `kbEsc`.

### Edit 3: crmActivateTab

- [ ] **Step 5:** После kbOpenCardPage добавить:
  ```js
  function crmActivateTab(btn){
   var tab = btn.dataset.tab;
   document.querySelectorAll('.crm-tabs .crm-tab').forEach(function(t){ t.classList.toggle('active', t === btn); });
   document.querySelectorAll('.crm-tab-pane').forEach(function(p){ p.hidden = p.dataset.pane !== tab; });
   var card = window._kbCurrentCard; if(!card) return;
   // в v226+ здесь lazy-load contacts/files/calendar
  }
  ```

### Bump + Verify + Commit

- [ ] **Step 6:** title v225, sw.js v225.
- [ ] **Step 7:** Скриншот → открыть карточку → новый layout видно. Существующий чеклист и история работают.
- [ ] **Step 8:** Commit `feat(v225): карточка клиента — pipeline + 5 табов (UI без бэка)`. Push.

---

## Task 1.2: v226 — Контакты (Sheet + Apps Script + UI)

**UX-цель:** таб «Контакты» → список (Директор/IT/Бухгалтер/Супервайзер). Кнопка «+ Добавить» → модалка. Удаление с confirm.

### Backend (Apps Script Editor)

- [ ] **Step 1:** Создать вкладку `Контакты`. Headers row 1: `id | client | name | role | phone | whatsapp | telegram | email | notes | created_at | created_by`.

- [ ] **Step 2:** В Apps Script (KB_SCRIPT_URL проект) добавить функции:
  - `crmContactsList(client)` — массив объектов отфильтрованных по client
  - `crmContactsUpsert(data)` — id новый или существующий, created_at = now() при insert, returns `{id}`
  - `crmContactsDelete(id)` — find row, deleteRow, returns `{ok:true}`
  
  В существующий `doPost` handler добавить case-ы для action='crmContactsList'/'crmContactsUpsert'/'crmContactsDelete'.

- [ ] **Step 3:** Apps Script: Deploy → Manage deployments → Edit → New Version → Deploy.

- [ ] **Step 4:** Smoke-test:
  ```bash
  curl -X POST "$KB_SCRIPT_URL" -H "Content-Type: text/plain" \
    -d '{"action":"crmContactsList","client":"ТОО El-product"}'
  ```
  Ожидаемое: `[]`.

### Frontend CSS

- [ ] **Step 5:** Блок CSS `v226 — Контакты`. Селекторы:
  - `.crm-contacts-list` — flex column в surface card
  - `.crm-contact-row` — 14/18 padding, hover surface-2, border-bottom hairline
  - `.crm-contact-avatar` (.r-ceo accent-bg, .r-it indigo-bg, .r-bh orange-bg, .r-sv done-bg)
  - `.crm-contact-info/name/role` — name 14px bold, role 12px text-soft
  - `.crm-contact-del` — 28px button hover red
  - `.crm-contacts-add` — dashed border accent, full-width, padding 10/16
  - `.crm-modal-bg` — fixed inset 0 backdrop-blur 8px
  - `.crm-modal` — 18px radius, surface, sh-3
  - `.crm-field` — label uppercase 11px text-soft, input/select/textarea на токенах
  - `.crm-modal-actions` — flex end gap

### Frontend JS

- [ ] **Step 6:** Добавить JS-модуль перед `</script>`. Globals: `var crmContactsCache = {};`.

  Функции:
  - **`crmContactsLoad(client, cb)`** — fetch к KB_SCRIPT_URL action='crmContactsList', кладёт в кэш, вызывает cb(list). Catch → toast 'Ошибка загрузки контактов'.
  - **`crmContactsRender(client)`** — берёт `crmContactsCache[client]`. Обновляет counter `#crm-cnt-cn`. Если пусто — отрендерить в pane empty-state + кнопку add. Иначе — list rows с avatar (initials через `kbEsc`), name, role, phone (как `<a href="tel:...">`), кнопкой удаления. Внизу — кнопка add.
  - **`crmContactOpenModal(client, contactId)`** — найти контакт в кэше (или пустой объект если new). Создать `<div class="crm-modal-bg">`, внутри `<div class="crm-modal">` с полями: name input, role select (Директор/IT/Бухгалтер/Супервайзер/Прочее), phone, whatsapp, telegram, email, notes textarea. Кнопки Отмена/Сохранить. Все значения через `kbEsc(c.name)` etc. Onclick background → close если e.target===bg.
  - **`crmContactSave(client, contactId)`** — собрать данные из полей модалки, validate (name not empty), POST action='crmContactsUpsert'. Toast 'Контакт добавлен/обновлён'. Закрыть модалку, перезагрузить.
  - **`crmContactDelete(id, client)`** — confirm() → POST action='crmContactsDelete' → toast 'Удалено' → перезагрузить.

  Все рендеры — через паттерн codebase (`element.innerHTML = template`). XSS-safe: пользовательский текст через `kbEsc`.

### Подключение

- [ ] **Step 7:** В `crmActivateTab` добавить:
  ```js
  if(tab === 'contacts'){ crmContactsLoad(card.client, function(){ crmContactsRender(card.client); }); }
  ```

### Bump + Verify + Commit

- [ ] **Step 8:** title/sw v226.

- [ ] **Step 9:** Сценарий:
  1. Открыть карточку → таб Контакты → empty-state
  2. Кнопка «+ Добавить» → модалка → Директор/Малик/+7... → Сохранить
  3. Контакт виден в списке
  4. F5 (автологин из v220) → таб Контакты → контакт остался
  5. Удалить → confirm → toast → исчез
  6. Counter (4) обновился

- [ ] **Step 10:** Commit `feat(v226): CRM — контакты клиента`. Push.

---

## Task 1.3: v227 — Файлы (DriveApp + upload + URL)

**UX-цель:** загрузка файлов до 25 МБ через файлселектор → DriveApp в папку SalesDoc_CRM_Files/<клиент>/. Большие — sharing-link вручную.

### Backend

- [ ] **Step 1:** Вкладка `Файлы`: `id | client | type | filename | size_bytes | mime | drive_url | drive_file_id | uploaded_at | uploaded_by`.

- [ ] **Step 2:** Apps Script:
  - `crmFilesList(client)` — как ContactsList
  - `crmFilesUpload(p)`:
    1. Найти/создать папку `SalesDoc_CRM_Files` в DriveApp.getRootFolder()
    2. Внутри папка по `p.client` (создать если нет)
    3. `Utilities.newBlob(Utilities.base64Decode(p.base64), p.mime, p.filename)` → `clientFolder.createFile(blob)`
    4. `file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW)`
    5. Записать в Sheet строку, return `{id, drive_url: file.getUrl(), drive_file_id: file.getId()}`
  - `crmFilesAddUrl(p)` — добавляет запись с готовым URL (size=0, drive_file_id=пусто)
  - `crmFilesDelete(id)` — найти строку, `try { DriveApp.getFileById(fid).setTrashed(true); } catch(e){}`, deleteRow

  Подключить case-ы в doPost. Deploy.

- [ ] **Step 3:** Smoke: `curl -X POST $KB_SCRIPT_URL -d '{"action":"crmFilesList","client":"X"}'` → `[]`.

### Frontend CSS

- [ ] **Step 4:** Блок CSS `v227 — Файлы`. Селекторы: `.crm-files-list`, `.crm-file-row` (как `<a target="_blank">`), `.crm-file-icon` (variants .pdf/.doc/.xls/.img/.zip/.other с разными цветами), `.crm-file-info/name/meta`, `.crm-file-del`, `.crm-files-actions` (две кнопки).

### Frontend JS

- [ ] **Step 5:** JS-модуль `crmFiles`:
  - Globals: `var crmFilesCache = {}; var CRM_MAX_UPLOAD_BYTES = 25 * 1024 * 1024;`
  - `crmFilesLoad(client, cb)` / `crmFilesRender(client)` — аналогично контактам
  - `crmFileTypeFromMime(mime, filename)` — по расширению возвращает 'pdf'/'doc'/'xls'/'img'/'zip'/'other'
  - `crmFileSizeFmt(b)` — '2.3 МБ' / '156 КБ' / '0 Б'
  - `crmFileUploadInput(client)` — установить `window._crmCurrentClient = client`, кликнуть скрытый `<input type="file" id="crm-file-input">`
  - `crmFileSelected(input)` — `input.files[0]`. Проверить размер > CRM_MAX_UPLOAD_BYTES → toast «Файл больше 25 МБ — используйте Вставить ссылку», return. Иначе FileReader.readAsDataURL → POST action='crmFilesUpload' с base64 (split на ',' и взять [1]). Toast «Загрузка...» → «Файл загружен». Перезагрузить.
  - `crmFileAddUrlModal(client)` — модалка: имя файла, Drive URL, тип (Договор/ТЗ/Скриншот/Видео/Прочее)
  - `crmFileSaveUrl(client)` — POST action='crmFilesAddUrl'
  - `crmFileDelete(id, client)` — confirm 'Файл будет в корзину Drive' → POST → перезагрузка

  Файл открывается по клику на `<a target="_blank">` (drive_url). Кнопка удалить — `event.stopPropagation()` чтобы не открыть Drive.

- [ ] **Step 6:** В `crmActivateTab`:
  ```js
  if(tab === 'files'){ crmFilesLoad(card.client, function(){ crmFilesRender(card.client); }); }
  ```

### Bump + Verify + Commit

- [ ] **Step 7:** title/sw v227.

- [ ] **Step 8:** Тест:
  1. Загрузить PDF < 25МБ → файл виден → клик открывает Drive
  2. Большой файл (>25МБ) → toast «используйте ссылку»
  3. Кнопка «Вставить ссылку» → модалка → ввести URL → виден
  4. Удалить → confirm → toast → файл в корзине Drive

- [ ] **Step 9:** Commit `feat(v227): CRM — файлы клиента (upload+URL, DriveApp)`. Push.

---

## Task 1.4: v228 — детальные чеклисты по этапам + блокировка активации

**UX-цель:** на текущем этапе оператор видит конкретные подпункты. Кнопка «Активировать» disabled пока чеклист текущего этапа не 100%. Drag-and-drop вперёд тоже блокируется.

### Edit 1: KB_DEFAULT_CHECKLISTS

- [ ] **Step 1:** После `var KB_DEFAULT_COL_COLORS` добавить словарь с дефолтами по 6 этапам:
  - 'В очереди': ['Подтверждена оплата','Назначен оператор','Создана анкета компании']
  - 'Взят в работу': ['Подписан акт первичного контакта','Получены реквизиты сервера','Заполнена анкета компании']
  - 'Настройка сервера': ['Сервер развернут','Установлено ПО последней версии','Импортирован справочник товаров (1С)','Заведены пользователи системы','Настроены маршруты ТП']
  - 'Обучение полевых': ['Назначен ответственный супервайзер','Проведён онлайн-инструктаж','Проведён выезд оператора','Подписан акт обучения']
  - 'Обучения офисных': ['Обучен директор основным отчётам','Обучен супервайзер контролю ТП','Обучен бухгалтер закрытию периода']
  - 'Запущен': ['Передано в боевую эксплуатацию','Загружен АВР']
  - 'Активирован': []

### Edit 2: Миграция формата checklist

- [ ] **Step 2:** Добавить функцию `crmInitChecklist(card)`:
  - Если `Array.isArray(card.checklist)` (legacy) — построить новый словарь со всеми этапами (нули), биты legacy применить к этапу `card.stage` best-effort
  - Если `null/undefined` — создать пустой словарь со всеми этапами
  - Если уже словарь — добавить недостающие этапы

- [ ] **Step 3:** В `kbLoad` после формирования каждой `card` вызвать `crmInitChecklist(card)`.

### Edit 3: Прогресс

- [ ] **Step 4:** Заменить `kbChecklistProgress(card)`:
  ```js
  function kbChecklistProgress(card){
   var done=0,total=0;
   if(card.checklist && typeof card.checklist === 'object'){
    Object.keys(card.checklist).forEach(function(s){
     (card.checklist[s]||[]).forEach(function(b){total++;if(b)done++;});
    });
   }
   return {done:done,total:total};
  }
  function kbChecklistStageProgress(card){
   var arr=(card.checklist && card.checklist[card.stage])||[];
   var done=0; arr.forEach(function(b){if(b)done++;});
   return {done:done,total:arr.length};
  }
  ```

### Edit 4: CSS чеклистов

- [ ] **Step 5:** Блок `v228 — чеклисты`. Селекторы:
  - `.crm-cl-block` — flex column gap 14
  - `.crm-cl-stage` — surface-2 card. Variants `.cl-active` (blue border + accent-bg тонкий), `.cl-future` (opacity .55)
  - `.crm-cl-head/name/pct` — pct в `var(--done)` зелёный
  - `.crm-cl-bar/fill` — fill в `var(--done)`
  - `.crm-cl-item/cb/text` — checkbox 20px, .on (done bg + green), text.done зачёркнутый

### Edit 5: Рендер чеклистов в pane

- [ ] **Step 6:** Функция `crmRenderChecklists(card)`:
  - Цикл по `kbColumns`. Для каждого этапа — массив битов `card.checklist[stage]` и шаблон `KB_DEFAULT_CHECKLISTS[stage]`
  - Если массив пустой — пропустить
  - Header: `Этап N · ${stage}${current?' (текущий)':''}` + прогресс `done/total · pct%`
  - Bar fill — зелёный по pct
  - Items: чекбокс (`onclick=crmChecklistToggle(...)` если stage===card.stage или назад) + текст пункта
  - Текущий этап → `.cl-active`. Будущие → `.cl-future`.
  
  Counter `#crm-cnt-cl` — `${done}/${total}` суммарно.

- [ ] **Step 7:** `crmChecklistToggle(cardId, stage, idx)`:
  - Найти карточку, переключить бит
  - POST к KB_SCRIPT_URL action='updateCard' (существующий action) с полем `checklist: JSON.stringify(card.checklist)`
  - Перерендерить pane
  - Вызвать `crmUpdateActivateBtn(card)`

### Edit 6: Блокировка активации

- [ ] **Step 8:** Функция `crmUpdateActivateBtn(card)`:
  ```js
  function crmUpdateActivateBtn(card){
   var btn = document.querySelector('.crm-action[data-action="activate"]');
   if(!btn) return;
   var p = kbChecklistStageProgress(card);
   var ok = p.total === 0 || p.done === p.total;
   btn.disabled = !ok;
   btn.title = ok ? 'Перевести на следующий этап' : 'Сначала закройте чеклист текущего этапа ('+p.done+'/'+p.total+')';
  }
  ```
  В разметке header кнопка получает `data-action="activate"`. Вызов в kbOpenCardPage после рендера.

- [ ] **Step 9:** Защита `kbMoveCard`:
  ```js
  // в начале kbMoveCard, перед существующей логикой
  var fromIdx = kbColumns.indexOf(card.stage);
  var toIdx = kbColumns.indexOf(toStage);
  if(toIdx > fromIdx){
   var p = kbChecklistStageProgress(card);
   if(p.total > 0 && p.done < p.total){
    if(typeof showToast==='function') showToast('Сначала закройте чеклист этапа «'+card.stage+'»');
    return;
   }
  }
  ```

### Bump + Verify + Commit

- [ ] **Step 10:** title/sw v228.

- [ ] **Step 11:** Тест:
  1. Открыть карточку → видно блоки чеклиста (пройденные с галочками green, текущий accent-bg, будущие dimmed)
  2. Кнопка «Активировать» disabled
  3. Закрыть все пункты текущего → кнопка активна, drag-and-drop вперёд работает
  4. Старые карточки legacy plain-array — корректно мигрируют

- [ ] **Step 12:** Commit `feat(v228): детальные чеклисты по этапам + блокировка активации`. Push.

---

## Task 1.5: v229 — раздел «Календарь» + События

**UX-цель:** новый пункт в sidebar. Открывает страницу TickTick: Smart Lists слева, agenda по дням, quick-add внизу. События создаются из карточки клиента или прямо в календаре.

### Backend

- [ ] **Step 1:** Вкладка `События`: `id | client | operator | type | title | date | time_start | time_end | location | notes | status | priority | recurring | parent_id | created_at | created_by`.

- [ ] **Step 2:** Apps Script:
  - `crmEventsList(p)` — массив объектов с фильтрами по client/operator/dateFrom/dateTo (если переданы)
  - `crmEventsUpsert(data)`
  - `crmEventsDelete(id)`
  
  Case-ы в doPost. Deploy.

- [ ] **Step 3:** Smoke-test: `curl ... '{"action":"crmEventsList"}'` → `[]`.

### Sidebar

- [ ] **Step 4:** Найти `data-view="kanban"` в sidebar. Рядом добавить:
  ```html
  <div class="nav-item" data-view="calendar" onclick="showView('calendar')">
   <svg class="nav-icon-stroke" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M3 10h18M8 2v4M16 2v4"/></svg>
   <span class="nav-label">Календарь</span>
  </div>
  ```
  В `showView`: 
  - access map `_accessMap` (line ~8127) добавить `calendar:'view_calendar'`
  - loop view-id (line ~8134) добавить `'calendar'`

### View markup

- [ ] **Step 5:** После `</div><!-- /KANBAN VIEW -->` добавить:
  ```html
  <div id="view-calendar" style="display:none">
   <div class="tt-page">
    <aside class="tt-side" id="tt-side"></aside>
    <main class="tt-main">
     <div class="tt-toolbar" id="tt-toolbar"></div>
     <div class="tt-list" id="tt-list"></div>
     <div class="tt-quickadd">
      <span style="color:var(--text-soft);font-weight:600;font-size:18px">+</span>
      <input class="tt-qa-input" id="tt-qa-input" placeholder="Добавить задачу… например: «Завтра 10:00 встреча с ТОО El-product»" onkeydown="if(event.key==='Enter')crmEventsQuickAdd()">
      <button class="tt-qa-btn" onclick="crmEventsQuickAdd()">Создать</button>
     </div>
    </main>
    <aside class="tt-right" id="tt-right"></aside>
   </div>
  </div>
  ```

### CSS

- [ ] **Step 6:** Скопировать CSS из `mockup-crm.html` блок `<style>` (вторая половина — строки 312-448 — секции tt-page/tt-side/tt-li/tt-toolbar/tt-list/tt-day-head/tt-task/tt-cb/tt-task-info/tt-task-meta/tt-quickadd/tt-mini-cal/tt-detail). Вставить в новый блок `DESIGN SYSTEM v229 — Календарь TickTick`.

### JS — модуль crmCalendar

- [ ] **Step 7:** Globals:
  ```js
  var crmEvents = [];
  var crmCalState = {list:'today', operator:null, type:null, selectedId:null, view:'list'};
  ```

- [ ] **Step 8:** Функции (рендеры через паттерн codebase):
  - `crmEventsLoad(cb)` — POST 'crmEventsList', set crmEvents, callback
  - `crmDateStr(d)` → 'YYYY-MM-DD'. `crmAddDays(d,n)` → новый Date.
  - `crmCalCount()` — пересчёт счётчиков по датам и категориям. Returns object `{today,tomorrow,week,overdue,nodate,done,byOp,byType}`.
  - `crmCalFilter()` — apply state к crmEvents → filtered list. Логика для list:
    - 'today' → date===todayStr && status!=='done'
    - 'tomorrow' → date===tomorrowStr && status!=='done'
    - 'week' → date >= today && date <= today+7d && status!=='done'
    - 'overdue' → date && date<today && status!=='done'
    - 'nodate' → !date && status!=='done'
    - 'done' → status==='done'
    
    + дополнительные фильтры по operator и type.
  - `crmCalRenderSide()` — Smart Lists + операторы + типы (links с onclick state-setters)
  - `crmCalRenderToolbar()` — h1 title по state.list, кнопка переключения Список/Календарь
  - `crmCalRenderList()` — group filtered by date, sticky day-head, list of `crmCalTaskHtml(e, today)` per day. Sort: priority desc → time_start asc.
  - `crmCalTaskHtml(e, today)` — task div с class p1/p2/p3/p4 (по priority), title (kbEsc), meta: time, type-tag, client с 📎, operator с цветной точкой
  - `crmCalRenderRight()` — мини-календарь сверху + детали выбранной задачи внизу (или пусто)
  - `crmCalRender()` — последовательно Side+Toolbar+List(or Grid)+Right
  - `crmCalSetList/Operator/Type/Select(...)` — обновление state, перерендер
  - `crmEventToggleDone(id)` — переключить status, POST upsert, перерендер

### Quick-add с natural-language

- [ ] **Step 9:** Парсер:
  - `crmEventsQuickAdd()` — берёт `tt-qa-input`, `crmParseNL`, POST upsert с currentUser.name как operator/created_by. Очистить input, toast, reload.
  - `crmParseNL(s)`:
    - Дата: `/завтра/` → +1d. `/сегодня/` → today. `/(\d{1,2})\.(\d{1,2})/` → ISO формат.
    - Время: `/(\d{1,2}):(\d{2})/` → time_start
    - Тип: `/обучен/` → training. `/встреч|выезд|демо|презент/` → meeting. `/дедлайн|срок/` → deadline.
    - Priority: `/!([1-4])/` → priority + remove from title
    - Клиент: substring match `kbCards[].client`
    - Оператор: substring match `Object.keys(KB_OP_COLORS)`
    - Title = оригинал минус извлечённые токены (или просто оригинал)

### Интеграция с showView

- [ ] **Step 10:** В `showView`:
  ```js
  if(v === 'calendar' && typeof crmEventsLoad === 'function'){ crmEventsLoad(crmCalRender); }
  ```

### Bump + Verify + Commit

- [ ] **Step 11:** title/sw v229.

- [ ] **Step 12:** Тест:
  1. Sidebar → Календарь → виден layout
  2. Smart Lists слева — клик меняет фильтр
  3. Quick-add: «завтра 10:00 встреча с ТОО El-product» → создалось → видно в Завтра
  4. Чекбокс задачи → done → переехала в «Выполненные»
  5. Открыть карточку клиента → таб Календарь → события только этого клиента

- [ ] **Step 13:** Commit `feat(v229): новый раздел Календарь + события + Smart Lists + quick-add`. Push.

---

## Task 1.6: v230 — drag-and-drop + повторения

**UX-цель:** перенос задачи на завтра drag-and-drop. «Утренний созвон каждый понедельник» — автоматически в каждый понедельник.

### Edit 1: HTML5 drag-and-drop

- [ ] **Step 1:** В `crmCalTaskHtml` — атрибут `draggable="true"` + handlers `ondragstart/ondragend`.

- [ ] **Step 2:** В day-head в `crmCalRenderList` — `data-date="<key>" ondragover/leave/drop`.

- [ ] **Step 3:** JS:
  ```js
  function crmCalDragStart(e, id){ e.dataTransfer.setData('text/plain', id); e.target.classList.add('dragging'); }
  function crmCalDragEnd(e){
   e.target.classList.remove('dragging');
   document.querySelectorAll('.tt-day-head.drop').forEach(function(h){h.classList.remove('drop');});
  }
  function crmCalDrop(e, dateKey){
   e.preventDefault();
   var id = e.dataTransfer.getData('text/plain');
   var ev = crmEvents.find(function(x){return x.id===id;});
   if(!ev) return;
   ev.date = dateKey === 'nodate' ? '' : dateKey;
   fetch(KB_SCRIPT_URL,{method:'POST',headers:{'Content-Type':'text/plain'},body:JSON.stringify({action:'crmEventsUpsert',id:ev.id,date:ev.date})});
   crmCalRender();
  }
  ```

- [ ] **Step 4:** CSS:
  ```css
  .tt-task.dragging{opacity:.5}
  .tt-day-head.drop{background:var(--accent-bg)}
  ```

### Edit 2: Повторения

- [ ] **Step 5:** В модалке создания/редактирования — `<select id="ev-recurring">` (Не повторять/Каждый день/Каждую неделю/Каждый месяц/По будням).

- [ ] **Step 6:** Функция `crmExpandRecurring(events, dateFrom, dateTo)`:
  - Для каждого event с recurring и date — генерировать виртуалы в диапазоне
  - daily=1d, weekly=7d, monthly=+1month, weekdays=1d но только пн-пт
  - virtual.id = base.id + '#' + dateStr
  - virtual._virtual = true
  - return [...originals, ...virtuals]

- [ ] **Step 7:** В `crmCalFilter` — сначала `crmExpandRecurring(crmEvents, today-7d, today+30d)` потом фильтр.

- [ ] **Step 8:** Toggle done на virtual:
  - Проверить `e._virtual` в `crmEventToggleDone`. Если true — POST upsert НОВОЙ записи: `id = base.id + '#' + virtual.date, parent_id = base.id, status = 'done', date = virtual.date`. Это override.
  - В `crmExpandRecurring` — пропускать виртуал если есть override-запись с same parent_id и same date.

### Bump + Verify + Commit

- [ ] **Step 9:** title/sw v230.

- [ ] **Step 10:** Тест:
  1. Создать «Утренний созвон» recurring=weekly, date=сегодня
  2. Видно в Сегодня + следующие понедельники в 7 дней
  3. Drag из Сегодня в Завтра → переехала, в Sheet обновлено
  4. Done на виртуал → создан override, при следующей загрузке базовая повторяется но конкретная дата помечена

- [ ] **Step 11:** Commit `feat(v230): TickTick — drag-and-drop + повторяющиеся задачи`. Push.

---

## Task 1.7: v231 — Calendar Grid View (Месяц)

**UX-цель:** Apple-style сетка месяца с событиями chips. Клик день → переход в Список.

### Edit 1: Месячная сетка

- [ ] **Step 1:** Функция `crmCalRenderGridMonth(year, month)`:
  - 7 заголовков дней недели (пн-вс)
  - 6×7 ячеек: offset до первого понедельника, потом дни месяца, потом до конца недели
  - В каждой ячейке: `<div class="tt-grid-num">${day}</div>` + до 3 chip-events. Если >3 — `<div class="tt-grid-more">+ ${N-3}</div>`.
  - Cell классы: `.muted` (другой месяц), `.today` (сегодня)
  - Event chip class по типу (training/meeting/deadline)

### Edit 2: CSS Grid view

- [ ] **Step 2:** Блок `v231 — Grid view`. Селекторы:
  - `.tt-grid-month` — grid 7 колонок, gap 1px hairline
  - `.tt-grid-h` — header дня недели surface-3
  - `.tt-grid-cell` — surface, 90px min-height, flex-col gap 3px
  - `.tt-grid-cell.muted` — opacity .4
  - `.tt-grid-cell.today .tt-grid-num` — accent circle 22x22
  - `.tt-grid-num` — 12px tabular
  - `.tt-grid-ev` — 10px chip с цветами по типу. Default accent-bg/accent-text. `.training` done. `.meeting` accent. `.deadline` red.
  - `.tt-grid-more` — 10px text-soft

### Edit 3: Переключатель Список / Календарь

- [ ] **Step 3:** В `crmCalState` уже есть `view: 'list' | 'grid'` (с v229 step 7).

- [ ] **Step 4:** В `crmCalRenderToolbar` — кнопки переключения. Onclick устанавливает state.view.

- [ ] **Step 5:** В `crmCalRender` — если state.view==='grid', контент `tt-list` заменяется на `crmCalRenderGridMonth(state.year, state.month)`. По умолчанию текущий месяц.

- [ ] **Step 6:** Клик на ячейку дня → state.list='day', state.dayDate=ds, state.view='list'. Перерендер. (Опционально — отдельная Smart List 'day' в `crmCalFilter`.)

### Bump + Verify + Commit

- [ ] **Step 7:** title/sw v231.

- [ ] **Step 8:** Тест:
  1. Календарь → переключатель «Календарь» → сетка месяца
  2. События chips цветные по типу
  3. Клик на день → переход в Список со списком событий этого дня

- [ ] **Step 9:** Commit `feat(v231): календарь — Grid view (Месяц)`. Push.

---

## Self-Review

**Spec coverage:**
- ✅ Phase 0 перекраска → Task 0.1 v224 (20 шагов)
- ✅ Карточка 5 табов + pipeline → Task 1.1 v225
- ✅ Контакты Sheet+CRUD+UI → Task 1.2 v226
- ✅ Файлы Sheet+upload+UI → Task 1.3 v227
- ✅ Детальные чеклисты + блокировка → Task 1.4 v228
- ✅ События + Smart-lists + quick-add → Task 1.5 v229
- ✅ Drag-and-drop + повторения → Task 1.6 v230
- ✅ Grid view → Task 1.7 v231

**Apps Script actions:** 9 описаны (crmContactsList/Upsert/Delete, crmFilesUpload/AddUrl/List/Delete, crmEventsList/Upsert/Delete). Pseudocode в спеке `2026-05-10-crm-implementation-design.md` секция «Backend (Apps Script)».

**UX-проверки:** в каждой задаче перед commit — verify-блок с конкретным сценарием. Все сценарии включают: открытие раздела, основное действие, обратную связь (toast), сохранение после reload.

**Известные неопределённости:**
- Точное имя текущей функции рендера чеклиста в карточке → Grep в v228 step 6
- Точное местоположение sidebar markup → Grep `data-view="kanban"` в v229 step 4
- Совместимость legacy `card.checklist` migration → проверить на тестовом аккаунте перед массовым деплоем (v228 step 11)

**Версионирование:** v224 (визуал) → v225 (UI каркас) → v226-v228 (бэк по компоненту) → v229 (раздел Календарь) → v230-v231 (расширения и сетка). 8 коммитов суммарно. Каждый — самостоятельный пользовательский выгрыш.

**Замечание про DOM-render:** все рендеры используют закреплённый паттерн codebase `element.innerHTML = template_string`. XSS-эскейп через `kbEsc()` (line ~17500) применяется ко всем строкам которые вводит оператор (имя клиента, контакта, заголовок задачи, заметки). Этот паттерн используется уже во всём codebase (~250+ мест) и сохраняется для consistency.
