// v924 SEC — серверная проверка прав доступа.
// До этого права жили ТОЛЬКО в браузере (index.html: ROLE_DEFAULTS + showView), а сервер
// пускал любого, кто знает общий APP_TOKEN из бандла. Теперь чувствительные данные
// (расходы, зарплаты, доходы) проверяются на сервере: роль вызывающего берём из таблицы
// employees, поверх — персональные переопределения из employee_access.
//
// Зеркало ROLE_DEFAULTS из index.html. При изменении прав в одном месте — править оба.

import { sbSelect } from './_supabase.js';
import { resolveCaller } from './_caller.js';

export const ROLE_DEFAULTS = {
  admin:      { view_dashboard:1, view_payments:1, view_acts:1, view_plan:1, view_expenses:1, view_integrations:1, view_employees:1, view_settings:1, view_marketing:1, view_knowledge:1, view_academy:1, view_reports:1, view_kanban:1, view_planning:1, view_calendar:1, view_supportdash:1, view_activeclients:1, view_botadmin:1, add_payments:1, manage_employees:1 },
  head:       { view_dashboard:1, view_payments:1, view_acts:1, view_plan:1, view_expenses:1, view_integrations:1, view_employees:1, view_settings:1, view_marketing:1, view_knowledge:1, view_academy:1, view_reports:1, view_kanban:1, view_planning:1, view_calendar:1, view_supportdash:1, view_activeclients:1, view_botadmin:0, add_payments:1, manage_employees:1 },
  rop:        { view_dashboard:1, view_payments:1, view_acts:1, view_plan:1, view_expenses:0, view_integrations:0, view_employees:1, view_settings:0, view_marketing:1, view_knowledge:1, view_academy:1, view_reports:1, view_kanban:0, view_planning:1, view_calendar:1, view_supportdash:1, view_activeclients:1, view_botadmin:0, add_payments:1, manage_employees:0 },
  manager:    { view_dashboard:1, view_payments:1, view_acts:1, view_plan:1, view_expenses:0, view_integrations:0, view_employees:0, view_settings:0, view_marketing:1, view_knowledge:1, view_academy:1, view_reports:1, view_kanban:0, view_planning:1, view_calendar:1, view_supportdash:0, view_activeclients:1, view_botadmin:0, add_payments:1, manage_employees:0 },
  operator:   { view_dashboard:0, view_payments:0, view_acts:0, view_plan:0, view_expenses:0, view_integrations:1, view_employees:0, view_settings:0, view_marketing:0, view_knowledge:1, view_academy:1, view_reports:0, view_kanban:1, view_planning:1, view_calendar:1, view_supportdash:1, view_activeclients:1, view_botadmin:0, add_payments:0, manage_employees:0 },
  accountant: { view_dashboard:1, view_payments:1, view_acts:1, view_plan:0, view_expenses:1, view_integrations:0, view_employees:0, view_settings:0, view_marketing:0, view_knowledge:0, view_academy:0, view_reports:1, view_kanban:0, view_planning:1, view_calendar:1, view_supportdash:0, view_activeclients:0, view_botadmin:0, add_payments:1, manage_employees:0 },
  viewer:     { view_dashboard:1, view_payments:1, view_acts:1, view_plan:1, view_expenses:0, view_integrations:0, view_employees:0, view_settings:0, view_marketing:0, view_knowledge:1, view_academy:0, view_reports:0, view_kanban:0, view_planning:1, view_calendar:0, view_supportdash:0, view_activeclients:0, view_botadmin:0, add_payments:0, manage_employees:0 },
};

// Персональные переопределения прав (таблица employee_access) — тот же источник, что у фронта.
let _accCache = null;
let _accCacheTs = 0;
const ACC_TTL_MS = 5 * 60 * 1000;

async function loadAccessMap() {
  const now = Date.now();
  if (_accCache && (now - _accCacheTs) < ACC_TTL_MS) return _accCache;
  try {
    const rows = await sbSelect('employee_access', { limit: '1000' });
    const map = {};
    rows.forEach(r => { if (r.email) map[String(r.email).trim().toLowerCase()] = r.access || {}; });
    _accCache = map;
    _accCacheTs = now;
    return map;
  } catch (e) {
    console.error('[_perm] employee_access недоступен:', e.message);
    // Права роли остаются в силе — но пустой кэш НЕ запоминаем, чтобы следующий запрос попробовал снова.
    return _accCache || {};
  }
}

// Итоговые права сотрудника: набор роли + персональные переопределения поверх.
export async function accessFor(caller) {
  if (!caller) return null;
  const base = Object.assign({}, ROLE_DEFAULTS[caller.role] || ROLE_DEFAULTS.viewer);
  const map = await loadAccessMap();
  const own = map[caller.email];
  return own ? Object.assign(base, own) : base;
}

// Оплаты нужны не только разделу «Оплаты»: оператор видит платежи СВОИХ клиентов в
// «Действующих» и «Оплатах и долгах». Поэтому доступ к платежам даёт любое из этих прав.
// Сузить до «только свои клиенты» — отдельная задача, это уже про бизнес-правила, не про дыру.
export const PAYMENTS_KEYS = ['view_payments', 'view_activeclients', 'view_supportdash'];

function hasAny(acc, keys) {
  return keys.some(k => acc[k] === 1 || acc[k] === true);
}

// Мягкий гейт для эндпоинтов, куда ходят не только люди, но и служебные клиенты
// (бот оплат на Railway, крон импорта) — у них личности нет, только общий APP_TOKEN.
// Правило: сотрудника без права разворачиваем, безличный служебный вызов пропускаем.
// Полностью закрыть такой эндпоинт можно будет, когда APP_TOKEN уйдёт из бандла
// и каждый запрос из браузера станет носить подписанную сессию.
export async function requirePermSoft(req, res, keyOrKeys) {
  const keys = Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys];
  const caller = await resolveCaller(req);
  if (!caller) return { ok: true, caller: null };
  if (caller.active === false) {
    res.status(403).json({ ok: false, error: 'Учётная запись отключена' });
    return { ok: false };
  }
  const acc = await accessFor(caller);
  if (!hasAny(acc, keys)) {
    res.status(403).json({ ok: false, error: 'Нет доступа к этим данным' });
    return { ok: false };
  }
  return { ok: true, caller };
}

// Главный гейт: возвращает { ok, caller } либо сам отправляет 401/403.
// key — ключ права (view_expenses и т.п.) либо null, если нужен только факт «свой сотрудник».
export async function requirePerm(req, res, key) {
  const caller = await resolveCaller(req);
  if (!caller) {
    res.status(401).json({ ok: false, error: 'Не удалось определить сотрудника — войдите в программу заново', needLogin: true });
    return { ok: false };
  }
  if (caller.active === false) {
    res.status(403).json({ ok: false, error: 'Учётная запись отключена' });
    return { ok: false };
  }
  if (!key) return { ok: true, caller };
  const acc = await accessFor(caller);
  if (!hasAny(acc, Array.isArray(key) ? key : [key])) {
    res.status(403).json({ ok: false, error: 'Нет доступа к этим данным' });
    return { ok: false };
  }
  return { ok: true, caller };
}
