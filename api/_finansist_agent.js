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
import { sbSelect, sbInsert, sbUpsert, sbUpdate } from './_supabase.js';
import * as C from './_finansist_core.js';

export const MODEL = 'claude-opus-5-5';
const PRICE = { input: 4, output: 20, cache_read: 0.2, cache_write: 5 }; // $ за 1M токенов
const MAX_ROUNDS = 8;
const NEAR_LIMIT_SHARE = 0.7; // с этой доли лимита — короткие ответы и предупреждение
const HISTORY_MESSAGES = 12;

function apiKey() { return (process.env.ANTHROPIC_API_KEY_FINANSIST || '').trim(); }
let _client = null;
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
  { name: 'get_team', description: 'Рентабельность людей за период: выручка по менеджеру, его зарплата (ЗП, бонусы, отпускные, аванс по имени в примечании; Гульшан — по правилу), разница. Общие расходы отдельно, на людей не делятся.', input_schema: { type: 'object', properties: PERIOD, required: ['from', 'to'], additionalProperties: false }, strict: true },
  { name: 'get_disputes', description: 'Спорные оплаты за период: bank (не тот счёт), dup (возможный дубль), dec (правило декад — «проверить», не ошибка).', input_schema: { type: 'object', properties: Object.assign({}, PERIOD, { type: { type: ['string', 'null'], description: 'bank|dup|dec или null' } }), required: ['from', 'to', 'type'], additionalProperties: false }, strict: true },
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
async function expensesFor(from, to) {
  const keys = monthsIn(from, to);
  const byMonth = await C.loadExpenses(keys);
  const rows = []; const missingMonths = [];
  keys.forEach(k => { const m = byMonth[k]; if (!m || !m.available) { missingMonths.push(k); return; } m.rows.forEach(e => { if (!C.isTransfer(e) && e.date >= from && e.date <= to) rows.push(e); }); });
  return { rows, byMonth, keys, missingMonths };
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
      let rows = ex.rows;
      if (input.category) rows = rows.filter(e => String(e.category).toLowerCase().indexOf(String(input.category).toLowerCase()) >= 0);
      if (input.query) rows = rows.filter(e => String(e.note).toLowerCase().indexOf(String(input.query).toLowerCase()) >= 0);
      const byCat = {}; rows.forEach(e => { byCat[e.category] = (byCat[e.category] || 0) + C.num(e.amount); });
      return { total_rows: rows.length, total_amount: C.round(rows.reduce((a, e) => a + C.num(e.amount), 0)), by_category: rounded(byCat), months_without_data: ex.missingMonths, shown: Math.min(200, rows.length), rows: rows.slice(0, 200).map(e => ({ date: e.date, category: e.category, note: e.note, amount: e.amount, bank: e.bank, source: e.source, salary: C.isSalary(e) })) };
    }
    case 'get_team': { const p = period(input.from, input.to); const base = await C.loadBase(); const ex = await expensesFor(p.from, p.to); return rounded(Object.assign(C.teamRows(base, p, ex.rows.length ? ex.rows : null), { months_without_expenses: ex.missingMonths })); }
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
      const keys = [0, -1, -2, -3, -4, -5, -6].map(k => C.shiftMonthKey(key, k)); const byMonth = await C.loadExpenses(keys);
      const r = await C.syncMissing(byMonth, key);
      return rounded({ month: key, incomplete: r.incomplete, items: r.check.map(it => Object.assign({}, it, { found_rows: it.found_rows.slice(0, 10), saved: (r.items.find(x => x.item_key === it.item_key) || null) })) });
    }
    case 'get_prepaid': { const items = await C.loadPrepaid(); return { count: items.length, items: items.map(e => ({ id: e.id, label: e.label, item_key: e.item_key, amount: e.amount, start: e.start, end: C.prepaidEnd(e), months: e.months, per_month: C.prepaidShare(e), added_by: e.added_by_name || e.added_by })) }; }
    case 'get_decisions': { const d = await C.loadDecisions(); return { count: d.length, decisions: d.map(x => ({ key: x.key, text: x.text, source: x.source, month: x.month, by: x.decided_by_name || x.decided_by, at: x.created_at })) }; }
    case 'compare_periods': {
      const a = period(input.a_from, input.a_to), b = period(input.b_from, input.b_to);
      const [sa, sb] = await Promise.all([summaryFor(a.from, a.to), summaryFor(b.from, b.to)]);
      const diff = {}; ['revenue', 'expenses', 'salaries', 'shared', 'profit'].forEach(k => { if (sa[k] != null && sb[k] != null) diff[k] = { a: C.round(sa[k]), b: C.round(sb[k]), delta: C.round(sb[k] - sa[k]), pct: sa[k] ? Math.round((sb[k] - sa[k]) / Math.abs(sa[k]) * 1000) / 10 : null }; });
      return rounded({ a: sa, b: sb, diff });
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
  const lines = ['Сегодня ' + C.fmtDay(today) + ' ' + today.slice(0, 4) + ' (Бишкек). Текущий месяц ' + C.currentMonthKey() + '. Валюта — сом, страна — Кыргызстан.'];
  if (decisions.length) { lines.push('Действующие решения владельца и бухгалтера (применяй, не переспрашивай):'); decisions.slice(0, 30).forEach(d => lines.push('- ' + d.text + (d.month ? ' (' + d.month + ')' : ''))); }
  if (openQuestions.length) { lines.push('Открытые вопросы во вкладке «Вопросы агента» (' + openQuestions.length + '): ' + openQuestions.slice(0, 10).map(q => q.title).join('; ')); }
  if (missing && missing.length) { lines.push('Незакрытые недостающие данные: ' + missing.map(m => m.month + ' ' + m.item_label + ' (' + (m.status === 'missing' ? 'нет строки' : 'сумма отличается') + ')').join('; ') + '. Прибыль за эти месяцы неполная — говори об этом.'); }
  return lines.join('\n');
}

