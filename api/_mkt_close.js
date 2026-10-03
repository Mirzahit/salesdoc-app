import './_preview_guard.js'; // v1017: в превью-сборке запись наружу отключена (см. файл)
// v1019: закрытие месяца Маркетинга — цифры месяца замораживаются в public.mkt_month_close.
//
// Решения CEO (03.10.2026):
//   • 5-го числа в 07:30 по Бишкеку крон закрывает прошлый месяц (SD, Z24, Штурм, Все); не вышло —
//     пробует каждый час. Закрываем только без дыр: ошибка amo/Meta или неполные данные → 'failed'.
//   • закрытую строку крон больше не трогает; пересчитать может только администратор (с причиной,
//     в mkt_month_close_history остаётся «было → стало»).
//   • курс доллара — по каждому дню: НБКР за день (daily), архив НБКР (archive), иначе курс из
//     Настроек (settings). Архив дописывается только с разрешения CEO (app_settings.mkt_fx_archive_ok).
// Здесь чистые функции (их проверяет scripts/mkt-selftest.mjs) и дозапись курсов из архива НБКР.

import { sbUpsert, sbSelect } from './_supabase.js';
import { addDaysIso, dayStartMs, dayEndMs } from './_dates.js';
import { fxRateFor } from './_finansist_core.js';
import { campaignDecision } from './_mkt.js';

export const CLOSE_PRODUCTS = ['SD', 'Z24', 'SHTURM', 'ALL'];
export const CRM_PRODUCTS = ['SD', 'ALL']; // у Zakaz24 и Штурма CRM не подключена
export const FX_ARCHIVE_SRC = 'nbkr_archive';
export const RECALC_REASON_MIN = 5;
const r2 = (x) => Math.round(x * 100) / 100;

// ── Месяц ───────────────────────────────────────────────────────────────────
export function monthInfo(month, country) {
  const m = String(month || '').match(/^(\d{4})-(\d{2})$/);
  if (!m || +m[2] < 1 || +m[2] > 12) return null;
  const first = m[1] + '-' + m[2] + '-01';
  const nextFirst = (+m[2] === 12 ? (+m[1] + 1) + '-01' : m[1] + '-' + String(+m[2] + 1).padStart(2, '0')) + '-01';
  const until = addDaysIso(nextFirst, -1);
  const days = [];
  for (let d = first; d <= until; d = addDaysIso(d, 1)) days.push(d);
  const c = country || 'KG';
  return { month: m[1] + '-' + m[2], first, since: first, until, days,
    fromTs: Math.floor(dayStartMs(first, c) / 1000), toTs: Math.floor(dayEndMs(until, c) / 1000) - 1 };
}
export function prevMonthOf(todayIso) {
  const y = +String(todayIso).slice(0, 4), mo = +String(todayIso).slice(5, 7);
  return mo === 1 ? (y - 1) + '-12' : y + '-' + String(mo - 1).padStart(2, '0');
}
// Пора ли закрывать прошлый месяц: 5-го с 07:00 по Бишкеку и позже (повторы каждый час, пока не закрыт).
export function closeDue(bishkekDay, bishkekHour) { return bishkekDay > 5 || (bishkekDay === 5 && bishkekHour >= 7); }

// ── Курс доллара по дням ────────────────────────────────────────────────────
// rates — app_settings.finansist_fx_rates. Каждый день месяца: курс НБКР (за день или ближайший
// опубликованный, не старше 5 дней); src 'nbkr_archive' → архив, иначе «по дням»; нет курса →
// курс из Настроек (день считается settings); нет и его → день в missing.
export function fxForDays(rates, days, settingsRate) {
  const fb = Number(settingsRate) > 0 ? Number(settingsRate) : null;
  const by_day = {}, missing = [];
  let daily = 0, archive = 0, settings = 0, sum = 0, n = 0;
  (days || []).forEach(d => {
    const r = fxRateFor(rates, d, 'USD');
    if (r) {
      const dayObj = rates && rates[r.date];
      const kind = usdSrcOf(dayObj) === FX_ARCHIVE_SRC ? 'archive' : 'daily';
      by_day[d] = { rate: r.rate, kind, from: r.date };
      if (kind === 'archive') archive++; else daily++;
    } else if (fb) { by_day[d] = { rate: fb, kind: 'settings', from: null }; settings++; }
    else { missing.push(d); return; }
    sum += by_day[d].rate; n++;
  });
  return { by_day, missing, days_daily: daily, days_archive: archive, days_settings: settings,
    avg: n ? sum / n : null, source: fxSourceOf({ daily, archive, settings }) };
}
// Один источник на месяц: все дни из одного места — его имя, иначе 'mixed'.
export function fxSourceOf(c) {
  const kinds = ['daily', 'archive', 'settings'].filter(k => Number(c && c[k]) > 0);
  if (!kinds.length) return null;
  return kinds.length === 1 ? kinds[0] : 'mixed';
}

