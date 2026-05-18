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
