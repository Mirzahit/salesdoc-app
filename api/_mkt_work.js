import './_preview_guard.js'; // v1017: в превью-сборке запись наружу отключена (см. файл)
// v1017: «Не взято в работу» — когда менеджер впервые что-то сделал по новой сделке.
//
// Решения CEO (этап Б Маркетинга):
//   • «взял» = первое действие ЧЕЛОВЕКА по сделке: смена этапа, примечание, задача
//     (поставил или закрыл), исходящий звонок. Человек = created_by ≠ 0: всё, что делает
//     интеграция/робот, в amo записано с created_by 0 (например, ответы формы через 1 с).
//     Входящие звонки и сообщения не считаются — это клиент, а не менеджер.
//   • скорость считаем только в рабочее время: Пн–Пт 9:00–18:00 по Бишкеку, кроме
//     праздников из app_settings.work_holidays. Заявка ночью — отсчёт с утра рабочего дня.
//   • ≤15 мин — норма, ≤60 — поздно, больше — провал.
//   • сделки, которые завёл сам менеджер, взяты в момент создания — в скорость не входят.
//
// Чистые функции (normalizeHolidays, workMinutesBetween, toneOf, firstHumanAction)
// проверяет scripts/mkt-selftest.mjs. Сеть — только detectTaken/buildWork, и только
// через переданный ограничитель amo (ctx.amoFetch).

import { sbSelect, sbSelectAll } from './_supabase.js';
import { normalizePhone } from './_phone.js';

export const WORK_DEFAULT = { startH: 9, endH: 18, offH: 6, days: [1, 2, 3, 4, 5] };
export const NORM_OK_MIN = 15, NORM_LATE_MIN = 60;

// Список праздников: только настоящие даты YYYY-MM-DD, без повторов, по порядку, не больше 300.
export function normalizeHolidays(v) {
  const arr = Array.isArray(v) ? v : (v && Array.isArray(v.days) ? v.days : []);
  const out = new Set();
  for (const x of arr) {
    const s = String(x == null ? '' : x).trim().slice(0, 10);
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) continue;
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    if (d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) continue;
    out.add(s);
  }
  return [...out].sort().slice(0, 300);
}

// Сколько рабочих минут между двумя моментами (мс). Рабочее окно — [startH, endH) местного
// времени (пояс offH) в рабочие дни недели, кроме праздников. end ≤ start → 0.
export function workMinutesBetween(startMs, endMs, holidays, opts) {
  const o = Object.assign({}, WORK_DEFAULT, opts || {});
  const s = Number(startMs), e = Number(endMs);
  if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) return 0;
  const hol = holidays instanceof Set ? holidays : new Set(Array.isArray(holidays) ? holidays : []);
  const off = o.offH * 3600000;
  const dayMs = 86400000;
  // начало местных суток, в которые попал start
  let d0 = Math.floor((s + off) / dayMs) * dayMs - off;
  let total = 0;
  for (let d = d0; d < e; d += dayMs) {
    const local = new Date(d + off);
    const iso = local.toISOString().slice(0, 10);
    if (!o.days.includes(local.getUTCDay()) || hol.has(iso)) continue;
    const ws = d + o.startH * 3600000, we = d + o.endH * 3600000;
    const a = Math.max(ws, s), b = Math.min(we, e);
    if (b > a) total += b - a;
  }
  return Math.round(total / 60000);
}

export function toneOf(min) {
  const v = Number(min);
  if (!Number.isFinite(v)) return null;
  return v <= NORM_OK_MIN ? 'ok' : (v <= NORM_LATE_MIN ? 'mid' : 'bad');
}

