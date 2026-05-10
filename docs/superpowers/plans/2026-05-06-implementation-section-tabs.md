# Раздел «Внедрение» — табы (этап 1) — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Разбить раздел «Внедрение» на 3 равноправные подстраницы (Доска · Архив · Отчёт), убрать активированных клиентов с доски в Архив с возможностью вернуть.

**Architecture:** Контейнер `view-kanban` перестраивается в shell с табами + 3 внутренних блока. Доска и логика `_activated` — без изменений (карточки уже скрыты по дефолту через `_kbShowActivated=false`). Отчёт переезжает из fullscreen-overlay внутрь таба. Архив — новый view над теми же `kbCards`. Возврат из архива — override-флаг в `localStorage`.

**Tech Stack:** Монолитный HTML/CSS/JS SPA (`index.html`), без фреймворков. Нет автотестов — проверка ручная в браузере. SW для PWA-кэша. Vercel auto-deploy при push в `main`.

**Spec:** `docs/superpowers/specs/2026-05-06-implementation-section-tabs-design.md`

---

## File Structure

Все правки — в одном файле `index.html` (монолитный SPA), плюс bump кэша в `sw.js`.

**Зоны редактирования в `index.html`:**

- **CSS** (~line 1700–1736): добавить стили `.kb-tabs` и `.kb-tab` рядом с `.kbsp-seg-item`.
- **HTML markup** (lines 3626–3688, 3733–3765): обернуть содержимое `view-kanban` в три блока `kb-tab-board`, `kb-tab-archive`, `kb-tab-report` + табовая полоса сверху. Удалить overlay `view-kb-report`, перенести содержимое в `kb-tab-report`.
- **JS** (~lines 15896–18120):
  - Удалить ссылки на сегмент `activated` (~lines 16203, 16207, 16216, 16253, 16255).
  - Добавить функции: `kbActivateTab(name)`, `kbRenderArchive()`, `kbReturnFromArchive(clientName)`, `kbGetReturnOverrides()`, `kbSaveReturnOverrides()`.
  - Заменить тело `kbOpenReport()` (line 17981) и `kbCloseReport()` (line 18106) на вызовы `kbActivateTab`.
  - Добавить чтение overrides в `kbLoad()` (~line 15980).
- **HTML topbar** (line 3672): удалить кнопку «Отчёт» из `kb-topbar`.
- **Title** (line 10): bump v195 → v196.

**Файл `sw.js`:**
- Bump `CACHE_NAME = 'salesdoc-v195'` → `'salesdoc-v196'` (line 4).

---

## Замечания по тестированию

Проект — монолитный SPA, **автотестов нет**. Каждая задача проверяется вручную в браузере: либо локально (открыть `index.html` напрямую), либо после push в `main` Vercel разворачивает за ~30 сек. Шаги «Verify» — инструкции что открыть и что должно произойти.

---

## Заметка про XSS / innerHTML

В этом проекте весь рендер построен на `el.innerHTML = string`. Источник данных — Google Sheets, контролируемый владельцем. Это закреплённый паттерн codebase-а; мы его сохраняем для consistency. Все примеры ниже используют его же. Эскейпинг полезен только для имени клиента (см. `kbEsc` ниже).

## Task 1: Tab UI shell — CSS, markup-обёртки, переключатель

**Цель:** появляется панель из 3 табов; клик переключает видимые блоки. Доска ведёт себя как сейчас, Архив и Отчёт показывают плейсхолдер.

**Files:**
- Modify: `index.html` (CSS-блок ~line 1726, markup view-kanban lines 3626–3688, JS — добавление `kbActivateTab` после `var kbLog = []` на line 15970).

- [ ] **Step 1: Добавить CSS для табов**

В `index.html` найди конец блока `.kbsp-seg-item` стилей. Сразу после правила `body.light .kbsp-seg-item.active{...}` (line 1725) и перед медиа-запросом `@media (max-width: 600px)` (line 1730) — вставь:

```css
/* v196: Внедрение — табы Доска / Архив / Отчёт */
.kb-tabs{display:flex;gap:4px;padding:8px 16px 0 16px;border-bottom:1px solid var(--dark-border);background:var(--dark-panel)}
.kb-tab{padding:10px 18px;border-radius:8px 8px 0 0;font-size:13px;font-weight:600;color:var(--text-muted);cursor:pointer;border:1px solid transparent;border-bottom:none;background:transparent;font-family:'Inter',sans-serif;transition:all .15s;position:relative;top:1px}
.kb-tab:hover{color:var(--text-primary);background:rgba(99,102,241,.06)}
.kb-tab.active{color:#A5B4FC;background:var(--dark-bg);border-color:var(--dark-border);border-bottom:1px solid var(--dark-bg)}
body.light .kb-tab{color:#4B5563}
body.light .kb-tab:hover{background:#F3F4F6;color:#111827}
body.light .kb-tab.active{color:#4338CA;background:#FFFFFF;border-color:#E5E7EB;border-bottom-color:#FFFFFF}
.kbr-table th{text-align:left;padding:10px 12px;font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--text-muted);border-bottom:1px solid var(--dark-border)}
.kbr-table td{padding:10px 12px;font-size:13px;color:var(--text-primary);border-bottom:1px solid rgba(255,255,255,.04)}
.kbr-table tr:hover td{background:rgba(99,102,241,.04)}
```

- [ ] **Step 2: Обернуть содержимое `view-kanban` в табы**

Найди `<div id="view-kanban" ...>` (line 3627). Сразу **после** этого открывающего тега, **перед** `<!-- Компактный тулбар -->` (line 3628) — вставь:

```html
  <!-- v196: Табы раздела «Внедрение» -->
  <div class="kb-tabs">
   <button class="kb-tab active" id="kb-tab-btn-board" onclick="kbActivateTab('board')">Доска</button>
   <button class="kb-tab" id="kb-tab-btn-archive" onclick="kbActivateTab('archive')">Архив</button>
   <button class="kb-tab" id="kb-tab-btn-report" onclick="kbActivateTab('report')">Отчёт</button>
  </div>
  <div id="kb-tab-board" class="kb-tab-pane">
```

Найди закрывающие теги доски (после `<div id="kb-board" ...>` и `<div id="kb-scroll-dots" ...>`) — это перед комментарием `<!-- /KANBAN VIEW -->` (line 3688). Сразу **после** последнего закрывающего тега доски, но **перед** `<!-- /KANBAN VIEW -->` — вставь:

```html
  </div><!-- /kb-tab-board -->
  <div id="kb-tab-archive" class="kb-tab-pane" style="display:none;padding:24px;overflow-y:auto;height:calc(100vh - 110px)">
   <div style="text-align:center;color:var(--text-muted);padding:40px;font-size:13px">Архив — в разработке</div>
  </div>
  <div id="kb-tab-report" class="kb-tab-pane" style="display:none;overflow-y:auto;height:calc(100vh - 110px)">
   <div style="text-align:center;color:var(--text-muted);padding:40px;font-size:13px">Отчёт — в разработке</div>
  </div>
```

- [ ] **Step 3: Добавить функцию `kbActivateTab`**

Найди `// KANBAN — ВНЕДРЕНИЕ v2` (line 15896). Сразу после строки `var kbLog = [];` (line 15970) — вставь:

```javascript
// v196: Переключение табов раздела «Внедрение»
var _kbActiveTab = 'board';
function kbActivateTab(name) {
 _kbActiveTab = name;
 ['board','archive','report'].forEach(function(t){
  var pane = document.getElementById('kb-tab-'+t);
  var btn = document.getElementById('kb-tab-btn-'+t);
  if(!pane || !btn) return;
  var isActive = (t === name);
  pane.style.display = isActive ? '' : 'none';
  btn.classList.toggle('active', isActive);
 });
 if(name === 'archive' && typeof kbRenderArchive === 'function') kbRenderArchive();
 if(name === 'report' && typeof kbRenderReport === 'function') kbRenderReport();
}
```

- [ ] **Step 4: Verify в браузере**

