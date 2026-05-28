// /api/payments — Платежи компании. Источник истины с v512 (мигрируем с Google Sheets).
//
// GET    /api/payments?country=KZ                               → все платежи страны
// GET    /api/payments?country=KZ&from=2026-05-01&to=2026-05-31 → за период
// GET    /api/payments?client_id=SD-KZ-2026-00003               → по клиенту
// GET    /api/payments?unmatched=1&country=KZ                   → без привязки к client_id
// GET    /api/payments?id=UUID                                  → один платёж
// POST   /api/payments                                          → создать (бот / manual)
//        body: { country, paid_at, company_name, amount, currency, category, ... }
// PATCH  /api/payments?id=UUID                                  → редактировать (whitelist)
// DELETE /api/payments?id=UUID                                  → удалить (только manual)

import { sbSelect, sbInsert, sbUpdate, sbDelete } from './_supabase.js';
import { checkAuth } from './_auth.js';

const ALLOWED_COUNTRIES = ['KZ', 'KG'];
const ALLOWED_CATEGORIES = ['implementation', 'integration', 'subscription', 'license', 'other'];
const ALLOWED_SOURCES = ['manual', 'payment_bot', 'sheets_import'];
const ALLOWED_PATCH_FIELDS = [
  'paid_at', 'company_name', 'client_id', 'category', 'category_raw',
  'amount', 'amount_planned', 'currency', 'qty', 'price', 'period_months',
  'bank', 'manager_name', 'tech_support', 'seated', 'activation_date',
  'period_start_raw', 'comment', 'notes'
];