// ── Первое действие человека: сборщики + общий выбор самого раннего ─────────
// Каждый сборщик превращает свой источник в список кандидатов [{at, kind, human, by, by_name}]
// (время — секунды unix). Выбор (firstHumanAction) не знает об источниках: сборщик можно
// добавить или поменять, не трогая выбор. Действия до создания сделки не считаются.
// v1017 (утверждено CEO): «тронул» = первое действие человека (created_by ≠ 0) по сделке или её контактам:
//   примечания 'common' и исходящие звонки 'call_out' (любой call_status — недозвон тоже попытка);
//   звонки живут в примечаниях КОНТАКТА (amo_beeline_kg). Входящие 'call_in' не считаются.
//   Плюс смена этапа, задача (поставил человек или закрыта), исходящий WhatsApp (см. collectWhatsapp).
//   Не считаются: created_by 0 (роботы, интеграции, автоназначение, SalesBot), смена ответственного.
export const NOTE_RULES = {
  lead: { common: 'note', call_out: 'call' },    // примечания сделки
  contact: { common: 'note', call_out: 'call' }  // примечания всех контактов сделки
};
export function collectStatus(statusEv) {
  return (statusEv || []).map(ev => ({ at: Number(ev.created_at), kind: 'status', human: !!Number(ev.created_by), by: Number(ev.created_by) || null }));
}
function collectNotes(notes, rules) {
  const out = [];
  (notes || []).forEach(n => {
    const kind = rules[String(n.note_type || '')];
    if (kind) out.push({ at: Number(n.created_at), kind, human: !!Number(n.created_by), by: Number(n.created_by) || null });
  });
  return out;
}
export function collectLeadNotes(notes) { return collectNotes(notes, NOTE_RULES.lead); }
export function collectContactNotes(notes) { return collectNotes(notes, NOTE_RULES.contact); }
export function collectTasks(tasks) {
  const out = [];
  (tasks || []).forEach(tk => {
    out.push({ at: Number(tk.created_at), kind: 'task', human: !!Number(tk.created_by), by: Number(tk.created_by) || null });
    if (tk.is_completed) out.push({ at: Number(tk.updated_at), kind: 'task_done', human: !!Number(tk.responsible_user_id), by: Number(tk.responsible_user_id) || null });
  });
  return out;
}
// Шаблоны автоответов WhatsApp (app_settings.wa_autoreply_templates). Пока строки нет — эти.
export const WA_TEMPLATES_DEFAULT = [
  'Здравствуйте! Спасибо, что написали. Мы скоро ответим.',
  'Здравствуйте. Не смогли принять ваш вызов. Но непременно ответим',
  'Здравствуйте! Хотите узнать подробнее о решении для управления товар'
];
// Сравнение текста с шаблоном: строчные, ё=е, без эмодзи и знаков, пробелы схлопнуты.
export function normWaText(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}\s]+/gu, ' ').replace(/\s+/g, ' ').trim();
}
export function isAutoReply(text, templates) {
  const t = normWaText(text);
  if (!t) return false;
  return (templates || []).some(x => { const n = normWaText(x); return !!n && (t === n || t.startsWith(n)); });
}
// Проверка настройки шаблонов перед записью: список непустых строк ≤300 знаков, не больше 50.
export function validateWaTemplates(v) {
  if (!Array.isArray(v)) return { ok: false, error: 'value должен быть списком строк' };
  const out = [];
  for (const x of v) {
    const s = String(x == null ? '' : x).trim();
    if (!s) continue;
    if (s.length > 300) return { ok: false, error: 'шаблон длиннее 300 знаков' };
    if (!out.includes(s)) out.push(s);
  }
  if (out.length > 50) return { ok: false, error: 'не больше 50 шаблонов' };
  return { ok: true, value: out };
}
export async function loadWaTemplates() {
  try {
    const rows = await sbSelect('app_settings', { key: 'eq.wa_autoreply_templates', limit: '1' });
    const v = rows.length ? validateWaTemplates(rows[0].value) : null;
    return v && v.ok ? v.value : WA_TEMPLATES_DEFAULT;
  } catch (_) { return WA_TEMPLATES_DEFAULT; }
}
// WhatsApp (наша таблица wazzup_events), события номеров контактов сделки. Правило CEO (утверждено,
// включено по умолчанию; выключить — use_whatsapp=0): исходящее
//   • текст совпал с шаблоном автоответа → бот;
//   • authorName пустой → бот Wazzup;
//   • authorName 'Phone' (написали с телефона) → человек, засчитываем ответственному сделки;
//   • иначе authorName — имя сотрудника → человек (если имя совпало с менеджером amo — его id).
// o: { managers: {имя в нижнем регистре: id}, templates: [...], responsibleId }.
export function collectWhatsapp(events, o) {
  const opt = o || {};
  const mgr = opt.managers || {};
  const tpl = opt.templates || WA_TEMPLATES_DEFAULT;
  const out = [];
  (events || []).forEach(e => {
    const at = Math.floor(Date.parse(e.received_at) / 1000);
    if (!Number.isFinite(at)) return;
    if ((e.kind && e.kind !== 'message') || e.direction !== 'out') return;
    const author = String((e.raw && e.raw.authorName) || '').trim();
    const text = e.message_text != null ? e.message_text : (e.raw && e.raw.text);
    let human = true, by = null;
    if (!author || isAutoReply(text, tpl)) human = false;
    else if (author.toLowerCase() === 'phone') by = Number(opt.responsibleId) || null;
    else by = mgr[author.toLowerCase()] != null ? Number(mgr[author.toLowerCase()]) : null;
    out.push({ at, kind: 'whatsapp', human, by, by_name: author || null });
  });
  return out;
}
// Самое раннее действие человека не раньше создания сделки → {at, by, kind, by_name?} или null.
export function firstHumanAction(created, candidates) {
  const c0 = Number(created) || 0;
  let best = null;
  (candidates || []).forEach(x => {
    const t = Number(x && x.at);
    if (!x || !x.human || !Number.isFinite(t) || !t || t < c0) return;
    if (!best || t < best.at) best = { at: t, by: x.by != null ? Number(x.by) : null, kind: x.kind, ...(x.by_name ? { by_name: x.by_name } : {}) };
  });
  return best;
}
// Все сборщики разом по сырым данным одной сделки.
export function candidatesOf(src) {
  const s = src || {};
  return [].concat(collectStatus(s.statusEv), collectLeadNotes(s.notes), collectContactNotes(s.contactNotes), collectTasks(s.tasks),
    s.whatsapp ? collectWhatsapp(s.whatsapp, s.wa) : []);
}

