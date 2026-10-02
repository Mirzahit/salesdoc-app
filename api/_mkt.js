import './_preview_guard.js'; // v1017: в превью-сборке запись наружу отключена (см. файл)
// v1015: общие правила экрана «Маркетинг» — продукт, этапы воронки, дата обращения,
// ошибки источников и перевод рекламных часов в бишкекские дни.
// Здесь только чистые функции (без сети), кроме loadProducts — их проверяет
// scripts/mkt-selftest.mjs. Решения CEO — в docs/superpowers/specs (Stage A маркетинга).

import { sbSelect } from './_supabase.js';
import { localIso, zonedToUtcMs, addDaysIso } from './_dates.js';

// ── Продукты ────────────────────────────────────────────────────────────────
// Продукт кампании узнаём по началу названия: SD_KG_LF_IH_2026-09 → SalesDoc.
// Старые кампании без схемы названий — по списку номеров из настроек (mkt_products).
// Cliq — это SalesDoc, отдельного продукта нет.
export const PRODUCT_CODES = ['SD', 'Z24', 'SHTURM'];
export const DEFAULT_PRODUCTS = {
  version: 1, default: 'SD',
  products: [
    // v1017: кампании и формы SalesDoc, названные не по схеме SD_… (выгрузка 01.10.2026). Cliq — это SalesDoc.
    { code: 'SD', name: 'SalesDoc', prefixes: ['SD'],
      campaign_ids: ['52537154151252', '52537159060852', '52534294129852', '6986710298448', '120250929785560444', '120251110515330444', '120250929937200444', '120250909391990444'],
      form_ids: ['1056856707121847', '1107958975222847', '1690320792809154', '1619183776219131', '28209238382066599', '825357413900105'] },
    { code: 'Z24', name: 'Zakaz24', prefixes: ['Z24'], campaign_ids: ['120251108502780444'], form_ids: ['1640508510930310'] },
    { code: 'SHTURM', name: 'Штурм', prefixes: ['SHTURM'], campaign_ids: ['120251202836020444'], form_ids: ['1775408007121079', '1138537525515939'] }
  ]
};