// ── Архив НБКР ──────────────────────────────────────────────────────────────
// Страница nbkr.kg index1.jsp?item=1562: строки <!--date-->DD.MM.YYYY<!--date--> … <!--value-->87,4483<!--value-->.
export function parseNbkrArchive(html) {
  const out = {};
  const re = /<!--date-->\s*(\d{2})\.(\d{2})\.(\d{4})\s*<!--date-->[\s\S]*?<!--value-->\s*([\d\s.,]+?)\s*<!--value-->/g;
  let m;
  while ((m = re.exec(String(html || '')))) {
    const v = parseFloat(m[4].replace(/\s/g, '').replace(',', '.'));
    if (Number.isFinite(v) && v > 0) out[m[3] + '-' + m[2] + '-' + m[1]] = v;
  }
  return out;
}
export function nbkrArchiveUrl(fromIso, toIso, valutaId) {
  const [fy, fm, fd] = String(fromIso).split('-'), [ty, tm, td] = String(toIso).split('-');
  return `https://www.nbkr.kg/index1.jsp?item=1562&lang=RUS&valuta_id=${valutaId || 15}&beg_day=${fd}&beg_month=${fm}&beg_year=${fy}&end_day=${td}&end_month=${tm}&end_year=${ty}`;
}
// Что дописать: только дни, где доллара ещё нет; существующие значения не трогаем.
export function planFxFill(rates, archive, fromIso, toIso) {
  const filled = [], skipped = [];
  for (let d = fromIso; d <= toIso; d = addDaysIso(d, 1)) {
    const has = rates && rates[d] && Number(rates[d].USD) > 0;
    if (has) { skipped.push(d); continue; }
    if (archive[d] > 0) filled.push(d); else skipped.push(d);
  }
  return { filled, skipped };
}
const FX_VALUTA = { USD: 15 };
// v1019 (QA): источник доллара дня — своё поле USD_src (день мог прийти из ежедневного курса по тенге,
// а доллар дописан из архива), иначе общий src дня.
export function usdSrcOf(day) { return (day && (day.USD_src || day.src)) || null; }
// Курсы читаем напрямую: ошибка чтения — исключение (а не пустой объект, который при записи стёр бы всё).
export async function readFxRatesStrict() {
  const r = await sbSelect('app_settings', { key: 'eq.finansist_fx_rates', limit: '1' });
  const v = (r[0] && r[0].value) || {};
  if (typeof v !== 'object' || Array.isArray(v)) throw new Error('finansist_fx_rates: неожиданный формат');
  return v;
}
// Слияние: из архива добавляются только дни/поля без доллара; ни один ключ не пропадает.
export function mergeArchiveRates(fresh, archiveUsd, days, nowIso) {
  const out = Object.assign({}, fresh);
  const added = [];
  days.forEach(d => {
    const cur = out[d];
    if (cur && Number(cur.USD) > 0) return;
    if (!(archiveUsd[d] > 0)) return;
    out[d] = cur ? Object.assign({}, cur, { USD: archiveUsd[d], USD_src: FX_ARCHIVE_SRC })
      : { USD: archiveUsd[d], USD_src: FX_ARCHIVE_SRC, src: FX_ARCHIVE_SRC, by: 'архив Нацбанка', at: nowIso };
    added.push(d);
  });
  return { rates: out, added };
}
// Дозапись курсов из архива НБКР в app_settings.finansist_fx_rates (src 'nbkr_archive').
// opts: { currencies: ['USD'], dryRun, fetchImpl }. Возвращает { filled:[даты], skipped:[даты], errors }.
export async function fillFxFromArchive(fromIso, toIso, opts) {
  const o = opts || {};
  const cur = (o.currencies && o.currencies.length ? o.currencies : ['USD']).filter(c => FX_VALUTA[c]);
  const errors = [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(fromIso)) || !/^\d{4}-\d{2}-\d{2}$/.test(String(toIso)) || toIso < fromIso) return { filled: [], skipped: [], errors: ['неверный период'] };
  const f = o.fetchImpl || fetch;
  const archive = {};
  for (const c of cur) {
    try {
      const r = await f(nbkrArchiveUrl(fromIso, toIso, FX_VALUTA[c]), { signal: AbortSignal.timeout(20000), headers: { 'User-Agent': 'Mozilla/5.0 SalesDoc' } });
      if (!r.ok) throw new Error('НБКР ' + r.status);
      const html = Buffer.from(await r.arrayBuffer()).toString('latin1'); // windows-1251, нужны только цифры
      archive[c] = parseNbkrArchive(html);
      if (!Object.keys(archive[c]).length) errors.push('архив НБКР: курсов ' + c + ' не нашли');
    } catch (e) { errors.push('архив НБКР ' + c + ': ' + String(e.message || e).slice(0, 120)); archive[c] = {}; }
  }
  const rates = await readFxRatesStrict(); // ошибка чтения — исключение, ничего не пишем
  const plan = planFxFill(rates, archive.USD || {}, fromIso, toIso);
  if (o.dryRun || !plan.filled.length) return Object.assign(plan, { errors, rates_preview: plan.filled.slice(0, 40).map(d => ({ date: d, USD: archive.USD[d] })) });
  // перечитываем прямо перед записью и сливаем только недостающее (ночной крон Финансиста мог записать день)
  const fresh = await readFxRatesStrict();
  if (Object.keys(fresh).length < Object.keys(rates).length) throw new Error('курсы за это время уменьшились — запись отменена');
  const now = new Date().toISOString();
  const m = mergeArchiveRates(fresh, archive.USD || {}, plan.filled, now);
  if (Object.keys(m.rates).length < Object.keys(fresh).length) throw new Error('слияние потеряло дни — запись отменена');
  if (m.added.length) await sbUpsert('app_settings', { key: 'finansist_fx_rates', value: m.rates, updated_at: now }, 'key');
  return { filled: m.added, skipped: plan.skipped.concat(plan.filled.filter(d => !m.added.includes(d))), errors };
}

