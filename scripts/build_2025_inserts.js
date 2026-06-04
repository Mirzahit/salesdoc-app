#!/usr/bin/env node
// Parses 24 downloaded Sheets JSON files (KZ + KG, 12 months of 2025)
// from C:/Users/Мирзахит/Downloads/p2025/<KZ|KG>_<Янв..Дек>.json
// Emits a single SQL file with multi-row INSERTs into public.payments
// with ON CONFLICT-safe duplicate guard.
//
// Output: C:/Users/Мирзахит/Downloads/p2025/payments_2025_inserts.sql
//
// Run: node scripts/build_2025_inserts.js

const fs = require('fs');
const path = require('path');

const SRC_DIR = 'C:/Users/Мирзахит/Downloads/p2025';
const OUT_FILE = 'C:/Users/Мирзахит/Downloads/p2025/payments_2025_inserts.sql';
const STATS_FILE = 'C:/Users/Мирзахит/Downloads/p2025/payments_2025_stats.json';

const MONTHS = ['Янв','Фев','Мар','Апр','Май','Июн','Июл','Авг','Сен','Окт','Ноя','Дек'];

const COUNTRIES = {
  KZ: {
    sheet_id: '11ErpSR9fJ_T0ggWBrHjRB35cMs4yl84HedSO1Tf4Z08',
    currency: 'KZT',
    dateCorrection: 0
  },
  KG: {
    sheet_id: '1e34EE4DKuj2tzatlX1qBFEAEX7aDtky02R2HA2KE7_M',
    currency: 'KGS',
    dateCorrection: 1
  }
};

// ---- helpers (cloned 1:1 from api/payments.js) ----

function parseDate(v, dateCorrection) {
  if (v == null) return null;
  if (typeof v === 'number') {
    if (v === 0) return null;
    const d = new Date(Math.round((v - 25569) * 86400 * 1000));
    if (isNaN(d)) return null;
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  let s = String(v).trim();
  if (!s || s === '0' || s === '-' || s === '—') return null;
  const m1 = s.match(/Date\((\d+),(\d+),(\d+)\)/);
  if (m1) return m1[1] + '-' + String(parseInt(m1[2]) + 1).padStart(2, '0') + '-' + String(m1[3]).padStart(2, '0');
  const m2 = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (m2) {
    const dObj = new Date(parseInt(m2[3]), parseInt(m2[2]) - 1, parseInt(m2[1]) + (dateCorrection || 0));
    if (isNaN(dObj.getTime())) return null;
    return dObj.getFullYear() + '-' + String(dObj.getMonth() + 1).padStart(2, '0') + '-' + String(dObj.getDate()).padStart(2, '0');
  }
  if (s.match(/^\d{4}-\d{2}-\d{2}/)) return s.substring(0, 10);
  try {
    const d = new Date(s);
    if (!isNaN(d) && d.getFullYear() > 2000) {
      return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    }
  } catch (e) {}
  return null;
}

function mapCategory(cat) {
  const c = String(cat || '').toLowerCase().replace(/\./g, ' ').replace(/\s+/g, ' ').trim();
  if (c.includes('интеграц')) return 'integration';
  if (c.includes('внедрен') || c.includes('доработ')) return 'implementation';
  if (c.includes('абон') || c.includes('баланс')) return 'subscription';
  if (c.includes('лицен') || c.includes('новый клиент') || c.includes('нов клиент')) return 'license';
  return 'other';
}

function parseNumber(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  const s = String(v).replace(/\s/g, '').replace(/[^0-9.,-]/g, '').replace(',', '.');
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}

function parseRow(row, hdrRow, cfg, monthName, monthIdx, sheetRowAbs) {
  if (!row || row[1] == null || String(row[1]).trim() === '') return null;
  let colDate = 0, colClient = 1, colCat = 2, colMgr = 5, colAmt = 12, colBank = 10, colSeated = 11, colTech = 17, colActivation = -1;
  if (hdrRow) {
    hdrRow.forEach((h, i) => {
      const s = String(h || '').toLowerCase();
      if (s === 'дата' && i < 3) colDate = i;
      else if (s === 'компания') colClient = i;
      else if (s.includes('стать')) colCat = i;
      else if (s === 'менеджер') colMgr = i;
      else if (s.includes('сумма') && s.includes('факт')) colAmt = i;
      else if (s.includes('сумма') && !s.includes('факт') && !s.includes('оста')) { if (colAmt === 9) colAmt = i; }
      else if (s === 'банк') colBank = i;
      else if (s.includes('посаж')) colSeated = i;
      else if (s.includes('тех') && !s.includes('актив')) colTech = i;
    });
    const h14 = String(hdrRow[14] || '').toLowerCase();
    if (h14.includes('актив')) colActivation = 14;
    else hdrRow.forEach((h, i) => {
      const s = String(h || '').toLowerCase();
      if (colActivation < 0 && s.includes('дата') && s.includes('актив') && !s.includes('цена')) colActivation = i;
    });
    if (colActivation < 0) colActivation = 14;
  }
  let amtRaw = row[colAmt];
  if (amtRaw == null || String(amtRaw).trim() === '') amtRaw = row[9];
  const amount = parseNumber(amtRaw);
  if (!amount || amount <= 0) return null;
  let paidAt = parseDate(row[colDate], cfg.dateCorrection);
  if (!paidAt) paidAt = `2025-${String(monthIdx + 1).padStart(2, '0')}-01`;
  const company = String(row[colClient] || '').trim();
  if (!company) return null;
  const catRaw = String(row[colCat] || '').trim();
  let actDate = parseDate(row[colActivation], cfg.dateCorrection);
  if (!actDate && colActivation === 14) actDate = parseDate(row[15], cfg.dateCorrection);
  return {
    paid_at: paidAt,
    company_name: company,
    category_raw: catRaw,
    category: mapCategory(catRaw),
    amount,
    amount_planned: parseNumber(row[9]),
    manager_name: String(row[colMgr] || '').trim() || null,
    bank: String(row[colBank] || '').trim() || null,
    seated: (function () { const v = String(row[colSeated] || '').trim(); return v === 'Да' || v === 'да' || v === '+'; })(),
    tech_support: String(row[colTech] || '').trim() || null,
    qty: parseNumber(row[4]),
    price: parseNumber(row[7]),
    period_months: (function () { const n = parseNumber(row[8]); return n != null ? Math.max(0, Math.min(60, Math.round(n))) : null; })(),
    activation_date: actDate,
    period_start_raw: row[19] ? String(row[19]).trim() : null,
    sheet_tab: monthName,
    sheet_row: sheetRowAbs
  };
}

function sqlStr(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return "'" + String(v).replace(/'/g, "''") + "'";
}

// ---- main ----

const allRows = [];
const stats = { by_country: {}, by_month: {} };

for (const country of Object.keys(COUNTRIES)) {
  const cfg = COUNTRIES[country];
  stats.by_country[country] = { rows: 0, sum: 0 };
  for (let mi = 0; mi < MONTHS.length; mi++) {
    const monthName = MONTHS[mi];
    const file = path.join(SRC_DIR, `${country.toLowerCase()}_${monthName}.json`);
    if (!fs.existsSync(file)) { console.warn('MISS', file); continue; }
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); }
    catch (e) { console.warn('READ ERR', file, e.message); continue; }
    let data;
    try { data = JSON.parse(raw); }
    catch (e) { console.warn('JSON ERR', file, e.message); continue; }
    if (!data || !Array.isArray(data.rows) || data.rows.length < 2) { continue; }
    // Find header row (the one where row[1] === 'Компания')
    let headerIdx = -1;
    for (let ri = 0; ri < data.rows.length; ri++) {
      const r = data.rows[ri];
      if (r && String(r[1] || '').trim() === 'Компания') { headerIdx = ri; break; }
    }
    const hdrRow = headerIdx >= 0 ? data.rows[headerIdx] : null;
    const startIdx = headerIdx >= 0 ? headerIdx + 1 : 4;
    let monthRows = 0, monthSum = 0;
    data.rows.slice(startIdx).forEach((row, idx) => {
      const sheetRowAbs = startIdx + idx + 1;
      const parsed = parseRow(row, hdrRow, cfg, monthName, mi, sheetRowAbs);
      if (!parsed) return;
      parsed.country = country;
      parsed.currency = cfg.currency;
      parsed.source = 'sheets_import';
      parsed.sheet_id = cfg.sheet_id;
      // Force 2025 if for some reason date got parsed to 2026
      if (!/^2025-/.test(parsed.paid_at)) {
        const d = new Date(parsed.paid_at);
        if (!isNaN(d) && d.getFullYear() !== 2025) {
          parsed.paid_at = '2025-' + parsed.paid_at.substring(5);
        }
      }
      allRows.push(parsed);
      monthRows++; monthSum += parsed.amount;
    });
    stats.by_country[country].rows += monthRows;
    stats.by_country[country].sum += monthSum;
    stats.by_month[`${country}_${monthName}`] = { rows: monthRows, sum: monthSum };
  }
}

