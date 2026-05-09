# Design Tokens Foundation (v196) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Заложить дизайн-систему Emerald (палитра, шрифт Inter, шкалы spacing/radius/shadows/typography) аддитивным слоем поверх существующего CSS, не меняя визуал ни одного компонента.

**Architecture:** Один монолитный SPA `index.html`. Новые токены добавляются отдельным `:root` блоком СРАЗУ после существующего `:root` (CSS-переменные мерджатся), новый `body.light` блок после существующего, утилитарный класс `.num` рядом. Старые переменные (`--gold-*`, `--dark-card`, `--text-primary`, существующие семантические `--success/--info/--danger/--warning`) остаются нетронутыми. Новые семантические токены имеют префикс `--ds-` чтобы не сталкиваться. `<title>` бампается v195 → v196, `sw.js` `CACHE_NAME` тоже — иначе SW отдаст старый закэшированный HTML.

**Tech Stack:** Vanilla HTML/CSS, Google Fonts (Inter), Service Worker (cache-busting).

**Тестирование:** В проекте нет автотестов (vanilla SPA). Верификация ручная: открыть приложение в браузере, проверить DevTools (Network → загружен только Inter; Computed styles → новые токены доступны), визуально убедиться что компоненты выглядят идентично текущему состоянию.

**Спека:** `docs/superpowers/specs/2026-05-09-design-tokens-foundation-design.md`

---

## File Structure

| Файл | Что меняем |
|------|------------|
| `index.html:10` | `<title>` — bump v195 → v196 |
| `index.html:13` | `<link>` шрифтов — заменить на один Inter |
| `index.html` после строки 393 | НОВЫЙ `:root` блок с дизайн-токенами |
| `index.html` после нового `:root` | НОВЫЙ `body.light` блок с light-overrides |
| `index.html` после нового `body.light` | Утилитарный класс `.num` |
| `sw.js:4` | `CACHE_NAME` — bump v195 → v196 |

---

## Task 1: Foundation release v196

**Files:**
- Modify: `index.html` (строки 10, 13, и вставка трёх новых блоков после строки 393)
- Modify: `sw.js:4`

### Pre-flight: убедиться что мы на чистой ветке

- [ ] **Step 1: Проверить git status**

```bash
git status
```

Ожидаемый вывод: `On branch main`, `nothing to commit, working tree clean` (или есть только untracked не связанные с этой задачей файлы).

Если есть незафиксированные изменения в `index.html` или `sw.js` — остановиться и спросить пользователя.

---

### Edit 1: Bump `<title>` на v196

- [ ] **Step 2: Прочитать текущую строку**

Открыть `index.html`, строка 10 содержит:
```html
<title>SalesDoc — Финансовый Дашборд v195</title>
```

- [ ] **Step 3: Заменить v195 → v196**

Применить точечную правку:

```html
<title>SalesDoc — Финансовый Дашборд v196</title>
```

---

### Edit 2: Заменить `<link>` шрифтов на один Inter

- [ ] **Step 4: Прочитать текущую строку 13**

Текущее значение (одна строка):
```html
<link href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700&family=Space+Grotesk:wght@500;600;700&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
```

- [ ] **Step 5: Заменить на Inter-only**

Новое значение (одна строка):
```html
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
```

Параметр `display=swap` уже был — оставляем.

`<link rel="preconnect">` строки 11–12 НЕ трогаем — preconnect к `fonts.googleapis.com` и `fonts.gstatic.com` всё ещё нужен для Inter.

---

### Edit 3: Добавить новый `:root` блок с дизайн-токенами

- [ ] **Step 6: Найти точку вставки**

Существующий `:root` блок занимает строки 378–393. На строке 393 — закрывающая `}`. На строке 394 — комментарий `/* LIGHT THEME — ТЗ v147 ... */`.

Вставить НОВЫЙ блок СРАЗУ после строки 393, ПЕРЕД строкой 394.

