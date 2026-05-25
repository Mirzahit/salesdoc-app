// /api/clients-without-tasks — клиенты без открытых задач старше N дней.
// Spec: docs/superpowers/specs/2026-05-25-tasks-module-design.md §5 (фаза 5)
//
// Использование:
//   GET /api/clients-without-tasks                    → дефолт: 3 дня, только active
//   GET /api/clients-without-tasks?days=7             → 7 дней
//   GET /api/clients-without-tasks?status=onboarding  → конкретный статус
//   GET /api/clients-without-tasks?curator=Айдос      → только клиенты конкретного куратора
//
// Возвращает список клиентов, у которых:
//   - НЕТ ни одной открытой задачи (status='open'), ИЛИ
//   - все задачи закрыты, и последняя из них закрыта раньше чем (NOW - days)
//
// Это «брошенные» клиенты — менеджер не оставил активного follow-up.

import { sbSelect } from './_supabase.js';
import { checkAuth } from './_auth.js';

const ALLOWED_STATUS = ['lead','sale','onboarding','active','paused','churned'];

export default async function handler(req, res) {
  if (!checkAuth(req, res)) return;
  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'method not allowed' });
  }
  try {
    const q = req.query || {};
    const days = Math.max(0, Math.min(365, parseInt(q.days, 10) || 3));
    const statusFilter = q.status && ALLOWED_STATUS.includes(q.status) ? q.status : null;
    const curator = q.curator || null;
    const country = q.country || null;

    // 1. Получаем подходящих клиентов
    const clientParams = { order: 'updated_at.desc', limit: '1000' };
    if (statusFilter) clientParams['status'] = 'eq.' + statusFilter;
    if (curator)      clientParams['curator_operator'] = 'eq.' + curator;
    if (country)      clientParams['country'] = 'eq.' + country;
    // По умолчанию ищем «активных» (lead/sale/onboarding/active) — те, кто требует касаний.
    if (!statusFilter) clientParams['status'] = 'in.(lead,sale,onboarding,active)';
    const clients = await sbSelect('clients', clientParams);
    if (!clients.length) return res.status(200).json({ ok: true, count: 0, clients: [] });

    // 2. Для каждого считаем «есть ли открытые задачи». Делаем одним запросом —
    //    выбираем все открытые задачи где client_id IN (нужный список) и группируем на стороне Node.
    const clientIds = clients.map(c => c.client_id).filter(Boolean);
    if (!clientIds.length) return res.status(200).json({ ok: true, count: clients.length, clients });

    // PostgREST: IN-фильтр строится как in.(a,b,c). Экранируем — пробелов/спецсимволов в client_id нет (SD-KZ-...-NNNNN).
    const inList = clientIds.map(id => id).join(',');
    const openTasks = await sbSelect('tasks', {
      status: 'eq.open',
      client_id: 'in.(' + inList + ')',
      select: 'client_id'
    });
    const hasOpenSet = new Set(openTasks.map(t => t.client_id));

    // 3. Для клиентов без открытых задач — проверяем последнюю закрытую (для timestamp «когда последнее касание»).
    const closedTasks = await sbSelect('tasks', {
      status: 'eq.done',
      client_id: 'in.(' + inList + ')',
      select: 'client_id,closed_at',
      order: 'closed_at.desc'
    });
    const lastClosedByClient = {};
    closedTasks.forEach(t => {
      if (!lastClosedByClient[t.client_id]) lastClosedByClient[t.client_id] = t.closed_at;
    });

    // 4. Фильтруем клиентов: «брошенные» = нет открытых + (нет закрытых ИЛИ последнее закрытие старше N дней).
    const thresholdMs = Date.now() - days * 86400000;
    const abandoned = clients.filter(c => {
      if (hasOpenSet.has(c.client_id)) return false;        // есть открытая задача — не брошенный
      const lastClosed = lastClosedByClient[c.client_id];
      if (!lastClosed) return true;                          // никаких задач никогда не было
      return new Date(lastClosed).getTime() < thresholdMs;   // последнее касание было давно
    }).map(c => ({
      ...c,
      last_task_closed_at: lastClosedByClient[c.client_id] || null,
      days_since_last_task: lastClosedByClient[c.client_id]
        ? Math.round((Date.now() - new Date(lastClosedByClient[c.client_id]).getTime()) / 86400000)
        : null
    }));

    // Сортируем: сначала те, у кого вообще нет касаний (null), потом по давности.
    abandoned.sort((a, b) => {
      if (a.days_since_last_task === null && b.days_since_last_task !== null) return -1;
      if (a.days_since_last_task !== null && b.days_since_last_task === null) return 1;
      return (b.days_since_last_task || 0) - (a.days_since_last_task || 0);
    });

    return res.status(200).json({
      ok: true,
      count: abandoned.length,
      threshold_days: days,
      clients: abandoned
    });
  } catch (e) {
    console.error('[api/clients-without-tasks] error:', e);
    return res.status(500).json({ ok: false, error: e.message || String(e) });
  }
}
