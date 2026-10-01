// Локальный предпросмотр раздела «Маркетинг» (v1015) — без пароля и без ключей.
//
// Зачем: новый экран Маркетинга нужно показать CEO до пуша, а на проде пока старый сервер.
// Этот сервер:
//   • отдаёт файлы этой папки (index.html и т.д.) и сам входит в программу под владельцем
//     (вставляет в страницу вызов _enterAppAsCurrentUser) и открывает Маркетинг;
//   • GET /api/* проксирует на прод (только чтение: любой не-GET получает 405);
//   • подгоняет ответы старого сервера под новый формат (v=2):
//       - /api/amo?action=lead_report: у сделок нет product → 'SD', нет qual_stage → ищем этап
//         «Квалификация пройдена» по названию;
//       - /api/meta-ads geo / geo_daily / campaigns_geo с &product=Z24|SHTURM|SD: старый сервер
//         продукт не знает, поэтому делим ПРИБЛИЗИТЕЛЬНО — кампании по названию/номеру
//         (как в настройке mkt_products), страны и дни — по доле расхода этих кампаний.
//         Это только для показа экрана, настоящие цифры по продукту считает новый сервер;
//   • сбои для проверки экрана: откройте страницу с ?mock=meta_token | amo_auth | truncated
//     (значение читается из Referer запроса, странице знать о нём не нужно).
//
// Запуск: node scripts/preview-mkt.mjs [папка] [порт]   (или .claude/launch.json → mkt-preview)
// Потом открыть http://localhost:4181  (сбой ключа рекламы: http://localhost:4181/?mock=meta_token)

import http from 'http';
import https from 'https';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(process.argv[2] || path.join(HERE, '..'));
const PORT = Number(process.argv[3] || 4181);
const UPSTREAM = 'salesdoc-app.vercel.app';
const OWNER = 'office@salesdoc.io';

// Токен приложения берём из самого index.html (тот же, что видит браузер), в лог не пишем.
const INDEX = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const tm = INDEX.match(/window\._APP_TOKEN\s*=\s*window\._APP_TOKEN\s*\|\|\s*'([^']+)'/);
if (!tm) { console.error('не нашёл window._APP_TOKEN в index.html'); process.exit(1); }
const TOKEN = tm[1];

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };

// Вход без пароля: только в этом локальном сервере, в репозиторий не попадает.
const ENTER = `<script>/* preview-mkt: вход под владельцем */
(function(){
  function go(){
    try {
      if (typeof currentUser !== 'undefined' && currentUser) return;
      currentUser = _empWithAccess({ id: 'preview-owner', email: '${OWNER}', name: 'Мирзахит', role: 'admin' });
      _enterAppAsCurrentUser();
      var v = new URLSearchParams(location.search).get('view') || 'marketing';
      setTimeout(function(){ try { showView(v); } catch(e){ console.warn('preview: showView', e); } }, 300);
    } catch(e){ console.warn('preview: вход не удался', e); }
  }
  if (document.readyState === 'complete') setTimeout(go, 800); else window.addEventListener('load', function(){ setTimeout(go, 800); });
})();
</script>`;

// Продукт кампании — те же правила, что в спеке: префикс названия, потом номера, иначе SD.
const PRODUCTS = [
  { code: 'Z24', campaign_ids: ['120251108502780444'] },
  { code: 'SHTURM', campaign_ids: ['120251202836020444'] },
  { code: 'SD', campaign_ids: [] },
];
function campProduct(c) {
  const m = String(c.name || '').match(/^(SHTURM|Z24|SD)([_\s-]|$)/i);
  if (m) return m[1].toUpperCase();
  const id = String(c.id || '');
  for (const p of PRODUCTS) if (p.campaign_ids.includes(id)) return p.code;
  return 'SD';
}

function mockOf(req) {
  try { return new URL(req.headers.referer || '', 'http://localhost').searchParams.get('mock') || ''; } catch (_) { return ''; }
}

