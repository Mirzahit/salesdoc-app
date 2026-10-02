import './_preview_guard.js'; // v1017: в превью-сборке запись наружу отключена (см. файл)
// /api/cron-ad-touches — копим рекламные касания сами, без ручного запуска.
//
// Зачем: разбивка Маркетинга по таргетологам держится на таблице ad_touches —
// кто пришёл с чьей рекламы. Собирается она из двух источников, и оба живут
// недолго: переписки Wazzup приходят вебхуком в реальном времени, а заявки
// лидформ Meta хранит 90 дней. Без регулярного прогона свежие обращения просто
// не попадут в отчёт, а старые Meta успеет удалить.
//
// Запускается Vercel Cron по расписанию из vercel.json. Окна берём короткие:
// уложиться надо в 60 секунд (реальный потолок на этом плане), а повторный
// прогон дублей не плодит — касание пишется по уникальному ключу сообщения.
//
// ENV: CRON_SECRET (Vercel Cron шлёт его сам), APP_TOKEN (для вызова своих же
// эндпоинтов), META_LEADS_TOKEN (доступ к заявкам лидформ).
// v1017: заявки лидформ копятся в meta_leads (action=meta_leads_sync), в ad_touches — только переписки.

import { bishkekIso } from './_dates.js'; // v1015
import { sbSelect } from './_supabase.js';
import { backfillPiece } from './_mkt.js'; // v1017 (b2)
// v1017 (QA): в журнал — без «Failing row contains (…)» (там телефон и имя клиента)
const cleanErr = (m) => String(m || '').split(/Failing row/i)[0].trim().slice(0, 200);

export const config = { maxDuration: 300 };