// ── Кто видит телефоны и имена клиентов ─────────────────────────────────────
// Решение CEO: полный номер, имя и ответы формы — только сотруднику с ПОДПИСАННОЙ сессией и ролью
// admin/head/rop/manager, или по админ-коду. Остальным (таргетолог, наблюдатель, вызов по общему
// ключу без сессии) — последние 4 цифры, без имени и ответов. Маскируем на сервере.
export const PII_ROLES = ['admin', 'head', 'rop', 'manager'];
export function piiAllowed(caller, adminOk) {
  if (adminOk) return true;
  return !!(caller && caller.trusted && caller.active !== false && PII_ROLES.includes(String(caller.role || '').toLowerCase()));
}
export function maskTail(p) {
  const d = String(p || '').replace(/\D/g, '');
  return d.length < 4 ? '' : '••• ' + d.slice(-4);
}

export async function loadHolidays() {
  try {
    const rows = await sbSelect('app_settings', { key: 'eq.work_holidays', limit: '1' });
    return normalizeHolidays(rows.length ? rows[0].value : []);
  } catch (_) { return []; }
}

// ── Сеть ────────────────────────────────────────────────────────────────────
// Готовое «взял» не меняется (раньше первого действия ничего не появится) — держим сутки.
// «Ещё не взяли» не храним: спрашиваем заново при каждом построении отчёта.
const _takenCache = new Map();
const TAKEN_TTL_MS = 24 * 3600 * 1000;

// Список по номерам сделок пачками; amo не принял пачку (400) — пробуем по 10.
async function listByIds(ctx, ids, build, key, stats, errors, what) {
  const out = [];
  const run = async (part) => {
    for (let page = 1; page <= 3; page++) {
      stats.requests++;
      const r = await ctx.amoFetch(build(part) + '&limit=250&page=' + page, ctx.env);
      const arr = (r && r._embedded && r._embedded[key]) || [];
      out.push(...arr);
      if (arr.length < 250) break;
      if (page === 3) stats.truncated = true;
    }
  };
  for (let i = 0; i < ids.length; i += 50) {
    const part = ids.slice(i, i + 50);
    try { await run(part); }
    catch (e) {
      if (Number(e.status) === 401 || Number(e.status) === 403) throw e;
      if (Number(e.status) !== 400) { errors.push({ source: 'amo', kind: 'other', message: what + ': ' + String(e.message || e).slice(0, 200) }); stats.failed += part.length; continue; }
      for (let k = 0; k < part.length; k += 10) {
        try { await run(part.slice(k, k + 10)); }
        catch (e2) {
          if (Number(e2.status) === 401 || Number(e2.status) === 403) throw e2;
          errors.push({ source: 'amo', kind: 'other', message: what + ': ' + String(e2.message || e2).slice(0, 200) });
          stats.failed += Math.min(10, part.length - k);
        }
      }
    }
  }
  return out;
}

