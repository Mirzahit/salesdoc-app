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

export default async function handler(req, res) {
  if (!checkAuth(req, res)) return;
  try {
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
