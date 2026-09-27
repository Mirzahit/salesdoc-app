// v1006 «Финансист»: мозг вкладки. Claude через API Anthropic, только с сервера.
//
// Ключ: только ANTHROPIC_API_KEY_FINANSIST (CEO 27.09.2026: без него агент честно пишет, что не подключён; запасного ключа нет).
// Модель: claude-opus-5-5. Дневной лимит расходов — app_settings.finansist_agent_limits.daily_usd
// (по умолчанию 2 $): при 70% лимита агент предупреждает и отвечает коротко, при превышении модель не зовёт.
//
// Инструменты — только чтение рабочих таблиц через _finansist_core (страна KG зашита, период обязателен
// и не длиннее 400 дней, выборки ≤ 200 строк). Писать агент может только в свои таблицы:
// finansist_questions (ask_question), finansist_missing_data.note (note_missing_data), finansist_decisions
// (record_decision). До оплат, клиентов и расходов доступа на запись нет.
//
// Контекст чата: последние 12 сообщений + активные решения + сводка открытых вопросов — не вся история,
// иначе стоимость росла бы каждый месяц. Инструкция и инструменты кэшируются на час.

import fs from 'node:fs';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { sbSelect, sbInsert, sbUpsert, sbUpdate, sbDelete } from './_supabase.js';
import * as C from './_finansist_core.js';

export const MODEL = 'claude-opus-5-5';
const PRICE = { input: 4, output: 20, cache_read: 0.2, cache_write: 5 }; // $ за 1M токенов
const MAX_ROUNDS = 8;
const NEAR_LIMIT_SHARE = 0.7; // с этой доли лимита — короткие ответы и предупреждение
const HISTORY_MESSAGES = 12;

function apiKey() { return (process.env.ANTHROPIC_API_KEY_FINANSIST || '').trim(); }
let _client = null;
const CHAT_DEADLINE_MS = 240000;
export function client() { if (!apiKey()) throw new Error('Не задан ключ ANTHROPIC_API_KEY_FINANSIST'); if (!_client) _client = new Anthropic({ apiKey: apiKey(), maxRetries: 2, timeout: 120000 }); return _client; }

export function costOf(u) {
  if (!u) return 0;
  return ((u.input_tokens || 0) * PRICE.input + (u.output_tokens || 0) * PRICE.output + (u.cache_read_input_tokens || 0) * PRICE.cache_read + (u.cache_creation_input_tokens || 0) * PRICE.cache_write) / 1e6;
}
function addUsage(acc, u) { if (!u) return acc; ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'].forEach(k => { acc[k] = (acc[k] || 0) + (u[k] || 0); }); return acc; }

let _agents = null;
function agentConfig() {
  if (!_agents) _agents = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'api', 'agents.json'), 'utf8'));
  const a = _agents.agents && _agents.agents.finansist;
  if (!a) throw new Error('В api/agents.json нет записи finansist');
  return a;
}

// ---------- лимит ----------
export async function limitState() {
  const day = C.bishkekIso();
  const [lim, sp] = await Promise.all([C.getAgentLimits(), C.getSpend(day)]);
  return { day, daily_usd: lim.daily_usd, spent_usd: sp.usd, exhausted: sp.usd >= lim.daily_usd, near: sp.usd >= lim.daily_usd * NEAR_LIMIT_SHARE };
}
export function limitMessage(st) { return 'Дневной лимит расходов на агента исчерпан: ' + st.spent_usd.toFixed(2) + ' $ из ' + st.daily_usd + ' $. Завтра продолжим. Цифры на странице считаются без меня и остаются актуальными.'; }

// ---------- инструменты ----------
const PERIOD = { from: { type: 'string', description: 'Начало периода, YYYY-MM-DD' }, to: { type: 'string', description: 'Конец периода включительно, YYYY-MM-DD' } };
export const TOOLS = [
  { name: 'get_summary', description: 'Сводка за период: выручка по статьям и счетам, расходы по статьям, зарплаты, общие расходы, прибыль, доля зарплат, пометка «прибыль неполная» и почему. Первый инструмент для любого вопроса про деньги.', input_schema: { type: 'object', properties: PERIOD, required: ['from', 'to'], additionalProperties: false }, strict: true },
  { name: 'get_payments', description: 'Строки оплат за период с фильтрами. До 200 строк, сортировка по дате.', input_schema: { type: 'object', properties: Object.assign({}, PERIOD, { category: { type: ['string', 'null'], description: 'implementation|integration|subscription|license|revision|extra|other' }, bank: { type: ['string', 'null'], description: 'license|services|cash|other|none — нормализованный счёт' }, manager: { type: ['string', 'null'], description: 'имя менеджера как в оплате' }, client: { type: ['string', 'null'], description: 'часть названия клиента' }, limit: { type: ['integer', 'null'], description: 'до 200' } }), required: ['from', 'to', 'category', 'bank', 'manager', 'client', 'limit'], additionalProperties: false }, strict: true },
  { name: 'get_expenses', description: 'Строки расходов за период из таблицы расходов плюс суммы, внесённые бухгалтером вручную (source=manual). Переносы между счетами исключены.', input_schema: { type: 'object', properties: Object.assign({}, PERIOD, { category: { type: ['string', 'null'], description: 'часть названия статьи' }, query: { type: ['string', 'null'], description: 'часть примечания' } }), required: ['from', 'to', 'category', 'query'], additionalProperties: false }, strict: true },
  { name: 'get_team', description: 'Рентабельность людей за период: выручка по менеджеру, его зарплата (ЗП, бонусы, отпускные, аванс по имени в примечании; Гульшан — по правилу), разница. Общие расходы на людей не делятся; в поле departments — отделы (Продажи, Поддержка, Интеграция, Администрация): зарплаты, распределённые расходы (прямые статьи и доля офиса/аренды/воды по числу людей), выручка и итог; налоги, банк и прочее — undistributed.', input_schema: { type: 'object', properties: PERIOD, required: ['from', 'to'], additionalProperties: false }, strict: true },
  { name: 'get_disputes', description: 'Спорные оплаты за период: bank (не тот счёт), dup (возможный дубль). Правила декад нет — дни клиентам иногда дарят сознательно.', input_schema: { type: 'object', properties: Object.assign({}, PERIOD, { type: { type: ['string', 'null'], description: 'bank|dup или null' } }), required: ['from', 'to', 'type'], additionalProperties: false }, strict: true },
  { name: 'get_churn', description: 'Отток за месяц: ушедшие и отказавшиеся клиенты с потерей в месяц, новая выручка в месяц, выгрузка биллинга если есть.', input_schema: { type: 'object', properties: { month: { type: 'string', description: 'YYYY-MM' } }, required: ['month'], additionalProperties: false }, strict: true },
  { name: 'get_client', description: 'Карточка клиента по части названия: статус, даты биллинга, куратор, последние 12 оплат.', input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false }, strict: true },
  { name: 'get_cash', description: 'Касса: введённый остаток, средние поступления в день за 90 дней, ожидаемые продления, просрочка, расходы по образцу прошлого месяца.', input_schema: { type: 'object', properties: { days: { type: ['integer', 'null'], description: '7–90, по умолчанию 30' } }, required: ['days'], additionalProperties: false }, strict: true },
  { name: 'get_missing_data', description: 'Обязательные статьи месяца (аренда, amo, реклама, телефония, WhatsApp, вода, такси, сим-карты): что найдено, чего нет, что резко отличается, что внесено вручную.', input_schema: { type: 'object', properties: { month: { type: 'string', description: 'YYYY-MM' } }, required: ['month'], additionalProperties: false }, strict: true },
  { name: 'get_prepaid', description: 'Предоплаченные расходы (например amoCRM за 6 месяцев): сумма, срок, доля в месяц. Такие оплаты в расходах разнесены равными долями по месяцам срока.', input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false }, strict: true },
  { name: 'get_decisions', description: 'Прошлые решения владельца и бухгалтера (ответы на вопросы и договорённости из чата). Не задавать вопросы, на которые уже есть решение.', input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false }, strict: true },
  { name: 'compare_periods', description: 'Две сводки рядом с разницей в сомах и процентах.', input_schema: { type: 'object', properties: { a_from: { type: 'string' }, a_to: { type: 'string' }, b_from: { type: 'string' }, b_to: { type: 'string' } }, required: ['a_from', 'a_to', 'b_from', 'b_to'], additionalProperties: false }, strict: true },
  { name: 'ask_question', description: 'Вынести спорное на решение владельца: создать вопрос во вкладке «Вопросы агента». Только когда решение нельзя принять по правилам. Ключ устойчивый — повтор с тем же ключом обновит вопрос.', input_schema: { type: 'object', properties: { month: { type: 'string', description: 'YYYY-MM' }, key: { type: 'string', description: 'короткий устойчивый ключ, латиница' }, type: { type: 'string', description: 'bank|dup|dec|missing|goal|other' }, title: { type: 'string' }, body: { type: 'string', description: 'объяснение с цифрами и откуда они' }, options: { type: 'array', items: { type: 'string' }, description: '2–3 варианта ответа' }, amount: { type: ['number', 'null'] } }, required: ['month', 'key', 'type', 'title', 'body', 'options', 'amount'], additionalProperties: false }, strict: true },
  { name: 'note_missing_data', description: 'Дописать пояснение к недостающей статье месяца: какую цифру и у кого взять.', input_schema: { type: 'object', properties: { month: { type: 'string' }, item_key: { type: 'string', description: 'rent|amo|ads|telephony|whatsapp|water|taxi|sim' }, note: { type: 'string' } }, required: ['month', 'item_key', 'note'], additionalProperties: false }, strict: true },
  { name: 'record_decision', description: 'Запомнить решение, которое владелец или бухгалтер явно приняли в чате, чтобы применять его дальше и не спрашивать снова.', input_schema: { type: 'object', properties: { key: { type: 'string', description: 'короткий устойчивый ключ, латиница' }, text: { type: 'string', description: 'решение одной фразой' } }, required: ['key', 'text'], additionalProperties: false }, strict: true },
];