Открой `index.html` локально, залогинься (admin), перейди в раздел «Внедрение». Ожидаемое:
- Сверху доски видна полоса с тремя табами: «Доска» (подсвечена), «Архив», «Отчёт».
- Клик «Архив» — показывается плейсхолдер «Архив — в разработке», доска скрывается, активный таб подсвечивается.
- Клик «Отчёт» — то же с плейсхолдером.
- Клик «Доска» — возвращает доску, всё работает (drag-and-drop, поиск, фильтры).
- В консоли (F12) нет ошибок.

- [ ] **Step 5: Commit**

```
git add index.html
git commit -m "feat(v196): табы Доска/Архив/Отчёт в разделе Внедрение — каркас"
```

---

## Task 2: Перенос «Отчёта» из fullscreen-overlay в таб

**Цель:** содержимое текущего fullscreen `view-kb-report` (KPI / Воронка / Aging / Сводки) живёт внутри `kb-tab-report` и открывается переключением таба. Кнопка «Отчёт» в топбаре доски удаляется.

**Files:**
- Modify: `index.html` — markup `view-kb-report` (lines 3733–3765), кнопка в `kb-topbar` (line 3672), функции `kbOpenReport` (line 17981), `kbCloseReport` (line 18106), плейсхолдер из Task 1 step 2.

- [ ] **Step 1: Перенести содержимое `view-kb-report` в `kb-tab-report`**

В `index.html` замени плейсхолдер таба «Отчёт» (созданный в Task 1) — то что было `<div style="text-align:center;...">Отчёт — в разработке</div>` — на:

```html
   <div style="padding:24px;max-width:1200px;margin:0 auto">
    <div class="kbc-section-title" style="margin-bottom:16px;font-size:18px">Отчёт по внедрениям</div>
    <div id="kbr-kpis" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:12px;margin-bottom:24px"></div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:24px">
     <div>
      <div class="kbc-section-title" style="margin-bottom:12px">Воронка по этапам</div>
      <div id="kbr-funnel"></div>
     </div>
     <div>
      <div class="kbc-section-title" style="margin-bottom:12px">Aging — дней без движения</div>
      <div id="kbr-aging"></div>
     </div>
    </div>
    <div class="kbc-section-title" style="margin-bottom:12px">Сводка по этапам</div>
    <div style="overflow-x:auto;margin-bottom:24px">
     <table id="kbr-stages-table" class="kbr-table"></table>
    </div>
    <div class="kbc-section-title" style="margin-bottom:12px">Отчёт по операторам</div>
    <div style="overflow-x:auto;margin-bottom:24px">
     <table id="kbr-ops-table" class="kbr-table"></table>
    </div>
   </div>
```

- [ ] **Step 2: Удалить старый overlay `view-kb-report`**

Найди и удали целиком блок (lines ~3733–3765):
```html
 <!-- FULLSCREEN REPORT PAGE -->
 <div id="view-kb-report" style="display:none;position:fixed;inset:0;z-index:9999;background:var(--dark-void);overflow-y:auto">
  ... всё содержимое ...
 </div>
 <!-- /FULLSCREEN REPORT PAGE -->
```

ВАЖНО: id `kbr-kpis`, `kbr-funnel`, `kbr-aging`, `kbr-stages-table`, `kbr-ops-table` теперь существуют только внутри таба (Step 1). В файле они должны быть в одном экземпляре.

- [ ] **Step 3: Удалить кнопку «Отчёт» из `kb-topbar`**

Найди (line 3672):
```html
    <button class="kb-filter-btn" onclick="kbOpenReport()" style="background:rgba(59,130,246,.08)">Отчёт</button>
```
Удали эту строку целиком.

- [ ] **Step 4: Заменить тело `kbOpenReport`**

Найди функцию `function kbOpenReport()` (line 17981). Замени её **полностью** (сигнатуру оставь — она может вызываться откуда-то ещё):

```javascript
function kbOpenReport() {
 // v196: было fullscreen-overlay, теперь — переключение на таб «Отчёт»
 kbActivateTab('report');
}
```

- [ ] **Step 5: Заменить тело `kbCloseReport`**

