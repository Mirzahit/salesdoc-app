// /api/employees — ростер сотрудников (без pass_hash) + админ-CRUD (v587).
// Заменяет лист Users в GAS как источник правды для сотрудников.
//
// GET                           → { ok, employees:[...без pass_hash...] }  (любой залогиненный с app-token)
// POST { ...employee }          → admin/head: создать/обновить (пароль хешируется на сервере)
// POST { action:'delete', id }  → admin/head: удалить
//
// АВТОРИЗАЦИЯ: checkAuth (общий x-app-token) + проверка роли вызывающего через _caller (таблица employees).
import crypto from 'crypto';
import { sbSelect, sbUpsert, sbUpdate, sbDelete } from './_supabase.js';
import { checkAuth, checkAdminToken } from './_auth.js';
import { resolveCaller } from './_caller.js';

const ADMIN_ROLES = new Set(['admin', 'head']);
const PUBLIC_COLS = 'id,name,pos,email,role,bonus,active,country,is_temp';

function sha256(s) { return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex'); }

// v589: одноразовый временный пароль вместо общего '123456'. Алфавит без неоднозначных символов.
function genTempPassword(len) {
  const A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789abcdefghijkmnpqrstuvwxyz';
  let s = '';
  const bytes = crypto.randomBytes(len || 9);
  for (let i = 0; i < bytes.length; i++) s += A[bytes[i] % A.length];
  return s;
}
function normEmail(s) { return String(s || '').trim().toLowerCase(); }
function publicEmp(e) {
  return { id: e.id, name: e.name, pos: e.pos, email: e.email, role: e.role, bonus: e.bonus, active: e.active, country: e.country, is_temp: e.is_temp };
}

export default async function handler(req, res) {
  if (!checkAuth(req, res)) return;
  try {
    if (req.method === 'GET') {
      const rows = await sbSelect('employees', { select: PUBLIC_COLS, order: 'id', limit: '1000' });
      return res.status(200).json({ ok: true, employees: rows });
    }

    // мутации — только admin/head + админ-код (барьер против захвата через публичный app-token)
    const caller = await resolveCaller(req);
    if (!caller || caller.active === false || !ADMIN_ROLES.has(caller.role)) {
      return res.status(403).json({ ok: false, error: 'Изменять сотрудников может только активный администратор' });
    }
    const gate = checkAdminToken(req);
    if (!gate.ok) {
      if (gate.unconfigured) return res.status(503).json({ ok: false, error: 'Управление сотрудниками недоступно: на сервере не настроен ADMIN_TOKEN (задайте env в Vercel).' });
      return res.status(403).json({ ok: false, error: 'Неверный или отсутствует админ-код', needAdminToken: true });
    }
    const body = await readBody(req);

    if (req.method === 'POST' || req.method === 'PUT') {
      if (body.action === 'delete') {
        const id = parseInt(body.id);
        if (!id) return res.status(400).json({ ok: false, error: 'id обязателен' });
        await sbDelete('employees', { id: 'eq.' + id });
        return res.status(200).json({ ok: true, deleted: id });
      }

      const id = parseInt(body.id) || null;
      const now = new Date().toISOString();

      // UPDATE существующего по id — патчим только переданные поля
      // (сброс пароля/блокировка не присылают name+email).
      if (id) {
        const patch = { updated_at: now };
        let tempPassword = null;
        if (body.name != null) patch.name = String(body.name).trim();
        if (body.pos != null) patch.pos = String(body.pos);
        if (body.email != null) patch.email = normEmail(body.email);
        if (body.role != null) patch.role = String(body.role).toLowerCase();
        if (body.bonus != null) patch.bonus = parseInt(body.bonus) || 0;
        if (body.country != null) patch.country = String(body.country);
        if (typeof body.active === 'boolean') patch.active = body.active;
        if (typeof body.is_temp === 'boolean') patch.is_temp = body.is_temp;
        if (body.reset === true) {
          // v589: сброс — генерим одноразовый пароль, отдаём его админу один раз
          tempPassword = genTempPassword();
          patch.pass_hash = sha256(tempPassword);
          patch.is_temp = true;
        } else if (typeof body.password === 'string' && body.password) {
          patch.pass_hash = sha256(body.password.trim());
        } else if (typeof body.pass_hash === 'string' && body.pass_hash) {
          patch.pass_hash = body.pass_hash;
        }
        const result = await sbUpdate('employees', { id: 'eq.' + id }, patch);
        if (!result || !result[0]) return res.status(404).json({ ok: false, error: 'сотрудник не найден' });
        const out = { ok: true, employee: publicEmp(result[0]) };
        if (tempPassword) out.temp_password = tempPassword;
        return res.status(200).json(out);
      }

      // CREATE нового — нужны name+email; id = max+1; пароль задан админом или одноразовый сгенерённый
      const email = normEmail(body.email);
      const name = String(body.name || '').trim();
      if (!name || !email) return res.status(400).json({ ok: false, error: 'name и email обязательны' });
      const top = await sbSelect('employees', { select: 'id', order: 'id.desc', limit: 1 });
      const newId = ((top && top[0] && top[0].id) || 0) + 1;
      let tempPassword = null;
      let pass_hash;
      if (typeof body.password === 'string' && body.password) {
        pass_hash = sha256(body.password.trim());
      } else {
        tempPassword = genTempPassword();
        pass_hash = sha256(tempPassword);
      }
      const row = {
        id: newId,
        name,
        pos: String(body.pos || ''),
        email,
        pass_hash,
        role: String(body.role || 'viewer').toLowerCase(),
        bonus: parseInt(body.bonus) || 0,
        active: body.active !== false,
        country: String(body.country || ''),
        is_temp: body.is_temp !== false, // новый по умолчанию временный (форс смены пароля)
        updated_at: now
      };
      const result = await sbUpsert('employees', row, 'id');
      const out = { ok: true, employee: publicEmp((result && result[0]) || row) };
      if (tempPassword) out.temp_password = tempPassword;
      return res.status(200).json(out);
    }

    return res.status(405).json({ ok: false, error: 'method not allowed' });
  } catch (e) {
    console.error('[api/employees] error:', e);
    return res.status(500).json({ ok: false, error: e.message || String(e) });
  }
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  return new Promise((resolve) => {
    let c = '';
    req.on('data', x => c += x);
    req.on('end', () => { try { resolve(JSON.parse(c || '{}')); } catch { resolve({}); } });
  });
}