// Проверка настройки перед записью. Возвращает {ok, value} или {ok:false, error}.
export function validateProducts(v) {
  if (!v || typeof v !== 'object' || !Array.isArray(v.products)) return { ok: false, error: 'products должен быть списком' };
  const seen = new Set();
  const products = [];
  for (const p of v.products) {
    if (!p || typeof p !== 'object') return { ok: false, error: 'неверная запись продукта' };
    const code = String(p.code || '').toUpperCase();
    if (!PRODUCT_CODES.includes(code)) return { ok: false, error: 'code должен быть одним из: ' + PRODUCT_CODES.join(', ') };
    if (seen.has(code)) return { ok: false, error: 'продукт ' + code + ' указан дважды' };
    seen.add(code);
    const ids = (arr, what) => {
      if (arr == null) return [];
      if (!Array.isArray(arr)) throw new Error(what + ' должен быть списком');
      return arr.map(x => String(x).trim()).filter(Boolean).map(x => {
        if (!/^\d{5,25}$/.test(x)) throw new Error(what + ': «' + x.slice(0, 30) + '» — только цифры');
        return x;
      });
    };
    let campaign_ids, form_ids, prefixes;
    try {
      campaign_ids = ids(p.campaign_ids, 'campaign_ids');
      form_ids = ids(p.form_ids, 'form_ids');
      prefixes = (Array.isArray(p.prefixes) ? p.prefixes : []).map(x => String(x).trim().toUpperCase()).filter(Boolean);
    } catch (e) { return { ok: false, error: e.message }; }
    if (prefixes.some(x => !/^[A-Z0-9]{1,20}$/.test(x))) return { ok: false, error: 'prefixes — только латинские буквы и цифры' };
    products.push({ code, name: String(p.name || code).slice(0, 60), prefixes, campaign_ids: [...new Set(campaign_ids)], form_ids: [...new Set(form_ids)] });
  }
  const def = String(v.default || 'SD').toUpperCase();
  return { ok: true, value: { version: 1, default: PRODUCT_CODES.includes(def) ? def : 'SD', products } };
}
// Битая настройка не должна ронять экран — тогда работаем по умолчанию.
export function normalizeProducts(v) {
  const r = validateProducts(v);
  return r.ok && r.value.products.length ? r.value : DEFAULT_PRODUCTS;
}
let _prodCache = null;
export async function loadProducts() {
  if (_prodCache && Date.now() - _prodCache.t < 60 * 1000) return _prodCache.v;
  let v = DEFAULT_PRODUCTS;
  try {
    const rows = await sbSelect('app_settings', { key: 'eq.mkt_products', limit: '1' });
    if (rows.length && rows[0].value) v = normalizeProducts(rows[0].value);
  } catch (_) { v = DEFAULT_PRODUCTS; }
  _prodCache = { t: Date.now(), v };
  return v;
}
function _prefixMatch(cfg, name) {
  const list = [];
  (cfg.products || []).forEach(p => (p.prefixes || []).forEach(x => list.push({ x: String(x).toUpperCase(), code: p.code })));
  list.sort((a, b) => b.x.length - a.x.length); // длинные первыми: SHTURM раньше SD
  const n = String(name || '').trim();
  for (const it of list) {
    const esc = it.x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp('^' + esc + '([_\\s-]|$)', 'i').test(n)) return it.code;
  }
  return null;
}
export function classifyCampaign(cfg, c) {
  cfg = cfg || DEFAULT_PRODUCTS;
  const byName = _prefixMatch(cfg, c && c.name);
  if (byName) return byName;
  const id = c && c.id != null ? String(c.id) : '';
  if (id) for (const p of cfg.products || []) if ((p.campaign_ids || []).includes(id)) return p.code;
  return cfg.default || 'SD';
}
function _formProduct(cfg, formId, adsByForm) {
  const fid = formId != null ? String(formId) : '';
  if (!fid) return null;
  for (const p of cfg.products || []) if ((p.form_ids || []).includes(fid)) return p.code;
  const a = adsByForm && adsByForm[fid];
  const ad = Array.isArray(a) ? a[0] : a;
  if (ad && (ad.campaign_id || ad.campaign || ad.campaign_name)) {
    return classifyCampaign(cfg, { id: ad.campaign_id, name: ad.campaign || ad.campaign_name });
  }
  return null;
}
// v1017: продукт заявки лидформы — СТРОГО, без «по умолчанию». Порядок: начало названия
// кампании → номер кампании из настроек → номер формы из настроек → null («продукт не распознан»).
// Решение CEO: нераспознанную заявку не приписываем SalesDoc молча, её видно отдельно.
export function classifyMetaLead(cfg, lead) {
  cfg = cfg || DEFAULT_PRODUCTS;
  const l = lead || {};
  const byName = _prefixMatch(cfg, l.campaign_name);
  if (byName) return byName;
  const cid = l.campaign_id != null ? String(l.campaign_id) : '';
  if (cid) for (const p of cfg.products || []) if ((p.campaign_ids || []).includes(cid)) return p.code;
  const fid = l.form_id != null ? String(l.form_id) : '';
  if (fid) for (const p of cfg.products || []) if ((p.form_ids || []).includes(fid)) return p.code;
  return null;
}
// v1017: цена квала → оттенок и решение по кампании (пока нет оплат — решаем по цене квала).
// До 10 000 сом — норма, 10–15 тыс. — оптимизировать, от 15 000 — красная зона.
export const CPQ_OK = 10000, CPQ_BAD = 15000, CPQ_MIN_QUAL = 3;
export function cpqTone(cpq) {
  const v = Number(cpq);
  if (!Number.isFinite(v) || v <= 0) return null;
  return v < CPQ_OK ? 'ok' : (v < CPQ_BAD ? 'mid' : 'bad');
}
export function campaignDecision(cpq, qual) {
  if (!(Number(qual) >= CPQ_MIN_QUAL)) return { key: 'few', label: 'мало данных' };
  const t = cpqTone(cpq);
  if (t === 'ok') return { key: 'scale', label: 'Масштабировать' };
  if (t === 'mid') return { key: 'optimize', label: 'Оптимизировать' };
  if (t === 'bad') return { key: 'off', label: 'Отключить' };
  return { key: 'few', label: 'мало данных' };
}
export function classifyForm(cfg, formId, adsByForm) {
  cfg = cfg || DEFAULT_PRODUCTS;
  return _formProduct(cfg, formId, adsByForm) || cfg.default || 'SD';
}
// Сделка с лидформы приходит в amo с тегом «fb<номер формы>».
export function formIdFromTags(tags) {
  for (const t of tags || []) {
    const n = typeof t === 'string' ? t : (t && t.name);
    const m = String(n || '').trim().match(/^fb(\d{6,})$/i);
    if (m) return m[1];
  }
  return null;
}
// Продукт сделки: тег формы главнее, потом кампания рекламного касания, иначе SalesDoc.
export function productOfLead(cfg, lead, touch, adsByForm) {
  cfg = cfg || DEFAULT_PRODUCTS;
  const fid = formIdFromTags(lead && lead.tags);
  const fp = fid ? _formProduct(cfg, fid, adsByForm) : null;
  if (fp) return fp;
  if (touch && (touch.campaign_id || touch.campaign)) return classifyCampaign(cfg, { id: touch.campaign_id, name: touch.campaign });
  return cfg.default || 'SD';
}
// v1017 (b2): откуда пришла сделка — по названию, тегам и тому, кто завёл:
//   form   — лидформа Meta («Facebook №…» или тег fb<номер формы>);
//   call   — завела интеграция телефонии (created_by 0, «Исходящий/Входящий/Пропущенный…»);
//   chat   — завела другая интеграция (created_by 0: Wazzup/WhatsApp и прочие);
//   manual — завёл сотрудник (created_by ≠ 0).
export const SOURCE_TYPES = ['form', 'chat', 'call', 'manual'];
// v1017 (b2): дозаливка переписок идёт ночами кусками — отметки соседних/пересекающихся периодов
// склеиваем в одну (from=min, to=max), чтобы в конце была одна отметка на весь пропуск.
export function mergeBackfillMark(prev, next) {
  if (!next) return prev || null;
  const ok = (m) => m && /^\d{4}-\d{2}-\d{2}$/.test(String(m.from || '')) && /^\d{4}-\d{2}-\d{2}$/.test(String(m.to || ''));
  if (!ok(prev) || !ok(next)) return next;
  const touch = next.from <= addDaysIso(prev.to, 1) && next.to >= addDaysIso(prev.from, -1);
  if (!touch) return next;
  return { from: prev.from < next.from ? prev.from : next.from, to: prev.to > next.to ? prev.to : next.to,
    done_at: next.done_at || prev.done_at || null,
    matched: (Number(prev.matched) || 0) + (Number(next.matched) || 0), checked: (Number(prev.checked) || 0) + (Number(next.checked) || 0) };
}
// v1017 (QA): следующий кусок дозаливки (≤45 дней): с конца отметки, если она покрывает начало заявки,
// иначе с начала заявки; не дальше конца заявки и сегодняшнего дня. Нечего делать — null.
export function backfillPiece(request, mark, todayIso) {
  if (!request || !request.from || !request.to) return null;
  let from = request.from;
  if (mark && mark.from && mark.to && mark.from <= request.from && mark.to >= request.from) from = addDaysIso(mark.to, 1);
  const last = todayIso && todayIso < request.to ? todayIso : request.to;
  if (from > last) return null;
  const cap = addDaysIso(from, 44);
  return { from, to: cap < last ? cap : last };
}
// Нужна ли ещё дозаливка по заявке mkt_chat_backfill_request.
export function backfillNeeded(request, mark) {
  if (!request || !request.from || !request.to) return false;
  if (!mark || !mark.from || !mark.to) return true;
  return mark.to < request.to || mark.from > request.from;
}
export function sourceTypeOf(lead) {
  const l = lead || {};
  const name = String(l.name || '');
  const tags = (l.tags || []).map(t => typeof t === 'string' ? t : (t && t.name)).map(x => String(x || '').trim());
  if (/Facebook\s*№/i.test(name) || tags.some(t => /^fb\d+$/i.test(t))) return 'form';
  if (Number(l.created_by)) return 'manual';
  if (/исходящ|входящ|пропущ/i.test(name)) return 'call';
  return 'chat';
}
export function emptyByProduct(fields) {
  const o = {};
  PRODUCT_CODES.forEach(c => { o[c] = {}; (fields || []).forEach(f => { o[c][f] = 0; }); });
  return o;
}
export function productParam(q) {
  const p = String((q && q.product) || '').toUpperCase();
  return PRODUCT_CODES.includes(p) ? p : 'ALL';
}

