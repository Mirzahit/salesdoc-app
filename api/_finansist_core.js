// v1006 «Финансист»: общее ядро расчётов для страницы (/api/finansist), агента (/api/finansist-agent)
// и ночного обхода (/api/cron-finansist). Одни и те же функции — одни и те же цифры в чате и на экране.
//
// Данные: payments/clients/employees из Supabase (только чтение), расходы — из Google-таблицы KG через
// Apps Script со снимком в finansist_expenses_cache (Apps Script отвечает 10–20 с), плюс суммы, внесённые
// бухгалтером в finansist_missing_data (status='filled'). Страна всегда KG.
//
// Правила расхождений и правило декад: см. комментарии в findDisputes. Зарплата: isSalary/SALARY_RULES —
// зеркало функций fzIsSalary/FZ_SALARY_RULES в index.html, править синхронно.

import { sbSelect, sbSelectAll, sbUpsert, sbUpdate, sbDelete, sbInsert } from './_supabase.js';

export const COUNTRY = 'KG';
export const CURRENCY = 'сом';
export const SERVICE_CATS = ['implementation', 'integration', 'revision'];
export const LICENSE_CATS = ['subscription', 'license', 'extra'];
export const DECADE_CATS = ['license', 'subscription', 'extra']; // CEO 26.09.2026: доп. лицензии тоже по декадам
export const BANK_RULE_FROM = '2026-01-01';
export const DUP_WINDOW_DAYS = 3;
export const CAT_RU = { implementation: 'Внедрение', integration: 'Интеграция', subscription: 'Абонплата', license: 'Новый клиент', revision: 'Доработка', extra: 'Доп. лицензии', other: 'Прочее' };
export const BANK_LABELS = { license: 'М-банк лицензии', services: 'М-банк услуги', cash: 'Наличные', other: 'Другие счета', none: 'Счёт не указан' };
export const MONTHS_RU = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
export const MONTHS_RU_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

// Таблица расходов KG (та же, что читает фронт через /api/sheets) — листы по месяцам без года.
const EXP_SHEET_ID = '1wJaSorA_jLG7YJJaTT2XXV6j5SSjufutVFOuKsK1tdY';
const GS_URL = 'https://script.google.com/macros/s/AKfycbwwNL4CxOrSo4wXT3qci_dSSqi5tABLPUqHQPv2nWrn_WQhZsaOpfnwdygaqskzuHphvg/exec';

