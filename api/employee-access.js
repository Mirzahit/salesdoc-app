// /api/employee-access — переопределения прав доступа сотрудников (общие, на сервере).
// До v581 права хранились только в localStorage браузера CEO → не доходили до сотрудника
// и слетали при перезагрузке. Теперь — в Supabase (таблица employee_access, ключ = email).
//
// GET  /api/employee-access            → { ok, access: { "email": {view_dashboard:1,...}, ... } }
// GET  /api/employee-access?email=x    → { ok, email, access }
// POST /api/employee-access            → upsert одного: body { email, access, updated_by? }

import { sbSelect, sbUpsert } from './_supabase.js';
import { checkAuth } from './_auth.js';

function normEmail(s) {
  return String(s || '').trim().toLowerCase();
}

export default async function handler(req, res) {
  if (!checkAuth(req, res)) return;
  try {
    if (req.method === 'GET') {
      const email = normEmail(req.query.email);
      if (email) {
        const rows = await sbSelect('employee_access', { email: 'eq.' + email, limit: 1 });
        if (!rows.length) return res.status(200).json({ ok: true, email, access: null });
        return res.status(200).json({ ok: true, email, access: rows[0].access || {} });
      }
      const rows = await sbSelect('employee_access', { limit: '1000' });
      const map = {};
      rows.forEach(r => { if (r.email) map[r.email] = r.access || {}; });
      return res.status(200).json({ ok: true, access: map });
    }

    if (req.method === 'POST') {
      const body = await readBody(req);
      const email = normEmail(body.email);
      if (!email) return res.status(400).json({ ok: false, error: 'email обязателен' });
      if (!body.access || typeof body.access !== 'object' || Array.isArray(body.access)) {
        return res.status(400).json({ ok: false, error: 'access должен быть объектом' });
      }
      const row = {
        email,
        access: body.access,
        updated_at: new Date().toISOString(),
        updated_by: body.updated_by || req.headers['x-user-name'] || null
      };
      const result = await sbUpsert('employee_access', row, 'email');
      return res.status(200).json({ ok: true, access: (result[0] && result[0].access) || body.access });
    }

    return res.status(405).json({ ok: false, error: 'method not allowed' });
  } catch (e) {
    console.error('[api/employee-access] error:', e);
    return res.status(500).json({ ok: false, error: e.message || String(e) });
  }
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  return new Promise((resolve) => {
    let chunks = '';
    req.on('data', c => chunks += c);
    req.on('end', () => { try { resolve(JSON.parse(chunks || '{}')); } catch { resolve({}); } });
  });
}
