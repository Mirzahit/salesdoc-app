// Локальный предпросмотр «Финансиста» (v1005) без ключей Supabase.
//
// Зачем: .env.local пуст, превью-деплои Vercel закрыты SSO и без env, а на проде
// новый /api/finansist появится только после пуша в main. Этот сервер:
//   • отдаёт файлы репозитория (index.html и т.д.);
//   • /api/finansist выполняет ЛОКАЛЬНЫМ кодом из api/, но вместо Supabase подставляет
//     снимок данных, который сам скачивает с прода через /api/payments, /api/clients,
//     /api/churn, /api/employees (в папку temp, в репозиторий не попадает);
//   • остальные /api/* проксирует на прод (вход, расходы из Sheets и т.д.).
//
// Запуск: node scripts/preview-finansist.mjs . 4174   (или .claude/launch.json → salesdoc-fz)
// Потом открыть http://localhost:4174 и войти как обычно.

import http from 'http';
import https from 'https';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

const ROOT = path.resolve(process.argv[2] || process.cwd());
const PORT = Number(process.argv[3] || 4174);
const UPSTREAM = 'salesdoc-app.vercel.app';
const TOKEN = 'salesdoc-2026-route-secret-9k3xJ7'; // тот же публичный токен, что в index.html
const OWNER = 'office@salesdoc.io';
const WORK = path.join(os.tmpdir(), 'salesdoc-finansist-preview');
const FIX = path.join(WORK, 'fixtures');
const MOCK = path.join(WORK, 'mock');
fs.mkdirSync(FIX, { recursive: true }); fs.mkdirSync(MOCK, { recursive: true });
process.env.APP_TOKEN = process.env.APP_TOKEN || TOKEN;

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };

function getJson(p) {
  return new Promise((resolve, reject) => {
    https.get({ hostname: UPSTREAM, path: p, headers: { 'x-app-token': TOKEN, 'x-user-email': OWNER } }, (r) => {
      let b = ''; r.on('data', c => b += c); r.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(new Error('bad json from ' + p)); } });
    }).on('error', reject);
  });
}

// Снимок прода: таблица → откуда брать. Обновляется, если файлу больше часа.
const SOURCES = {
  payments: ['/api/payments?country=KG', 'payments'],
  clients: ['/api/clients?country=KG', 'clients'],
  churn_records: ['/api/churn?country=KG&from=2025-01-01&to=2027-12-31', 'records'],
  churn_license_changes: ['/api/churn?country=KG&dataset=licenses', 'records'],
  employees: ['/api/employees', 'employees'],
};
async function ensureFixtures() {
  for (const [t, [p, key]] of Object.entries(SOURCES)) {
    const f = path.join(FIX, t + '.json');
    if (fs.existsSync(f) && Date.now() - fs.statSync(f).mtimeMs < 3600e3) continue;
    const d = await getJson(p);
    if (!d || !d.ok || !Array.isArray(d[key])) throw new Error('не удалось снять ' + t + ': ' + JSON.stringify(d).slice(0, 200));
    fs.writeFileSync(f, JSON.stringify(d[key]));
    console.log('снимок', t, d[key].length, 'строк');
  }
  const a = path.join(FIX, 'employee_access.json');
  if (!fs.existsSync(a) || Date.now() - fs.statSync(a).mtimeMs > 3600e3) {
    const d = await getJson('/api/employee-access');
    fs.writeFileSync(a, JSON.stringify(Object.entries((d && d.access) || {}).map(([email, access]) => ({ email, access }))));
  }
}

const MOCK_SUPABASE = `import fs from 'fs'; import path from 'path';
const D = ${JSON.stringify(FIX)};
function table(t){ const f = path.join(D, t + '.json'); if (!fs.existsSync(f)) throw new Error('нет снимка ' + t); return JSON.parse(fs.readFileSync(f, 'utf8')); }
export async function sbSelect(t, params){
  params = params || {}; let rows = table(t).slice();
  Object.keys(params).forEach(k => { if (['select','order','limit','offset'].includes(k)) return; const m = String(params[k]).match(/^eq\\.(.*)$/); if (m) rows = rows.filter(r => String(r[k]) === m[1]); });
  if (params.order) { const [col, dir] = String(params.order).split(',')[0].split('.'); rows.sort((a,b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0) * (dir === 'desc' ? -1 : 1)); }
  const off = +params.offset || 0, lim = params.limit ? +params.limit : rows.length; rows = rows.slice(off, off + lim);
  if (params.select && params.select !== '*') { const cols = params.select.split(','); rows = rows.map(r => Object.fromEntries(cols.map(c => [c, r[c]]))); }
  return rows;
}
export async function sbSelectAll(t, params){ const p = Object.assign({}, params || {}); delete p.limit; delete p.offset; return sbSelect(t, p); }
export async function sbInsert(){ throw new Error('превью: только чтение'); } export const sbUpsert = sbInsert, sbUpdate = sbInsert, sbDelete = sbInsert, sbInsertIgnoreDup = sbInsert;
`;
fs.writeFileSync(path.join(MOCK, '_supabase.js'), MOCK_SUPABASE);

const LOCAL = { '/api/finansist': 'finansist.js' };
function prepareLocal(name) {
  ['_auth.js', '_session.js', '_caller.js', '_perm.js', '_dates.js', name].forEach(n => fs.copyFileSync(path.join(ROOT, 'api', n), path.join(MOCK, n)));
  return path.join(MOCK, name);
}

function proxy(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) if (k.startsWith('x-user-') || k === 'x-admin-token' || k === 'x-session-token' || k === 'content-type') headers[k] = v;
  headers['x-app-token'] = TOKEN;
  const up = https.request({ hostname: UPSTREAM, path: url.pathname + url.search, method: req.method, headers }, (r) => {
    res.writeHead(r.statusCode, { 'content-type': r.headers['content-type'] || 'application/json' });
    r.pipe(res);
  });
  up.on('error', (e) => { if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: String(e) })); });
  req.pipe(up);
}

async function local(req, res, name) {
  const url = new URL(req.url, 'http://localhost');
  req.query = Object.fromEntries(url.searchParams.entries());
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (o) => { res.setHeader('content-type', 'application/json; charset=utf-8'); res.end(JSON.stringify(o)); return res; };
  res.send = (b) => { res.end(b); return res; };
  try {
    await ensureFixtures();
    const file = prepareLocal(name);
    const mod = await import(pathToFileURL(file).href + '?t=' + Date.now()); // без кэша: правки в api/ видны сразу
    await mod.default(req, res);
  } catch (e) {
    console.error('[local api]', e);
    if (!res.headersSent) res.status(500).json({ ok: false, error: String(e && e.message || e) });
  }
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    const f = LOCAL[url.pathname];
    return f ? local(req, res, f) : proxy(req, res);
  }
  let p = decodeURIComponent(url.pathname); if (p === '/') p = '/index.html';
  const file = path.join(ROOT, p);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(file).pipe(res);
}).listen(PORT, () => console.log('Финансист: предпросмотр на http://localhost:' + PORT + ' (снимок данных в ' + FIX + ')'));
