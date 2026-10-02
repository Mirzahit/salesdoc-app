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
//   • v1017 (этап Б): новых действий сервера на проде ещё нет — отвечаем образцами из макета
//     (docs/design/marketing, класс DCLogic): mkt_recon, mkt_work, mkt_lost_close (POST, эхо ok),
//     настройка work_holidays (GET/PATCH в памяти), лишние поля lead_report (ответственный,
//     дата входа в этап, причина отказа). «Кто взял» строится из настоящего lead_report того же
//     периода: сделки на первом этапе — «не взяты». Доп. сбои: ?mock=lost_close_401 (нужен вход),
//     ?mock=old (старый сервер: новых действий нет), ?mock=untrusted (телефоны скрыты, pii:false).
//     ?mock=backfill_done — переписки за сентябрь уже размечены (подпись про цену квала пропадает).
//     ?mock=preview_readonly — запись отвечает code preview_readonly (как превью Vercel).
//     Настройки wa_autoreply_templates и work_holidays хранятся в памяти сервера превью.
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
  const url = new URL(req.url, 'http://localhost');
  const mock = mockOf(req);
  const fx = await fixture(req, url, mock);
  if (fx) return sendJson(res, fx[0], fx[1]);
  if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'превью: только чтение' });
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
        if (isAmo && url.searchParams.get('action') === 'lead_report' && Array.isArray(j.leads)) { enrichLeadReport(j, mock); LR_CACHE.set(lrKey(url), j); }
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

