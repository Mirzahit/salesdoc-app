// /api/4dx — модуль 4 дисциплин исполнения Кови (4DX) для команды SalesDoc.
// Все 5 сущностей через один endpoint по образцу api/cards.js:
//   ?entity=goals|metrics|entries|sessions|commitments|board|analytics
// Все данные в Vercel KV. 5 раздельных ключей вместо одного — атомарность и точечные PATCH.
//
// Иерархия целей: year → quarter → month → week (4 уровня).
// Каждая сущность имеет country: 'KZ' | 'KG'.

import { checkAuth } from './_auth.js';

// Кто может править цели/показатели/сессии (CEO + руководители).
// Резолв своих обязательств и ввод entries — для всех залогиненных.
const FDX_EDITOR_EMAILS = (process.env.FDX_EDITOR_EMAILS || process.env.WIG_EDITOR_EMAILS || 'office@salesdoc.io')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

const KV_KEYS = {
  goals:       '4dx:goals:v1',
  metrics:     '4dx:metrics:v1',
  entries:     '4dx:entries:v1',
  sessions:    '4dx:sessions:v1',
  commitments: '4dx:commitments:v1'
};

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

// Чтение списка (всегда массив, даже если пусто).
async function readList(entity) {
  if (entity === 'goals') await ensureMigratedFromWigV1();
  const raw = await kvGet(KV_KEYS[entity]);
  if (!raw) return [];
  return Array.isArray(raw) ? raw : [];
}

// Миграция старой одной цели wig_v1 → первая цель в новом формате.
// Делаем один раз: если 4dx:goals:v1 пуст и есть wig_v1 — конвертируем.
// Старый ключ физически НЕ удаляем (страховка на 1 релиз).
async function ensureMigratedFromWigV1() {
  const existing = await kvGet(KV_KEYS.goals);
  if (existing) return; // уже мигрировали или уже есть цели
  const old = await kvGet('wig_v1');
  if (!old || !old.title) return; // нечего мигрировать
  const migrated = [{
    id: 'g_migrated_' + Date.now(),
    country: 'KZ', // старая цель «50 встреч» — KZ-цель
    type: 'year',
    parent_id: null,
    title: String(old.title || ''),
    target: Number(old.target) || 0,
    current: Number(old.current) || 0,
    unit: String(old.unit || '₸'),
    period_start: String(old.started_at || new Date().toISOString().slice(0,10)),
    period_end: String(old.deadline || ''),
    why: String(old.why || ''),
    published: old.published === true,
    history: Array.isArray(old.history) ? old.history.slice(-50) : [],
    created_at: Date.now(),
    updated_at: Number(old.updated_at) || Date.now(),
    updated_by: String(old.updated_by || ''),
    _migrated_from: 'wig_v1'
  }];
  await kvSet(KV_KEYS.goals, migrated);
}

function genId(prefix) {
  return prefix + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  return new Promise((resolve) => {
    let chunks = '';
    req.on('data', c => chunks += c);
    req.on('end', () => { try { resolve(JSON.parse(chunks || '{}')); } catch { resolve({}); } });
  });
}

// Светофор для опережающего: factPct vs timePct в текущем периоде.
function periodBoundsForMetric(period, now) {
  // v663: границы дня/недели считаем в UTC — entry.date хранится как toISOString().slice(0,10)
  // (UTC-полночь), а Date.parse(e.date) тоже парсит как UTC. Раньше границы строились в
  // локальном времени сервера → на non-UTC сервере записи попадали не в тот день/неделю.
  const d = new Date(now);
  if (period === 'day') {
    const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    return { start, end: start + 86400000 - 1 };
  }
  // week — понедельник 00:00 → воскресенье 23:59 в UTC
  const dow = (d.getUTCDay() + 6) % 7; // 0 = понедельник
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow);
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
  return { color, fact, target, factPct, timePct };
}