// Телефоны контактов (для WhatsApp) — пачками по 50 через ограничитель amo, держим сутки.
const _phoneCache = new Map();
async function contactPhones(ctx, cids, stats, errors) {
  const out = new Map(), need = [];
  cids.forEach(c => { const h = _phoneCache.get(ctx.sub + '|' + c); if (h && Date.now() - h.t < TAKEN_TTL_MS) out.set(c, h.v); else need.push(c); });
  for (let i = 0; i < need.length; i += 50) {
    const part = need.slice(i, i + 50);
    try {
      stats.requests++;
      const r = await ctx.amoFetch('/contacts?' + part.map((x, k) => `filter[id][${k}]=${x}`).join('&') + '&limit=250', ctx.env);
      const got = new Set();
      ((r && r._embedded && r._embedded.contacts) || []).forEach(c => {
        const ph = [];
        (c.custom_fields_values || []).forEach(f => { if (String(f.field_code || '') === 'PHONE') (f.values || []).forEach(v => { if (v && v.value) ph.push(String(v.value)); }); });
        out.set(Number(c.id), ph); got.add(Number(c.id)); _phoneCache.set(ctx.sub + '|' + c.id, { t: Date.now(), v: ph });
      });
      part.forEach(c => { if (!got.has(c)) { out.set(c, []); _phoneCache.set(ctx.sub + '|' + c, { t: Date.now(), v: [] }); } });
    } catch (e) {
      if (Number(e.status) === 401 || Number(e.status) === 403) throw e;
      errors.push({ source: 'amo', kind: 'other', message: 'телефоны контактов: ' + String(e.message || e).slice(0, 200) });
    }
  }
  if (_phoneCache.size > 20000) [..._phoneCache.keys()].slice(0, 5000).forEach(k => _phoneCache.delete(k));
  return out;
}

