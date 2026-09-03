// /api/wazzup — приёмник вебхуков Wazzup (v905).
//
// Зачем. Заявки из WhatsApp и Instagram приходят в amoCRM без пометки, откуда
// пришёл человек: менеджер видит сообщение и заводит сделку руками. Из-за этого
// цену заявки с рекламы посчитать не из чего. Wazzup же в каждом входящем
// сообщении отдаёт блок referral — ссылку на пост, заголовок объявления и
// ctwa_clid (идентификатор клика по рекламе). Это и есть доказательство.
//
// Что делает:
//   POST /api/wazzup?k=<WAZZUP_HOOK_SECRET>   — приём вебхука от Wazzup.
//   GET  /api/wazzup?action=subscribe          — подписать наш адрес у Wazzup.
//   GET  /api/wazzup?action=status             — что подписано и сколько поймали.
//   GET  /api/wazzup?action=events&days=30     — что пришло (для сверки).
//   GET  /api/wazzup?phone=996700000000        — рекламный след по номеру.
// Все GET-действия закрыты app-token, POST — секретом в адресе (Wazzup не умеет
// слать наши заголовки).
//
// ENV:
//   WAZZUP_API_KEY     — ключ из кабинета Wazzup (Настройки → Интеграции → API)
//   WAZZUP_HOOK_SECRET — любая своя строка, попадёт в адрес вебхука
//   PUBLIC_BASE_URL    — опц., адрес сайта; иначе берём из заголовков запроса

import { sbInsertIgnoreDup, sbSelect } from './_supabase.js';
import { checkAuth } from './_auth.js';

const WZ_API = 'https://api.wazzup24.com/v3';

function apiKey() { return String(process.env.WAZZUP_API_KEY || '').trim(); }
function hookSecret() { return String(process.env.WAZZUP_HOOK_SECRET || '').trim(); }

function baseUrl(req) {
  const env = String(process.env.PUBLIC_BASE_URL || '').trim();
  if (env) return env.replace(/\/+$/, '');
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  return `${proto}://${host}`;
}