// ── v1017: образцы новых действий сервера (этап Б) ──────────────────────────
// Числа и строки — из макета docs/design/marketing (класс DCLogic): 312 заявок Meta,
// 281 долетело, форма не подключена — 19, пустой номер — 4, дубли — 8; заявки
// «1619…7841», «1056…0930»; менеджеры Амир и Асель; причины «Не ЛПР», «Нет бюджета»…
const LR_CACHE = new Map();
const lrKey = (url) => url.searchParams.get('from') + '|' + url.searchParams.get('to');
const HOLIDAYS = { list: [] };
const WA_TPL = { list: ['Здравствуйте! Спасибо, что написали. Мы скоро ответим.', 'Здравствуйте. Не смогли принять ваш вызов. Но непременно ответим', 'Здравствуйте! Хотите узнать подробнее о решении для управления товар'] };
const CLOSED = new Set();
const OLD_ACTION = { error: 'Unknown action. Use ?action=pipelines | funnel | tag_breakdown' };
const LOSS = ['Не ЛПР', 'Нет бюджета', 'Не дозвонились', 'Не наш профиль', 'Спам, ошибка в номере', null, null, null];
const hashN = (v) => { let h = 7; for (const ch of String(v)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h; };

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = []; req.on('data', c => chunks.push(c));
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (_) { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}
function bkDays(since, until) {
  const out = []; let d = new Date(since + 'T00:00:00Z'); const z = new Date(until + 'T00:00:00Z');
  while (d <= z && out.length < 400) { out.push(d.toISOString().slice(0, 10)); d = new Date(d.getTime() + 86400000); }
  return out;
}
// Лишние поля lead_report v2 (этап Б): ответственный, дата закрытия, дата входа в текущий этап, причина отказа
function enrichLeadReport(j, mock) {
  if (mock === 'old') return;
  const now = Math.floor(Date.now() / 1000);
  j.leads.forEach(l => {
    const h = hashN(l.id);
    l.responsible_user_id = l.manager && l.manager !== '—' ? 1000 + (hashN(l.manager) % 9000) : null;
    l.closed_at = (l.is_won || l.is_lost) ? (l.created || now) + 86400 * (1 + h % 9) : null;
    l.stage_entered_at = (l.is_won || l.is_lost) ? null : Math.max(l.created || 0, now - 86400 * (h % 21));
    if (l.is_lost) { const r = LOSS[h % LOSS.length]; l.loss_reason = r; l.loss_reason_src = r ? 'field' : null; }
    else { l.loss_reason = null; l.loss_reason_src = null; }
    // b2: откуда сделка — как в настоящем сентябре (формы 143, WhatsApp 55, звонки 13, вручную 66)
    if (!l.source_type) {
      const k = h % 211;
      l.source_type = l.origin === 'manual' ? 'manual' : (k < 143 ? 'form' : (k < 198 ? 'chat' : 'call'));
    }
  });
  if (!j.sources) {
    const cnt = (list) => { const o = { form: 0, chat: 0, call: 0, manual: 0 }; list.forEach(l => { if (o[l.source_type] != null) o[l.source_type]++; }); return o; };
    j.sources = cnt(j.leads);
    j.sources_ad = cnt(j.leads.filter(l => l.arrival_kind === 'ad' || l.arrival_kind === 'return'));
  }
}
function reconFixture(url, mock) {
  const since = url.searchParams.get('since'), until = url.searchParams.get('until');
  const product = url.searchParams.get('product') || 'SD';
  const trusted = mock !== 'untrusted';
  const days = bkDays(since, until);
  const by_day = {};
  days.forEach((d, i) => {
    const dow = new Date(d + 'T00:00:00Z').getUTCDay();
    by_day[d] = (dow === 0 || dow === 6) ? { rate: 87.42, src: 'nbkr', from: days[Math.max(0, i - (dow === 6 ? 1 : 2))] } : { rate: Math.round((87.3 + (i % 5) * 0.06) * 100) / 100, src: 'nbkr', from: d };
  });
  const base = [
    ['1619284471937841', '+996700123841', 'SD - август', 'SD_KG_LF_IH_2026-09', 'form_not_connected', 'not_found', 'Айгуль'],
    ['1619377102842406', '+996555220406', 'SD - август', 'SD_KG_LF_IH_2026-09', 'form_not_connected', 'not_found', 'Бакыт'],
    ['1056991200470930', '', 'Cliq', 'Лиды - KG', 'bad_phone', 'bad_phone', 'Эрмек'],
    ['1690412257735445', '+996777318445', 'tokmok', 'SD_KG_SITE_IH_2026-09', 'no_deal', 'not_found', 'Нурлан']
  ];
  const rows = [];
  for (let i = 0; i < 27; i++) {
    const b = base[i] || ['16' + String(19000000000000 + i * 7919337).slice(0, 14), i % 6 === 0 ? '' : '+99655' + String(1000000 + i * 37171).slice(0, 7),
      i % 3 ? 'SD - август' : 'tokmok', i % 3 ? 'SD_KG_LF_IH_2026-09' : 'SD_KG_SITE_IH_2026-09', i % 6 === 0 ? 'bad_phone' : (i < 19 ? 'form_not_connected' : 'no_deal'), i % 6 === 0 ? 'bad_phone' : 'not_found', 'Клиент ' + (i + 1)];
    const day = days[(i * 7) % days.length];
    const hh = 9 + (i * 5) % 12, mm = (i * 13) % 60;
    const created = new Date(day + 'T' + String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0') + ':00+06:00').toISOString();
    const tail = b[1] ? b[1].slice(-9) : '';
    rows.push({ meta_lead_id: b[0], created_time: created, product: i === 5 ? null : 'SD', campaign_name: b[3], form_name: b[2], ad_name: 'Видео ' + (1 + i % 4),
      full_name: b[6], phone: b[1] ? (trusted ? '+' + b[1].replace(/^\+/, '') : '··· ' + b[1].slice(-4)) : '',
      phone_tail: tail.slice(-4), lost_reason: b[4], match_status: b[5], recheck_until: new Date(Date.parse(created) + 14 * 86400000).toISOString(),
      amo_search_url: tail ? 'https://zeidplyus.amocrm.ru/leads/list/?term=' + tail : '' });
  }
  const lost = rows.filter(r => !CLOSED.has(r.meta_lead_id));
  const recon = { meta_total: 312, test: 2, in_amo: { matched: 230, renamed: 30, manual: 21, total: 281 }, duplicates: 8,
    lost: { total: 27, form_not_connected: 19, no_deal: 4, bad_phone: 4 }, lost_pct: 8.7,
    closed: { added_to_amo: CLOSED.size, no_answer: 0, not_our_client: 0 }, not_recognized: 3, other_product: { Z24: 56, SHTURM: 19 },
    pending_new: 2, last_checked_at: new Date(Date.now() - 23 * 60000).toISOString() };
  if (product === 'ALL') { recon.meta_total = 312 + 56 + 19; }
  if (mock === 'recon_empty') { // до первой ночной загрузки: таблица заявок пустая
    return { country: 'KG', since, until, product, trusted, pii: trusted, amo_sub: 'zeidplyus',
      fx: { cur: 'USD', by_day, avg_rate: 87.44, fallback_rate: 87, missing_days: [] },
      recon: { meta_total: 0, test: 0, in_amo: { matched: 0, renamed: 0, manual: 0, total: 0 }, duplicates: 0,
        lost: { total: 0, form_not_connected: 0, no_deal: 0, bad_phone: 0 }, lost_pct: null, closed: {}, not_recognized: 0,
        other_product: { Z24: 0, SHTURM: 0 }, pending_new: 0, last_checked_at: null }, lost: [], errors: [], incomplete: [] };
  }
  return { country: 'KG', since, until, product, trusted, pii: trusted, amo_sub: 'zeidplyus',
    fx: { cur: 'USD', by_day, avg_rate: 87.44, fallback_rate: 87, missing_days: [] },
    recon, lost: (product === 'SD' || product === 'ALL') ? lost : [], errors: [], incomplete: [],
    chat_unmarked_from: '2026-09-09',
    chat_backfill: mock === 'backfill_done' ? { from: '2026-09-01', to: '2026-12-31', done_at: new Date().toISOString() } : null };
}
function workFixture(url) {
  const lr = LR_CACHE.get(lrKey(url));
  const now = Math.floor(Date.now() / 1000);
  const leads = {}, mg = {};
  const WAITS = [9, 51, 311, 650, 1460, 37, 125, 12];
  if (lr) {
    const first = (lr.stages || []).slice().sort((a, b) => a.sort - b.sort)[0];
    let k = 0;
    lr.leads.forEach(l => {
      if (l.origin === 'manual' || l.arrival_kind === 'return') return;
      const h = hashN(l.id);
      const pm = '+996 ' + ['555', '700', '777', '552'][h % 4] + ' ··· ' + String(h % 1000).padStart(3, '0');
      // для показа экрана «не взятыми» считаем и часть открытых сделок (каждую третью), иначе блок часто пуст
      if (!l.is_won && !l.is_lost && ((first && l.status_id === first.id) || h % 3 === 0)) {
        const w = WAITS[k++ % WAITS.length];
        leads[l.id] = { taken_at: null, taken_by: null, taken_by_name: null, taken_kind: null, reaction_wmin: null, wait_wmin: w, tone: w <= 15 ? 'ok' : (w <= 60 ? 'mid' : 'bad'), phone_masked: pm };
      } else {
        const r = l.manager === 'Амир' ? 4 + h % 18 : 20 + h % 55;
        leads[l.id] = { taken_at: new Date(((l.arrival_at || l.created || now) + r * 60) * 1000).toISOString(), taken_by: l.responsible_user_id || null, taken_by_name: l.manager,
          taken_kind: ['status', 'note', 'call', 'task', 'whatsapp'][h % 5], reaction_wmin: r, wait_wmin: null, tone: r <= 15 ? 'ok' : (r <= 60 ? 'mid' : 'bad'), phone_masked: pm };
        const x = mg[l.manager] || (mg[l.manager] = { responsible_user_id: l.responsible_user_id || null, name: l.manager, n: 0, sum: 0 });
        x.n++; x.sum += r;
      }
    });
  }
  const managers = lr ? Object.values(mg).map(x => ({ responsible_user_id: x.responsible_user_id, name: x.name, n: x.n, avg_reaction_wmin: Math.round(x.sum / x.n) }))
    : [{ responsible_user_id: 1, name: 'Амир', n: 142, avg_reaction_wmin: 12 }, { responsible_user_id: 2, name: 'Асель', n: 126, avg_reaction_wmin: 48 }];
  return { country: 'KG', from: Number(url.searchParams.get('from')), to: Number(url.searchParams.get('to')), now,
    work: { start: '09:00', end: '18:00', tz: 6, holidays: HOLIDAYS.list.slice() }, norms: { ok: 15, late: 60 },
    leads, managers, scanned: { leads: Object.keys(leads).length, requests: lr ? 3 : 0 }, errors: [], incomplete: lr ? [] : [{ source: 'amo', what: 'leads', detail: 'превью: сделки периода ещё не загружены' }] };
}
// Возвращает [status, body] или null (тогда запрос идёт на прод как раньше)
async function fixture(req, url, mock) {
  const action = url.searchParams.get('action');
  // как превью-сборка Vercel: любая запись запрещена (пометку сверху страницы включает ?as_preview=1)
  if (mock === 'preview_readonly' && req.method !== 'GET') return [403, { ok: false, error: 'В превью запись отключена', code: 'preview_readonly' }];
  if (url.pathname === '/api/amo' && action === 'mkt_recon' && req.method === 'GET') {
    return mock === 'old' ? [400, OLD_ACTION] : [200, reconFixture(url, mock)];
  }
  if (url.pathname === '/api/amo' && action === 'mkt_work' && req.method === 'GET') {
    return mock === 'old' ? [400, OLD_ACTION] : [200, workFixture(url)];
  }
  if (url.pathname === '/api/amo' && action === 'mkt_lost_close') {
    if (req.method !== 'POST') return [405, { error: 'Only POST' }];
    const body = await readBody(req);
    if (mock === 'old') return [400, OLD_ACTION];
    if (mock === 'lost_close_401') return [401, { ok: false, error: 'Не удалось определить сотрудника — войдите в программу заново', needLogin: true }];
    if (!body.meta_lead_id || !['added_to_amo', 'no_answer', 'not_our_client'].includes(body.resolution)) return [400, { error: 'Нужны meta_lead_id и resolution' }];
    if (CLOSED.has(String(body.meta_lead_id))) return [409, { error: 'Заявку уже разобрали', code: 'conflict' }];
    CLOSED.add(String(body.meta_lead_id));
    console.log('превью: разобрана заявка', body.meta_lead_id, body.resolution, body.note ? '(с комментарием)' : '');
    return [200, { ok: true, meta_lead_id: String(body.meta_lead_id), resolution: body.resolution, resolution_note: String(body.note || '').slice(0, 500), handled_by: OWNER, handled_at: new Date().toISOString() }];
  }
  if (url.pathname === '/api/settings') {
    if (req.method === 'GET' && url.searchParams.get('key') === 'wa_autoreply_templates') {
      return mock === 'old' ? [400, { ok: false, error: 'key должен быть один из: mkt_costs, mkt_products' }] : [200, { ok: true, key: 'wa_autoreply_templates', value: WA_TPL.list.slice() }];
    }
    if (req.method === 'GET' && url.searchParams.get('key') === 'work_holidays') {
      return mock === 'old' ? [400, { ok: false, error: 'key должен быть один из: mkt_costs, mkt_products' }] : [200, { ok: true, key: 'work_holidays', value: HOLIDAYS.list.slice() }];
    }
    if (req.method === 'PATCH') {
      const body = await readBody(req);
      if (body.key !== 'work_holidays' && body.key !== 'wa_autoreply_templates') return [405, { ok: false, error: 'превью: только чтение' }];
      if (mock === 'old') return [400, { ok: false, error: 'key должен быть один из: mkt_costs, mkt_products' }];
      if (body.key === 'wa_autoreply_templates') {
        WA_TPL.list = (Array.isArray(body.value) ? body.value : []).map(x => String(x || '').trim().slice(0, 500)).filter(Boolean).slice(0, 50);
        return [200, { ok: true, key: 'wa_autoreply_templates', value: WA_TPL.list.slice() }];
      }
      const v = Array.isArray(body.value) ? body.value.filter(x => /^\d{4}-\d{2}-\d{2}$/.test(String(x)) && !isNaN(Date.parse(x + 'T00:00:00Z'))) : [];
      HOLIDAYS.list = [...new Set(v)].sort().slice(0, 300);
      return [200, { ok: true, key: 'work_holidays', value: HOLIDAYS.list.slice() }];
    }
  }
  return null;
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
}).listen(PORT, () => console.log('Маркетинг: предпросмотр на http://localhost:' + PORT + '  (сбои: ?mock=meta_token | amo_auth | truncated | lost_close_401 | old | untrusted | preview_readonly | backfill_done)'));
