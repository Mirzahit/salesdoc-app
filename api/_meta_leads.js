import './_preview_guard.js'; // v1017: в превью-сборке запись наружу отключена (см. файл)
// v1017: заявки лидформ Meta — своя таблица public.meta_leads и сверка «Meta → amoCRM».
//
// Зачем: реклама говорит «37 заявок», а в amo видно меньше. Чтобы понять, сколько заявок
// потерялось и почему, каждую заявку Meta храним у себя и ищем её сделку в amo:
//   matched   — интеграция завела сделку «Facebook №<номер заявки>» (номер в названии);
//   renamed   — сделку завела интеграция (created_by 0), но название сменили — нашли по телефону;
//   manual    — по телефону нашли сделку, которую завёл менеджер руками;
//   duplicate — этот же номер уже пришёл другой заявкой, и та в amo есть (не потеря);
//   bad_phone — номера в заявке нет/он кривой; not_found — сделки нет нигде;
//   test      — тестовая заявка Meta; other_product — Zakaz24/Штурм (в amo SalesDoc не ищем).
// Причина потери (not_found): form_not_connected — ни одна сделка с тегом fb<форма> не
// приходила, значит форму к amo не подключали; иначе no_deal.
// Таблица — единственный дом заявок лидформ: в ad_touches остаются только переписки.
//
// Чистые функции проверяет scripts/mkt-selftest.mjs. Сеть: Meta — только чтение,
// amo — только чтение и только через ограничитель частоты (ctx.amoFetch), запись — в meta_leads.

import { sbSelect, sbSelectAll, sbInsertIgnoreDup, sbUpdate } from './_supabase.js';
import { normalizePhone } from './_phone.js';
import { loadProducts, classifyMetaLead, formIdFromTags } from './_mkt.js';
import { dayStartMs, dayEndMs, addDaysIso, localIso } from './_dates.js';
import { loadFxRates, fxRateFor } from './_finansist_core.js';
import { maskTail } from './_mkt_work.js'; // v1017: одна маска телефона на весь Маркетинг

