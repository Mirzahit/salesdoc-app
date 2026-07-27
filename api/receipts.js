// /api/receipts — чеки (скрины переводов) к оплатам. v825.
//
// POST /api/receipts              → загрузить чек
//      body: { image: <base64 без dataURL-префикса>, mime, country }
//      ответ: { ok, path } — path сохраняется в payments.receipt_path
// GET  /api/receipts?path=...     → временная подписанная ссылка (1 час)
//
// Бакет payment-receipts ПРИВАТНЫЙ: публичных ссылок не существует, доступ
// только через этот эндпоинт (checkAuth) + service key (паттерн api/academy.js).

import { checkAuth } from './_auth.js';

const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SB_KEY = process.env.SUPABASE_SECRET_KEY || '';
const BUCKET = 'payment-receipts';

// Скрин после клиентского сжатия ~100-500КБ; 4МБ — щедрый потолок (лимит тела Vercel 4.5МБ)
const MAX_BASE64_LEN = 4 * 1024 * 1024;
const ALLOWED_MIME = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
// Путь строго нашего формата — защита от traversal при подписи ссылки
const PATH_RE = /^(KZ|KG)\/\d{4}\/\d{2}\/[a-f0-9-]{36}\.(jpg|png|webp)$/;

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  return new Promise((resolve) => {
    let chunks = '';
    req.on('data', c => chunks += c);
    req.on('end', () => { try { resolve(JSON.parse(chunks || '{}')); } catch { resolve({}); } });
  });
}

export default async function handler(req, res) {
  if (!checkAuth(req, res)) return;
  if (!SB_URL || !SB_KEY) return res.status(503).json({ ok: false, error: 'Supabase не настроен на сервере' });
  try {
    if (req.method === 'GET') {
      const path = String((req.query || {}).path || '');
      if (!PATH_RE.test(path)) return res.status(400).json({ ok: false, error: 'некорректный путь чека' });
      const r = await fetch(`${SB_URL}/storage/v1/object/sign/${BUCKET}/${path}`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${SB_KEY}`, 'apikey': SB_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ expiresIn: 3600 })
      });
      const json = await r.json().catch(() => ({}));
      if (!json.signedURL) return res.status(404).json({ ok: false, error: 'чек не найден в хранилище' });
      return res.status(200).json({ ok: true, url: SB_URL + '/storage/v1' + json.signedURL });
    }

    if (req.method === 'POST') {
      const body = await readBody(req);
      const country = String(body.country || '').toUpperCase();
      if (country !== 'KZ' && country !== 'KG') return res.status(400).json({ ok: false, error: 'country должен быть KZ или KG' });
      const ext = ALLOWED_MIME[body.mime];
      if (!ext) return res.status(400).json({ ok: false, error: 'формат должен быть JPEG/PNG/WebP' });
      const b64 = String(body.image || '');
      if (!b64) return res.status(400).json({ ok: false, error: 'нет изображения' });
      if (b64.length > MAX_BASE64_LEN) return res.status(413).json({ ok: false, error: 'чек слишком большой (после сжатия должен быть до ~3МБ)' });
      let buf;
      try { buf = Buffer.from(b64, 'base64'); } catch { return res.status(400).json({ ok: false, error: 'битый base64' }); }
      if (!buf || !buf.length) return res.status(400).json({ ok: false, error: 'пустое изображение' });

      const now = new Date();
      const path = `${country}/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${crypto.randomUUID()}.${ext}`;
      const up = await fetch(`${SB_URL}/storage/v1/object/${BUCKET}/${path}`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${SB_KEY}`, 'apikey': SB_KEY, 'Content-Type': body.mime },
        body: buf
      });
      if (!up.ok) {
        const err = await up.json().catch(() => ({}));
        return res.status(502).json({ ok: false, error: 'хранилище не приняло файл: ' + (err.message || up.status) });
      }
      return res.status(201).json({ ok: true, path });
    }

    return res.status(405).json({ ok: false, error: 'method not allowed' });
  } catch (e) {
    console.error('[api/receipts] error:', e);
    return res.status(500).json({ ok: false, error: e.message || String(e) });
  }
}