function _normName(s) {
  return String(s || '').toLowerCase().replace(/[«»"',.()]/g, ' ').replace(/\s+/g, ' ').trim();
}

function _defaultCurrency(country) {
  return country === 'KG' ? 'KGS' : 'KZT';
}

// Резолв client_id по company_name (точное совпадение нормализованного имени).
// Если найдено больше 1 кандидата — возвращаем null, попадёт в unmatched.
async function _resolveClientId(companyName, country) {
  const norm = _normName(companyName);
  if (!norm) return null;
  const rows = await sbSelect('clients', {
    country: 'eq.' + country,
    limit: '500'
  });
  const matches = rows.filter(r => _normName(r.company_name) === norm);
  if (matches.length === 1) return matches[0].client_id;
  return null;
}

// === Sheets-import конфигурация (KZ/KG таблицы доходов) ===
const SHEET_CONFIG = {
  KZ: {
    sheet_id: '1WJJRqPvQ_i9jVhQgNc2Kuuynneu9jjTJwMGijCZKHbo',
    gs_url: 'https://script.google.com/macros/s/AKfycbwwNL4CxOrSo4wXT3qci_dSSqi5tABLPUqHQPv2nWrn_WQhZsaOpfnwdygaqskzuHphvg/exec',
    months: ['Янв','Фев','Мар','Апр','Май','Июн','Июл','Авг','Сен','Окт','Ноя','Дек'],
    currency: 'KZT',
    dateCorrection: 0
  },
  KG: {
    sheet_id: '1RbnGDy0rZJj7Ek-j1y3FkAToCSXXtR8F-5a7ga67O2Q',
    gs_url: 'https://script.google.com/macros/s/AKfycbwwNL4CxOrSo4wXT3qci_dSSqi5tABLPUqHQPv2nWrn_WQhZsaOpfnwdygaqskzuHphvg/exec',
    months: ['Январь','Февраль','Март','Апрель','Май','Июнь','Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'],
    currency: 'KGS',
    dateCorrection: 1
  }
};

function _parseDate(v, dateCorrection) {
  if (v == null) return null;
  if (typeof v === 'number') {
    if (v === 0) return null;
    const d = new Date(Math.round((v - 25569) * 86400 * 1000));
    if (isNaN(d)) return null;
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  let s = String(v).trim();
  if (!s || s === '0' || s === '-' || s === '—') return null;
  // gviz Date(YYYY,M,D)
  const m1 = s.match(/Date\((\d+),(\d+),(\d+)\)/);
  if (m1) return m1[1] + '-' + String(parseInt(m1[2]) + 1).padStart(2, '0') + '-' + String(m1[3]).padStart(2, '0');
  // DD.MM.YYYY
  const m2 = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (m2) {
    let d = parseInt(m2[1]) + (dateCorrection || 0);
    return m2[3] + '-' + m2[2].padStart(2, '0') + '-' + String(d).padStart(2, '0');
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

function _mapCategory(cat) {
  const c = String(cat || '').toLowerCase().replace(/\./g, ' ').replace(/\s+/g, ' ').trim();
  if (c.includes('интеграц')) return 'integration';
  if (c.includes('внедрен') || c.includes('доработ')) return 'implementation';
  if (c.includes('абон') || c.includes('баланс')) return 'subscription';
  if (c.includes('лицен') || c.includes('новый клиент') || c.includes('нов клиент')) return 'license';
  return 'other';
}

function _parseNumber(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  const s = String(v).replace(/\s/g, '').replace(/[^0-9.,-]/g, '').replace(',', '.');
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}

// Парсит одну строку Sheets в payment-объект по той же логике что index.html:9118
function _parseRow(row, headerIdx, hdrRow, cfg, monthName, monthIdx, sheetRowAbs) {
  if (!row || row[1] == null || String(row[1]).trim() === '') return null;
  // Определяем колонки динамически (по образцу syncFromSheets)
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
  // Сумма: M (colAmt) приоритет, J (9) fallback
  let amtRaw = row[colAmt];
  if (amtRaw == null || String(amtRaw).trim() === '') amtRaw = row[9];
  const amount = _parseNumber(amtRaw);
  if (!amount || amount <= 0) return null;
  // Дата
  let paidAt = _parseDate(row[colDate], cfg.dateCorrection);
  if (!paidAt) paidAt = `2026-${String(monthIdx + 1).padStart(2, '0')}-01`;
  const company = String(row[colClient] || '').trim();
  if (!company) return null;
  const catRaw = String(row[colCat] || '').trim();
  let actDate = _parseDate(row[colActivation], cfg.dateCorrection);
  if (!actDate && colActivation === 14) actDate = _parseDate(row[15], cfg.dateCorrection);
  return {
    paid_at: paidAt,
    company_name: company,
    category_raw: catRaw,
    category: _mapCategory(catRaw),
    amount,
    amount_planned: _parseNumber(row[9]),
    manager_name: String(row[colMgr] || '').trim() || null,
    bank: String(row[colBank] || '').trim() || null,
    seated: (function () { const v = String(row[colSeated] || '').trim(); return v === 'Да' || v === 'да' || v === '+'; })(),
    tech_support: String(row[colTech] || '').trim() || null,
    qty: _parseNumber(row[4]),
    price: _parseNumber(row[7]),
    period_months: (function () { const n = _parseNumber(row[8]); return n != null ? Math.max(0, Math.min(60, Math.round(n))) : null; })(),
    activation_date: actDate,
    period_start_raw: row[19] ? String(row[19]).trim() : null,
    sheet_tab: monthName,
    sheet_row: sheetRowAbs
  };
}

async function _fetchSheet(sheetName, cfg) {
  const url = cfg.gs_url + '?action=getSheet&sheet=' + encodeURIComponent(sheetName) + '&spreadsheetId=' + cfg.sheet_id;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error('Sheets fetch failed: ' + resp.status);
  const json = await resp.json();
  if (json.error) throw new Error('Sheets API error: ' + json.error);
  return json;
}

async function handleImportSheets(req, res) {
  const country = (req.query.country || 'KZ').toUpperCase();
  if (!ALLOWED_COUNTRIES.includes(country)) {
    return res.status(400).json({ ok: false, error: 'country должен быть KZ или KG' });
  }
  const cfg = SHEET_CONFIG[country];
  const dryRun = String(req.query.dry_run || '1') !== '0' && req.query.dry_run !== 'false';

  // Загружаем существующих клиентов для lookup client_id
  const clients = await sbSelect('clients', { country: 'eq.' + country, limit: '1000' });
  const clientByNorm = {};
  clients.forEach(c => { clientByNorm[_normName(c.company_name)] = c.client_id; });

  // Загружаем существующие платежи sheets_import чтобы не дублировать
  const existing = await sbSelect('payments', {
    country: 'eq.' + country,
    source: 'eq.sheets_import',
    limit: '5000'
  });
  const existingKeys = new Set(existing.map(p => `${p.sheet_tab}::${p.sheet_row}`));

  const now = new Date();
  const curMonthIdx = now.getMonth();
  const months = cfg.months.slice(0, curMonthIdx + 1);

  const parsedRows = [];
  const skippedByMonth = {};
  const sumByMonth = {};
  let totalParsed = 0;

  for (let mi = 0; mi < months.length; mi++) {
    const monthName = months[mi];
    try {
      const data = await _fetchSheet(monthName, cfg);
      if (!data.rows || data.rows.length < 2) { sumByMonth[monthName] = 0; continue; }
      // headerIdx
      let headerIdx = -1;
      for (let ri = 0; ri < data.rows.length; ri++) {
        const r = data.rows[ri];
        if (r && String(r[1] || '').trim() === 'Компания') { headerIdx = ri; break; }
      }
      const hdrRow = headerIdx >= 0 ? data.rows[headerIdx] : null;
      const startIdx = headerIdx >= 0 ? headerIdx + 1 : 4;
      let monthSum = 0;
      let monthCount = 0;
      data.rows.slice(startIdx).forEach((row, idx) => {
        const sheetRowAbs = startIdx + idx + 1; // 1-based в Sheets
        const parsed = _parseRow(row, headerIdx, hdrRow, cfg, monthName, mi, sheetRowAbs);
        if (!parsed) return;
        parsed.country = country;
        parsed.currency = cfg.currency;
        parsed.source = 'sheets_import';
        parsed.sheet_id = cfg.sheet_id;
        parsed.client_id = clientByNorm[_normName(parsed.company_name)] || null;
        parsed._key = `${parsed.sheet_tab}::${parsed.sheet_row}`;
        parsed._already_exists = existingKeys.has(parsed._key);
        parsedRows.push(parsed);
        monthSum += parsed.amount;
        monthCount++;
        totalParsed++;
      });
      sumByMonth[monthName] = monthSum;
      skippedByMonth[monthName] = monthCount;
    } catch (e) {
      console.error('[import_sheets] month error:', monthName, e.message);
      sumByMonth[monthName] = null;
    }
  }

  const willInsert = parsedRows.filter(p => !p._already_exists);
  const willSkip = parsedRows.filter(p => p._already_exists);
  const totalSum = parsedRows.reduce((s, p) => s + (p.amount || 0), 0);
  const insertSum = willInsert.reduce((s, p) => s + (p.amount || 0), 0);
  const unmatched = willInsert.filter(p => !p.client_id);
  const matchedClientsCount = willInsert.filter(p => p.client_id).length;

  if (dryRun) {
    return res.status(200).json({
      ok: true,
      mode: 'dry_run',
      country,
      total_parsed: totalParsed,
      already_in_supabase: willSkip.length,
      will_insert: willInsert.length,
      will_match_existing_client: matchedClientsCount,
      will_be_unmatched: unmatched.length,
      sum_by_month_sheets: sumByMonth,
      total_sum_parsed: totalSum,
      sum_to_insert: insertSum,
      sample_unmatched: unmatched.slice(0, 10).map(p => ({
        company_name: p.company_name, paid_at: p.paid_at, amount: p.amount, category_raw: p.category_raw
      })),
      sample_insert: willInsert.slice(0, 5).map(p => ({
        company_name: p.company_name, paid_at: p.paid_at, amount: p.amount, client_id: p.client_id, sheet_tab: p.sheet_tab, sheet_row: p.sheet_row
      }))
    });
  }

  // Реальный insert
  const inserted = [];
  const failed = [];
  for (const p of willInsert) {
    const { _key, _already_exists, ...row } = p;
    try {
      const r = await sbInsert('payments', row);
      inserted.push(r[0]);
    } catch (e) {
      failed.push({ company_name: p.company_name, paid_at: p.paid_at, amount: p.amount, error: e.message });
    }
  }
  return res.status(200).json({
    ok: true,
    mode: 'apply',
    country,
    inserted_count: inserted.length,
    failed_count: failed.length,
    failed_sample: failed.slice(0, 10),
    sum_inserted: inserted.reduce((s, p) => s + parseFloat(p.amount || 0), 0)
  });
}

export default async function handler(req, res) {
  if (!checkAuth(req, res)) return;
  try {
    if (req.method === 'POST' && req.query.action === 'import_sheets') {
      return await handleImportSheets(req, res);
    }
    if (req.method === 'GET')    return await handleGet(req, res);
    if (req.method === 'POST')   return await handlePost(req, res);
    if (req.method === 'PATCH')  return await handlePatch(req, res);
    if (req.method === 'DELETE') return await handleDelete(req, res);
    return res.status(405).json({ ok: false, error: 'method not allowed' });
  } catch (e) {
    console.error('[api/payments] error:', e);
    return res.status(500).json({ ok: false, error: e.message || String(e) });
  }
}

async function handleGet(req, res) {
  const q = req.query || {};
  const params = { order: 'paid_at.desc' };

  if (q.id) {
    const rows = await sbSelect('payments', { id: 'eq.' + q.id, limit: 1 });
    if (!rows.length) return res.status(404).json({ ok: false, error: 'платёж не найден' });
    return res.status(200).json({ ok: true, payment: rows[0] });
  }

  if (q.country) {
    if (!ALLOWED_COUNTRIES.includes(q.country)) {
      return res.status(400).json({ ok: false, error: 'country должен быть KZ или KG' });
    }
    params['country'] = 'eq.' + q.country;
  }
  if (q.client_id) params['client_id'] = 'eq.' + q.client_id;
  if (q.category) params['category'] = 'eq.' + q.category;
  if (q.source) params['source'] = 'eq.' + q.source;
  if (q.from && q.to) {
    params['and'] = `(paid_at.gte.${q.from},paid_at.lte.${q.to})`;
  } else if (q.from) {
    params['paid_at'] = 'gte.' + q.from;
  } else if (q.to) {
    params['paid_at'] = 'lte.' + q.to;
  }
  if (String(q.unmatched || '') === '1' || q.unmatched === 'true') {
    params['client_id'] = 'is.null';
  }
  if (q.limit) params['limit'] = q.limit;

  const data = await sbSelect('payments', params);
  return res.status(200).json({ ok: true, count: data.length, payments: data });
}

async function handlePost(req, res) {
  const body = await readBody(req);

  const country = (body.country || 'KZ').toUpperCase();
  if (!ALLOWED_COUNTRIES.includes(country)) {
    return res.status(400).json({ ok: false, error: 'country должен быть KZ или KG' });
  }
  if (!body.paid_at) {
    return res.status(400).json({ ok: false, error: 'paid_at обязателен (формат YYYY-MM-DD)' });
  }
  const companyName = String(body.company_name || '').trim();
  if (!companyName) {
    return res.status(400).json({ ok: false, error: 'company_name обязателен' });
  }
  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ ok: false, error: 'amount должен быть положительным числом' });
  }
  const source = body.source && ALLOWED_SOURCES.includes(body.source) ? body.source : 'manual';
  let category = body.category;
  if (category && !ALLOWED_CATEGORIES.includes(category)) category = 'other';

  // Резолв client_id (если не передан явно)
  let clientId = body.client_id || null;
  if (!clientId) {
    clientId = await _resolveClientId(companyName, country);
  }

  // Анти-дубль для бота: ищем уже существующий платёж с теми же параметрами
  if (source === 'payment_bot') {
    const existing = await sbSelect('payments', {
      country: 'eq.' + country,
      company_name: 'eq.' + companyName,
      paid_at: 'eq.' + body.paid_at,
      amount: 'eq.' + amount,
      source: 'eq.payment_bot',
      limit: 1
    });
    if (existing.length) {
      return res.status(200).json({
        ok: true,
        action: 'duplicate_ignored',
        payment: existing[0],
        client_linked: !!existing[0].client_id
      });
    }
  }

  const row = {
    country,
    paid_at: body.paid_at,
    company_name: companyName,
    client_id: clientId,
    category: category || null,
    category_raw: body.category_raw || null,
    amount,
    amount_planned: body.amount_planned != null ? Number(body.amount_planned) : null,
    currency: body.currency || _defaultCurrency(country),
    qty: body.qty != null ? Number(body.qty) : null,
    price: body.price != null ? Number(body.price) : null,
    period_months: body.period_months != null ? parseInt(body.period_months, 10) : null,
    bank: body.bank || null,
    manager_name: body.manager_name || null,
    tech_support: body.tech_support || null,
    seated: !!body.seated,
    activation_date: body.activation_date || null,
    period_start_raw: body.period_start_raw || null,
    comment: body.comment || null,
    source,
    sheet_id: body.sheet_id || null,
    sheet_tab: body.sheet_tab || null,
    sheet_row: body.sheet_row != null ? parseInt(body.sheet_row, 10) : null,
    created_by: body.created_by || req.headers['x-user-name'] || null,
    notes: body.notes || null
  };

  try {
    const result = await sbInsert('payments', row);
    return res.status(201).json({
      ok: true,
      payment: result[0],
      client_linked: !!clientId,
      client_id: clientId
    });
  } catch (e) {
    // Уникальный индекс мог сработать (двойная попытка импорта/бота)
    if (String(e.message || '').includes('duplicate') || String(e.message || '').includes('unique')) {
      return res.status(409).json({ ok: false, error: 'дубликат платежа', detail: e.message });
    }
    throw e;
  }
}

async function handlePatch(req, res) {
  const { id } = req.query || {};
  if (!id) return res.status(400).json({ ok: false, error: 'нужен id' });
  const body = await readBody(req);
  const patch = {};
  for (const k of ALLOWED_PATCH_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(body, k)) patch[k] = body[k];
  }
  if (!Object.keys(patch).length) {
    return res.status(400).json({ ok: false, error: 'нечего обновлять. Разрешены: ' + ALLOWED_PATCH_FIELDS.join(', ') });
  }
  if (patch.amount !== undefined) {
    const a = Number(patch.amount);
    if (!Number.isFinite(a) || a <= 0) {
      return res.status(400).json({ ok: false, error: 'amount должен быть > 0' });
    }
    patch.amount = a;
  }
  if (patch.category !== undefined && patch.category && !ALLOWED_CATEGORIES.includes(patch.category)) {
    return res.status(400).json({ ok: false, error: 'category должен быть один из: ' + ALLOWED_CATEGORIES.join(', ') });
  }
  const updated = await sbUpdate('payments', { id: 'eq.' + id }, patch);
  if (!updated.length) return res.status(404).json({ ok: false, error: 'платёж не найден' });
  return res.status(200).json({ ok: true, payment: updated[0] });
}

async function handleDelete(req, res) {
  const { id } = req.query || {};
  if (!id) return res.status(400).json({ ok: false, error: 'нужен id' });
  // Защита: автоматические записи (бот / sheets) удалять нельзя — только manual
  const rows = await sbSelect('payments', { id: 'eq.' + id, limit: 1 });
  if (!rows.length) return res.status(404).json({ ok: false, error: 'платёж не найден' });
  if (rows[0].source !== 'manual') {
    return res.status(403).json({ ok: false, error: 'автоматические платежи (' + rows[0].source + ') нельзя удалить через API. Используйте PATCH с notes' });
  }
  await sbDelete('payments', { id: 'eq.' + id });
  return res.status(200).json({ ok: true });
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  return new Promise((resolve) => {
    let chunks = '';
    req.on('data', c => chunks += c);
    req.on('end', () => { try { resolve(JSON.parse(chunks || '{}')); } catch { resolve({}); } });
  });
}
