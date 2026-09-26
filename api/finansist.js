// /api/finansist — v1005. Данные для вкладки «Финансы → Финансист».
//
// Только просмотр: сервер собирает цифры из базы и отдаёт готовые блоки, никаких выводов
// и изменений. Доступ — только тем, у кого есть право view_finansist (владелец и бухгалтер),
// проверяется здесь, а не только скрытием пункта в меню.
//
// GET  /api/finansist?month=2026-09        → { ok, month, meta, months[], period, disputes, banks, team, churn, cash, answers[], settings }
// POST /api/finansist?action=answer        body { month, question_id, answer_idx, answer_text } → отметка ответа (кто/когда)
// POST /api/finansist?action=balance       body { balance }                                    → остаток по счетам
//   Ответы и остаток лежат в Supabase (finansist_answers, finansist_settings; RLS без политик — только через сервер),
//   чтобы владелец с телефона и бухгалтер с компьютера видели одно и то же.
//
// Правила расхождений (то же описано на странице «Правила и цели»):
//   bank — услуга (внедрение/интеграция/доработка) зачислена на счёт лицензий, или
//          лицензия/абонплата/доп.лицензия — на счёт услуг. Считаем с 2026-01-01: раньше
//          отдельного счёта услуг не было.
//   dup  — два платежа одного клиента с одинаковой суммой и статьёй в пределах 3 дней.
//   dec  — правило декад действует при каждой активации и каждом продлении (статьи license и
//          subscription): оплата 1–9 числа → 30 дней, 10–19 → 20, с 20-го → 10. Помечаем оплаты
//          с 10-го числа и позже, где сумма внесена как за полные месяцы. Это «проверить», не ошибка:
//          у клиента мог быть остаток на балансе. Дата активации в KG не заполняется — берём дату оплаты.
//
// Расходы (Google Sheets) сюда не приходят — их фронт берёт своим путём через /api/sheets
// с правом view_expenses и складывает с этими цифрами.

import { sbSelect, sbSelectAll, sbUpsert } from './_supabase.js';
import { checkAuth } from './_auth.js';
import { requirePerm } from './_perm.js';
import { callerName } from './_caller.js';
import { almatyIso } from './_dates.js'; // «сегодня» по Бишкеку, не по UTC (ловушка toISOString)

export const config = { maxDuration: 60 };

const COUNTRY = 'KG';
const SERVICE_CATS = ['implementation', 'integration', 'revision'];
const LICENSE_CATS = ['subscription', 'license', 'extra'];
const BANK_RULE_FROM = '2026-01-01';
const DUP_WINDOW_DAYS = 3;
const DECADE_CATS = ['license', 'subscription']; // доп. лицензии (extra) выравниваются по сроку и под правило не попадают

export const BANK_LABELS = {
  license: 'М-банк лицензии',
  services: 'М-банк услуги',
  cash: 'Касса',
  other: 'Другие счета',
  none: 'Счёт не указан',
};

// Поле bank менеджер заполняет руками: «М Бизнес», «МБизнес», «Мбизнес Услуги», «МБизнес Усл», «РСК», «Касса …».
export function bankKey(bank) {
  const s = String(bank || '').toLowerCase().replace(/\s+/g, '');
  if (!s) return 'none';
  if (/усл/.test(s)) return 'services';
  if (/мбизнес|м-?банк|m-?bank|mbusiness/.test(s)) return 'license';
  if (/касса|налич/.test(s)) return 'cash';
  return 'other';
}

