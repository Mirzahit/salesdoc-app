// /api/cards — CRUD карточек Канбана Внедрения.
//
// GET  /api/cards               → все активные карточки (не архивные)
// GET  /api/cards?operator=Айдос → карточки оператора
// GET  /api/cards?id=UUID       → одна карточка
// POST /api/cards               → создать карточку (body: { client_id, stage, operator, ... })
// PATCH /api/cards?id=UUID      → изменить (body: { stage: 'Активация', ... })
// DELETE /api/cards?id=UUID     → архивировать (soft delete: stage='Архив', archived_at=now)

import { sbSelect, sbInsert, sbUpdate } from './_supabase.js';
import { checkAuth } from './_auth.js';

// v364: whitelist разрешённых стадий — иначе мусорный stage сохранится молча
const ALLOWED_STAGES = ['Новый','Настройка','Обучение','Тестирование','Активация','Архив'];
const ALLOWED_COUNTRIES = ['KZ','KG'];

export default async function handler(req, res) {
  if (!checkAuth(req, res)) return;
  try {
    if (req.method === 'GET') {
      const { id, operator, stage, country } = req.query || {};
      const params = { select: '*,clients(company_name,main_phone,curator_operator,country)', order: 'created_at.desc' };
      if (id) params['id'] = 'eq.' + id;
      if (operator) params['operator'] = 'eq.' + operator;
      if (country) params['country'] = 'eq.' + country;
      if (stage) params['stage'] = 'eq.' + stage;
      else params['stage'] = 'neq.Архив';
      const data = await sbSelect('kanban_cards', params);
      return res.status(200).json({ ok: true, count: data.length, cards: data });
    }

    if (req.method === 'POST') {
      const body = await readBody(req);
      if (!body.client_id) return res.status(400).json({ ok: false, error: 'client_id обязателен' });
      const stage = body.stage || 'Новый';
      if (!ALLOWED_STAGES.includes(stage)) {
        return res.status(400).json({ ok: false, error: 'stage должен быть один из: ' + ALLOWED_STAGES.join(', ') });
      }
      const country = (body.country || 'KZ').toUpperCase();
      if (!ALLOWED_COUNTRIES.includes(country)) {
        return res.status(400).json({ ok: false, error: 'country должен быть KZ или KG' });
      }
      const card = {
        client_id: body.client_id,
        stage: stage,
        country: country,
        operator: body.operator || null,
        tariff: body.tariff || null,
        licenses_count: body.licenses_count || null,
        modules: body.modules || null,
        stage_entered_at: new Date().toISOString()
      };
      const result = await sbInsert('kanban_cards', card);
      return res.status(201).json({ ok: true, card: result[0] });
    }

    if (req.method === 'PATCH') {
      const { id } = req.query || {};
      if (!id) return res.status(400).json({ ok: false, error: 'нужен ?id=UUID' });
      const body = await readBody(req);
      const patch = {};
      if (body.stage) {
        if (!ALLOWED_STAGES.includes(body.stage)) {
          return res.status(400).json({ ok: false, error: 'stage должен быть один из: ' + ALLOWED_STAGES.join(', ') });
        }
        patch.stage = body.stage;
        patch.stage_entered_at = new Date().toISOString();
      }
      if (body.operator !== undefined) patch.operator = body.operator;
      if (body.tariff !== undefined) patch.tariff = body.tariff;
      if (body.licenses_count !== undefined) patch.licenses_count = body.licenses_count;
      if (body.modules !== undefined) patch.modules = body.modules;
      if (!Object.keys(patch).length) return res.status(400).json({ ok: false, error: 'нечего обновлять' });
      const result = await sbUpdate('kanban_cards', { id: 'eq.' + id }, patch);
      if (!result.length) return res.status(404).json({ ok: false, error: 'карточка не найдена' });
      return res.status(200).json({ ok: true, card: result[0] });
    }

    if (req.method === 'DELETE') {
      const { id } = req.query || {};
      if (!id) return res.status(400).json({ ok: false, error: 'нужен ?id=UUID' });
      const result = await sbUpdate('kanban_cards', { id: 'eq.' + id }, {
        stage: 'Архив',
        archived_at: new Date().toISOString()
      });
      if (!result.length) return res.status(404).json({ ok: false, error: 'карточка не найдена' });
      return res.status(200).json({ ok: true, card: result[0] });
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
