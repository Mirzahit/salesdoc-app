// v626 SEC — серверные пер-юзер сессии (фундамент, фаза 1).
// Назначение: не подделываемая клиентом личность вызывающего. Сейчас НИЧЕГО не принуждает —
// эндпоинты как и раньше работают по APP_TOKEN. Этот модуль лишь ВЫДаёт (issueSession при логине)
// и ПРОВЕРЯЕТ (resolveSession) подписанный токен. Принуждение/скоуп — отдельным шагом (фаза 2).
//
// Stateless HMAC-токен (без таблицы в БД): payload.b64 + '.' + HMAC_SHA256(payload.b64, SESSION_SECRET).
// Подделать без SESSION_SECRET нельзя. Если env SESSION_SECRET не задан — issue/resolve возвращают
// null (полностью спящий режим, поведение системы не меняется).
//
// ENV: SESSION_SECRET (произвольная длинная случайная строка в Vercel). Пока не задан — фундамент спит.

import crypto from 'crypto';

const TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 дней

function secret() { return (process.env.SESSION_SECRET || '').trim(); }

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function sign(data, sec) {
  return b64url(crypto.createHmac('sha256', sec).update(data).digest());
}

// Возвращает подписанный токен или null (если нет SESSION_SECRET / нет email).
export function issueSession(user) {
  const sec = secret();
  if (!sec) return null;
  if (!user || !user.email) return null;
  const payload = {
    email: String(user.email).toLowerCase(),
    role: user.role || '',
    name: user.name || '',
    country: user.country || '',
    exp: Date.now() + TTL_MS,
  };
  const body = b64url(JSON.stringify(payload));
  return body + '.' + sign(body, sec);
}

// Возвращает доверенную личность { email, role, name, country } или null.
export function resolveSession(req) {
  const sec = secret();
  if (!sec) return null;
  const tok = String((req.headers['x-session-token'] || '')).trim();
  if (!tok || tok.indexOf('.') < 0) return null;
  const dot = tok.lastIndexOf('.');
  const body = tok.slice(0, dot);
  const sig = tok.slice(dot + 1);
  if (!body || !sig) return null;
  const expected = sign(body, sec);
  // constant-time сравнение подписей
  if (sig.length !== expected.length) return null;
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
  if (diff !== 0) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch (e) { return null; }
  if (!payload || !payload.exp || Date.now() > payload.exp) return null;
  return { email: payload.email, role: payload.role, name: payload.name, country: payload.country };
}
