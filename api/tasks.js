// /api/tasks — модуль «Задачи» (amoCRM-style follow-up).
// Spec: docs/superpowers/specs/2026-05-25-tasks-module-design.md
//
// Routes (через query-string + HTTP-метод, один файл):
//
//   GET  /api/tasks?id=UUID                          → одна задача
//   GET  /api/tasks?client_id=SD-...&status=open     → задачи клиента (status: open|done|all)
//   GET  /api/tasks?kanban=1&assignee=Айдос          → канбан, сгруппирован по бакетам
//   GET  /api/tasks?types=1                          → 19 типов из справочника
//
//   POST /api/tasks                                  → создать
//        body: {client_id?, type_id, text, deadline_at, deadline_end_at?,
//               is_all_day, assignee_operator, contact_name?, stage_label?, stage_color?}
//        header x-user-name → created_by
//
//   PATCH /api/tasks?id=UUID                         → редактировать (whitelist)
//   PATCH /api/tasks?id=UUID&close=1                 → закрыть, body: {result} (≥3 символа)
//   PATCH /api/tasks?id=UUID&move=TARGET             → drag-перенос
//        TARGET: today | tomorrow | after_tomorrow | next_week | next_month | done
//
//   DELETE /api/tasks?id=UUID                        → удалить (только created_by или admin)
//
// Auth: shared APP_TOKEN через checkAuth.
// Идентификация юзера: header x-user-name (для created_by/прав), x-user-role (для admin-проверки).

import { sbSelect, sbInsert, sbUpdate, sbDelete } from './_supabase.js';
import { checkAuth } from './_auth.js';

const ALLOWED_PATCH_FIELDS = [
  'text', 'deadline_at', 'deadline_end_at', 'is_all_day',
  'type_id', 'assignee_operator', 'contact_name', 'stage_label', 'stage_color',
  'pinned'
];

const MOVE_TARGETS = ['today', 'tomorrow', 'after_tomorrow', 'next_week', 'next_month', 'done'];

const KANBAN_BUCKETS = ['expire', 'today', 'tomorrow', 'this_week', 'next_week', 'this_month', 'future', 'completed'];

// v452 fix: пользователи в KZ/KG (UTC+5/+6). Vercel-функция работает в UTC, поэтому
// при расчёте бакетов канбана и сдвигов move= используем Asia/Almaty TZ через Intl.
const APP_TZ = process.env.APP_TZ || 'Asia/Almaty';
const APP_TZ_OFFSET = process.env.APP_TZ_OFFSET || '+05:00';  // для составления ISO-строк

export default async function handler(req, res) {
  if (!checkAuth(req, res)) return;
  try {
    if (req.method === 'GET')    return await handleGet(req, res);
    if (req.method === 'POST')   return await handlePost(req, res);
    if (req.method === 'PATCH')  return await handlePatch(req, res);
    if (req.method === 'DELETE') return await handleDelete(req, res);
    return res.status(405).json({ ok: false, error: 'method not allowed' });
  } catch (e) {
    console.error('[api/tasks] error:', e);
    return res.status(500).json({ ok: false, error: e.message || String(e) });
  }
}

// ============================================================================
// GET
// ============================================================================
async function handleGet(req, res) {
  const q = req.query || {};

  // GET /api/tasks?types=1  →  справочник типов
  if (q.types) {
    const types = await sbSelect('task_types', { order: 'sort.asc' });
    return res.status(200).json({ ok: true, types });
  }

  // GET /api/tasks?id=UUID  →  одна задача
  if (q.id) {
    const rows = await sbSelect('tasks', { id: 'eq.' + q.id, limit: 1 });
    if (!rows.length) return res.status(404).json({ ok: false, error: 'задача не найдена' });
    return res.status(200).json({ ok: true, task: rows[0] });
  }

  // GET /api/tasks?kanban=1  →  бакеты для канбана
  if (q.kanban) {
    return await handleKanban(req, res);
  }

  // GET /api/tasks?client_id=X&status=open|done|all  →  задачи клиента
  if (q.client_id) {
    const params = {
      client_id: 'eq.' + q.client_id,
      order: 'deadline_at.asc'
    };
    const status = q.status || 'all';
    if (status === 'open' || status === 'done') params['status'] = 'eq.' + status;
    const tasks = await sbSelect('tasks', params);
    return res.status(200).json({ ok: true, count: tasks.length, tasks });
  }

  // Без фильтра — отдаём все открытые задачи (для отладки/админа). С limit для защиты.
  const tasks = await sbSelect('tasks', {
    status: 'eq.open',
    order: 'deadline_at.asc',
    limit: '500'
  });
  return res.status(200).json({ ok: true, count: tasks.length, tasks });
}