function isoOk(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !isNaN(Date.parse(s)); }
function period(from, to) {
  if (!isoOk(from) || !isoOk(to)) throw new Error('период: даты в формате YYYY-MM-DD');
  if (to < from) throw new Error('период: to раньше from');
  if (from < '2025-01-01') throw new Error('данные есть с 2025-01-01');
  if (C.daysBetween(from, to) > 400) throw new Error('период не длиннее 400 дней');
  return { from, to };
}
function monthsIn(from, to) { const out = []; let k = from.slice(0, 7); while (k <= to.slice(0, 7)) { out.push(k); k = C.shiftMonthKey(k, 1); } return out; }
// rows — по месяцу работы (для прибыли и команды; зарплата аванс+остаток), cash — по дате выплаты (строки таблицы)
async function expensesFor(from, to) {
  const keys = monthsIn(from, to);
  const byMonth = await C.loadExpenses(keys);
  const rows = [], cash = [], seen = new Set(), seenCash = new Set(); const missingMonths = [];
  keys.forEach(k => { const m = byMonth[k]; if (!m || !m.available) { missingMonths.push(k); return; } m.rows.forEach(e => { if (C.isTransfer(e)) return; if (keys.indexOf(e.work_month) >= 0 && !seen.has(e.id)) { seen.add(e.id); rows.push(e); } if (e.date >= from && e.date <= to && !seenCash.has(e.id)) { seenCash.add(e.id); cash.push(e); } }); });
  return { rows, cash, byMonth, keys, missingMonths };
}
async function summaryFor(from, to) {
  const base = await C.loadBase();
  const ex = await expensesFor(from, to);
  const s = C.periodSummary(base, { from, to }, ex.rows.length ? ex.rows : null);
  // неполнота: открытые недостающие статьи в месяцах периода
  const miss = await sbSelect('finansist_missing_data', { country: 'eq.' + C.COUNTRY, limit: '500' });
  const open = miss.filter(r => ex.keys.indexOf(r.month) >= 0 && (r.status === 'missing' || r.status === 'odd'));
  s.by_category_ru = Object.fromEntries(Object.entries(s.by_category).map(([k, v]) => [C.CAT_RU[k] || k, C.round(v)]));
  s.by_bank_ru = Object.fromEntries(Object.entries(s.by_bank).map(([k, v]) => [C.BANK_LABELS[k] || k, C.round(v)]));
  s.expenses_months_without_data = ex.missingMonths;
  s.profit_incomplete = open.length > 0 || ex.missingMonths.length > 0;
  s.missing_estimate = open.filter(r => r.status === 'missing' && r.expected_amount && !(C.EXPECTED_ITEMS.find(i => i.key === r.item_key) || {}).track_last).reduce((a, r) => a + C.num(r.expected_amount), 0); // прибыль завышена примерно на эту сумму; вода «по последней покупке» не в счёт
  // как посчитаны расходы и выплачена ли зарплата — иначе модель гадает («остаток ещё не выплачен», «по дате выплаты»)
  s.expenses_basis = 'Зарплата — по месяцу работы: аванс и остаток за месяц, даже если остаток выплачен в следующем месяце. Пока остаток не выплачен, вместо него стоит ожидаемая зарплата (expected_salary_rows: по окладу, «Моему доходу», у Жибек 1 000 $ по курсу, без оклада — по прошлому месяцу), прибыль такого месяца — «ожидаемая». Прочие расходы — по месяцу листа. Выручка — по дате оплаты.';
  s.salary_state = ex.keys.map(k => Object.assign({ month: k }, C.salaryState(ex.byMonth, k)));
  s.salary_pending_months = s.salary_state.filter(x => x.pending).map(x => x.month); // пока не пусто — прибыль этих месяцев предварительная
  s.profit_incomplete_reasons = open.map(r => r.month + ': ' + r.item_label + ' — ' + (r.status === 'missing' ? 'нет строки' : 'сумма резко отличается')).concat(ex.missingMonths.map(m => m + ': расходов в таблице нет'));
  return s;
}
function rounded(o) { return JSON.parse(JSON.stringify(o, (k, v) => typeof v === 'number' && !Number.isInteger(v) ? Math.round(v * 100) / 100 : v)); }