export default async function handler(req, res) {
  const expected = (process.env.CRON_SECRET || '').trim();
  if (!expected) return res.status(503).json({ ok: false, error: 'CRON_SECRET не настроен' });
  const got = String(req.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim();
  if (got !== expected) return res.status(401).json({ ok: false, error: 'Unauthorized' });

  // SEC: адрес своего сервера — из окружения, не из заголовков запроса.
  const base = (String(process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '')) || 'https://salesdoc-app.vercel.app';
  const appTok = String(process.env.APP_TOKEN || '').trim();
  // v1017 (QA): у каждого вызова свой потолок времени; запись заявок — с секретом крона (Bearer).
  const call = async (qs, timeoutMs, withSecret) => {
    const hdr = { 'x-app-token': appTok, 'x-user-email': 'cron@salesdoc.io' };
    if (withSecret) hdr['authorization'] = 'Bearer ' + expected;
    const bypass = String(process.env.VERCEL_AUTOMATION_BYPASS_SECRET || '').trim(); // v1015: превью под защитой
    if (bypass) hdr['x-vercel-protection-bypass'] = bypass;
    const r = await fetch(`${base}/api/amo?${qs}`, { headers: hdr, signal: AbortSignal.timeout(timeoutMs || 60000) });
    return r.json().catch(() => ({ error: 'нечитаемый ответ' }));
  };

  const out = {};
  // v1017 (b2): дозаливка старых переписок — сам крон в прогоне 06:30 по Бишкеку (после ночной загрузки
  // заявок и Финансиста), если в app_settings лежит заявка mkt_chat_backfill_request = {from, to}
  // и отметка mkt_chat_backfill её ещё не покрывает. Идёт от старых переписок к новым с курсора
  // (app_settings.mkt_chat_backfill_progress); не успела за ночь (время, 120 номеров, сбой amo) —
  // следующей ночью продолжит с курсора. Отметка пишется, когда кусок пройден целиком.
  const T0 = Date.now(), BUDGET_MS = 270000;
  const left = () => BUDGET_MS - (Date.now() - T0);
  const hourB = new Date(Date.now() + 6 * 3600000).getUTCHours();
  let bfReq = null;
  if (hourB === 6) {
    try {
      const rows = await sbSelect('app_settings', { key: 'in.(mkt_chat_backfill_request,mkt_chat_backfill)' });
      const v = {}; rows.forEach(r => { v[r.key] = r.value; });
      const rq = v.mkt_chat_backfill_request;
      // длинная заявка режется на куски ≤45 дней; каждую ночь — следующий кусок (курсор внутри куска — в amo.js)
      if (rq && /^\d{4}-\d{2}-\d{2}$/.test(String(rq.from || '')) && /^\d{4}-\d{2}-\d{2}$/.test(String(rq.to || ''))) bfReq = backfillPiece(rq, v.mkt_chat_backfill, bishkekIso(Date.now()));
    } catch (e) { out.backfill = { error: 'заявка на дозаливку не прочиталась' }; }
  }

  // Переписки: смотрим неделю назад. Человек мог написать вчера, а сделку ему завели сегодня —
  // короткое окно такие пары всё равно поймает. Идёт всегда, и в ночь дозаливки тоже.
  try {
    const chats = await call('action=targ_sync&country=KG&days=7&limit=60&dry_run=false', bfReq ? 60000 : 120000);
    out.chats = { matched: chats.matched || 0, saved: chats.saved || 0, errors: (chats.save_errors || []).map(cleanErr) };
  } catch (e) { out.chats = { error: e.message || String(e) }; }

  try {
    // v1017: заявки лидформ — в свою таблицу meta_leads (а не в ad_touches) и поиск их сделок в amo.
    // Днём проверяются свежие заявки, ночью — ещё и старые порциями (до 100 за прогон).
    const ml = await call('action=meta_leads_sync&country=KG&dry_run=false&max=100', Math.min(160000, Math.max(30000, left() - (bfReq ? 90000 : 60000))), true);
    out.forms = { pulled: ml.pulled || 0, inserted: ml.inserted || 0, checked: ml.checked || 0, by_status: ml.by_status || {},
                  backfill_pending: ml.backfill_pending || 0, requests: ml.requests || null,
                  errors: (ml.errors || []).map(e => cleanErr(e.message || e)).concat(ml.error ? [cleanErr(ml.error)] : []) };
  } catch (e) { out.forms = { error: e.message || String(e) }; }

  if (bfReq) {
    const tmo = Math.min(200000, left() - 5000);
    if (tmo < 45000) out.backfill = { skipped: 'не хватило времени, следующей ночью' };
    else {
      try {
        // сама дозаливка останавливается по своему бюджету (budget, с) чуть раньше таймаута вызова и запоминает курсор
        const budgetS = Math.max(20, Math.floor((tmo - 15000) / 1000));
        const b = await call(`action=targ_sync&country=KG&since=${bfReq.from}&until=${bfReq.to}&max=120&mark=1&dry_run=false&budget=${budgetS}`, tmo, true);
        const rg = b.range || {};
        out.backfill = { from: bfReq.from, to: bfReq.to, checked: b.checked_phones || 0, matched: b.matched || 0, saved: b.saved || 0,
          incomplete: !rg.done || !!b.error, stop: rg.stop || null, cursor_at: rg.cursor_at || null, search_failed: b.search_failed || 0,
          marked: !!b.backfill_mark, error: b.error ? cleanErr(b.error) : undefined };
      } catch (e) { out.backfill = { error: e.message || String(e) }; }
    }
  } else {
    // Прогреваем отчёт за текущий месяц, чтобы экран открывался сразу, а не через 40 с.
    // v1015: месяц — по Бишкеку; греем тот же вариант, что открывает экран: v=2, продукт SalesDoc.
    try {
      const until = bishkekIso(Date.now()), since = until.slice(0, 8) + '01';
      const r = await call(`action=targ_report&country=KG&since=${since}&until=${until}&fresh=1&v=2&product=SD`, 60000);
      out.warm = { ok: !r.error, targetologs: (r.targetologs || []).length, errors: (r.errors || []).length };
    } catch (e) { out.warm = { error: e.message || String(e) }; }
  }
  console.log('[cron-ad-touches]', JSON.stringify(out));
  return res.status(200).json({ ok: true, ...out });
}