// ── Этапы воронки ───────────────────────────────────────────────────────────
// Решение CEO: «Квал» = сделка по НАСТОЯЩЕЙ истории дошла до «Квалификация пройдена»
// или любого этапа дальше. «Отложили на период» и отказ движением вперёд не считаются.
export const QUAL_STATUS_ID = 82205462;
export const POSTPONED_STATUS_ID = 87022638;
export const isLossStatus = (st) => Number(st.id) === 143 || Number(st.sort) === 11000 || /закрыт.*не.*реализ|не реализ/i.test(String(st.name || ''));
export const isWonStatus = (st) => Number(st.id) === 142 || Number(st.sort) === 10000 || /успешн.*реализ/i.test(String(st.name || ''));
export const isPostponed = (st) => !!st && (Number(st.id) === POSTPONED_STATUS_ID || /отложил/i.test(String(st.name || '')));

// honest=false — старое поведение (v1): «Отложили» считался обычным этапом воронки.
export function buildStageModel(statuses, opts) {
  const honest = !opts || opts.honest !== false;
  const all = (statuses || []).slice();
  const skip = (st) => isLossStatus(st) || (honest && isPostponed(st));
  const flow = all.filter(st => !skip(st) && !isWonStatus(st)).sort((a, b) => a.sort - b.sort);
  // Успех засчитываем как пройденную воронку целиком — до последнего живого этапа (Предоплата).
  const maxFlowSort = flow.length ? Number(flow[flow.length - 1].sort) : 0;
  const sortById = {}, nameById = {};
  all.forEach(st => {
    nameById[st.id] = st.name;
    if (skip(st)) return;
    sortById[st.id] = isWonStatus(st) ? maxFlowSort : Number(st.sort);
  });
  const pick = (re) => flow.find(st => re.test(String(st.name || '')));
  const qualStage = flow.find(st => Number(st.id) === QUAL_STATUS_ID) || pick(/квалификац.*пройден/i) || null;
  const meetStage = pick(/назначен.*встреч|встреч.*назначен/i) || null;
  const invStage = pick(/сч[еёe]т.*выставл|выставл.*сч[еёe]т/i) || null;
  return {
    flow, maxFlowSort, sortById, nameById, qualStage, meetStage, invStage,
    wonIds: new Set(all.filter(isWonStatus).map(st => st.id)),
    lostIds: new Set(all.filter(isLossStatus).map(st => st.id)),
    postponedIds: new Set(all.filter(isPostponed).map(st => st.id))
  };
}
// Самый дальний настоящий этап среди тех, где сделка была (текущий + история).
export function reachedFromVisited(model, statusIds) {
  let r = null;
  for (const id of statusIds || []) {
    const s = model.sortById[id];
    if (s === undefined) continue;
    if (r === null || s > r) r = s;
  }
  return r;
}
export function reachedFlags(model, r) {
  const ge = (st) => !!(st && r != null && r >= Number(st.sort));
  return { qual: ge(model.qualStage), meet: ge(model.meetStage), inv: ge(model.invStage) };
}
export function stageRef(st) { return st ? { id: st.id, name: st.name, sort: Number(st.sort) } : null; }