async function contextBundle() {
  const [decisions, openQ, missing] = await Promise.all([
    C.loadDecisions(),
    sbSelect('finansist_questions', { country: 'eq.' + C.COUNTRY, status: 'eq.open', order: 'created_at.desc', limit: '30' }),
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
  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (spentToday >= st.daily_usd) { finalText = (finalText ? finalText + '\n\n' : '') + limitMessage({ spent_usd: spentToday, daily_usd: st.daily_usd }); break; }
    const resp = await client().messages.create({ model: cfg.model || MODEL, max_tokens: near ? 1200 : (cfg.max_tokens || 4000), system, tools: TOOLS, messages, output_config: { effort: near ? 'low' : (cfg.effort || 'medium') } });
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
  dec: ['Это аванс', 'Проверю', 'Так и должно быть'],
  missing: ['Внесу сумму', 'Такой статьи в этом месяце нет'],
  odd: ['Всё верно', 'Проверю с Гульшан'],
  superseded: ['Понятно'],
  prepaid_end: ['Продлили — добавлю новую предоплату', 'Больше не платим'],
};
function candidates(monthKey, disputes, missingSync, opts_prepaid) {
  const out = [];
  disputes.list.forEach(p => {
    const seen = {};
    p.issues.forEach(i => {
      if (seen[i.type]) return; seen[i.type] = 1;
      const key = i.type + ':' + p.id;
      const fact = C.fmtDay(p.paid_at) + ', ' + p.company_name + ', ' + (C.CAT_RU[p.category] || p.category) + ', ' + C.round(p.amount) + ' сом, счёт «' + (p.bank || '—') + '», менеджер ' + (p.manager_name || '—') + '. ' + i.text;
      out.push({ key, type: i.type, amount: p.amount, fact, options: OPTIONS[i.type], evidence: { payment_id: p.id, date: p.paid_at, client: p.company_name, category: p.category, amount: p.amount, bank: p.bank, manager: p.manager_name, issue: i.text } });
    });
  });
  (missingSync.items || []).forEach(r => {
    if (r.status === 'missing' || r.status === 'odd') out.push({ key: r.status + ':' + r.item_key, type: 'missing', amount: r.status === 'odd' ? r.found_amount : r.expected_amount, fact: r.note, options: OPTIONS[r.status], evidence: { item_key: r.item_key, status: r.status, found_amount: r.found_amount, expected_amount: r.expected_amount } });
  });
  (opts_prepaid || []).forEach(e => { const endKey = C.prepaidEnd(e); if (monthKey === C.shiftMonthKey(endKey, 1)) out.push({ key: 'prepaid_end:' + e.id, type: 'other', amount: e.amount, fact: 'Предоплата «' + e.label + '» ' + C.round(e.amount) + ' сом за ' + e.months + ' мес. закончилась в ' + C.monthLabel(endKey) + '. Продлили или больше не платим?', options: OPTIONS.prepaid_end, evidence: { prepaid_id: e.id, label: e.label, amount: e.amount, start: e.start, months: e.months } }); });
  (missingSync.changes || []).forEach(ch => { if (ch.type === 'superseded') out.push({ key: 'superseded:' + ch.item.item_key + ':' + monthKey, type: 'missing', amount: ch.prev.amount, fact: 'Ручная сумма ' + C.round(ch.prev.amount) + ' сом по статье «' + ch.item.item_label + '» больше не учитывается: в таблице появилась настоящая строка на ' + C.round(ch.item.found_amount) + ' сом.', options: OPTIONS.superseded, evidence: { item_key: ch.item.item_key, manual: ch.prev.amount, found: ch.item.found_amount } }); });
  return out;
}
const FALLBACK_TITLE = { bank: 'Оплата не на том счёте', dup: 'Похоже на двойную запись', dec: 'Проверить по правилу декад', missing: 'Не хватает данных по расходам', other: 'Предоплата закончилась' };

export async function sweepMonth(monthKey, opts) {
  opts = opts || {};
  const base = await C.loadBase(true);
  const range = C.monthKeyToRange(monthKey);
  const disputes = C.findDisputes(base.payments, range);
  const keys = [0, -1, -2, -3, -4, -5, -6].map(k => C.shiftMonthKey(monthKey, k));
  const byMonth = await C.loadExpenses(keys, { force: !!opts.force });
  const missingSync = await C.syncMissing(byMonth, monthKey);
  const prepaid = await C.loadPrepaid();
  const cands = candidates(monthKey, disputes, missingSync, prepaid);
  const existing = await sbSelect('finansist_questions', { country: 'eq.' + C.COUNTRY, month: 'eq.' + monthKey, limit: '500' });
  const exMap = {}; existing.forEach(q => { exMap[q.key] = q; });
  const decisions = await C.loadDecisions();
  const decided = new Set(decisions.map(d => d.key));
  const fresh = cands.filter(c => !exMap[c.key] && !decided.has(c.key));
  const now = new Date().toISOString();
  // исчезнувшие расхождения — закрываем
  const candKeys = new Set(cands.map(c => c.key));
  let closed = 0;
  for (const q of existing) if (q.status === 'open' && !candKeys.has(q.key) && !q.key.startsWith('superseded:') && q.type !== 'goal' && q.type !== 'other') { await sbUpdate('finansist_questions', { id: 'eq.' + q.id }, { status: 'dismissed', answer_text: 'Расхождение исчезло само', updated_at: now }); closed++; }
  // обновляем сумму/доказательства у открытых
  for (const c of cands) { const q = exMap[c.key]; if (q && q.status === 'open') await sbUpdate('finansist_questions', { id: 'eq.' + q.id }, { amount: c.amount == null ? null : C.round(c.amount), evidence: c.evidence, updated_at: now }); }

  let texts = {}; let usage = null; let cost = 0; let modelUsed = false;
  if (fresh.length) {
    const st = await limitState();
    if (!st.exhausted && apiKey()) {
      try {
        const cfg = agentConfig();
        const ask = 'Сформулируй вопросы владельцу по фактам ниже. На каждый факт — короткий заголовок (до 60 знаков) и объяснение в 1–2 предложения с цифрами из факта, без выводов сверх фактов, по-русски, на «вы». Верни ТОЛЬКО JSON-массив объектов {"key","title","body"} для всех ключей.\n\n' + fresh.map(c => 'key=' + c.key + ' | тип=' + c.type + ' | ' + c.fact).join('\n');
        const resp = await client().messages.create({ model: cfg.model || MODEL, max_tokens: 4000, system: [{ type: 'text', text: cfg.system_prompt, cache_control: { type: 'ephemeral', ttl: '1h' } }], messages: [{ role: 'user', content: ask }], output_config: { effort: 'low' } });
        usage = resp.usage; cost = costOf(resp.usage); modelUsed = true;
        const txt = resp.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
        const m = txt.match(/\[[\s\S]*\]/);
        if (m) JSON.parse(m[0]).forEach(x => { if (x && x.key) texts[x.key] = { title: String(x.title || '').slice(0, 200), body: String(x.body || '').slice(0, 2000) }; });
        if (cost > 0) await C.addSpend(st.day, cost);
      } catch (e) { console.error('[finansist-agent] sweep model:', e.message); }
    }
  }
  let created = 0;
  for (const c of fresh) {
    const t = texts[c.key] || {};
    await sbUpsert('finansist_questions', { country: C.COUNTRY, month: monthKey, key: c.key, type: c.type, title: t.title || FALLBACK_TITLE[c.type] || 'Вопрос', body: t.body || c.fact, options: c.options, evidence: c.evidence, amount: c.amount == null ? null : C.round(c.amount), status: 'open', created_at: now, updated_at: now }, 'country,month,key');
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
  return { ok: true };
}
