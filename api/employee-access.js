// /api/employee-access — переопределения прав доступа сотрудников (общие, на сервере).
// До v581 права хранились только в localStorage браузера CEO → не доходили до сотрудника
// и слетали при перезагрузке. Теперь — в Supabase (таблица employee_access, ключ = email).
//
// GET  /api/employee-access            → admin: { ok, access: { "email": {...}, ... } } (все)
//                                        не-admin: только свои права { ok, access: { "<свой email>": {...} } }
// POST /api/employee-access            → ТОЛЬКО admin/head: upsert { email, access }
//
// АВТОРИЗАЦИЯ: checkAuth (общий x-app-token) — базовый слой. Поверх — проверка РОЛИ вызывающего
// по таблице employees (доверенный источник ролей, как при логине), email берём из заголовка x-user-email.
// ОГРАНИЧЕНИЕ: x-user-email не подписан (у приложения нет пер-юзер сессий/токенов), поэтому
// знающий админский email теоретически может его подделать. Это закрывает реальный инсайдерский
// сценарий (обычный сотрудник со своей сессией не повысит себе права), но полноценная защита —
// пер-юзер аутентификация (отдельная задача). updated_by берём из проверенного email, не из тела.

import { sbSelect, sbUpsert } from './_supabase.js';
import { checkAuth, checkAdminToken } from './_auth.js';
import { resolveCaller } from './_caller.js'; // v587: роли из таблицы employees, не из GAS

const ADMIN_ROLES = new Set(['admin', 'head']);

function normEmail(s) {
  return String(s || '').trim().toLowerCase();
}

export default async function handler(req, res) {
  if (!checkAuth(req, res)) return;
  try {
    const caller = await resolveCaller(req);
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
      // Менять права может только admin/head + админ-код (v587).
      if (!isAdmin) {
        return res.status(403).json({ ok: false, error: 'Изменять права может только администратор/руководитель' });
      }
      const gate = checkAdminToken(req);
      if (!gate.ok) {
        if (gate.unconfigured) return res.status(503).json({ ok: false, error: 'Изменение прав недоступно: на сервере не настроен ADMIN_TOKEN (задайте env в Vercel).' });
        return res.status(403).json({ ok: false, error: 'Неверный или отсутствует админ-код', needAdminToken: true });
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