// Точка входа.
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!checkAuth(req, res)) return;

  const { url: kvUrl, token: kvToken } = kvEnv();
  if (!kvUrl || !kvToken) return res.status(503).json({ ok: false, error: 'KV_NOT_CONFIGURED' });

  const entity = String(req.query.entity || '').toLowerCase();
  const country = String(req.query.country || '').toUpperCase();

  try {
    // ===== GET =====
    if (req.method === 'GET') {
      // Сводка для Табло — один запрос вместо трёх (board)
      if (entity === 'board') {
        const [goals, metrics, entries, sessions] = await Promise.all([
          readList('goals'), readList('metrics'), readList('entries'), readList('sessions')
        ]);
        const inCountry = (x) => !country || x.country === country;
        const yearGoals = goals.filter(g => g.type === 'year' && g.published === true && inCountry(g));
        const activeMetrics = metrics.filter(m => m.active !== false && inCountry(m));
        const metricLights = activeMetrics.map(m => ({ metric: m, light: trafficLight(m, entries) }));
        const nextSession = sessions
          .filter(s => inCountry(s) && s.status !== 'done' && s.scheduled_at)
          .sort((a, b) => Date.parse(a.scheduled_at) - Date.parse(b.scheduled_at))[0] || null;
        return res.status(200).json({
          ok: true,
          board: {
            year_goals: yearGoals,
            sub_goals: goals.filter(g => yearGoals.some(y => g.parent_id === y.id || g._chain_year === y.id)),
            metric_lights: metricLights,
            next_session: nextSession
          }
        });
      }

      // Аналитика — отдельная ветка
      if (entity === 'analytics') {
        const kind = String(req.query.kind || '').toLowerCase();
        if (kind === 'commitments_by_person') {
          const commitments = await readList('commitments');
          const from = req.query.from ? Date.parse(req.query.from) : 0;
          const to = req.query.to ? Date.parse(req.query.to) : Date.now();
          const byOwner = {};
          commitments.filter(c => (!country || c.country === country)).forEach(c => {
            const t = c.created_at || 0;
            if (t < from || t > to) return;
            const o = String(c.owner || '—');
            byOwner[o] = byOwner[o] || { owner: o, done: 0, total: 0 };
            byOwner[o].total++;
            if (c.status === 'done') byOwner[o].done++;
          });
          const rows = Object.values(byOwner).map(r => ({ ...r, pct: r.total ? Math.round(r.done * 100 / r.total) : 0 }));
          rows.sort((a, b) => b.pct - a.pct);
          return res.status(200).json({ ok: true, rows });
        }
        if (kind === 'metrics_traffic') {
          const [metrics, entries] = await Promise.all([readList('metrics'), readList('entries')]);
          const rows = metrics
            .filter(m => m.active !== false && (!country || m.country === country))
            .map(m => ({ metric_id: m.id, title: m.title, ...trafficLight(m, entries) }));
          return res.status(200).json({ ok: true, rows });
        }
        return res.status(400).json({ ok: false, error: 'unknown analytics kind' });
      }

      // CRUD по списку
      if (!KV_KEYS[entity]) return res.status(400).json({ ok: false, error: 'unknown entity' });
      const list = await readList(entity);
      const id = req.query.id;
      if (id) {
        const item = list.find(x => x.id === id);
        return res.status(200).json({ ok: true, [entity.slice(0, -1)]: item || null });
      }
      // Фильтрация
      let filtered = country ? list.filter(x => x.country === country) : list.slice();
      if (req.query.parent_id) filtered = filtered.filter(x => x.parent_id === req.query.parent_id);
      if (req.query.type) filtered = filtered.filter(x => x.type === req.query.type);
      if (req.query.published === 'true') filtered = filtered.filter(x => x.published === true);
      if (req.query.status) filtered = filtered.filter(x => x.status === req.query.status);
      if (req.query.team) filtered = filtered.filter(x => x.team === req.query.team);
      if (req.query.goal_id) filtered = filtered.filter(x => x.goal_id === req.query.goal_id);
      if (req.query.metric_id) filtered = filtered.filter(x => x.metric_id === req.query.metric_id);
      if (req.query.session_id) filtered = filtered.filter(x => x.session_id === req.query.session_id);
      return res.status(200).json({ ok: true, [entity]: filtered, count: filtered.length });
    }

    // ===== POST =====
    if (req.method === 'POST') {
      const body = await readBody(req);
      const action = String(body.action || 'upsert').toLowerCase();
      const ent = String(body.entity || entity).toLowerCase();
      const email = String(body.updated_by_email || '').trim().toLowerCase();
      const user = String(body.updated_by || '').trim();

      // Resolve commitments — может любой залогиненный, но только своё
      if (action === 'resolve_commitment') {
        const id = String(body.id || '');
        const newStatus = body.status === 'done' ? 'done' : (body.status === 'failed' ? 'failed' : 'pending');
        const list = await readList('commitments');
        const idx = list.findIndex(x => x.id === id);
        if (idx < 0) return res.status(404).json({ ok: false, error: 'commitment not found' });
        const c = list[idx];
        const isEditor = email && FDX_EDITOR_EMAILS.indexOf(email) !== -1;
        const isOwner = c.owner && user && c.owner === user;
        if (!isEditor && !isOwner) return res.status(403).json({ ok: false, error: 'не своё обязательство' });
        c.status = newStatus;
        c.resolved_at = Date.now();
        c.resolved_by = user;
        if (body.completion_note) c.completion_note = String(body.completion_note);
        list[idx] = c;
        await kvSet(KV_KEYS.commitments, list);
        return res.status(200).json({ ok: true, commitment: c });
      }

      // Ввод факта (entries) — расширенный whitelist, чтобы операторы тоже могли
      if (ent === 'entries' && action === 'upsert') {
        if (!email) return res.status(403).json({ ok: false, error: 'нужен email' });
        const list = await readList('entries');
        const payload = body.payload || {};
        let entry;
        if (payload.id) {
          const idx = list.findIndex(x => x.id === payload.id);
          if (idx < 0) return res.status(404).json({ ok: false, error: 'entry not found' });
          entry = Object.assign({}, list[idx], payload);
          list[idx] = entry;
        } else {
          entry = {
            id: genId('e'),
            country: String(payload.country || country || 'KZ').toUpperCase(),
            metric_id: String(payload.metric_id || ''),
            date: String(payload.date || new Date().toISOString().slice(0, 10)),
            value: Number(payload.value) || 0,
            author: user,
            note: String(payload.note || ''),
            created_at: Date.now()
          };
          if (!entry.metric_id) return res.status(400).json({ ok: false, error: 'metric_id обязателен' });
          list.push(entry);
        }
        await kvSet(KV_KEYS.entries, list);
        return res.status(200).json({ ok: true, entry });
      }

      // Полное удаление entry — тоже расширенный whitelist
      if (ent === 'entries' && action === 'delete') {
        const id = String(body.id || '');
        const list = await readList('entries');
        const filtered = list.filter(x => x.id !== id);
        await kvSet(KV_KEYS.entries, filtered);
        return res.status(200).json({ ok: true });
      }

      // Остальные правки — только для CEO/руководителей
      if (!email || FDX_EDITOR_EMAILS.indexOf(email) === -1) {
        return res.status(403).json({ ok: false, error: 'Только CEO/руководитель может править этот раздел.' });
      }

      if (action === 'complete_session') {
        const id = String(body.id || '');
        const list = await readList('sessions');
        const idx = list.findIndex(x => x.id === id);
        if (idx < 0) return res.status(404).json({ ok: false, error: 'session not found' });
        list[idx].status = 'done';
        list[idx].completed_at = Date.now();
        if (body.notes) list[idx].notes = String(body.notes);
        await kvSet(KV_KEYS.sessions, list);
        return res.status(200).json({ ok: true, session: list[idx] });
      }

      if (action === 'recalc_goal') {
        const id = String(body.id || '');
        const [goals, metrics, entries] = await Promise.all([
          readList('goals'), readList('metrics'), readList('entries')
        ]);
        const idx = goals.findIndex(g => g.id === id);
        if (idx < 0) return res.status(404).json({ ok: false, error: 'goal not found' });
        // Сумма entries по всем метрикам этой цели за период цели
        const goalMetricIds = metrics.filter(m => m.goal_id === id).map(m => m.id);
        const periodStart = Date.parse(goals[idx].period_start || '1970-01-01');
        const periodEnd = Date.parse(goals[idx].period_end || '2099-12-31');
        const total = entries
          .filter(e => goalMetricIds.indexOf(e.metric_id) !== -1 && Date.parse(e.date) >= periodStart && Date.parse(e.date) <= periodEnd)
          .reduce((s, e) => s + (Number(e.value) || 0), 0);
        goals[idx].current = total;
        goals[idx].updated_at = Date.now();
        goals[idx].updated_by = user;
        await kvSet(KV_KEYS.goals, goals);
        return res.status(200).json({ ok: true, goal: goals[idx] });
      }

      // Универсальный upsert для goals/metrics/sessions/commitments
      if (action === 'upsert') {
        if (!KV_KEYS[ent]) return res.status(400).json({ ok: false, error: 'unknown entity for upsert' });
        const list = await readList(ent);
        const payload = body.payload || {};
        let item;
        if (payload.id) {
          const idx = list.findIndex(x => x.id === payload.id);
          if (idx < 0) return res.status(404).json({ ok: false, error: ent + ' not found' });
          item = Object.assign({}, list[idx], payload, {
            updated_at: Date.now(),
            updated_by: user
          });
          // Для goals — записываем history если current поменялся
          if (ent === 'goals' && typeof payload.current === 'number' && payload.current !== list[idx].current) {
            const hist = Array.isArray(list[idx].history) ? list[idx].history.slice() : [];
            hist.push({ at: Date.now(), value: payload.current });
            item.history = hist.slice(-50);
          }
          list[idx] = item;
        } else {
          // Создание
          const prefix = ent === 'goals' ? 'g' : ent === 'metrics' ? 'm' : ent === 'sessions' ? 's' : 'c';
          item = Object.assign({
            id: genId(prefix),
            country: String(payload.country || country || 'KZ').toUpperCase(),
            created_at: Date.now(),
            updated_at: Date.now(),
            updated_by: user
          }, payload);
          // Для goals дефолтное поле history
          if (ent === 'goals' && !item.history) item.history = [];
          // Для sessions — статус по умолчанию
          if (ent === 'sessions' && !item.status) item.status = 'planned';
          // Для commitments — статус по умолчанию
          if (ent === 'commitments' && !item.status) item.status = 'pending';
          list.push(item);
        }
        await kvSet(KV_KEYS[ent], list);
        return res.status(200).json({ ok: true, [ent.slice(0, -1)]: item });
      }

      if (action === 'delete') {
        if (!KV_KEYS[ent]) return res.status(400).json({ ok: false, error: 'unknown entity for delete' });
        const id = String(body.id || '');
        const list = await readList(ent);
        const filtered = list.filter(x => x.id !== id);
        await kvSet(KV_KEYS[ent], filtered);
        return res.status(200).json({ ok: true });
      }

      return res.status(400).json({ ok: false, error: 'unknown action: ' + action });
    }

    return res.status(405).json({ ok: false, error: 'method not allowed' });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message || String(e) });
  }
}
