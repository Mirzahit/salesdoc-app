// /api/history — лента действий по карточке Канбана.
//
// GET    /api/history?card_id=UUID    → история карточки (последние сверху)
// POST   /api/history                 → новая запись (body: { card_id, event_type, text, author })
// PATCH  /api/history?id=UUID         → редактировать (whitelist: text, pinned)
// DELETE /api/history?id=UUID         → удалить запись (только заметки, не stage_change/system)
//
// event_type: 'call' | 'whatsapp' | 'note' | 'stage_change' | 'file' | 'system'

import { sbSelect, sbInsert, sbUpdate, sbDelete } from './_supabase.js';
import { notifCreate, opEmailByName } from './_notify.js'; // v813: уведомления об @упоминаниях

const ALLOWED_PATCH_FIELDS = ['text', 'pinned'];
import { checkAuth } from './_auth.js';

// v430: добавлен 'integration_note' — заметки от команды интеграторов.
// В UI будут рендериться особым стилем (как тикеты в v416-v417), чтобы было
// видно «это от интегратора, не от оператора внедрения».
const ALLOWED_EVENTS = new Set(['call','whatsapp','note','stage_change','file','system','integration_note']);

export default async function handler(req, res) {
  if (!checkAuth(req, res)) return;
  try {
    if (req.method === 'GET') {
      const { card_id, client_id, limit } = req.query || {};
      const params = { order: 'created_at.desc' };
      if (card_id) params['card_id'] = 'eq.' + card_id;
      if (client_id) params['client_id'] = 'eq.' + client_id;
      if (limit) params['limit'] = limit;
      const items = await sbSelect('card_history', params);
      return res.status(200).json({ ok: true, count: items.length, items });
    }

    if (req.method === 'POST') {
      const body = await readBody(req);
      if (!body.card_id && !body.client_id) {
        return res.status(400).json({ ok: false, error: 'нужен card_id или client_id' });
      }
      if (!body.event_type || !ALLOWED_EVENTS.has(body.event_type)) {
        return res.status(400).json({ ok: false, error: 'event_type должен быть один из: ' + Array.from(ALLOWED_EVENTS).join(', ') });
      }
      const row = {
        card_id: body.card_id || null,
        client_id: body.client_id || null,
        event_type: body.event_type,
        text: body.text || null,
        attachment_url: body.attachment_url || null,
        author: body.author || null
      };
      const result = await sbInsert('card_history', row);

      // v813: @упоминания — фронт шлёт mentions[] (имена из выпадающей подсказки),
      // сервер перепроверяет и резолвит в email. Сбой уведомления не валит заметку.
      if (Array.isArray(body.mentions) && body.mentions.length) {
        try {
          const authorName = String(row.author || '').trim();
          const names = body.mentions.slice(0, 10)
            .map(n => String(n || '').trim())
            .filter(n => n && /^[\p{L}\s.-]{2,40}$/u.test(n));
          const seen = {};
          const notifRows = [];
          for (const nm of names) {
            const em = await opEmailByName(nm);
            if (!em || seen[em]) continue;
            seen[em] = 1;
            // сам себя упомянул — не уведомляем
            if (authorName && nm.split(/\s+/)[0].toLowerCase() === authorName.split(/\s+/)[0].toLowerCase()) continue;
            notifRows.push({
              user_email: em,
              type: 'mention',
              title: (authorName || 'Коллега') + ' упомянул вас в заметке',
              body: String(row.text || '').slice(0, 200),
              entity_type: body.event_type === 'integration_note' ? 'integration' : (row.card_id ? 'kanban_card' : 'client'),
              entity_id: body.mention_entity_id || row.card_id || row.client_id || null,
              client_id: row.client_id || null,
              actor: authorName || null
            });
          }
          if (notifRows.length) await notifCreate(notifRows);
        } catch (e) { console.warn('[history] mention notify failed:', e.message); }
      }

      return res.status(201).json({ ok: true, item: result[0] });
    }

    if (req.method === 'PATCH') {
      const { id } = req.query || {};
      if (!id) return res.status(400).json({ ok: false, error: 'нужен id' });
      const body = await readBody(req);
      const patch = {};
      for (const k of ALLOWED_PATCH_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(body, k)) patch[k] = body[k];
      }
      if (!Object.keys(patch).length) {
        return res.status(400).json({ ok: false, error: 'нечего обновлять. Разрешены поля: ' + ALLOWED_PATCH_FIELDS.join(', ') });
      }
      // Защита: системные события и смены этапа редактировать нельзя.
      const rows = await sbSelect('card_history', { id: 'eq.' + id, limit: 1 });
      if (!rows.length) return res.status(404).json({ ok: false, error: 'запись не найдена' });
      const evt = rows[0].event_type;
      if (evt === 'stage_change' || evt === 'system') {
        return res.status(403).json({ ok: false, error: 'системные события нельзя редактировать' });
      }
      const updated = await sbUpdate('card_history', { id: 'eq.' + id }, patch);
      return res.status(200).json({ ok: true, item: updated[0] || null });
    }

    if (req.method === 'DELETE') {
      const { id } = req.query || {};
      if (!id) return res.status(400).json({ ok: false, error: 'нужен id' });
      // Защита: не даём удалять системные события (stage_change, system) — только заметки/звонки/файлы.
      const rows = await sbSelect('card_history', { id: 'eq.' + id, limit: 1 });
      if (!rows.length) return res.status(404).json({ ok: false, error: 'запись не найдена' });
      const evt = rows[0].event_type;
      if (evt === 'stage_change' || evt === 'system') {
        return res.status(403).json({ ok: false, error: 'системные события нельзя удалять' });
      }
      await sbDelete('card_history', { id: 'eq.' + id });
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ ok: false, error: 'method not allowed' });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message || String(e) });
  }
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  return new Promise((resolve) => {
    let chunks = '';
    req.on('data', c => chunks += c);
    req.on('end', () => { try { resolve(JSON.parse(chunks || '{}')); } catch { resolve({}); } });
  });
}
