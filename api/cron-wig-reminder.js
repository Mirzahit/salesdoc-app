// /api/cron-wig-reminder — ежедневное напоминание CEO в Telegram о цели (4DX).
// Дёргается Vercel Cron каждое утро в 08:00 Almaty (03:00 UTC, см. vercel.json crons).
//
// Логика: читает wig_v1 из KV. Если цель опубликована И факт не обновлялся >24 часов
// И заданы ENV TG_BOT_TOKEN + CEO_TG_CHAT_ID → шлёт сообщение «обновите факт».
// При любых пропусках возвращает 200 чтобы Vercel не ретраил (иначе спам в TG).
//
// Защита: проверяет Authorization: Bearer ${CRON_SECRET}. Без секрета любой curl мог бы
// спамить TG (Vercel Cron сам шлёт этот заголовок если CRON_SECRET задан в env проекта).
//
// ENV (Vercel Project Settings → Environment Variables):
//   - CRON_SECRET (любая случайная строка — генерится автоматически если не задана)
//   - TG_BOT_TOKEN (токен Telegram-бота для отправки)
//   - CEO_TG_CHAT_ID (chat_id куда слать; пользователь узнаёт через /start у бота)

const KV_KEY = 'wig_v1';

function kvEnv() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return { url, token };
}

async function kvGet(key) {
  const { url, token } = kvEnv();
  if (!url || !token) return null;
  try {
    const r = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!r.ok) return null;
    const j = await r.json();
    if (!j || !j.result) return null;
    return typeof j.result === 'string' ? JSON.parse(j.result) : j.result;
  } catch (_) { return null; }
}

function _wigFmtNum(n) {
  n = Number(n) || 0;
  if (Math.abs(n) >= 1000000) return (n / 1000000).toFixed(n % 1000000 === 0 ? 0 : 1).replace('.0', '') + 'М';
  if (Math.abs(n) >= 1000) return Math.round(n / 1000) + 'К';
  return String(Math.round(n));
}

export default async function handler(req, res) {
  // 1. Защита от внешних curl — Vercel Cron шлёт этот заголовок автоматически.
  const expected = (process.env.CRON_SECRET || '').trim();
  if (expected) {
    const got = String(req.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim();
    if (got !== expected) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }
  }

  // 2. Проверяем ENV для Telegram.
  const botToken = (process.env.TG_BOT_TOKEN || '').trim();
  const ceoChatId = (process.env.CEO_TG_CHAT_ID || '').trim();
  if (!botToken) return res.status(200).json({ ok: true, skipped: 'no_tg_bot_token' });
  if (!ceoChatId) return res.status(200).json({ ok: true, skipped: 'no_ceo_chat_id' });

  // 3. Читаем цель.
  const wig = await kvGet(KV_KEY);
  if (!wig) return res.status(200).json({ ok: true, skipped: 'kv_unreachable_or_empty' });
  if (wig.published !== true || !wig.title) return res.status(200).json({ ok: true, skipped: 'no_wig' });

  // 4. Если факт обновлялся свежее 24 часов — не дёргаем.
  const staleHours = (Date.now() - (wig.updated_at || 0)) / 3600000;
  if (staleHours < 24) return res.status(200).json({ ok: true, skipped: 'fresh', stale_hours: Math.round(staleHours) });

  // 5. Считаем сколько дней до дедлайна (если есть).
  let daysLeft = null;
  if (wig.deadline) {
    const ms = new Date(wig.deadline + 'T00:00:00').getTime() - Date.now();
    daysLeft = Math.max(0, Math.round(ms / 86400000));
  }

  // 6. Текст. Простой язык, без эмоджи (правило проекта).
  const lines = [
    `Привет! Пора обновить факт по главной цели.`,
    ``,
    `Цель: ${wig.title}`,
    `Сейчас: ${_wigFmtNum(wig.current)} ${wig.unit || ''} из ${_wigFmtNum(wig.target)} ${wig.unit || ''}`,
  ];
  if (daysLeft !== null) lines.push(`Осталось: ${daysLeft} дн.`);
  lines.push(``);
  lines.push(`Открой раздел Цель в приложении и нажми «Обновить факт».`);
  const text = lines.join('\n');

  // 7. Шлём в Telegram.
  try {
    const r = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: ceoChatId, text: text })
    });
    const j = await r.json();
    if (!j || !j.ok) {
      // Не паникуем — 200 чтобы Vercel не ретраил. Ошибку видно в логах.
      return res.status(200).json({ ok: false, error: 'tg_failed', tg: j });
    }
    return res.status(200).json({ ok: true, sent: true, stale_hours: Math.round(staleHours) });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e && e.message || e) });
  }
}