export async function runTool(name, input, ctx) {
  input = input || {};
  switch (name) {
    case 'get_summary': { const p = period(input.from, input.to); return summaryFor(p.from, p.to); }
    case 'get_payments': {
      const p = period(input.from, input.to); const base = await C.loadBase();
      let rows = base.payments.filter(x => C.inRange(x, p));
      if (input.category) rows = rows.filter(x => x.category === input.category);
      if (input.bank) rows = rows.filter(x => C.bankKey(x.bank) === input.bank);
      if (input.manager) rows = rows.filter(x => String(x.manager_name || '').toLowerCase().indexOf(String(input.manager).toLowerCase()) >= 0);
      if (input.client) rows = rows.filter(x => String(x.company_name || '').toLowerCase().indexOf(String(input.client).toLowerCase()) >= 0);
      const total = rows.reduce((a, x) => a + C.num(x.amount), 0);
      const lim = Math.min(200, Math.max(1, input.limit || 100));
      return { total_rows: rows.length, total_amount: C.round(total), shown: Math.min(lim, rows.length), rows: rows.slice(0, lim).map(x => ({ date: x.paid_at, client: x.company_name, category: x.category, category_raw: x.category_raw, amount: C.num(x.amount), qty: x.qty, price: x.price, months: x.period_months, bank: x.bank, manager: x.manager_name })) };
    }
    case 'get_expenses': {
      const p = period(input.from, input.to); const ex = await expensesFor(p.from, p.to);
      let rows = ex.cash;
      if (input.category) rows = rows.filter(e => String(e.category).toLowerCase().indexOf(String(input.category).toLowerCase()) >= 0);
      if (input.query) rows = rows.filter(e => String(e.note).toLowerCase().indexOf(String(input.query).toLowerCase()) >= 0);
      const byCat = {}; rows.forEach(e => { byCat[e.category] = (byCat[e.category] || 0) + C.num(e.amount); });
      return { total_rows: rows.length, total_amount: C.round(rows.reduce((a, e) => a + C.num(e.amount), 0)), by_category: rounded(byCat), months_without_data: ex.missingMonths, shown: Math.min(200, rows.length), rows: rows.slice(0, 200).map(e => ({ date: e.date, category: e.category, note: e.note, amount: e.amount, bank: e.bank, source: e.source, kind: e.kind, part: e.part || null, work_month: e.work_month })) };
    }
    case 'get_team': { const p = period(input.from, input.to); const base = await C.loadBase(); const ex = await expensesFor(p.from, p.to); const team = C.teamRows(base, p, ex.rows.length ? ex.rows : null); const single = ex.keys.length === 1; if (single) await C.enrichTeamPay(team, base.employees, ex.keys[0]); return rounded(Object.assign(team, { months_without_expenses: ex.missingMonths, salary_state: single ? C.salaryState(ex.byMonth, ex.keys[0]) : ex.keys.map(k => Object.assign({ month: k }, C.salaryState(ex.byMonth, k))) })); }
    case 'get_disputes': {
      const p = period(input.from, input.to); const base = await C.loadBase(); const d = C.findDisputes(base.payments, p);
      let list = d.list; if (input.type) list = list.filter(x => x.issues.some(i => i.type === input.type));
      return { counts: d.counts, total: d.list.length, payments_in_period: base.payments.filter(x => C.inRange(x, p)).length, rows: list.slice(0, 200).map(x => ({ date: x.paid_at, client: x.company_name, category: x.category, amount: x.amount, bank: x.bank, manager: x.manager_name, issues: x.issues })) };
    }
    case 'get_churn': { const r = C.monthKeyToRange(input.month); if (!r) throw new Error('month: YYYY-MM'); const base = await C.loadBase(); return rounded(await C.churnForMonth(base, r)); }
    case 'get_client': {
      const q = String(input.query || '').toLowerCase().trim(); if (q.length < 2) throw new Error('query: минимум 2 символа');
      const base = await C.loadBase();
      const cl = base.clients.filter(c => String(c.company_name || '').toLowerCase().indexOf(q) >= 0 || String(c.client_id || '').toLowerCase() === q).slice(0, 5);
      return { found: cl.length, clients: cl.map(c => ({ client_id: c.client_id, company_name: c.company_name, city: c.city, status: c.status, access_until: c.access_until, access_status: c.access_status, next_billing_at: c.next_billing_at, period_months: c.subscription_period_months, pay_reason: c.pay_reason, pay_reason_note: c.pay_reason_note, support_operator: c.support_operator, curator_operator: c.curator_operator, payments: base.payments.filter(p => p.client_id === c.client_id || C.normName(p.company_name) === C.normName(c.company_name)).slice(0, 12).map(p => ({ date: p.paid_at, category: p.category, amount: C.num(p.amount), qty: p.qty, price: p.price, months: p.period_months, bank: p.bank, manager: p.manager_name })) })) };
    }
    case 'get_cash': {
      const base = await C.loadBase(); const cf = C.cashForecast(base, input.days || 30);
      const bal = await sbSelect('finansist_settings', { key: 'eq.balance_' + C.COUNTRY, limit: '1' });
      const prevKey = C.shiftMonthKey(C.currentMonthKey(), -1); const ex = await C.loadExpenses([prevKey]); const prevRows = C.expenseRows(ex, prevKey) || [];
      return rounded({ balance: bal[0] ? Object.assign({}, bal[0].value, { updated_by: bal[0].updated_by_name || bal[0].updated_by, updated_at: bal[0].updated_at }) : null, daily_avg_90: cf.daily_avg_90, inflow_90: cf.inflow_90, expected_30: cf.expected_30, expected_60: cf.expected_60, expected_90: cf.expected_90, overdue_count: cf.overdue_count, overdue_est: cf.overdue_est, expected_next: cf.expected.slice(0, 40), last_month_expenses_total: prevRows.reduce((a, e) => a + C.num(e.amount), 0), last_month_expenses_by_category: C.expenseSummary(prevRows).shared_by_category, last_month_salaries: C.expenseSummary(prevRows).salary_total });
    }
    case 'get_missing_data': {
      const key = input.month; if (!C.parseMonth(key)) throw new Error('month: YYYY-MM');
      const keys = [3, 2, 1, 0, -1, -2, -3, -4, -5, -6].map(k => C.shiftMonthKey(key, k)).filter(k => k <= C.currentMonthKey()); const byMonth = await C.loadExpenses(keys);
      const r = await C.syncMissing(byMonth, key);
      return rounded({ month: key, incomplete: r.incomplete, items: r.check.map(it => Object.assign({}, it, { found_rows: it.found_rows.slice(0, 10), saved: (r.items.find(x => x.item_key === it.item_key) || null) })) });
    }
    case 'get_prepaid': { const items = await C.loadPrepaid(); return { count: items.length, items: items.map(e => ({ id: e.id, label: e.label, item_key: e.item_key, amount: e.amount, start: e.start, end: C.prepaidEnd(e), months: e.months, per_month: C.prepaidShare(e), added_by: e.added_by_name || e.added_by })) }; }
    case 'get_decisions': { const d = await C.loadDecisions(); return { count: d.length, decisions: d.map(x => ({ key: x.key, text: x.text, source: x.source, month: x.month, by: x.decided_by_name || x.decided_by, at: x.created_at })) }; }
    case 'compare_periods': {
      const a = period(input.a_from, input.a_to), b = period(input.b_from, input.b_to);
      const [sa, sb] = await Promise.all([summaryFor(a.from, a.to), summaryFor(b.from, b.to)]);
      const diff = {}; ['revenue', 'expenses', 'salaries', 'shared', 'profit'].forEach(k => { if (sa[k] != null && sb[k] != null) diff[k] = { a: C.round(sa[k]), b: C.round(sb[k]), delta: C.round(sb[k] - sa[k]), pct: sa[k] ? Math.round((sb[k] - sa[k]) / Math.abs(sa[k]) * 1000) / 10 : null }; });
      const notes = [];
      const kgSince = C.INTEGRATORS_PAID_FROM_KG_SINCE;
      if ((a.from.slice(0, 7) < kgSince) !== (b.from.slice(0, 7) < kgSince) || (a.to.slice(0, 7) < kgSince) !== (b.to.slice(0, 7) < kgSince)) notes.push('Интеграция: до ' + kgSince + ' интеграторам платили из Казахстана, в расходах KG их нет — эту статью между периодами напрямую не сравнивать.');
      return rounded({ a: sa, b: sb, diff, notes });
    }
    case 'ask_question': {
      if (!C.parseMonth(input.month)) throw new Error('month: YYYY-MM');
      const opts = (input.options || []).map(String).filter(Boolean).slice(0, 3); if (opts.length < 2) throw new Error('нужно 2–3 варианта');
      const existing = await sbSelect('finansist_questions', { country: 'eq.' + C.COUNTRY, month: 'eq.' + input.month, key: 'eq.' + input.key, limit: '1' });
      if (existing[0] && existing[0].status !== 'open') return { ok: false, reason: 'на этот вопрос уже ответили: ' + (existing[0].answer_text || existing[0].status) };
      const row = { country: C.COUNTRY, month: input.month, key: String(input.key).slice(0, 120), type: input.type || 'other', title: String(input.title).slice(0, 200), body: String(input.body).slice(0, 2000), options: opts, amount: input.amount == null ? null : C.num(input.amount), status: 'open', updated_at: new Date().toISOString() };
      const rows = await sbUpsert('finansist_questions', row, 'country,month,key');
      return { ok: true, id: rows[0] && rows[0].id };
    }
    case 'note_missing_data': {
      const rows = await sbSelect('finansist_missing_data', { country: 'eq.' + C.COUNTRY, month: 'eq.' + input.month, item_key: 'eq.' + input.item_key, limit: '1' });
      if (!rows[0]) return { ok: false, reason: 'такой недостающей статьи за месяц нет' };
      await sbUpdate('finansist_missing_data', { id: 'eq.' + rows[0].id }, { note: String(input.note).slice(0, 500), updated_at: new Date().toISOString() });
      return { ok: true };
    }
    case 'record_decision': { const d = await C.saveDecision(input.key, input.text, 'chat', null, ctx && ctx.email, ctx && ctx.name); return { ok: true, key: d && d.key }; }
    default: throw new Error('неизвестный инструмент ' + name);
  }
}

