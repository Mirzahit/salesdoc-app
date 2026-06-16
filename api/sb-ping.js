// /api/sb-ping — проверка связи Vercel ↔ Supabase.
// GET → возвращает список операторов из таблицы operators.

import { sbSelect } from './_supabase.js';
import { checkAuth } from './_auth.js';

export default async function handler(req, res) {
  // v626 SEC: раньше эндпоинт сливал таблицу operators без авторизации.
  if (!checkAuth(req, res)) return;
  const env_url_set = !!process.env.SUPABASE_URL;
  const env_key_set = !!process.env.SUPABASE_SECRET_KEY;

  if (!env_url_set || !env_key_set) {
    return res.status(500).json({
      ok: false,
      error: 'env не настроены',
      env_url_set,
      env_key_set,
      hint: 'Добавь SUPABASE_URL и SUPABASE_SECRET_KEY в Vercel и сделай Redeploy'
    });
  }

  try {
    const operators = await sbSelect('operators', { order: 'name' });
    return res.status(200).json({
      ok: true,
      count: operators.length,
      operators,
      env_url_set: true,
      env_key_set: true
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: e.message || String(e),
      env_url_set: true,
      env_key_set: true
    });
  }
}