// leads — сделки amo (с _embedded.contacts), sc — история этапов (scanStatusEvents с firstHuman).
// opts: { useWhatsapp, phoneBy: {leadId: phone}, managers: {имя: id}, templates: [...] }.
// Возвращает { taken: Map<id,{at,by,kind}>, requests, errors, incomplete }.
export async function detectTaken(ctx, leads, sc, opts) {
  const o = opts || {};
  const taken = new Map();
  const errors = [], incomplete = [];
  const stats = { requests: 0, failed: 0, truncated: false };
  const ck = (id) => ctx.sub + '|' + (o.useWhatsapp ? 'wa|' : '') + id;
  const todo = [];
  for (const l of leads) {
    const c = _takenCache.get(ck(l.id));
    if (c && Date.now() - c.t < TAKEN_TTL_MS) { taken.set(l.id, c.v); continue; }
    todo.push(l);
  }
  if (todo.length) {
    const ids = todo.map(l => Number(l.id));
    // v1017 (решение CEO): действия по сделке ИЛИ по любому её контакту
    const contactsOf = {};
    todo.forEach(l => { contactsOf[l.id] = [...new Set(((l._embedded && l._embedded.contacts) || []).map(c => Number(c.id)).filter(Boolean))]; });
    const cids = [...new Set(Object.values(contactsOf).flat())];
    const q = (arr) => arr.map(x => 'filter[entity_id][]=' + x).join('&');
    const types = (rules) => Object.keys(rules).map(t => '&filter[note_type][]=' + t).join('');
    const notes = await listByIds(ctx, ids, (p) => '/leads/notes?' + q(p) + types(NOTE_RULES.lead), 'notes', stats, errors, 'примечания сделок');
    const cnotes = cids.length ? await listByIds(ctx, cids, (p) => '/contacts/notes?' + q(p) + types(NOTE_RULES.contact), 'notes', stats, errors, 'звонки контактов') : [];
    const tasks = await listByIds(ctx, ids, (p) => '/tasks?filter[entity_type]=leads&' + q(p), 'tasks', stats, errors, 'задачи');
    // WhatsApp: исходящие из нашей wazzup_events по телефонам контактов сделки (последние 9 цифр)
    const waByTail = new Map();
    const tailsOf = {};
    if (o.useWhatsapp) {
      const phonesByContact = await contactPhones(ctx, cids, stats, errors);
      const full = new Set();
      todo.forEach(l => {
        const t = new Set();
        const add = (raw) => { const d = String(raw || '').replace(/\D/g, ''); if (d.length < 9) return; t.add(d.slice(-9)); full.add(d); const n = normalizePhone(raw); if (n) full.add(n); };
        contactsOf[l.id].forEach(c => (phonesByContact.get(c) || []).forEach(add));
        if (o.phoneBy && o.phoneBy[l.id]) add(o.phoneBy[l.id]);
        tailsOf[l.id] = [...t];
      });
      const phones = [...full];
      const minCreated = todo.reduce((m, l) => Math.min(m, Number(l.created_at) || m), Infinity);
      try {
        for (let i = 0; i < phones.length; i += 100) {
          const rows = await sbSelectAll('wazzup_events', { select: 'id,phone,received_at,direction,kind,message_text,raw',
            phone: 'in.(' + phones.slice(i, i + 100).join(',') + ')', direction: 'eq.out',
            received_at: 'gte.' + new Date(minCreated * 1000).toISOString(), order: 'received_at.asc,id.asc' });
          rows.forEach(r => { const k = String(r.phone || '').replace(/\D/g, '').slice(-9); if (!waByTail.has(k)) waByTail.set(k, []); waByTail.get(k).push(r); });
        }
      } catch (e) { incomplete.push({ source: 'db', what: 'whatsapp', detail: 'переписки WhatsApp не загрузились' }); }
    }
    const byLead = (arr, idOf) => { const m = new Map(); arr.forEach(x => { const k = Number(idOf(x)); if (!m.has(k)) m.set(k, []); m.get(k).push(x); }); return m; };
    const notesBy = byLead(notes, n => n.entity_id);
    const cnotesBy = byLead(cnotes, n => n.entity_id);
    const tasksBy = byLead(tasks, t => t.entity_id);
    const fh = (sc && sc.firstHuman) || new Map();
    todo.forEach(l => {
      const st = fh.get(Number(l.id));
      const wa = o.useWhatsapp ? (tailsOf[l.id] || []).flatMap(t => waByTail.get(t) || []) : null;
      const r = firstHumanAction(l.created_at, candidatesOf({
        statusEv: st ? [{ created_at: st.at, created_by: st.by }] : [],
        notes: notesBy.get(Number(l.id)) || [],
        contactNotes: contactsOf[l.id].flatMap(c => cnotesBy.get(c) || []),
        tasks: tasksBy.get(Number(l.id)) || [],
        whatsapp: wa,
        wa: { managers: o.managers, templates: o.templates, responsibleId: l.responsible_user_id }
      }));
      if (r) { taken.set(l.id, r); _takenCache.set(ck(l.id), { t: Date.now(), v: r }); }
    });
    if (_takenCache.size > 5000) { const old = [..._takenCache.keys()].slice(0, 1000); old.forEach(k => _takenCache.delete(k)); }
  }
  if (stats.failed) incomplete.push({ source: 'amo', what: 'actions', detail: 'не проверены действия по сделкам: ' + stats.failed });
  if (stats.truncated) incomplete.push({ source: 'amo', what: 'actions', detail: 'действия просмотрены не полностью' });
  return { taken, requests: stats.requests, errors, incomplete };
}

