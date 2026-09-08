// /api/sheets — v924 SEC. Единственная дверь фронта к Google-таблицам через Apps Script.
//
// ЗАЧЕМ. Раньше браузер ходил в Apps Script напрямую, а тот развёрнут «для всех, даже
// анонимных». Ссылка лежала в index.html, значит расходы компании (включая зарплаты
// поимённо) и лист Users с хешами паролей мог скачать кто угодно без входа в программу.
// Теперь ссылка и секрет живут только на сервере, а сервер проверяет права сотрудника.
//
// GET  /api/sheets?action=getSheet&sheet=Август&spreadsheetId=...&range=A1:E1000
// GET  /api/sheets?action=getAvatar&spreadsheetId=<academy>&sheet=Users&userId=7
// POST /api/sheets  { action:'updateAvatar', spreadsheetId:<academy>, sheet:'Users', userId, avatar }
//
// ВАЖНО: после того как в Apps Script появится проверка токена (docs/APPS_SCRIPT_SECURE.md),
// без env SHEETS_TOKEN запросы перестанут проходить — токен задаётся в Vercel.

import { checkAuth } from './_auth.js';
import { requirePerm, PAYMENTS_KEYS } from './_perm.js';

const GS_URL = 'https://script.google.com/macros/s/AKfycbwwNL4CxOrSo4wXT3qci_dSSqi5tABLPUqHQPv2nWrn_WQhZsaOpfnwdygaqskzuHphvg/exec';

// Белый список таблиц: чужую таблицу через прокси не прочитать, право — своё на каждую.
// avatarOnly — таблица Академии: в ней лист Users с хешами паролей, поэтому getSheet по ней запрещён.
const SHEETS = {
  '1TQSgd1rBHmF4mIktKf8Sk3C3OGxfownysqgQwu0IzWM': { name: 'Расходы KZ',  perm: 'view_expenses' },
  '1wJaSorA_jLG7YJJaTT2XXV6j5SSjufutVFOuKsK1tdY': { name: 'Расходы KG',  perm: 'view_expenses' },
  '1WJJRqPvQ_i9jVhQgNc2Kuuynneu9jjTJwMGijCZKHbo': { name: 'Доходы KZ',   perm: PAYMENTS_KEYS },
  '1RbnGDy0rZJj7Ek-j1y3FkAToCSXXtR8F-5a7ga67O2Q': { name: 'Доходы KG',   perm: PAYMENTS_KEYS },
  '1dA_NypMBj2LbmSOn6GuZXcCNCUqN7lmBAs9S5FbgjzU': { name: 'КПИ/План KZ', perm: 'view_plan' },
  '1PJvpQbcWAV4TbkNgXvnlkIQhOgsbleM42oIBkWzqh10': { name: 'КПИ/План KG', perm: 'view_plan' },
  '1A5zZZi54Le3bUHkUng8L-Kbt2dkfMwwP48cpNFQ9ZMQ': { name: 'Академия',    perm: null, avatarOnly: true },
};

const READ_ACTIONS = new Set(['getSheet', 'getAvatar']);
const WRITE_ACTIONS = new Set(['updateAvatar']);

function withToken(url) {
  const tok = (process.env.SHEETS_TOKEN || '').trim();
  return tok ? url + '&token=' + encodeURIComponent(tok) : url;
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
  if (!checkAuth(req, res)) return;

  const isPost = req.method === 'POST';
  const body = isPost ? await readBody(req) : {};
  const action = String((isPost ? body.action : req.query.action) || '').trim();
  const spreadsheetId = String((isPost ? body.spreadsheetId : req.query.spreadsheetId) || '').trim();

  const cfg = SHEETS[spreadsheetId];
  if (!cfg) return res.status(403).json({ ok: false, error: 'Таблица не разрешена' });

  if (isPost ? !WRITE_ACTIONS.has(action) : !READ_ACTIONS.has(action)) {
    return res.status(400).json({ ok: false, error: 'Действие не поддерживается: ' + action });
  }
  if (cfg.avatarOnly && action === 'getSheet') {
    return res.status(403).json({ ok: false, error: 'Чтение листов этой таблицы закрыто' });
  }

  // Аватар — про самого себя, отдельного права не требует, но сотрудник должен быть опознан.
  const gate = await requirePerm(req, res, action === 'getSheet' ? cfg.perm : null);
  if (!gate.ok) return;

  try {
    if (isPost) {
      const r = await fetch(withToken(GS_URL + '?action=' + encodeURIComponent(action)), {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify(Object.assign({}, body, { token: (process.env.SHEETS_TOKEN || '').trim() || undefined })),
      });
      const text = await r.text();
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return res.status(200).send(text);
    }

    let url = GS_URL + '?action=' + encodeURIComponent(action) + '&spreadsheetId=' + encodeURIComponent(spreadsheetId);
    if (req.query.sheet) url += '&sheet=' + encodeURIComponent(req.query.sheet);
    if (req.query.range) url += '&range=' + encodeURIComponent(req.query.range);
    if (req.query.userId) url += '&userId=' + encodeURIComponent(req.query.userId);

    const r = await fetch(withToken(url));
    const text = await r.text();
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    // Кэш ответа не держим: расходы и планы правят в таблице в течение дня.
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(text);
  } catch (e) {
    console.error('[sheets] proxy failed:', e.message);
    return res.status(502).json({ ok: false, rows: [], error: 'Google Таблицы недоступны: ' + e.message });
  }
}