// ── Дата обращения (одно правило месяца на весь экран) ──────────────────────
// Сделка из рекламы относится к месяцу рекламного касания, остальные — к дате создания.
// Касание в пределах 7 дней от создания — это то же обращение (берём более раннюю дату).
// Касание позже 7 дней после создания — человек вернулся: новое обращение в месяце касания.
export const NEAR_SEC = 7 * 86400;
export function computeArrival(lead, touches, fromTs, toTs) {
  const created = Number(lead && lead.created) || 0;
  const to = toTs == null ? Infinity : Number(toTs);
  const ts = (touches || []).map(t => ({ t, at: Math.floor(Date.parse(t.touched_at) / 1000) }))
    .filter(x => Number.isFinite(x.at)).sort((a, b) => a.at - b.at);
  const near = ts.filter(x => Math.abs(x.at - created) <= NEAR_SEC);
  const returns = ts.filter(x => x.at - created > NEAR_SEC);
  const newAt = near.reduce((m, x) => Math.min(m, x.at), created);
  const inP = (s) => s >= fromTs && s <= to;
  const newIn = inP(newAt);
  const retIn = returns.filter(x => inP(x.at));
  if (!newIn && !retIn.length) return null;
  const cand = (newIn ? near : []).concat(retIn).sort((a, b) => a.at - b.at);
  const touch = cand.length ? cand[cand.length - 1].t : null;
  const fb = !!formIdFromTags(lead && lead.tags);
  if (newIn) return { arrival_at: newAt, arrival_kind: (near.length || fb) ? 'ad' : 'organic', touch };
  return { arrival_at: retIn[retIn.length - 1].at, arrival_kind: 'return', touch };
}
export function touchRef(t) {
  if (!t) return null;
  return { campaign_id: t.campaign_id || null, campaign: t.campaign || null, ad_id: t.ad_id || null,
    targetolog: t.targetolog || null, touched_at: t.touched_at || null };
}

