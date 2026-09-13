# Единая дизайн-система — аудит и план миграции

**Дата:** 2026-09-13
**Статус:** черновик на согласование (Mirzahit)
**Прод:** v958
**Основание:** аудит всего `index.html` (CSS L14–8137, JS-шаблоны, 8 скриншотов разделов).

---

## A. Диагноз

### A1. В файле живут 5 дизайн-систем одновременно
23 блока `DESIGN SYSTEM v*` и 7 конкурирующих `:root`:

| Строка | Слой | Что задаёт |
|---|---|---|
| L379 | legacy v147 | `--gold-*`, `--dark-*`, `--text-primary/secondary/muted` |
| L405 | v196 Emerald | `--bg/--surface*`, `--accent #2C9466`, `--ds-*`, `--r-*` 8/12/16/20 |
| L480 | v215 iOS | `--r-*` → **10/14/18/24**, body 15/17px, тени, transitions |
| L893 | v264 Amo | `--amo-blue*` + «никаких цветных полос» |
| L1729, L4970 | v217/v291 remap | `--gold-*` → зелёный/индиго |
| **L5057** | **v664 Linear** | финальный override: графит #08090B/#101116, индиго #5E6AD2 |

Реально рендерится палитра v664, но **радиусы, типографика body, тени — от v215**. В v664 `--text-soft` = `--text-faint` (L5064), в light `--surface` = `--surface-2` = #FFF (L5090): шкалы текста и поверхностей схлопнулись.

145 разных `var(--…)` в использовании: `--text-muted` ×787, `--text-soft` ×329, `--dark-border` ×205, `--text-primary` ×204, `--gold-bright` ×88, `--amocard-*` ×~160.

### A2. Разделы-«чужие продукты»
1. **Мои задачи / формы CRM-задач** — `.mt-page` L8023, `.ct-*` L7438/7747/7942: `PT Sans`, navy `#0b1220/#0e1626`, border `#2a3a52` (Tailwind-slate внутри графита).
2. **Академия** — `.acad-tab` L3102: `#334155/#94a3b8/#2563eb` (55 вхождений tailwind-slate).
3. **Карточка задачи** — `.tcard-wrap` L1478: `#1b1e26/#2a2e39`, teal `#4CC2C0` ×14, `.tc-send` L6782 `#2F80ED` — третий синий рядом с `#5E6AD2` и `#0A84FF`.
4. **Карточка клиента** — 28 токенов `--amocard-*` L7084–7130, своя палитра/тени; UPPERCASE-лейблы 10px.
5. **Доска Маршрута** — цветные полосы над колонками (L5309) вопреки v264.
6. **Дашборд ↔ Финансы ↔ Маркетинг** — тонированные KPI vs плоские; капс-лейблы на Маркетинге вопреки v291/v665; в топбаре Маркетинга заголовок «Обзор финансов» (L16022).
7. **Спринт / Задачи** — три разных шапки, сайдбар в задачах — 2 иконки вместо 7.
8. `.kpi-card` определён **14 раз**; 1963 `!important`, 1453 селекторов, скоупленных на `#view-*`.

### A3. Цифры
| Метрика | CSS | JS/HTML inline |
|---|---|---|
| `border-radius` | **46 значений** / 864 вхождения; через `var(--r-*)` — 3% | 21 / 447 |
| hex-цвета | **430 уникальных** / 2474 | JS 205 / 1038 |
| топ hex в JS | — | `#4CB782`×159, `#E5604D`×115, `#5E6AD2`×107, `#E0A458`×57, `#828FF7`×43 — все уже есть токенами |
| `font-size` | **53 значения** / 1370; дробные 11.5/12.5/10.5 ≈370 мест; <11px ≈280 | 26 / 1151 |
| `font-family` | **19 вариантов** / 393 (Inter дубли, Bebas, PT Sans, Montserrat, Georgia) | |
| `box-shadow` | **184 уникальных** / 294 | 26 |
| `font-weight` | 800×48, 650×28, 900×2 | |
| таблицы | 9 семейств, `th` 9–12px, `td` padding 8 вариантов (52px vs 38px строка) | |
| тосты / empty / модалки | 2 / 4 / 7 разных | |
| глифы вместо иконок | `→`×233, `×`×54, `▾`×33, `‹›`×14, `←`×12, `✓`×10, `↻`×3, `⋯`×3 | |

Иконки в сайдбаре — хорошо (inline SVG 20px, stroke 1.5, L8211–8249). Эмодзи почти нет — плюс.

---

## B. Единая система (совместима с текущими токенами)