// ---- emit SQL ----

const BATCH = 100;
const cols = [
  'country','paid_at','company_name','category','category_raw','amount','amount_planned',
  'currency','qty','price','period_months','bank','manager_name','tech_support','seated',
  'activation_date','period_start_raw','source','sheet_id','sheet_tab','sheet_row'
];

const lines = [];
lines.push('-- Auto-generated 2025 payments import for KZ+KG');
lines.push(`-- Total rows: ${allRows.length}`);
lines.push(`-- Per-country: ${JSON.stringify(stats.by_country)}`);
lines.push('');
lines.push('BEGIN;');
lines.push('');

for (let i = 0; i < allRows.length; i += BATCH) {
  const slice = allRows.slice(i, i + BATCH);
  lines.push(`INSERT INTO payments (${cols.join(', ')}) VALUES`);
  const valueRows = slice.map(p => {
    const vals = [
      sqlStr(p.country),
      sqlStr(p.paid_at),
      sqlStr(p.company_name),
      sqlStr(p.category),
      sqlStr(p.category_raw),
      sqlStr(p.amount),
      sqlStr(p.amount_planned),
      sqlStr(p.currency),
      sqlStr(p.qty),
      sqlStr(p.price),
      sqlStr(p.period_months),
      sqlStr(p.bank),
      sqlStr(p.manager_name),
      sqlStr(p.tech_support),
      sqlStr(p.seated),
      sqlStr(p.activation_date),
      sqlStr(p.period_start_raw),
      sqlStr(p.source),
      sqlStr(p.sheet_id),
      sqlStr(p.sheet_tab),
      sqlStr(p.sheet_row)
    ];
    return `  (${vals.join(', ')})`;
  });
  lines.push(valueRows.join(',\n'));
  lines.push('  ON CONFLICT DO NOTHING;');
  lines.push('');
}

lines.push('COMMIT;');
lines.push('');

fs.writeFileSync(OUT_FILE, lines.join('\n'), 'utf8');
fs.writeFileSync(STATS_FILE, JSON.stringify({ total_rows: allRows.length, ...stats }, null, 2), 'utf8');

console.log('OK rows=' + allRows.length, ' file=' + OUT_FILE);
console.log('stats=', JSON.stringify(stats.by_country));