Найди функцию `function kbCloseReport()` (line 18106). Замени её **полностью**:

```javascript
function kbCloseReport() {
 // v196: возврат на доску = переключение таба
 kbActivateTab('board');
}
```

- [ ] **Step 6: Найти и переименовать рендер отчёта в `kbRenderReport`**

Где-то в JS должна быть функция, которая заполняет `kbr-kpis`/`kbr-funnel`/`kbr-aging`/`kbr-stages-table`/`kbr-ops-table`. Сейчас она вызывается из старого `kbOpenReport` до правки. Найди её через поиск (Grep по `kbr-kpis` или `kbr-funnel` внутри JS-блока).

Варианты:
- Если функция отдельная (например, `kbBuildReport`) — добавь рядом обёртку:
  ```javascript
  // v196: алиас для нового интерфейса табов
  function kbRenderReport() { kbBuildReport(); }
  ```
- Если код заполнения был inline внутри `kbOpenReport` (до правки в Step 4) — выдели его в отдельную функцию `kbRenderReport()` и из `kbOpenReport` (Step 4) теперь вызывается `kbActivateTab('report')`, который, в свою очередь, дёрнет `kbRenderReport`.

- [ ] **Step 7: Verify в браузере**

Открой раздел «Внедрение». Ожидаемое:
- В топбаре доски нет кнопки «Отчёт».
- Клик по табу «Отчёт» — показывает KPI, воронку, aging, обе таблицы.
- Никакого fullscreen-overlay не появляется.
- Клик «Доска» — возвращает на доску.
- Цифры в отчёте совпадают с тем что показывал старый fullscreen.
- В консоли (F12) — без ошибок.

- [ ] **Step 8: Commit**

```
git add index.html
git commit -m "feat(v196): отчёт по внедрениям — переезд из fullscreen в таб"
```

---

## Task 3: Удалить сегмент «Активированные» из панели поиска

**Цель:** в выпадающей панели фильтров доски (`kb-search-panel`) больше нет сегмента «Активированные» — теперь это отдельный таб.

**Files:**
- Modify: `index.html` — markup сегмента (line 3646), JS обработка `_kbShowActivated` (~lines 16203, 16207, 16216, 16253, 16255).

- [ ] **Step 1: Удалить сегмент из HTML**

Найди (line 3646):
```html
       <div class="kbsp-seg-item" data-seg="activated" onclick="kbPickSegment('activated')">Активированные</div>
```
Удали эту строку целиком.

- [ ] **Step 2: Зафиксировать `_kbShowActivated = false` навсегда**

В `kbPickSegment` (~line 16203) найди и удали:
```javascript
else if(seg === 'activated') _kbShowActivated = true;
```

Если рядом есть код вида `var cb = document.getElementById('kb-show-activated'); if(cb) cb.checked = ...` (~line 16207, 16253) или `var wrap = document.getElementById('kb-show-activated-wrap')` (~line 16255) — удали целиком: чекбоксы уже не существуют в DOM.

Найди (~line 16216): `else if(_kbShowActivated) activeKey = 'activated';` — удали эту ветку.

Объявление `var _kbShowActivated = ...` оставь как `var _kbShowActivated = false;` — оно используется в фильтре (line 16264) и нужно чтобы всегда было false.

- [ ] **Step 3: Verify в браузере**

Открой раздел «Внедрение» → таб «Доска» → клик в поле поиска (откроется панель сегментов). Ожидаемое:
- Сегменты в панели: «Все сделки», «Застряли (SLA > 7 дн)», «Без оператора», «Без АВР» — БЕЗ «Активированные».
- Клик по любому из них работает как раньше.
- Клик «Все сделки» — все карточки кроме активированных. Активированные на доску не возвращаются.
- В консоли — без ошибок.

- [ ] **Step 4: Commit**

```
git add index.html
git commit -m "feat(v196): убрал сегмент Активированные из фильтров доски (теперь Архив)"
```

---

## Task 4: Реализовать таб «Архив»

**Цель:** в табе «Архив» отображается KPI-полоска + таблица активированных клиентов с сортировкой и фильтрами. Клик по строке открывает существующую fullscreen-карточку клиента.

