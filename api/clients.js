// /api/clients — CRUD Реестра клиентов.
//
// GET  /api/clients                       → все клиенты
// GET  /api/clients?status=active         → по статусу
// GET  /api/clients?curator=Айдос         → по куратору
// GET  /api/clients?client_id=SD-2026-1   → один клиент
// POST /api/clients                       → создать (body: { client_id, company_name, ... })
// PATCH /api/clients?client_id=SD-2026-1  → изменить (body: поля для обновления)

import { sbSelect, sbInsert, sbUpdate } from './_supabase.js';

const ALLOWED_STATUS = ['lead','sale','onboarding','active','paused','churned'];

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      const { client_id, status, curator, search } = req.query || {};
      const params = { order: 'updated_at.desc' };
      if (client_id) params['client_id'] = 'eq.' + client_id;
      if (status) params['status'] = 'eq.' + status;
      if (curator) params['curator_operator'] = 'eq.' + curator;
      if (search) params['company_name'] = 'ilike.*' + search + '*';
      const data = await sbSelect('clients', params);
      return res.status(200).json({ ok: true, count: data.length, clients: data });
    }

    if (req.method === 'POST') {
      const body = await readBody(req);
      if (!body.client_id) {
        // авто-генерация если не передан: SD-2026-NNNN на основе текущего max
        const existing = await sbSelect('clients', { select: 'client_id', order: 'created_at.desc', limit: '1' });
        const year = new Date().getFullYear();
        const prefix = 'SD-' + year + '-';
        let nextNum = 1;
        if (existing.length) {
          const last = existing[0].client_id || '';
          const m = last.match(/SD-\d{4}-(\d+)/);
          if (m) nextNum = parseInt(m[1], 10) + 1;
        }
        body.client_id = prefix + String(nextNum).padStart(5, '0');
      }
      if (!body.company_name) return res.status(400).json({ ok: false, error: 'company_name обязателен' });
      if (body.status && !ALLOWED_STATUS.includes(body.status)) {
        return res.status(400).json({ ok: false, error: 'status должен быть один из: ' + ALLOWED_STATUS.join(', ') });
      }
      const result = await sbInsert('clients', body);
      return res.status(201).json({ ok: true, client: result[0] });
    }

    if (req.method === 'PATCH') {
      const { client_id } = req.query || {};
      if (!client_id) return res.status(400).json({ ok: false, error: 'нужен ?client_id=...' });
      const body = await readBody(req);
      body.updated_at = new Date().toISOString();
      if (body.status && !ALLOWED_STATUS.includes(body.status)) {
        return res.status(400).json({ ok: false, error: 'status должен быть один из: ' + ALLOWED_STATUS.join(', ') });
      }
      const result = await sbUpdate('clients', { client_id: 'eq.' + client_id }, body);
      return res.status(200).json({ ok: true, client: result[0] });
    }

    return res.status(405).json({ ok: false, error: 'method not allowed' });
  } catch (e) {
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