// ---------- системный промпт ----------
function dynamicContext(decisions, openQuestions, missing) {
  const today = C.bishkekIso();
  const R = C.currentRules();
  const lines = ['Сегодня ' + C.fmtDay(today) + ' ' + today.slice(0, 4) + ' (Бишкек). Текущий месяц ' + C.currentMonthKey() + '. Валюта — сом, страна — Кыргызстан.',
    'Настройки правил: интеграторам ' + R.integrators_kzt + ' тенге в месяц, допуск ' + R.integrators_tolerance_pct + '%; безопасный остаток на счетах — ' + (R.safe_balance == null ? 'не задан' : R.safe_balance + ' сом') + '; владелец в примечаниях расходов — ' + (R.owner_names || []).join(', ') + '.'];
  if (decisions.length) { lines.push('Действующие решения владельца и бухгалтера (применяй, не переспрашивай):'); decisions.slice(0, 30).forEach(d => lines.push('- ' + d.text + (d.month ? ' (' + d.month + ')' : ''))); }
  if (openQuestions.length) { lines.push('Открытые вопросы во вкладке «Вопросы агента» (' + openQuestions.length + '), не дублируй их:'); openQuestions.slice(0, 40).forEach(q => lines.push('- [' + q.month + '] ' + q.key + ' — ' + q.title + (q.amount ? ' (' + Math.round(q.amount) + ' сом)' : ''))); }
  if (missing && missing.length) { lines.push('Незакрытые недостающие данные: ' + missing.map(m => m.month + ' ' + m.item_label + ' (' + (m.status === 'missing' ? 'нет строки' : 'сумма отличается') + ')').join('; ') + '. Прибыль за эти месяцы неполная — говори об этом.'); }
  return lines.join('\n');
}

async function contextBundle() {
  await C.loadRules();
  const [decisions, openQ, missing] = await Promise.all([
    C.loadDecisions(),
    sbSelect('finansist_questions', { country: 'eq.' + C.COUNTRY, status: 'eq.open', order: 'created_at.desc', limit: '40', select: 'month,key,title,amount' }),
    sbSelect('finansist_missing_data', { country: 'eq.' + C.COUNTRY, status: 'in.(missing,odd)', order: 'month.desc', limit: '30' }),
  ]);
  return { decisions, openQ, missing };
}

// ---------- один ход чата ----------
export async function chatTurn(text, caller) {
  const st = await limitState();
  const userRow = { country: C.COUNTRY, role: 'user', content: String(text).slice(0, 4000), author_email: caller.email, author_name: caller.name || null, created_at: new Date().toISOString() };
  await sbInsert('finansist_chat_messages', userRow);
  if (st.exhausted) { const a = await saveAssistant(limitMessage(st), null, null, 0); return { reply: a, limit: st }; }
  if (!apiKey()) { const a = await saveAssistant('Агент не подключён: на сервере нет ключа ANTHROPIC_API_KEY_FINANSIST. Цифры на странице считаются без него.', null, null, 0); return { reply: a, limit: st }; }

  const cfg = agentConfig();
  const [hist, ctx] = await Promise.all([
    sbSelect('finansist_chat_messages', { country: 'eq.' + C.COUNTRY, order: 'created_at.desc', limit: String(HISTORY_MESSAGES + 1) }),
    contextBundle(),
  ]);
  const messages = hist.slice().reverse().filter(m => m.content).map(m => ({ role: m.role, content: m.content }));
  if (!messages.length || messages[messages.length - 1].role !== 'user') messages.push({ role: 'user', content: userRow.content });
  while (messages.length && messages[0].role !== 'user') messages.shift();
  // подряд идущие одинаковые роли API склеивает сам

  const near = st.near;
  const system = [
    { type: 'text', text: cfg.system_prompt, cache_control: { type: 'ephemeral', ttl: '1h' } },
    { type: 'text', text: dynamicContext(ctx.decisions, ctx.openQ, ctx.missing) + (near ? '\n\nДневной лимит расходов на тебя почти исчерпан (' + st.spent_usd.toFixed(2) + ' $ из ' + st.daily_usd + ' $). Отвечай коротко: одна-две фразы с цифрой, не больше двух инструментов, и в конце одной строкой предупреди, что лимит на сегодня почти исчерпан.' : '') },
  ];
  const usage = {}; const trace = []; let finalText = ''; let spentNow = 0;
  const day = st.day; let spentToday = st.spent_usd;
  // Общий предел на ответ: Vercel обрывает запрос через 300 с, а модель иногда отвечает минутами (27.09 локально — 577 с).
  const t0 = Date.now(); const SLOW = 'Модель сейчас отвечает медленно, ответ не успел собраться. Спросите ещё раз через минуту.';
  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (spentToday >= st.daily_usd) { finalText = (finalText ? finalText + '\n\n' : '') + limitMessage({ spent_usd: spentToday, daily_usd: st.daily_usd }); break; }
    const left = CHAT_DEADLINE_MS - (Date.now() - t0); if (left < 15000) { finalText = SLOW; break; }
    let resp;
    try { resp = await client().messages.create({ model: cfg.model || MODEL, max_tokens: near ? 1200 : (cfg.max_tokens || 4000), system, tools: TOOLS, messages, output_config: { effort: near ? 'low' : (cfg.effort || 'medium') } }, { timeout: left, maxRetries: left > 90000 ? 1 : 0 }); }
    catch (e) { if (/timeout|timed out|abort/i.test(String(e && (e.name + ' ' + e.message)))) { finalText = SLOW; break; } throw e; }
    addUsage(usage, resp.usage); const c = costOf(resp.usage); spentNow += c; spentToday += c;
    const textParts = resp.content.filter(b => b.type === 'text').map(b => b.text);
    const toolUses = resp.content.filter(b => b.type === 'tool_use');
    if (resp.stop_reason === 'refusal') { finalText = 'Не могу ответить на этот запрос.'; break; }
    if (!toolUses.length) { finalText = textParts.join('\n').trim(); if (resp.stop_reason === 'max_tokens') finalText += '\n\n(ответ обрезан по длине)'; break; }
    messages.push({ role: 'assistant', content: resp.content });
    const results = [];
    for (const tu of toolUses) {
      let out; let isErr = false;
      try { out = await runTool(tu.name, tu.input, caller); } catch (e) { out = { error: String(e && e.message || e) }; isErr = true; }
      trace.push({ tool: tu.name, input: tu.input, ok: !isErr });
      let s = JSON.stringify(out); if (s.length > 60000) s = s.slice(0, 60000) + '…(обрезано)';
      results.push({ type: 'tool_result', tool_use_id: tu.id, content: s, is_error: isErr });
    }
    messages.push({ role: 'user', content: results });
    if (round === MAX_ROUNDS - 1) finalText = (textParts.join('\n') || 'Слишком много шагов для одного вопроса. Уточните, что именно посмотреть.').trim();
  }
  if (spentNow > 0) { try { await C.addSpend(day, spentNow); } catch (e) { console.error('[finansist-agent] spend:', e.message); } }
  const a = await saveAssistant(finalText || 'Не получилось сформулировать ответ.', trace, usage, spentNow, cfg.model || MODEL);
  return { reply: a, usage, cost_usd: spentNow, limit: { day, daily_usd: st.daily_usd, spent_usd: spentToday } };
}