**Files:**
- Modify: `index.html` — markup `kb-tab-archive` (заменить плейсхолдер из Task 1), JS — реализовать `kbRenderArchive`.

- [ ] **Step 1: Заменить плейсхолдер таба «Архив» на полную разметку**

Найди (создан в Task 1):
```html
  <div id="kb-tab-archive" class="kb-tab-pane" style="display:none;padding:24px;overflow-y:auto;height:calc(100vh - 110px)">
   <div style="text-align:center;color:var(--text-muted);padding:40px;font-size:13px">Архив — в разработке</div>
  </div>
```
Замени на:
```html
  <div id="kb-tab-archive" class="kb-tab-pane" style="display:none;padding:24px;overflow-y:auto;height:calc(100vh - 110px)">
   <div id="kb-archive-kpis" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px;margin-bottom:20px"></div>
   <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:16px">
    <input class="kb-topbar-search" id="kb-archive-search" placeholder="Поиск по клиенту..." oninput="kbRenderArchive()" style="max-width:280px">
    <select id="kb-archive-operator" class="form-select" style="max-width:180px;font-size:12px;padding:6px 10px" onchange="kbRenderArchive()"><option value="">Все операторы</option></select>
    <select id="kb-archive-period" class="form-select" style="max-width:160px;font-size:12px;padding:6px 10px" onchange="kbRenderArchive()">
     <option value="all">Всё время</option>
     <option value="month">Месяц</option>
     <option value="quarter">Квартал</option>
     <option value="year">Год</option>
    </select>
    <div style="flex:1"></div>
    <span id="kb-archive-count" style="font-size:12px;color:var(--text-muted)"></span>
   </div>
   <div style="overflow-x:auto">
    <table class="kbr-table" id="kb-archive-table"></table>
   </div>
  </div>
```

- [ ] **Step 2: Реализовать `kbRenderArchive`**

Сразу после функции `kbActivateTab` (которую добавили в Task 1 step 3) добавь:

```javascript
// v196: эскейп для безопасной вставки имени клиента в HTML
function kbEsc(s) {
 return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// v196: рендер таба «Архив»
function kbRenderArchive() {
 var tbody = document.getElementById('kb-archive-table');
 if(!tbody) return;
 var archived = (kbCards||[]).filter(function(c){ return c._activated; });

 // Заполнить селект операторов уникальными значениями (один раз)
 var opSel = document.getElementById('kb-archive-operator');
 if(opSel && opSel.options.length <= 1) {
  var ops = {};
  archived.forEach(function(c){ if(c.operator) ops[c.operator] = 1; });
  Object.keys(ops).sort().forEach(function(o){
   var opt = document.createElement('option'); opt.value = o; opt.textContent = o; opSel.appendChild(opt);
  });
 }

 // Применить фильтры
 var q = ((document.getElementById('kb-archive-search')||{}).value || '').trim().toLowerCase();
 var fOp = (document.getElementById('kb-archive-operator')||{}).value || '';
 var fPer = (document.getElementById('kb-archive-period')||{}).value || 'all';
 var now = new Date();
 var periodCutoff = null;
 if(fPer === 'month')   periodCutoff = new Date(now.getFullYear(), now.getMonth()-1, now.getDate());
 if(fPer === 'quarter') periodCutoff = new Date(now.getFullYear(), now.getMonth()-3, now.getDate());
 if(fPer === 'year')    periodCutoff = new Date(now.getFullYear()-1, now.getMonth(), now.getDate());

 var rows = archived.filter(function(c){
  if(q && (c.client||'').toLowerCase().indexOf(q) < 0) return false;
  if(fOp && c.operator !== fOp) return false;
  if(periodCutoff) {
   var d = c.activDate ? new Date(c.activDate) : null;
   if(!d || isNaN(d) || d < periodCutoff) return false;
  }
  return true;
 });

 // Сортировка по дате активации (свежие сверху)
 rows.sort(function(a,b){
  var da = a.activDate ? new Date(a.activDate).getTime() : 0;
  var db = b.activDate ? new Date(b.activDate).getTime() : 0;
  return db - da;
 });

 // KPI strip
 var avgDays = '—';
 if(archived.length) {
  var totalDays = 0, n = 0;
  archived.forEach(function(c){
   if(c.startDate && c.activDate) {
    var s = new Date(c.startDate), e = new Date(c.activDate);
    if(!isNaN(s) && !isNaN(e)) { totalDays += Math.max(0, (e-s)/86400000); n++; }
   }
  });
  if(n) avgDays = Math.round(totalDays / n) + ' дн';
 }
 var monthCutoff = new Date(now.getFullYear(), now.getMonth()-1, now.getDate());
 var lastMonth = archived.filter(function(c){
  var d = c.activDate ? new Date(c.activDate) : null;
  return d && !isNaN(d) && d >= monthCutoff;
 }).length;

 var kpiHtml = ''
  + '<div class="mkt-main-kpi"><div class="mkt-main-kpi-label">Активировано всего</div><div class="mkt-main-kpi-val" style="color:#10B981">'+archived.length+'</div></div>'
  + '<div class="mkt-main-kpi"><div class="mkt-main-kpi-label">Среднее время активации</div><div class="mkt-main-kpi-val">'+avgDays+'</div></div>'
  + '<div class="mkt-main-kpi"><div class="mkt-main-kpi-label">За последний месяц</div><div class="mkt-main-kpi-val" style="color:#3B82F6">'+lastMonth+'</div></div>';
 document.getElementById('kb-archive-kpis').innerHTML = kpiHtml;

 // Table
 var html = '<thead><tr><th>Клиент</th><th>Дата активации</th><th>Оператор</th><th>Менеджер</th><th>Тип</th><th>Сумма</th><th>Действие</th></tr></thead><tbody>';
 if(!rows.length) {
  html += '<tr><td colspan="7" style="text-align:center;color:var(--text-muted);padding:40px">Нет записей</td></tr>';
 } else {
  rows.forEach(function(c){
   var actDate = '';
   if(c.activDate) { var d = new Date(c.activDate); if(!isNaN(d)) actDate = ('0'+d.getDate()).slice(-2)+'.'+('0'+(d.getMonth()+1)).slice(-2)+'.'+d.getFullYear(); }
   var sum = (typeof fmt2 === 'function') ? fmt2(c.amount||0) : (c.amount||0);
   var implType = (c.fields && c.fields.implType) || '—';
   var clientHtml = kbEsc(c.client||'—');
   var clientJs = (c.client||'').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
   html += '<tr style="cursor:pointer" onclick="kbOpenCard(\''+clientJs+'\')">'
    + '<td>'+clientHtml+'</td>'
    + '<td>'+actDate+'</td>'
    + '<td>'+kbEsc(c.operator||'—')+'</td>'
    + '<td>'+kbEsc(c.manager||'—')+'</td>'
    + '<td>'+kbEsc(implType)+'</td>'
    + '<td>'+sum+' ₸</td>'
    + '<td><button class="kb-filter-btn" onclick="event.stopPropagation();kbReturnFromArchive(\''+clientJs+'\')">Вернуть на доску</button></td>'
    + '</tr>';
  });
 }
 html += '</tbody>';
 tbody.innerHTML = html;
 document.getElementById('kb-archive-count').textContent = rows.length + ' из ' + archived.length;
}
```

Примечание: проверь что у `kbCards[i]` есть поля `client`, `operator`, `manager`, `amount`, `activDate`, `startDate`, `fields.implType`. Если имена отличаются — поправь по факту (явные ошибки видны в консоли).

- [ ] **Step 3: Verify в браузере**

Открой раздел «Внедрение» → таб «Архив». Ожидаемое:
- KPI-полоска: «Активировано всего», «Среднее время активации», «За последний месяц».
- Таблица активированных клиентов (свежие сверху).
- Поиск по клиенту работает.
- Фильтр оператора работает.
- Фильтр периода (Месяц/Квартал/Год/Всё) работает.
- Клик по строке открывает fullscreen-карточку клиента.
- Кнопка «Вернуть на доску» в каждой строке видна (но пока ничего не делает — Task 5).
- В консоли — без ошибок.

