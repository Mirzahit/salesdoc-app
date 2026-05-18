// v348: Общий helper для всех /api/* эндпоинтов работающих с Supabase.
// Использует service-role (secret) ключ — обходит RLS, имеет полный доступ к БД.
// НЕ возвращать этот клиент в браузер. Только сервер.

import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY;

if (!url || !key) {
  console.warn('[supabase] env переменные не настроены — SUPABASE_URL / SUPABASE_SECRET_KEY');
}

export const sb = createClient(url || '', key || '', {
  auth: { persistSession: false }
});
