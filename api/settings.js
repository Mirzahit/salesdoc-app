// /api/settings — общие настройки программы (ключ-значение, таблица app_settings).
// v795: первый потребитель — план интеграций в месяц (key='intg_month_plan', value={plan:10}).
//
// Routes:
//   GET   /api/settings?key=intg_month_plan   → { ok, key, value }
//   PATCH /api/settings                        → body {key, value}; value — объект (jsonb)
//
// Ключи валидируются whitelist-ом — это не произвольное KV-хранилище для фронта.

import { sbSelect, sbUpsert } from './_supabase.js';
import { checkAuth } from './_auth.js';

// intg_fields (v796): настройка полей карты интеграции — {hidden:[стандартные ключи], custom:[{key,label}]}
// mkt_lead_plan (v797): план лидов на месяц по странам — {KZ:{plan:200}, KG:{plan:80}}
// mkt_costs (v797): курс доллара и гонорар таргетолога — {KZ:{usd_rate:478, fee:150000}, KG:{...}}
const ALLOWED_KEYS = ['intg_month_plan', 'intg_fields', 'mkt_lead_plan', 'mkt_costs'];

export default async function handler(req, res) {
  if (!checkAuth(req, res)) return;
  try {
    if (req.method === 'GET') {
      const key = (req.query.key || '').toString();
      if (!ALLOWED_KEYS.includes(key)) {
        return res.status(400).json({ ok: false, error: 'key должен быть один из: ' + ALLOWED_KEYS.join(', ') });
      }
      const rows = await sbSelect('app_settings', { key: 'eq.' + key, limit: '1' });
      return res.status(200).json({ ok: true, key: key, value: rows.length ? rows[0].value : null });
    }
    if (req.method === 'PATCH') {
      const body = await readBody(req);
      const key = (body.key || '').toString();
      if (!ALLOWED_KEYS.includes(key)) {
        return res.status(400).json({ ok: false, error: 'key должен быть один из: ' + ALLOWED_KEYS.join(', ') });
      }
      if (body.value == null || typeof body.value !== 'object') {
        return res.status(400).json({ ok: false, error: 'value должен быть объектом' });
      }
      const rows = await sbUpsert('app_settings', {
        key: key, value: body.value, updated_at: new Date().toISOString()
      }, 'key');
      return res.status(200).json({ ok: true, key: key, value: rows[0].value });
    }
    return res.status(405).json({ ok: false, error: 'method not allowed' });
  } catch (e) {
    console.error('[api/settings] error:', e);
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