- [ ] **Step 7: Вставить блок токенов**

Использовать Edit, найти уникальный якорь — последнюю строку существующего `:root`:

old_string:
```
--sidebar-bg:#07131D;--topbar-bg:#153043;
}
/* LIGHT THEME — ТЗ v147, изменение 5: нейтральный #F5F6F8 фон, белые карточки */
```

new_string:
```
--sidebar-bg:#07131D;--topbar-bg:#153043;
}
/* ============================================================
   DESIGN SYSTEM v196 — Emerald foundation
   Аддитивный слой токенов. Старые переменные (--gold-*, --dark-card,
   --success/--info/--danger/--warning, --text-primary/--text-muted)
   НЕ трогаются — они останутся работать в существующих компонентах.
   Новые семантические токены имеют префикс --ds- чтобы избежать
   коллизий. Компоненты будут переключаться на эти токены поэтапно
   в последующих релизах.
   ============================================================ */
:root{
 /* Backgrounds */
 --bg:#0F2027;--surface:#14322D;--surface-2:#18403A;--surface-3:#1F5046;
 /* Borders */
 --border:rgba(40,98,58,.20);--border-strong:rgba(40,98,58,.40);--border-faint:rgba(40,98,58,.10);
 /* Text — НЕ переопределяем существующие --text-primary/--text-secondary/--text-muted */
 --text:#F1F7F2;--text-2:#B8CFC0;--text-soft:#8FAA9A;--text-faint:#5F8070;
 /* Accent (Emerald) */
 --accent:#28623A;--accent-hover:#34794A;--accent-bg:rgba(40,98,58,.15);--accent-text:#4DAB68;
 /* Semantic — префикс --ds- */
 --ds-success:#28623A;--ds-success-text:#4DAB68;--ds-success-bg:rgba(40,98,58,.15);
 --ds-info:#35577D;--ds-info-text:#6B8FB8;--ds-info-bg:rgba(53,87,125,.18);
 --ds-danger:#C13A40;--ds-danger-text:#D67075;--ds-danger-bg:rgba(193,58,64,.15);--ds-danger-deep:#6B1E23;
 --ds-warning:#D97706;--ds-warning-text:#F59E0B;--ds-warning-bg:rgba(217,119,6,.15);
 /* Spacing — 4px base */
 --sp-1:4px;--sp-2:8px;--sp-3:12px;--sp-4:16px;--sp-5:24px;--sp-6:32px;--sp-7:48px;--sp-8:64px;
 /* Radius */
 --r-sm:8px;--r-md:12px;--r-lg:16px;--r-xl:20px;--r-pill:999px;
 /* Shadows — 3-layer + inset highlight */
 --sh-1:0 1px 2px rgba(0,0,0,.30),0 1px 1px rgba(0,0,0,.20);
 --sh-2:0 4px 12px rgba(0,0,0,.30),0 2px 4px rgba(0,0,0,.20),inset 0 1px 0 rgba(255,255,255,.04);
 --sh-3:0 16px 40px rgba(0,0,0,.40),0 6px 16px rgba(0,0,0,.25),inset 0 1px 0 rgba(255,255,255,.06);
 /* Glass */
 --glass-1-bg:rgba(255,255,255,.04);--glass-1-blur:blur(12px);--glass-1-border:rgba(255,255,255,.08);
 --glass-2-bg:rgba(255,255,255,.06);--glass-2-blur:blur(20px);--glass-2-border:rgba(255,255,255,.12);
 /* Typography sizes (используются через font: или раздельно font-size/font-weight/letter-spacing) */
 --font-display-xl-size:40px;--font-display-size:32px;--font-h1-size:24px;--font-h2-size:20px;--font-h3-size:18px;
 --font-body-lg-size:16px;--font-body-size:14px;--font-body-sm-size:13px;--font-caption-size:12px;--font-label-size:11px;
 /* Transitions */
 --t-fast:120ms cubic-bezier(.2,.8,.2,1);
 --t-base:200ms cubic-bezier(.2,.8,.2,1);
 --t-slow:320ms cubic-bezier(.2,.8,.2,1);
}
/* LIGHT THEME — ТЗ v147, изменение 5: нейтральный #F5F6F8 фон, белые карточки */
```