// ---------- даты ----------
export function pad2(n) { return String(n).padStart(2, '0'); }
// «Сегодня» по Бишкеку (UTC+6, перевода часов нет). Не путать с almatyIso (UTC+5) — у KG свой пояс.
export function bishkekIso(ms) { return new Date((ms || Date.now()) + 6 * 3600 * 1000).toISOString().slice(0, 10); }
export function bishkekNow() { return new Date(Date.now() + 6 * 3600 * 1000); }
export function parseMonth(s) {
  const m = String(s || '').match(/^(\d{4})-(\d{2})$/);
  if (!m) return null;
  const y = +m[1], mo = +m[2];
  if (mo < 1 || mo > 12) return null;
  return { y, mo };
}
export function monthRange(y, mo) {
  const from = y + '-' + pad2(mo) + '-01';
  const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return { from, to: y + '-' + pad2(mo) + '-' + pad2(last), key: y + '-' + pad2(mo) };
}
export function monthKeyToRange(key) { const m = parseMonth(key); return m ? monthRange(m.y, m.mo) : null; }
export function shiftMonth(y, mo, k) { const d = new Date(Date.UTC(y, mo - 1 + k, 1)); return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1 }; }
export function shiftMonthKey(key, k) { const m = parseMonth(key); const s = shiftMonth(m.y, m.mo, k); return s.y + '-' + pad2(s.mo); }
export function currentMonthKey() { return bishkekIso().slice(0, 7); }
export function dayOf(iso) { return parseInt(String(iso || '').slice(8, 10), 10) || 0; }
export function daysBetween(a, b) { return Math.round((Date.parse(b) - Date.parse(a)) / 86400000); }
export function addDays(iso, k) { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + k); return d.toISOString().slice(0, 10); }
export function fmtDay(iso) { return iso ? dayOf(iso) + ' ' + MONTHS_RU_GEN[parseInt(iso.slice(5, 7), 10) - 1] : '—'; }
export function monthLabel(key) { const m = parseMonth(key); return m ? MONTHS_RU[m.mo - 1].toLowerCase() + ' ' + m.y : key; }
export function num(v) { const n = parseFloat(v); return isNaN(n) ? 0 : n; }
export function round(n) { return Math.round(+n || 0); }
export function normName(s) { return String(s || '').toLowerCase().replace(/[«»"',.()]/g, ' ').replace(/\s+/g, ' ').trim(); }
export function decadeDays(day) { return day >= 20 ? 10 : (day >= 10 ? 20 : 30); }

// Поле bank менеджер заполняет руками: «М Бизнес», «МБизнес», «Мбизнес Услуги», «МБизнес Усл», «РСК», «Касса …», «M-Bank».
export function bankKey(bank) {
  const s = String(bank || '').toLowerCase().replace(/\s+/g, '');
  if (!s) return 'none';
  if (/усл/.test(s)) return 'services';
  if (/мбизнес|м-?банк|m-?bank|mbusiness/.test(s)) return 'license';
  if (/касса|налич/.test(s)) return 'cash';
  return 'other';
}

// ---------- зарплата (зеркало index.html: fzPersonWord / fzNameKey / fzIsSalary / FZ_SALARY_RULES) ----------
export const NAME_ALIAS = { malika: 'малика', eliza: 'элиза', mirzahit: 'мирзахит', gulshan: 'гульшан', aselya: 'аселя', amir: 'амир' };
export const SALARY_RULES = [
  { person: 'Гульшан', category: /^услуг/i, note: /^гульшан/i, cat_label: 'Услуги', note_label: 'примечание начинается с «Гульшан»' },
];
export function personWord(s) { const ws = String(s || '').trim().split(/[\s,.(]+/).filter(Boolean); let w = ws[0] || ''; if (/^(аванс|зп|зарплата|премия|бонус|бонусы|отпускные)$/i.test(w) && ws[1]) w = ws[1]; return w; }
export function nameKey(s) { let w = personWord(s).toLowerCase(); w = NAME_ALIAS[w] || w; return w.slice(0, 4); }
export function salaryRule(e) { const c = String((e && e.category) || '').trim(), n = String((e && e.note) || '').trim(); return SALARY_RULES.find(r => r.category.test(c) && r.note.test(n)) || null; }
export function isSalary(e) { const c = String((e && e.category) || '').trim().toLowerCase(); return c === 'зп' || /^зп[\s./-]|зарплат|оклад|аванс|бонус|премия|отпускн/.test(c) || !!salaryRule(e); }
export function isTransfer(e) { return /перенос/i.test(String((e && e.category) || '')); }

// ---------- обязательные статьи месяца (что должно быть в расходах каждый месяц) ----------
// Сопоставление со строками таблицы: по статье (category) и/или примечанию (note). Показано на «Правилах и целях».
export const EXPECTED_ITEMS = [
  { key: 'rent', label: 'Аренда и коммуналка', category: /аренд|коммунал/i, note: /аренд|коммунал|технопарк/i, how: 'статья «Аренда» или примечание с «аренда», «коммуналка», «Технопарк»' }, // «офис»/«склад» нарочно нет: ловили мебель («Пуфик в офис»)
  { key: 'amo', label: 'amoCRM', category: /amo|амо/i, note: /\bamo|амо\s*срм|амосрм|amocrm/i, how: 'примечание с «amo», «амо», «amoCRM»' },
  { key: 'ads', label: 'Реклама и таргет', category: /реклам|таргет|маркет/i, note: /таргет|реклам|facebook|фейсбук|meta|инстаграм|instagram/i, how: 'статья «Реклама/Таргет» или примечание с «таргет», «реклама», «Facebook», «Instagram»' },
  { key: 'telephony', label: 'Виртуальная телефония', category: /телефони/i, note: /телефони|onlinepbx|pbx|sipuni|zadarma|билайн|beeline|(^|[^а-яё])атс([^а-яё]|$)/i, how: 'примечание с «телефония», «АТС», «Билайн» (счёт за АТС), «PBX», «Sipuni», «Zadarma»' }, // \b в JS не знает кириллицу — границы слова вручную
  { key: 'whatsapp', label: 'Платный WhatsApp', category: /whatsapp|ватсап|ваззап|wazzup/i, note: /whatsapp|ватсап|ваззап|wazzup/i, how: 'примечание с «WhatsApp», «Ватсап», «Wazzup»' },
  { key: 'water', label: 'Вода', category: /^вод[аы]?$/i, note: /(^|[^а-яё])вод[аыу]([^а-яё]|$)|кулер/i, how: 'статья «Вода» или примечание с «вода», «кулер» (например «Офис / Алтын Булак вода»)' },
  { key: 'taxi', label: 'Такси', category: /такси/i, note: /такси|яндекс/i, no_odd: true, how: 'статья «Такси» или примечание с «такси», «Яндекс»; сумма не сравнивается — такси каждый месяц разное' },
  { key: 'sim', label: 'Сим-карты и связь', category: /связ|сим/i, note: /сим|\bsim\b|мегаком|megacom|\bo!\b|nur\s*telecom|мобильн/i, exclude: /атс|телефони|билайн|beeline/i, how: 'статья «Связь» или примечание с «сим», «Мегаком», «O!», «мобильный», кроме АТС и Билайна (они — телефония)' },
];
export const ODD_THRESHOLD = 0.4; // отклонение от медианы прошлых месяцев больше 40% — «сумма резко отличается»

export function itemMatches(item, e) {
  if (!e || isTransfer(e) || isSalary(e)) return false;
  const c = String(e.category || ''), n = String(e.note || '');
  if (item.exclude && (item.exclude.test(n) || item.exclude.test(c))) return false;
  return item.category.test(c) || item.note.test(n);
}

// ---------- база: оплаты, клиенты, сотрудники (кэш 60 с на инстанс — чат дёргает инструменты подряд) ----------
let _base = null, _baseTs = 0;
export async function loadBase(force) {
  if (!force && _base && Date.now() - _baseTs < 60e3) return _base;
  const [payments, clients, employees] = await Promise.all([
    sbSelectAll('payments', { country: 'eq.' + COUNTRY, select: 'id,paid_at,company_name,client_id,category,category_raw,amount,qty,price,period_months,bank,manager_name,source,created_by,created_at,comment', order: 'paid_at.desc,id' }),
    sbSelectAll('clients', { country: 'eq.' + COUNTRY, select: 'client_id,company_name,city,status,next_billing_at,access_until,access_status,pay_reason,pay_reason_note,pay_reason_at,churned_at,subscription_period_months,support_operator,curator_operator,first_payment_date,last_payment_date', order: 'client_id' }),
    sbSelect('employees', { active: 'eq.true', select: 'name,pos,role,country,email', order: 'name', limit: '200' }),
  ]);
  _base = { payments, clients, employees: employees.filter(e => !e.country || e.country === COUNTRY) };
  _baseTs = Date.now();
  return _base;
}

// ---------- расходы: Google-таблица → снимок в finansist_expenses_cache → строки месяца ----------
function _gsToken() { const t = (process.env.SHEETS_TOKEN || '').trim(); return t ? '&token=' + encodeURIComponent(t) : ''; }
function _parseSheetDate(v) {
  if (v == null || v === '' || v === 0) return null;
  if (typeof v === 'number') { const d = new Date(Math.round((v - 25569) * 86400 * 1000)); return isNaN(d) ? null : d.toISOString().slice(0, 10); }
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/); if (m) return m[1] + '-' + m[2] + '-' + m[3];
  m = s.match(/^(\d{1,2})[.\/](\d{1,2})[.\/](\d{4})/); if (m) return m[3] + '-' + pad2(m[2]) + '-' + pad2(m[1]);
  m = s.match(/Date\((\d+),(\d+),(\d+)\)/); if (m) return m[1] + '-' + pad2(parseInt(m[2], 10) + 1) + '-' + pad2(m[3]);
  const d = new Date(s); return isNaN(d) ? null : d.toISOString().slice(0, 10);
}
async function _fetchExpenseSheet(tabName) {
  const tryOnce = async (name) => {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 28000);
    try {
      const r = await fetch(GS_URL + '?action=getSheet&sheet=' + encodeURIComponent(name) + '&spreadsheetId=' + EXP_SHEET_ID + '&range=A1:E1000' + _gsToken(), { signal: ctl.signal });
      if (!r.ok) throw new Error('Sheets ' + r.status);
      const j = await r.json();
      if (j.error) throw new Error('Sheets: ' + j.error);
      return j;
    } finally { clearTimeout(t); }
  };
  try { return await tryOnce(tabName); }
  catch (e) {
    if (!/Sheet not found/i.test(String(e && e.message || e))) throw e;
    return await tryOnce(tabName.toLowerCase());
  }
}
function _parseExpenseRows(json, monthKey) {
  const rows = (json && json.rows) || [];
  let headerIdx = -1;
  for (let i = 0; i < rows.length; i++) if (rows[i] && String(rows[i][0] || '').toLowerCase() === 'дата') { headerIdx = i; break; }
  const out = [];
  rows.slice(headerIdx >= 0 ? headerIdx + 1 : 1).forEach((row, i) => {
    if (!row || !row[0] || !row[3]) return;
    const amount = typeof row[3] === 'number' ? row[3] : parseFloat(String(row[3]).replace(/[^0-9.,-]/g, '').replace(',', '.'));
    if (!amount || amount <= 0) return;
    const date = _parseSheetDate(row[0]) || (monthKey + '-01');
    out.push({ id: monthKey + ':' + i, date, category: String(row[1] || 'Прочее').trim(), note: String(row[2] || '').trim(), amount, bank: String(row[4] || '').trim(), source: 'sheet' });
  });
  // дедуп как на фронте
  const seen = new Set();
  return out.filter(e => { const k = e.date + '|' + e.category + '|' + e.amount + '|' + e.note + '|' + e.bank; if (seen.has(k)) return false; seen.add(k); return true; });
}
// Снимок месяца: свежий (1 ч для текущего месяца, сутки для прошлых) — из кэша, иначе из таблицы.
// Таблица ведётся по текущему году: другие годы — «нет данных» (available:false).
export async function loadExpenseMonth(monthKey, opts) {
  opts = opts || {};
  const m = parseMonth(monthKey);
  const nowKey = currentMonthKey();
  if (!m || m.y !== +nowKey.slice(0, 4)) return { month: monthKey, rows: [], available: false, fetched_at: null };
  const ttl = monthKey === nowKey ? 3600e3 : 86400e3;
  let cached = null;
  try { const c = await sbSelect('finansist_expenses_cache', { month: 'eq.' + monthKey, limit: '1' }); cached = c[0] || null; } catch (_) {}
  if (cached && !opts.force && Date.now() - Date.parse(cached.fetched_at) < ttl) return { month: monthKey, rows: cached.rows || [], available: true, fetched_at: cached.fetched_at, from_cache: true };
  try {
    const json = await _fetchExpenseSheet(MONTHS_RU[m.mo - 1]);
    const rows = _parseExpenseRows(json, monthKey);
    const fetched_at = new Date().toISOString();
    try { await sbUpsert('finansist_expenses_cache', { month: monthKey, rows, fetched_at }, 'month'); } catch (e) { console.error('[finansist] cache write:', e.message); }
    return { month: monthKey, rows, available: true, fetched_at };
  } catch (e) {
    console.error('[finansist] expenses sheet ' + monthKey + ':', e.message);
    if (cached) return { month: monthKey, rows: cached.rows || [], available: true, fetched_at: cached.fetched_at, from_cache: true, stale: true };
    return { month: monthKey, rows: [], available: false, error: e.message };
  }
}
// Ручные суммы бухгалтера (status='filled') — виртуальные строки расходов, чтобы попадали во все расчёты.
export async function loadManualRows(monthKeys) {
  const rows = await sbSelect('finansist_missing_data', { country: 'eq.' + COUNTRY, status: 'eq.filled', limit: '1000' });
  const out = {};
  rows.forEach(r => {
    if (monthKeys && monthKeys.indexOf(r.month) < 0) return;
    (out[r.month] = out[r.month] || []).push({ id: 'manual:' + r.id, date: r.month + '-01', category: r.item_label, note: 'внесено вручную' + (r.filled_by_name ? ' (' + r.filled_by_name + ')' : ''), amount: num(r.amount), bank: '', source: 'manual', item_key: r.item_key });
  });
  return out;
}
export async function loadExpenses(monthKeys, opts) {
  const [snaps, manual, prepaid] = await Promise.all([Promise.all(monthKeys.map(k => loadExpenseMonth(k, opts))), loadManualRows(monthKeys), loadPrepaid()]);
  const byMonth = {};
  snaps.forEach(s => { byMonth[s.month] = { available: s.available, fetched_at: s.fetched_at, stale: !!s.stale, rows: (s.rows || []).concat(manual[s.month] || []) }; });
  applyPrepaid(byMonth, prepaid);
  return byMonth;
}

// ---------- предоплаченные расходы (CEO 27.09.2026: amoCRM 37 430 за 6 мес. = ~6 238 в месяц) ----------
// Список — в app_settings.finansist_prepaid.items: { id, label, item_key|null, amount, start:'YYYY-MM', months, added_by, added_at }.
// Правило: строка самой оплаты в месяце start из расходов убирается, вместо неё в каждый месяц срока
// кладётся равная доля (source='prepaid'). Обязательная статья в эти месяцы считается закрытой.
export async function loadPrepaid() {
  try { const r = await sbSelect('app_settings', { key: 'eq.finansist_prepaid', limit: '1' }); return ((r[0] && r[0].value && r[0].value.items) || []).filter(e => e && e.amount > 0 && e.months > 0 && parseMonth(e.start)); } catch (_) { return []; }
}
export async function savePrepaid(items) {
  await sbUpsert('app_settings', { key: 'finansist_prepaid', value: { items }, updated_at: new Date().toISOString() }, 'key');
  return items;
}
export function prepaidEnd(e) { return shiftMonthKey(e.start, e.months - 1); }
export function prepaidShare(e) { return Math.round(num(e.amount) / num(e.months) * 100) / 100; }
export function applyPrepaid(byMonth, prepaid) {
  (prepaid || []).forEach(e => {
    const item = e.item_key ? EXPECTED_ITEMS.find(i => i.key === e.item_key) : null;
    const share = prepaidShare(e);
    const end = prepaidEnd(e);
    Object.keys(byMonth).forEach(k => {
      const m = byMonth[k]; if (!m) return;
      if (k === e.start) {
        // сама оплата: та же статья (или любая, если статья не задана) и сумма ±1% — убираем, вместо неё доля
        m.rows = (m.rows || []).filter(r => !(r.source === 'sheet' && Math.abs(num(r.amount) - num(e.amount)) <= Math.max(1, num(e.amount) * 0.01) && (!item || itemMatches(item, r))));
      }
      if (k < e.start || k > end || !m.available) return;
      m.rows = (m.rows || []).concat([{ id: 'prepaid:' + e.id + ':' + k, date: k + '-01', category: e.label, note: 'предоплата ' + round(e.amount) + ' сом за ' + e.months + ' мес. (' + monthLabel(e.start) + ' – ' + monthLabel(end) + '), доля месяца', amount: share, bank: e.bank || '', source: 'prepaid', item_key: e.item_key || null, prepaid_id: e.id }]);
    });
  });
  return byMonth;
}
export function expenseRows(byMonth, monthKey) { const m = byMonth[monthKey]; if (!m || !m.available) return null; const rows = m.rows.filter(e => !isTransfer(e)); return rows.length ? rows : null; }

export function expenseSummary(rows) {
  const o = { total: 0, salary_total: 0, salaries: {}, shared_total: 0, shared_by_category: {}, by_bank: {}, manual_total: 0 };
  (rows || []).forEach(e => {
    const a = num(e.amount); o.total += a;
    if (e.source === 'manual') o.manual_total += a;
    const bk = bankKey(e.bank); o.by_bank[bk] = (o.by_bank[bk] || 0) + a;
    if (isSalary(e)) { o.salary_total += a; const k = nameKey(e.note); const nm = personWord(e.note); if (!o.salaries[k]) o.salaries[k] = { key: k, name: nm ? nm.charAt(0).toUpperCase() + nm.slice(1) : 'Без имени', sum: 0, n: 0 }; o.salaries[k].sum += a; o.salaries[k].n++; }
    else { const c = String(e.category || 'Прочее').trim(); o.shared_by_category[c] = (o.shared_by_category[c] || 0) + a; o.shared_total += a; }
  });
  return o;
}

// ---------- расхождения ----------
export function findDisputes(all, range) {
  const issues = {};
  const push = (id, type, text) => { (issues[id] = issues[id] || []).push({ type, text }); };
  all.forEach(p => {
    if (p.paid_at < BANK_RULE_FROM || num(p.amount) <= 0) return;
    const bk = bankKey(p.bank);
    if (bk !== 'license' && bk !== 'services') return;
    if (SERVICE_CATS.includes(p.category) && bk === 'license') push(p.id, 'bank', 'услуга на счёте лицензий');
    if (LICENSE_CATS.includes(p.category) && bk === 'services') push(p.id, 'bank', 'лицензия на счёте услуг');
  });
  const byClient = {};
  all.forEach(p => { if (num(p.amount) <= 0) return; const k = p.client_id || normName(p.company_name); (byClient[k] = byClient[k] || []).push(p); });
  Object.keys(byClient).forEach(k => {
    const rows = byClient[k].slice().sort((a, b) => a.paid_at < b.paid_at ? -1 : 1);
    for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++) {
      const a = rows[i], b = rows[j];
      if (daysBetween(a.paid_at, b.paid_at) > DUP_WINDOW_DAYS) break;
      if (a.category !== b.category || num(a.amount) !== num(b.amount)) continue;
      push(a.id, 'dup', 'такой же платёж ' + fmtDay(b.paid_at));
      push(b.id, 'dup', 'такой же платёж ' + fmtDay(a.paid_at));
    }
  });
  all.forEach(p => {
    if (!DECADE_CATS.includes(p.category)) return;
    const qty = num(p.qty), price = num(p.price), months = num(p.period_months), amount = num(p.amount);
    if (qty <= 0 || price <= 0 || months <= 0 || amount <= 0) return;
    const day = dayOf(p.paid_at); if (day < 10) return;
    if (Math.abs(amount - qty * price * months) >= 1) return;
    const dd = decadeDays(day); const expected = Math.round(qty * price * (months - 1 + dd / 30));
    push(p.id, 'dec', 'проверить: по декаде ' + dd + ' дн., ожидалось ' + expected + ', внесено за полные месяцы (мог быть остаток на балансе)');
  });
  const list = all.filter(p => issues[p.id] && (!range || (p.paid_at >= range.from && p.paid_at <= range.to)))
    .map(p => ({ id: p.id, paid_at: p.paid_at, company_name: p.company_name, client_id: p.client_id, category: p.category, category_raw: p.category_raw, amount: num(p.amount), bank: p.bank, bank_key: bankKey(p.bank), manager_name: p.manager_name, source: p.source, created_by: p.created_by, issues: issues[p.id] }))
    .sort((a, b) => a.paid_at < b.paid_at ? 1 : -1);
  const counts = { bank: 0, dup: 0, dec: 0 };
  list.forEach(p => { const seen = {}; p.issues.forEach(i => { if (!seen[i.type]) { counts[i.type]++; seen[i.type] = 1; } }); });
  return { list, issues, counts };
}

// ---------- период: выручка, расходы, команда ----------
export function inRange(p, r) { return p.paid_at >= r.from && p.paid_at <= r.to; }
export function sumBy(rows, fn) { const o = {}; rows.forEach(p => { const k = fn(p) || '—'; o[k] = (o[k] || 0) + num(p.amount); }); return o; }

export function periodSummary(base, range, expRowsOrNull) {
  const cur = base.payments.filter(p => inRange(p, range));
  const revenue = cur.reduce((a, p) => a + num(p.amount), 0);
  const exp = expRowsOrNull ? expenseSummary(expRowsOrNull) : null;
  const out = {
    from: range.from, to: range.to, count: cur.length, revenue,
    by_category: sumBy(cur, p => p.category), by_bank: sumBy(cur, p => bankKey(p.bank)), by_manager: sumBy(cur, p => p.manager_name),
    expenses: exp ? exp.total : null, salaries: exp ? exp.salary_total : null, shared: exp ? exp.shared_total : null, shared_by_category: exp ? exp.shared_by_category : null,
    manual_expenses: exp ? exp.manual_total : 0,
    profit: exp ? revenue - exp.total : null,
    margin_pct: exp && revenue ? Math.round((revenue - exp.total) / revenue * 1000) / 10 : null,
    salary_share_pct: exp && revenue ? Math.round(exp.salary_total / revenue * 100) : null,
  };
  return out;
}

export function teamRows(base, range, expRowsOrNull) {
  const cur = base.payments.filter(p => inRange(p, range));
  const exp = expRowsOrNull ? expenseSummary(expRowsOrNull) : null;
  const rows = {};
  cur.forEach(p => { const n = (p.manager_name || '').trim() || 'Без менеджера'; const k = nameKey(n); const t = rows[k] = rows[k] || { name: n, revenue: 0, count: 0, new_clients: 0, salary: 0, has_salary: false }; t.revenue += num(p.amount); t.count++; if (p.category === 'license') t.new_clients++; });
  if (exp) Object.keys(exp.salaries).forEach(k => { const s = exp.salaries[k]; const t = rows[k] = rows[k] || { name: s.name, revenue: 0, count: 0, new_clients: 0, salary: 0, has_salary: false }; t.salary = s.sum; t.has_salary = true; });
  const list = Object.values(rows).map(r => Object.assign(r, { result: r.revenue - r.salary, status: (!r.has_salary && r.revenue > 0) ? 'нет в расходах' : (r.revenue <= 0 ? 'без выручки' : (r.revenue - r.salary >= 0 ? 'окупается' : 'в минусе')) }));
  list.sort((a, b) => b.revenue - a.revenue || b.salary - a.salary);
  return { rows: list, has_expenses: !!exp, shared: exp ? exp.shared_total : null, shared_by_category: exp ? exp.shared_by_category : null };
}

// ---------- отток ----------
export function lastSubscriptionByClient(payments) {
  const o = {};
  payments.forEach(p => { if (!LICENSE_CATS.includes(p.category) || num(p.amount) <= 0) return; const k = p.client_id || normName(p.company_name); if (!o[k]) o[k] = p; });
  return o;
}
export function monthlyValue(p) { const m = num(p.period_months); return num(p.amount) / (m > 0 ? m : 1); }
export async function churnForMonth(base, range) {
  const lastSub = lastSubscriptionByClient(base.payments);
  const inMonthTs = ts => { const s = String(ts || '').slice(0, 10); return s >= range.from && s <= range.to; };
  const left = base.clients.filter(c => inMonthTs(c.churned_at) || ((c.pay_reason === 'churn' || c.pay_reason === 'decline') && inMonthTs(c.pay_reason_at))).map(c => {
    const last = lastSub[c.client_id] || lastSub[normName(c.company_name)];
    return { client_id: c.client_id, company_name: c.company_name, city: c.city, kind: c.pay_reason === 'decline' ? 'decline' : 'churn', reason: c.pay_reason_note || '', when: (c.churned_at || c.pay_reason_at || '').slice(0, 10), monthly: last ? Math.round(monthlyValue(last)) : 0, last_paid_at: last ? last.paid_at : null, operator: c.support_operator || null };
  });
  const [churnRows, licRows, licPeriods] = await Promise.all([
    sbSelectAll('churn_records', { country: 'eq.' + COUNTRY, period_month: 'eq.' + range.from, select: 'period_month,company_name,company_key,kind,prev_count,prev_amount,cur_count,cur_amount,diff,reason,reason_raw' }),
    sbSelectAll('churn_license_changes', { country: 'eq.' + COUNTRY, period_month: 'eq.' + range.from, select: 'period_month,company_key,license_type,m1_count,m2_count,diff' }),
    sbSelectAll('churn_license_changes', { country: 'eq.' + COUNTRY, select: 'period_month' }),
  ]);
  const licBy = {};
  licRows.forEach(r => { const o = licBy[r.company_key] = licBy[r.company_key] || { company_key: r.company_key, before: 0, after: 0, diff: 0 }; o.before += num(r.m1_count); o.after += num(r.m2_count); o.diff += num(r.diff); });
  const cur = base.payments.filter(p => inRange(p, range));
  const newRows = cur.filter(p => p.category === 'license' && num(p.amount) > 0);
  return {
    left, lost_monthly: left.reduce((a, c) => a + c.monthly, 0),
    new_monthly: Math.round(newRows.reduce((a, p) => a + monthlyValue(p), 0)),
    new_clients: new Set(newRows.map(p => p.client_id || normName(p.company_name))).size,
    records: churnRows.map(r => ({ company_name: r.company_name, kind: r.kind, prev_count: r.prev_count, cur_count: r.cur_count, prev_amount: num(r.prev_amount), cur_amount: num(r.cur_amount), diff: r.diff, reason: r.reason || r.reason_raw || '' })),
    license_changes: Object.values(licBy).filter(o => o.diff !== 0).sort((a, b) => a.diff - b.diff).slice(0, 40),
    periods_available: Array.from(new Set(churnRows.map(r => r.period_month).concat(licPeriods.map(r => r.period_month)))).filter(Boolean).sort().reverse(),
  };
}

// ---------- касса ----------
export function cashForecast(base, days) {
  const today = bishkekIso(); days = Math.min(90, Math.max(7, days || 30));
  const d90 = addDays(today, -90);
  const last90 = base.payments.filter(p => p.paid_at > d90 && p.paid_at <= today && num(p.amount) > 0);
  const lastSub = lastSubscriptionByClient(base.payments);
  const active = base.clients.filter(c => c.status === 'active');
  const estFor = c => { const last = lastSub[c.client_id] || lastSub[normName(c.company_name)]; return last ? num(last.amount) : 0; };
  const expected = active.filter(c => c.next_billing_at && c.next_billing_at >= today && c.next_billing_at <= addDays(today, 90)).map(c => ({ client_id: c.client_id, company_name: c.company_name, date: c.next_billing_at, est: estFor(c), months: c.subscription_period_months || null })).sort((a, b) => a.date < b.date ? -1 : 1);
  const overdue = active.filter(c => c.next_billing_at && c.next_billing_at < today);
  return { today, days, daily_avg_90: Math.round(last90.reduce((a, p) => a + num(p.amount), 0) / 90), inflow_90: last90.reduce((a, p) => a + num(p.amount), 0), expected, expected_30: expected.filter(e => e.date <= addDays(today, 30)).reduce((a, e) => a + e.est, 0), expected_60: expected.filter(e => e.date <= addDays(today, 60)).reduce((a, e) => a + e.est, 0), expected_90: expected.reduce((a, e) => a + e.est, 0), overdue_count: overdue.length, overdue_est: overdue.reduce((a, c) => a + estFor(c), 0) };
}

// ---------- недостающие данные ----------
function median(arr) { const a = arr.slice().sort((x, y) => x - y); if (!a.length) return null; const m = Math.floor(a.length / 2); return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; }
// Проверка месяца: по каждой обязательной статье — нашлись ли строки в таблице, сколько, и как это соотносится
// с медианой трёх прошлых месяцев, где данные были. Ручные суммы (source='manual') сюда не считаются как «настоящие».
// Когда проверка не имеет смысла: месяца в таблице нет вовсе (другой год, лист пуст) — «нет данных», а не
// «всё отсутствует»; текущий месяц до 20-го числа — статьи ещё могут быть просто не внесены («рано»).
export const MISSING_CHECK_FROM_DAY = 20;
export function missingCheckMode(byMonth, monthKey) {
  const m = byMonth[monthKey];
  if (!m || !m.available || !(m.rows || []).some(r => r.source === 'sheet')) return 'no_data';
  if (monthKey === currentMonthKey() && parseInt(bishkekIso().slice(8, 10), 10) < MISSING_CHECK_FROM_DAY) return 'early';
  return 'full';
}
export function checkMissing(byMonth, monthKey) {
  const prevKeys = [1, 2, 3, 4, 5, 6].map(k => shiftMonthKey(monthKey, -k));
  const mode = missingCheckMode(byMonth, monthKey);
  const items = EXPECTED_ITEMS.map(item => {
    const cur = ((byMonth[monthKey] && byMonth[monthKey].rows) || []).filter(e => e.source !== 'manual' && itemMatches(item, e));
    const found = cur.reduce((a, e) => a + num(e.amount), 0);
    const prepaid = cur.some(e => e.source === 'prepaid'); // доля предоплаты — сумма известна по построению, сравнивать не с чем
    const prev = [];
    prevKeys.forEach(k => { const m = byMonth[k]; if (!m || !m.available || prev.length >= 3) return; const s = m.rows.filter(e => e.source !== 'manual' && itemMatches(item, e)).reduce((a, e) => a + num(e.amount), 0); if (s > 0) prev.push({ month: k, sum: s }); });
    const med = median(prev.map(p => p.sum));
    let status = 'ok';
    if (mode === 'no_data') status = 'no_data';
    else if (!cur.length) status = mode === 'early' ? 'early' : 'missing';
    else if (prepaid) status = 'ok';
    else if (!item.no_odd && med && Math.abs(found - med) / med > ODD_THRESHOLD) status = 'odd';
    return { item_key: item.key, item_label: item.label, status, prepaid, found_amount: found, found_rows: cur.map(e => ({ date: e.date, category: e.category, note: e.note, amount: e.amount, source: e.source })), expected_amount: med, prev, how: item.how };
  });
  items.mode = mode;
  return items;
}
// Синхронизация с таблицей finansist_missing_data. Возвращает актуальный список и что изменилось
// (в т.ч. «ручная сумма заменена настоящей строкой» — защита от двойного учёта).
export async function syncMissing(byMonth, monthKey) {
  const found = checkMissing(byMonth, monthKey);
  const existing = await sbSelect('finansist_missing_data', { country: 'eq.' + COUNTRY, month: 'eq.' + monthKey, limit: '100' });
  const exMap = {}; existing.forEach(r => { exMap[r.item_key] = r; });
  const changes = [];
  const now = new Date().toISOString();
  for (const it of found) {
    const ex = exMap[it.item_key];
    if (it.status === 'no_data' || it.status === 'early') { // рано судить: ничего не заводим, а старые «нет строки/отличается» (заведённые, пока данных не было) убираем
      if (ex && (ex.status === 'missing' || ex.status === 'odd')) { await sbDelete('finansist_missing_data', { id: 'eq.' + ex.id }); changes.push({ type: 'resolved', item: it, prev: ex }); }
      continue;
    }
    const note = it.status === 'missing'
      ? 'В таблице расходов за ' + monthLabel(monthKey) + ' нет строки «' + it.item_label + '». Спросить у Гульшан сумму' + (it.expected_amount ? ' (обычно около ' + round(it.expected_amount) + ' сом)' : '') + '.'
      : it.status === 'odd' ? '«' + it.item_label + '» за ' + monthLabel(monthKey) + ': ' + round(it.found_amount) + ' сом, обычно около ' + round(it.expected_amount) + ' сом. Уточнить у Гульшан, всё ли внесено.' : null;
    if (it.status === 'ok') {
      if (!ex) continue;
      if (ex.status === 'filled') { await sbUpdate('finansist_missing_data', { id: 'eq.' + ex.id }, { status: 'superseded', found_amount: it.found_amount, note: (it.prepaid ? 'Статья «' + it.item_label + '» закрыта предоплатой (' + round(it.found_amount) + ' сом в месяц)' : 'В таблице появилась настоящая строка «' + it.item_label + '» на ' + round(it.found_amount) + ' сом') + ' — ручная сумма ' + round(ex.amount) + ' сом больше не учитывается.', updated_at: now }); changes.push({ type: 'superseded', item: it, prev: ex }); }
      else if (ex.status === 'missing' || ex.status === 'odd') { await sbDelete('finansist_missing_data', { id: 'eq.' + ex.id }); changes.push({ type: 'resolved', item: it, prev: ex }); }
      continue;
    }
    if (!ex) { const ins = await sbInsert('finansist_missing_data', { country: COUNTRY, month: monthKey, item_key: it.item_key, item_label: it.item_label, status: it.status, expected_amount: it.expected_amount, found_amount: it.found_amount, note, created_at: now, updated_at: now }); exMap[it.item_key] = ins[0]; changes.push({ type: 'new', item: it }); continue; }
    if (ex.status === 'filled' || ex.status === 'ignored' || ex.status === 'superseded') {
      if (ex.status === 'superseded' && it.status === 'missing') { await sbUpdate('finansist_missing_data', { id: 'eq.' + ex.id }, { status: 'filled', note: 'Настоящая строка исчезла — снова учитываем ручную сумму.', updated_at: now }); changes.push({ type: 'refilled', item: it, prev: ex }); }
      continue;
    }
    if (ex.status !== it.status || round(ex.found_amount) !== round(it.found_amount)) { await sbUpdate('finansist_missing_data', { id: 'eq.' + ex.id }, { status: it.status, expected_amount: it.expected_amount, found_amount: it.found_amount, note, updated_at: now }); }
  }
  const rows = await sbSelect('finansist_missing_data', { country: 'eq.' + COUNTRY, month: 'eq.' + monthKey, order: 'item_key', limit: '100' });
  return { items: rows, check: found, mode: found.mode, changes, incomplete: rows.some(r => r.status === 'missing' || r.status === 'odd') };
}

// ---------- решения ----------
export async function loadDecisions() { return sbSelect('finansist_decisions', { country: 'eq.' + COUNTRY, active: 'eq.true', order: 'created_at.desc', limit: '200' }); }
export async function saveDecision(key, text, source, month, who, whoName) {
  const rows = await sbUpsert('finansist_decisions', { country: COUNTRY, key: String(key).slice(0, 200), text: String(text).slice(0, 1000), source, month: month || null, decided_by: who || null, decided_by_name: whoName || null, active: true, created_at: new Date().toISOString() }, 'country,key');
  return rows[0];
}

// ---------- расход на API: дневной лимит ----------
const DEFAULT_DAILY_LIMIT_USD = 2; // CEO 27.09.2026: агент — один отчёт в день, не постоянные разговоры
export async function getAgentLimits() {
  try { const r = await sbSelect('app_settings', { key: 'eq.finansist_agent_limits', limit: '1' }); const v = (r[0] && r[0].value) || {}; return { daily_usd: num(v.daily_usd) || DEFAULT_DAILY_LIMIT_USD }; } catch (_) { return { daily_usd: DEFAULT_DAILY_LIMIT_USD }; }
}
export async function getSpend(dayIso) {
  try { const r = await sbSelect('app_settings', { key: 'eq.finansist_agent_spend', limit: '1' }); const v = (r[0] && r[0].value) || {}; return { day: dayIso, usd: num(v[dayIso]), all: v }; } catch (_) { return { day: dayIso, usd: 0, all: {} }; }
}
export async function addSpend(dayIso, usd) {
  const cur = await getSpend(dayIso);
  const all = Object.assign({}, cur.all); all[dayIso] = Math.round((num(all[dayIso]) + usd) * 10000) / 10000;
  const keys = Object.keys(all).sort(); while (keys.length > 60) delete all[keys.shift()]; // храним два месяца
  await sbUpsert('app_settings', { key: 'finansist_agent_spend', value: all, updated_at: new Date().toISOString() }, 'key');
  return all[dayIso];
}
