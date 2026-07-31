// /api/login — серверная проверка логина (v587). pass_hash НИКОГДА не уходит на клиент.
// Раньше клиент скачивал все хэши из публичного GAS-листа и сравнивал локально (утечка).
//
// POST { email, password }   — ручной вход: сервер хеширует пароль и сверяет.
// POST { email, pass_hash }  — автологин по сохранённому в localStorage хэшу (хэш как токен).
// Ответ: { ok:true, employee:{...без pass_hash...} } | { ok:false, error, disabled? }
import crypto from 'crypto';
import { sbSelect } from './_supabase.js';
import { checkAuth } from './_auth.js';
import { issueSession } from './_session.js';

function normEmail(s) { return String(s || '').trim().toLowerCase(); }
function sha256(s) { return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex'); }
function publicEmp(e) {
  return { id: e.id, name: e.name, pos: e.pos, email: e.email, role: e.role, bonus: e.bonus, active: e.active, country: e.country, is_temp: e.is_temp };
}

// v847 SEC: запрос на восстановление пароля. Раньше браузер сам дёргал api.telegram.org
// с токеном бота, зашитым в index.html — токен лежал в публичном коде страницы у всех.
// Теперь сообщение шлёт сервер своим токеном (env TG_BOT_TOKEN), в бандле секрета нет.
async function handleRecover(req, res) {
  const body = await readBody(req);
  const email = normEmail(body.email);
  const token = (process.env.TG_BOT_TOKEN || '').trim();
  const chat = (process.env.DIRECTOR_TG_ID || '5472344802').trim(); // Мирзахит
  // Ответ всегда одинаковый — не подсказываем, существует логин или нет
  const okResponse = () => res.status(200).json({ ok: true });
  if (!email || !token) return okResponse();
  try {
    const rows = await sbSelect('employees', { email: 'eq.' + email, limit: 1 });
    const emp = rows && rows[0];
    if (!emp) return okResponse();
    const text = 'Запрос на восстановление пароля\n\n'
      + 'Сотрудник: ' + (emp.name || '—') + '\n'
      + 'Логин: ' + (emp.email || '—') + '\n'
      + 'Роль: ' + (emp.role || '—') + (emp.country ? (' · ' + emp.country) : '') + '\n\n'
      + 'Сбросьте пароль в Настройках → Сотрудники.';
    await fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text: text }),
      signal: AbortSignal.timeout(8000)
    });
  } catch (e) {
    console.error('[api/login recover]', e.message || e);
  }
  return okResponse();
}

export default async function handler(req, res) {
  if (!checkAuth(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method not allowed' });
  try {
    if ((req.query || {}).action === 'recover') return await handleRecover(req, res);
    const body = await readBody(req);
    const email = normEmail(body.email);
    if (!email) return res.status(200).json({ ok: false, error: 'Введите логин и пароль' });
    // v587 SEC: запрещаем спецсимволы PostgREST/LIKE — иначе подстановкой %,*,( можно матчить чужую строку.
    if (/[,*()%\s]/.test(email)) return res.status(200).json({ ok: false, error: 'Неверный логин или пароль' });

    // eq (точное равенство) вместо ilike — % и * трактуются буквально, инъекция шаблоном невозможна.
    const rows = await sbSelect('employees', { email: 'eq.' + email, limit: 1 });
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
    // v626 SEC (фаза 1): выдаём подписанный сессионный токен. Обёрнуто в try — если что-то
    // пойдёт не так (или SESSION_SECRET не задан), логин работает как раньше, без токена.
    let session_token = null;
    try { session_token = issueSession(emp); } catch (_) { session_token = null; }
    return res.status(200).json({ ok: true, employee: publicEmp(emp), session_token });
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