export const IN_AMO_STATUSES = ['matched', 'renamed', 'manual'];
export const LOST_STATUSES = ['not_found', 'bad_phone'];
export const RESOLUTIONS = ['added_to_amo', 'no_answer', 'not_our_client'];
export const RECHECK_DAYS = 14;
export const PHONE_DEAL_BEFORE_SEC = 86400, PHONE_DEAL_AFTER_SEC = 14 * 86400; // v1017 (QA): окно сделки по телефону
// v1017 (QA): текст ошибки базы без «Failing row contains (…)» — там вся строка с телефоном и именем.
export function cleanErr(e) {
  return String((e && e.message) || e || '').split(/Failing row/i)[0].replace(/[\s,:;(]+$/, '').slice(0, 200);
}
const META_LEAD_FIELDS = 'id,created_time,ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name,form_id,field_data,is_organic,platform';
const DAY = 86400000;

// ── Чистые функции ──────────────────────────────────────────────────────────
export function leadIdFromDealName(name) {
  const m = String(name || '').match(/Facebook\s*№\s*(\d{6,})/i);
  return m ? m[1] : null;
}
// v1017 (решение CEO): без права на персональные данные — только последние 4 цифры.
export const maskPhone = maskTail;
const _has = (m, k) => m && (m instanceof Map ? m.has(String(k)) : (m instanceof Set ? m.has(String(k)) : Object.prototype.hasOwnProperty.call(m, String(k))));
const _get = (m, k) => !m ? undefined : (m instanceof Map ? m.get(String(k)) : m[String(k)]);
const _iso = (sec) => { const n = Number(sec); return n > 0 ? new Date(n * 1000).toISOString() : null; };

// Тестовая заявка Meta: во всех полях «<test lead: dummy data for …>».
export function isTestLead(row) {
  const vals = [row && row.full_name, row && row.phone_raw].concat(Object.values((row && row.answers) || {}));
  return vals.some(v => /<test lead/i.test(String(v || '')));
}

// Сырая заявка Meta → строка meta_leads. extra: { form_name, page_id, account_id, now }.
export function parseMetaLead(raw, cfg, extra) {
  const e = extra || {};
  const fields = (raw && raw.field_data) || [];
  const val = (f) => (f.values || []).map(v => String(v)).join(', ');
  const pick = (exact, re) => fields.find(f => String(f.name || '').toLowerCase() === exact) || fields.find(f => re.test(String(f.name || '')));
  const ph = pick('phone_number', /phone|тел|номер/i);
  const nm = pick('full_name', /name|имя|фио/i);
  const answers = {};
  fields.forEach(f => { if (f !== ph && f !== nm) answers[String(f.name || '')] = val(f); });
  const phone_raw = ph ? val(ph) : null;
  const phone_norm = normalizePhone(phone_raw);
  const ctMs = Date.parse(raw && raw.created_time);
  const created = Number.isFinite(ctMs) ? new Date(ctMs).toISOString() : null;
  const s = (v) => (v == null || v === '') ? null : String(v);
  const row = {
    meta_lead_id: String(raw.id),
    country: phone_norm && phone_norm.startsWith('7') ? 'KZ' : 'KG',
    created_time: created,
    product: null,
    page_id: s(e.page_id),
    form_id: s(raw.form_id || e.form_id),
    form_name: s(e.form_name),
    campaign_id: s(raw.campaign_id), campaign_name: s(raw.campaign_name),
    adset_id: s(raw.adset_id), adset_name: s(raw.adset_name),
    ad_id: s(raw.ad_id), ad_name: s(raw.ad_name),
    account_id: s(e.account_id),
    platform: s(raw.platform),
    is_organic: raw.is_organic == null ? null : !!raw.is_organic,
    full_name: nm ? val(nm) : null,
    phone_raw, phone_norm,
    answers,
    match_status: 'new',
    first_seen_at: new Date(e.now || Date.now()).toISOString(),
    recheck_until: Number.isFinite(ctMs) ? new Date(ctMs + RECHECK_DAYS * DAY).toISOString() : null
  };
  row.product = classifyMetaLead(cfg, { campaign_name: row.campaign_name, campaign_id: row.campaign_id, form_id: row.form_id });
  return row;
}

// Решение по одной заявке. c: { dealByMetaId, phoneDeals, matchedPhones, connectedForms }.
//   dealByMetaId   — номер заявки → сделка {id, created_at, created_by, contact_id} (из названий сделок);
//   phoneDeals     — phone_norm → {contact_id, deals:[{id, created_at, created_by}]} (поиск по номеру);
//   matchedPhones  — phone_norm → номер ДРУГОЙ заявки, которая уже есть в amo;
//   connectedForms — номера форм, по которым сделки в amo приходили.
export function decideMatch(row, c) {
  const ctx = c || {};
  const out = { match_status: null, lost_reason: null, amo_lead_id: null, amo_contact_id: null, amo_created_at: null, match_method: null };
  if (isTestLead(row)) return Object.assign(out, { match_status: 'test' });
  if (row.product === 'Z24' || row.product === 'SHTURM') return Object.assign(out, { match_status: 'other_product' });
  const d = _get(ctx.dealByMetaId, row.meta_lead_id);
  if (d) return Object.assign(out, { match_status: 'matched', match_method: 'lead_id', amo_lead_id: Number(d.id),
    amo_contact_id: d.contact_id ? Number(d.contact_id) : null, amo_created_at: _iso(d.created_at) });
  if (!row.phone_norm) return Object.assign(out, { match_status: 'bad_phone', lost_reason: 'bad_phone' });
  const dupOf = _get(ctx.matchedPhones, row.phone_norm);
  if (dupOf && String(dupOf) !== String(row.meta_lead_id)) return Object.assign(out, { match_status: 'duplicate', lost_reason: 'duplicate' });
  const pd = _get(ctx.phoneDeals, row.phone_norm);
  // v1017 (QA): сделка по телефону засчитывается, только если создана от суток ДО заявки до 14 дней
  // ПОСЛЕ неё. Старая сделка 2025 года — это прошлое обращение, а не эта заявка (заявка потеряна).
  const ct = Math.floor(Date.parse(row.created_time) / 1000) || 0;
  const near = pd && pd.deals ? pd.deals.filter(x => { const c = Number(x.created_at) || 0; return c >= ct - PHONE_DEAL_BEFORE_SEC && c <= ct + PHONE_DEAL_AFTER_SEC; }) : [];
  if (near.length) {
    const best = near.slice().sort((a, b) => Math.abs(Number(a.created_at || 0) - ct) - Math.abs(Number(b.created_at || 0) - ct))[0];
    return Object.assign(out, { match_status: Number(best.created_by) ? 'manual' : 'renamed', match_method: 'phone',
      amo_lead_id: Number(best.id), amo_contact_id: pd.contact_id ? Number(pd.contact_id) : null, amo_created_at: _iso(best.created_at) });
  }
  const connected = row.form_id && _has(ctx.connectedForms, row.form_id);
  return Object.assign(out, { match_status: 'not_found', lost_reason: connected ? 'no_deal' : 'form_not_connected' });
}

// Заявка, найденная в amo → рекламное касание для отчётов (как строка ad_touches).
export function metaLeadTouch(row, targByAcc) {
  const t = targByAcc || {};
  const acc = row.account_id || null;
  const targ = acc ? (t[acc] || t[String(acc).replace(/^act_/, '')] || t['act_' + String(acc).replace(/^act_/, '')] || null) : null;
  return {
    message_id: 'ml:' + row.meta_lead_id, country: row.country || null, phone: row.phone_norm || null,
    touched_at: row.created_time, account: acc, targetolog: targ,
    campaign_id: row.campaign_id || null, campaign: row.campaign_name || null,
    ad_id: row.ad_id || null, ad_name: row.ad_name || null, ad_ambiguous: false,
    lead_id: row.amo_lead_id != null ? Number(row.amo_lead_id) : null,
    contact_id: row.amo_contact_id != null ? Number(row.amo_contact_id) : null,
    lead_created: row.amo_created_at || null,
    source: 'meta_leadform', link: 'лидформа ' + (row.form_id || '')
  };
}
// Общий источник касаний: переписки из ad_touches + заявки из meta_leads, найденные в amo.
// Старую строку ad_touches 'lg:X' выбрасываем, если заявка X уже есть в meta_leads (любой статус).
export function mergeTouches(adRows, metaRows, targByAcc) {
  const known = new Set((metaRows || []).map(r => String(r.meta_lead_id)));
  const chats = (adRows || []).filter(t => !(String(t.message_id || '').startsWith('lg:') && known.has(String(t.message_id).slice(3))));
  const forms = (metaRows || []).filter(r => IN_AMO_STATUSES.includes(r.match_status) && r.amo_lead_id != null && r.created_time)
    .map(r => metaLeadTouch(r, targByAcc));
  return chats.concat(forms).sort((a, b) => (Date.parse(a.touched_at) - Date.parse(b.touched_at)) || String(a.message_id).localeCompare(String(b.message_id)));
}

// Список дней периода (YYYY-MM-DD), не больше 400.
export function daysOf(since, until) {
  const out = [];
  for (let d = String(since).slice(0, 10), i = 0; d <= String(until).slice(0, 10) && i < 400; d = addDaysIso(d, 1), i++) out.push(d);
  return out;
}
// Курс доллара по дням периода: курс НБКР этого дня (в выходные — последний, не старше 5 дней),
// иначе курс из настроек Маркетинга (mkt_costs.usd_rate), иначе день в missing_days.
export function fxByDay(rates, days, fallbackRate) {
  const fb = Number(fallbackRate) > 0 ? Number(fallbackRate) : null;
  const by_day = {}, missing_days = [];
  let sum = 0, n = 0;
  (days || []).forEach(d => {
    const r = fxRateFor(rates, d, 'USD');
    // v1019 (QA): настоящий источник доллара дня — 'nbkr' или 'nbkr_archive' (поле USD_src, иначе src дня)
    if (r) { const day = rates && rates[r.date]; const us = (day && (day.USD_src || day.src)) || 'nbkr'; by_day[d] = { rate: r.rate, src: us === 'nbkr_archive' ? 'nbkr_archive' : 'nbkr', from: r.date }; }
    else if (fb) by_day[d] = { rate: fb, src: 'settings', from: null };
    else { missing_days.push(d); return; }
    sum += by_day[d].rate; n++;
  });
  return { cur: 'USD', by_day, avg_rate: n ? Math.round(sum / n * 10000) / 10000 : null, fallback_rate: fb, missing_days };
}

// ── Meta: заявки форм (только чтение) ───────────────────────────────────────
function metaToken() { return String(process.env.META_LEADS_TOKEN || process.env.META_ACCESS_TOKEN || '').trim(); }
async function metaGetRaw(url, stats) {
  stats.meta++;
  let r;
  try { r = await fetch(url, { signal: AbortSignal.timeout(25000) }); }
  catch (e) { const er = new Error('Meta недоступна: ' + (e.message || e)); er.code = 0; throw er; }
  const j = await r.json().catch(() => null);
  if (!r.ok || !j || j.error) {
    const er = new Error((j && j.error && j.error.message) || ('Meta ' + r.status));
    er.code = (j && j.error && j.error.code) || r.status;
    throw er;
  }
  return j;
}
function metaUrl(path, params, tok) {
  const qs = new URLSearchParams(Object.assign({ access_token: tok }, params || {}));
  return `https://graph.facebook.com/v21.0${path}?${qs.toString()}`;
}
const metaErr = (e, what) => ({ source: 'meta', kind: Number(e.code) === 190 ? 'token' : ((Number(e.code) === 10 || (Number(e.code) >= 200 && Number(e.code) <= 299)) ? 'perm' : 'other'),
  code: e.code, message: (what ? what + ': ' : '') + cleanErr(e) });

// Тянет заявки всех форм всех доступных Страниц, созданные после sinceMs.
// Возвращает [{ raw, form_name, page_id }].
export async function pullMetaLeads(ctx, sinceMs, stats, errors, incomplete) {
  const tok = metaToken();
  if (!tok) { errors.push({ source: 'meta', kind: 'token', message: 'META_LEADS_TOKEN не задан' }); return []; }
  const pages = [];
  try {
    const r = await metaGetRaw(metaUrl('/me/accounts', { fields: 'id,name,access_token', limit: 100 }, tok), stats);
    ((r && r.data) || []).forEach(p => { if (p.id && p.access_token) pages.push({ id: String(p.id), token: p.access_token }); });
  } catch (e) { if (Number(e.code) === 190) { errors.push(metaErr(e, 'страницы')); return []; } }
  if (!pages.length) {
    // запасной путь: Страницы из карты объявлений, токен Страницы — отдельным запросом
    const ids = new Set(ctx.adsPageIds ? await ctx.adsPageIds() : []);
    for (const pg of ids) {
      try {
        const r = await metaGetRaw(metaUrl('/' + pg, { fields: 'access_token' }, tok), stats);
        if (r && r.access_token) pages.push({ id: String(pg), token: r.access_token });
      } catch (e) { errors.push(metaErr(e, 'токен страницы ' + pg)); }
    }
  }
  if (!pages.length) { errors.push({ source: 'meta', kind: 'perm', message: 'нет доступа ни к одной Странице с лидформами' }); return []; }
  const out = [];
  const sinceS = Math.floor(sinceMs / 1000);
  for (const pg of pages) {
    let forms = [];
    try {
      const r = await metaGetRaw(metaUrl('/' + pg.id + '/leadgen_forms', { fields: 'id,name,status', limit: 200 }, pg.token), stats);
      forms = (r && r.data) || [];
    } catch (e) { errors.push(metaErr(e, 'формы страницы ' + pg.id)); continue; }
    for (const fm of forms) {
      if (ctx.timeUp && ctx.timeUp()) { incomplete.push({ source: 'meta', what: 'forms', detail: 'не хватило времени на все формы' }); return out; } // v1017 (QA)
      try {
        let j = await metaGetRaw(metaUrl('/' + fm.id + '/leads', {
          fields: META_LEAD_FIELDS,
          filtering: JSON.stringify([{ field: 'time_created', operator: 'GREATER_THAN', value: sinceS }]),
          limit: 200
        }, pg.token), stats);
        let n = 0;
        for (;;) {
          ((j && j.data) || []).forEach(raw => out.push({ raw, form_name: fm.name || null, page_id: pg.id }));
          const next = j && j.paging && j.paging.next;
          if (!next) break;
          if (++n >= 10) { incomplete.push({ source: 'meta', what: 'form_leads', detail: 'форма ' + fm.id + ': показаны первые 2200 заявок' }); break; }
          j = await metaGetRaw(next, stats);
        }
      } catch (e) {
        if (Number(e.code) === 190) { errors.push(metaErr(e, 'заявки')); return out; }
        incomplete.push({ source: 'meta', what: 'forms', detail: 'форма ' + fm.id + ' не открылась: ' + String(e.message || e).slice(0, 120) });
      }
    }
  }
  return out;
}

// ── amo: сделки интеграции за окно и поиск по номеру (только чтение) ────────
// Окно дат → сделки, заведённые интеграцией (created_by 0): номер заявки из названия, теги fb<форма>.
async function scanRobotDeals(ctx, fromS, toS, acc, stats, incomplete) {
  for (let page = 1; page <= 8; page++) {
    stats.amo++;
    const r = await ctx.amoFetch(`/leads?filter[created_by][]=0&filter[created_at][from]=${fromS}&filter[created_at][to]=${toS}&limit=250&page=${page}&with=contacts`, ctx.env);
    const batch = (r && r._embedded && r._embedded.leads) || [];
    batch.forEach(l => {
      const fid = formIdFromTags(((l._embedded && l._embedded.tags) || []).map(t => t.name));
      if (fid) acc.forms.add(fid);
      const mid = leadIdFromDealName(l.name);
      if (!mid) return;
      const cs = (l._embedded && l._embedded.contacts) || [];
      const main = cs.find(c => c.is_main) || cs[0];
      const prev = acc.deals.get(mid);
      if (!prev || Number(l.created_at) < Number(prev.created_at)) acc.deals.set(mid, { id: l.id, created_at: l.created_at, created_by: l.created_by || 0, contact_id: main ? main.id : null });
    });
    if (batch.length < 250) return;
    if (page === 8) incomplete.push({ source: 'amo', what: 'deals', detail: 'окно сделок просмотрено не полностью' });
  }
}
// Номер у контакта: если телефоны у контакта есть — хотя бы один должен кончаться на хвост.
function contactHasTail(c, tail) {
  const ph = [];
  (c.custom_fields_values || []).forEach(f => { if (String(f.field_code || '') === 'PHONE') (f.values || []).forEach(v => ph.push(String(v.value || '').replace(/\D/g, ''))); });
  return !ph.length || ph.some(p => p.endsWith(tail));
}

// ── Синхронизация (крон раз в час) ──────────────────────────────────────────
const EXIST_COLS = 'meta_lead_id,created_time,product,page_id,form_id,form_name,campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name,account_id,platform,is_organic,full_name,phone_raw,phone_norm,answers,match_status,lost_reason,match_method,amo_lead_id,recheck_until,last_checked_at,resolution';
const ENRICH_COLS = ['product', 'page_id', 'form_name', 'adset_id', 'adset_name', 'campaign_id', 'campaign_name', 'ad_id', 'ad_name', 'account_id', 'platform', 'is_organic', 'full_name', 'phone_raw', 'answers'];

// ctx: { env, country, amoFetch, fetchLeadsByIds, adsMap():Promise<{ads:[]}>, now() }.
// opts: { dryRun, max, night, full, budgetMs }.
export async function syncMetaLeads(ctx, opts) {
  const o = opts || {};
  const started = Date.now();
  const budget = o.budgetMs || 150000; // крон живёт до 300 с, а до и после нас — переписки и прогрев
  const timeUp = () => Date.now() - started > budget;
  const now = ctx.now ? ctx.now() : Date.now();
  const nowIso = new Date(now).toISOString();
  const dry = o.dryRun !== false;
  const max = Math.min(Math.max(Number(o.max) || 100, 1), 200);
  const errors = [], incomplete = [];
  const stats = { meta: 0, amo: 0, self: 0, db_writes: 0 };
  const hourB = new Date(now + 6 * 3600000).getUTCHours();
  const night = o.night != null ? !!o.night : (hourB >= 21 || hourB < 8);
  const cfg = await loadProducts();

  // 0) что уже есть в таблице
  let existing;
  try { existing = await sbSelectAll('meta_leads', { select: EXIST_COLS, order: 'created_time.asc,meta_lead_id.asc' }); }
  catch (e) { return { error: 'meta_leads: ' + cleanErr(e) }; }
  const byId = new Map(existing.map(r => [String(r.meta_lead_id), r]));

  // 1) новые заявки из Meta. Пустая таблица или 03:00 по Бишкеку — все 90 дней (Meta хранит 90).
  const maxCT = existing.reduce((m, r) => Math.max(m, Date.parse(r.created_time) || 0), 0);
  const full = !!o.full || !existing.length || hourB === 3;
  const sinceMs = full ? now - 90 * DAY : Math.max(maxCT - 2 * 3600000, now - 90 * DAY);
  let adsCache = null;
  const adsMap = async () => {
    if (adsCache) return adsCache;
    stats.self++;
    try { adsCache = (ctx.adsMap ? await ctx.adsMap() : null) || { ads: [] }; }
    catch (e) { adsCache = { ads: [] }; }
    if (!Array.isArray(adsCache.ads)) adsCache = { ads: [] };
    return adsCache;
  };
  const mstats = { meta: 0 };
  const pulled = await pullMetaLeads(Object.assign({}, ctx, { timeUp, adsPageIds: async () => (await adsMap()).ads.map(a => a.page_id).filter(Boolean) }), sinceMs, mstats, errors, incomplete);
  stats.meta += mstats.meta;
  const fresh = [], enrich = [];
  const seenPull = new Set();
  for (const p of pulled) {
    const id = String(p.raw && p.raw.id || '');
    if (!id || seenPull.has(id)) continue;
    seenPull.add(id);
    const ex = byId.get(id);
    if (!ex) fresh.push(p);
    else if (!ex.form_name) enrich.push(p); // строка перенесена из ad_touches — дополняем пустые поля
  }
  const accByAd = {};
  if (fresh.length || enrich.length) {
    const am = await adsMap();
    am.ads.forEach(a => { if (a.ad_id) accByAd[String(a.ad_id)] = a.account || null; });
  }
  const newRows = fresh.map(p => parseMetaLead(p.raw, cfg, { form_name: p.form_name, page_id: p.page_id, account_id: accByAd[String(p.raw.ad_id)] || null, now }));
  let inserted = 0, enriched = 0;
  if (!dry && newRows.length) {
    for (let i = 0; i < newRows.length; i += 200) {
      try { const ins = await sbInsertIgnoreDup('meta_leads', newRows.slice(i, i + 200), 'meta_lead_id'); inserted += ins.length; stats.db_writes++; }
      catch (e) { errors.push({ source: 'db', kind: 'other', message: 'запись заявок: ' + cleanErr(e) }); }
    }
  }
  for (const p of enrich) {
    const ex = byId.get(String(p.raw.id));
    const r = parseMetaLead(p.raw, cfg, { form_name: p.form_name, page_id: p.page_id, account_id: accByAd[String(p.raw.ad_id)] || null, now });
    const patch = {};
    ENRICH_COLS.forEach(k => { if ((ex[k] == null || ex[k] === '') && r[k] != null && !(typeof r[k] === 'object' && !Object.keys(r[k]).length)) patch[k] = r[k]; });
    if (!Object.keys(patch).length) continue;
    Object.assign(ex, patch);
    if (!dry) {
      try { await sbUpdate('meta_leads', { meta_lead_id: 'eq.' + ex.meta_lead_id }, patch); stats.db_writes++; enriched++; }
      catch (e) { errors.push({ source: 'db', kind: 'other', message: 'дополнение заявки: ' + cleanErr(e) }); }
    } else enriched++;
  }
  newRows.forEach(r => byId.set(r.meta_lead_id, r));

  // 2) какие строки проверяем в этот прогон
  const all = [...byId.values()];
  const ms = (r) => Date.parse(r.created_time) || 0;
  const pickedIds = new Set();
  const quick = [];      // тест и другие продукты — без amo
  const work = [];       // ищем сделку
  all.forEach(r => {
    if (r.match_status !== 'new') return;
    if (isTestLead(r) || r.product === 'Z24' || r.product === 'SHTURM') { quick.push(r); pickedIds.add(r.meta_lead_id); }
  });
  const pending = all.filter(r => r.match_status === 'new' && !pickedIds.has(r.meta_lead_id)).sort((a, b) => ms(b) - ms(a));
  const freshNew = pending.filter(r => now - ms(r) <= 48 * 3600000).slice(0, 30);
  freshNew.forEach(r => { work.push(r); pickedIds.add(r.meta_lead_id); });
  if (night) {
    const room = Math.max(0, max - work.length);
    pending.filter(r => !pickedIds.has(r.meta_lead_id)).sort((a, b) => ms(a) - ms(b)).slice(0, room)
      .forEach(r => { work.push(r); pickedIds.add(r.meta_lead_id); });
  }
  const recheck = all.filter(r => LOST_STATUSES.includes(r.match_status) && r.recheck_until && Date.parse(r.recheck_until) > now
    && (!r.last_checked_at || now - Date.parse(r.last_checked_at) > 20 * 3600000)).sort((a, b) => ms(a) - ms(b)).slice(0, 50);
  recheck.forEach(r => { if (!pickedIds.has(r.meta_lead_id)) { work.push(r); pickedIds.add(r.meta_lead_id); } }); // пустой номер перепроверяется только по номеру заявки — поиска по телефону у него нет
  const backfillPending = pending.filter(r => !pickedIds.has(r.meta_lead_id)).length;

  // 3) номер заявки в названии сделки — окна дат не длиннее недели
  const acc = { deals: new Map(), forms: new Set() };
  const sorted = work.slice().sort((a, b) => ms(a) - ms(b));
  const windows = [];
  sorted.forEach(r => {
    const t = ms(r);
    const w = windows[windows.length - 1];
    if (w && t - w.min <= 4 * DAY) w.max = t; else windows.push({ min: t, max: t });
  });
  let amoAuthErr = null;
  for (const w of windows) {
    if (timeUp()) { incomplete.push({ source: 'amo', what: 'deals', detail: 'не хватило времени на все окна' }); break; }
    try {
      await scanRobotDeals(ctx, Math.floor(w.min / 1000) - 3600, Math.floor(Math.min(now, w.max + 3 * DAY) / 1000), acc, stats, incomplete);
    } catch (e) {
      if (Number(e.status) === 401 || Number(e.status) === 403) { amoAuthErr = e; break; }
      errors.push({ source: 'amo', kind: 'other', code: e.status, message: 'сделки интеграции: ' + cleanErr(e) });
      w.failed = true;
    }
  }
  if (amoAuthErr) {
    errors.push({ source: 'amo', kind: 'token', code: amoAuthErr.status, message: 'amo: ' + String(amoAuthErr.message).slice(0, 200) });
  }
  const failedWindow = (r) => windows.some(w => w.failed && ms(r) >= w.min && ms(r) <= w.max);

  // подключённые формы: по ним уже была сделка «Facebook №…» или тег fb<форма>
  const connectedForms = new Set(acc.forms);
  all.forEach(r => { if (r.match_method === 'lead_id' && r.form_id) connectedForms.add(String(r.form_id)); });
  acc.deals.forEach((d, mid) => { const r = byId.get(mid); if (r && r.form_id) connectedForms.add(String(r.form_id)); });

  // уже найденные в amo номера (для дублей): номер → заявка
  const matchedPhones = new Map();
  all.slice().sort((a, b) => ms(a) - ms(b)).forEach(r => { if (IN_AMO_STATUSES.includes(r.match_status) && r.phone_norm && !matchedPhones.has(r.phone_norm)) matchedPhones.set(r.phone_norm, r.meta_lead_id); });

  const decisions = new Map();
  quick.forEach(r => decisions.set(r.meta_lead_id, decideMatch(r, {})));
  if (!amoAuthErr) {
    // 3а) сначала то, что нашлось по номеру заявки
    sorted.forEach(r => {
      if (failedWindow(r)) return;
      if (acc.deals.has(String(r.meta_lead_id))) {
        const d = decideMatch(r, { dealByMetaId: acc.deals });
        decisions.set(r.meta_lead_id, d);
        if (r.phone_norm && !matchedPhones.has(r.phone_norm)) matchedPhones.set(r.phone_norm, r.meta_lead_id);
      }
    });
    // 3б) поиск по номеру: один запрос контакта на хвост номера (9 цифр), не больше 60 за прогон
    const needPhone = sorted.filter(r => !decisions.has(r.meta_lead_id) && !failedWindow(r) && r.phone_norm
      && !(matchedPhones.has(r.phone_norm) && matchedPhones.get(r.phone_norm) !== r.meta_lead_id));
    const tails = new Map();
    let capped = 0;
    for (const r of needPhone) {
      const tail = r.phone_norm.slice(-9);
      if (tails.has(tail)) continue;
      if (tails.size >= 60 || timeUp()) { capped++; continue; }
      try {
        stats.amo++;
        const res = await ctx.amoFetch(`/contacts?query=${encodeURIComponent(tail)}&limit=10&with=leads`, ctx.env);
        const cs = ((res && res._embedded && res._embedded.contacts) || []).filter(c => contactHasTail(c, tail));
        tails.set(tail, cs);
      } catch (e) {
        if (Number(e.status) === 401 || Number(e.status) === 403) { amoAuthErr = e; errors.push({ source: 'amo', kind: 'token', code: e.status, message: 'amo: ' + String(e.message).slice(0, 200) }); break; }
        errors.push({ source: 'amo', kind: 'other', code: e.status, message: 'поиск по номеру: ' + cleanErr(e) });
        tails.set(tail, null);
      }
    }
    if (capped) incomplete.push({ source: 'amo', what: 'contacts', detail: 'не проверено по номеру: ' + capped });
    const leadIds = new Set();
    tails.forEach(cs => (cs || []).forEach(c => ((c._embedded && c._embedded.leads) || []).forEach(l => leadIds.add(Number(l.id)))));
    let dealById = {};
    if (leadIds.size && !amoAuthErr) {
      stats.amo += Math.ceil(leadIds.size / 50);
      try { dealById = (await ctx.fetchLeadsByIds(ctx.env, leadIds, '', errors)).leads || {}; }
      catch (e) { amoAuthErr = e; errors.push({ source: 'amo', kind: 'token', code: e.status, message: 'amo: ' + String(e.message).slice(0, 200) }); }
    }
    const phoneDeals = new Map();
    tails.forEach((cs, tail) => {
      if (cs == null) return;
      const deals = [];
      cs.forEach(c => ((c._embedded && c._embedded.leads) || []).forEach(l => { const d = dealById[l.id]; if (d && !deals.some(x => x.id === d.id)) deals.push({ id: d.id, created_at: d.created_at, created_by: d.created_by || 0 }); }));
      phoneDeals.set(tail, { contact_id: cs.length ? cs[0].id : null, deals });
    });
    // 3в) решение по остальным — по порядку времени (ранняя заявка забирает номер, поздняя — дубль)
    if (!amoAuthErr) sorted.forEach(r => {
      if (decisions.has(r.meta_lead_id) || failedWindow(r)) return;
      const tail = r.phone_norm ? r.phone_norm.slice(-9) : null;
      if (r.phone_norm && !(matchedPhones.has(r.phone_norm) && matchedPhones.get(r.phone_norm) !== r.meta_lead_id) && !tails.has(tail)) return; // не успели проверить
      if (tail && tails.get(tail) === null) return; // поиск упал — проверим в следующий раз
      const pd = tail && phoneDeals.has(tail) ? new Map([[r.phone_norm, phoneDeals.get(tail)]]) : null;
      const d = decideMatch(r, { matchedPhones, phoneDeals: pd, connectedForms });
      decisions.set(r.meta_lead_id, d);
      if (IN_AMO_STATUSES.includes(d.match_status) && r.phone_norm && !matchedPhones.has(r.phone_norm)) matchedPhones.set(r.phone_norm, r.meta_lead_id);
    });
  }

  // 4) запись решений. Свежая заявка (младше часа), которую не нашли, остаётся «новой» —
  //    интеграция могла ещё не довезти сделку; проверим в следующий час.
  const byStatus = {};
  let checked = 0;
  for (const r of work.concat(quick)) {
    const d = decisions.get(r.meta_lead_id);
    if (!d) continue;
    let patch = Object.assign({}, d, { last_checked_at: nowIso });
    if (d.match_status === 'not_found' && r.match_status === 'new' && now - ms(r) < 3600000) patch = { last_checked_at: nowIso };
    const st = patch.match_status || r.match_status;
    byStatus[st] = (byStatus[st] || 0) + 1;
    checked++;
    if (dry) continue;
    if (timeUp()) { incomplete.push({ source: 'db', what: 'write', detail: 'не хватило времени записать все решения' }); break; }
    try { await sbUpdate('meta_leads', { meta_lead_id: 'eq.' + r.meta_lead_id }, patch); stats.db_writes++; }
    catch (e) { errors.push({ source: 'db', kind: 'other', message: 'запись решения: ' + cleanErr(e) }); }
  }

  // 5) Поправки без amo (только база):
  //   а) форма, по которой теперь пришла сделка «Facebook №…», подключена — её старые потери
  //      «форма не подключена» становятся «нет сделки» (первые порции решались, когда это было неизвестно);
  //   б) номер нашёлся в amo по другой заявке — ранние «не нашли» с тем же номером становятся дублями.
  const fixed = { forms: 0, duplicates: 0 };
  const statusNow = (r) => { const d = decisions.get(r.meta_lead_id); return d ? d.match_status : r.match_status; };
  const reasonNow = (r) => { const d = decisions.get(r.meta_lead_id); return d ? d.lost_reason : r.lost_reason; };
  const staleForms = [...new Set(all.filter(r => statusNow(r) === 'not_found' && reasonNow(r) === 'form_not_connected' && r.form_id && connectedForms.has(String(r.form_id))).map(r => String(r.form_id)))];
  const dupRows = all.filter(r => statusNow(r) === 'not_found' && r.phone_norm && matchedPhones.has(r.phone_norm) && matchedPhones.get(r.phone_norm) !== r.meta_lead_id);
  if (!dry && !timeUp()) {
    for (const f of staleForms) {
      try { const u = await sbUpdate('meta_leads', { form_id: 'eq.' + f, match_status: 'eq.not_found', lost_reason: 'eq.form_not_connected' }, { lost_reason: 'no_deal' }); fixed.forms += u.length; stats.db_writes++; }
      catch (e) { errors.push({ source: 'db', kind: 'other', message: 'поправка форм: ' + cleanErr(e) }); }
    }
    for (const r of dupRows) {
      try { await sbUpdate('meta_leads', { meta_lead_id: 'eq.' + r.meta_lead_id, match_status: 'eq.not_found' }, { match_status: 'duplicate', lost_reason: 'duplicate', last_checked_at: nowIso }); fixed.duplicates++; stats.db_writes++; }
      catch (e) { errors.push({ source: 'db', kind: 'other', message: 'поправка дублей: ' + cleanErr(e) }); }
    }
  } else { fixed.forms = staleForms.length; fixed.duplicates = dupRows.length; }
  return {
    country: ctx.country, dry_run: dry, mode: night ? 'night' : 'day', full_pull: full,
    since: new Date(sinceMs).toISOString(),
    pulled: seenPull.size, inserted: dry ? 0 : inserted, would_insert: dry ? newRows.length : undefined, enriched,
    checked, by_status: byStatus, backfill_pending: backfillPending, fixed,
    requests: { meta: stats.meta, amo: stats.amo, ads_map: stats.self, db_writes: stats.db_writes },
    elapsed_ms: Date.now() - started,
    errors, incomplete
  };
}

// ── Перенос 'lg:' строк из ad_touches в meta_leads (разовый) ────────────────
export const IMPORT_LG_SQL = "INSERT INTO public.meta_leads (meta_lead_id,country,created_time,form_id,campaign_id,campaign_name,ad_id,ad_name,account_id,phone_raw,phone_norm,match_status,amo_lead_id,amo_contact_id,first_seen_at,recheck_until) SELECT substr(t.message_id,4), t.country, t.touched_at, substring(t.link from '(\\d{6,})'), t.campaign_id, t.campaign, t.ad_id, t.ad_name, t.account, t.phone, CASE WHEN t.phone ~ '^996\\d{9}$' THEN t.phone WHEN t.phone ~ '^0\\d{9}$' THEN '996'||substr(t.phone,2) WHEN t.phone ~ '^\\d{9}$' THEN '996'||t.phone WHEN t.phone ~ '^7\\d{10}$' THEN t.phone END, 'new', t.lead_id, t.contact_id, now(), t.touched_at + interval '14 days' FROM public.ad_touches t WHERE t.message_id LIKE 'lg:%' ON CONFLICT (meta_lead_id) DO NOTHING;";
export function lgTouchToRow(t, nowMs) {
  const d = String(t.phone || '').replace(/\D/g, '');
  const norm = /^996\d{9}$/.test(d) ? d : (/^0\d{9}$/.test(d) ? '996' + d.slice(1) : (/^\d{9}$/.test(d) ? '996' + d : (/^7\d{10}$/.test(d) ? d : null)));
  const fm = String(t.link || '').match(/(\d{6,})/);
  const ct = Date.parse(t.touched_at);
  return {
    meta_lead_id: String(t.message_id).slice(3), country: t.country || null, created_time: Number.isFinite(ct) ? new Date(ct).toISOString() : null,
    form_id: fm ? fm[1] : null, campaign_id: t.campaign_id || null, campaign_name: t.campaign || null,
    ad_id: t.ad_id || null, ad_name: t.ad_name || null, account_id: t.account || null,
    phone_raw: t.phone || null, phone_norm: norm, match_status: 'new',
    amo_lead_id: t.lead_id != null ? Number(t.lead_id) : null, amo_contact_id: t.contact_id != null ? Number(t.contact_id) : null,
    first_seen_at: new Date(nowMs || Date.now()).toISOString(),
    recheck_until: Number.isFinite(ct) ? new Date(ct + RECHECK_DAYS * DAY).toISOString() : null
  };
}
export async function importLgRows(dry) {
  const src = await sbSelectAll('ad_touches', { select: 'message_id,country,touched_at,link,campaign_id,campaign,ad_id,ad_name,account,phone,lead_id,contact_id', message_id: 'like.lg:*', order: 'message_id.asc' });
  const rows = src.map(t => lgTouchToRow(t));
  let already = 0;
  try {
    const have = await sbSelectAll('meta_leads', { select: 'meta_lead_id', order: 'meta_lead_id.asc' });
    const s = new Set(have.map(r => String(r.meta_lead_id)));
    already = rows.filter(r => s.has(r.meta_lead_id)).length;
  } catch (_) {}
  const out = { dry_run: !!dry, found: rows.length, already_in_meta_leads: already, bad_phone: rows.filter(r => !r.phone_norm).length,
    samples: rows.slice(0, 5).map(r => ({ meta_lead_id: r.meta_lead_id, created_time: r.created_time, form_id: r.form_id, campaign_name: r.campaign_name, phone: maskPhone(r.phone_norm || r.phone_raw), amo_lead_id: r.amo_lead_id })),
    sql: IMPORT_LG_SQL };
  if (dry) return out;
  let inserted = 0;
  for (let i = 0; i < rows.length; i += 200) inserted += (await sbInsertIgnoreDup('meta_leads', rows.slice(i, i + 200), 'meta_lead_id')).length;
  out.inserted = inserted;
  return out;
}

// ── Сверка Meta → amo за период (только чтение базы) ────────────────────────
const RECON_COLS = 'meta_lead_id,created_time,product,form_id,form_name,campaign_name,ad_name,full_name,phone_norm,phone_raw,answers,match_status,lost_reason,recheck_until,last_checked_at,resolution';
// q: { since, until, product ('ALL'|'SD'|'Z24'|'SHTURM'), trusted, pii, sub }
// pii=false — телефон «последние 4 цифры», без имени и ответов формы (маскируем здесь, на сервере).
export async function buildRecon(q) {
  const errors = [], incomplete = [];
  const since = q.since, until = q.until, product = q.product || 'ALL';
  const fromMs = dayStartMs(since, 'KG'), toMs = dayEndMs(until, 'KG');
  const rowsAll = (await sbSelectAll('meta_leads', { select: RECON_COLS, created_time: 'gte.' + new Date(fromMs).toISOString(), order: 'created_time.asc,meta_lead_id.asc' }))
    .filter(r => { const t = Date.parse(r.created_time); return Number.isFinite(t) && t < toMs; });
  const inProduct = (r) => product === 'ALL' ? true : (product === 'SD' ? (r.product === 'SD' || r.product == null) : r.product === product);
  const rows = rowsAll.filter(inProduct);
  const cnt = (f) => rows.filter(f).length;
  const st = (s) => cnt(r => r.match_status === s);
  // v1017 (QA): «форма не подключена» считаем на лету — если по форме хоть раз пришла сделка
  // «Facebook №…» (match_method lead_id), она подключена, и потеря — «нет сделки».
  try {
    const conn = new Set((await sbSelectAll('meta_leads', { select: 'form_id', match_method: 'eq.lead_id', order: 'form_id.asc' })).map(r => String(r.form_id)).filter(Boolean));
    rows.forEach(r => { if (r.match_status === 'not_found' && r.lost_reason === 'form_not_connected' && conn.has(String(r.form_id))) r.lost_reason = 'no_deal'; });
  } catch (e) { incomplete.push({ source: 'db', what: 'forms', detail: 'подключённые формы не проверены' }); }
  const lostRows = rows.filter(r => LOST_STATUSES.includes(r.match_status));
  const nonTest = rows.filter(r => r.match_status !== 'test');
  const lostTotal = lostRows.length;
  const recon = {
    meta_total: nonTest.length,
    test: st('test'),
    in_amo: { matched: st('matched'), renamed: st('renamed'), manual: st('manual'), total: cnt(r => IN_AMO_STATUSES.includes(r.match_status)) },
    duplicates: st('duplicate'),
    lost: { total: lostTotal,
      form_not_connected: lostRows.filter(r => r.match_status === 'not_found' && r.lost_reason === 'form_not_connected').length,
      no_deal: lostRows.filter(r => r.match_status === 'not_found' && r.lost_reason !== 'form_not_connected').length,
      bad_phone: lostRows.filter(r => r.match_status === 'bad_phone').length },
    lost_pct: nonTest.length ? Math.round(lostTotal / nonTest.length * 1000) / 10 : null,
    closed: { added_to_amo: 0, no_answer: 0, not_our_client: 0 },
    not_recognized: (product === 'SD' || product === 'ALL') ? rows.filter(r => r.product == null && r.match_status !== 'test').length : 0,
    other_product: { Z24: rowsAll.filter(r => r.product === 'Z24').length, SHTURM: rowsAll.filter(r => r.product === 'SHTURM').length },
    pending_new: st('new'),
    last_checked_at: rows.reduce((m, r) => (r.last_checked_at && (!m || r.last_checked_at > m)) ? r.last_checked_at : m, null)
  };
  lostRows.forEach(r => { if (r.resolution && recon.closed[r.resolution] != null) recon.closed[r.resolution]++; });
  const pii = !!q.pii;
  const searchUrl = (r) => (pii && r.phone_norm) ? `https://${q.sub}.amocrm.ru/leads/list/?query=${encodeURIComponent(r.phone_norm.slice(-9))}` : null;
  const lost = lostRows.filter(r => !r.resolution).sort((a, b) => Date.parse(b.created_time) - Date.parse(a.created_time)).map(r => {
    const ph = r.phone_norm || String(r.phone_raw || '').replace(/\D/g, '');
    return { meta_lead_id: String(r.meta_lead_id), created_time: r.created_time, product: r.product || null,
      campaign_name: r.campaign_name || null, form_name: r.form_name || null, ad_name: r.ad_name || null,
      full_name: pii ? (r.full_name || '') : null, answers: pii ? (r.answers || null) : null,
      phone: pii ? (ph || '') : maskTail(ph), phone_tail: ph ? ph.slice(-4) : '',
      lost_reason: r.lost_reason || (r.match_status === 'bad_phone' ? 'bad_phone' : null), match_status: r.match_status,
      recheck_until: r.recheck_until || null, amo_search_url: searchUrl(r) };
  });
  // курс доллара по дням периода
  let rates = {}, fallback = null;
  try { rates = await loadFxRates(); } catch (_) { rates = {}; }
  try {
    const rr = await sbSelect('app_settings', { key: 'eq.mkt_costs', limit: '1' });
    fallback = Number((((rr[0] && rr[0].value) || {}).KG || {}).usd_rate) || null;
  } catch (_) {}
  const days = daysOf(since, until > localIso(Date.now(), 'KG') ? localIso(Date.now(), 'KG') : until);
  const fx = fxByDay(rates, days, fallback);
  if (fx.missing_days.length) incomplete.push({ source: 'db', what: 'fx', detail: 'нет курса доллара за ' + fx.missing_days.length + ' дн.' });
  return { since, until, product, trusted: !!q.trusted, pii, amo_sub: q.sub, fx, recon, lost, errors, incomplete };
}

// ── Закрыть потерянную заявку (кто, чем закончилось) ────────────────────────
// Возвращает { status, body }.
export async function closeLost(body, who) {
  const id = String((body && body.meta_lead_id) || '').trim();
  const resolution = String((body && body.resolution) || '').trim();
  const note = String((body && body.note) || '').trim().slice(0, 500);
  if (!/^\d{6,25}$/.test(id)) return { status: 400, body: { ok: false, error: 'Нужен номер заявки' } };
  if (!RESOLUTIONS.includes(resolution)) return { status: 400, body: { ok: false, error: 'Выберите, чем закончилось' } };
  const patch = { handled_by: who.email, handled_by_name: who.name || who.email, handled_at: new Date().toISOString(), resolution, resolution_note: note || null };
  const upd = await sbUpdate('meta_leads', { meta_lead_id: 'eq.' + id, resolution: 'is.null', match_status: 'in.(not_found,bad_phone)' }, patch);
  if (upd.length) return { status: 200, body: { ok: true, meta_lead_id: id, resolution, handled_by_name: patch.handled_by_name, handled_at: patch.handled_at } };
  const cur = await sbSelect('meta_leads', { select: 'meta_lead_id,match_status,resolution,handled_by_name,handled_at', meta_lead_id: 'eq.' + id, limit: '1' });
  if (!cur.length) return { status: 404, body: { ok: false, error: 'Заявка не найдена' } };
  const c = cur[0];
  if (c.resolution === resolution) return { status: 200, body: { ok: true, already: true, meta_lead_id: id, resolution, handled_by_name: c.handled_by_name, handled_at: c.handled_at } };
  if (c.resolution) return { status: 409, body: { ok: false, error: 'Заявку уже закрыл ' + (c.handled_by_name || 'другой сотрудник'), resolution: c.resolution } };
  return { status: 409, body: { ok: false, error: 'Заявка уже не в списке потерянных', match_status: c.match_status } };
}