// GET /api/tasks?kanban=1[&assignee=X]
// Возвращает {expire:[...], today:[...], tomorrow:[...], this_week:[...],
//             next_week:[...], this_month:[...], future:[...], completed:[...]}
async function handleKanban(req, res) {
  const q = req.query || {};
  const params = { order: 'deadline_at.asc' };
  if (q.assignee) params['assignee_operator'] = 'eq.' + q.assignee;

  // Открытые задачи нам нужны для всех бакетов кроме completed.
  const openTasks = await sbSelect('tasks', { ...params, status: 'eq.open' });
  // Выполненные — отдельно, последние 100 (для секции completed в фильтрах).
  const doneTasks = await sbSelect('tasks', {
    ...params,
    status: 'eq.done',
    order: 'closed_at.desc',
    limit: '100'
  });

  const buckets = { expire: [], today: [], tomorrow: [], this_week: [], next_week: [], this_month: [], future: [], completed: doneTasks };

  // v452 fix: ВСЕ календарные сравнения — в Asia/Almaty TZ (или APP_TZ из env).
  // Иначе пользователь в Алматы в 02:00 локального времени видит задачи на «сегодня»
  // как «вчерашние/просроченные» из-за UTC-смещения сервера.
  const now = new Date();
  const todayStr = ymdInTz(now);
  const tomorrowStr = ymdInTz(addDays(now, 1));
  const endOfWeekStr = ymdInTz(endOfWeek(now));       // воскресенье текущей недели
  const endOfNextWeekStr = ymdInTz(endOfWeek(addDays(now, 7)));
  const endOfMonthStr = ymdInTz(endOfMonth(now));

  for (const t of openTasks) {
    // deadline_at — TIMESTAMPTZ из БД. new Date() парсит UTC, а затем ymdInTz
    // даёт календарную дату пользователя.
    const dStr = t.deadline_at ? ymdInTz(new Date(t.deadline_at)) : null;
    if (!dStr) { buckets.future.push(t); continue; }

    if (dStr < todayStr) buckets.expire.push(t);
    else if (dStr === todayStr) buckets.today.push(t);
    else if (dStr === tomorrowStr) buckets.tomorrow.push(t);
    else if (dStr <= endOfWeekStr) buckets.this_week.push(t);
    else if (dStr <= endOfNextWeekStr) buckets.next_week.push(t);
    else if (dStr <= endOfMonthStr) buckets.this_month.push(t);
    else buckets.future.push(t);
  }

  return res.status(200).json({ ok: true, buckets });
}

// ============================================================================
// POST — создать
// ============================================================================
async function handlePost(req, res) {
  const body = await readBody(req);
  const userName = (req.headers['x-user-name'] || '').toString().trim();
  if (!userName) {
    return res.status(400).json({ ok: false, error: 'header x-user-name обязателен' });
  }

  // Валидация обязательных полей
  if (!body.type_id || !Number.isInteger(body.type_id) || body.type_id < 1 || body.type_id > 19) {
    return res.status(400).json({ ok: false, error: 'type_id обязателен (1..19)' });
  }
  if (!body.deadline_at) {
    return res.status(400).json({ ok: false, error: 'deadline_at обязателен (ISO 8601)' });
  }
  if (!body.assignee_operator) {
    return res.status(400).json({ ok: false, error: 'assignee_operator обязателен' });
  }

  // Сборка записи — whitelist полей, плюс created_by из header.
  const row = {
    client_id:         body.client_id || null,
    contact_name:      body.contact_name || null,
    stage_label:       body.stage_label || null,
    stage_color:       body.stage_color || null,
    type_id:           body.type_id,
    text:              body.text || null,
    deadline_at:       body.deadline_at,
    deadline_end_at:   body.deadline_end_at || null,
    is_all_day:        !!body.is_all_day,
    assignee_operator: body.assignee_operator,
    created_by:        userName,
    status:            'open'
  };

  const result = await sbInsert('tasks', row);
  return res.status(201).json({ ok: true, task: result[0] });
}

// ============================================================================
// PATCH — редактировать / закрыть / move
// ============================================================================
async function handlePatch(req, res) {
  const q = req.query || {};
  const id = q.id;
  if (!id) return res.status(400).json({ ok: false, error: 'нужен ?id=UUID' });

  // Загружаем существующую задачу — нужна для проверок и пересчёта дедлайна.
  const existing = await sbSelect('tasks', { id: 'eq.' + id, limit: 1 });
  if (!existing.length) return res.status(404).json({ ok: false, error: 'задача не найдена' });
  const task = existing[0];

  // ---- PATCH ?close=1 — закрытие задачи с результатом ----
  if (q.close) {
    if (task.status === 'done') {
      return res.status(200).json({ ok: true, task, already_done: true });
    }
    const body = await readBody(req);
    const result = (body.result || '').toString().trim();
    if (result.length < 3) {
      return res.status(400).json({ ok: false, error: 'result обязателен (мин 3 символа)' });
    }
    const patch = {
      status:    'done',
      result,
      closed_at: new Date().toISOString()
    };
    const updated = await sbUpdate('tasks', { id: 'eq.' + id }, patch);
    return res.status(200).json({ ok: true, task: updated[0] });
  }

  // ---- PATCH ?move=TARGET — drag-перенос ----
  if (q.move) {
    const target = q.move;
    if (!MOVE_TARGETS.includes(target)) {
      return res.status(400).json({ ok: false, error: 'move target должен быть один из: ' + MOVE_TARGETS.join(', ') });
    }
    // move=done без result — отказ (UI должен вместо этого открыть модалку закрытия).
    if (target === 'done') {
      return res.status(400).json({ ok: false, error: 'для закрытия используйте ?close=1 с body.result' });
    }
    const newDeadline = computeMoveDeadline(target, task.deadline_at);
    const updated = await sbUpdate('tasks', { id: 'eq.' + id }, { deadline_at: newDeadline });
    return res.status(200).json({ ok: true, task: updated[0], deadline_at: newDeadline });
  }

  // ---- PATCH ?id=UUID — обычное редактирование (whitelist) ----
  const rawBody = await readBody(req);
  const patch = {};
  Object.keys(rawBody).forEach(k => {
    if (ALLOWED_PATCH_FIELDS.includes(k)) patch[k] = rawBody[k];
  });
  if (Object.keys(patch).length === 0) {
    return res.status(400).json({ ok: false, error: 'нет полей для обновления (whitelist: ' + ALLOWED_PATCH_FIELDS.join(', ') + ')' });
  }
  // Валидация type_id если меняют
  if (patch.type_id !== undefined) {
    if (!Number.isInteger(patch.type_id) || patch.type_id < 1 || patch.type_id > 19) {
      return res.status(400).json({ ok: false, error: 'type_id должен быть 1..19' });
    }
  }
  const updated = await sbUpdate('tasks', { id: 'eq.' + id }, patch);
  return res.status(200).json({ ok: true, task: updated[0] });
}

