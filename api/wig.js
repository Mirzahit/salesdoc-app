// /api/wig — главная цель квартала (4DX Wildly Important Goal).
// Хранилище: Vercel KV. Одна цель на компанию, ключ wig_v1.
// GET — любой залогиненный (нужен x-app-token). POST/PATCH — только CEO (email-whitelist).
// ENV: KV_REST_API_URL, KV_REST_API_TOKEN, опционально WIG_EDITOR_EMAILS (через запятую).

import { checkAuth } from './_auth.js';

const KV_KEY = 'wig_v1';

// Кто может править цель. По умолчанию — только CEO. Можно расширить через env.
const WIG_EDITOR_EMAILS = (process.env.WIG_EDITOR_EMAILS || 'office@salesdoc.io')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

function kvEnv() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return { url, token };
}

async function kvGet(key) {
  const { url, token } = kvEnv();
  if (!url || !token) throw new Error('KV not configured');
  const r = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!r.ok) throw new Error(`KV GET ${r.status}`);
  const j = await r.json();
  return j && j.result ? j.result : null;
}

async function kvSet(key, value) {
  const { url, token } = kvEnv();
  if (!url || !token) throw new Error('KV not configured');
  const body = typeof value === 'string' ? value : JSON.stringify(value);
  const r = await fetch(`${url}/set/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body
  });
  if (!r.ok) throw new Error(`KV SET ${r.status}`);
  return true;
}

function emptyState() {
  // published:false — на табло показывается заглушка «Цель пока не задана»
  return { published: false };
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  return new Promise((resolve) => {
    let chunks = '';
    req.on('data', c => chunks += c);
    req.on('end', () => { try { resolve(JSON.parse(chunks || '{}')); } catch { resolve({}); } });
  });
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!checkAuth(req, res)) return;

  const { url: kvUrl, token: kvToken } = kvEnv();
  if (!kvUrl || !kvToken) {
    return res.status(503).json({ ok: false, error: 'KV_NOT_CONFIGURED' });
  }

  try {
    if (req.method === 'GET') {
      const raw = await kvGet(KV_KEY);
      if (!raw) return res.status(200).json({ ok: true, wig: emptyState() });
      let parsed;
      try { parsed = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { parsed = emptyState(); }
      if (!parsed || typeof parsed !== 'object') parsed = emptyState();
      return res.status(200).json({ ok: true, wig: parsed });
    }

    if (req.method === 'POST') {
      const body = await readBody(req);
      // Защита: только email из белого списка может писать.
      const email = String(body.updated_by_email || '').trim().toLowerCase();
      if (!email || WIG_EDITOR_EMAILS.indexOf(email) === -1) {
        return res.status(403).json({ ok: false, error: 'Только CEO может править главную цель.' });
      }

      // Если body.partial=true — частичное обновление (например только current со страницы Цель).
      // Иначе — полная перезапись.
      let existing = null;
      const raw = await kvGet(KV_KEY);
      if (raw) {
        try { existing = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { existing = null; }
      }
      // v447: для истории нам нужно знать предыдущее значение current и старую историю.
      const prevCurrent = existing && typeof existing.current === 'number' ? existing.current : null;
      const prevHistory = (existing && Array.isArray(existing.history)) ? existing.history : [];

      let next;
      if (body.partial && existing) {
        next = Object.assign({}, existing);
        if (typeof body.current === 'number') next.current = body.current;
        if (typeof body.published === 'boolean') next.published = body.published;
      } else {
        // Полная перезапись. Минимальная валидация.
        next = {
          title: String(body.title || '').trim(),
          target: Number(body.target) || 0,
          current: Number(body.current) || 0,
          unit: String(body.unit || '₸').trim(),
          deadline: String(body.deadline || '').trim(),
          why: String(body.why || '').trim(),
          published: body.published === true,
          started_at: (existing && existing.started_at) || (body.started_at || new Date().toISOString().slice(0,10))
        };
      }
      next.updated_at = Date.now();
      next.updated_by = String(body.updated_by || '').trim() || null;

      // v447: история значений current. Пишем точку только если current реально поменялся,
      // чтобы не плодить дубли (сохранение «зачем» или unit не должно засорять график).
      // Trim до 50 последних точек — KV не пухнет, для квартала достаточно.
      next.history = prevHistory.slice();
      const currentChanged = typeof next.current === 'number' && next.current !== prevCurrent;
      if (currentChanged) {
        next.history.push({ at: next.updated_at, value: next.current });
        if (next.history.length > 50) next.history = next.history.slice(-50);
      }

      await kvSet(KV_KEY, next);
      return res.status(200).json({ ok: true, wig: next });
    }

    return res.status(405).json({ ok: false, error: 'method not allowed' });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message || String(e) });
  }
}
