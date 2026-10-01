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

export const config = { maxDuration: 300 };

export default async function handler(req, res) {
  const expected = (process.env.CRON_SECRET || '').trim();
  if (!expected) return res.status(503).json({ ok: false, error: 'CRON_SECRET не настроен' });
  const got = String(req.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim();
  if (got !== expected) return res.status(401).json({ ok: false, error: 'Unauthorized' });

  // SEC: адрес своего сервера — из окружения, не из заголовков запроса.
  const base = (String(process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '')) || 'https://salesdoc-app.vercel.app';
  const appTok = String(process.env.APP_TOKEN || '').trim();
  const call = async (qs) => {
    const r = await fetch(`${base}/api/amo?${qs}`, {
      headers: { 'x-app-token': appTok, 'x-user-email': 'cron@salesdoc.io' }
    });
    return r.json().catch(() => ({ error: 'нечитаемый ответ' }));
  };

  const out = {};
  try {
    // Переписки: смотрим неделю назад. Человек мог написать вчера, а сделку ему
    // завели сегодня — короткое окно такие пары всё равно поймает.
    const chats = await call('action=targ_sync&country=KG&days=7&limit=60&dry_run=false');
    out.chats = { matched: chats.matched || 0, saved: chats.saved || 0, errors: chats.save_errors || [] };
  } catch (e) { out.chats = { error: e.message || String(e) }; }

  try {
    // Заявки лидформ: окно шире, потому что заявка и сделка в amoCRM могут
    // разойтись на несколько дней, пока менеджер до неё дойдёт.
    const forms = await call('action=targ_forms&country=KG&days=14&limit=100&dry_run=false');
    out.forms = { found: forms.forms_leads_found || 0, matched: forms.matched || 0,
                  saved: forms.saved || 0, errors: forms.save_errors || [] };
  } catch (e) { out.forms = { error: e.message || String(e) }; }

  // Прогреваем отчёт за текущий месяц, чтобы экран открывался сразу, а не через 40 с.
  try {
    const d = new Date(); const y = d.getUTCFullYear(), m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const since = `${y}-${m}-01`, until = `${y}-${m}-${String(d.getUTCDate()).padStart(2, '0')}`;
    const r = await call(`action=targ_report&country=KG&since=${since}&until=${until}&fresh=1`);
    out.warm = { ok: !r.error, targetologs: (r.targetologs || []).length };
  } catch (e) { out.warm = { error: e.message || String(e) }; }
  console.log('[cron-ad-touches]', JSON.stringify(out));
  return res.status(200).json({ ok: true, ...out });
}