async function wzFetch(path, method, body) {
  const key = apiKey();
  if (!key) throw new Error('WAZZUP_API_KEY не задан в переменных Vercel');
  const r = await fetch(WZ_API + path, {
    method: method || 'GET',
    headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = { raw: text }; }
  if (!r.ok) {
    const err = new Error(`Wazzup ${method || 'GET'} ${path} → ${r.status}: ${text.slice(0, 300)}`);
    err.status = r.status;
    throw err;
  }
  return data;
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try { return JSON.parse(raw); } catch (_) { return { _unparsed: raw }; }
}

// Телефон приводим к цифрам: в amo он записан как угодно, сверять будем по хвосту.
function normPhone(v) {
  const digits = String(v || '').replace(/\D/g, '');
  if (digits.length < 9) return null;
  return digits;
}

// Wazzup складывает номер в chatId для каналов whatsapp/telegram, а для
// Instagram там username. Поэтому берём первое, что похоже на номер.
function pickPhone(m) {
  const cands = [
    m && m.chatId,
    m && m.contact && m.contact.phone,
    m && m.contact && m.contact.chatId,
    m && m.authorPhone,
    m && m.phone
  ];
  for (const c of cands) {
    const p = normPhone(c);
    if (p) return p;
  }
  return null;
}

function pickReferral(m) {
  if (!m) return null;
  const r = m.referral || (m.recipient && m.recipient.referral) || null;
  if (r && typeof r === 'object' && Object.keys(r).length) return r;
  // На некоторых каналах рекламный след лежит в advert.
  const a = (m.recipient && m.recipient.advert) || m.advert || null;
  if (a && typeof a === 'object' && Object.keys(a).length) return a;
  return null;
}

function rowFromMessage(m) {
  const ref = pickReferral(m);
  return {
    kind: 'message',
    message_id: String((m && (m.messageId || m.id)) || '') || null,
    chat_id: (m && (m.chatId || m.chat_id)) || null,
    chat_type: (m && (m.chatType || m.chat_type)) || null,
    channel_id: (m && (m.channelId || m.channel_id)) || null,
    phone: pickPhone(m),
    direction: (m && (m.isEcho ? 'out' : (m.direction || 'in'))) || null,
    message_text: (m && (m.text || m.textContent)) || null,
    contact_name: (m && m.contact && (m.contact.name || m.contact.username)) || (m && m.authorName) || null,
    referral: ref || null,
    ctwa_clid: (ref && (ref.ctwa_clid || ref.ctwaClid)) || null,
    ad_source_id: (ref && (ref.source_id || ref.sourceId)) || null,
    ad_headline: (ref && (ref.headline || ref.title)) || null,
    raw: m || {}
  };
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();

  // ── приём вебхука ─────────────────────────────────────────────────────────
  if (req.method === 'POST') {
    const secret = hookSecret();
    const given = String((req.query && (req.query.k || req.query.key)) || '');
    if (!secret || given !== secret) return res.status(403).json({ error: 'forbidden' });

    let body = {};
    try { body = await readBody(req); } catch (_) { body = {}; }

    // Отвечаем Wazzup быстро и всегда 200: иначе он отключит вебхук после
    // серии ошибок, а разбирать payload можно и потом по сырым данным.
    try {
      const rows = [];
      const msgs = Array.isArray(body.messages) ? body.messages : [];
      msgs.forEach(m => rows.push(rowFromMessage(m)));

      // Всё, что не сообщения (статусы, создание контактов и сделок, тестовый
      // запрос при подписке) — кладём одной строкой, чтобы увидеть живой формат.
      if (!msgs.length) {
        rows.push({
          kind: body.test ? 'test' : (Object.keys(body)[0] || 'unknown'),
          message_id: null, chat_id: null, chat_type: null, channel_id: null,
          phone: null, direction: null, message_text: null, contact_name: null,
          referral: null, ctwa_clid: null, ad_source_id: null, ad_headline: null,
          raw: body
        });
      }
      const withId = rows.filter(r => r.message_id);
      const noId = rows.filter(r => !r.message_id);
      if (withId.length) await sbInsertIgnoreDup('wazzup_events', withId, 'message_id');
      if (noId.length) await sbInsertIgnoreDup('wazzup_events', noId);
    } catch (e) {
      console.error('[api/wazzup] не смогли сохранить вебхук:', e && e.message);
    }
    return res.status(200).json({ ok: true });
  }

  if (req.method !== 'GET') return res.status(405).json({ error: 'Only GET/POST' });
  if (!checkAuth(req, res)) return;

  const action = String((req.query && req.query.action) || '').toLowerCase();

  try {
    if (action === 'subscribe') {
      if (!hookSecret()) return res.status(400).json({ ok: false, error: 'WAZZUP_HOOK_SECRET не задан в переменных Vercel' });
      const uri = `${baseUrl(req)}/api/wazzup?k=${encodeURIComponent(hookSecret())}`;
      const out = await wzFetch('/webhooks', 'PATCH', {
        webhooksUri: uri,
        subscriptions: { messagesAndStatuses: true, contactsAndDealsCreation: true }
      });
      return res.status(200).json({ ok: true, subscribed_to: uri, wazzup: out });
    }

    if (action === 'status') {
      let hooks = null, hooksError = null;
      try { hooks = await wzFetch('/webhooks'); } catch (e) { hooksError = e.message; }
      let channels = null, channelsError = null;
      try { channels = await wzFetch('/channels'); } catch (e) { channelsError = e.message; }
      const recent = await sbSelect('wazzup_events', { order: 'received_at.desc', limit: 5 });
      const withRef = await sbSelect('wazzup_events', { select: 'id', ctwa_clid: 'not.is.null', limit: 1000 });
      return res.status(200).json({
        ok: true,
        api_key_set: !!apiKey(),
        hook_secret_set: !!hookSecret(),
        expected_uri: hookSecret() ? `${baseUrl(req)}/api/wazzup?k=***` : null,
        webhooks: hooks, webhooks_error: hooksError,
        channels: channels, channels_error: channelsError,
        events_with_ad_source: withRef.length,
        last_events: recent.map(e => ({
          received_at: e.received_at, kind: e.kind, phone: e.phone,
          headline: e.ad_headline, has_referral: !!e.referral
        }))
      });
    }

    if (action === 'events') {
      const days = Math.min(Math.max(Number(req.query.days || 30), 1), 365);
      const since = new Date(Date.now() - days * 86400000).toISOString();
      const rows = await sbSelect('wazzup_events', {
        received_at: 'gte.' + since, order: 'received_at.desc', limit: 500
      });
      return res.status(200).json({ ok: true, days, count: rows.length, events: rows });
    }

    // ?phone= — рекламный след по конкретному номеру, для карточки сделки
    const phone = normPhone(req.query && req.query.phone);
    if (phone) {
      const tail = phone.slice(-9);
      const rows = await sbSelect('wazzup_events', {
        phone: 'like.*' + tail, order: 'received_at.asc', limit: 50
      });
      const first = rows.find(r => r.referral) || null;
      return res.status(200).json({
        ok: true, phone, found: rows.length,
        ad: first ? { headline: first.ad_headline, source_id: first.ad_source_id, ctwa_clid: first.ctwa_clid, referral: first.referral, at: first.received_at } : null
      });
    }

    return res.status(400).json({ ok: false, error: 'Нужен ?action=subscribe|status|events или ?phone=' });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message || String(e) });
  }
}
