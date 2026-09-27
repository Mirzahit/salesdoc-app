// /api/finansist — данные для вкладки «Финансы → Финансист» (v1005, v1006 — общее ядро с агентом).
//
// Только просмотр: сервер собирает цифры из базы и отдаёт готовые блоки. Доступ — право view_finansist
// (владелец и бухгалтер), проверяется здесь, а не только скрытием пункта в меню.
//
// GET  /api/finansist?month=2026-09  → { ok, month, meta, months[], period, disputes, banks, team, churn, cash,
//                                       expenses (по месяцам, из снимка таблицы + ручные суммы), missing, questions, settings, agent }
// POST /api/finansist?action=balance  body { balance } → остаток по счетам (finansist_settings)
//
// Расчёты и правила — в api/_finansist_core.js (одни и те же для страницы, чата и ночного обхода).
// С v1006 расходы приходят с сервера (снимок Google-таблицы в finansist_expenses_cache), фронт их больше
// не читает сам, поэтому цифры на странице и в чате совпадают.

import { sbSelect, sbUpsert } from './_supabase.js';
import { checkAuth } from './_auth.js';
import { requirePerm } from './_perm.js';
import { callerName } from './_caller.js';
import * as C from './_finansist_core.js';
import { limitState } from './_finansist_agent.js';

export const config = { maxDuration: 60 };
export { bankKey, BANK_LABELS } from './_finansist_core.js';

const BALANCE_KEY = 'balance_' + C.COUNTRY;

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  return new Promise((resolve) => { let s = ''; req.on('data', c => s += c); req.on('end', () => { try { resolve(JSON.parse(s || '{}')); } catch { resolve({}); } }); });
}

