// /api/login — серверная проверка логина (v587). pass_hash НИКОГДА не уходит на клиент.
// Раньше клиент скачивал все хэши из публичного GAS-листа и сравнивал локально (утечка).
//
// POST { email, password }   — ручной вход: сервер хеширует пароль и сверяет.
// POST { email, pass_hash }  — автологин по сохранённому в localStorage хэшу (хэш как токен).
// Ответ: { ok:true, employee:{...без pass_hash...} } | { ok:false, error, disabled? }
import crypto from 'crypto';
import { sbSelect } from './_supabase.js';
import { checkAuth } from './_auth.js';

function normEmail(s) { return String(s || '').trim().toLowerCase(); }
function sha256(s) { return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex'); }
function publicEmp(e) {
  return { id: e.id, name: e.name, pos: e.pos, email: e.email, role: e.role, bonus: e.bonus, active: e.active, country: e.country, is_temp: e.is_temp };
}

export default async function handler(req, res) {
  if (!checkAuth(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method not allowed' });
  try {
    const body = await readBody(req);
    const email = normEmail(body.email);
    if (!email) return res.status(200).json({ ok: false, error: 'Введите логин и пароль' });

    const rows = await sbSelect('employees', { email: 'ilike.' + email, limit: 1 });
    const emp = rows && rows[0];
    // одинаковый ответ при отсутствии юзера и неверном пароле — не палим существование логина
    if (!emp) return res.status(200).json({ ok: false, error: 'Неверный логин или пароль' });

    const stored = String(emp.pass_hash || '');
    let match = false;
    if (typeof body.pass_hash === 'string' && body.pass_hash) {
      // автологин: сверяем сохранённый хэш напрямую
      match = !!stored && stored === body.pass_hash;
    } else if (typeof body.password === 'string') {
      // ручной вход: пробуем trimmed и raw (как делал клиент — невидимые пробелы на мобиле)
      const raw = body.password;
      const trimmed = raw.trim();
      match = !!stored && (stored === sha256(trimmed) || stored === sha256(raw));
    }
    if (!match) return res.status(200).json({ ok: false, error: 'Неверный логин или пароль' });

    if (emp.active === false) {
      return res.status(200).json({ ok: false, disabled: true, error: 'Учётная запись отключена. Обратитесь к администратору.' });
    }
    return res.status(200).json({ ok: true, employee: publicEmp(emp) });
  } catch (e) {
    console.error('[api/login] error:', e);
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