// Отчёт «Не взято в работу» за период. ctx: { env, sub, country, amoFetch, fetchUsers, periodBase, now }.
// opts: { useWhatsapp } (по умолчанию включён). Полный номер лежит в скрытом поле _phone — наружу его отдаёт только
// applyWorkPii (по правам вызывающего), поэтому сам отчёт можно держать в общем кэше.
export async function buildWork(ctx, fromTs, toTs, opts) {
  const o = opts || {};
  const errors = [], incomplete = [];
  const now = ctx.now ? ctx.now() : Date.now();
  const base = await ctx.periodBase(fromTs, toTs);
  if (base.error) return { error: base.error };
  errors.push(...(base.ar.errors || [])); incomplete.push(...(base.ar.incomplete || []));
  const sc = base.sc;
  if (sc.error) {
    if (Number(sc.error.status) === 401 || Number(sc.error.status) === 403) throw sc.error;
    errors.push({ source: 'amo', kind: 'other', message: 'история этапов: ' + String(sc.error.message || sc.error).slice(0, 200) });
  }
  const holidays = await loadHolidays();
  const holSet = new Set(holidays);
  const users = await ctx.fetchUsers(incomplete);
  const toS = toTs || Math.floor(now / 1000);
  // Только сделки, которые завела интеграция (created_by 0), созданные в периоде, и не «возврат клиента».
  const items = base.ar.items.filter(x => x.lead.pipeline_id === base.p.id && !Number(x.lead.created_by)
    && x.arrival.arrival_kind !== 'return' && Number(x.lead.created_at) >= fromTs && Number(x.lead.created_at) <= toS);
  const leads = items.map(x => x.lead);

  // Телефон: из заявки Meta, иначе из рекламного касания.
  const phoneBy = {};
  try {
    const ids = leads.map(l => Number(l.id));
    for (let i = 0; i < ids.length; i += 150) {
      const rows = await sbSelect('meta_leads', { select: 'amo_lead_id,phone_norm', amo_lead_id: 'in.(' + ids.slice(i, i + 150).join(',') + ')' });
      rows.forEach(r => { if (r.phone_norm && !phoneBy[r.amo_lead_id]) phoneBy[r.amo_lead_id] = r.phone_norm; });
    }
  } catch (e) { incomplete.push({ source: 'db', what: 'phones', detail: 'телефоны заявок не загрузились' }); }
  items.forEach(x => { if (!phoneBy[x.lead.id] && x.arrival.touch && x.arrival.touch.phone) phoneBy[x.lead.id] = x.arrival.touch.phone; });

  const managers = {};
  Object.keys(users || {}).forEach(id => { const n = String(users[id] || '').trim().toLowerCase(); if (n) managers[n] = Number(id); });
  const useWa = o.useWhatsapp !== false;
  const templates = useWa ? await loadWaTemplates() : null;
  const det = await detectTaken(ctx, leads, sc, { useWhatsapp: useWa, phoneBy, managers, templates });
  errors.push(...det.errors); incomplete.push(...det.incomplete);

  const out = {};
  const mgr = new Map();
  items.forEach(x => {
    const l = x.lead;
    const r = det.taken.get(l.id);
    const createdMs = Number(l.created_at) * 1000;
    const row = { taken_at: null, taken_by: null, taken_by_name: null, taken_kind: null, reaction_wmin: null, wait_wmin: null, tone: null };
    if (r) {
      row.taken_at = r.at; row.taken_by = r.by; row.taken_kind = r.kind;
      row.taken_by_name = r.by ? (users[r.by] || ('id ' + r.by)) : (r.by_name || null);
      row.reaction_wmin = workMinutesBetween(createdMs, r.at * 1000, holSet);
      row.tone = toneOf(row.reaction_wmin);
      const uid = Number(l.responsible_user_id) || 0;
      if (!mgr.has(uid)) mgr.set(uid, { responsible_user_id: uid, name: users[uid] || (uid ? 'id ' + uid : 'Без ответственного'), n: 0, sum: 0 });
      const m = mgr.get(uid); m.n++; m.sum += row.reaction_wmin;
    } else {
      row.wait_wmin = workMinutesBetween(createdMs, now, holSet);
      row.tone = toneOf(row.wait_wmin);
    }
    const ph = String(phoneBy[l.id] || '').replace(/\D/g, '');
    if (ph) { row.phone_masked = maskTail(ph); Object.defineProperty(row, '_phone', { value: ph, enumerable: false }); }
    out[l.id] = row;
  });
  const mgrList = [...mgr.values()].map(m => ({ responsible_user_id: m.responsible_user_id, name: m.name, n: m.n,
    avg_reaction_wmin: m.n ? Math.round(m.sum / m.n) : null })).sort((a, b) => b.n - a.n);
  return {
    country: ctx.country, from: fromTs, to: toTs || null, now: Math.floor(now / 1000),
    work: { start: '09:00', end: '18:00', tz: 6, holidays },
    norms: { ok: NORM_OK_MIN, late: NORM_LATE_MIN },
    sources: { whatsapp: o.useWhatsapp !== false },
    leads: out, managers: mgrList,
    scanned: { leads: items.length, requests: det.requests },
    errors, incomplete
  };
}
// Копия отчёта для конкретного вызывающего: pii — добавляем полный номер (phone), иначе только «••• 1234».
export function applyWorkPii(data, pii) {
  const leads = {};
  Object.keys(data.leads || {}).forEach(id => {
    const r = data.leads[id];
    const c = Object.assign({}, r);
    if (pii && r._phone) c.phone = r._phone;
    leads[id] = c;
  });
  return Object.assign({}, data, { leads, pii: !!pii });
}