- [ ] **Step 4: Commit**

```
git add index.html
git commit -m "feat(v196): таб Архив — таблица активированных клиентов с фильтрами"
```

---

## Task 5: Действие «Вернуть на доску» — override через localStorage

**Цель:** клик «Вернуть на доску» убирает у клиента флаг `_activated` через override в localStorage. Карточка возвращается на доску в свою последнюю не-активированную колонку. После перезагрузки состояние сохраняется. Если в Доходах появится новая дата активации — override снимается автоматически.

**Files:**
- Modify: `index.html` — JS: реализация `kbReturnFromArchive` + чтение overrides в `kbLoad`.

- [ ] **Step 1: Реализовать `kbReturnFromArchive` и helpers**

Сразу после `kbRenderArchive` добавь:

```javascript
// v196: ключи и функции overrides «Вернуть из архива»
var KB_RETURN_OVERRIDES_KEY = 'kb_return_overrides';
function kbGetReturnOverrides() {
 try { return JSON.parse(localStorage.getItem(KB_RETURN_OVERRIDES_KEY) || '{}'); } catch(e){ return {}; }
}
function kbSaveReturnOverrides(map) {
 localStorage.setItem(KB_RETURN_OVERRIDES_KEY, JSON.stringify(map));
}
function kbReturnFromArchive(clientName) {
 if(!clientName) return;
 var key = clientName.toLowerCase();
 var ov = kbGetReturnOverrides();
 var card = (kbCards||[]).find(function(c){ return (c.client||'').toLowerCase() === key; });
 // Запоминаем дату активации на момент override чтобы потом отличать «новую активацию» от старой
 ov[key] = { since: card && card.activDate ? card.activDate : '', at: new Date().toISOString() };
 kbSaveReturnOverrides(ov);
 if(card) {
  card._activated = false;
  // Поставить карточку в последнюю не-активированную колонку (из лога)
  if(!card.stage || card.stage === 'Активирован') {
   var last = (kbLog||[]).filter(function(l){ return l.client === card.client && l.to && l.to !== 'Активирован'; }).slice(-1)[0];
   card.stage = last ? last.to : (kbColumns[kbColumns.length-1] || 'Запущен');
  }
 }
 if(typeof showToast === 'function') showToast('Возвращено на доску: ' + clientName);
 kbRenderArchive();
 if(typeof kbRenderBoard === 'function') kbRenderBoard();
}
```

- [ ] **Step 2: Учесть overrides при определении `_activated` в `kbLoad`**

Найди в `kbLoad` (line 15980) место где строится `clientActivMap`. После цикла `payments.forEach(...)` (~line 16070) добавь:

```javascript
   // v196: применяем overrides «вернуть из архива»
   var _retOv = kbGetReturnOverrides();
   var _retOvChanged = false;
   Object.keys(_retOv).forEach(function(k){
    var ov = _retOv[k];
    var current = clientActivMap[k];
    if(!current) return;
    if(ov.since && String(current) === String(ov.since)) {
     // активация не менялась — уважаем override, карточка остаётся на доске
     delete clientActivMap[k];
    } else {
     // активация в Доходах изменилась — снимаем override автоматически
     delete _retOv[k];
     _retOvChanged = true;
    }
   });
   if(_retOvChanged) kbSaveReturnOverrides(_retOv);
```

Это вставляется **сразу после** блока:
```javascript
   if(typeof payments !== 'undefined' && payments.length) {
    payments.forEach(function(p) {
     if(!p.activationDate) return;
     // ... тело цикла ...
     if(!clientActivMap[ck]) clientActivMap[ck] = p.activationDate;
    });
   }
```

- [ ] **Step 3: Verify в браузере**

Сценарий:
1. Открой раздел «Внедрение» → таб «Архив». Найди любого клиента.
2. Нажми «Вернуть на доску». Ожидаемое:
   - Toast «Возвращено на доску: ...».
   - Строка пропадает из таблицы Архива.
   - KPI «Активировано всего» уменьшается на 1.
