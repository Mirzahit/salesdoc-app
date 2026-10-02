import './_preview_guard.js'; // v1017: в превью-сборке запись наружу отключена (см. файл)
// /api/cron-finansist — ночной обход «Финансиста» (v1006). Vercel Cron: 21:00 UTC = 03:00 по Бишкеку.
// Что делает: пересобирает спорные записи и проверку обязательных статей за текущий месяц (в первые
// 10 дней месяца — ещё и за прошлый), формулирует новые вопросы во вкладке «Вопросы агента».
// Это не дайджест: никуда ничего не отправляет.
// ENV: CRON_SECRET (Vercel шлёт сам), ANTHROPIC_API_KEY_FINANSIST (без ключа вопросы получат шаблонные тексты).

import { sweepMonth } from './_finansist_agent.js';
import { currentMonthKey, shiftMonthKey, bishkekIso, fetchNbkrToday, saveFxRate } from './_finansist_core.js';

export const config = { maxDuration: 300 };

export default async function handler(req, res) {
  const expected = (process.env.CRON_SECRET || '').trim();
  if (!expected) return res.status(503).json({ ok: false, error: 'CRON_SECRET не настроен' });
  const got = String(req.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim();
  if (got !== expected) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  // курс тенге Нацбанка КР на сегодня — копим историю (архива по дате у Нацбанка нет)
  let fx = null;
  try { const r = await fetchNbkrToday(); await saveFxRate(r.date, { KZT: r.KZT, USD: r.USD }, 'nbkr', 'крон'); fx = r; } catch (e) { console.error('[cron-finansist] НБКР:', e.message); fx = { error: String(e.message || e) }; }
  // текущий и два прошлых: зарплата за прошлый месяц закрывается ~10-го, а недостающие строки вносят с опозданием
  const months = [currentMonthKey(), shiftMonthKey(currentMonthKey(), -1), shiftMonthKey(currentMonthKey(), -2)];
  const out = [];
  for (const m of months) {
    try { const r = await sweepMonth(m, { force: true }); out.push({ month: m, created: r.created, closed: r.closed, candidates: r.candidates, missing: r.missing.map(x => x.item_key + ':' + x.status), cost_usd: r.cost_usd }); }
    catch (e) { console.error('[cron-finansist]', m, e); out.push({ month: m, error: String(e && e.message || e) }); }
  }
  return res.status(200).json({ ok: true, ran_at: new Date().toISOString(), fx, months: out });
}