async function saveAssistant(text, trace, usage, cost, model) {
  const rows = await sbInsert('finansist_chat_messages', { country: C.COUNTRY, role: 'assistant', content: text, tool_trace: trace || null, model: model || null, input_tokens: usage ? (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0) : null, output_tokens: usage ? usage.output_tokens || 0 : null, cost_usd: cost != null ? Math.round(cost * 10000) / 10000 : null, created_at: new Date().toISOString() });
  return rows[0];
}

// ---------- обход месяца: расхождения + недостающие → вопросы ----------
const OPTIONS = {
  bank: ['Ошибка в счёте', 'Ошибка в статье', 'Так и должно быть'],
  dup: ['Это дубль, разберусь в оплатах', 'Разные платежи'],
  miss: ['Удалить из программы', 'Строку вернут в таблицу'],
  missing: ['Внесу сумму', 'Такой статьи в этом месяце нет'],
  odd: ['Всё верно', 'Проверю с Гульшан'],
  superseded: ['Понятно'],
  prepaid_end: ['Продлили — добавлю новую предоплату', 'Больше не платим'],
  owner_over: ['Знаю, так и задумано', 'Верну часть в компанию'],
  pay_less: ['Так и должно быть', 'Недоплатили — доплатим', 'Поправлю оклад'],
  pay_more: ['Это бонус', 'Переплата', 'Поправлю оклад'],
  no_advance: ['Аванс не давали', 'Внесём аванс в таблицу'],
  wrong_sheet: ['Перенесу на нужный лист', 'Так и должно быть'],
  oklad_missing: ['Впишу оклад на «Правилах и целях»', 'Оклада нет, плачу по факту'],
  tax_penalty: ['Знаю, уже закрыли', 'Разберёмся с Гульшан'],
  owner_other: ['Изъятие владельца', 'Расход компании'],
  water_supplier: ['Сверю с поставщиком', 'Воду покупаем не каждый месяц'],
  prepaid_renew: ['Продлим', 'Не будем продлевать'],
  fx_over: ['Так и должно быть', 'Разберусь с конвертацией'],
  low_balance: ['Знаю', 'Сократим расходы', 'Ускорим оплаты клиентов'],
};
function candidates(monthKey, disputes, missingSync, opts_prepaid) {
  const out = [];
  const seenPairs = new Set();
  disputes.list.forEach(p => {
    const seen = {};
    p.issues.forEach(i => {
      if (seen[i.type]) return; seen[i.type] = 1;
      if (i.type === 'dup' && i.pair) { if (seenPairs.has(i.pair)) return; seenPairs.add(i.pair); }
      const key = i.type === 'dup' && i.pair ? 'dup:' + i.pair : i.type + ':' + p.id;
      const fact = C.fmtDay(p.paid_at) + ', ' + p.company_name + ', ' + (C.CAT_RU[p.category] || p.category) + ', ' + C.round(p.amount) + ' сом, счёт «' + (p.bank || '—') + '», менеджер ' + (p.manager_name || '—') + '. ' + i.text + (i.type === 'dup' ? ' (одна пара — один вопрос)' : '');
      out.push({ key, type: i.type, amount: p.amount, fact, options: OPTIONS[i.type], evidence: { payment_id: p.id, date: p.paid_at, client: p.company_name, category: p.category, amount: p.amount, bank: p.bank, manager: p.manager_name, issue: i.text } });
    });
  });
  (missingSync.items || []).forEach(r => {
    if (r.status === 'missing' || r.status === 'odd') out.push({ key: r.status + ':' + r.item_key, type: 'missing', amount: r.status === 'odd' ? r.found_amount : r.expected_amount, fact: r.note, options: OPTIONS[r.status], evidence: { item_key: r.item_key, status: r.status, found_amount: r.found_amount, expected_amount: r.expected_amount } });
  });
  (opts_prepaid || []).forEach(e => { if (e.renew_date && monthKey === C.shiftMonthKey(String(e.renew_date).slice(0, 7), -1)) out.push({ key: 'prepaid_renew:' + e.id + ':' + e.renew_date, type: 'other', kind: 'prepaid_renew', amount: e.amount, fact: '«' + e.label + '» оплачен до ' + C.fmtDay(e.renew_date) + ' ' + String(e.renew_date).slice(0, 4) + '. Продлеваем?', options: OPTIONS.prepaid_renew, evidence: { prepaid_id: e.id, renew_date: e.renew_date } }); });
  (opts_prepaid || []).forEach(e => { if (e.renew_date) return; const endKey = C.prepaidEnd(e); if (monthKey === C.shiftMonthKey(endKey, 1)) out.push({ key: 'prepaid_end:' + e.id, type: 'other', amount: e.amount, fact: 'Предоплата «' + e.label + '» ' + C.round(e.amount) + ' сом за ' + e.months + ' мес. закончилась в ' + C.monthLabel(endKey) + '. Продлили или больше не платим?', options: OPTIONS.prepaid_end, evidence: { prepaid_id: e.id, label: e.label, amount: e.amount, start: e.start, months: e.months } }); });
  (missingSync.changes || []).forEach(ch => { if (ch.type === 'superseded') out.push({ key: 'superseded:' + ch.item.item_key + ':' + monthKey, type: 'missing', amount: ch.prev.amount, fact: 'Ручная сумма ' + C.round(ch.prev.amount) + ' сом по статье «' + ch.item.item_label + '» больше не учитывается: в таблице появилась настоящая строка на ' + C.round(ch.item.found_amount) + ' сом.', options: OPTIONS.superseded, evidence: { item_key: ch.item.item_key, manual: ch.prev.amount, found: ch.item.found_amount } }); });
  return out;
}
const FALLBACK_TITLE_MORE = { advance_date: 'Аванс: за какой месяц?', oklad_missing: 'Какой у вас оклад?', owner_other: 'Изъятие или расход компании?', water_supplier: 'Сверить доставки воды с поставщиком', prepaid_renew: 'Подписка скоро кончается', tax_penalty: 'Появилась пеня по налогам', pay_less: 'Выплата меньше оклада', pay_more: 'Выплата больше оклада — бонус?', no_advance: 'Аванс не найден', wrong_sheet: 'Строка не на своём листе', fx_over: 'Ушло больше, чем нужно по курсу' };
const FALLBACK_TITLE = { bank: 'Оплата не на том счёте', dup: 'Похоже на двойную запись', miss: 'Оплаты нет в таблице «Доходы»', missing: 'Не хватает данных по расходам', other: 'Предоплата закончилась', owner: 'Изъято больше, чем заработано', balance: 'Остаток ниже безопасного' };

// Изъятие владельца с начала квартала против прибыли за тот же период + остаток на счетах против безопасного.
// Прибыль берём только за месяцы, где есть расходы (иначе сравнивать не с чем).
async function ownerAndBalanceChecks(base, monthKey, byMonthHint) {
  const out = [];
  const m = C.parseMonth(monthKey); const qStartMo = Math.floor((m.mo - 1) / 3) * 3 + 1; const q = Math.floor((m.mo - 1) / 3) + 1;
  const keys = []; for (let mo = qStartMo; mo <= m.mo; mo++) keys.push(m.y + '-' + C.pad2(mo));
  const byMonth = await C.loadExpenses(keys);
  let profit = 0, draws = 0, months = 0;
  keys.forEach(k => { const rows = C.expenseRows(byMonth, k); if (!rows) return; const s = C.periodSummary(base, C.monthKeyToRange(k), rows); profit += s.profit; draws += s.owner_draws; months++; });
  if (months && draws > 0 && draws > profit) out.push({ key: 'owner_over:' + m.y + '-Q' + q, type: 'other', kind: 'owner', amount: draws, fact: 'С начала ' + q + '-го квартала ' + m.y + ' изъято ' + C.round(draws) + ' сом, а прибыль за те же месяцы ' + C.round(profit) + ' сом. Изъято на ' + C.round(draws - profit) + ' сом больше, чем заработано.', options: OPTIONS.owner_over, evidence: { quarter: m.y + '-Q' + q, months: keys, draws: C.round(draws), profit: C.round(profit) } });
  const R = C.currentRules();
  if (R.safe_balance != null) {
    const bal = await sbSelect('finansist_settings', { key: 'eq.balance_' + C.COUNTRY, limit: '1' });
    const b = bal[0] && bal[0].value && bal[0].value.balance;
    if (b != null && b < R.safe_balance) out.push({ key: 'low_balance:' + (bal[0].value.entered_at || C.bishkekIso()), type: 'other', kind: 'balance', amount: b, fact: 'Остаток на счетах ' + C.round(b) + ' сом (введён ' + C.fmtDay(bal[0].value.entered_at || '') + '), это ниже безопасного ' + C.round(R.safe_balance) + ' сом' + (draws > 0 ? '. Изъятие владельца с начала квартала — ' + C.round(draws) + ' сом.' : '.'), options: OPTIONS.low_balance, evidence: { balance: b, safe_balance: R.safe_balance, draws_qtd: C.round(draws) } });
  }
  return out;
}