// ── Строка закрытого месяца ─────────────────────────────────────────────────
const isAd = (l) => l.arrival_kind === 'ad' || l.arrival_kind === 'return';
function stageOk(st) { return st && st.sort != null; }
// input: { product, month (monthInfo), meta:{geo,daily,camps}, rp (lead_report v2), recon (mkt_recon), work (mkt_work), fx (fxForDays), hidden }
// Возвращает { row, holes:[причины] } — row без служебных полей статуса.
export function buildCloseRow(input) {
  const { product, month, meta, rp, recon, work, fx } = input;
  const hidden = input.hidden || { KZ: 1 };
  const holes = [];
  const crmOn = CRM_PRODUCTS.includes(product);
  const sum = (list, f) => list.reduce((a, x) => a + (Number(f(x)) || 0), 0);
  // реклама (доллары) — страны аудитории без скрытых (KZ)
  const geo = (meta && meta.geo) || {};
  const vis = (geo.countries || []).filter(c => !hidden[c.code]);
  const adUsd = sum(vis, c => c.spend);
  const lc = sum(vis, c => c.link_clicks), cl = sum(vis, c => c.clicks);
  const metaInfo = { impressions: sum(vis, c => c.impressions), clicks: lc > 0 ? lc : cl,
    meta_leads: sum(vis, c => c.leads) + sum(geo.accounts || [], a => a.msgs) };
  // расход в сомах — каждый день по курсу своего дня
  let spendSom = null;
  const rateOf = (d) => fx && fx.by_day[d] ? fx.by_day[d].rate : null;
  const days = (meta && meta.daily && Array.isArray(meta.daily.days)) ? meta.daily.days : null;
  if (days && days.length) {
    let s = 0, usd = 0, miss = 0;
    days.forEach(day => Object.keys(day.by_country || {}).forEach(cc => {
      if (hidden[cc]) return;
      const v = Number(day.by_country[cc].spend) || 0; if (!v) return;
      const rt = rateOf(day.date);
      if (!rt) { miss++; return; }
      s += v * rt; usd += v;
    }));
    if (miss) holes.push('нет курса доллара за ' + miss + ' дн. с расходом');
    else spendSom = usd > 0 ? s * (adUsd / usd) : (adUsd > 0 ? adUsd * (fx && fx.avg || 0) : 0);
  } else if (adUsd > 0) {
    if (fx && fx.avg) spendSom = adUsd * fx.avg; else holes.push('нет курса доллара');
  } else spendSom = 0;
  if (fx && fx.missing && fx.missing.length && adUsd > 0 && !holes.some(h => /курса/.test(h))) holes.push('нет курса доллара за ' + fx.missing.length + ' дн.');
  const fxAvg = spendSom != null && adUsd > 0 ? spendSom / adUsd : (fx && fx.avg) || null;

  // сделки amo (только SalesDoc и «Все»)
  const leadsAll = crmOn && rp ? (rp.leads || []).filter(l => product === 'ALL' || (l.product || 'SD') === product) : [];
  const leadsAd = leadsAll.filter(isAd);
  const qs = rp && stageOk(rp.qual_stage) ? rp.qual_stage : null;
  const ms = rp && stageOk(rp.meet_stage) ? rp.meet_stage : null;
  const isQ = (l) => !!qs && (l.is_won || (l.reached_sort != null && l.reached_sort >= Number(qs.sort)));
  const isM = (l) => !!ms && (l.is_won || (l.reached_sort != null && l.reached_sort >= Number(ms.sort)));
  if (crmOn && rp && !qs) holes.push('в воронке нет этапа «Квалификация пройдена»');
  const qualAd = leadsAd.filter(isQ), qualAll = leadsAll.filter(isQ);
  const wonAd = leadsAd.filter(l => l.is_won);
  const srcCount = (list) => { const o = { form: 0, chat: 0, call: 0, manual: 0 }; list.forEach(l => { if (o[l.source_type] != null) o[l.source_type]++; }); return o; };
  const flow = rp ? (rp.stages || []).slice().sort((a, b) => a.sort - b.sort) : [];
  const funnel = (list) => ({
    stages: flow.map((st, i) => ({ id: st.id, name: st.name, sort: st.sort,
      qual: !!(qs && String(qs.id) === String(st.id)), // v1019 (QA): этап квала подсвечивается в закрытой воронке
      n: i === 0 ? list.length : list.filter(l => l.is_won || (l.reached_sort != null && l.reached_sort >= st.sort)).length })),
    won: list.filter(l => l.is_won).length, postponed: list.filter(l => l.is_postponed).length, lost: list.filter(l => l.is_lost).length
  });
  const wl = (work && work.leads) || {};
  const wOf = (l) => wl[l.id] || wl[String(l.id)] || null;
  const untaken = (list) => list.filter(l => { const w = wOf(l); return w && !w.taken_at; });
  const managers = (list) => {
    const un = new Set(untaken(list).map(l => l.id));
    const by = {};
    list.forEach(l => {
      if (un.has(l.id)) return;
      const k = l.manager && l.manager !== '—' ? l.manager : '';
      if (!k) return;
      const x = by[k] || (by[k] = { name: k, n: 0, qual: 0, meet: 0, won: 0, avg_reaction_wmin: null });
      x.n++; if (isQ(l)) x.qual++; if (isM(l)) x.meet++; if (l.is_won) x.won++;
    });
    ((work && work.managers) || []).forEach(m => { if (m && by[m.name]) by[m.name].avg_reaction_wmin = m.avg_reaction_wmin; });
    return Object.values(by).sort((a, b) => b.n - a.n);
  };
  const loss = (list) => {
    const by = {}; let none = 0;
    list.filter(l => l.is_lost).forEach(l => { const k = String(l.loss_reason || '').trim(); if (k) by[k] = (by[k] || 0) + 1; else none++; });
    const rows = Object.keys(by).map(k => ({ reason: k, n: by[k] })).sort((a, b) => b.n - a.n);
    if (none) rows.push({ reason: 'Причина не указана', n: none });
    return rows;
  };
  const notTaken = (list) => {
    const un = untaken(list);
    const taken = list.map(wOf).filter(w => w && w.taken_at && w.reaction_wmin != null);
    const tones = { ok: 0, mid: 0, bad: 0 };
    taken.forEach(w => { if (tones[w.tone] != null) tones[w.tone]++; });
    return { untaken: un.length, late: un.filter(l => (wOf(l).wait_wmin || 0) > 60).length, taken: taken.length,
      avg_reaction_wmin: taken.length ? Math.round(taken.reduce((a, w) => a + w.reaction_wmin, 0) / taken.length) : null, tones };
  };
  // кампании: открут в сомах по курсу месяца, сделки — по кампании рекламного касания
  const rate = fxAvg || 0;
  const byCamp = {};
  if (crmOn) leadsAll.forEach(l => {
    const id = l.touch && l.touch.campaign_id; if (!id) return;
    const x = byCamp[id] || (byCamp[id] = { leads: 0, qual: 0, won: 0 });
    x.leads++; if (isQ(l)) x.qual++; if (l.is_won) x.won++;
  });
  const campaigns = (((meta && meta.camps) || {}).campaigns || []).map(c => {
    let usd = 0;
    if (c.by_country) Object.keys(c.by_country).forEach(cc => { if (!hidden[cc]) usd += Number(c.by_country[cc].spend) || 0; });
    else usd = Number(c.spend) || 0;
    const crm = byCamp[c.id] || null;
    const som = spendSom != null && rate ? usd * rate : null;
    const leads = crmOn ? (crm ? crm.leads : 0) : (Number(c.leads) || 0) + (Number(c.msgs) || 0);
    const qual = crmOn ? (crm ? crm.qual : 0) : null, won = crmOn ? (crm ? crm.won : 0) : null;
    const cpq = som != null && qual ? som / qual : null;
    return { id: c.id, name: c.name || '(без названия)', account: c.account || null, usd: r2(usd), som: som != null ? Math.round(som) : null,
      leads, cpl: som != null && leads ? Math.round(som / leads) : null, qual, cpq: cpq != null ? Math.round(cpq) : null, won,
      decision: crmOn && som != null ? campaignDecision(cpq, qual).label : null };
  }).filter(x => x.usd > 0 || x.leads > 0).sort((a, b) => b.usd - a.usd);

  const rc = (recon && recon.recon) || null;
  const cpl = crmOn && spendSom != null && leadsAd.length ? spendSom / leadsAd.length : null;
  const cpq = crmOn && spendSom != null && qualAd.length ? spendSom / qualAd.length : null;
  const row = {
    spend_usd: r2(adUsd), spend_som: spendSom != null ? Math.round(spendSom) : null, fx_avg: fxAvg != null ? Math.round(fxAvg * 10000) / 10000 : null,
    fx_source: fx ? fx.source : null, fx_days_daily: fx ? fx.days_daily : 0, fx_days_archive: fx ? fx.days_archive : 0, fx_days_settings: fx ? fx.days_settings : 0,
    leads_ad: crmOn ? leadsAd.length : null, leads_all: crmOn ? leadsAll.length : null,
    quals_ad: crmOn ? qualAd.length : null, quals_all: crmOn ? qualAll.length : null, won_ad: crmOn ? wonAd.length : null,
    cpl_som: cpl != null ? Math.round(cpl) : null, cpq_som: cpq != null ? Math.round(cpq) : null,
    meta_form_leads: rc ? Number(rc.meta_total) || 0 : null, lost: rc && rc.lost ? Number(rc.lost.total) || 0 : null,
    lead_ids_ad: crmOn ? leadsAd.map(l => Number(l.id)) : null, lead_ids_qual: crmOn ? qualAd.map(l => Number(l.id)) : null,
    details: {
      month_rule: 'created', qual_stage: qs ? { id: qs.id, name: qs.name, sort: qs.sort } : null,
      meta: metaInfo,
      sources: crmOn ? srcCount(leadsAll) : null, sources_ad: crmOn ? srcCount(leadsAd) : null,
      funnel: crmOn ? { ad: funnel(leadsAd), all: funnel(leadsAll) } : null,
      managers: crmOn ? { ad: managers(leadsAd), all: managers(leadsAll) } : null,
      loss_reasons: crmOn ? { ad: loss(leadsAd), all: loss(leadsAll) } : null,
      not_taken: crmOn && work ? { ad: notTaken(leadsAd), all: notTaken(leadsAll) } : null,
      campaigns,
      recon: rc,
      fx: fx ? { source: fx.source, days_daily: fx.days_daily, days_archive: fx.days_archive, days_settings: fx.days_settings, missing: fx.missing } : null
    }
  };
  return { row, holes };
}

