// v802: УТРЕННИЙ ДАЙДЖЕСТ CEO — серверный (заменил браузерный sendTgReport, удалённый в v801:
// тот слал дубли с каждого устройства, читал удалённые элементы и держал токен бота в бандле).
//
// Расписание: vercel.json "0 1-7 * * *" (раз в час, окно 06:00–12:00 по Алматы UTC+5).
// Каждый запуск проверяет app_settings.tg_digest = {enabled, hour, last_sent}:
// шлём только если enabled, текущий час Алматы == hour и сегодня ещё не слали (last_sent).
// Настраивается в приложении: Настройки → Уведомления. Часовой пояс — Алматы (дайджест личный для CEO).
//
// Данные — напрямую из Supabase (те же, что видит дашборд) + расход Meta через свой /api/meta-ads.
// ENV: CRON_SECRET (Bearer, fail-closed), TG_BOT_TOKEN + CEO_TG_CHAT_ID (как cron-fdx-reminder),
//      APP_TOKEN (для внутреннего запроса к meta-ads).

import { sbSelect, sbUpsert } from './_supabase.js';
import { runReminders } from './_reminders.js'; // v813: напоминания о дедлайнах — второй блок этого крона

export const config = { maxDuration: 60 };

const ALMATY_MS = 5 * 3600 * 1000;

function almatyNow() { return new Date(Date.now() + ALMATY_MS); }
function isoDate(d) { return d.toISOString().slice(0, 10); }

function fmtMoney(n, cur) {
  return Math.round(Number(n) || 0).toLocaleString('ru-RU') + ' ' + cur;
}

async function getDigestSettings() {
  const rows = await sbSelect('app_settings', { key: 'eq.tg_digest', limit: '1' });
  return rows.length ? (rows[0].value || {}) : {};
}

async function markSent(settings, today) {
  await sbUpsert('app_settings', {
    key: 'tg_digest',
    value: { ...settings, last_sent: today },
    updated_at: new Date().toISOString()
  }, 'key');
}

// Доходы: текущий месяц по странам + вчерашние оплаты
async function collectPayments(monthStart, yesterday) {
  const rows = await sbSelect('payments', {
    select: 'amount,country,paid_at',
    paid_at: 'gte.' + monthStart,
    limit: '5000'
  });
  const out = { KZ: 0, KG: 0, yCount: 0, ySum: 0 };
  rows.forEach(p => {
    const a = Number(p.amount) || 0;
    const c = (p.country || 'KZ').toUpperCase();
    if (out[c] != null) out[c] += a;
    if (String(p.paid_at).slice(0, 10) === yesterday) { out.yCount++; out.ySum += a; }
  });
  return out;
}

// Интеграции: очередь (и возраст старейшей), в работе, готово за месяц
async function collectIntegrations(monthStart) {
  const rows = await sbSelect('integrations', {
    select: 'status,date_paid,created_at,date_done',
    limit: '3000'
  });
  const out = { queue: 0, oldestDays: 0, inWork: 0, doneMonth: 0 };
  const now = Date.now();
  rows.forEach(r => {
    if (r.status === 'Новая') {
      out.queue++;
      const d = Date.parse(r.date_paid || r.created_at);
      if (d) out.oldestDays = Math.max(out.oldestDays, Math.floor((now - d) / 86400000));
    }
    if (r.status === 'В работе') out.inWork++;
    if (r.status === 'Готово' && r.date_done && String(r.date_done) >= monthStart) out.doneMonth++;
  });
  return out;
}

// Просроченные открытые задачи по исполнителям (топ-5)
async function collectOverdueTasks() {
  const rows = await sbSelect('tasks', {
    select: 'assignee_operator',
    status: 'eq.open',
    deadline_at: 'lt.' + new Date().toISOString(),
    limit: '2000'
  });
  const by = {};
  rows.forEach(t => {
    const a = (t.assignee_operator || 'без исполнителя').trim() || 'без исполнителя';
    by[a] = (by[a] || 0) + 1;
  });
  return Object.keys(by)
    .map(a => ({ assignee: a, count: by[a] }))
    .sort((x, y) => y.count - x.count)
    .slice(0, 5);
}

// Расход Meta за вчера — через собственный endpoint (там уже токены кабинетов и нормализация).
// Любая ошибка не валит дайджест — просто «нет данных».
async function metaSpendYesterday(country) {
  try {
    const base = process.env.VERCEL_PROJECT_PRODUCTION_URL || 'salesdoc-app.vercel.app';
    const r = await fetch(`https://${base}/api/meta-ads?endpoint=account_summary&period=yesterday&country=${country}`, {
      headers: { 'x-app-token': (process.env.APP_TOKEN || '').trim() }
    });
    const d = await r.json();
    if (!d || d.error || !d.summary) return null;
    return { spend: parseFloat(d.summary.spend || 0) || 0, leads: Math.round(Number(d.summary.leads_count || 0)) };
  } catch (_) { return null; }
}

