// /api/employee-access — переопределения прав доступа сотрудников (общие, на сервере).
// До v581 права хранились только в localStorage браузера CEO → не доходили до сотрудника
// и слетали при перезагрузке. Теперь — в Supabase (таблица employee_access, ключ = email).
//
// GET  /api/employee-access            → admin: { ok, access: { "email": {...}, ... } } (все)
//                                        не-admin: только свои права { ok, access: { "<свой email>": {...} } }
// POST /api/employee-access            → ТОЛЬКО admin/head: upsert { email, access }
//
// АВТОРИЗАЦИЯ: checkAuth (общий x-app-token) — базовый слой. Поверх — проверка РОЛИ вызывающего
// по листу Users (доверенный источник ролей, как при логине), email берём из заголовка x-user-email.
// ОГРАНИЧЕНИЕ: x-user-email не подписан (у приложения нет пер-юзер сессий/токенов), поэтому
// знающий админский email теоретически может его подделать. Это закрывает реальный инсайдерский
// сценарий (обычный сотрудник со своей сессией не повысит себе права), но полноценная защита —
// пер-юзер аутентификация (отдельная задача). updated_by берём из проверенного email, не из тела.

import { sbSelect, sbUpsert } from './_supabase.js';
import { checkAuth } from './_auth.js';

const ADMIN_ROLES = new Set(['admin', 'head']);
const GS_URL = 'https://script.google.com/macros/s/AKfycbwwNL4CxOrSo4wXT3qci_dSSqi5tABLPUqHQPv2nWrn_WQhZsaOpfnwdygaqskzuHphvg/exec';
const USERS_SHEET_ID = '1A5zZZi54Le3bUHkUng8L-Kbt2dkfMwwP48cpNFQ9ZMQ';

function normEmail(s) {
  return String(s || '').trim().toLowerCase();
}

// Кэш листа Users (роли) на 5 минут — чтобы не дёргать Sheet на каждый запрос.
let _usersCache = null;
let _usersCacheTs = 0;
const USERS_TTL_MS = 5 * 60 * 1000;

async function fetchUsers(now) {
  if (_usersCache && (now - _usersCacheTs) < USERS_TTL_MS) return _usersCache;
  const url = GS_URL + '?action=getSheet&sheet=Users&spreadsheetId=' + USERS_SHEET_ID;
  const r = await fetch(url);
  const j = await r.json();
  const rows = j.rows || j || [];
  const map = {};
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || !row[3]) continue;
    map[normEmail(row[3])] = { role: String(row[5] || 'viewer').toLowerCase(), active: row[7] };
  }
  _usersCache = map;
  _usersCacheTs = now;
  return map;
}

// Возвращает { email, role } вызывающего (по x-user-email, роль из листа Users) или null.
async function resolveCaller(req, now) {
  const email = normEmail(req.headers['x-user-email']);
  if (!email) return null;
  try {
    const users = await fetchUsers(now);
    const u = users[email];
    if (!u) return null;
    return { email, role: u.role };
  } catch (e) {
    console.error('[employee-access] fetchUsers failed:', e.message);
    return null;
  }
}

export default async function handler(req, res) {
  if (!checkAuth(req, res)) return;
  const now = Date.now(); // для TTL-кэша листа Users (серверный рантайм)
  try {
    const caller = await resolveCaller(req, now);
    const isAdmin = !!(caller && ADMIN_ROLES.has(caller.role));

    if (req.method === 'GET') {
      // Админ видит все права; обычный сотрудник — только свои.
      if (isAdmin) {
        const email = normEmail(req.query.email);
        if (email) {
          const rows = await sbSelect('employee_access', { email: 'eq.' + email, limit: 1 });
          return res.status(200).json({ ok: true, email, access: rows.length ? (rows[0].access || {}) : null });
        }
        const rows = await sbSelect('employee_access', { limit: '1000' });
        const map = {};
        rows.forEach(r => { if (r.email) map[r.email] = r.access || {}; });
        return res.status(200).json({ ok: true, access: map });
      }
      // не-админ: отдаём только его собственные права (если личность известна)
      if (caller) {
        const rows = await sbSelect('employee_access', { email: 'eq.' + caller.email, limit: 1 });
        const map = {};
        if (rows.length) map[caller.email] = rows[0].access || {};
        return res.status(200).json({ ok: true, access: map });
      }
      // личность не подтверждена (например, до логина) — пустo, без утечки чужих прав
      return res.status(200).json({ ok: true, access: {} });
    }

    if (req.method === 'POST') {
      // Менять права может только admin/head.
      if (!isAdmin) {
        return res.status(403).json({ ok: false, error: 'Изменять права может только администратор/руководитель' });
      }
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
        updated_by: caller.email   // из проверенной личности, не из тела/произвольного заголовка
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