// v1019 (QA): крон повторяет неудачные продукты, но не больше 48 попыток на продукт (дальше — пересчёт администратором).
export const CLOSE_MAX_ATTEMPTS = 48;
export function needsClose(row) {
  if (!row) return true;
  if (row.status === 'closed') return false;
  return (Number(row.attempts) || 0) < CLOSE_MAX_ATTEMPTS;
}
// ── Запись ──────────────────────────────────────────────────────────────────
// Что делать с закрытием одного продукта. existing — строка из базы или null.
// outcome: { ok:true, row } или { ok:false, error }. Закрытую строку не трогаем никогда.
const NUM_FIELDS = ['spend_usd', 'spend_som', 'fx_avg', 'fx_source', 'fx_days_daily', 'fx_days_archive', 'fx_days_settings', 'leads_ad', 'leads_all',
  'quals_ad', 'quals_all', 'won_ad', 'cpl_som', 'cpq_som', 'meta_form_leads', 'lost', 'details', 'lead_ids_ad', 'lead_ids_qual'];
export function decideCloseWrite(existing, outcome, key, nowIso) {
  if (existing && existing.status === 'closed') return { action: 'skip' };
  const base = Object.assign({}, key, { attempts: (Number(existing && existing.attempts) || 0) + 1, last_attempt_at: nowIso });
  if (outcome && outcome.ok) {
    return { action: 'upsert', row: Object.assign(base, pickNums(outcome.row), { status: 'closed', last_error: null,
      closed_at: nowIso, closed_by: outcome.by || 'cron' }) };
  }
  const empty = {}; NUM_FIELDS.forEach(f => { empty[f] = null; });
  return { action: 'upsert', row: Object.assign(base, empty, { status: 'failed', last_error: shortErr(outcome && outcome.error) }) };
}
function pickNums(r) { const o = {}; NUM_FIELDS.forEach(f => { o[f] = r && r[f] !== undefined ? r[f] : null; }); return o; }
export function shortErr(e) {
  return String((e && e.message) || e || 'неизвестная ошибка').split(/Failing row/i)[0].replace(/\d{9,}/g, '#').slice(0, 200);
}
// Пересчёт администратором: строка истории (было → стало) и обновление.
// Закрытая строка сохраняет closed_at/closed_by; неудачная (failed) закрывается руками — closed_by = email.
export function buildRecalc(existing, freshRow, who, reason, key, nowIso) {
  const why = String(reason || '').trim();
  if (why.length < RECALC_REASON_MIN) return { error: 'Причина — не короче ' + RECALC_REASON_MIN + ' знаков' };
  const wasClosed = !!(existing && existing.status === 'closed');
  const upd = Object.assign({}, key, pickNums(freshRow), {
    status: 'closed', last_error: null,
    closed_at: wasClosed ? existing.closed_at : nowIso,
    closed_by: wasClosed ? existing.closed_by : who,
    attempts: Number(existing && existing.attempts) || 0,
    last_attempt_at: existing ? existing.last_attempt_at || null : null,
    recalc_count: (Number(existing && existing.recalc_count) || 0) + (wasClosed ? 1 : 0),
    recalculated_at: wasClosed ? nowIso : (existing && existing.recalculated_at) || null
  });
  const history = Object.assign({}, key, { changed_at: nowIso, changed_by: who, reason: why.slice(0, 500),
    old_row: existing ? slimRow(existing) : null, new_row: slimRow(upd) });
  return { update: upd, history };
}
// Кто может пересчитать: только администратор с подписанной сессией (общий ключ и заголовок с email — нет).
export function recalcAccess(caller) {
  if (!caller) return 'need_login';
  if (!caller.trusted) return 'need_login';
  if (caller.active === false || String(caller.role || '').toLowerCase() !== 'admin') return 'forbidden';
  return 'ok';
}
// В историю — без длинных списков номеров сделок.
export function slimRow(r) { const o = Object.assign({}, r); delete o.lead_ids_ad; delete o.lead_ids_qual; return o; }
// Изменения после закрытия: сколько номеров сделок прибавилось / ушло.
export function idsDelta(closedIds, liveIds) {
  const a = new Set((closedIds || []).map(Number)), b = new Set((liveIds || []).map(Number));
  let added = 0, removed = 0;
  b.forEach(x => { if (!a.has(x)) added++; });
  a.forEach(x => { if (!b.has(x)) removed++; });
  return { added, removed };
}
// Живые номера сделок продукта (из рекламы и квалы из рекламы) — тем же правилом, что в закрытии.
export function liveIdsOf(rp, product) {
  if (!rp || !CRM_PRODUCTS.includes(product)) return null;
  const qs = stageOk(rp.qual_stage) ? rp.qual_stage : null;
  const ad = (rp.leads || []).filter(l => (product === 'ALL' || (l.product || 'SD') === product) && isAd(l));
  return { ad: ad.map(l => Number(l.id)), qual: ad.filter(l => qs && (l.is_won || (l.reached_sort != null && l.reached_sort >= Number(qs.sort)))).map(l => Number(l.id)) };
}
