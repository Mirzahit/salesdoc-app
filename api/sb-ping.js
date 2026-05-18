// /api/sb-ping — проверка связи Vercel ↔ Supabase.
// GET → возвращает список операторов из таблицы operators.
// Если в ответе 3 строки (Айдос/Акбар/Самат) — связь работает.

import { sb } from './_supabase.js';

export default async function handler(req, res) {
  try {
    const { data, error } = await sb
      .from('operators')
      .select('email, name, role, active')
      .order('name');

    if (error) {
      return res.status(500).json({ ok: false, error: error.message });
    }

    return res.status(200).json({
      ok: true,
      count: data.length,
      operators: data,
      env_url_set: !!process.env.SUPABASE_URL,
      env_key_set: !!process.env.SUPABASE_SECRET_KEY
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