function pad2(n) { return String(n).padStart(2, '0'); }
function ym(d) { return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1); }
function parseMonth(s) {
  const m = String(s || '').match(/^(\d{4})-(\d{2})$/);
  if (!m) return null;
  const y = +m[1], mo = +m[2];
  if (mo < 1 || mo > 12) return null;
  return { y, mo };
}
function monthRange(y, mo) {
  const from = y + '-' + pad2(mo) + '-01';
  const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return { from, to: y + '-' + pad2(mo) + '-' + pad2(last), key: y + '-' + pad2(mo) };
}
function shiftMonth(y, mo, k) {
  const d = new Date(Date.UTC(y, mo - 1 + k, 1));
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1 };
}
function dayOf(iso) { return parseInt(String(iso || '').slice(8, 10), 10) || 0; }
function daysBetween(a, b) { return Math.round((Date.parse(b) - Date.parse(a)) / 86400000); }
function num(v) { const n = parseFloat(v); return isNaN(n) ? 0 : n; }
function normName(s) {
  return String(s || '').toLowerCase().replace(/[«»"',.()]/g, ' ').replace(/\s+/g, ' ').trim();
}
function decadeDays(day) { return day >= 20 ? 10 : (day >= 10 ? 20 : 30); }
function todayIso() { return almatyIso(); }
function addDays(iso, k) { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + k); return d.toISOString().slice(0, 10); }

// ---------- расхождения ----------
function findDisputes(all, range) {
  const issues = {}; // id -> [{type, text}]
  const push = (id, type, text) => { (issues[id] = issues[id] || []).push({ type, text }); };

  // не тот счёт
  all.forEach(p => {
    if (p.paid_at < BANK_RULE_FROM || num(p.amount) <= 0) return;
    const bk = bankKey(p.bank);
    if (bk !== 'license' && bk !== 'services') return;
    if (SERVICE_CATS.includes(p.category) && bk === 'license') push(p.id, 'bank', 'услуга на счёте лицензий');
    if (LICENSE_CATS.includes(p.category) && bk === 'services') push(p.id, 'bank', 'лицензия на счёте услуг');
  });

  // возможный дубль — сортируем по клиенту, сравниваем соседей в окне 3 дня
  const byClient = {};
  all.forEach(p => {
    if (num(p.amount) <= 0) return;
    const k = p.client_id || normName(p.company_name);
    (byClient[k] = byClient[k] || []).push(p);
  });
  Object.keys(byClient).forEach(k => {
    const rows = byClient[k].slice().sort((a, b) => a.paid_at < b.paid_at ? -1 : 1);
    for (let i = 0; i < rows.length; i++) {
      for (let j = i + 1; j < rows.length; j++) {
        const a = rows[i], b = rows[j];
        if (daysBetween(a.paid_at, b.paid_at) > DUP_WINDOW_DAYS) break;
        if (a.category !== b.category || num(a.amount) !== num(b.amount)) continue;
        push(a.id, 'dup', 'такой же платёж ' + fmtDay(b.paid_at));
        push(b.id, 'dup', 'такой же платёж ' + fmtDay(a.paid_at));
      }
    }
  });

  // не по декаде — каждая активация и каждое продление
  all.forEach(p => {
    if (!DECADE_CATS.includes(p.category)) return;
    const qty = num(p.qty), price = num(p.price), months = num(p.period_months), amount = num(p.amount);
    if (qty <= 0 || price <= 0 || months <= 0 || amount <= 0) return;
    const day = dayOf(p.paid_at);
    if (day < 10) return;
    const full = qty * price * months;
    if (Math.abs(amount - full) >= 1) return;
    const dd = decadeDays(day);
    const expected = Math.round(qty * price * (months - 1 + dd / 30));
    push(p.id, 'dec', 'проверить: по декаде ' + dd + ' дн., ожидалось ' + expected + ', внесено за полные месяцы (мог быть остаток на балансе)');
  });

  const list = all
    .filter(p => issues[p.id] && p.paid_at >= range.from && p.paid_at <= range.to)
    .map(p => ({
      id: p.id,
      paid_at: p.paid_at,
      company_name: p.company_name,
      client_id: p.client_id,
      category: p.category,
      category_raw: p.category_raw,
      amount: num(p.amount),
      bank: p.bank,
      bank_key: bankKey(p.bank),
      manager_name: p.manager_name,
      source: p.source,
      created_by: p.created_by,
      issues: issues[p.id],
    }))
    .sort((a, b) => a.paid_at < b.paid_at ? 1 : -1);
  return { list, issues };
}

const MONTHS_RU_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
function fmtDay(iso) { return dayOf(iso) + ' ' + MONTHS_RU_GEN[parseInt(iso.slice(5, 7), 10) - 1]; }

// ---------- сумма в месяц по последней подписочной оплате клиента ----------
function monthlyValue(p) {
  const m = num(p.period_months);
  return num(p.amount) / (m > 0 ? m : 1);
}

export default async function handler(req, res) {
  if (!checkAuth(req, res)) return;
  const gate = await requirePerm(req, res, 'view_finansist');
  if (!gate.ok) return;
  if (req.method === 'POST') return handlePost(req, res, gate.caller);
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'method not allowed' });

  try {
    const now = new Date();
    const pm = parseMonth(req.query.month) || { y: now.getUTCFullYear(), mo: now.getUTCMonth() + 1 };
    const range = monthRange(pm.y, pm.mo);
    const prev = monthRange(shiftMonth(pm.y, pm.mo, -1).y, shiftMonth(pm.y, pm.mo, -1).mo);

    const [payments, clients, churnRows, licRows, licPeriods, employees, answers, settingsRows] = await Promise.all([
      sbSelectAll('payments', {
        country: 'eq.' + COUNTRY,
        select: 'id,paid_at,company_name,client_id,category,category_raw,amount,qty,price,period_months,bank,manager_name,source,created_by,created_at',
        order: 'paid_at.desc,id',
      }),
      sbSelectAll('clients', {
        country: 'eq.' + COUNTRY,
        select: 'client_id,company_name,city,status,next_billing_at,access_until,access_status,pay_reason,pay_reason_note,pay_reason_at,churned_at,subscription_period_months,support_operator,curator_operator',
        order: 'client_id',
      }),
      sbSelectAll('churn_records', { country: 'eq.' + COUNTRY, period_month: 'eq.' + range.from, select: 'period_month,company_name,company_key,kind,prev_count,prev_amount,cur_count,cur_amount,diff,reason,reason_raw' }),
      sbSelectAll('churn_license_changes', { country: 'eq.' + COUNTRY, period_month: 'eq.' + range.from, select: 'period_month,company_key,license_type,m1_count,m2_count,diff' }),
      sbSelectAll('churn_license_changes', { country: 'eq.' + COUNTRY, select: 'period_month' }), // только даты выгрузок — для подсказки «есть за …»
      sbSelect('employees', { active: 'eq.true', select: 'name,pos,role,country,email', order: 'name', limit: '200' }),
      sbSelect('finansist_answers', { country: 'eq.' + COUNTRY, month: 'eq.' + range.key, select: 'question_id,answer_idx,answer_text,answered_by,answered_by_name,answered_at', limit: '200' }),
      sbSelect('finansist_settings', { key: 'eq.' + BALANCE_KEY, limit: '1' }),
    ]);

    const inRange = (p, r) => p.paid_at >= r.from && p.paid_at <= r.to;
    const cur = payments.filter(p => inRange(p, range));
    const prevRows = payments.filter(p => inRange(p, prev));

    // --- 6 месяцев ---
    const months = [];
    for (let k = -5; k <= 0; k++) {
      const s = shiftMonth(pm.y, pm.mo, k);
      const r = monthRange(s.y, s.mo);
      const rows = payments.filter(p => inRange(p, r));
      const byCat = {};
      rows.forEach(p => { byCat[p.category] = (byCat[p.category] || 0) + num(p.amount); });
      months.push({ key: r.key, revenue: rows.reduce((a, p) => a + num(p.amount), 0), count: rows.length, by_category: byCat });
    }

    // --- период ---
    const sumBy = (rows, fn) => { const o = {}; rows.forEach(p => { const k = fn(p) || '—'; o[k] = (o[k] || 0) + num(p.amount); }); return o; };
    const period = {
      from: range.from, to: range.to,
      count: cur.length,
      revenue: cur.reduce((a, p) => a + num(p.amount), 0),
      prev_revenue: prevRows.reduce((a, p) => a + num(p.amount), 0),
      by_category: sumBy(cur, p => p.category),
      by_manager: sumBy(cur, p => p.manager_name),
      by_bank: sumBy(cur, p => bankKey(p.bank)),
      last_paid_at: (function(){ const t = todayIso(); const p = payments.find(x => x.paid_at && x.paid_at <= t); return p ? p.paid_at : (payments.length ? payments[0].paid_at : null); })(), // без опечаток из будущего
    };

    // --- спорные ---
    const d = findDisputes(payments, range);
    const disputeCounts = { bank: 0, dup: 0, dec: 0 };
    d.list.forEach(p => { const seen = {}; p.issues.forEach(i => { if (!seen[i.type]) { disputeCounts[i.type]++; seen[i.type] = 1; } }); });

    // --- счета ---
    const banks = {};
    cur.forEach(p => {
      const k = bankKey(p.bank);
      const b = banks[k] = banks[k] || { key: k, label: BANK_LABELS[k], raw: {}, income: 0, count: 0, disputed: 0, disputed_sum: 0, by_category: {} };
      b.income += num(p.amount); b.count++;
      b.raw[p.bank || ''] = (b.raw[p.bank || ''] || 0) + 1;
      b.by_category[p.category] = (b.by_category[p.category] || 0) + num(p.amount);
      if (d.issues[p.id] && d.issues[p.id].some(i => i.type === 'bank')) { b.disputed++; b.disputed_sum += num(p.amount); }
    });

    // --- команда ---
    const team = {};
    const addTeam = (p, field) => {
      const n = (p.manager_name || '').trim() || 'Без менеджера';
      const t = team[n] = team[n] || { name: n, revenue: 0, prev_revenue: 0, count: 0, new_clients: 0, by_category: {} };
      if (field === 'prev') { t.prev_revenue += num(p.amount); return; }
      t.revenue += num(p.amount); t.count++;
      if (p.category === 'license') t.new_clients++;
      t.by_category[p.category] = (t.by_category[p.category] || 0) + num(p.amount);
    };
    cur.forEach(p => addTeam(p, 'cur'));
    prevRows.forEach(p => addTeam(p, 'prev'));

    // --- отток ---
    const lastSubByClient = {};
    payments.forEach(p => { // payments отсортированы по paid_at desc
      if (!LICENSE_CATS.includes(p.category) || num(p.amount) <= 0) return;
      const k = p.client_id || normName(p.company_name);
      if (!lastSubByClient[k]) lastSubByClient[k] = p;
    });
    const inMonthTs = (ts) => { const s = String(ts || '').slice(0, 10); return s >= range.from && s <= range.to; };
    const left = clients
      .filter(c => inMonthTs(c.churned_at) || ((c.pay_reason === 'churn' || c.pay_reason === 'decline') && inMonthTs(c.pay_reason_at)))
      .map(c => {
        const last = lastSubByClient[c.client_id] || lastSubByClient[normName(c.company_name)];
        return {
          client_id: c.client_id, company_name: c.company_name, city: c.city,
          kind: c.pay_reason === 'decline' ? 'decline' : 'churn',
          reason: c.pay_reason_note || '', when: (c.churned_at || c.pay_reason_at || '').slice(0, 10),
          monthly: last ? Math.round(monthlyValue(last)) : 0, last_paid_at: last ? last.paid_at : null,
          operator: c.support_operator || null,
        };
      });
    const churnPeriods = Array.from(new Set(churnRows.map(r => r.period_month).concat(licPeriods.map(r => r.period_month)))).filter(Boolean).sort().reverse();
    const churnMonth = churnRows.filter(r => r.period_month === range.from).map(r => ({
      company_name: r.company_name, kind: r.kind, prev_count: r.prev_count, cur_count: r.cur_count,
      prev_amount: num(r.prev_amount), cur_amount: num(r.cur_amount), diff: r.diff, reason: r.reason || r.reason_raw || '',
    }));
    const licByCompany = {};
    licRows.filter(r => r.period_month === range.from).forEach(r => {
      const o = licByCompany[r.company_key] = licByCompany[r.company_key] || { company_key: r.company_key, before: 0, after: 0, diff: 0 };
      o.before += num(r.m1_count); o.after += num(r.m2_count); o.diff += num(r.diff);
    });
    const licChanges = Object.values(licByCompany).filter(o => o.diff !== 0).sort((a, b) => a.diff - b.diff).slice(0, 40);
    const newClientRows = cur.filter(p => p.category === 'license' && num(p.amount) > 0);
    const newMonthly = newClientRows.reduce((a, p) => a + monthlyValue(p), 0);
    const churn = {
      left,
      lost_monthly: left.reduce((a, c) => a + c.monthly, 0),
      new_monthly: Math.round(newMonthly),
      new_clients: new Set(newClientRows.map(p => p.client_id || normName(p.company_name))).size,
      records: churnMonth,
      license_changes: licChanges,
      periods_available: churnPeriods,
    };

    // --- касса ---
    const today = todayIso();
    const d90 = addDays(today, -90);
    const last90 = payments.filter(p => p.paid_at > d90 && p.paid_at <= today && num(p.amount) > 0);
    const active = clients.filter(c => c.status === 'active');
    const estFor = (c) => { const last = lastSubByClient[c.client_id] || lastSubByClient[normName(c.company_name)]; return last ? num(last.amount) : 0; };
    const expected = active
      .filter(c => c.next_billing_at && c.next_billing_at >= today && c.next_billing_at <= addDays(today, 90))
      .map(c => ({ client_id: c.client_id, company_name: c.company_name, date: c.next_billing_at, est: estFor(c), months: c.subscription_period_months || null }))
      .sort((a, b) => a.date < b.date ? -1 : 1);
    const overdue = active.filter(c => c.next_billing_at && c.next_billing_at < today);
    const cash = {
      today,
      daily_avg_90: Math.round(last90.reduce((a, p) => a + num(p.amount), 0) / 90),
      inflow_90: last90.reduce((a, p) => a + num(p.amount), 0),
      expected,
      expected_30: expected.filter(e => e.date <= addDays(today, 30)).reduce((a, e) => a + e.est, 0),
      expected_60: expected.filter(e => e.date <= addDays(today, 60)).reduce((a, e) => a + e.est, 0),
      expected_90: expected.reduce((a, e) => a + e.est, 0),
      overdue_count: overdue.length,
      overdue_est: overdue.reduce((a, c) => a + estFor(c), 0),
    };

    return res.status(200).json({
      ok: true,
      month: range.key,
      meta: {
        generated_at: new Date().toISOString(),
        country: COUNTRY,
        currency: 'KGS',
        payments_total: payments.length,
        last_paid_at: period.last_paid_at,
        employees: employees.filter(e => !e.country || e.country === COUNTRY).map(e => ({ name: e.name, pos: e.pos, role: e.role, email: e.email })),
        bank_labels: BANK_LABELS,
        rules: { bank_from: BANK_RULE_FROM, dup_window_days: DUP_WINDOW_DAYS },
      },
      months,
      period,
      disputes: { list: d.list, counts: disputeCounts, total: d.list.length },
      banks: Object.values(banks).sort((a, b) => b.income - a.income),
      team: Object.values(team).sort((a, b) => b.revenue - a.revenue),
      churn,
      cash,
      answers,
      settings: { balance: settingsRows.length ? Object.assign({}, settingsRows[0].value, { updated_by: settingsRows[0].updated_by, updated_by_name: settingsRows[0].updated_by_name, updated_at: settingsRows[0].updated_at }) : null },
    });
  } catch (e) {
    console.error('[api/finansist] error:', e);
    return res.status(500).json({ ok: false, error: e.message || String(e) });
  }
}