Принцип: **не шестой набор, а один блок-«истина» после v664 (L5057), фиксирующий значения + алиасы для legacy-имён**. Старые имена остаются алиасами → 0 регрессий на первом шаге.

```css
/* DS-FINAL — ставится ПОСЛЕ v664 (L5057+) */
:root{
  /* Нейтрали (dark) */
  --bg:#08090B; --surface:#101116; --surface-2:#16171D; --surface-3:#1D1F26;
  --overlay:rgba(8,9,11,.64);
  --border:rgba(255,255,255,.08); --border-faint:rgba(255,255,255,.05); --border-strong:rgba(255,255,255,.13);
  /* Текст — 4 РАЗНЫХ уровня */
  --text:#F7F8F8; --text-2:#A3A8B1; --text-soft:#7A7F89; --text-faint:#565B64;
  /* Один акцент */
  --accent:#5E6AD2; --accent-hover:#828FF7; --accent-bg:rgba(94,106,210,.16); --accent-text:#A6ADEA;
  --focus-ring:0 0 0 3px rgba(94,106,210,.35);
  /* Семантика (info ≠ accent) */
  --ds-success:#4CB782; --ds-success-text:#6ACB99; --ds-success-bg:rgba(76,183,130,.14);
  --ds-warning:#E0A458; --ds-warning-text:#EAB878; --ds-warning-bg:rgba(224,164,88,.16);
  --ds-danger:#E5604D;  --ds-danger-text:#F0806F;  --ds-danger-bg:rgba(229,96,77,.14);
  --ds-info:#5AA7F0;    --ds-info-text:#7FBCF5;    --ds-info-bg:rgba(90,167,240,.14);
  /* Типографика */
  --font:'Inter',system-ui,-apple-system,'Segoe UI',sans-serif;
  --mono:'IBM Plex Mono',ui-monospace,SFMono-Regular,monospace;  /* только числа KPI/таблиц */
  --fs-11:11px; --fs-12:12px; --fs-13:13px; --fs-14:14px; --fs-16:16px; --fs-20:20px; --fs-24:24px; --fs-32:32px;
  --lh-tight:1.2; --lh-heading:1.35; --lh-body:1.5;
  --ls-display:-0.02em; --ls-body:-0.01em; --ls-label:.04em;
  /* Радиусы — 3 значения */
  --r-control:8px; --r-card:12px; --r-modal:16px;
  --r-sm:var(--r-control); --r-md:var(--r-card); --r-lg:var(--r-modal); --r-xl:var(--r-modal); --r-pill:999px;
  /* Тени — 3 уровня */
  --sh-1:0 1px 2px rgba(0,0,0,.30);
  --sh-2:0 6px 16px rgba(0,0,0,.32),0 2px 4px rgba(0,0,0,.20);
  --sh-3:0 24px 48px rgba(0,0,0,.45),0 8px 16px rgba(0,0,0,.24);
  --sp-1:4px; --sp-2:8px; --sp-3:12px; --sp-4:16px; --sp-5:24px; --sp-6:32px; --sp-7:48px; --sp-8:64px;
  --t-fast:120ms cubic-bezier(.2,.8,.2,1); --t-base:200ms cubic-bezier(.2,.8,.2,1);
  --h-control:36px; --h-control-sm:28px; --h-row:40px;

  /* АЛИАСЫ legacy → новые (удалить после миграции) */
  --text-primary:var(--text); --text-secondary:var(--text-2); --text-muted:var(--text-soft);
  --dark-void:var(--bg); --dark-base:var(--bg); --dark-bg:var(--bg); --dark-card:var(--surface); --dark-panel:var(--surface-2);
  --dark-border:var(--border); --dark-border-bright:var(--border-strong);
  --gold-deep:var(--accent); --gold-mid:var(--accent); --gold-bright:var(--accent-hover); --gold-light:var(--accent-text);
  --success:var(--ds-success); --warning:var(--ds-warning); --danger:var(--ds-danger); --info:var(--ds-info); --done:var(--ds-success);
  --amo-blue:var(--accent); --amo-blue-deep:var(--accent); --amo-blue-soft:var(--accent-bg); --amo-blue-fill:var(--accent-bg);
  --accent-bright:var(--accent-hover); --accent-deep:var(--accent);
  --glass-bg:var(--surface); --glass-border:var(--border);
  --ds-page-bg:var(--bg); --ds-col-bg:var(--surface); --ds-card-bg:var(--surface-2); --ds-border-soft:var(--border-faint);
  /* карточка клиента: 28 токенов → общие */
  --amocard-bg:var(--bg); --amocard-surface:var(--surface); --amocard-surface-2:var(--bg); --amocard-surface-3:var(--surface-3);
  --amocard-border:var(--border); --amocard-border-strong:var(--border-strong); --amocard-hairline:var(--border-faint);
  --amocard-text:var(--text); --amocard-text-2:var(--text-2); --amocard-text-soft:var(--text-soft); --amocard-text-faint:var(--text-faint);
  --amocard-accent:var(--accent); --amocard-accent-bg:var(--accent-bg); --amocard-blue:var(--ds-info); --amocard-blue-bg:var(--ds-info-bg);
  --amocard-green:var(--ds-success); --amocard-green-bg:var(--ds-success-bg); --amocard-amber:var(--ds-warning); --amocard-amber-bg:var(--ds-warning-bg);
  --amocard-purple:var(--accent-hover); --amocard-purple-bg:var(--accent-bg);
  --amocard-sh-1:var(--sh-1); --amocard-sh-2:var(--sh-2); --amocard-sh-3:var(--sh-3);
}
body.light{
  --bg:#FAFAFB; --surface:#FFFFFF; --surface-2:#F4F5F7; --surface-3:#EDEEF1;
  --overlay:rgba(15,18,25,.40);
  --border:rgba(15,18,25,.09); --border-faint:rgba(15,18,25,.06); --border-strong:rgba(15,18,25,.15);
  --text:#16181D; --text-2:#5C616B; --text-soft:#7A7F89; --text-faint:#A0A5AE;
  --accent:#4F5BC4; --accent-hover:#5E6AD2; --accent-bg:rgba(94,106,210,.10); --accent-text:#4651B5;
  --focus-ring:0 0 0 3px rgba(94,106,210,.25);
  --ds-success:#2C9466; --ds-success-text:#237A54; --ds-success-bg:rgba(44,148,102,.12);
  --ds-warning:#B07A2E; --ds-warning-text:#8F6222; --ds-warning-bg:rgba(224,164,88,.14);
  --ds-danger:#D24A36;  --ds-danger-text:#B23C2B;  --ds-danger-bg:rgba(210,74,54,.10);
  --ds-info:#2E7FD6;    --ds-info-text:#2565B0;    --ds-info-bg:rgba(46,127,214,.10);
  --sh-1:0 1px 2px rgba(15,18,25,.06);
  --sh-2:0 6px 16px rgba(15,18,25,.10),0 2px 4px rgba(15,18,25,.06);
  --sh-3:0 24px 48px rgba(15,18,25,.16),0 8px 16px rgba(15,18,25,.08);
}
```

