// /api/planning-init — одноразовая инициализация KV с дефолтными спринтами.
// Просто открой URL в браузере: https://salesdoc-app.vercel.app/api/planning-init
// Если KV пустой — заполнит. Если уже есть данные — НЕ перетрёт (нужен ?force=1).

import { checkAdminToken } from './_auth.js';

const KV_KEY = 'planning_v1';

function kvEnv() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return { url, token };
}

async function kvGet(key) {
  const { url, token } = kvEnv();
  const r = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!r.ok) throw new Error(`KV GET ${r.status}`);
  const j = await r.json();
  return j && j.result ? j.result : null;
}

async function kvSet(key, value) {
  const { url, token } = kvEnv();
  const body = typeof value === 'string' ? value : JSON.stringify(value);
  const r = await fetch(`${url}/set/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body
  });
  if (!r.ok) throw new Error(`KV SET ${r.status}`);
  return true;
}

const DEFAULT_SPRINTS = [
  { id:1, name:'Внедрение Гризли', goal:'Полное внедрение SalesDoc для 1150 пользователей с интеграцией 1С', start:'2026-05-04', end:'2026-05-17', status:'ontrack', color:'gold', total:12, in_progress:3, done:5, team:[{n:'АО',c:'#F59E0B'},{n:'С',c:'#AB47BC'},{n:'МЫ',c:'#3B82F6'}], teamNames:'Айдос, Самат, Мырзахыт', archived:false },
  { id:2, name:'Курс Академия ТП — запуск', goal:'8 модулей упаковать, лендинг + лид-магниты, набор первой группы', start:'2026-05-01', end:'2026-05-14', status:'atrisk', color:'purple', total:10, in_progress:2, done:3, team:[{n:'МЫ',c:'#AB47BC'},{n:'Ю',c:'#10B981'}], teamNames:'Мырзахыт, Юлия', archived:false },
  { id:3, name:'Лендинг SalesDoc v2', goal:'Финальная версия: hero-орбита, секции Features, анимация', start:'2026-05-04', end:'2026-05-17', status:'ontrack', color:'blue', total:8, in_progress:2, done:4, team:[{n:'МЫ',c:'#3B82F6'}], teamNames:'Мырзахыт', archived:false },
  { id:4, name:'Бот @fmcgsng_sales — деплой', goal:'Загрузить код, подключить Railway, env, протестировать 3 роли', start:'2026-05-04', end:'2026-05-17', status:'ontrack', color:'green', total:6, in_progress:1, done:2, team:[{n:'МЫ',c:'#10B981'}], teamNames:'Мырзахыт', archived:false }
];

const DEFAULT_TASKS = [
  { id:101, sprint_id:1, title:'Подписан договор и предоплата', owner:'Мырзахыт', points:2, status:'done' },
  { id:102, sprint_id:1, title:'Создание учётной записи и тарифа', owner:'Айдос', points:1, status:'done' },
  { id:103, sprint_id:1, title:'Карта структуры дистрибьютора', owner:'Самат', points:3, status:'done' },
  { id:104, sprint_id:1, title:'Импорт базы клиентов (4200 ТТ)', owner:'Айдос', points:5, status:'done' },
  { id:105, sprint_id:1, title:'Установка приложения на 50 устройств', owner:'Самат', points:3, status:'done' },
  { id:106, sprint_id:1, title:'Интеграция API 1С — настройка обмена', owner:'Айдос', points:8, status:'progress' },
  { id:107, sprint_id:1, title:'Обучение супервайзеров (12 человек)', owner:'Самат', points:5, status:'progress' },
  { id:108, sprint_id:1, title:'Настройка ролей и прав доступа', owner:'Айдос', points:3, status:'progress' },
  { id:109, sprint_id:1, title:'Перенос остатков 1С → SalesDoc', owner:'Айдос', points:5, status:'todo' },
  { id:110, sprint_id:1, title:'Настройка маршрутов ТП по регионам', owner:'Самат', points:3, status:'todo' },
  { id:111, sprint_id:1, title:'Импорт прайс-листа (8000 SKU)', owner:'Айдос', points:2, status:'todo' },
  { id:112, sprint_id:1, title:'Финальная сдача проекта', owner:'Мырзахыт', points:2, status:'todo' }
];

function html(status, body) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Planning Init</title>
<style>body{font-family:system-ui;padding:40px;max-width:600px;margin:0 auto;background:#0a0a0a;color:#fff}
h1{font-size:18px;margin:0 0 12px}
.s{padding:14px 16px;border-radius:10px;margin-bottom:14px;font-size:14px;line-height:1.5}
.ok{background:rgba(16,185,129,.1);border:1px solid rgba(16,185,129,.3);color:#10B981}
.warn{background:rgba(245,158,11,.1);border:1px solid rgba(245,158,11,.3);color:#F59E0B}
.err{background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.3);color:#EF4444}
a{color:#60A5FA;text-decoration:none} a:hover{text-decoration:underline}
pre{background:rgba(255,255,255,.04);padding:12px;border-radius:8px;overflow:auto;font-size:11px}</style>
</head><body><h1>SalesDoc — Planning KV Init</h1>${body}</body></html>`;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  const { url: kvUrl, token: kvToken } = kvEnv();
  if (!kvUrl || !kvToken) {
    return res.status(503).send(html(503, `<div class="err">KV не подключён. Vercel → Storage → Create Database → KV.</div>`));
  }

  const force = req.query && (req.query.force === '1' || req.query.force === 'true');
  const clear = req.query && (req.query.clear === '1' || req.query.clear === 'true');

  // v592 SEC: деструктивные clear/force (стирают общие планёрки) — только с админ-кодом.
  if (force || clear) {
    const g = checkAdminToken(req);
    if (!g.ok) return res.status(g.unconfigured ? 503 : 403).send(html(g.unconfigured ? 503 : 403, '<div class="err">Нужен админ-код (заголовок x-admin-token) для clear/force.</div>'));
  }

  try {
    const current = await kvGet(KV_KEY);
    let parsed = null;
    try { parsed = current ? (typeof current === 'string' ? JSON.parse(current) : current) : null; } catch {}

    // Режим очистки: пишем пустое состояние с updated_at:0, чтобы следующий
    // planSyncFetch посчитал serverEmpty=true и залил данные из localStorage.
    if (clear) {
      const emptyState = { sprints: [], tasks: [], retros: [], updated_at: 0, updated_by: 'planning-init-clear' };
      await kvSet(KV_KEY, JSON.stringify(emptyState));
      return res.status(200).send(html(200, `
        <div class="ok">Готово. KV очищен. Сейчас там пусто.</div>
        <p>Дальше: открой <a href="/">приложение</a> → «Планёрки». Твои локальные данные автоматически уйдут в облако (увидишь зелёный бейдж «Синхронизировано»).</p>
        <p>После этого попроси других пользователей сделать <code>Ctrl+Shift+R</code> или открыть <a href="/api/reset">/api/reset</a> — они увидят твои спринты.</p>
      `));
    }

    const hasData = parsed && parsed.updated_at && Array.isArray(parsed.sprints) && parsed.sprints.length > 0;

    if (hasData && !force) {
      return res.status(200).send(html(200, `
        <div class="warn">В KV уже есть данные (${parsed.sprints.length} спринт(ов), updated_at: ${new Date(parsed.updated_at).toLocaleString('ru-RU')}). Не перезаписываю.</div>
        <p>Чтобы принудительно перезаписать дефолтами:<br><a href="/api/planning-init?force=1">/api/planning-init?force=1</a></p>
        <p>Чтобы очистить KV (и потом залить свои данные через приложение):<br><a href="/api/planning-init?clear=1">/api/planning-init?clear=1</a></p>
        <p>Текущее содержимое:</p><pre>${JSON.stringify(parsed, null, 2).slice(0, 2000)}</pre>
        <p><a href="/">Назад в приложение</a></p>
      `));
    }

    const next = {
      sprints: DEFAULT_SPRINTS,
      tasks: DEFAULT_TASKS,
      retros: [],
      updated_at: Date.now(),
      updated_by: 'planning-init'
    };
    await kvSet(KV_KEY, JSON.stringify(next));

    return res.status(200).send(html(200, `
      <div class="ok">Готово. KV заполнен ${DEFAULT_SPRINTS.length} спринтами и ${DEFAULT_TASKS.length} задачами.</div>
      <p>Теперь открой <a href="/">приложение</a>, перейди в «Планёрки» — должны быть видны спринты с зелёным бейджем «Синхронизировано».</p>
    `));
  } catch (e) {
    return res.status(500).send(html(500, `<div class="err">Ошибка: ${String(e && e.message || e)}</div>`));
  }
}
