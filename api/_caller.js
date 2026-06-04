// v587: резолв вызывающего (email + role) из таблицы employees — для серверной проверки прав.
// Заменяет чтение ролей из GAS-листа Users. TTL-кэш 5 мин (как было в employee-access.js).
import { sbSelect } from './_supabase.js';

let _cache = null;
let _cacheTs = 0;
const TTL_MS = 5 * 60 * 1000;

function normEmail(s) { return String(s || '').trim().toLowerCase(); }

async function loadRoles(now) {
  if (_cache && (now - _cacheTs) < TTL_MS) return _cache;
  const rows = await sbSelect('employees', { select: 'email,role,active', limit: '1000' });
  const map = {};
  rows.forEach(r => {
    const e = normEmail(r.email);
    if (e) map[e] = { role: String(r.role || 'viewer').toLowerCase(), active: r.active !== false };
  });
  _cache = map;
  _cacheTs = now;
  return map;
}

// Возвращает { email, role, active } вызывающего (по заголовку x-user-email) или null.
// ОГРАНИЧЕНИЕ: x-user-email не подписан — полноценная защита требует пер-юзер сессий (отдельная задача).
export async function resolveCaller(req) {
  const email = normEmail(req.headers['x-user-email']);
  if (!email) return null;
  try {
    const map = await loadRoles(Date.now());
    const u = map[email];
    if (!u) return null;
    return { email, role: u.role, active: u.active };
  } catch (e) {
    console.error('[_caller] loadRoles failed:', e.message);
    return null;
  }
}