function upstreamGet(p) {
  return new Promise((resolve, reject) => {
    https.get({ hostname: UPSTREAM, path: p, headers: { 'x-app-token': TOKEN, 'x-user-email': OWNER, 'accept': 'application/json' } }, (r) => {
      const chunks = []; r.on('data', c => chunks.push(c));
      r.on('end', () => resolve({ status: r.statusCode, type: r.headers['content-type'] || 'application/json', body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}
function sendJson(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}

// Доля продукта по странам из campaigns_geo (тот же период и исключения).
async function productShare(url, product) {
  const u = new URL(url.toString());
  u.searchParams.set('endpoint', 'campaigns_geo');
  const r = await upstreamGet(u.pathname + u.search);
  const j = JSON.parse(r.body.toString('utf8'));
  const tot = {}, mine = {};
  (j.campaigns || []).forEach(c => {
    const ok = campProduct(c) === product;
    Object.entries(c.by_country || {}).forEach(([cc, b]) => {
      const t = tot[cc] || (tot[cc] = { spend: 0, leads: 0 }); t.spend += b.spend || 0; t.leads += b.leads || 0;
      if (ok) { const m = mine[cc] || (mine[cc] = { spend: 0, leads: 0 }); m.spend += b.spend || 0; m.leads += b.leads || 0; }
    });
  });
  const share = {};
  Object.keys(tot).forEach(cc => {
    const t = tot[cc], m = mine[cc] || { spend: 0, leads: 0 };
    share[cc] = { spend: t.spend > 0 ? m.spend / t.spend : 0, leads: t.leads > 0 ? m.leads / t.leads : (t.spend > 0 ? m.spend / t.spend : 0) };
  });
  return share;
}
function scaleRow(row, sh) {
  if (!row || !sh) return row;
  const k = sh.spend;
  ['spend', 'impressions', 'clicks', 'link_clicks', 'reach', 'msgs'].forEach(f => { if (typeof row[f] === 'number') row[f] = f === 'spend' ? Math.round(row[f] * k * 100) / 100 : Math.round(row[f] * k); });
  if (typeof row.leads === 'number') row.leads = Math.round(row.leads * sh.leads);
  if (typeof row.cpl !== 'undefined') row.cpl = row.leads > 0 ? Math.round(row.spend / row.leads * 100) / 100 : null;
  return row;
}

async function adapt(url, j) {
  const action = url.searchParams.get('action');
  const endpoint = url.searchParams.get('endpoint');
  const product = url.searchParams.get('product') || 'ALL';
  if (url.pathname === '/api/amo' && action === 'lead_report' && j && Array.isArray(j.leads)) {
    j.leads.forEach(l => { if (!l.product) l.product = 'SD'; });
    if (!j.qual_stage) {
      const st = (j.stages || []).find(s => /квалификац.*пройден/i.test(String(s.name)));
      if (st) j.qual_stage = { id: st.id, name: st.name, sort: st.sort };
    }
  }
  if (url.pathname === '/api/meta-ads' && product !== 'ALL' && j && !j.error && !j.product) {
    if (endpoint === 'campaigns_geo') {
      j.campaigns = (j.campaigns || []).filter(c => campProduct(c) === product);
    } else if (endpoint === 'geo' || endpoint === 'geo_daily') {
      const share = await productShare(url, product);
      if (endpoint === 'geo') {
        (j.countries || []).forEach(c => scaleRow(c, share[c.code]));
        (j.accounts || []).forEach(a => {
          let sp = 0, ld = 0;
          Object.entries(a.by_country || {}).forEach(([cc, b]) => { scaleRow(b, share[cc]); sp += b.spend || 0; ld += b.leads || 0; });
          if (a.by_country) { a.spend = Math.round(sp * 100) / 100; a.leads = ld; }
        });
      } else {
        (j.days || []).forEach(d => {
          Object.entries(d.by_country || {}).forEach(([cc, b]) => scaleRow(b, share[cc]));
          Object.values(d.by_account || {}).forEach(m => Object.entries(m || {}).forEach(([cc, b]) => scaleRow(b, share[cc])));
        });
      }
    }
    j.product = product;
  }
  return j;
}

async function proxy(req, res) {
  if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'превью: только чтение' });
  const url = new URL(req.url, 'http://localhost');
  const mock = mockOf(req);
  const isMeta = url.pathname === '/api/meta-ads';
  const isAmo = url.pathname === '/api/amo';
  if (mock === 'meta_token' && isMeta) return sendJson(res, 502, { error: 'Error validating access token: Session has expired', code: 'meta_token' });
  if (mock === 'amo_auth' && isAmo) return sendJson(res, 502, { error: 'amoCRM 401 Unauthorized', code: 'amo_auth' });
  try {
    const r = await upstreamGet(url.pathname + url.search);
    if ((isAmo || isMeta) && /json/.test(r.type)) {
      let j; try { j = JSON.parse(r.body.toString('utf8')); } catch (_) { j = null; }
      if (j) {
        j = await adapt(url, j);
        if (mock === 'truncated' && isAmo && url.searchParams.get('action') === 'lead_report') {
          j.incomplete = (j.incomplete || []).concat([{ source: 'amo', what: 'leads', detail: 'показаны первые 3000' }]);
        }
        return sendJson(res, r.status, j);
      }
    }
    res.writeHead(r.status, { 'content-type': r.type, 'cache-control': 'no-store' });
    res.end(r.body);
  } catch (e) {
    sendJson(res, 502, { ok: false, error: String(e && e.message || e) });
  }
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) return proxy(req, res);
  // свой service worker в превью не нужен — иначе он закэширует страницу
  if (url.pathname === '/sw.js') { res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' }); return res.end("self.addEventListener('install',function(){self.skipWaiting();});"); }
  let p = decodeURIComponent(url.pathname); if (p === '/') p = '/index.html';
  const file = path.join(ROOT, p);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' });
  if (p === '/index.html') {
    const html = fs.readFileSync(file, 'utf8');
    const i = html.lastIndexOf('</body>');
    return res.end(i >= 0 ? html.slice(0, i) + ENTER + html.slice(i) : html + ENTER);
  }
  fs.createReadStream(file).pipe(res);
}).listen(PORT, () => console.log('Маркетинг: предпросмотр на http://localhost:' + PORT + '  (сбои: ?mock=meta_token | amo_auth | truncated)'));
