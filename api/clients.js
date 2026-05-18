// /api/clients — CRUD Реестра клиентов.
//
// GET  /api/clients                       → все клиенты
// GET  /api/clients?status=active         → по статусу
// GET  /api/clients?curator=Айдос         → по куратору
// GET  /api/clients?client_id=SD-2026-1   → один клиент
// POST /api/clients                       → создать (body: { client_id, company_name, ... })
// PATCH /api/clients?client_id=SD-2026-1  → изменить (body: поля для обновления)

import { sbSelect, sbInsert, sbUpdate } from './_supabase.js';
import { checkAuth } from './_auth.js';

const ALLOWED_STATUS = ['lead','sale','onboarding','active','paused','churned'];
const ALLOWED_COUNTRIES = ['KZ','KG'];

export default async function handler(req, res) {
  if (!checkAuth(req, res)) return;
  try {
    if (req.method === 'GET') {
      const { client_id, status, curator, search, country } = req.query || {};
      const params = { order: 'updated_at.desc' };
      if (client_id) params['client_id'] = 'eq.' + client_id;
      if (status) params['status'] = 'eq.' + status;
      if (curator) params['curator_operator'] = 'eq.' + curator;
      if (country) params['country'] = 'eq.' + country;
      if (search) params['company_name'] = 'ilike.*' + search + '*';
      const data = await sbSelect('clients', params);
      return res.status(200).json({ ok: true, count: data.length, clients: data });
    }

    if (req.method === 'POST') {
      const body = await readBody(req);
      const country = (body.country || 'KZ').toUpperCase();
      if (!ALLOWED_COUNTRIES.includes(country)) {
        return res.status(400).json({ ok: false, error: 'country должен быть KZ или KG' });
      }
      body.country = country;
      if (!body.client_id) {
        // v364: авто-генерация с префиксом страны: SD-KZ-2026-NNNN / SD-KG-2026-NNNN
        // Уменьшает риск гонки (хотя UNIQUE-индекс в БД всё равно нужен).
        const existing = await sbSelect('clients', {
          select: 'client_id',
          country: 'eq.' + country,
          order: 'created_at.desc',
          limit: '1'
        });
        const year = new Date().getFullYear();
        const prefix = 'SD-' + country + '-' + year + '-';
        let nextNum = 1;
        if (existing.length) {
          const last = existing[0].client_id || '';
          const m = last.match(/SD-[A-Z]{2}-\d{4}-(\d+)/);
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
      // v364: идемпотентность активации — если уже active и снова шлют active, не пишем
      if (body.status === 'active') {
        const existing = await sbSelect('clients', { client_id: 'eq.' + client_id, select: 'status,activation_date' });
        if (existing[0] && existing[0].status === 'active') {
          return res.status(200).json({ ok: true, client: existing[0], already_active: true });
        }
      }
      const result = await sbUpdate('clients', { client_id: 'eq.' + client_id }, body);
      if (!result.length) return res.status(404).json({ ok: false, error: 'клиент не найден' });
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
