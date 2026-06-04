// v364: проверка shared-secret для эндпоинтов работающих с Supabase.
// Без этого любой curl на /api/clients может слить базу с телефонами.
//
// Использование:
//   import { checkAuth } from './_auth.js';
//   if (!checkAuth(req, res)) return; // сам отправит 401

export function checkAuth(req, res) {
  const expected = (process.env.APP_TOKEN || '').trim();
  if (!expected) {
    // Если токен не настроен в env — пропускаем (для локальной разработки),
    // но логируем чтоб не забыли в проде.
    console.warn('[auth] APP_TOKEN не настроен — эндпоинт открыт всем');
    return true;
  }
  const got = (req.headers['x-app-token'] || '').toString().trim();
  if (got !== expected) {
    res.status(401).json({ ok: false, error: 'Unauthorized' });
    return false;
  }
  return true;
}

// v587: отдельный секрет для ОПАСНЫХ мутаций (сотрудники, права). В отличие от APP_TOKEN он
// НЕ лежит в клиентском бандле — CEO вводит его в UI, фронт шлёт в заголовке x-admin-token.
// Это барьер против захвата аккаунта: публичный APP_TOKEN + подделанный x-user-email больше
// не дают сбросить пароль / удалить / выдать роль. Полноценная защита — пер-юзер сессии (отдельно).
// FAIL-CLOSED: если ADMIN_TOKEN не задан в env — мутации БЛОКИРУЕМ (unconfigured), а не пропускаем.
// Иначе барьер бессмысленен до настройки. Возвращает { ok, unconfigured? }.
export function checkAdminToken(req) {
  const expected = (process.env.ADMIN_TOKEN || '').trim();
  if (!expected) {
    console.warn('[auth] ADMIN_TOKEN не настроен — мутации заблокированы (fail-closed). Задайте env в Vercel.');
    return { ok: false, unconfigured: true };
  }
  const got = (req.headers['x-admin-token'] || '').toString().trim();
  return { ok: got === expected };
}