export async function sweepMonth(monthKey, opts) {
  opts = opts || {};
  await C.loadRules(true); // решения по «Прочему» владельца и оклады — свежие
  const base = await C.loadBase(true);
  const range = C.monthKeyToRange(monthKey);
  const disputes = C.findDisputes(base.payments, range);
  const keys = [3, 2, 1, 0, -1, -2, -3, -4, -5, -6].map(k => C.shiftMonthKey(monthKey, k)).filter(k => k <= C.currentMonthKey());
  const byMonth = await C.loadExpenses(keys, { force: !!opts.force });
  const missingSync = await C.syncMissing(byMonth, monthKey);
  const prepaid = await C.loadPrepaid();
  const cands = candidates(monthKey, disputes, missingSync, prepaid);
  (await ownerAndBalanceChecks(base, monthKey, byMonth)).forEach(c => cands.push(c));
  (await payAndSheetChecks(base, monthKey, byMonth)).forEach(c => cands.push(c));
  const existing = await sbSelect('finansist_questions', { country: 'eq.' + C.COUNTRY, month: 'eq.' + monthKey, limit: '500' });
  const exMap = {}; existing.forEach(q => { exMap[q.key] = q; });
  const decisions = await C.loadDecisions();
  const decided = new Set(decisions.map(d => d.key));
  const fresh = cands.filter(c => !exMap[c.key] && !decided.has(c.key));
  const now = new Date().toISOString();
  // исчезнувшие расхождения — закрываем
  const candKeys = new Set(cands.map(c => c.key));
  let closed = 0;
  for (const q of existing) if (q.status === 'open' && /^pay_(less|more):/.test(q.key) && q.month < C.PAY_CHECK_FROM) { await sbUpdate('finansist_questions', { id: 'eq.' + q.id }, { status: 'dismissed', answer_text: 'До начала сверки окладов', updated_at: now }); closed++; q.status = 'dismissed'; }
  for (const q of existing) if (q.status === 'open' && q.key.startsWith('owner_other:') && (C.currentRules().owner_other || {})[q.key.slice(12)]) { const d = C.currentRules().owner_other[q.key.slice(12)]; await sbUpdate('finansist_questions', { id: 'eq.' + q.id }, { status: 'dismissed', answer_text: d === 'owner' ? 'Решение принято: изъятие владельца' : 'Решение принято: расход компании', updated_at: now }); closed++; q.status = 'dismissed'; }
  for (const q of existing) if (q.status === 'open' && q.key.startsWith('dec:')) { await sbUpdate('finansist_questions', { id: 'eq.' + q.id }, { status: 'dismissed', answer_text: 'Проверка по декадам отключена', updated_at: now }); closed++; }
  for (const q of existing) if (q.status === 'open' && !candKeys.has(q.key) && !q.key.startsWith('superseded:') && !q.key.startsWith('prepaid_end:') && !q.key.startsWith('prepaid_renew:') && q.key !== 'water_supplier' && q.type !== 'goal' && (q.type !== 'other' || /^(owner_over|low_balance|pay_less|pay_more|fx_over|owner_other|tax_penalty):/.test(q.key))) { await sbUpdate('finansist_questions', { id: 'eq.' + q.id }, { status: 'dismissed', answer_text: 'Расхождение исчезло само', updated_at: now }); closed++; }
  // обновляем сумму/доказательства у открытых
  // у открытых обновляем сумму, доказательства и текст (если текст шаблонный — равен прошлому факту)
  for (const c of cands) { const q = exMap[c.key]; if (q && q.status === 'open') { const keepModel = !!(q.evidence && q.evidence.model_text); const patch = { amount: c.amount == null ? null : C.round(c.amount), evidence: Object.assign({}, c.evidence, keepModel ? { model_text: true } : {}), updated_at: now }; if (q.body !== c.fact && !keepModel) patch.body = c.fact; await sbUpdate('finansist_questions', { id: 'eq.' + q.id }, patch); } }

  let texts = {}; let usage = null; let cost = 0; let modelUsed = false;
  if (fresh.length) {
    const st = await limitState();
    if (!st.exhausted && apiKey()) {
      const cfg = agentConfig();
      // пачками по 10 фактов: на 30 фактах ответ модели обрезался по длине и тексты терялись, а деньги списывались
      let spentNow = st.spent_usd; usage = {};
      for (let i = 0; i < fresh.length; i += 10) {
        if (spentNow >= st.daily_usd) break;
        const chunk = fresh.slice(i, i + 10);
        try {
          const ask = 'Сформулируй вопросы владельцу по фактам ниже. На каждый факт — короткий заголовок (до 60 знаков) и объяснение в 1–2 предложения с цифрами из факта, без выводов сверх фактов, по-русски, на «вы». Имена людей пиши как в факте. Если факт начинается с «Вопрос для <Имя>», обращайся прямо к этому человеку на «вы»: заголовок начни с «<Имя>, …», в тексте не пиши «уточните у <Имя>». Если в факте сказано уточнить у Гульшан — напиши «Уточните у Гульшан» один раз, без оборотов вроде «этот вопрос также уточняется». Верни ТОЛЬКО JSON-массив объектов {"key","title","body"} для всех ключей.\n\n' + chunk.map(c => 'key=' + c.key + ' | тип=' + c.type + ' | ' + c.fact).join('\n');
          const resp = await client().messages.create({ model: cfg.model || MODEL, max_tokens: 6000, system: [{ type: 'text', text: cfg.system_prompt, cache_control: { type: 'ephemeral', ttl: '1h' } }], messages: [{ role: 'user', content: ask }], output_config: { effort: 'low' } }, { timeout: 90000, maxRetries: 1 });
          addUsage(usage, resp.usage); const c1 = costOf(resp.usage); cost += c1; spentNow += c1; modelUsed = true;
          if (resp.stop_reason === 'max_tokens') console.error('[finansist-agent] sweep model: ответ обрезан, пачка ' + i);
          const txt = resp.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
          const mm = txt.match(/\[[\s\S]*\]/);
          if (mm) { try { JSON.parse(mm[0]).forEach(x => { if (x && x.key) texts[x.key] = { title: String(x.title || '').slice(0, 200), body: String(x.body || '').slice(0, 2000) }; }); } catch (pe) { console.error('[finansist-agent] sweep model JSON:', pe.message); } }
          if (c1 > 0) await C.addSpend(st.day, c1);
        } catch (e) { console.error('[finansist-agent] sweep model:', e.message); }
      }
    }
  }
  let created = 0;
  for (const c of fresh) {
    const t = texts[c.key] || {};
    await sbUpsert('finansist_questions', { country: C.COUNTRY, month: monthKey, key: c.key, type: c.type, title: t.title || FALLBACK_TITLE_MORE[c.kind] || FALLBACK_TITLE[c.kind] || FALLBACK_TITLE[c.type] || 'Вопрос', body: t.body || c.fact, options: c.options, evidence: Object.assign({}, c.evidence, t.body ? { model_text: true } : {}), amount: c.amount == null ? null : C.round(c.amount), status: 'open', created_at: now, updated_at: now }, 'country,month,key');
    created++;
  }
  return { month: monthKey, candidates: cands.length, created, closed, missing: missingSync.items, missing_changes: missingSync.changes, disputes: disputes.counts, model_used: modelUsed, cost_usd: cost, usage };
}

