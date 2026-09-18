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
import { requirePerm } from './_perm.js'; // v979 SEC

// intg_fields (v796): настройка полей карты интеграции — {hidden:[стандартные ключи], custom:[{key,label}]}
// mkt_lead_plan (v797): план лидов на месяц по странам — {KZ:{plan:200}, KG:{plan:80}}
// mkt_costs (v797): курс доллара и гонорар таргетолога — {KZ:{usd_rate:478, fee:150000}, KG:{...}}
// tg_digest (v801): утренний дайджест в Telegram — {enabled:bool, hour:9, last_sent:'YYYY-MM-DD'};
//   шлёт серверный крон (api/cron-digest.js, v802), фронт только настраивает.
// company_plans (v801): цели компании со страницы «Планы» — {week|month|quarter|year:{категория:число}};
//   override поверх плана из Светофора (пустая ячейка = берём Светофор/дефолт).
// plan_history (v801): история изменений планов — МАССИВ (typeof 'object' — валидацию ниже проходит),
//   новые сверху, фронт держит cap 50 записей.
// route_stages (v861): этапы доски Внедрения — {stages:['Новый','Настройка',...]}.
// Раньше список был зашит в код двумя массивами, и добавить этап мог только программист.
// Этапы общие для всех, как воронка в amoCRM: доска у всех одинаковая, цифры сравнимы.
// v899: mkt_targetologs — кто ведёт какой рекламный кабинет { 'act_123': 'Имя' }.
// v901: mkt_ad_sources — какие значения поля «Источник сделки» считаются рекламой.
// v964: autopause — {enabled:bool, days:30}: действующий клиент без оплаты дольше N дней → «На паузе» (крон)
// v993: salary_grades — грейды менеджеров (оклад, премия KPI, план, шкала бонуса, веса, штраф, кто на каком грейде);
//   salary_manual — то, что РОП ставит руками по месяцам: балл CRM и нарушения {'YYYY-MM':{email:{crm,late,noreport,complaint}}}.
const ALLOWED_KEYS = ['intg_month_plan', 'intg_fields', 'mkt_lead_plan', 'mkt_costs', 'mkt_targetologs', 'mkt_text_codes', 'mkt_ad_sources', 'mkt_exclude_ads', 'tg_digest', 'company_plans', 'plan_history', 'route_stages', 'autopause', 'salary_grades', 'salary_manual'];

// v993 SEC: кто видит зарплаты всех (руководители, РОП, бухгалтер) и кто их правит (без бухгалтера)
const SALARY_KEYS = ['salary_grades', 'salary_manual'];
const SALARY_FULL_ROLES = ['admin', 'head', 'rop', 'accountant'];
const SALARY_EDIT_ROLES = ['admin', 'head', 'rop'];
function salaryFullAccess(caller) { return SALARY_FULL_ROLES.includes(String(caller.role || '').toLowerCase()); }
// Менеджеру — только его кусок: грейд, на котором он стоит, общие правила и его собственные баллы по месяцам
function salaryOwnOnly(key, value, email) {
  const em = String(email || '').toLowerCase();
  if (key === 'salary_grades') {
    const assign = (value && value.assign) || {};
    const myId = assign[em] || null;
    const grades = Array.isArray(value.grades) ? value.grades.filter(g => g && g.id === myId) : [];
    const own = {}; if (myId) own[em] = myId;
    return { grades, weights: value.weights || null, kpi_floor: value.kpi_floor, violation_fine: value.violation_fine, assign: own };
  }
  if (key === 'salary_manual') {
    const out = {};
    Object.keys(value || {}).forEach(ym => {
      const row = value[ym] && value[ym][em];
      if (row) out[ym] = {}; if (row) out[ym][em] = row;
    });
    return out;
  }
  return value;
}

export default async function handler(req, res) {
  if (!checkAuth(req, res)) return;
  try {
    if (req.method === 'GET') {
      const key = (req.query.key || '').toString();
      if (!ALLOWED_KEYS.includes(key)) {
        return res.status(400).json({ ok: false, error: 'key должен быть один из: ' + ALLOWED_KEYS.join(', ') });
      }
      // v993 SEC: зарплатные настройки — только с правом «Мой доход»; менеджер получает лишь свою
      // часть (свой грейд, свой балл и нарушения), чужие оклады и баллы наружу не уходят.
      let caller = null;
      if (SALARY_KEYS.includes(key)) {
        const _r = await requirePerm(req, res, 'view_income');
        if (!_r.ok) return;
        caller = _r.caller;
      }
      const rows = await sbSelect('app_settings', { key: 'eq.' + key, limit: '1' });
      let value = rows.length ? rows[0].value : null;
      if (caller && value && !salaryFullAccess(caller)) value = salaryOwnOnly(key, value, caller.email);
      return res.status(200).json({ ok: true, key: key, value: value });
    }
    if (req.method === 'PATCH') {
      const body = await readBody(req);
      const key = (body.key || '').toString();
      if (!ALLOWED_KEYS.includes(key)) {
        return res.status(400).json({ ok: false, error: 'key должен быть один из: ' + ALLOWED_KEYS.join(', ') });
      }
      // v979 SEC: раньше настройки мог переписать любой вошедший (только общий токен). Планы — тем, кто
      // «Может править планы»; всё остальное (этапы, автопауза, курс, таргетологи) — только с доступом к Настройкам.
      const PLAN_KEYS = ['company_plans', 'plan_history', 'mkt_lead_plan', 'intg_month_plan'];
      let _w;
      if (key === 'salary_manual') {
        // v993 SEC: балл CRM и нарушения ставят только руководители и РОП — у менеджера тоже есть
        // edit_plans, но свой доход он править не должен
        _w = await requirePerm(req, res, 'view_income');
        if (!_w.ok) return;
        if (!SALARY_EDIT_ROLES.includes(_w.caller.role)) return res.status(403).json({ ok: false, error: 'Балл CRM и нарушения ставит руководитель' });
      } else {
        _w = await requirePerm(req, res, PLAN_KEYS.includes(key) ? ['edit_plans', 'view_settings'] : 'view_settings');
        if (!_w.ok) return;
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
