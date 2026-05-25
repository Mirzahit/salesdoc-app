// /api/tasks-presets — кастомные пресеты фильтра задач (модуль «Задачи»).
// Spec: docs/superpowers/specs/2026-05-25-tasks-module-design.md §4.3
//
// Системные пресеты (Только мои / Просроченные / Выполненные / Все) — на фронте.
// Здесь храним только пользовательские (как "запросы Клиентов Горит" в amoCRM).
//
// Routes:
//   GET    /api/tasks-presets?owner=Айдос       → пресеты пользователя
//   POST   /api/tasks-presets                   → создать. body: {name, filter, sort?}
//          header x-user-name → owner_operator
//   DELETE /api/tasks-presets?id=UUID           → удалить (только владелец)
//          header x-user-name → проверка прав

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
    console.error('[api/tasks-presets] error:', e);
    return res.status(500).json({ ok: false, error: e.message || String(e) });
  }
}

async function handleGet(req, res) {
  const owner = (req.query && req.query.owner) || (req.headers['x-user-name'] || '').toString().trim();
  if (!owner) return res.status(400).json({ ok: false, error: 'нужен ?owner=NAME или header x-user-name' });
  const presets = await sbSelect('task_presets', {
    owner_operator: 'eq.' + owner,
    order: 'sort.asc,created_at.asc'
  });
  return res.status(200).json({ ok: true, count: presets.length, presets });
}

async function handlePost(req, res) {
  const body = await readBody(req);
  const userName = (req.headers['x-user-name'] || '').toString().trim();
  if (!userName) return res.status(400).json({ ok: false, error: 'header x-user-name обязателен' });

  const name = (body.name || '').toString().trim();
  if (!name) return res.status(400).json({ ok: false, error: 'name обязателен' });
  if (!body.filter || typeof body.filter !== 'object') {
    return res.status(400).json({ ok: false, error: 'filter обязателен (объект)' });
  }

  const row = {
    owner_operator: userName,
    name,
    filter: body.filter,
    sort: Number.isInteger(body.sort) ? body.sort : 0
  };
  const result = await sbInsert('task_presets', row);
  return res.status(201).json({ ok: true, preset: result[0] });
}

async function handleDelete(req, res) {
  const id = req.query && req.query.id;
  if (!id) return res.status(400).json({ ok: false, error: 'нужен ?id=UUID' });
  const userName = (req.headers['x-user-name'] || '').toString().trim();
  if (!userName) return res.status(400).json({ ok: false, error: 'header x-user-name обязателен' });

  // Проверяем что юзер — владелец.
  const existing = await sbSelect('task_presets', { id: 'eq.' + id, select: 'id,owner_operator', limit: 1 });
  if (!existing.length) return res.status(404).json({ ok: false, error: 'пресет не найден' });
  if (existing[0].owner_operator !== userName) {
    return res.status(403).json({ ok: false, error: 'удалять пресет может только владелец' });
  }

  await sbDelete('task_presets', { id: 'eq.' + id });
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