// Ответ на вопрос: статус + решение, чтобы агент не спрашивал снова
export async function answerQuestion(id, idx, caller) {
  const rows = await sbSelect('finansist_questions', { id: 'eq.' + id, limit: '1' });
  const q = rows[0]; if (!q) throw new Error('вопрос не найден');
  const opts = Array.isArray(q.options) ? q.options : []; const text = opts[idx]; if (text == null) throw new Error('нет такого варианта');
  const now = new Date().toISOString();
  await sbUpdate('finansist_questions', { id: 'eq.' + id }, { status: 'answered', answer_idx: idx, answer_text: text, answered_by: caller.email, answered_by_name: caller.name || null, answered_at: now, updated_at: now });
  await C.saveDecision(q.key, q.title + ' — ' + text, 'question', q.month, caller.email, caller.name);
  if (q.key.startsWith('advance_date:') && q.evidence && q.evidence.row_key) { const cur = Object.assign({}, (await C.loadRules(true)).advance_month || {}); cur[q.evidence.row_key] = idx === 0 ? q.evidence.sheet_month : q.evidence.date_month; await C.saveRules({ advance_month: cur }); }
  // v1011: оплата пропала из листа — удаляем из программы только по ответу и только если пометка ещё стоит
  if (q.key.startsWith('miss:') && idx === 0) { const pid = q.key.slice(5); const pr = await sbSelect('payments', { id: 'eq.' + pid, select: 'id,sheet_missing_at', limit: '1' }); if (pr[0] && pr[0].sheet_missing_at) await sbDelete('payments', { id: 'eq.' + pid }); }
  if (q.key.startsWith('owner_other:')) { const key = q.key.slice('owner_other:'.length); const cur = Object.assign({}, (await C.loadRules(true)).owner_other || {}); cur[key] = idx === 0 ? 'owner' : 'company'; await C.saveRules({ owner_other: cur }); }
  return { ok: true };
}