3. Переключись на «Доска» — карточка появилась в колонке (последней, в которой была).
4. F5 (перезагрузка). Ожидаемое:
   - Карточка остаётся на доске.
   - В Архиве её нет.
5. (Опционально) DevTools → Application → Local Storage → `kb_return_overrides` — есть запись с именем клиента.
6. (Опционально) Если есть права — поменяй в Доходах 2026 «Дата активации» этого клиента на новую дату → перезагрузи. Ожидаемое: override снимается, карточка снова в Архиве.

- [ ] **Step 4: Commit**

```
git add index.html
git commit -m "feat(v196): возврат клиента из Архива на доску — override через localStorage"
```

---

## Task 6: Bump версии и финальная проверка

**Цель:** версия в `<title>` и `CACHE_NAME` синхронизирована (v195 → v196), service worker подхватывает изменения, нет регрессий.

**Files:**
- Modify: `index.html` (line 10), `sw.js` (line 4).

- [ ] **Step 1: Bump `<title>`**

В `index.html`, line 10:
```html
<title>SalesDoc — Финансовый Дашборд v195</title>
```
Заменить на:
```html
<title>SalesDoc — Финансовый Дашборд v196</title>
```

- [ ] **Step 2: Bump `CACHE_NAME` в `sw.js`**

В `sw.js`, line 4:
```javascript
var CACHE_NAME = 'salesdoc-v195';
```
Заменить на:
```javascript
var CACHE_NAME = 'salesdoc-v196';
```

- [ ] **Step 3: Финальная сквозная проверка**

Полный smoke-test:
1. Открой приложение, залогинься как admin → раздел «Внедрение».
2. Сверху видны 3 таба: Доска · Архив · Отчёт. Доска активна.
3. На доске работают: drag-and-drop карточек, фильтр оператора, фильтр менеджера, поиск, чеклист на карточке клиента, открытие fullscreen-карточки.
4. В выпадающей панели поиска нет сегмента «Активированные».
5. Активированные клиенты НЕ видны на доске.
6. Таб «Архив»: KPI, таблица, фильтры работают, кнопка «Вернуть на доску» работает.
7. Таб «Отчёт»: KPI / Воронка / Aging / Сводки — те же что были в старом fullscreen, цифры совпадают.
8. Переключение между табами без перезагрузки, без ошибок в консоли.
9. Залогинься как `manager` (`view_kanban=0`) — раздела «Внедрение» в навигации не должно быть.
10. Залогинься как `operator` — раздел доступен, все 3 таба работают.

- [ ] **Step 4: Commit + push**

```
git add index.html sw.js
git commit -m "chore(v196): bump версии — внедрение разбито на табы Доска/Архив/Отчёт"
git push origin main
```

После push — Vercel сделает деплой за ~30 сек, открой продакшн URL, повтори smoke-тест из Step 3.

---

## Self-Review (заметки автора плана)

**Spec coverage:**
- Архитектура (3 таба) → Task 1.
- Доска без активированных + удаление сегмента → Task 3 (data-flow уже работает через `_kbShowActivated=false`).
- Архив (KPI, таблица, фильтры, клик в карточку) → Task 4.
- Возврат из архива (override через localStorage) → Task 5.
- Отчёт (перенос fullscreen → таб) → Task 2.
- Версионирование (title + CACHE_NAME) → Task 6.
- Связь с будущим канбаном «Производство и Поддержка» — учтено в spec, кнопка «Вернуть на доску» спроектирована так чтобы рядом было место для «Передать в производство» (отдельная задача).

**Известные неопределённости:**
- В Task 4: имена полей карточки (`activDate`, `startDate`, `fields.implType`) — лучшие догадки на основе кода в районе lines 16085–16108 и 15943. Если поля называются иначе — исполнитель поправит при первом запуске (явные ошибки в консоли).
- В Task 2 step 6: точное имя текущей функции рендера отчёта — нужен Grep на момент исполнения (`kbr-kpis|kbr-funnel|kbr-aging` внутри JS).
