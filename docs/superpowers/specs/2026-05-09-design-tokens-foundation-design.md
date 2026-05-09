# Дизайн-система SalesDoc — фундамент (v196)

**Дата:** 2026-05-09
**Файл:** `index.html` (монолитный SPA)
**Зачем:** Унифицировать визуал и подготовить базу под Apple/Arc-премиум рефакторинг по блокам. Сейчас в коде ad-hoc CSS-переменные только под цвета, ~70 уникальных `box-shadow`, 5 разных `border-radius`, три шрифта без иерархии — любая правка визуала требует переписывания десятков мест.

## 1. Стратегия миграции

**Аддитивно с поэтапным рефакторингом.**

- Новые токены добавляются в `:root` и `body.light`, рядом со старыми
- Старые переменные (`--gold-*`, `--dark-card`, `--text-primary`, etc.) **остаются** — они используются 800+ раз, удалять небезопасно
- Файл `index.html` всегда работает после каждого коммита
- Откат — `git revert` любого коммита

**Порядок рефакторинга компонентов (отдельные релизы, вне этого спека):**
1. KPI-карточки
2. Таблицы и форматирование чисел
3. Кнопки и инпуты
4. Формы
5. Модалки
6. Sidebar / topbar
7. Финальный sweep — удаление неиспользуемых старых переменных

## 2. Шрифт

**Inter — единственный.**

- Веса: 400, 500, 600, 700
- `display=swap` — без FOUC на медленных сетях
- Manrope и Space Grotesk удаляются из `<link>`
- `font-feature-settings: 'cv11' 1` — открытые формы цифр
- На всех числовых элементах (KPI, таблицы, валюта, проценты) — `font-variant-numeric: tabular-nums` через утилитарный класс `.num` или включением в селектор компонента

**Фолбэк:** `'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif`

## 3. Палитра — Emerald Depth основная

Базируется на трёх референсах от пользователя: Emerald Depth (главная), Navy Mirage (инфо), Crimson Velvet (danger).

### 3.1 Dark theme (по умолчанию)

```css
--bg            #0F2027
--surface       #14322D
--surface-2     #18403A
--surface-3     #1F5046

--border        rgba(40,98,58,.20)
--border-strong rgba(40,98,58,.40)
--border-faint  rgba(40,98,58,.10)

--text          #F1F7F2
--text-2        #B8CFC0
--text-soft     #8FAA9A          (намеренно НЕ --text-muted — старая переменная остаётся со своим значением)
--text-faint    #5F8070

--accent        #28623A
--accent-hover  #34794A
--accent-bg     rgba(40,98,58,.15)
--accent-text   #4DAB68

/* Семантика — префикс --ds- чтобы не пересекаться с существующими --success/--info/--danger/--warning */
--ds-success       #28623A      (= accent)
--ds-success-text  #4DAB68
--ds-success-bg    rgba(40,98,58,.15)

--ds-info          #35577D      (Navy Mirage accent)
--ds-info-text     #6B8FB8
--ds-info-bg       rgba(53,87,125,.18)

--ds-danger        #C13A40      (Crimson Velvet, поднят для контраста — в рефе #6B1E23 слишком тёмный для алерта)
--ds-danger-text   #D67075
--ds-danger-bg     rgba(193,58,64,.15)
--ds-danger-deep   #6B1E23      (для фоновых пилюль/градиентов в духе референса)

--ds-warning       #D97706      (amber, не из рефов — нужен в UX)
--ds-warning-text  #F59E0B
--ds-warning-bg    rgba(217,119,6,.15)
```

### 3.2 Light theme (переключатель сохраняется)

```css
--bg            #F5F7F3
--surface       #FFFFFF
--surface-2     #F0F4ED
--surface-3     #FFFFFF

--border        rgba(40,98,58,.18)
--border-strong rgba(40,98,58,.30)
--border-faint  rgba(40,98,58,.08)

--text          #0F2027
--text-2        #3A5048
--text-soft     #6B7C72
--text-faint    #95A89B

--accent        #1F4D2D
--accent-hover  #28623A
--accent-bg     rgba(40,98,58,.10)
--accent-text   #1F4D2D

--ds-info       #2D4768
--ds-danger     #A02D33
--ds-warning    #B45309
```

## 4. Типографическая шкала

```css
--font-display-xl  40px / 700 / -1px / 1.1
--font-display     32px / 600 / -0.5px / 1.15   /* KPI-значения */
--font-h1          24px / 600 / -0.3px / 1.25
--font-h2          20px / 600 / -0.2px / 1.3
--font-h3          18px / 600 / 0 / 1.35
--font-body-lg     16px / 400 / 0 / 1.5
--font-body        14px / 400 / 0 / 1.5
--font-body-sm     13px / 400 / 0 / 1.45
--font-caption     12px / 500 / 0 / 1.4
--font-label       11px / 600 / +0.5px / 1.3 / uppercase
```