// ── Ошибки источников (никаких тихих нулей) ─────────────────────────────────
export function metaErrKind(code) {
  const c = Number(code);
  if (c === 190) return 'token';
  if (c === 10 || (c >= 200 && c <= 299)) return 'perm';
  return 'other';
}
export function metaErrOf(e, account) {
  const me = (e && e.metaError) || null;
  const code = me ? me.code : (e && e.code);
  const out = { source: 'meta', kind: metaErrKind(code), message: String((me && me.message) || (e && e.message) || e).slice(0, 300) };
  if (account) out.account = account;
  if (code != null) out.code = code;
  return out;
}
export function metaFailCode(errors) { return (errors || []).some(x => x && x.kind === 'token') ? 'meta_token' : 'meta_error'; }
export function amoErrKind(status) { const s = Number(status); return (s === 401 || s === 403) ? 'token' : 'other'; }
export function amoErrOf(e, what) {
  const out = { source: 'amo', kind: amoErrKind(e && e.status), message: String((what ? what + ': ' : '') + ((e && e.message) || e)).slice(0, 300) };
  if (e && e.status) out.code = e.status;
  return out;
}

// ── Деление без потерь: сумма частей ровно равна целому ─────────────────────
function _cleanWeights(w) {
  const keys = Object.keys(w || {}).filter(k => Number(w[k]) > 0);
  const sum = keys.reduce((a, k) => a + Number(w[k]), 0);
  return sum > 0 ? { keys, sum } : null;
}
// Целые (показы, клики, заявки) — методом наибольшего остатка.
export function splitInt(total, weights) {
  const cw = _cleanWeights(weights);
  const T = Number(total) || 0;
  if (!cw) return { '??': T };
  if (!Number.isInteger(T)) {
    const out = {}; let acc = 0;
    cw.keys.forEach((k, i) => { if (i === cw.keys.length - 1) out[k] = T - acc; else { out[k] = T * Number(weights[k]) / cw.sum; acc += out[k]; } });
    return out;
  }
  const sign = T < 0 ? -1 : 1, A = Math.abs(T);
  const raw = cw.keys.map(k => ({ k, v: A * Number(weights[k]) / cw.sum }));
  const out = {}; let used = 0;
  raw.forEach(x => { out[x.k] = Math.floor(x.v); used += out[x.k]; });
  raw.sort((a, b) => (b.v - Math.floor(b.v)) - (a.v - Math.floor(a.v)));
  for (let i = 0; used < A; i++, used++) out[raw[i % raw.length].k] += 1;
  Object.keys(out).forEach(k => { out[k] *= sign; });
  return out;
}
// Деньги — в центах, потом обратно.
export function splitMoney(total, weights) {
  const cents = Math.round((Number(total) || 0) * 100);
  const p = splitInt(cents, weights);
  const out = {};
  Object.keys(p).forEach(k => { out[k] = p[k] / 100; });
  return out;
}