### Типографика — правила
- Одно семейство `var(--font)`; удалить 393 локальных `font-family`, Bebas/PT Sans/Montserrat/Georgia.
- `--mono` — **только** `.num` на KPI и числовых столбцах. Не в датах, не в лентах.
- Шкала: 11 (label/badge) · 12 (caption, th) · 13 (body-sm, td, кнопки) · 14 (body, input) · 16 (h3) · 20 (h2) · 24 (h1) · 32 (KPI). Ниже 11px — запрещено. Дробные → ближайшее целое.
- Веса 400/500/600/700. line-height 1.2 / 1.35 / 1.5. Uppercase — только `.ds-label` (11/600, text-soft, +.04em).

### Компоненты
| Компонент | Спецификация |
|---|---|
| **Button** `.btn` | h36 (`.btn-sm` h28), padding 0 14, r control, 13/600, svg 16. `primary` accent/#FFF · `secondary` surface-2 + border · `ghost` прозрачная, text-2 · `danger` danger-bg + danger-text. Focus `--focus-ring`, disabled opacity .45 |
| **Input/Select/Textarea** `.field` | h36, surface-2, border, r control, 14/400; placeholder text-faint; focus accent + ring; label над: 12/500 text-2 |
| **Filter chip** `.chip` | h28, r pill, 12/600, surface-2 + border, text-2; `.on` accent-bg + accent-text. Segmented — те же chip в контейнере surface-3 |
| **Badge** `.badge` | h20, r 6, 11/600, без uppercase; success/warning/danger/info/neutral = `--ds-*-bg` + `--ds-*-text` |
| **Table** `.tbl` | th h36 12/500 text-soft sticky; td 10×12 → строка 40px, 13/400; `.num` right tabular; hover surface-2; `.tbl-dense` td 6×12 |
| **Card** `.card` | surface, border-faint, r card, padding 16; тень sh-1 только dark; без цветных полос/тонировок |
| **Modal** | overlay; surface, border-strong, r modal, sh-3, padding 24, w 480; заголовок 18/600 |
| **Drawer** | right 480 (mobile 100%), surface, border-left, sh-3, шапка h56 |
| **Toast** | один `#sd-toast`: surface-2, border, r card, sh-2, 13/500, svg 16; `.notification` (L3661) удалить |
| **Skeleton** | `.skel` surface-2 → shimmer surface-3 1.2s; h 12/16/40 |
| **Empty state** | один `.ds-empty`: padding 48 20, svg 32 text-faint, 14/600 text-2 + 13 text-soft |
| **Tooltip** | surface-3, border, r control, 12/500, sh-2, max-w 260 |

