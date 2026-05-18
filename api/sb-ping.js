// /api/sb-ping — проверка связи Vercel ↔ Supabase.
// GET → возвращает список операторов из таблицы operators.
// Если в ответе 3 строки (Айдос/Акбар/Самат) — связь работает.

export default async function handler(req, res) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;

  // Сначала проверяем env — чтоб не падать на createClient если их нет
  if (!url || !key) {
    return res.status(500).json({
      ok: false,
      error: 'env не настроены',
      env_url_set: !!url,
      env_key_set: !!key,
      hint: 'Добавь SUPABASE_URL и SUPABASE_SECRET_KEY в Vercel Settings → Environment Variables, потом Redeploy'
    });
  }

  try {
    // Импортируем динамически чтобы ошибка модуля тоже была видна в JSON а не крашила функцию
    const { createClient } = await import('@supabase/supabase-js');
    const sb = createClient(url, key, { auth: { persistSession: false } });

    const { data, error } = await sb
      .from('operators')
      .select('email, name, role, active')
      .order('name');

    if (error) {
      return res.status(500).json({
        ok: false,
        error: 'supabase query failed: ' + error.message,
        details: error,
        env_url_set: true,
        env_key_set: true
      });
    }

    return res.status(200).json({
      ok: true,
      count: data.length,
      operators: data,
      env_url_set: true,
      env_key_set: true
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: 'function crash: ' + (e.message || String(e)),
      stack: (e.stack || '').split('\n').slice(0, 5),
      env_url_set: true,
      env_key_set: true
    });
  }
}