// ── Рекламные часы → бишкекские дни ─────────────────────────────────────────
// Кабинет в поясе Лос-Анджелеса отдаёт сутки с 11:00 (зимой с 10:00) по Бишкеку.
// v1015 (QA): часы берём ОДНИМ запросом на уровне всего кабинета (≈24 строки на день),
// по ним считаем, какая доля дня кабинета (по каждому показателю) приходится на каждый
// бишкекский день, и этой долей делим дневные строки (кампания × страна). Итог каждой
// строки сохраняется точно (целые — методом наибольшего остатка, деньги — в центах).
const HOUR_FIELD = 'hourly_stats_aggregated_by_advertiser_time_zone';
const _num = (v) => Number(v || 0) || 0;
function _actMap(actions) {
  const m = {};
  (Array.isArray(actions) ? actions : []).forEach(a => { m[a.action_type] = (m[a.action_type] || 0) + _num(a.value); });
  return m;
}
function _blank() { return { spend: 0, impressions: 0, clicks: 0, inline_link_clicks: 0, reach: 0, actions: {} }; }
function _add(acc, r) {
  acc.spend += _num(r.spend); acc.impressions += _num(r.impressions); acc.clicks += _num(r.clicks);
  acc.inline_link_clicks += _num(r.inline_link_clicks); acc.reach += _num(r.reach);
  const am = _actMap(r.actions);
  Object.keys(am).forEach(t => { acc.actions[t] = (acc.actions[t] || 0) + am[t]; });
}
const _mval = (e, m) => m.startsWith('a:') ? (e.actions[m.slice(2)] || 0) : e[m];
const METRIC_FIELDS = ['spend', 'impressions', 'clicks', 'inline_link_clicks', 'reach', 'actions', 'cost_per_action_type', 'ctr', 'cpc', 'cpm', 'frequency'];
export function hourOfRow(r) { return parseInt(String((r && r[HOUR_FIELD]) || '').slice(0, 2), 10); }
// Перевод одного часа кабинета (местная дата + час) в день страны.
export function shiftHourToDay(tz, localIsoDay, hour, country) {
  const [y, m, d] = String(localIsoDay).split('-').map(Number);
  return localIso(zonedToUtcMs(tz, y, m, d, hour), country);
}
// hourlyRows — почасовые строки ВСЕГО кабинета (без разбивок); dayRows — дневные строки
// (date_start = день кабинета) на нужном уровне, с разбивкой по странам или без.
export function bishkekShiftRows(o) {
  const { hourlyRows, dayRows, tz, country, since, until, keyOf, daily } = o;
  const hourAgg = new Map(); // день кабинета → { день страны → показатели }
  (hourlyRows || []).forEach(r => {
    const L = String(r.date_start || '').slice(0, 10);
    const h = hourOfRow(r);
    if (!L || !Number.isFinite(h)) return;
    const T = shiftHourToDay(tz, L, h, country);
    if (!hourAgg.has(L)) hourAgg.set(L, {});
    const m = hourAgg.get(L);
    m[T] = m[T] || _blank();
    _add(m[T], r);
  });
  const hourlyHasActions = (hourlyRows || []).some(r => Array.isArray(r.actions) && r.actions.length);
  const hoursCache = new Map();
  const hoursMap = (L) => { // запасной вариант — просто число часов
    if (!hoursCache.has(L)) {
      const w = {};
      for (let h = 0; h < 24; h++) { const T = shiftHourToDay(tz, L, h, country); w[T] = (w[T] || 0) + 1; }
      hoursCache.set(L, w);
    }
    return hoursCache.get(L);
  };
  const fracCache = new Map();
  const fracOf = (L, m) => {
    const ck = L + '|' + m;
    if (fracCache.has(ck)) return fracCache.get(ck);
    const hm = hourAgg.get(L);
    const wOf = (mm) => {
      if (!hm) return null;
      const w = {}; let s = 0;
      Object.keys(hm).forEach(T => { const v = _mval(hm[T], mm); if (v > 0) { w[T] = v; s += v; } });
      return s > 0 ? w : null;
    };
    const w = wOf(m) || wOf('spend') || hoursMap(L);
    fracCache.set(ck, w);
    return w;
  };
  let approx = false;
  const out = new Map();
  (dayRows || []).forEach(r => {
    const L = String(r.date_start || '').slice(0, 10);
    if (!L) return;
    const v = _blank(); _add(v, r);
    const parts = {};
    const put = (T, m, val) => { parts[T] = parts[T] || _blank(); if (m.startsWith('a:')) parts[T].actions[m.slice(2)] = val; else parts[T][m] = val; };
    const metrics = ['spend', 'impressions', 'clicks', 'inline_link_clicks', 'reach'].concat(Object.keys(v.actions).map(t => 'a:' + t));
    metrics.forEach(m => {
      const total = _mval(v, m);
      if (!total) return;
      const fm = m === 'reach' ? 'spend' : m; // охват не складывается — делим по расходу (приблизительно)
      if (m.startsWith('a:') && !hourlyHasActions) approx = true;
      const w = fracOf(L, fm);
      const sp = m === 'spend' ? splitMoney(total, w) : splitInt(total, w);
      Object.keys(sp).forEach(T => { if (T >= since && T <= until && sp[T]) put(T, m, sp[T]); });
    });
    Object.keys(parts).forEach(T => {
      const ok = (daily ? T : '') + '|' + keyOf(r) + '|' + String(r.country || '');
      let row = out.get(ok);
      if (!row) {
        row = Object.assign({}, r);
        METRIC_FIELDS.forEach(f => { delete row[f]; });
        row.date_start = daily ? T : since; row.date_stop = daily ? T : until;
        row._v = _blank();
        out.set(ok, row);
      }
      const a = row._v, p = parts[T];
      a.spend += p.spend; a.impressions += p.impressions; a.clicks += p.clicks; a.inline_link_clicks += p.inline_link_clicks; a.reach += p.reach;
      Object.keys(p.actions).forEach(t => { a.actions[t] = (a.actions[t] || 0) + p.actions[t]; });
    });
  });
  const rows = [...out.values()].map(r => {
    const v = r._v; delete r._v;
    r.spend = Math.round(v.spend * 100) / 100;
    r.impressions = v.impressions; r.clicks = v.clicks; r.inline_link_clicks = v.inline_link_clicks; r.reach = v.reach;
    r.actions = Object.keys(v.actions).filter(t => v.actions[t]).map(t => ({ action_type: t, value: String(v.actions[t]) }));
    r._shifted = true;
    return r;
  });
  return { rows, approx };
}
