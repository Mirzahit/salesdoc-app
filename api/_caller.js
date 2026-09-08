// v587: резолв вызывающего (email + role) из таблицы employees — для серверной проверки прав.
// Заменяет чтение ролей из GAS-листа Users. TTL-кэш 5 мин (как было в employee-access.js).
import { sbSelect } from './_supabase.js';
import { resolveSession } from './_session.js';

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

// Возвращает { email, role, active, trusted } вызывающего или null.
// v924 SEC: сначала пробуем ПОДПИСАННУЮ сессию (x-session-token) — её подделать нельзя,
// пока задан SESSION_SECRET. Если сессии нет (env не задан / старый вход) — падаем на
// незащищённый заголовок x-user-email, как было раньше. trusted говорит, какой путь сработал:
// на нём можно ужесточать доступ к самому чувствительному, не ломая переходный период.
export async function resolveCaller(req) {
  const sess = resolveSession(req);
  const email = normEmail((sess && sess.email) || req.headers['x-user-email']);
  if (!email) return null;
  try {
    // Роль берём ИЗ БАЗЫ, а не из токена: понижение роли действует сразу, не дожидаясь протухания сессии.
    const map = await loadRoles(Date.now());
    const u = map[email];
    if (!u) return null;
    return { email, role: u.role, active: u.active, trusted: !!sess };
  } catch (e) {
    console.error('[_caller] loadRoles failed:', e.message);
    return null;
  }
}
