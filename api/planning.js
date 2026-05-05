// /api/planning — общий стор для Планёрок (спринты, задачи, ретро).
// Хранилище: Vercel KV (Upstash Redis) через REST API — без npm-зависимостей.
// ENV: KV_REST_API_URL, KV_REST_API_TOKEN (Vercel создаёт автоматически при подключении KV).
// Если KV не подключён — отвечаем 503 с понятной ошибкой; фронт остаётся в локальном режиме.

const KV_KEY = 'planning_v1';

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
  const r = await fetch(`${url}/set/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(value)
  });
  if (!r.ok) throw new Error(`KV SET ${r.status}`);
  return true;
}

function emptyState() {
  return { sprints: [], tasks: [], retros: [], updated_at: 0, updated_by: null };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const { url: kvUrl, token: kvToken } = kvEnv();
  if (!kvUrl || !kvToken) {
    return res.status(503).json({ error: 'KV_NOT_CONFIGURED', hint: 'Подключи Vercel KV в Storage → Create Database → KV.' });
  }

  try {
    if (req.method === 'GET') {
      const raw = await kvGet(KV_KEY);
      if (!raw) return res.status(200).json(emptyState());
      let parsed;
      try { parsed = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { parsed = emptyState(); }
      if (!parsed || typeof parsed !== 'object') parsed = emptyState();
      // защита от старых записей без полей
      if (!Array.isArray(parsed.sprints)) parsed.sprints = [];
      if (!Array.isArray(parsed.tasks)) parsed.tasks = [];
      if (!Array.isArray(parsed.retros)) parsed.retros = [];
      if (typeof parsed.updated_at !== 'number') parsed.updated_at = 0;
      return res.status(200).json(parsed);
    }

    if (req.method === 'POST') {
      let body = req.body;
      if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch { body = null; }
      }
      if (!body || typeof body !== 'object') return res.status(400).json({ error: 'BAD_BODY' });

      const sprints = Array.isArray(body.sprints) ? body.sprints : [];
      const tasks = Array.isArray(body.tasks) ? body.tasks : [];
      const retros = Array.isArray(body.retros) ? body.retros : [];
      const clientUpdatedAt = typeof body.client_updated_at === 'number' ? body.client_updated_at : 0;
      const updatedBy = (body.updated_by && String(body.updated_by).slice(0, 64)) || null;

      // Проверка конфликтов: если на сервере свежее, чем то, что видел клиент,
      // не перетираем и просим клиента смержить (пока — клиент просто перечитает).
      const current = await kvGet(KV_KEY);
      let serverState = null;
      try { serverState = current ? (typeof current === 'string' ? JSON.parse(current) : current) : null; } catch {}
      const serverTs = (serverState && typeof serverState.updated_at === 'number') ? serverState.updated_at : 0;
      if (clientUpdatedAt && serverTs && serverTs > clientUpdatedAt) {
        return res.status(409).json({ error: 'CONFLICT', server_updated_at: serverTs });
      }

      const next = {
        sprints, tasks, retros,
        updated_at: Date.now(),
        updated_by: updatedBy
      };
      await kvSet(KV_KEY, JSON.stringify(next));
      return res.status(200).json({ ok: true, updated_at: next.updated_at });
    }

    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'METHOD_NOT_ALLOWED' });
  } catch (e) {
    return res.status(500).json({ error: 'KV_ERROR', message: String(e && e.message || e) });
  }
}
