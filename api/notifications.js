// /api/notifications — v813: центр уведомлений (колокольчик) + привязка Telegram.
//
// GET   /api/notifications              → { ok, unread, items:[последние 30] } для caller
// PATCH /api/notifications?id=UUID      → пометить прочитанным (только своё)
// PATCH /api/notifications?all=1        → пометить все свои
// POST  {action:'tg_code'}              → выдать код привязки (15 минут)
// POST  {action:'tg_check'}             → забрать код из сообщений боту (getUpdates) и привязать
// POST  {action:'tg_unlink'}            → отвязать Telegram
//
// Создания уведомлений снаружи НЕТ намеренно: APP_TOKEN лежит в клиентском бандле,
// внешний POST был бы вектором спама и подделки «системных» уведомлений.
// Генераторы — только серверный код через api/_notify.js.
//
// Личность — заголовок x-user-email (sbFetch шлёт сам). Известное ограничение проекта:
// заголовок можно подделать с APP_TOKEN — читается/метится только СВОЙ список, приемлемо.

import { sbSelect, sbUpdate } from './_supabase.js';
import { checkAuth } from './_auth.js';

export const config = { maxDuration: 15 };

const TG_TOKEN = process.env.TG_BOT_TOKEN || '';

function callerEmail(req) {
  return String(req.headers['x-user-email'] || '').trim().toLowerCase();
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  return new Promise((resolve) => {
    let chunks = '';
    req.on('data', c => chunks += c);
    req.on('end', () => { try { resolve(JSON.parse(chunks || '{}')); } catch { resolve({}); } });
  });
}

async function tgApi(method, params) {
  const r = await fetch('https://api.telegram.org/bot' + TG_TOKEN + '/' + method, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params || {}),
    signal: AbortSignal.timeout(8000)
  });
  return r.json();
}

export default async function handler(req, res) {
  if (!checkAuth(req, res)) return;
  const email = callerEmail(req);
  if (!email) return res.status(400).json({ ok: false, error: 'нет email — обратитесь к администратору' });

  try {
    if (req.method === 'GET') {
      const [items, unreadRows] = await Promise.all([
        sbSelect('notifications', { user_email: 'eq.' + email, order: 'created_at.desc', limit: '30' }),
        sbSelect('notifications', { user_email: 'eq.' + email, is_read: 'eq.false', select: 'id', limit: '100' })
      ]);
      return res.status(200).json({ ok: true, unread: unreadRows.length, items });
    }

    if (req.method === 'PATCH') {
      const q = req.query || {};
      if (q.all === '1') {
        await sbUpdate('notifications', { user_email: 'eq.' + email, is_read: 'eq.false' }, { is_read: true });
        return res.status(200).json({ ok: true });
      }
      if (q.id) {
        // фильтр и по id, и по user_email — чужое пометить нельзя
        await sbUpdate('notifications', { id: 'eq.' + q.id, user_email: 'eq.' + email }, { is_read: true });
        return res.status(200).json({ ok: true });
      }
      return res.status(400).json({ ok: false, error: 'нужен ?id или ?all=1' });
    }

    if (req.method === 'POST') {
      const body = await readBody(req);

      if (body.action === 'tg_code') {
        // 4-значный код, живёт 15 минут. ilike — на случай email с заглавными в employees
        const code = String(Math.floor(1000 + Math.random() * 9000));
        const upd = await sbUpdate('employees', { email: 'ilike.' + email },
          { tg_link_code: code, tg_link_code_at: new Date().toISOString() });
        if (!upd.length) return res.status(404).json({ ok: false, error: 'сотрудник не найден' });
        return res.status(200).json({ ok: true, code, bot: 'salesdoc_reports_bot' });
      }

      if (body.action === 'tg_check') {
        if (!TG_TOKEN) return res.status(500).json({ ok: false, error: 'бот не настроен на сервере' });
        // Все сотрудники с живыми кодами (не только caller — обрабатываем всё, что накопилось)
        const emps = await sbSelect('employees', {
          tg_link_code: 'not.is.null', select: 'email,tg_link_code,tg_link_code_at'
        });
        const alive = {};
        const now = Date.now();
        emps.forEach(e => {
          const t = new Date(e.tg_link_code_at || 0).getTime();
          if (now - t < 15 * 60 * 1000) alive[String(e.tg_link_code).trim()] = String(e.email).toLowerCase();
        });
        const upd = await tgApi('getUpdates', { timeout: 0, allowed_updates: ['message'] });
        if (!upd.ok) {
          const conflict = String(upd.description || '').includes('terminated by other');
          return res.status(200).json({ ok: false, error: conflict ? 'бот занят — попробуйте ещё раз' : ('telegram: ' + (upd.description || 'ошибка')) });
        }
        let linkedMe = false;
        let maxUpdateId = 0;
        for (const u of (upd.result || [])) {
          if (u.update_id > maxUpdateId) maxUpdateId = u.update_id;
          const msg = u.message;
          if (!msg || !msg.text || !msg.chat) continue;
          const codeTxt = String(msg.text).trim();
          const em = alive[codeTxt];
          if (!em) continue;
          await sbUpdate('employees', { email: 'eq.' + em },
            { tg_chat_id: String(msg.chat.id), tg_link_code: null, tg_link_code_at: null });
          delete alive[codeTxt]; // код одноразовый
          if (em === email) linkedMe = true;
          try {
            await tgApi('sendMessage', { chat_id: msg.chat.id, text: 'Уведомления SalesDoc подключены. Отвязать можно в Настройках дашборда.' });
          } catch (_) {}
        }
        // подтверждаем offset ТОЛЬКО после обработки — при падении выше апдейты не потеряются
        if (maxUpdateId) { try { await tgApi('getUpdates', { offset: maxUpdateId + 1, timeout: 0 }); } catch (_) {}
        }
        const me = await sbSelect('employees', { email: 'eq.' + email, select: 'tg_chat_id', limit: '1' });
        const linked = !!(me.length && me[0].tg_chat_id);
        return res.status(200).json({ ok: true, linked, just_linked: linkedMe });
      }

      if (body.action === 'tg_unlink') {
        await sbUpdate('employees', { email: 'eq.' + email }, { tg_chat_id: null, tg_link_code: null, tg_link_code_at: null });
        return res.status(200).json({ ok: true });
      }

      if (body.action === 'tg_status') {
        const me = await sbSelect('employees', { email: 'eq.' + email, select: 'tg_chat_id', limit: '1' });
        return res.status(200).json({ ok: true, linked: !!(me.length && me[0].tg_chat_id) });
      }

      return res.status(400).json({ ok: false, error: 'неизвестный action' });
    }

    return res.status(405).json({ ok: false, error: 'method not allowed' });
  } catch (e) {
    console.error('[api/notifications]', e);
    return res.status(500).json({ ok: false, error: e.message || String(e) });
  }
}
