// /api/churn — Отток и спады клиентов. Источник: ручная выгрузка из биллинга
// (billing.salesdoc.io/report/churn), парсится на фронте (SheetJS), сюда приходят готовые строки.
//
// Два датасета:
//   churn     → таблица churn_records          (Файл 2 «Отток»: клиент, тип, суммы, причина)
//   licenses  → таблица churn_license_changes  (Файл 1 «pivot»: изменение лицензий по типам)
//
// GET    /api/churn?country=KZ&from=&to=&kind=        → записи оттока/спада
// GET    /api/churn?country=KZ&dataset=licenses       → изменения лицензий
// POST   /api/churn?action=import&dataset=churn       → массовая загрузка (body: { country, period_month, rows[] })
// POST   /api/churn?action=import&dataset=licenses     → -//-
// DELETE /api/churn?upload_batch_id=...&dataset=churn  → откат одной загрузки

import { sbSelect, sbInsert, sbDelete, sbUpsert } from './_supabase.js';
import { checkAuth } from './_auth.js';

export const config = { maxDuration: 60 };

const ALLOWED_COUNTRIES = ['KZ', 'KG'];
const TABLE = { churn: 'churn_records', licenses: 'churn_license_changes', notes: 'churn_notes' };

function _defaultCurrency(country) { return country === 'KG' ? 'KGS' : 'KZT'; }

function _num(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return isNaN(v) ? null : v;
  const s = String(v).replace(/\s/g, '').replace(/[^0-9.,-]/g, '').replace(',', '.');
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}
function _int(v) { const n = _num(v); return n == null ? null : Math.round(n); }

// Нормализация даты периода к 1-му числу месяца YYYY-MM-01.
function _periodMonth(v) {
  const s = String(v || '').trim();
  const m = s.match(/^(\d{4})-(\d{1,2})/);
  if (!m) return null;
  return m[1] + '-' + String(parseInt(m[2], 10)).padStart(2, '0') + '-01';
}

const KIND_MAP = { 'отток': 'churn', 'спд': 'decline', 'спад': 'decline', 'прирост': 'growth', 'новый': 'new', 'ноый': 'new' };
function _mapKind(v) {
  const k = String(v || '').toLowerCase().trim();
  return KIND_MAP[k] || (k && (KIND_MAP[k.replace(/[^а-яёa-z]/g, '')] )) || 'other';
}

export default async function handler(req, res) {
  if (!checkAuth(req, res)) return;
  try {
    if (req.method === 'POST' && req.query.action === 'import') return await handleImport(req, res);
    if (req.method === 'POST' && req.query.action === 'note') return await handleNote(req, res);
    if (req.method === 'GET')    return await handleGet(req, res);
    if (req.method === 'DELETE') return await handleDelete(req, res);
    return res.status(405).json({ ok: false, error: 'method not allowed' });
  } catch (e) {
    console.error('[api/churn] error:', e);
    return res.status(500).json({ ok: false, error: e.message || String(e) });
  }
}

async function handleGet(req, res) {
  const q = req.query || {};
  const dataset = (q.dataset === 'licenses' || q.dataset === 'notes') ? q.dataset : 'churn';
  const table = TABLE[dataset];
  const params = { order: 'period_month.desc', limit: q.limit || '5000' };
  if (q.country) {
    if (!ALLOWED_COUNTRIES.includes(q.country)) return res.status(400).json({ ok: false, error: 'country должен быть KZ или KG' });
    params['country'] = 'eq.' + q.country;
  }
  if (dataset === 'churn' && q.kind) params['kind'] = 'eq.' + q.kind;
  if (q.company_key) params['company_key'] = 'eq.' + String(q.company_key).toLowerCase();
  if (dataset !== 'notes') {
    if (q.from && q.to) params['and'] = `(period_month.gte.${q.from},period_month.lte.${q.to})`;
    else if (q.from) params['period_month'] = 'gte.' + q.from;
    else if (q.to) params['period_month'] = 'lte.' + q.to;
  }
  const data = await sbSelect(table, params);
  return res.status(200).json({ ok: true, dataset, count: data.length, records: data });
}