Утилитарный класс `.num`:
```css
.num { font-variant-numeric: tabular-nums; font-feature-settings: 'tnum' 1, 'cv11' 1; }
```

## 5. Spacing / Radius / Shadows

```css
/* Spacing — 4px base */
--sp-1: 4px;
--sp-2: 8px;
--sp-3: 12px;
--sp-4: 16px;
--sp-5: 24px;
--sp-6: 32px;
--sp-7: 48px;
--sp-8: 64px;

/* Radius */
--r-sm: 8px;     /* инпуты, чипы */
--r-md: 12px;    /* кнопки */
--r-lg: 16px;    /* карточки */
--r-xl: 20px;    /* модалки */
--r-pill: 999px; /* пилюли (под рефы) */

/* Shadows — 3-слойные с inset highlight */
--sh-1: 0 1px 2px rgba(0,0,0,.30),
        0 1px 1px rgba(0,0,0,.20);

--sh-2: 0 4px 12px rgba(0,0,0,.30),
        0 2px 4px rgba(0,0,0,.20),
        inset 0 1px 0 rgba(255,255,255,.04);

--sh-3: 0 16px 40px rgba(0,0,0,.40),
        0 6px 16px rgba(0,0,0,.25),
        inset 0 1px 0 rgba(255,255,255,.06);

/* Glass — характер из референсов */
--glass-1-bg:     rgba(255,255,255,.04);
--glass-1-blur:   blur(12px);
--glass-1-border: rgba(255,255,255,.08);

--glass-2-bg:     rgba(255,255,255,.06);
--glass-2-blur:   blur(20px);
--glass-2-border: rgba(255,255,255,.12);

/* Light theme — glass overrides */
body.light {
  --glass-1-bg: rgba(0,0,0,.03);
  --glass-1-border: rgba(0,0,0,.08);
  --glass-2-bg: rgba(0,0,0,.05);
  --glass-2-border: rgba(0,0,0,.10);
}

/* Transitions */
--t-fast: 120ms cubic-bezier(.2,.8,.2,1);
--t-base: 200ms cubic-bezier(.2,.8,.2,1);
--t-slow: 320ms cubic-bezier(.2,.8,.2,1);
```

## 6. Изменения в файле прямо в этом релизе

Только фундамент — компоненты не трогаем.

1. `<link>` шрифтов в `<head>`: убрать Manrope и Space Grotesk, оставить только Inter с весами 400/500/600/700, добавить `display=swap`
2. В `:root` добавить блок `/* DESIGN SYSTEM v196 — Emerald foundation */` со всеми токенами раздела 3.1, 4, 5
3. В `body.light` добавить overrides раздела 3.2 (только токены, которые отличаются)
4. Добавить utility `.num` (раздел 4)
5. `<title>`: `v195` → `v196`
6. `sw.js`: `CACHE_NAME` `salesdoc-v195` → `salesdoc-v196`

## 7. Что НЕ делаем в этом релизе

- Не переписываем KPI / таблицы / кнопки / формы / модалки — это последующие релизы
- Не удаляем старые `--gold-*`, `--dark-card`, etc. — они активно используются
- Не добавляем `!important` к новым токенам — старые правила должны перебивать локально, новые применяются только когда компонент явно их использует
- Не меняем поведение `body.light` для старых токенов

## 8. Критерии готовности (этот релиз)

- [ ] В `<head>` ровно один `<link>` шрифта, и это Inter с `display=swap`
- [ ] В `:root` присутствует блок `DESIGN SYSTEM v196` со всеми токенами
- [ ] В `body.light` присутствуют light-overrides
- [ ] Класс `.num` определён
- [ ] `<title>` показывает v196
- [ ] `sw.js` `CACHE_NAME = 'salesdoc-v196'`
- [ ] Открыть приложение в браузере — визуально **ничего не должно поменяться** (компоненты ещё используют старые токены)
- [ ] DevTools Network: загружается только Inter, не Manrope и не Space Grotesk
- [ ] DevTools Computed: на любом элементе доступны `--accent`, `--sp-4`, `--r-lg`, `--sh-2`

## 9. Открытые вопросы

Нет — все ключевые решения зафиксированы:
- Стратегия: аддитивная
- Шрифт: Inter единый
- Палитра: Emerald основная, Navy info, Crimson danger
- Light тема: оставить
- Шкалы: 4px-base, крупные radius, 3-слойные тени