---

### Edit 4: Добавить новый `body.light` блок с light-overrides

- [ ] **Step 8: Найти точку вставки**

После всех правок выше существующий `body.light` блок (раньше был на строках 395–411) сместился ниже. Найти его конец — строка с `--sidebar-bg:#111827;` и следующая закрывающая `}`. Сразу после неё (перед комментарием `/* Light theme: нейтральный фон без градиентов ... */`) вставить новый блок.

- [ ] **Step 9: Вставить новый `body.light` блок**

Использовать Edit с уникальным якорем:

old_string:
```
 --sidebar-bg:#111827;
}
/* Light theme: нейтральный фон без градиентов, цифры KPI графитовые #111827 */
```

new_string:
```
 --sidebar-bg:#111827;
}
/* DESIGN SYSTEM v196 — light theme overrides (только новые токены) */
body.light{
 --bg:#F5F7F3;--surface:#FFFFFF;--surface-2:#F0F4ED;--surface-3:#FFFFFF;
 --border:rgba(40,98,58,.18);--border-strong:rgba(40,98,58,.30);--border-faint:rgba(40,98,58,.08);
 --text:#0F2027;--text-2:#3A5048;--text-soft:#6B7C72;--text-faint:#95A89B;
 --accent:#1F4D2D;--accent-hover:#28623A;--accent-bg:rgba(40,98,58,.10);--accent-text:#1F4D2D;
 --ds-success:#1F4D2D;--ds-success-text:#1F4D2D;--ds-success-bg:rgba(40,98,58,.10);
 --ds-info:#2D4768;--ds-info-text:#2D4768;--ds-info-bg:rgba(45,71,104,.10);
 --ds-danger:#A02D33;--ds-danger-text:#A02D33;--ds-danger-bg:rgba(160,45,51,.10);--ds-danger-deep:#6B1E23;
 --ds-warning:#B45309;--ds-warning-text:#B45309;--ds-warning-bg:rgba(180,83,9,.10);
 --glass-1-bg:rgba(0,0,0,.03);--glass-1-border:rgba(0,0,0,.08);
 --glass-2-bg:rgba(0,0,0,.05);--glass-2-border:rgba(0,0,0,.10);
}
/* Light theme: нейтральный фон без градиентов, цифры KPI графитовые #111827 */
```

---

### Edit 5: Добавить утилитарный класс `.num`

- [ ] **Step 10: Вставить класс сразу после нового `body.light` блока**

Использовать Edit с якорем — последняя строка нового light-блока + следующая существующая строка:

old_string:
```
 --glass-2-bg:rgba(0,0,0,.05);--glass-2-border:rgba(0,0,0,.10);
}
/* Light theme: нейтральный фон без градиентов, цифры KPI графитовые #111827 */
```

new_string:
```
 --glass-2-bg:rgba(0,0,0,.05);--glass-2-border:rgba(0,0,0,.10);
}
/* DESIGN SYSTEM v196 — utility: tabular-nums для финансовых чисел */
.num{font-variant-numeric:tabular-nums;font-feature-settings:'tnum' 1,'cv11' 1}
/* Light theme: нейтральный фон без градиентов, цифры KPI графитовые #111827 */
```

---

### Edit 6: Bump `CACHE_NAME` в `sw.js`

- [ ] **Step 11: Заменить версию кэша**

В `sw.js` строка 4:

old_string:
```javascript
var CACHE_NAME = 'salesdoc-v195';
```

new_string:
```javascript
var CACHE_NAME = 'salesdoc-v196';
```

---

### Verification (ручная)

- [ ] **Step 12: Открыть `index.html` локально или на Vercel preview**