async function handleImport(req, res) {
  const body = await readBody(req);
  const dataset = (req.query.dataset === 'licenses') ? 'licenses' : 'churn';
  const table = TABLE[dataset];

  const country = String(body.country || 'KZ').toUpperCase();
  if (!ALLOWED_COUNTRIES.includes(country)) return res.status(400).json({ ok: false, error: 'country должен быть KZ или KG' });

  const periodMonth = _periodMonth(body.period_month);
  if (!periodMonth) return res.status(400).json({ ok: false, error: 'period_month обязателен (формат YYYY-MM или YYYY-MM-01)' });

  const rows = Array.isArray(body.rows) ? body.rows : [];
  if (!rows.length) return res.status(400).json({ ok: false, error: 'rows пуст — нечего загружать' });

  const uploadedBy = (req.headers['x-user-name'] || req.headers['x-user-email'] || 'unknown').toString();
  const batchId = 'imp_' + Date.now();
  const currency = _defaultCurrency(country);

  // Дедуп ВНУТРИ файла по ключу (последняя строка побеждает). Загрузка ОБНОВЛЯЕТ существующие
  // строки (upsert по row_hash), а не пропускает — чтобы дозагрузка файла с заполненными
  // причинами перезаписывала ранее пустые. Повторная загрузка того же файла безопасна (те же значения).
  const byHash = new Map();
  for (const r of rows) {
    let mapped, hash;
    if (dataset === 'churn') {
      const companyName = String(r.company_name || '').trim();
      const companyKey = String(r.company_key || '').trim().toLowerCase();
      if (!companyName) continue;
      hash = `${country}|${periodMonth}|${companyKey || companyName.toLowerCase()}`;
      mapped = {
        country, period_month: periodMonth,
        company_name: companyName,
        company_key: companyKey || null,
        kind: _mapKind(r.kind),
        prev_count: _int(r.prev_count), prev_amount: _num(r.prev_amount),
        cur_count: _int(r.cur_count), cur_amount: _num(r.cur_amount),
        diff: _int(r.diff),
        reason: (r.reason != null && String(r.reason).trim()) ? String(r.reason).trim() : null,
        reason_raw: (r.reason_raw != null && String(r.reason_raw).trim()) ? String(r.reason_raw).trim() : (r.reason ? String(r.reason).trim() : null),
        currency, source: 'file_import', upload_batch_id: batchId, uploaded_by: uploadedBy, row_hash: hash
      };
    } else {
      const companyKey = String(r.company_key || '').trim().toLowerCase();
      const licenseType = String(r.license_type || '').trim();
      if (!companyKey || !licenseType) continue;
      hash = `${country}|${periodMonth}|${companyKey}|${licenseType}`;
      mapped = {
        country, period_month: periodMonth,
        company_key: companyKey, license_type: licenseType,
        m1_count: _int(r.m1_count), m2_count: _int(r.m2_count), diff: _int(r.diff),
        source: 'file_import', upload_batch_id: batchId, uploaded_by: uploadedBy, row_hash: hash
      };
    }
    byHash.set(hash, mapped);
  }
  const toSave = Array.from(byHash.values());

  let saved = 0; const failed = [];
  // Upsert пачками по 200 (merge-duplicates по row_hash → обновляет существующие).
  for (let i = 0; i < toSave.length; i += 200) {
    const chunk = toSave.slice(i, i + 200);
    try {
      const r = await sbUpsert(table, chunk, 'row_hash');
      saved += Array.isArray(r) ? r.length : chunk.length;
    } catch (e) {
      for (const row of chunk) {
        try { await sbUpsert(table, row, 'row_hash'); saved++; }
        catch (e2) { failed.push({ key: row.row_hash, error: e2.message }); }
      }
    }
  }

  // inserted/skipped оставлены для совместимости со старым фронтом (показывает «добавлено N»).
  return res.status(200).json({ ok: true, dataset, country, period_month: periodMonth, upload_batch_id: batchId, total: rows.length, saved, inserted: saved, skipped: 0, failed_count: failed.length, failed_sample: failed.slice(0, 10) });
}

// Ручная причина+комментарий по компании (оверлей). Upsert по (country, period_month, company_key).
async function handleNote(req, res) {
  const body = await readBody(req);
  const country = String(body.country || 'KZ').toUpperCase();
  if (!ALLOWED_COUNTRIES.includes(country)) return res.status(400).json({ ok: false, error: 'country должен быть KZ или KG' });
  const periodMonth = _periodMonth(body.period_month);
  if (!periodMonth) return res.status(400).json({ ok: false, error: 'period_month обязателен' });
  const companyKey = String(body.company_key || '').trim().toLowerCase();
  if (!companyKey) return res.status(400).json({ ok: false, error: 'company_key обязателен' });
  const updatedBy = (req.headers['x-user-name'] || req.headers['x-user-email'] || 'unknown').toString();
  const reason = (body.reason != null && String(body.reason).trim()) ? String(body.reason).trim() : null;
  const comment = (body.comment != null && String(body.comment).trim()) ? String(body.comment).trim() : null;
  const row = { country, period_month: periodMonth, company_key: companyKey, reason, comment, updated_by: updatedBy, updated_at: new Date().toISOString() };
  const r = await sbUpsert('churn_notes', row, 'country,period_month,company_key');
  return res.status(200).json({ ok: true, note: Array.isArray(r) ? r[0] : r });
}

async function handleDelete(req, res) {
  const q = req.query || {};
  const dataset = q.dataset === 'licenses' ? 'licenses' : 'churn';
  const table = TABLE[dataset];
  if (!q.upload_batch_id) return res.status(400).json({ ok: false, error: 'нужен upload_batch_id' });
  await sbDelete(table, { upload_batch_id: 'eq.' + q.upload_batch_id });
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