// ============================================================================
// DELETE — удалить (автор или admin)
// ============================================================================
async function handleDelete(req, res) {
  const q = req.query || {};
  const id = q.id;
  if (!id) return res.status(400).json({ ok: false, error: 'нужен ?id=UUID' });

  const existing = await sbSelect('tasks', { id: 'eq.' + id, select: 'id,created_by', limit: 1 });
  if (!existing.length) return res.status(404).json({ ok: false, error: 'задача не найдена' });
  const task = existing[0];

  const userName = (req.headers['x-user-name'] || '').toString().trim();
  const userRole = (req.headers['x-user-role'] || '').toString().trim().toLowerCase();

  const isAuthor = userName && userName === task.created_by;
  const isAdmin = userRole === 'admin';
  if (!isAuthor && !isAdmin) {
    return res.status(403).json({ ok: false, error: 'удалять задачу может только автор или admin' });
  }

  await sbDelete('tasks', { id: 'eq.' + id });
  return res.status(200).json({ ok: true, deleted: id });
}

// ============================================================================
// Helpers
// ============================================================================

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  return new Promise((resolve) => {
    let chunks = '';
    req.on('data', c => chunks += c);
    req.on('end', () => { try { resolve(JSON.parse(chunks || '{}')); } catch { resolve({}); } });
  });
}

// v452 fix: форматирование YYYY-MM-DD в TZ приложения (Asia/Almaty по умолчанию).
// 'en-CA' locale возвращает ISO-формат (YYYY-MM-DD). Без указания timeZone использовался бы UTC.
function ymdInTz(d) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: APP_TZ,
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(d);
}

function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

// Конец недели = воскресенье (KZ/RU локаль: неделя пн-вс).
function endOfWeek(date) {
  const d = new Date(date);
  const dow = d.getDay();              // 0=вс, 1=пн, ..., 6=сб
  const daysUntilSunday = dow === 0 ? 0 : 7 - dow;
  d.setDate(d.getDate() + daysUntilSunday);
  return d;
}

function endOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0);
}

// Пересчёт deadline_at для drag&drop в drop-зоны.
// Сохраняем время дня, меняем только дату — кроме next_month, где явно 09:00.
function computeMoveDeadline(target, currentDeadlineIso) {
  const now = new Date();
  const cur = currentDeadlineIso ? new Date(currentDeadlineIso) : now;
  // Время дня — берём из текущего дедлайна (чтобы перенос не сбивал «на 15:00»).
  const h = cur.getHours(), m = cur.getMinutes(), s = cur.getSeconds();

  let target_date;
  if (target === 'today') {
    target_date = new Date(now);
  } else if (target === 'tomorrow') {
    target_date = addDays(now, 1);
  } else if (target === 'after_tomorrow') {
    target_date = addDays(now, 2);
  } else if (target === 'next_week') {
    // Ближайший понедельник следующей недели.
    target_date = new Date(now);
    const dow = target_date.getDay();          // 0=вс,1=пн,...
    const daysToNextMonday = dow === 0 ? 1 : (8 - dow);
    target_date.setDate(target_date.getDate() + daysToNextMonday);
  } else if (target === 'next_month') {
    // v452 fix: 1 число следующего месяца, 09:00 в TZ приложения (а не в UTC сервера!).
    // Конструируем ISO-строку с явным offset, чтобы Vercel в UTC не сдвигал на +5 часов.
    let y = now.getFullYear(), m = now.getMonth() + 1;
    if (m > 11) { y++; m = 0; }
    return `${y}-${String(m + 1).padStart(2, '0')}-01T09:00:00${APP_TZ_OFFSET}`;
  }

  target_date.setHours(h, m, s, 0);
  return target_date.toISOString();
}