Открыть приложение в браузере. Залогиниться (если не сохранён вход).

Ожидаемое поведение: визуально приложение выглядит **идентично v195** — никакие компоненты не должны измениться. Если что-то поменялось — это регрессия (вероятно конфликт переменных), остановиться и разобраться.

- [ ] **Step 13: DevTools → Network → проверить шрифты**

Открыть Network tab, перезагрузить страницу с `Ctrl+Shift+R`. Отфильтровать по `font` или `googleapis`.

Ожидаемое: только один запрос на CSS с Inter (`fonts.googleapis.com/css2?family=Inter:...`) и последующие запросы на woff2 файлы Inter. Запросов на Manrope или Space Grotesk быть не должно.

- [ ] **Step 14: DevTools → Elements → выбрать `<body>` → Computed → проверить токены**

Должны быть видны новые переменные:
- `--bg: #0F2027`
- `--accent: #28623A`
- `--sp-4: 16px`
- `--r-lg: 16px`
- `--sh-2: 0 4px 12px rgba(...) ...`
- `--ds-info: #35577D`

Старые переменные тоже должны быть на месте:
- `--gold-mid: #3B82F6`
- `--dark-card: #153043`
- `--success: #10B981`

- [ ] **Step 15: Проверить переключатель темы**

Кликнуть переключатель light/dark в topbar. Все компоненты должны переключаться как раньше. В DevTools на light-теме `--accent` должен показывать `#1F4D2D`, в dark — `#28623A`.

- [ ] **Step 16: Проверить utility `.num`**

В DevTools Elements → Console:
```javascript
const el = document.createElement('div'); el.className = 'num'; el.textContent = '1234567'; document.body.appendChild(el); getComputedStyle(el).fontVariantNumeric;
```

Ожидаемое: строка содержит `tabular-nums`. Удалить тестовый элемент: `el.remove();`.

- [ ] **Step 17: Проверить SW cache bump**

DevTools → Application → Cache Storage. Должен появиться `salesdoc-v196`. Старый `salesdoc-v195` будет удалён при следующей активации SW (через `caches.delete` в `activate` handler).

---

### Commit

- [ ] **Step 18: Закоммитить одним коммитом**

```bash
git add index.html sw.js
git commit -m "$(cat <<'EOF'
feat(v196): дизайн-система — Emerald foundation (токены)

Аддитивный слой: новый :root блок с палитрой Emerald
(bg #0F2027, accent #28623A), Navy info, Crimson danger,
4px spacing, радиусы 8/12/16/20/pill, 3-слойные shadows,
typography sizes, transitions. Шрифт Inter единый. Старые
переменные не тронуты, новые семантические — префикс --ds-.
Компоненты рефакторятся отдельно в следующих релизах.

Spec: docs/superpowers/specs/2026-05-09-design-tokens-foundation-design.md

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 19: Проверить коммит**

```bash
git log -1 --stat
```

Ожидаемое: один коммит, ровно два файла изменены: `index.html` и `sw.js`. Без посторонних правок.

- [ ] **Step 20: Push (опционально, по решению пользователя)**

Если пользователь подтвердил — `git push`. Vercel автоматически развернёт.

---

## Acceptance criteria (из спеки)

- [x] В `<head>` ровно один `<link>` шрифта, и это Inter с `display=swap` (Step 5)
- [x] В файле присутствует блок `DESIGN SYSTEM v196` со всеми токенами (Step 7)
- [x] Присутствуют light-overrides (Step 9)
- [x] Класс `.num` определён (Step 10)
- [x] `<title>` показывает v196 (Step 3)
- [x] `sw.js` `CACHE_NAME = 'salesdoc-v196'` (Step 11)
- [x] Приложение визуально не изменилось (Step 12)
- [x] DevTools Network: загружается только Inter (Step 13)
- [x] DevTools Computed: доступны `--accent`, `--sp-4`, `--r-lg`, `--sh-2` (Step 14)