export default async function handler(req, res) {
  if (!checkAuth(req, res)) return;
  const gate = await requirePerm(req, res, 'view_finansist');
  if (!gate.ok) return;
  if (req.method === 'POST') return handlePost(req, res, gate.caller);
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'method not allowed' });

  try {
    const nowKey = C.currentMonthKey();
    const pm = C.parseMonth(req.query.month) || C.parseMonth(nowKey);
    const range = C.monthRange(pm.y, pm.mo);
    const prevKey = C.shiftMonthKey(range.key, -1);
    const monthKeys = [-5, -4, -3, -2, -1, 0].map(k => C.shiftMonthKey(range.key, k));
    const prevNowKey = C.shiftMonthKey(nowKey, -1); // для кассы: расходы прошлого календарного месяца
    const expKeys = monthKeys.indexOf(prevNowKey) < 0 ? monthKeys.concat([prevNowKey]) : monthKeys;

    const base = await C.loadBase();
    const [expByMonth, churn, questions, settingsRows, agentLimit, prepaid] = await Promise.all([
      C.loadExpenses(expKeys),
      C.churnForMonth(base, range),
      sbSelect('finansist_questions', { country: 'eq.' + C.COUNTRY, month: 'eq.' + range.key, order: 'created_at.desc', limit: '300' }),
      sbSelect('finansist_settings', { key: 'eq.' + BALANCE_KEY, limit: '1' }),
      limitState().catch(() => null),
      C.loadPrepaid(),
    ]);
    const missing = await C.syncMissing(expByMonth, range.key);

    // --- 6 месяцев ---
    const months = monthKeys.map(k => {
      const r = C.monthKeyToRange(k); const rows = base.payments.filter(p => C.inRange(p, r));
      const exRows = C.expenseRows(expByMonth, k);
      const s = C.periodSummary(base, r, exRows);
      return { key: k, revenue: s.revenue, count: rows.length, by_category: s.by_category, expenses: s.expenses, salaries: s.salaries, profit: s.profit, owner_draws: s.owner_draws, retained: s.retained, margin_pct: s.margin_pct, salary_share_pct: s.salary_share_pct, expenses_available: !!exRows };
    });

    // --- период ---
    const curRows = base.payments.filter(p => C.inRange(p, range));
    const prevRows = base.payments.filter(p => C.inRange(p, C.monthKeyToRange(prevKey)));
    const period = Object.assign(C.periodSummary(base, range, C.expenseRows(expByMonth, range.key)), {
      prev_revenue: prevRows.reduce((a, p) => a + C.num(p.amount), 0),
      last_paid_at: (function () { const t = C.bishkekIso(); const p = base.payments.find(x => x.paid_at && x.paid_at <= t); return p ? p.paid_at : (base.payments[0] ? base.payments[0].paid_at : null); })(),
      profit_incomplete: missing.incomplete,
    });

    // --- спорные ---
    const d = C.findDisputes(base.payments, range);

    // --- счета ---
    const banks = {};
    curRows.forEach(p => {
      const k = C.bankKey(p.bank);
      const b = banks[k] = banks[k] || { key: k, label: C.BANK_LABELS[k], raw: {}, income: 0, count: 0, disputed: 0, disputed_sum: 0, by_category: {} };
      b.income += C.num(p.amount); b.count++; b.raw[p.bank || ''] = (b.raw[p.bank || ''] || 0) + 1; b.by_category[p.category] = (b.by_category[p.category] || 0) + C.num(p.amount);
      if (d.issues[p.id] && d.issues[p.id].some(i => i.type === 'bank')) { b.disputed++; b.disputed_sum += C.num(p.amount); }
    });

    // --- команда ---
    const team = C.teamRows(base, range, C.expenseRows(expByMonth, range.key));
    const teamPrev = {}; prevRows.forEach(p => { const n = (p.manager_name || '').trim() || 'Без менеджера'; teamPrev[n] = (teamPrev[n] || 0) + C.num(p.amount); });
    team.rows.forEach(r => { r.prev_revenue = teamPrev[r.name] || 0; });

    // --- касса ---
    const cash = C.cashForecast(base, 30);

    const expensesOut = {};
    Object.keys(expByMonth).forEach(k => { const m = expByMonth[k]; expensesOut[k] = { available: m.available, fetched_at: m.fetched_at, stale: !!m.stale, rows: m.rows.map(e => Object.assign({ date: e.date, category: e.category, note: e.note, amount: e.amount, bank: e.bank, source: e.source, item_key: e.item_key || null }, C.classifyExpense(e))) }; });

    return res.status(200).json({
      ok: true,
      month: range.key,
      meta: {
        generated_at: new Date().toISOString(), country: C.COUNTRY, currency: 'KGS', payments_total: base.payments.length, last_paid_at: period.last_paid_at,
        employees: base.employees.map(e => ({ name: e.name, pos: e.pos, role: e.role, email: e.email })),
        bank_labels: C.BANK_LABELS, rules: { bank_from: C.BANK_RULE_FROM, dup_window_days: C.DUP_WINDOW_DAYS, decade_cats: C.DECADE_CATS, odd_threshold: C.ODD_THRESHOLD },
        expected_items: C.EXPECTED_ITEMS.map(i => ({ key: i.key, label: i.label, how: i.how })),
        salary_rules: C.SALARY_RULES.map(r => ({ person: r.person, cat_label: r.cat_label, note_label: r.note_label })),
        group_rules: C.GROUP_RULES.map(g => ({ group: g.group, how: g.how, revenue_cats: g.revenue_cats })),
        shared_label_rules: C.SHARED_LABEL_RULES.map(r => ({ label: r.label, how: r.how })),
        settings: C.currentRules(),
      },
      months, period,
      disputes: { list: d.list, counts: d.counts, total: d.list.length },
      banks: Object.values(banks).sort((a, b) => b.income - a.income),
      team,
      churn, cash,
      expenses: expensesOut,
      missing: { items: missing.items, incomplete: missing.incomplete, mode: missing.mode },
      questions,
      prepaid: prepaid.map(e => Object.assign({}, e, { end: C.prepaidEnd(e), per_month: C.prepaidShare(e) })),
      settings: { balance: settingsRows.length ? Object.assign({}, settingsRows[0].value, { updated_by: settingsRows[0].updated_by, updated_by_name: settingsRows[0].updated_by_name, updated_at: settingsRows[0].updated_at }) : null },
      agent: agentLimit,
    });
  } catch (e) {
    console.error('[api/finansist] error:', e);
    return res.status(500).json({ ok: false, error: e.message || String(e) });
  }
}

async function handlePost(req, res, caller) {
  const action = String(req.query.action || '');
  const body = await readBody(req);
  try {
    if (action === 'balance') {
      const bal = body.balance == null || body.balance === '' ? null : Number(body.balance);
      if (bal != null && !isFinite(bal)) return res.status(400).json({ ok: false, error: 'balance должен быть числом' });
      const rows = await sbUpsert('finansist_settings', { key: BALANCE_KEY, value: { balance: bal, entered_at: C.bishkekIso() }, updated_by: caller.email, updated_by_name: callerName(req) || null, updated_at: new Date().toISOString() }, 'key');
      const r = rows[0] || {};
      return res.status(200).json({ ok: true, balance: Object.assign({}, r.value, { updated_by: r.updated_by, updated_by_name: r.updated_by_name, updated_at: r.updated_at }) });
    }
    return res.status(400).json({ ok: false, error: 'неизвестное действие' });
  } catch (e) {
    console.error('[api/finansist] post error:', e);
    return res.status(500).json({ ok: false, error: e.message || String(e) });
  }
}
