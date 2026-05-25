// /api/notes — Примечания (заметки) по клиенту (amoCRM-style notes, отдельно от tasks).
// Spec: docs/superpowers/specs/2026-05-25-tasks-module-design.md
//
// Routes:
//   GET    /api/notes?client_id=SD-...        → заметки клиента (по убыванию даты)
//   POST   /api/notes                          → создать. body: {client_id, text}
//          header x-user-name → created_by
//   DELETE /api/notes?id=UUID                  → удалить (только автор или admin)
//
// Заметки immutable после создания — PATCH не делаем. Если хочется отредактировать —
// удалить и создать новую.

import { sbSelect, sbInsert, sbDelete } from './_supabase.js';
import { checkAuth } from './_auth.js';

export default async function handler(req, res) {
  if (!checkAuth(req, res)) return;
  try {
    if (req.method === 'GET')    return await handleGet(req, res);
    if (req.method === 'POST')   return await handlePost(req, res);
    if (req.method === 'DELETE') return await handleDelete(req, res);
    return res.status(405).json({ ok: false, error: 'method not allowed' });
  } catch (e) {
    console.error('[api/notes] error:', e);
    return res.status(500).json({ ok: false, error: e.message || String(e) });
  }
}

async function handleGet(req, res) {
  const q = req.query || {};
  if (!q.client_id) return res.status(400).json({ ok: false, error: 'нужен ?client_id=...' });
  const notes = await sbSelect('client_notes', {
    client_id: 'eq.' + q.client_id,
    order: 'created_at.desc'
  });
  return res.status(200).json({ ok: true, count: notes.length, notes });
}

async function handlePost(req, res) {
  const body = await readBody(req);
  const userName = (req.headers['x-user-name'] || '').toString().trim();
  if (!userName) return res.status(400).json({ ok: false, error: 'header x-user-name обязателен' });
  if (!body.client_id) return res.status(400).json({ ok: false, error: 'client_id обязателен' });
  const text = (body.text || '').toString().trim();
  if (!text) return res.status(400).json({ ok: false, error: 'text обязателен (не пустой)' });

  const result = await sbInsert('client_notes', {
    client_id: body.client_id,
    text,
    created_by: userName
  });
  return res.status(201).json({ ok: true, note: result[0] });
}

async function handleDelete(req, res) {
  const id = req.query && req.query.id;
  if (!id) return res.status(400).json({ ok: false, error: 'нужен ?id=UUID' });
  const userName = (req.headers['x-user-name'] || '').toString().trim();
  const userRole = (req.headers['x-user-role'] || '').toString().trim().toLowerCase();

  const existing = await sbSelect('client_notes', { id: 'eq.' + id, select: 'id,created_by', limit: 1 });
  if (!existing.length) return res.status(404).json({ ok: false, error: 'заметка не найдена' });
  const note = existing[0];

  const isAuthor = userName && userName === note.created_by;
  const isAdmin = userRole === 'admin';
  if (!isAuthor && !isAdmin) {
    return res.status(403).json({ ok: false, error: 'удалять заметку может только автор или admin' });
  }

  await sbDelete('client_notes', { id: 'eq.' + id });
  return res.status(200).json({ ok: true, deleted: id });
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  return new Promise((resolve) => {
    let chunks = '';
    req.on('data', c => chunks += c);
    req.on('end', () => { try { resolve(JSON.parse(chunks || '{}')); } catch { resolve({}); } });
  });
}