const BALANCE_KEY = 'balance_' + COUNTRY;

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  return new Promise((resolve) => {
    let chunks = '';
    req.on('data', c => chunks += c);
    req.on('end', () => { try { resolve(JSON.parse(chunks || '{}')); } catch { resolve({}); } });
  });
}

// Отметки владельца/бухгалтера. Оплаты не трогаем — только запоминаем ответ и кто его дал.
async function handlePost(req, res, caller) {
  const action = String(req.query.action || '');
  const body = await readBody(req);
  const who = caller.email;
  const whoName = callerName(req) || null;
  try {
    if (action === 'answer') {
      const month = parseMonth(body.month) ? String(body.month) : null;
      const qid = String(body.question_id || '').trim();
      const idx = parseInt(body.answer_idx, 10);
      if (!month || !qid || isNaN(idx)) return res.status(400).json({ ok: false, error: 'нужны month, question_id, answer_idx' });
      const rows = await sbUpsert('finansist_answers', {
        country: COUNTRY, month, question_id: qid, answer_idx: idx,
        answer_text: body.answer_text ? String(body.answer_text).slice(0, 500) : null,
        answered_by: who, answered_by_name: whoName, answered_at: new Date().toISOString(),
      }, 'country,month,question_id');
      return res.status(200).json({ ok: true, answer: rows[0] || null });
    }
    if (action === 'balance') {
      const bal = body.balance == null || body.balance === '' ? null : Number(body.balance);
      if (bal != null && !isFinite(bal)) return res.status(400).json({ ok: false, error: 'balance должен быть числом' });
      const rows = await sbUpsert('finansist_settings', {
        key: BALANCE_KEY, value: { balance: bal, entered_at: todayIso() },
        updated_by: who, updated_by_name: whoName, updated_at: new Date().toISOString(),
      }, 'key');
      const r = rows[0] || {};
      return res.status(200).json({ ok: true, balance: Object.assign({}, r.value, { updated_by: r.updated_by, updated_by_name: r.updated_by_name, updated_at: r.updated_at }) });
    }
    return res.status(400).json({ ok: false, error: 'неизвестное действие' });
  } catch (e) {
    console.error('[api/finansist] post error:', e);
    return res.status(500).json({ ok: false, error: e.message || String(e) });
  }
}