function formatDigest(d) {
  const L = [];
  L.push('<b>SalesDoc — утренний дайджест</b>');
  L.push(d.dateLabel);
  L.push('');
  L.push('<b>Доходы за месяц</b>');
  L.push('KZ: ' + fmtMoney(d.pay.KZ, '₸') + ' · KG: ' + fmtMoney(d.pay.KG, 'сом'));
  L.push('Вчера: ' + d.pay.yCount + ' оплат на ' + fmtMoney(d.pay.ySum, '₸/сом'));
  L.push('');
  L.push('<b>Интеграции</b>');
  L.push('В очереди: ' + d.intg.queue + (d.intg.oldestDays > 0 ? ' (старейшая ждёт ' + d.intg.oldestDays + ' дн)' : '')
    + ' · в работе: ' + d.intg.inWork + ' · готово за месяц: ' + d.intg.doneMonth);
  L.push('');
  if (d.overdue.length) {
    L.push('<b>Просроченные задачи</b>');
    d.overdue.forEach(o => L.push(o.assignee + ': ' + o.count));
    L.push('');
  }
  const mk = [];
  if (d.metaKZ) mk.push('KZ $' + Math.round(d.metaKZ.spend) + ' · ' + d.metaKZ.leads + ' лидов');
  if (d.metaKG) mk.push('KG $' + Math.round(d.metaKG.spend) + ' · ' + d.metaKG.leads + ' лидов');
  if (mk.length) {
    L.push('<b>Реклама вчера</b>');
    L.push(mk.join(' · '));
    L.push('');
  }
  L.push('Подробности — в дашборде: https://salesdoc-app.vercel.app');
  return L.join('\n');
}

// v813: блок дайджеста вынесен в функцию — рядом теперь живут напоминания (runReminders),
// оба блока независимы: падение одного не мешает другому.
async function runDigest() {
  const botToken = (process.env.TG_BOT_TOKEN || '').trim();
  const ceoChatId = (process.env.CEO_TG_CHAT_ID || '').trim();
  if (!botToken) return { skipped: 'no_tg_bot_token' };
  if (!ceoChatId) return { skipped: 'no_ceo_chat_id' };

  const settings = await getDigestSettings();
  if (!settings.enabled) return { skipped: 'disabled' };

  const nowA = almatyNow();
  const today = isoDate(nowA);
  const hour = Number(settings.hour == null ? 9 : settings.hour);
  if (nowA.getUTCHours() !== hour) return { skipped: 'not_the_hour', almaty_hour: nowA.getUTCHours() };
  if (settings.last_sent === today) return { skipped: 'already_sent' };

  const monthStart = today.slice(0, 8) + '01';
  const yest = isoDate(new Date(nowA.getTime() - 86400000));

  const [pay, intg, overdue, metaKZ, metaKG] = await Promise.all([
    collectPayments(monthStart, yest),
    collectIntegrations(monthStart),
    collectOverdueTasks(),
    metaSpendYesterday('KZ'),
    metaSpendYesterday('KG')
  ]);

  const MONTHS = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
  const dateLabel = nowA.getUTCDate() + ' ' + MONTHS[nowA.getUTCMonth()] + ' ' + nowA.getUTCFullYear();

  const text = formatDigest({ dateLabel, pay, intg, overdue, metaKZ, metaKG });

  const r = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: ceoChatId, text: text, parse_mode: 'HTML', disable_web_page_preview: true })
  });
  const j = await r.json();
  if (!j || !j.ok) return { error: 'tg_failed', tg: j };

  await markSent(settings, today);
  return { sent: true };
}

export default async function handler(req, res) {
  // fail-closed (паттерн v592 из cron-fdx-reminder)
  const expected = (process.env.CRON_SECRET || '').trim();
  if (!expected) return res.status(503).json({ ok: false, error: 'CRON_SECRET не настроен' });
  const got = String(req.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim();
  if (got !== expected) return res.status(401).json({ ok: false, error: 'Unauthorized' });

  const results = {};
  try {
    results.digest = await runDigest();
  } catch (e) {
    console.error('[cron-digest]', e);
    results.digest = { error: String((e && e.message) || e) };
  }
  try {
    results.reminders = await runReminders();
  } catch (e) {
    console.error('[cron-reminders]', e);
    results.reminders = { error: String((e && e.message) || e) };
  }
  return res.status(200).json({ ok: true, ...results });
}
