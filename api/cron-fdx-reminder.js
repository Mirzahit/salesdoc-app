// /api/cron-fdx-reminder — ежедневное напоминание CEO в Telegram по модулю 4DX.
// Дёргается Vercel Cron каждое утро в 08:00 Almaty (03:00 UTC, см. vercel.json crons).
//
// Заменил api/cron-wig-reminder.js (тот считал одну цель, этот — все опережающие со светофором).
//
// Логика: читает 4dx:goals + 4dx:metrics + 4dx:entries из KV. Считает светофор каждой метрики.
// Если есть «красные» (factPct < 50% от ожидаемого) или метрики без записи >3 дней — шлёт CEO summary.
//
// ENV: CRON_SECRET, TG_BOT_TOKEN, CEO_TG_CHAT_ID (как раньше для wig). Без них — тихий skip.

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

function periodBoundsForMetric(period, now) {
  const d = new Date(now);
  if (period === 'day') {
    const start = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    return { start, end: start + 86400000 - 1 };
  }
  const dow = (d.getDay() + 6) % 7;
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate() - dow).getTime();
  return { start, end: start + 7 * 86400000 - 1 };
}

function trafficLight(metric, entries, now = Date.now()) {
  const { start, end } = periodBoundsForMetric(metric.period || 'week', now);
  const fact = entries
    .filter(e => e.metric_id === metric.id && Date.parse(e.date) >= start && Date.parse(e.date) <= end)
    .reduce((s, e) => s + (Number(e.value) || 0), 0);
  const target = Number(metric.target_per_period) || 0;
  if (target <= 0) return { color: 'gray', fact, target, factPct: 0, timePct: 0 };
  const factPct = fact / target;
  const timePct = Math.min(1, (now - start) / (end - start));
  let color = 'red';
  if (factPct >= timePct * 0.9) color = 'green';
  else if (factPct >= timePct * 0.5) color = 'yellow';
  return { color, fact, target, factPct };
}

function _fmtNum(n) {
  n = Number(n) || 0;
  if (Math.abs(n) >= 1000000) return (n / 1000000).toFixed(n % 1000000 === 0 ? 0 : 1).replace('.0', '') + 'М';
  if (Math.abs(n) >= 1000) return Math.round(n / 1000) + 'К';
  return String(Math.round(n));
}

export default async function handler(req, res) {
  // Защита от внешних curl. Vercel Cron шлёт этот заголовок автоматически если CRON_SECRET задан.
  const expected = (process.env.CRON_SECRET || '').trim();
  if (expected) {
    const got = String(req.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim();
    if (got !== expected) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  const botToken = (process.env.TG_BOT_TOKEN || '').trim();
  const ceoChatId = (process.env.CEO_TG_CHAT_ID || '').trim();
  if (!botToken) return res.status(200).json({ ok: true, skipped: 'no_tg_bot_token' });
  if (!ceoChatId) return res.status(200).json({ ok: true, skipped: 'no_ceo_chat_id' });

  const [metrics, entries, goals] = await Promise.all([
    kvGet('4dx:metrics:v1'), kvGet('4dx:entries:v1'), kvGet('4dx:goals:v1')
  ]);
  if (!Array.isArray(metrics) || !metrics.length) {
    return res.status(200).json({ ok: true, skipped: 'no_metrics' });
  }
  const allEntries = Array.isArray(entries) ? entries : [];
  const allGoals = Array.isArray(goals) ? goals : [];

  // Считаем светофор для каждой активной метрики
  const lights = metrics
    .filter(m => m.active !== false)
    .map(m => ({ m, light: trafficLight(m, allEntries) }));

  const reds = lights.filter(L => L.light.color === 'red');
  // Метрики без записи последние 3 дня
  const now = Date.now();
  const stale3d = lights.filter(L => {
    const lastEntry = allEntries
      .filter(e => e.metric_id === L.m.id)
      .reduce((max, e) => Math.max(max, Date.parse(e.date) || 0), 0);
    return lastEntry && (now - lastEntry) > 3 * 86400000;
  });

  if (!reds.length && !stale3d.length) {
    return res.status(200).json({ ok: true, skipped: 'all_green' });
  }

  // Группируем по стране (KZ/KG)
  const byCountry = {};
  reds.forEach(L => {
    const c = L.m.country || 'KZ';
    byCountry[c] = byCountry[c] || { reds: [], stale: [] };
    byCountry[c].reds.push(L);
  });
  stale3d.forEach(L => {
    const c = L.m.country || 'KZ';
    byCountry[c] = byCountry[c] || { reds: [], stale: [] };
    if (byCountry[c].reds.indexOf(L) === -1) byCountry[c].stale.push(L);
  });

  // Собираем текст
  const lines = ['Утренний обзор 4D — нужно внимание:', ''];
  Object.keys(byCountry).forEach(c => {
    lines.push('Страна ' + c + ':');
    byCountry[c].reds.forEach(L => {
      lines.push('  — ' + L.m.title + ': ' + _fmtNum(L.light.fact) + '/' + _fmtNum(L.light.target) + ' (' + Math.round((L.light.factPct||0)*100) + '%)');
    });
    byCountry[c].stale.forEach(L => {
      lines.push('  — ' + L.m.title + ': нет записей >3 дней');
    });
    lines.push('');
  });
  lines.push('Открой 4D → Опережающие в приложении.');
  const text = lines.join('\n');

  try {
    const r = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: ceoChatId, text: text })
    });
    const j = await r.json();
    if (!j || !j.ok) return res.status(200).json({ ok: false, error: 'tg_failed', tg: j });
    return res.status(200).json({ ok: true, sent: true, reds: reds.length, stale: stale3d.length });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e && e.message || e) });
  }
}
