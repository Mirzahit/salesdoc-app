// /api/checklist — пункты чек-листа для карточки Канбана.
//
// GET  /api/checklist?card_id=UUID            → все пункты карточки
// POST /api/checklist                         → новый пункт (body: { card_id, stage, title, position })
// PATCH /api/checklist?id=UUID                → отметить готово/убрать (body: { done: true/false, done_by })
// DELETE /api/checklist?id=UUID               → удалить пункт

import { sbSelect, sbInsert, sbUpdate, sbDelete } from './_supabase.js';
import { checkAuth } from './_auth.js';

export default async function handler(req, res) {
  if (!checkAuth(req, res)) return;
  try {
    if (req.method === 'GET') {
      const { card_id, stage, all } = req.query || {};
      const params = { order: 'position.asc' };
      if (card_id) params['card_id'] = 'eq.' + card_id;
      else if (!all) return res.status(400).json({ ok: false, error: 'нужен ?card_id=UUID или ?all=1' });
      if (stage) params['stage'] = 'eq.' + stage;
      const items = await sbSelect('checklist_items', params);
      return res.status(200).json({ ok: true, count: items.length, items });
    }

    if (req.method === 'POST') {
      const body = await readBody(req);
      if (!body.card_id) return res.status(400).json({ ok: false, error: 'card_id обязателен' });
      if (!body.title) return res.status(400).json({ ok: false, error: 'title обязателен' });
      const item = {
        card_id: body.card_id,
        stage: body.stage || 'Новый',
        title: body.title,
        done: !!body.done,
        position: body.position || 0
      };
      const result = await sbInsert('checklist_items', item);
      return res.status(201).json({ ok: true, item: result[0] });
    }

    if (req.method === 'PATCH') {
      const { id } = req.query || {};
      if (!id) return res.status(400).json({ ok: false, error: 'нужен ?id=UUID' });
      const body = await readBody(req);
      const patch = {};
      if (body.done !== undefined) {
        patch.done = !!body.done;
        patch.done_at = body.done ? new Date().toISOString() : null;
        if (body.done_by) patch.done_by = body.done_by;
      }
      if (body.title !== undefined) patch.title = body.title;
      if (body.position !== undefined) patch.position = body.position;
      const result = await sbUpdate('checklist_items', { id: 'eq.' + id }, patch);
      return res.status(200).json({ ok: true, item: result[0] });
    }

    if (req.method === 'DELETE') {
      const { id } = req.query || {};
      if (!id) return res.status(400).json({ ok: false, error: 'нужен ?id=UUID' });
      await sbDelete('checklist_items', { id: 'eq.' + id });
      return res.status(200).json({ ok: true });
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