### Иконки
Inline SVG `currentColor`, спрайт `<symbol>` в начале body: навигация 20px stroke 1.5, контролы 16px stroke 1.75. Заменить: `→` → arrow-right, `×` → x, `▾▴` → chevron, `‹›` → chevron, `↻` → refresh, `✓` → check, `⋯` → more. `•` как разделитель — оставить.

---

## C. План миграции (без «большого взрыва»)

| Шаг | Что | Объём | Риск |
|---|---|---|---|
| **1. Токены + алиасы** | Вставить DS-FINAL после L5057. Ничего не удалять | ~130 строк | низкий; визуально меняются text-faint, light surface-2, info, радиусы через `var()` (27 мест) |
| **2a. CSS: цвета** | `#4CB782`→`--ds-success` ×107, `#5E6AD2`→`--accent` ×88, `#828FF7`→`--accent-hover` ×64, `#E5604D`→`--ds-danger` ×58, `#E0A458`→`--ds-warning` ×45; light-текст hex ×240 → `--text*`; `rgba(255,255,255,.05–.10)` ×180 → `--border*` | ≈900 | низкий-средний |
| **2b. CSS: радиусы** | 6/7/9/10 → control (≈250); 11/13/14 → card (≈65); 16–24 → modal/pill (≈60); 2–5 → `--r-xs:4px` (≈130) | ≈500 | средний |
| **2c. CSS: шрифты** | −393 `font-family`; чужие семейства (15); дробные → шкала (≈250); <11 → 11 (≈190); 650/800/900 → 600/700 (≈78); капс-лейблы → `.ds-label` (≈150) | ≈1100 | средний: 10→11px раздует плотные таблицы |
| **2d. CSS: тени** | 184 → sh-1/2/3 + focus-ring | ≈260 | низкий |
| **3. JS-строки** | топ-5 hex → `var()` (481); цветовые словари (L12856, L21976, L36334, L40707…) → один `SD.C` через `getComputedStyle`; SVG stroke → `var()`; inline `style=` радиусы/шрифты | ≈2500 | средний-высокий: canvas не читает `var()` |
| **4. Компоненты по разделам** | Клиенты/карточка (≈180) → Задачи (≈220) → Дашборд (≈120) → Финансы (≈90) → Маркетинг (≈60) → Настройки (≈110) | | по разделу на релиз, скриншоты в обеих темах |
| **5. Sweep** | Удалить :root L379/405/480/893/1729/4970, алиасы, `!important`-слои | −2000 строк | высокий; после недели без регрессий |

## D. Топ-10 быстрых побед
1. Вставить блок DS-FINAL — один коммит, всё приложение.
2. Топ-5 hex → токены в CSS и JS (~890 мест, sed).
3. PT Sans + navy у «Мои задачи»/CRM-форм (4 строки) → `--font` + `--surface`.
4. Карточка задачи `.tcard-wrap` / `.tc-send` (≈25 строк) → surface/border/accent.
5. `--amocard-*` → алиасы (28 строк): карточка клиента в общей палитре без правки 160 мест.
6. Радиусы `--r-sm/md/lg` = 8/12/16 и sed 10→8, 14→12, 18→16 (≈170).
7. Один тост: удалить `.notification`, `showNotif` → `sdToast`.
8. Снять цветные полосы над колонками Маршрута (L5309) и тонировки KPI.
9. `font-size <11px` → 11 и дробные → целые (≈440, sed).
10. Глифы в кнопках → SVG-спрайт (≈110); заголовок топбара на Маркетинге.

## E. Связь с планом «Действующие клиенты»
Шаги 1 и 5 из D (токены + алиасы `--amocard-*`) выполняются **до** этапа 4 «Фронт: карточка» из `2026-09-13-active-clients-lifecycle-design.md` — тогда карточка клиента сразу делается на единых токенах. Остальное — отдельная дорожка, по одному разделу на релиз.