// Выплаты людям (после того как зарплата за месяц выплачена), аванс не найден, строка не на своём листе, курс интеграторам.
async function payAndSheetChecks(base, monthKey, byMonth) {
  const out = [];
  const R = C.currentRules();
  const ss = C.salaryState(byMonth, monthKey);
  const rows = C.expenseRows(byMonth, monthKey);
  if (rows && !ss.pending) {
    const team = C.teamRows(base, C.monthKeyToRange(monthKey), rows);
    await C.enrichTeamPay(team, base.employees, monthKey);
    team.rows.forEach(r => {
      if (!r.pay_check) return;
      const k = r.pay_check.direction === 'less' ? 'pay_less' : 'pay_more';
      const parts = r.parts || {};
      const fact = r.expected_kind === 'usd'
        ? 'Зарплата ' + r.name + ' за ' + C.monthLabel(monthKey) + ': ' + (r.pay_rows || []).filter(x => x.part === 'advance' || x.part === 'rest').map(x => (x.part === 'advance' ? 'аванс ' : 'остаток ') + C.round(x.amount) + ' сом ' + C.fmtDay(x.date)).join(' + ') + ' = ' + C.round(r.fact_for_check) + ' сом ≈ ' + String(r.usd_paid).replace('.', ',') + ' $ по курсу Нацбанка на даты выплат. Оклад ' + C.round(r.usd_expected) + ' $. ' + (k === 'pay_less' ? 'Меньше' : 'Больше') + ' на ' + String(Math.abs(r.pay_check.pct)).replace('.', ',') + '% при допуске ' + (R.integrators_tolerance_pct || 3) + '%' + (k === 'pay_more' ? ' — возможно, бонус.' : '.')
        : 'Зарплата ' + r.name + ' за ' + C.monthLabel(monthKey) + ': аванс ' + C.round(parts.advance) + ' + остаток ' + C.round(parts.rest) + (r.expected_kind === 'calc' && parts.bonus ? ' + бонус ' + C.round(parts.bonus) : '') + ' = ' + C.round(r.fact_for_check) + ' сом. Ожидалось ' + C.round(r.expected) + ' (' + r.expected_note + '). ' + (k === 'pay_less' ? 'Меньше на ' + C.round(-r.pay_check.diff) + ' сом.' : 'Больше на ' + C.round(r.pay_check.diff) + ' сом — возможно, бонус.');
      out.push({ key: k + ':' + monthKey + ':' + r.person_key, type: 'other', kind: k, amount: Math.abs(r.pay_check.diff), fact, options: OPTIONS[k], evidence: { person: r.name, month: monthKey, parts, expected: r.expected, expected_note: r.expected_note, fact: r.fact_for_check } });
    });
  }
  const s = C.expenseSummary(rows || []);
  ss.no_advance.forEach(name => { const p = Object.values(s.salaries).find(x => x.name === name); out.push({ key: 'no_advance:' + monthKey + ':' + (p ? p.key : name), type: 'missing', kind: 'no_advance', amount: p ? p.rest : null, fact: 'У ' + name + ' за ' + C.monthLabel(monthKey) + ' есть остаток «за вычетом аванса»' + (p ? ' на ' + C.round(p.rest) + ' сом' : '') + ', а самого аванса за этот месяц в таблице нет. Уточнить у Гульшан.', options: OPTIONS.no_advance, evidence: { person: name, month: monthKey } }); });
  // строки не на своём листе (дата одного месяца, лист другого)
  const seen = new Set();
  (byMonth[monthKey] && byMonth[monthKey].rows || []).forEach(e => {
    if (e.source !== 'sheet' || e.kind !== 'salary' || !e.sheet_month || String(e.date).slice(0, 7) === e.sheet_month) return; // только зарплатные строки: по ним месяц решает дата
    if (C.isAdvanceDateSuspect(e)) return; // аванс с датой следующего месяца — отдельный вопрос про опечатку в дате
    const key = 'wrong_sheet:' + e.sheet_month + ':' + e.date + ':' + C.round(e.amount); if (seen.has(key)) return; seen.add(key);
    const dm = C.parseMonth(String(e.date).slice(0, 7)), sm = C.parseMonth(e.sheet_month);
    out.push({ key, type: 'missing', kind: 'wrong_sheet', amount: e.amount, fact: 'Строка «' + e.note + '» на ' + C.round(e.amount) + ' сом от ' + C.fmtDay(e.date) + ' записана на лист «' + C.MONTHS_RU[sm.mo - 1] + '». Считаю её ' + (e.part === 'advance' ? 'авансом' : 'расходом') + ' за ' + C.monthLabel(e.work_month || String(e.date).slice(0, 7)) + '. Перенесите строку на лист «' + C.MONTHS_RU[dm.mo - 1] + '» и ведите там остальные строки этого месяца.', options: OPTIONS.wrong_sheet, evidence: { date: e.date, note: e.note, amount: e.amount, sheet: e.sheet_month } });
  });
  // Аванс на листе месяца с датой следующего месяца (CEO 27.09.2026, Элиза): вопрос Гульшан — опечатка в дате или аванс следующего месяца.
  // Пока ответа нет, аванс считается за месяц листа (так у всех: аванс 10 000 + остаток «за вычетом аванса» 50 000).
  const advSeen = new Set();
  (byMonth[monthKey] && byMonth[monthKey].rows || []).forEach(e => {
    if (!C.isAdvanceDateSuspect(e) || e.sheet_month !== monthKey) return;
    const rk = C.advanceRowKey(e); if (advSeen.has(rk) || (R.advance_month || {})[rk]) return; advSeen.add(rk);
    const cls = C.classifyExpense(e); const sm = C.parseMonth(e.sheet_month), dm = C.parseMonth(String(e.date).slice(0, 7));
    const who = cls.person ? cls.person.charAt(0).toUpperCase() + cls.person.slice(1) : 'сотрудника';
    const restRows = (C.expenseRows(byMonth, monthKey) || []).filter(x => x.kind === 'salary' && x.part === 'rest' && C.classifyExpense(x).person_key === cls.person_key);
    const rest = restRows.reduce((a, x) => a + C.num(x.amount), 0);
    const typoDay = String(e.date).slice(8, 10) + '.' + C.pad2(sm.mo);
    out.push({ key: 'advance_date:' + rk, type: 'missing', kind: 'advance_date', amount: e.amount, fact: 'Вопрос для Гульшан. ' + who + ': ' + (rest ? 'остаток за ' + C.monthLabel(monthKey) + ' ' + C.round(rest) + ' сом «за вычетом аванса», ' : '') + 'аванса с датой ' + C.MONTHS_RU_GEN[sm.mo - 1] + ' нет, а на листе «' + C.MONTHS_RU[sm.mo - 1] + '» есть строка «' + e.note + '» от ' + C.fmtDay(e.date) + ' на ' + C.round(e.amount) + ' сом. Это аванс за ' + C.MONTHS_RU[sm.mo - 1].toLowerCase() + ' с датой ' + typoDay + ' или за ' + C.MONTHS_RU[dm.mo - 1].toLowerCase() + '? Пока считаю его авансом за ' + C.MONTHS_RU[sm.mo - 1].toLowerCase() + '.', options: ['Аванс за ' + C.MONTHS_RU[sm.mo - 1].toLowerCase() + ', дата ' + typoDay, 'Аванс за ' + C.MONTHS_RU[dm.mo - 1].toLowerCase()], evidence: { row_key: rk, sheet_month: e.sheet_month, date_month: String(e.date).slice(0, 7), date: e.date, note: e.note, amount: e.amount, rest } });
  });
  // Оклад не задан (CEO 27.09.2026: Гульшан — вопрос ей самой). Один раз на человека, в текущем месяце; пока нет — ожидаемая по прошлому месяцу.
  if (monthKey === C.currentMonthKey()) {
    const people = await C.payPeople(byMonth, base.employees, monthKey);
    const recent = new Set(); const prevK = C.shiftMonthKey(monthKey, -1); // только те, кому платили в этом или прошлом месяце (Арслан ушёл в июле — не спрашиваем)
    Object.values(byMonth).forEach(m => (m.rows || []).forEach(e => { if (e.kind === 'salary' && e.source !== 'expected' && (e.work_month === monthKey || e.work_month === prevK)) recent.add(C.classifyExpense(e).person_key); }));
    for (const pp of people) {
      if (!recent.has(pp.key) || pp.manager || pp.oklad != null || pp.oklad_usd != null || C.isOwnerName(pp.name)) continue;
      const asked = await sbSelect('finansist_questions', { country: 'eq.' + C.COUNTRY, key: 'eq.oklad_missing:' + pp.key, limit: '1' });
      if (asked.length && asked[0].month !== monthKey) continue;
      out.push({ key: 'oklad_missing:' + pp.key, type: 'missing', kind: 'oklad_missing', amount: null, fact: 'Вопрос для ' + pp.name + '. Какой у вас оклад в месяц? Без оклада выплаты не с чем сравнить, а пока месяц не закрыт, ваша зарплата в прибыли берётся по выплате за прошлый месяц.', options: OPTIONS.oklad_missing, evidence: { person: pp.name, person_key: pp.key } });
    }
  }
  // «Прочее» с именем владельца без решения — один вопрос на ключ похожести (пока нет ответа — расход компании)
  const oo = {};
  (C.expenseRows(byMonth, monthKey) || []).forEach(e => { const k = C.classifyExpense(e); if (!k.owner_other || k.owner_decided || k.kind === 'owner') return; (oo[k.owner_other] = oo[k.owner_other] || []).push(e); });
  for (const key of Object.keys(oo)) {
    const other = await sbSelect('finansist_questions', { country: 'eq.' + C.COUNTRY, key: 'eq.owner_other:' + key, status: 'eq.open', limit: '5' });
    if (other.some(q => q.month !== monthKey)) continue; // уже спрашиваем в другом месяце
    const rows = oo[key]; const sum = rows.reduce((a, e) => a + C.num(e.amount), 0);
    out.push({ key: 'owner_other:' + key, type: 'other', kind: 'owner_other', amount: sum, fact: 'Статья «Прочее» с именем владельца за ' + C.monthLabel(monthKey) + ': ' + rows.map(e => '«' + e.note + '» ' + C.round(e.amount)).join(', ') + ' — всего ' + C.round(sum) + ' сом. Это изъятие владельца или расход компании? Ответ запомню для похожих строк («' + key + '»). Пока считаю расходом компании.', options: OPTIONS.owner_other, evidence: { similarity_key: key, rows: rows.map(e => ({ date: e.date, note: e.note, amount: e.amount })) } });
  }
  // вода: разовый вопрос сверить доставки с поставщиком (один на всё время)
  const water = C.checkMissing(byMonth, monthKey).find(i => i.item_key === 'water');
  if (water && monthKey === C.currentMonthKey()) {
    const asked = await sbSelect('finansist_questions', { country: 'eq.' + C.COUNTRY, key: 'eq.water_supplier', limit: '1' });
    if (!asked.length || asked[0].month === monthKey) {
      const hist = Object.keys(byMonth).filter(k => k <= monthKey).sort().map(k => { const s = (byMonth[k].rows || []).filter(e => e.source !== 'manual' && (e.work_month || k) === k && /(^|[^а-яё])вод[аыу]([^а-яё]|$)|кулер/i.test(String(e.category) + ' ' + String(e.note))).reduce((a, e) => a + C.num(e.amount), 0); return C.monthLabel(k) + ' — ' + (s ? C.round(s) + ' сом' : 'нет'); });
      out.push({ key: 'water_supplier', type: 'missing', kind: 'water_supplier', amount: null, fact: 'Вода в таблице встречается не каждый месяц: ' + hist.join('; ') + '. Сверьте с поставщиком воды, сколько доставок было за последние полгода — чтобы понять, это реальная периодичность или пропуски в записи.', options: OPTIONS.water_supplier, evidence: { history: hist } });
    }
  }
  // пени по налогам — по месяцу выплаты
  C.expenseSummary(C.cashRows(byMonth, monthKey) || []).tax_penalties.forEach(t => {
    out.push({ key: 'tax_penalty:' + t.date + ':' + C.round(t.amount), type: 'other', kind: 'tax_penalty', amount: t.amount, fact: C.fmtDay(t.date) + ' заплачена пеня ' + C.round(t.amount) + ' сом («' + t.note + '»). Пеня — это просрочка налога: за что она и закрыта ли причина?', options: OPTIONS.tax_penalty, evidence: t });
  });
  // курс: оплаты интеграторам в месяц выплаты
  const rates = await C.loadFxRates();
  C.fxChecks(C.cashRows(byMonth, monthKey) || [], rates).forEach(f => {
    if (f.status !== 'over') return;
    out.push({ key: 'fx_over:' + f.date + ':' + C.round(f.fact), type: 'other', kind: 'fx_over', amount: f.fact - f.expected, fact: 'Интеграторам ' + C.fmtDay(f.date) + ' ушло ' + C.round(f.fact) + ' сом. По курсу Нацбанка на ' + C.fmtDay(f.rate_date) + ' (' + String(f.rate).replace('.', ',') + ' сом за тенге) за ' + C.round(R.integrators_kzt) + ' тенге нужно ' + C.round(f.expected) + ' сом. Больше на ' + String(f.pct).replace('.', ',') + '% при допуске ' + R.integrators_tolerance_pct + '%.', options: OPTIONS.fx_over, evidence: f });
  });
  return out;
}
