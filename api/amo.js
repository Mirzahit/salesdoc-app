// /api/amo — Vercel Node serverless function (v308)
// Прокси к amoCRM API v4. Использует долгосрочный токен (JWT) из env.
//
// ENV (Vercel Project Settings → Environment Variables):
//   AMO_SUBDOMAIN  — поддомен типа 'salesdoctorkz' (без .amocrm.ru)
//   AMO_TOKEN      — долгосрочный JWT-токен
//   AMO_ACCOUNT_ID — id аккаунта (для проверки, опционально)
//
// Actions:
//   ?action=pipelines        — список воронок и их этапов
//   ?action=funnel&pipeline_id=N  — счётчики лидов по этапам выбранной воронки

import { checkAuth, checkAdminToken } from './_auth.js';
import { requirePermSoft } from './_perm.js';
import { sbSelect, sbSelectAll, sbInsertIgnoreDup } from './_supabase.js';
import { localIso, tzOffsetH, dayStartMs, dayEndMs } from './_dates.js';
import { normalizePhone } from './_phone.js'; // v1015: один разбор телефона KG+KZ вместо четырёх копий
import { DEFAULT_PRODUCTS, loadProducts, classifyCampaign, classifyForm, productOfLead, productParam, PRODUCT_CODES,
  buildStageModel, reachedFromVisited, reachedFlags, stageRef, computeArrival, touchRef, NEAR_SEC,
  amoErrOf } from './_mkt.js'; // v1015

// v1015: отчёты Маркетинга тяжёлые (amo + Meta), даём запас по времени.
export const config = { maxDuration: 300 };

function bad(res, code, msg, extra){
  res.status(code).json({ error: msg, ...(extra || {}) });
}

// ── v1015: ограничитель частоты запросов к amo ──────────────────────────────
// amo разрешает 7 запросов в секунду на аккаунт; за превышение отвечает 429, а при
// повторах может на время заблокировать IP (инцидент после выкладки v1015: 3 минуты
// все запросы падали «fetch failed»). Поэтому:
//   • в одном экземпляре функции — не чаще 1 запроса в 210 мс (≤5 в секунду);
//   • между экземплярами — общий счётчик в Upstash Redis (KV_REST_API_URL/TOKEN):
//     не больше 6 запросов в секунду на поддомен; нет KV или он сбоит — только местный;
//   • после сетевого сбоя 20 секунд не стучимся (сразу ошибка), чтобы не добивать amo.
const AMO_GAP_MS = 210, AMO_SHARED_MAX = 6;
let _amoNextAt = 0, _kvDownUntil = 0;
const _amoDownUntil = new Map();
const _sleep = (ms) => new Promise(ok => setTimeout(ok, ms));
async function amoLocalSlot(){
  const now = Date.now();
  const at = Math.max(now, _amoNextAt);
  _amoNextAt = at + AMO_GAP_MS;
  if(at > now) await _sleep(at - now);
}
async function amoSharedSlot(sub){
  const url = String(process.env.KV_REST_API_URL || '').trim().replace(/\/+$/, '');
  const tok = String(process.env.KV_REST_API_TOKEN || '').trim();
  if(!url || !tok || Date.now() < _kvDownUntil) return;
  for(let i = 0; i < 20; i++){
    const secNow = Math.floor(Date.now() / 1000);
    const key = 'amo:rl:' + sub + ':' + secNow;
    let n;
    try {
      const r = await fetch(url + '/pipeline', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json' },
        body: JSON.stringify([['INCR', key], ['EXPIRE', key, '5']]),
        signal: AbortSignal.timeout(800)
      });
      const j = await r.json();
      n = Number(j && j[0] && j[0].result);
      if(!r.ok || !Number.isFinite(n)) throw new Error('kv ' + r.status);
    } catch(e){
      _kvDownUntil = Date.now() + 60000; // KV сбоит — минуту живём на местном ограничителе
      console.error('[amo] KV limiter off: ' + String(e.message || e).slice(0, 80));
      return;
    }
    if(n <= AMO_SHARED_MAX) return;
    await _sleep(1000 - (Date.now() % 1000) + 25); // ждём следующую секунду
  }
}
// Путь для журнала: без значений, похожих на телефоны, и без поиска по номеру.
function amoLogPath(path){
  return String(path).replace(/([?&]query=)[^&]*/g, '$1***').replace(/\d{9,}/g, '#');
}

async function amoFetch(path, env, method){
  // v309: чистим whitespace из env-переменных. При вставке в Vercel UI часто
  //       копируются переносы строк, а в HTTP-заголовке они недопустимы.
  const token = String(env.AMO_TOKEN || '').replace(/\s+/g, '');
  const sub = String(env.AMO_SUBDOMAIN || '').replace(/\s+/g, '');
  const url = `https://${sub}.amocrm.ru/api/v4${path}`;
  const m = method || 'GET';
  if(Date.now() < (_amoDownUntil.get(sub) || 0)){
    const err = new Error('amo недоступен: пауза после сбоя сети');
    err.status = 0; err.upstream = 'amo'; err.cause_code = 'PAUSED';
    throw err;
  }
  let r;
  for(let attempt = 0; ; attempt++){
    await amoLocalSlot();          // каждый запрос, и повтор тоже, — через ограничитель
    await amoSharedSlot(sub);
    try {
      r = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        signal: AbortSignal.timeout(25000)
      });
    } catch(e){
      // v1015: сеть до amo упала — это ошибка amo, а не нашей программы
      const code = (e && e.cause && e.cause.code) || (e && e.name) || '';
      console.error(`[amo] NET ${m} ${amoLogPath(path)} code=${code} attempt=${attempt}`);
      // v1016: единичный обрыв соединения (amo закрыл сокет) — повторяем один раз через 1,5 с.
      // Только чтение (GET): запись повторять нельзя — может задвоиться. Таймаут и «не открылось
      // соединение» не повторяем: это похоже на блокировку, туда нужна пауза, а не ещё запрос.
      if(attempt === 0 && m === 'GET' && code !== 'TimeoutError' && code !== 'UND_ERR_CONNECT_TIMEOUT'){
        await new Promise(ok => setTimeout(ok, 1500));
        continue;
      }
      _amoDownUntil.set(sub, Date.now() + 20000);
      const err = new Error('amo недоступен: ' + (e.message || String(e)) + (code ? ' (' + code + ')' : ''));
      err.status = 0; err.upstream = 'amo'; err.cause_code = code || null;
      throw err;
    }
    if(!r.ok && r.status !== 204){
      const raH = r.headers && r.headers.get ? r.headers.get('retry-after') : null;
      console.error(`[amo] ${r.status} ${m} ${amoLogPath(path)} code= retry-after=${raH || ''} attempt=${attempt}`);
    }
    // amo ограничивает частоту — на 429 ждём (Retry-After или 1.2 с) и повторяем до 2 раз
    if(r.status !== 429 || attempt >= 2) break;
    const ra = Number(r.headers && r.headers.get ? r.headers.get('retry-after') : 0);
    _amoNextAt = Math.max(_amoNextAt, Date.now() + (ra > 0 ? Math.min(ra * 1000, 5000) : 1200)); // пауза и для соседних запросов
  }
  if(r.status === 204) return null; // empty response (no records)
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch(_){ data = { _raw: text }; }
  if(!r.ok){
    const err = new Error(`amo ${r.status}: ${data.title || data.detail || data['validation-errors'] || text.slice(0,200)}`);
    err.status = r.status;
    err.data = data;
    err.upstream = 'amo'; // v1015: наверх уходит как 502 amo_auth/amo_error, а не как наш 401
    throw err;
  }
  return data;
}

// v1015: ошибку amo отдаём фронту как 502 с кодом. Раньше 401 от amo пробрасывался
// как есть, и экран думал, что истекла СВОЯ сессия, — а на деле устарел ключ amo.
function amoFail(res, e){
  const s = Number(e && e.status);
  return res.status(502).json({ error: (e && e.message) || 'amo error', code: (s === 401 || s === 403) ? 'amo_auth' : 'amo_error',
    cause: (e && e.cause_code) || (s ? String(s) : null) });
}

// v1015: общий кэш с объединением одинаковых запросов: два экрана, открытые разом,
// строят отчёт один раз. Неудачный результат (isBad) не хранится.
const _memo = new Map();
function memo(key, ttlMs, fn, isBad){
  const e = _memo.get(key);
  if(e && Date.now() - e.t < ttlMs) return e.p;
  const p = Promise.resolve().then(fn);
  const ent = { t: Date.now(), p };
  _memo.set(key, ent);
  const drop = () => { if(_memo.get(key) === ent) _memo.delete(key); };
  p.then(v => { if(isBad && isBad(v)) drop(); }, drop);
  if(_memo.size > 200){ const old = _memo.keys().next().value; _memo.delete(old); }
  return p;
}

// v1015: воронки меняются редко — держим 10 минут, чтобы каждый отчёт не спрашивал заново
function getPipelines(env){
  const sub = String(env.AMO_SUBDOMAIN || '').replace(/\s+/g, '');
  return memo('pl|' + sub, 10 * 60 * 1000, () => getPipelinesRaw(env));
}
async function getPipelinesRaw(env){
  const data = await amoFetch('/leads/pipelines', env);
  const pipelines = (data && data._embedded && data._embedded.pipelines) || [];
  return pipelines.map(p => ({
    id: p.id,
    name: p.name,
    is_main: !!p.is_main,
    statuses: (p._embedded && p._embedded.statuses || []).map(s => ({
      id: s.id, name: s.name, sort: s.sort, color: s.color,
      type: s.type, is_editable: s.is_editable
    })).sort((a,b) => a.sort - b.sort)
  }));
}

// v421: помощник — извлечь значение custom field «Источник сделки» (field_id 1134759).
// В amo там значения типа «Таргет», «Marquiz», «Холодный звонок» и т.п. Менеджеры
// заполняют его всегда (обязательное поле), поэтому это правда для маркетинговой
// аналитики — лучше тегов, которые менеджеры часто забывают ставить.
function _amoLeadSource(lead){
 var fields = (lead && lead.custom_fields_values) || [];
 for(var i=0; i<fields.length; i++){
  if(fields[i].field_id === 1134759){
   var vals = fields[i].values || [];
   if(vals.length && vals[0].value) return String(vals[0].value).toLowerCase();
  }
 }
 return '';
}

async function getFunnel(pipelineId, env, fromTs, toTs, tagFilter){
  // Получаем pipeline + его статусы
  const pipelines = await getPipelines(env);
  // v308: всегда работаем с воронкой «Лиды» (по имени). Внедрение/Покупатели игнорируем.
  const p = (pipelineId && pipelines.find(x => x.id === Number(pipelineId)))
         || pipelines.find(x => /^лид/i.test(x.name || ''))
         || pipelines.find(x => x.is_main)
         || pipelines[0];
  if(!p) return { error: 'no pipelines found' };

  // v312: фильтр по дате создания лида. Если from/to не заданы — берём все лиды воронки.
  let dateFilter = '';
  if(fromTs) dateFilter += `&filter[created_at][from]=${fromTs}`;
  if(toTs) dateFilter += `&filter[created_at][to]=${toTs}`;

  // Тянем лиды постранично (до 5 страниц = 1250 лидов в периоде)
  // v319: with=contacts уже было; теги приходят в _embedded.tags автоматически
  const allLeads = [];
  let truncated = false;
  for(let page = 1; page <= 5; page++){
    const data = await amoFetch(`/leads?filter[pipeline_id]=${p.id}${dateFilter}&limit=250&page=${page}`, env);
    if(!data) break;
    const batch = (data._embedded && data._embedded.leads) || [];
    if(!batch.length) break;
    allLeads.push(...batch);
    if(batch.length < 250) break;
    if(page === 5 && batch.length === 250){ truncated = true; }
  }

  // v425: ОТКАТ v421 — возвращаем фильтр по ТЕГАМ. Пользователь подтвердил что
  // в маркетинговой воронке правильнее опираться на теги amo (таргет таблица /
  // marquiz / ТАРГЕТ), потому что:
  //   1) Они точно совпадают с тем как операторы фильтруют в amo руками
  //   2) Цифра «Попало в amo» ровно сравнима с Meta-кабинетом
  // Сделки без тега значит менеджер «не оформил» — это процессная проблема,
  // её надо решать обучением операторов, а не размазывать через custom field.
  //
  // Принимаемые значения tagFilter:
  //   'meta_any' / 'все meta' — любой Meta-тег (таргет таблица OR ТАРГЕТ OR marquiz)
  //   'без тега' / '__notag__' — без любых тегов
  //   '' / undefined           — без фильтра, считаем все
  //   иначе                    — match по includes на имена тегов сделки
  let leads = allLeads;
  if(tagFilter){
    const tf = String(tagFilter).toLowerCase().trim();
    if(tf === 'без тега' || tf === '__notag__'){
      leads = allLeads.filter(l => {
        const tags = (l._embedded && l._embedded.tags) || [];
        return tags.length === 0;
      });
    } else if(tf === 'meta_any' || tf === 'все meta'){
      leads = allLeads.filter(l => {
        const tags = (l._embedded && l._embedded.tags) || [];
        return tags.some(t => {
          const tn = String(t.name||'').toLowerCase();
          return tn.includes('таргет') || tn.includes('marquiz');
        });
      });
    } else {
      leads = allLeads.filter(l => {
        const tags = (l._embedded && l._embedded.tags) || [];
        return tags.some(t => String(t.name||'').toLowerCase().includes(tf));
      });
    }
  }

  // Группируем по status_id
  const byStatus = {};
  leads.forEach(l => {
    const sid = String(l.status_id);
    if(!byStatus[sid]) byStatus[sid] = { count: 0, total_price: 0 };
    byStatus[sid].count++;
    byStatus[sid].total_price += Number(l.price) || 0;
  });

  // Сшиваем в порядок этапов воронки. Конверсия — относительно ПЕРВОГО этапа.
  const firstStageCount = (() => {
    if(!p.statuses.length) return 0;
    const firstId = String(p.statuses[0].id);
    return (byStatus[firstId] && byStatus[firstId].count) || 0;
  })();

  const stages = p.statuses.map(s => {
    const stats = byStatus[String(s.id)] || { count: 0, total_price: 0 };
    const conv = firstStageCount > 0 ? Math.round(stats.count / firstStageCount * 100) : 0;
    return {
      id: s.id, name: s.name, sort: s.sort, color: s.color, type: s.type,
      count: stats.count,
      total_price: Math.round(stats.total_price),
      conv_from_first_pct: conv
    };
  });

  // v312: cumulative — сколько лидов из периода «прошло» через этап (current at this + deeper).
  //       ИСКЛЮЧАЕМ «закрыто и не реализовано» — эти лиды отвалились, не прошли успешно дальше.
  const isLoss = (s) => /закрыт.*не.*реализов|закрыт.*неуспех|закрытая база/i.test(s.name || '');
  const sortedStages = [...stages].sort((a,b) => a.sort - b.sort);
  for(let i = 0; i < sortedStages.length; i++){
    let sum = 0;
    for(let j = i; j < sortedStages.length; j++){
      if(isLoss(sortedStages[j])) continue;
      sum += sortedStages[j].count;
    }
    sortedStages[i].cumulative = sum;
  }

  // Подсчёт потерь отдельно
  const lostCount = sortedStages.filter(isLoss).reduce((a,s) => a + s.count, 0);

  // v312: логические шаги воронки (только то что нужно CEO)
  const findByName = (re) => sortedStages.find(s => re.test(String(s.name||'').toLowerCase()));
  const logicalFlow = [];
  // Всего попавших в amo (включая отвалившихся — это «заявка дошла до CRM»)
  const totalInPipeline = sortedStages.reduce((a,s) => a + s.count, 0);
  logicalFlow.push({ key: 'leads_in_amo', label: 'Попало в amo', count: totalInPipeline });

  const meeting1 = findByName(/назначен.*встреч|встреч.*назначен/);
  if(meeting1) logicalFlow.push({ key: 'meeting_set', label: 'Назначена встреча', count: meeting1.cumulative });

  const meeting2 = findByName(/встреч.*пройден|пройден.*встреч/);
  if(meeting2) logicalFlow.push({ key: 'meeting_done', label: 'Встреча прошла', count: meeting2.cumulative });

  const reqv = findByName(/реквизит|реквезит/);
  if(reqv) logicalFlow.push({ key: 'requisites', label: 'Реквизиты получены', count: reqv.cumulative });

  const paid = findByName(/счет.*оплач|оплач.*счет|оплачен.*работ/);
  if(paid) logicalFlow.push({ key: 'paid', label: 'Счёт оплачен', count: paid.cumulative });

  // v422: список названий компаний по логическим этапам — для отладки «какие именно сделки
  // попали в счётчик». Возвращаем для каждой логической стадии массив { id, name, current_stage }.
  // Логические шаги те же что в logicalFlow ниже: meeting_set, meeting_done, requisites, paid.
  const sortedIds = sortedStages.map(s => s.id);
  function _leadsCumulativeFor(stageId){
   const startIdx = sortedStages.findIndex(s => s.id === stageId);
   if(startIdx < 0) return [];
   const validIds = new Set();
   for(let i = startIdx; i < sortedStages.length; i++){
    if(isLoss(sortedStages[i])) continue;
    validIds.add(sortedStages[i].id);
   }
   return leads
    .filter(l => validIds.has(l.status_id))
    .map(l => ({
     id: l.id,
     name: l.name || '(без названия)',
     current_stage: (sortedStages.find(s => s.id === l.status_id) || {}).name || '?',
     created_at: l.created_at
    }))
    .sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
  }
  const findStage = (re) => sortedStages.find(s => re.test(String(s.name||'').toLowerCase()));
  const leadsByStep = {};
  const stMeetingSet = findStage(/назначен.*встреч|встреч.*назначен/);
  if(stMeetingSet) leadsByStep.meeting_set = _leadsCumulativeFor(stMeetingSet.id);
  const stMeetingDone = findStage(/встреч.*пройден|пройден.*встреч/);
  if(stMeetingDone) leadsByStep.meeting_done = _leadsCumulativeFor(stMeetingDone.id);
  const stReqv = findStage(/реквизит|реквезит/);
  if(stReqv) leadsByStep.requisites = _leadsCumulativeFor(stReqv.id);
  const stPaid = findStage(/счет.*оплач|оплач.*счет|оплачен.*работ/);
  if(stPaid) leadsByStep.paid = _leadsCumulativeFor(stPaid.id);

  // v427: «Качество данных» — список самих сделок без тегов, чтобы оператор мог
  // открыть каждую в amo и поставить тег. Это блок дашборда «грязь в amo».
  const stageNameById = {};
  sortedStages.forEach(s => { stageNameById[s.id] = s.name; });
  const untaggedLeads = allLeads
   .filter(l => {
    const tags = (l._embedded && l._embedded.tags) || [];
    return tags.length === 0;
   })
   .map(l => ({
    id: l.id,
    name: l.name || '(без названия)',
    current_stage: stageNameById[l.status_id] || '?',
    created_at: l.created_at,
    price: l.price || 0
   }))
   .sort((a, b) => (b.created_at || 0) - (a.created_at || 0));

  // v320: распределение по тегам — для атрибуции источников лидов
  const tagCounts = { 'таргет таблица': 0, 'ТАРГЕТ': 0, 'marquiz': 0, '__without_tag__': 0 };
  let _accountedByTag = 0;
  allLeads.forEach(l => {
    const tags = (l._embedded && l._embedded.tags) || [];
    if(tags.length === 0){ tagCounts['__without_tag__']++; return; }
    // v663: лид с несколькими тегами считался в нескольких источниках —
    // теперь определяем ОДИН источник по приоритету (таблица > ТАРГЕТ > marquiz) и считаем один раз
    let source = null;
    for(const t of tags){
      const tn = String(t.name||'').toLowerCase();
      if(tn.includes('таргет таблица')){ source = 'таргет таблица'; break; }
      else if(tn === 'таргет' || (tn.includes('таргет') && !tn.includes('таблица'))){ if(!source) source = 'ТАРГЕТ'; }
      else if(tn.includes('marquiz')){ if(!source) source = 'marquiz'; }
    }
    if(source){ tagCounts[source]++; _accountedByTag++; }
  });

  // v797: явные «выигранные» — деньги от рекламы для блока окупаемости в Маркетинге.
  // id 142 — системный статус amo «Успешно реализовано»; имя проверяем как fallback.
  const isWonStage = (s) => Number(s.id) === 142 || /успешн.*реализ/i.test(String(s.name || ''));
  const wonStages = stages.filter(isWonStage);
  const won = {
    count: wonStages.reduce((a, s) => a + s.count, 0),
    sum: wonStages.reduce((a, s) => a + s.total_price, 0)
  };

  return {
    pipeline: { id: p.id, name: p.name },
    total_leads: leads.length,
    total_leads_unfiltered: allLeads.length,
    truncated: truncated,
    lost_count: lostCount,
    period: { from: fromTs || null, to: toTs || null },
    tag_filter: tagFilter || null,
    tag_counts: tagCounts,
    won: won, // v797: {count, sum} успешных сделок (суммы в валюте аккаунта amo)
    stages: stages,
    logical_flow: logicalFlow,
    leads_by_step: leadsByStep, // v422: списки сделок по логическим шагам — для отладки
    untagged_leads: untaggedLeads // v427: список сделок без тегов — для блока «Качество данных»
  };
}

// v376: helper для записи в amo (PATCH/POST через amocrm API v4)
async function amoMutate(method, path, body, env){
  const token = String(env.AMO_TOKEN || '').replace(/\s+/g, '');
  const sub = String(env.AMO_SUBDOMAIN || '').replace(/\s+/g, '');
  const url = `https://${sub}.amocrm.ru/api/v4${path}`;
  await amoLocalSlot(); await amoSharedSlot(sub); // v1015: записи — через тот же ограничитель
  let r;
  try {
    r = await fetch(url, {
      method: method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(25000)
    });
  } catch(e){
    const code = (e && e.cause && e.cause.code) || (e && e.name) || '';
    console.error(`[amo] NET ${method} ${amoLogPath(path)} code=${code} attempt=0`);
    const err = new Error('amo недоступен: ' + (e.message || String(e)));
    err.status = 0; err.upstream = 'amo'; err.cause_code = code || null;
    throw err;
  }
  if(!r.ok && r.status !== 204) console.error(`[amo] ${r.status} ${method} ${amoLogPath(path)} code= retry-after=${(r.headers.get && r.headers.get('retry-after')) || ''} attempt=0`);
  if(r.status === 204) return null;
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch(_){ data = { _raw: text }; }
  if(!r.ok){
    const err = new Error(`amo ${method} ${r.status}: ${data.title || data.detail || text.slice(0,200)}`);
    err.status = r.status;
    err.data = data;
    err.upstream = 'amo'; // v1015
    throw err;
  }
  return data;
}

// v376: для POST/PATCH endpoint'ов — читаем body запроса.
async function readBody(req){
  if(req.body && typeof req.body === 'object') return req.body;
  return new Promise((resolve) => {
    let chunks = '';
    req.on('data', c => chunks += c);
    req.on('end', () => { try { resolve(JSON.parse(chunks || '{}')); } catch { resolve({}); } });
  });
}

// ── v897: полный отчёт по лидам за период — этапы, менеджеры, деньги ────────
// Зачем: Маркетинг раньше считал лиды из Meta, а Meta не видит заявки из переписок
// и с сайта тех стран, где кампании крутятся на трафик (KZ: расход есть, лидов 0).
// Источник правды по лидам — amo. Отчёт отдаёт: список лидов с текущим этапом,
// сколько дошло до каждого этапа, разрез по менеджерам и сумму успешных сделок.
const _lrCache = new Map();
const LR_TTL_MS = 10 * 60 * 1000;
function _lrGet(k, ttl){
  const e = _lrCache.get(k);
  if(!e) return null;
  if(Date.now() - e.t > (ttl || LR_TTL_MS)){ _lrCache.delete(k); return null; }
  return e.v;
}
function _lrSet(k, v){ _lrCache.set(k, { t: Date.now(), v }); }


// v951 SEC: адрес для вызова своих же эндпоинтов НЕ берём из заголовков запроса —
// подделанный x-forwarded-host увёл бы APP_TOKEN на чужой сервер. База задаётся
// окружением; заголовок используется только если он из списка своих доменов.
const _SELF_HOSTS = new Set(['salesdoc-app.vercel.app', 'salesdoc-app-office-2203s-projects.vercel.app', 'salesdoc-app-git-main-office-2203s-projects.vercel.app']);
function selfBase(req){
  // v1015: на превью-сборке ходим в саму превью-сборку, а не в прод — иначе проверяли бы чужой код
  const vu = String(process.env.VERCEL_URL || '').trim().replace(/\/+$/, '');
  if(process.env.VERCEL_ENV === 'preview' && vu) return 'https://' + vu.replace(/^https?:\/\//, '');
  const env = String(process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
  if(env) return env;
  const h = String((req && req.headers && (req.headers['x-forwarded-host'] || req.headers.host)) || '').split(',')[0].trim().toLowerCase();
  return 'https://' + (_SELF_HOSTS.has(h) ? h : 'salesdoc-app.vercel.app');
}
const _trCache = new Map(); // v946: готовые отчёты по таргетологам

// ── v1015: общие куски отчётов Маркетинга ───────────────────────────────────
// Свой же эндпоинт: отдаём и статус, и тело — чтобы отличить «нет данных» от «упало».
async function selfFetch(base, path, extraHeaders){
  const hdr = Object.assign({ 'x-app-token': String(process.env.APP_TOKEN || '').trim(), 'x-user-email': 'cron@salesdoc.io' }, extraHeaders || {});
  // v1015: на превью-сборке Vercel закрыт защитой — пропуск для своих же запросов
  const bypass = String(process.env.VERCEL_AUTOMATION_BYPASS_SECRET || '').trim();
  if(bypass) hdr['x-vercel-protection-bypass'] = bypass;
  try {
    const r = await fetch(`${base}${path}`, { headers: hdr });
    const json = await r.json().catch(() => null);
    return { status: r.status, json };
  } catch(e){ return { status: 0, json: { error: e.message || String(e) } }; }
}
function selfFailed(r){ return !r || !r.json || r.status >= 400 || r.status === 0 || !!r.json.error; }

async function fetchUsersRaw(env){
  const userNameById = {};
  for(let up = 1; up <= 5; up++){
    const ud = await amoFetch(`/users?limit=250&page=${up}`, env);
    const arr = (ud && ud._embedded && ud._embedded.users) || [];
    arr.forEach(u => { userNameById[u.id] = u.name; });
    if(arr.length < 250) break;
  }
  return userNameById;
}
async function fetchUsers(env, incomplete){
  let userNameById = {};
  try {
    // v1015: менеджеры — 10 минут из памяти
    const sub = String(env.AMO_SUBDOMAIN || '').replace(/\s+/g, '');
    userNameById = await memo('us|' + sub, 10 * 60 * 1000, () => fetchUsersRaw(env));
  } catch(e){
    // v1015: без имён менеджеров отчёт всё равно верный — это «неполные данные», не ошибка
    if(Number(e.status) === 401 || Number(e.status) === 403) throw e;
    if(incomplete) incomplete.push({ source: 'amo', what: 'managers', detail: 'имена менеджеров не загрузились' });
  }
  return userNameById;
}

// История смен этапа. Мало сделок — спрашиваем историю каждой (по 10 за запрос, вся жизнь
// сделки); много — листаем общий журнал аккаунта с начала периода, как раньше.
// Возвращает {visited: Map<lead_id, Set<status_id>>, scanned, truncated, error}.
async function scanStatusEvents(env, ids, fromTs, toTs){
  const visited = new Map();
  let scanned = 0, truncated = false, error = null;
  const take = (batch) => batch.forEach(e => {
    const id = Number(e.entity_id);
    if(!ids.has(id)) return;
    const after = (e.value_after && e.value_after[0] && e.value_after[0].lead_status) || null;
    if(!after) return;
    if(!visited.has(id)) visited.set(id, new Set());
    visited.get(id).add(after.id);
  });
  const nowS = Math.floor(Date.now()/1000);
  const globalScan = async () => {
    const evTo = Math.min(nowS, (toTs ? toTs + 90*86400 : nowS));
    for(let page = 1; page <= 40; page++){
      const ev = await amoFetch(`/events?filter[entity]=lead&filter[type][]=lead_status_changed&filter[created_at][from]=${fromTs}&filter[created_at][to]=${evTo}&limit=100&page=${page}`, env);
      if(!ev) break;
      const batch = (ev._embedded && ev._embedded.events) || [];
      if(!batch.length) break;
      scanned += batch.length;
      take(batch);
      if(batch.length < 100) break;
      if(page === 40) truncated = true;
    }
  };
  try {
    if(!ids.size){ /* нечего смотреть */ }
    else if(ids.size <= 60){
      const arr = [...ids];
      try {
        for(let i = 0; i < arr.length; i += 10){
          const q = arr.slice(i, i + 10).map(x => `filter[entity_id][]=${x}`).join('&');
          for(let page = 1; page <= 5; page++){
            const ev = await amoFetch(`/events?filter[entity]=lead&${q}&filter[type][]=lead_status_changed&limit=100&page=${page}`, env);
            if(!ev) break;
            const batch = (ev._embedded && ev._embedded.events) || [];
            if(!batch.length) break;
            scanned += batch.length;
            take(batch);
            if(batch.length < 100) break;
            if(page === 5) truncated = true;
          }
        }
      } catch(e){
        if(Number(e.status) !== 400) throw e;
        await globalScan(); // фильтр по сделкам не принят — общий журнал
      }
    } else await globalScan();
  } catch(e){ error = e; }
  return { visited, scanned, truncated, error };
}
function reachedOf(model, lead, sc){
  const v = sc && sc.visited.get(lead.id);
  return reachedFromVisited(model, [lead.status_id].concat(v ? [...v] : []));
}

// Сделки по номерам — пачками по 50 вместо запроса на каждую.
async function fetchLeadsByIds(env, ids, withParam, errors){
  const out = {};
  const arr = [...new Set([...ids].map(Number).filter(Boolean))];
  let failed = 0;
  for(let i = 0; i < arr.length; i += 50){
    const q = arr.slice(i, i + 50).map((x, k) => `filter[id][${k}]=${x}`).join('&');
    try {
      const r = await amoFetch(`/leads?${q}&limit=250${withParam ? '&with=' + withParam : ''}`, env);
      ((r && r._embedded && r._embedded.leads) || []).forEach(l => { out[l.id] = l; });
    } catch(e){
      if(Number(e.status) === 401 || Number(e.status) === 403) throw e;
      failed += Math.min(50, arr.length - i);
      if(errors) errors.push(amoErrOf(e, 'сделки'));
    }
  }
  return { leads: out, failed };
}

// Рекламные касания за [fromMs, toMs). PostgREST отдаёт ≤1000 строк — берём все страницы.
// Верхнюю границу режем в коде: sbSelect хранит один фильтр на колонку.
async function loadTouches(country, fromMs, toMs){
  const rows = await sbSelectAll('ad_touches', {
    country: 'eq.' + country,
    touched_at: 'gte.' + new Date(fromMs).toISOString(),
    order: 'touched_at.asc,message_id.asc'
  });
  return rows.filter(t => { const ms = Date.parse(t.touched_at); return Number.isFinite(ms) && ms < toMs; });
}

// v1015: одно правило месяца — по дате обращения. Сделка из рекламы относится к месяцу
// касания, остальные — к дате создания (правило в _mkt.js computeArrival).
//   L1 — сделки воронки, созданные в периоде (если нужны и «без рекламы»);
//   L2 — сделки, которых коснулась реклама в периоде, но созданы они раньше/позже.
async function buildArrivals(env, country, fromTs, toTs, opts){
  const o = opts || {};
  const errors = [], incomplete = [];
  let touches = [];
  try {
    // v1015: и на 7 дней после периода — сделка 30.08 с касанием 02.09 это реклама (обращение 30.08)
    touches = await loadTouches(country, (fromTs - NEAR_SEC) * 1000, ((toTs || Math.floor(Date.now()/1000)) + NEAR_SEC + 1) * 1000);
  } catch(e){ errors.push({ source: 'db', kind: 'other', message: 'рекламные касания: ' + String(e.message || e).slice(0, 200) }); }
  const byLead = new Map();
  touches.forEach(t => { if(!t.lead_id) return; const id = Number(t.lead_id); if(!byLead.has(id)) byLead.set(id, []); byLead.get(id).push(t); });
  const leads = {};
  let truncated = false;
  if(o.includeOrganic && o.pipelineId){
    let dateFilter = `&filter[created_at][from]=${fromTs}`;
    if(toTs) dateFilter += `&filter[created_at][to]=${toTs}`;
    for(let page = 1; page <= 12; page++){
      const data = await amoFetch(`/leads?filter[pipeline_id]=${o.pipelineId}${dateFilter}&limit=250&page=${page}${o.with ? '&with=' + o.with : ''}`, env);
      if(!data) break;
      const batch = (data._embedded && data._embedded.leads) || [];
      if(!batch.length) break;
      batch.forEach(l => { leads[l.id] = l; });
      if(batch.length < 250) break;
      if(page === 12) truncated = true;
    }
  }
  const toS = (toTs || Infinity) + NEAR_SEC; // касание до 7 дней после периода может относиться к сделке периода
  const touchedIds = new Set();
  touches.forEach(t => {
    const s = Math.floor(Date.parse(t.touched_at) / 1000);
    if(t.lead_id && s >= fromTs && s <= toS) touchedIds.add(Number(t.lead_id));
  });
  const missing = [...touchedIds].filter(id => !leads[id]);
  let failed = 0;
  if(missing.length){
    const r = await fetchLeadsByIds(env, missing, o.with || '', errors);
    failed = r.failed;
    Object.values(r.leads).forEach(l => { if(o.keepAllPipelines || !o.pipelineId || !o.includeOrganic || l.pipeline_id === o.pipelineId) leads[l.id] = l; });
  }
  if(failed) incomplete.push({ source: 'amo', what: 'deals', detail: 'не загрузились сделки: ' + failed });
  const items = [];
  Object.values(leads).forEach(l => {
    const tags = ((l._embedded && l._embedded.tags) || []).map(t => t.name).filter(Boolean);
    const a = computeArrival({ created: l.created_at, tags }, byLead.get(Number(l.id)) || [], fromTs, toTs);
    if(a) items.push({ lead: l, tags, arrival: a });
  });
  return { items, truncated, errors, incomplete, touches_total: touches.length };
}

// v1015: основа периода — обращения и история этапов — одна на lead_report и targ_report
// одной страны и периода: строится один раз (параллельные запросы ждут тот же результат),
// хранится 10 минут. Со сбоем не хранится.
function periodBase(env, country, fromTs, toTs){
  const sub = String(env.AMO_SUBDOMAIN || '').replace(/\s+/g, '');
  return memo(['pb', sub, country, fromTs, toTs || 0].join('|'), 10 * 60 * 1000, async () => {
    const pipelines = await getPipelines(env);
    const p = pipelines.find(x => /^лид/i.test(x.name || '')) || pipelines.find(x => x.is_main) || pipelines[0];
    if(!p) return { error: 'no pipelines found' };
    const ar = await buildArrivals(env, country, fromTs, toTs, { pipelineId: p.id, includeOrganic: true, keepAllPipelines: true, with: 'contacts' });
    const ids = new Set(ar.items.map(x => Number(x.lead.id)));
    const sc = await scanStatusEvents(env, ids, fromTs - NEAR_SEC, toTs);
    return { p, pipelines, ar, sc };
  }, v => !!(v.error || v.ar.errors.length || v.sc.error));
}

async function buildLeadReport(env, fromTs, toTs, opts){
  const o = opts || {};
  const v2 = !!o.v2;
  const country = o.country || 'KG';
  const errors = [], incomplete = [];
  const pipelines = await getPipelines(env);
  const p = pipelines.find(x => /^лид/i.test(x.name || '')) || pipelines.find(x => x.is_main) || pipelines[0];
  if(!p) return { error: 'no pipelines found' };

  // «Живые» этапы по порядку. Отказ и успех в этот список не входят: отказ не значит
  // «прошёл всю воронку», успех наоборот засчитываем как пройденную воронку целиком.
  // v1015 (v=2): «Отложили на период» тоже не движение вперёд — убран из воронки, как отказ.
  const model = buildStageModel(p.statuses, { honest: v2 });
  const flow = model.flow, nameById = model.nameById;

  // менеджеры (id → имя)
  const userNameById = await fetchUsers(env, incomplete);

  // 1) лиды периода: v1 — созданные в периоде; v2 — по дате обращения (реклама/создание)
  let raw = [];
  let truncated = false;
  const arrivalById = new Map();
  let cfg = DEFAULT_PRODUCTS;
  let sc = null;
  if(v2){
    cfg = o.cfg || DEFAULT_PRODUCTS;
    const base = await periodBase(env, country, fromTs, toTs);
    if(base.error) return { error: base.error };
    const ar = base.ar;
    errors.push(...ar.errors); incomplete.push(...ar.incomplete);
    truncated = ar.truncated;
    ar.items.forEach(x => { if(x.lead.pipeline_id !== p.id) return; raw.push(x.lead); arrivalById.set(x.lead.id, x.arrival); });
    sc = base.sc;
  } else {
    let dateFilter = `&filter[created_at][from]=${fromTs}`;
    if(toTs) dateFilter += `&filter[created_at][to]=${toTs}`;
    for(let page = 1; page <= 12; page++){
      const data = await amoFetch(`/leads?filter[pipeline_id]=${p.id}${dateFilter}&limit=250&page=${page}`, env);
      if(!data) break;
      const batch = (data._embedded && data._embedded.leads) || [];
      if(!batch.length) break;
      raw.push(...batch);
      if(batch.length < 250) break;
      if(page === 12) truncated = true;
    }
  }
  if(truncated) incomplete.push({ source: 'amo', what: 'leads', detail: 'показаны первые 3000' });
  const known = new Set(raw.map(l => l.id));

  // 2) история смен этапа — иначе лид, который дошёл до встречи и слился, теряется
  if(!sc) sc = await scanStatusEvents(env, known, fromTs, toTs);
  if(sc.error){
    if(Number(sc.error.status) === 401 || Number(sc.error.status) === 403) throw sc.error;
    errors.push(amoErrOf(sc.error, 'история этапов'));
  }
  if(sc.truncated) incomplete.push({ source: 'amo', what: 'events', detail: 'история этапов просмотрена не полностью' });

  const wonIds = model.wonIds, lostIds = model.lostIds;
  const sub = String(env.AMO_SUBDOMAIN || '').replace(/\s+/g, '');

  const leads = raw.map(l => {
    const r = reachedOf(model, l, sc);
    let deepest = null;
    if(r != null) for(const st of flow){ if(Number(st.sort) <= r) deepest = st; }
    // v900: поле «Источник сделки» в amo ЕСТЬ (в KG это field_id 2640473) — просто
    // заполняют его не всегда. Читаем по названию поля, а не по id, чтобы работало
    // и в казахстанском кабинете, где id другой.
    const cf = l.custom_fields_values || [];
    let source = '';
    for(const f of cf){
      if(/источник/i.test(String(f.field_name || ''))){
        const v = (f.values || [])[0];
        if(v && v.value){ source = String(v.value).trim(); break; }
      }
    }
    // Кто завёл сделку: created_by = 0 значит интеграция (форма, сайт, бот), иначе менеджер.
    const byRobot = !Number(l.created_by);
    const tags = ((l._embedded && l._embedded.tags) || []).map(t => t.name).filter(Boolean);
    const out = {
      id: l.id,
      name: l.name || '(без названия)',
      created: l.created_at,
      manager: userNameById[l.responsible_user_id] || '—',
      origin: byRobot ? 'auto' : 'manual',
      source: source,
      created_by: l.created_by || 0,
      created_by_name: byRobot ? 'интеграция' : (userNameById[l.created_by] || ('id ' + l.created_by)),
      tags: tags,
      status_id: l.status_id,
      stage: nameById[l.status_id] || '—',
      is_won: wonIds.has(l.status_id),
      is_lost: lostIds.has(l.status_id),
      reached_sort: r,
      reached_stage: deepest ? deepest.name : null,
      price: Number(l.price) || 0,
      url: `https://${sub}.amocrm.ru/leads/detail/${l.id}`
    };
    if(v2){
      const a = arrivalById.get(l.id);
      out.arrival_at = a ? a.arrival_at : l.created_at;
      out.arrival_kind = a ? a.arrival_kind : 'organic';
      out.touch = a ? touchRef(a.touch) : null;
      out.product = productOfLead(cfg, { tags }, a && a.touch);
      out.is_postponed = model.postponedIds.has(l.status_id);
    }
    return out;
  }).sort((a, b) => v2 ? (b.arrival_at - a.arrival_at) : (b.created - a.created));

  const countReached = (sort) => leads.filter(x => x.reached_sort != null && x.reached_sort >= sort).length;
  const stages = flow.map(st => ({ id: st.id, name: st.name, sort: Number(st.sort), reached: countReached(Number(st.sort)) }));

  // разрез по менеджерам: сколько его лидов дошло до каждого этапа
  const mgr = new Map();
  leads.forEach(l => {
    if(!mgr.has(l.manager)) mgr.set(l.manager, { name: l.manager, leads: 0, won: 0, won_sum: 0, lost: 0, reached: {} });
    const m = mgr.get(l.manager);
    m.leads++;
    if(l.is_won){ m.won++; m.won_sum += l.price; }
    if(l.is_lost) m.lost++;
    if(l.reached_sort == null) return;
    flow.forEach(st => { if(l.reached_sort >= Number(st.sort)) m.reached[st.id] = (m.reached[st.id] || 0) + 1; });
  });
  const managers = [...mgr.values()].sort((a, b) => b.leads - a.leads);

  const wonLeads = leads.filter(l => l.is_won);
  const origins = { auto: 0, manual: 0 };
  const byCreator = {};
  const bySource = {};
  let withSource = 0;
  leads.forEach(l => {
    origins[l.origin]++;
    byCreator[l.created_by_name] = (byCreator[l.created_by_name] || 0) + 1;
    const k = l.source || '(не заполнен)';
    bySource[k] = (bySource[k] || 0) + 1;
    if(l.source) withSource++;
  });
  const out = {
    pipeline: { id: p.id, name: p.name },
    origins, by_creator: byCreator,
    by_source: bySource, source_filled: withSource,
    from: fromTs, to: toTs || null,
    leads_total: leads.length,
    stages, leads, managers,
    won: { count: wonLeads.length, sum: wonLeads.reduce((a, l) => a + l.price, 0) },
    lost: { count: leads.filter(l => l.is_lost).length },
    truncated,
    events: { scanned: sc.scanned, truncated: sc.truncated, error: sc.error ? (sc.error.message || String(sc.error)) : null },
    errors, incomplete
  };
  if(v2){
    const products = {}; PRODUCT_CODES.forEach(c => { products[c] = 0; });
    leads.forEach(l => { products[l.product] = (products[l.product] || 0) + 1; });
    out.qual_stage = stageRef(model.qualStage);
    out.meet_stage = stageRef(model.meetStage);
    out.inv_stage = stageRef(model.invStage);
    out.postponed_now = leads.filter(l => l.is_postponed).length;
    out.products = products;
    out.month_rule = 'arrival';
  }
  return out;
}

export default async function handler(req, res){
  // v376: разрешаем POST для двусторонней синхронизации SD→amo (update_status, add_note).
  if(req.method !== 'GET' && req.method !== 'POST'){ return bad(res, 405, 'Only GET/POST'); }
  // v591 SEC: app-token обязателен для ВСЕХ методов. Раньше проверялся только для POST,
  // из-за чего GET-действия (phone_lookup/lead_full/data_quality/apply_meta_tags) сливали
  // PII клиентов из amo и позволяли GET-мутацию тегов сделок без токена.
  if(!checkAuth(req, res)) return;
  // v361: поддержка двух amo-кабинетов (KZ + KG) через ?country=KG
  const country = String((req.query && req.query.country) || 'KG').toUpperCase();
  const env = country === 'KG' ? {
    AMO_SUBDOMAIN: process.env.AMO_SUBDOMAIN_KG,
    AMO_TOKEN: process.env.AMO_TOKEN_KG,
    AMO_ACCOUNT_ID: process.env.AMO_ACCOUNT_ID_KG
  } : {
    AMO_SUBDOMAIN: process.env.AMO_SUBDOMAIN,
    AMO_TOKEN: process.env.AMO_TOKEN,
    AMO_ACCOUNT_ID: process.env.AMO_ACCOUNT_ID
  };
  if(!env.AMO_SUBDOMAIN || !env.AMO_TOKEN){
    const suffix = country === 'KG' ? '_KG' : '';
    return bad(res, 500, `AMO env not configured: set AMO_SUBDOMAIN${suffix} and AMO_TOKEN${suffix} in Vercel`);
  }

  const action = String((req.query && req.query.action) || '').toLowerCase();

  try {
    // v376: POST-действия для двусторонней синхронизации SD→amo
    if(req.method === 'POST'){
      const body = await readBody(req);
      if(action === 'update_status'){
        // Обновить статус сделки в amo. body: { lead_id, status_id, pipeline_id? }
        // Используется когда в SalesDoc активируют клиента — переводим сделку в amo на «успешно реализовано» (status_id=142).
        const leadId = Number(body.lead_id || 0);
        const statusId = Number(body.status_id || 0);
        if(!leadId || !statusId) return bad(res, 400, 'Need body { lead_id, status_id }');
        const patch = { status_id: statusId };
        if(body.pipeline_id) patch.pipeline_id = Number(body.pipeline_id);
        const result = await amoMutate('PATCH', `/leads/${leadId}`, patch, env);
        return res.status(200).json({ ok: true, lead: result });
      }
      if(action === 'add_note'){
        // Добавить заметку к сделке. body: { lead_id, text }
        // Используется чтобы синхронизировать заметки SalesDoc → лента событий amo.
        const leadId = Number(body.lead_id || 0);
        const text = String(body.text || '').trim();
        if(!leadId || !text) return bad(res, 400, 'Need body { lead_id, text }');
        const result = await amoMutate('POST', `/leads/${leadId}/notes`, [{
          note_type: 'common',
          params: { text: text }
        }], env);
        return res.status(201).json({ ok: true, note: result });
      }
      return bad(res, 400, 'Unknown POST action. Use ?action=update_status | add_note');
    }
    if(action === 'pipelines'){
      const list = await getPipelines(env);
      return res.status(200).json({ pipelines: list });
    }
    if(action === 'lead_full'){
      // v372: тянем сделку из amo со всеми кастомными полями, контактами и лентой событий.
      // Используется на карточке клиента в Маршруте — «загрузить из amo».
      const leadId = req.query.id ? Number(req.query.id) : null;
      if(!leadId) return bad(res, 400, 'Need ?id=LEAD_ID');
      const lead = await amoFetch(`/leads/${leadId}?with=contacts,catalog_elements,is_main_contact,loss_reason`, env);
      // Контакты: получаем каждого по id для деталей (телефоны, email)
      const contactsRaw = (lead._embedded && lead._embedded.contacts) || [];
      const contacts = [];
      for(const c of contactsRaw){
        try {
          const cd = await amoFetch(`/contacts/${c.id}`, env);
          contacts.push({
            id: cd.id,
            name: cd.name,
            first_name: cd.first_name,
            last_name: cd.last_name,
            is_main: c.is_main,
            phones: (cd.custom_fields_values || []).filter(f => f.field_code === 'PHONE')
              .flatMap(f => (f.values || []).map(v => ({ value: v.value, enum: v.enum_code }))),
            emails: (cd.custom_fields_values || []).filter(f => f.field_code === 'EMAIL')
              .flatMap(f => (f.values || []).map(v => ({ value: v.value, enum: v.enum_code }))),
            position: ((cd.custom_fields_values || []).find(f => f.field_code === 'POSITION') || {values:[{value:''}]}).values[0].value
          });
        } catch(e){
          contacts.push({ id: c.id, error: e.message });
        }
      }
      // Заметки/события (лента): последние 50
      let notes = [];
      try {
        const np = await amoFetch(`/leads/${leadId}/notes?limit=50&order[updated_at]=desc`, env);
        notes = (np && np._embedded && np._embedded.notes) || [];
      } catch(_){}
      // Pipeline + статус для понимания этапа
      let pipelineInfo = null;
      try {
        const allPipes = await getPipelines(env);
        const pipe = allPipes.find(p => p.id === lead.pipeline_id);
        const status = pipe && pipe.statuses.find(s => s.id === lead.status_id);
        pipelineInfo = pipe ? { id: pipe.id, name: pipe.name, status: status ? status.name : null, status_color: status ? status.color : null } : null;
      } catch(_){}
      return res.status(200).json({
        ok: true,
        lead: {
          id: lead.id,
          name: lead.name,
          price: lead.price,
          status_id: lead.status_id,
          pipeline_id: lead.pipeline_id,
          responsible_user_id: lead.responsible_user_id,
          created_at: lead.created_at,
          updated_at: lead.updated_at,
          custom_fields_values: lead.custom_fields_values || [],
          _url: `https://${String(env.AMO_SUBDOMAIN||'').replace(/\s+/g,'')}.amocrm.ru/leads/detail/${lead.id}`
        },
        pipeline: pipelineInfo,
        contacts: contacts,
        notes: notes
      });
    }
    if(action === 'loss_reasons'){
      // v629: агрегат причин отказа из amo (нативное поле loss_reason) за период.
      // Возврат: { period, currency, pipeline, total{count,sum}, reasons[], deals[], truncated }.
      const period = String(req.query.period || 'this_month').toLowerCase();
      const pipelineId = req.query.pipeline_id ? Number(req.query.pipeline_id) : null;
      // период → unix-границы (сек) для filter[closed_at]
      // v1015: год и месяц — по поясу страны (KG +6, KZ +5), а не по часам сервера (UTC)
      const now = new Date();
      const _todayLocal = localIso(Date.now(), country);
      const yy = Number(_todayLocal.slice(0, 4)), mm = Number(_todayLocal.slice(5, 7)) - 1;
      const MONTHS_RU = ['Январь','Февраль','Март','Апрель','Май','Июнь','Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];
      let fromDate, toDate, label;
      // v630: кастомный диапазон from/to (YYYY-MM-DD). Если валиден — приоритет над period.
      const qFrom = String((req.query && req.query.from) || '').slice(0, 10);
      const qTo = String((req.query && req.query.to) || '').slice(0, 10);
      const _validDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);
      // v922: границы считаем по Алматы (UTC+5), сервер Vercel живёт в UTC —
      // иначе сделки, закрытые 1-го числа до 05:00, улетали в прошлый месяц.
      // v1015: для KG — по Бишкеку (UTC+6)
      const almaty = (y, m, d) => new Date(Date.UTC(y, m, d) - tzOffsetH(country)*3600*1000);
      if(_validDate(qFrom) && _validDate(qTo)){
        fromDate = new Date(dayStartMs(qFrom, country));
        toDate = new Date(dayEndMs(qTo, country) - 1000);
        label = qFrom + ' — ' + qTo;
      } else if(period === 'year'){ fromDate = almaty(yy,0,1); toDate = now; label = 'Год ' + yy; }
      else if(period === 'quarter'){ const q = Math.floor(mm/3); fromDate = almaty(yy, q*3, 1); toDate = now; label = 'Квартал ' + (q+1) + ' · ' + yy; }
      else { fromDate = almaty(yy, mm, 1); toDate = now; label = MONTHS_RU[mm] + ' ' + yy; }
      const fromTs = Math.floor(fromDate.getTime()/1000);
      const toTs = Math.floor(toDate.getTime()/1000);

      // воронка «Лиды» (как в getFunnel)
      const pls = await getPipelines(env);
      const pl = (pipelineId && pls.find(x=>x.id===Number(pipelineId)))
             || pls.find(x=>/^лид/i.test(x.name||''))
             || pls.find(x=>x.is_main) || pls[0];
      if(!pl) return res.status(200).json({ error:'no pipelines found' });
      // статусы-потери: системный 143 или по названию
      const _isLoss = (s)=>/закрыт.*не.*реализов|закрыт.*неуспех|закрытая база/i.test(s.name||'');
      const lostStatusIds = pl.statuses.filter(s=> s.id===143 || _isLoss(s)).map(s=>s.id);
      if(!lostStatusIds.length) lostStatusIds.push(143);

      // каталог причин (id→имя) — резерв, если _embedded.loss_reason не придёт
      const reasonNameById = {};
      try {
        for(let rp=1; rp<=5; rp++){
          const rd = await amoFetch(`/leads/loss_reasons?limit=250&page=${rp}`, env);
          const arr = (rd && rd._embedded && rd._embedded.loss_reasons) || [];
          arr.forEach(r=>{ reasonNameById[r.id] = r.name; });
          if(arr.length < 250) break;
        }
      } catch(_){}
      // пользователи (id→имя менеджера)
      const userNameById = {};
      try {
        for(let up=1; up<=5; up++){
          const ud = await amoFetch(`/users?limit=250&page=${up}`, env);
          const arr = (ud && ud._embedded && ud._embedded.users) || [];
          arr.forEach(u=>{ userNameById[u.id] = u.name; });
          if(arr.length < 250) break;
        }
      } catch(_){}

      // фильтр по статусам-потерям + дате закрытия
      let statusFilter = '';
      lostStatusIds.forEach((sid,i)=>{ statusFilter += `&filter[statuses][${i}][pipeline_id]=${pl.id}&filter[statuses][${i}][status_id]=${sid}`; });
      const dateFilter = `&filter[closed_at][from]=${fromTs}&filter[closed_at][to]=${toTs}`;

      const deals = [];
      let truncated = false;
      const MAX_PAGES = 8;
      for(let page=1; page<=MAX_PAGES; page++){
        const data = await amoFetch(`/leads?limit=250&page=${page}&with=loss_reason${statusFilter}${dateFilter}`, env);
        if(!data) break;
        const batch = (data._embedded && data._embedded.leads) || [];
        if(!batch.length) break;
        batch.forEach(l=>{
          let reason = '';
          const lr = (l._embedded && l._embedded.loss_reason) || [];
          if(lr.length && lr[0]) reason = lr[0].name || reasonNameById[lr[0].id] || '';
          else if(l.loss_reason_id) reason = reasonNameById[l.loss_reason_id] || '';
          if(!reason) reason = 'Причина не указана';
          deals.push({
            company: l.name || '(без названия)',
            amount: Number(l.price)||0,
            manager: userNameById[l.responsible_user_id] || '—',
            reason: reason,
            date: l.closed_at ? localIso(l.closed_at*1000, country) : '', // v817/v1015: дата по поясу страны
            lead_id: l.id
          });
        });
        if(batch.length < 250) break;
        if(page === MAX_PAGES && batch.length === 250) truncated = true;
      }

      // агрегат по причинам
      const byReason = {};
      deals.forEach(d=>{ const k=d.reason; if(!byReason[k]) byReason[k]={name:k,count:0,sum:0}; byReason[k].count++; byReason[k].sum+=d.amount; });
      const reasons = Object.keys(byReason).map(k=>byReason[k]).sort((a,b)=> b.sum - a.sum || b.count - a.count);
      const total = { count: deals.length, sum: deals.reduce((s,d)=>s+d.amount,0) };

      return res.status(200).json({
        period: { label, from: fromTs, to: toTs },
        currency: country === 'KG' ? 'KGS' : 'KZT',
        pipeline: { id: pl.id, name: pl.name },
        total, reasons, deals, truncated,
        _subdomain: env.AMO_SUBDOMAIN
      });
    }
    if(action === 'funnel'){
      const pipelineId = req.query.pipeline_id ? Number(req.query.pipeline_id) : null;
      const fromTs = req.query.from ? Number(req.query.from) : null;
      const toTs = req.query.to ? Number(req.query.to) : null;
      const tagFilter = req.query.tag || null; // v319: фильтр по тегу (имя)
      const data = await getFunnel(pipelineId, env, fromTs, toTs, tagFilter);
      // v447: фронту нужен subdomain чтобы построить правильную ссылку KZ vs KG (был захардкожен salesdoctorkz).
      data._subdomain = env.AMO_SUBDOMAIN;
      data.currency = country === 'KG' ? 'KGS' : 'KZT'; // v797: валюта сумм сделок для блока «Деньги»
      return res.status(200).json(data);
    }
    if(action === 'honest_meta_funnel'){
      // v326: ЧЕСТНАЯ воронка Meta-лидов матчингом по телефонам (не по тегам).
      // Цель — ответить «из 82 Meta-заявок реально N на встрече, M оплатили».
      const sheetId = String(req.query.sheet_id || '');
      const sheetName = String(req.query.sheet_name || 'Sheet1');
      const fromTs = req.query.from ? Number(req.query.from) : null;
      const toTs = req.query.to ? Number(req.query.to) : null;
      if(!sheetId) return bad(res, 400, 'Need ?sheet_id=...');

      // v1015: normalizePhone — общий из _phone.js (KG + KZ)

      // 1. Phones из Sheets (Meta Lead Forms)
      const csvUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(sheetName)}&range=A1:Z2000`;
      const csvResp = await fetch(csvUrl);
      const csv = csvResp.ok ? await csvResp.text() : '';
      const sheetPhones = new Set();
      csv.split('\n').forEach(line => {
        const m = line.match(/p:\+?(\d{9,12})/);
        if(m){ const p = normalizePhone(m[1], country); if(p) sheetPhones.add(p); }
      });

      // 2. Из amo за период берём ВСЕ лиды воронки «Лиды» + их теги (для marquiz cohort)
      const pipelines = await getPipelines(env);
      const p = pipelines.find(x => /^лид/i.test(x.name||'')) || pipelines[0];
      let dateFilter = '';
      if(fromTs) dateFilter += `&filter[created_at][from]=${fromTs}`;
      if(toTs) dateFilter += `&filter[created_at][to]=${toTs}`;

      const allLeadsInPeriod = [];
      for(let pg = 1; pg <= 5; pg++){
        const data = await amoFetch(`/leads?filter[pipeline_id]=${p.id}${dateFilter}&limit=250&page=${pg}&with=contacts`, env);
        if(!data) break;
        const batch = (data._embedded && data._embedded.leads) || [];
        if(!batch.length) break;
        allLeadsInPeriod.push(...batch);
        if(batch.length < 250) break;
      }

      // 3. Marquiz cohort: amo лиды за период с тегом marquiz
      const marquizLeads = allLeadsInPeriod.filter(l => {
        const tags = (l._embedded && l._embedded.tags) || [];
        return tags.some(t => /marquiz/i.test(t.name||''));
      });

      // 4. Получаем телефоны контактов для лидов (нужно для phone-matching)
      //    Контакты в lead._embedded.contacts только ID — телефоны отдельно.
      //    Чтобы быстро: для каждого Sheets phone ищем lead через amo search.

      // Stages map
      const stageById = {};
      const stageList = p.statuses.sort((a,b) => a.sort - b.sort);
      stageList.forEach(s => { stageById[s.id] = s.name; });

      function classifyStage(statusId){
        const name = stageById[statusId] || 'неизвестно';
        const low = name.toLowerCase();
        if(/закрыт.*не.*реализов/i.test(low)) return 'lost';
        if(/успешн|реализован/i.test(low) && !/не.*реализов/i.test(low)) return 'won';
        if(/счет.*оплач|оплач.*счет|оплачен.*работ/i.test(low)) return 'paid';
        if(/счет.*выставл/i.test(low)) return 'invoice';
        if(/договор/i.test(low)) return 'contract';
        if(/реквизит|реквезит/i.test(low)) return 'requisites';
        if(/встреч.*пройден|пройден.*встреч/i.test(low)) return 'meeting_done';
        if(/назначен.*встреч|встреч.*назначен/i.test(low)) return 'meeting_set';
        if(/квалифик/i.test(low)) return 'qualified';
        if(/взят/i.test(low)) return 'in_work';
        return 'other';
      }

      // 5. Для каждого Sheets-phone ищем lead через amo query
      const sheetMatched = []; // {phone, lead_id, stage_name, status}
      const sheetNotFound = [];
      let processed = 0;
      for(const phone of sheetPhones){
        if(processed >= 60) break; // safety
        processed++;
        try {
          // v426 FIX: limit=10 (было 1) — в amo часто есть дубликаты контактов на один телефон,
          // первый может быть «пустым» (просто номер вместо имени, без сделок), а сделка
          // привязана ко второму. Берём ВСЕ контакты и собираем все их leadIds.
          // Реальный кейс: +77753097316 → contact 53757004 (пустой) + contact 53757042 (Адил со сделкой).
          // С limit=1 наш код брал 53757004 и записывал лида как «потерянный» — это была ошибка.
          const r = await amoFetch(`/contacts?query=${encodeURIComponent(phone)}&limit=10&with=leads`, env);
          const contacts = (r && r._embedded && r._embedded.contacts) || [];
          if(!contacts.length){ sheetNotFound.push({phone}); continue; }
          const leadIds = [];
          for(const c of contacts){
            ((c._embedded && c._embedded.leads) || []).forEach(l => { if(!leadIds.includes(l.id)) leadIds.push(l.id); });
          }
          if(!leadIds.length){ sheetNotFound.push({phone, contact_id: contacts[0].id}); continue; }
          // Берём первую сделку — её статус
          const leadId = leadIds[0];
          // Если эта сделка из периода (есть в allLeadsInPeriod) — используем её status_id оттуда (экономим API call)
          const inPeriod = allLeadsInPeriod.find(l => l.id === leadId);
          let statusId;
          if(inPeriod){ statusId = inPeriod.status_id; }
          else {
            const lr = await amoFetch(`/leads/${leadId}`, env);
            statusId = lr.status_id;
          }
          sheetMatched.push({
            phone: phone,
            lead_id: leadId,
            stage_name: stageById[statusId] || 'неизв',
            stage_class: classifyStage(statusId)
          });
        } catch(e){
          sheetNotFound.push({phone, error: e.message});
        }
      }

      // 6. Marquiz cohort — статусы прямо из allLeadsInPeriod
      const marquizMatched = marquizLeads.map(l => ({
        lead_id: l.id,
        stage_name: stageById[l.status_id] || 'неизв',
        stage_class: classifyStage(l.status_id)
      }));

      // 7. Объединение + распределение по стадиям
      const combined = [...sheetMatched, ...marquizMatched];
      // Дедуп по lead_id чтобы не считать дважды если Sheets-phone сматчился с Marquiz-лидом
      const seen = {};
      const dedupped = combined.filter(x => { if(seen[x.lead_id]) return false; seen[x.lead_id] = 1; return true; });

      const distribution = { in_work: 0, qualified: 0, meeting_set: 0, meeting_done: 0, requisites: 0, contract: 0, invoice: 0, paid: 0, won: 0, lost: 0, other: 0 };
      dedupped.forEach(x => { distribution[x.stage_class] = (distribution[x.stage_class] || 0) + 1; });

      return res.status(200).json({
        period: { from: fromTs, to: toTs },
        sheet_phones_total: sheetPhones.size,
        sheet_phones_processed: processed,
        sheet_phones_truncated: sheetPhones.size > processed,
        sheet_matched_in_amo: sheetMatched.length,
        sheet_not_in_amo: sheetNotFound.length,
        // v424: возвращаем сам список телефонов которые НЕ попали в amo — чтобы оператор
        // мог их вытащить руками или прозвонить заново. Раньше было только число.
        sheet_not_in_amo_list: sheetNotFound.map(x => ({ phone: x.phone, contact_id: x.contact_id || null, error: x.error || null })),
        marquiz_leads_in_amo: marquizLeads.length,
        combined_cohort_total: dedupped.length,
        stage_distribution: distribution,
        message: 'Это ЧЕСТНАЯ воронка по телефонам и тегу marquiz. Если Meta-кабинет показывает больше — разница теряется на уровне Meta→Sheets интеграции (другие формы не подключены).'
      });
    }
    if(action === 'apply_meta_tags'){
      // v323: массовая простановка тега «таргет таблица» сделкам которые сматчились по телефону
      //       с Meta Sheets (ручные переносы менеджеров без тега). С dry_run для безопасности.
      const sheetId = String(req.query.sheet_id || '');
      const sheetName = String(req.query.sheet_name || 'Sheet1');
      const tagName = String(req.query.tag || 'таргет таблица');
      const dryRun = req.query.dry_run !== 'false'; // по умолчанию true
      if(!sheetId) return bad(res, 400, 'Need ?sheet_id=...');
      // v591 SEC: реальная запись тегов в amo (dry_run=false) — только с админ-кодом.
      if(!dryRun){
        const gate = checkAdminToken(req);
        if(!gate.ok) return bad(res, gate.unconfigured ? 503 : 403, gate.unconfigured ? 'apply_meta_tags недоступен: не настроен ADMIN_TOKEN' : 'Нужен админ-код (x-admin-token) для записи тегов в amo');
      }

      // 1. Читаем CSV из Sheets и извлекаем телефоны
      const csvUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(sheetName)}`;
      const csvResp = await fetch(csvUrl);
      if(!csvResp.ok) return bad(res, 502, `Sheets fetch failed: ${csvResp.status}`);
      const csv = await csvResp.text();
      // v1015: normalizePhone — общий из _phone.js (KG + KZ)
      const phones = new Set();
      csv.split('\n').forEach(line => {
        const m = line.match(/p:\+?(\d{9,12})/);
        if(m){ const p = normalizePhone(m[1], country); if(p) phones.add(p); }
      });

      // 2. Для каждого телефона ищем lead в amo (с тегами)
      const results = { matched: [], not_found: [], already_tagged: [], to_tag: [] };
      let processed = 0;
      const maxProcess = Math.min(40, phones.size); // Vercel timeout safety
      for(const phone of phones){
        if(processed >= maxProcess) break;
        processed++;
        try {
          // v426 FIX: limit=10 — собираем сделки со всех дубликатов контактов на этот номер
          // (в amo часто есть пустой контакт «77...» + настоящий с именем — сделка у второго).
          const contactsR = await amoFetch(`/contacts?query=${encodeURIComponent(phone)}&limit=10&with=leads`, env);
          const contacts = (contactsR && contactsR._embedded && contactsR._embedded.contacts) || [];
          if(!contacts.length){ results.not_found.push({phone}); continue; }
          const leadIds = [];
          for(const c of contacts){
            ((c._embedded && c._embedded.leads) || []).forEach(l => { if(!leadIds.includes(l.id)) leadIds.push(l.id); });
          }
          if(!leadIds.length){ results.not_found.push({phone, contact_id: contacts[0].id}); continue; }
          // Берём первую (главную) сделку
          const leadId = leadIds[0];
          const leadR = await amoFetch(`/leads/${leadId}?with=contacts`, env);
          const existingTags = (leadR._embedded && leadR._embedded.tags) || [];
          const hasTag = existingTags.some(t => String(t.name||'').toLowerCase() === tagName.toLowerCase());
          if(hasTag){
            results.already_tagged.push({phone, lead_id: leadId});
            continue;
          }
          results.matched.push({phone, lead_id: leadId, lead_name: leadR.name});
          results.to_tag.push({phone, lead_id: leadId});
        } catch(e){
          results.not_found.push({phone, error: e.message});
        }
      }

      // 3. Если не dry_run — реально проставляем тег
      let appliedCount = 0;
      const appliedErrors = [];
      if(!dryRun && results.to_tag.length){
        // PATCH /leads с массивом обновлений: каждая сделка получает _embedded.tags = [{name: tagName}]
        // amo не имеет single-tag append, только полная замена. Сначала получаем существующие теги.
        for(const item of results.to_tag){
          try {
            const cur = await amoFetch(`/leads/${item.lead_id}?with=contacts`, env);
            const curTags = ((cur._embedded && cur._embedded.tags) || []).map(t => ({id: t.id}));
            curTags.push({name: tagName});
            const body = JSON.stringify([{ id: item.lead_id, _embedded: { tags: curTags } }]);
            const r = await fetch(`https://${String(env.AMO_SUBDOMAIN||'').replace(/\s+/g,'')}.amocrm.ru/api/v4/leads`, {
              method: 'PATCH',
              headers: {
                'Authorization': `Bearer ${String(env.AMO_TOKEN||'').replace(/\s+/g,'')}`,
                'Content-Type': 'application/json'
              },
              body: body
            });
            if(r.ok){ appliedCount++; }
            else { appliedErrors.push({lead_id: item.lead_id, status: r.status}); }
          } catch(e){
            appliedErrors.push({lead_id: item.lead_id, error: e.message});
          }
        }
      }

      return res.status(200).json({
        sheet: { id: sheetId, name: sheetName },
        tag: tagName,
        dry_run: dryRun,
        phones_total: phones.size,
        phones_processed: processed,
        truncated: phones.size > processed,
        matched_count: results.matched.length,
        already_tagged_count: results.already_tagged.length,
        not_found_count: results.not_found.length,
        to_tag_count: results.to_tag.length,
        applied_count: appliedCount,
        applied_errors: appliedErrors,
        matched_sample: results.matched.slice(0, 10),
        not_found_sample: results.not_found.slice(0, 10),
        message: dryRun
          ? `DRY RUN: будет помечено ${results.to_tag.length} сделок тегом «${tagName}». Запусти с &dry_run=false чтобы применить.`
          : `Применено: тег «${tagName}» к ${appliedCount} сделкам. Ошибок: ${appliedErrors.length}.`
      });
    }
    if(action === 'data_quality'){
      // v428: проверка «грязи» в amo для блока «Качество данных» дашборда.
      // Цель — показать оператору конкретные точки для чистки:
      //   1) Дубликаты контактов: один номер → несколько контактов в amo.
      //      Реальный кейс: +77753097316 → contact 53757004 (пустой) + 53757042 (Адил).
      //   2) Подозрительные номера: длина не 10 (без 7) и не 11 (с 7) → ввели с опечаткой.
      //      Реальный кейс: «Мансур» с +7747967614 (10 цифр, пропущена вторая 7).
      // Метод: тянем контакты постранично (до 5 стр = 1250), нормализуем телефоны,
      // группируем. Передачи периода нет — баг качества данных не зависит от периода.
      function normPhone(raw){
        const digits = String(raw||'').replace(/\D/g, '');
        if(!digits) return '';
        // Казахстан: 8XXXXXXXXXX → 7XXXXXXXXXX, 10 цифр (без кода) → добавим 7 для группировки
        let n = digits;
        if(n.length === 11 && n[0] === '8') n = '7' + n.slice(1);
        return n;
      }
      const phoneIndex = new Map(); // norm → [{ contact_id, contact_name, raw_phone, has_lead }]
      const badPhones = []; // длина не 10/11
      let pagesFetched = 0;
      let totalContacts = 0;
      let truncated = false;
      for(let page = 1; page <= 5; page++){
        try {
          const data = await amoFetch(`/contacts?with=leads&order[updated_at]=desc&limit=250&page=${page}`, env);
          if(!data) break;
          const batch = (data._embedded && data._embedded.contacts) || [];
          if(!batch.length) break;
          pagesFetched++;
          totalContacts += batch.length;
          batch.forEach(c => {
            const phoneField = (c.custom_fields_values || []).find(f => f.field_code === 'PHONE');
            const rawPhones = phoneField ? (phoneField.values || []).map(v => v.value).filter(Boolean) : [];
            const hasLead = !!((c._embedded && c._embedded.leads) || []).length;
            rawPhones.forEach(rp => {
              const n = normPhone(rp);
              if(!n) return;
              // v1015: подозрительный — тот, что не разбирается ни как кыргызский (996…),
              // ни как казахстанский (7…). Раньше все KG-номера (12 цифр) числились опечатками.
              const norm = normalizePhone(rp, country);
              if(norm === null){
                badPhones.push({ contact_id: c.id, contact_name: c.name, raw_phone: rp, normalized: n, length: n.length });
              }
              const key = norm || n; // группируем по разобранному номеру: 0555… и +996555… — один человек
              if(!phoneIndex.has(key)) phoneIndex.set(key, []);
              phoneIndex.get(key).push({
                contact_id: c.id,
                contact_name: c.name || '',
                raw_phone: rp,
                has_lead: hasLead
              });
            });
          });
          if(batch.length < 250) break;
          if(page === 5 && batch.length === 250) truncated = true;
        } catch(e){
          // v1015: ошибка amo — 502 с кодом (amo_auth/amo_error), а не 500
          if(e.upstream === 'amo') return res.status(502).json({ error: 'fetch contacts failed page ' + page + ': ' + e.message, code: (e.status === 401 || e.status === 403) ? 'amo_auth' : 'amo_error' });
          return res.status(500).json({ error: 'fetch contacts failed page ' + page + ': ' + e.message });
        }
      }
      // Дубликаты: ключи где >1 контакта
      const duplicateContacts = [];
      phoneIndex.forEach((arr, key) => {
        // Дедуп по contact_id (один контакт может иметь несколько телефонов которые после нормализации совпадают)
        const uniqIds = {};
        arr.forEach(x => { if(!uniqIds[x.contact_id]) uniqIds[x.contact_id] = x; });
        const uniqArr = Object.values(uniqIds);
        if(uniqArr.length > 1){
          duplicateContacts.push({
            phone: '+' + key,
            count: uniqArr.length,
            contacts: uniqArr.map(x => ({
              id: x.contact_id, name: x.contact_name, raw_phone: x.raw_phone, has_lead: x.has_lead
            }))
          });
        }
      });
      duplicateContacts.sort((a, b) => b.count - a.count);
      // Подозрительные номера: дедуп по contact_id
      const badByContact = {};
      badPhones.forEach(b => { badByContact[b.contact_id] = b; });
      const badList = Object.values(badByContact).sort((a, b) => a.length - b.length);

      return res.status(200).json({
        contacts_scanned: totalContacts,
        pages_fetched: pagesFetched,
        truncated: truncated,
        duplicate_contacts_count: duplicateContacts.length,
        duplicate_contacts: duplicateContacts.slice(0, 100),
        bad_phones_count: badList.length,
        bad_phones: badList.slice(0, 100),
        message: 'Проверка контактов amo. Дубликаты — телефоны на которые в amo несколько карточек. Подозрительные номера — короче/длиннее обычного, скорее всего опечатка.',
        // v447: subdomain для корректных ссылок на контакты KZ vs KG
        _subdomain: env.AMO_SUBDOMAIN
      });
    }
    if(action === 'lead_path'){
      // v897: полный путь одной сделки — когда завели, кто вёл, через какие этапы прошла
      // и сколько на каждом просидела. Нужен для экрана «Маркетинг»: CEO хочет открыть
      // лид по названию и увидеть его историю, а не только текущий этап.
      const leadId = Number(req.query.id || 0);
      if(!leadId) return bad(res, 400, 'Need ?id=LEAD_ID');
      const lead = await amoFetch(`/leads/${leadId}`, env);
      if(!lead || !lead.id) return bad(res, 404, 'Сделка не найдена');

      const pipelines = await getPipelines(env);
      const pipe = pipelines.find(x => x.id === lead.pipeline_id) || null;
      const stName = {};
      pipelines.forEach(pl => pl.statuses.forEach(st => { stName[st.id] = st.name; }));

      const userNameById = {};
      try {
        for(let up = 1; up <= 5; up++){
          const ud = await amoFetch(`/users?limit=250&page=${up}`, env);
          const arr = (ud && ud._embedded && ud._embedded.users) || [];
          arr.forEach(u => { userNameById[u.id] = u.name; });
          if(arr.length < 250) break;
        }
      } catch(_){}

      const steps = [];
      let eventsError = null;
      try {
        for(let page = 1; page <= 10; page++){
          const ev = await amoFetch(`/events?filter[entity]=lead&filter[entity_id][]=${leadId}&filter[type][]=lead_status_changed&limit=100&page=${page}`, env);
          if(!ev) break;
          const batch = (ev._embedded && ev._embedded.events) || [];
          if(!batch.length) break;
          batch.forEach(e => {
            const before = (e.value_before && e.value_before[0] && e.value_before[0].lead_status) || null;
            const after = (e.value_after && e.value_after[0] && e.value_after[0].lead_status) || null;
            if(!after) return;
            steps.push({
              at: e.created_at,
              from: before ? (stName[before.id] || null) : null,
              to: stName[after.id] || String(after.id),
              by: userNameById[e.created_by] || (e.created_by ? ('id ' + e.created_by) : 'программа')
            });
          });
          if(batch.length < 100) break;
        }
      } catch(e){ eventsError = e.message || String(e); }
      steps.sort((a, b) => a.at - b.at);
      // Сколько сделка просидела на каждом этапе: до следующего шага, а последний — до сих пор.
      const now = Math.floor(Date.now()/1000);
      steps.forEach((st, i) => { st.held = (i + 1 < steps.length ? steps[i+1].at : now) - st.at; });

      const byRobot = !Number(lead.created_by);
      const sub = String(env.AMO_SUBDOMAIN || '').replace(/\s+/g, '');
      return res.status(200).json({
        country: country,
        lead: {
          id: lead.id,
          name: lead.name || '(без названия)',
          price: Number(lead.price) || 0,
          created: lead.created_at,
          updated: lead.updated_at,
          closed: lead.closed_at || null,
          manager: userNameById[lead.responsible_user_id] || '—',
          created_by_name: byRobot ? 'интеграция' : (userNameById[lead.created_by] || ('id ' + lead.created_by)),
          origin: byRobot ? 'auto' : 'manual',
          stage: stName[lead.status_id] || '—',
          is_won: Number(lead.status_id) === 142,
          is_lost: Number(lead.status_id) === 143,
          pipeline: pipe ? pipe.name : null,
          tags: ((lead._embedded && lead._embedded.tags) || []).map(t => t.name).filter(Boolean),
          url: `https://${sub}.amocrm.ru/leads/detail/${lead.id}`
        },
        steps: steps,
        events_error: eventsError
      });
    }
    if(action === 'targ_plan' || action === 'targ_sync'){
      // v928: кто привёл человека — Ибрагим или Дастан.
      // Цепочка: человек кликает рекламу → попадает в WhatsApp с подставленным текстом,
      // где стоит ссылка на пост → по ссылке находим объявление → у объявления свой
      // кабинет → у кабинета вписано имя таргетолога → по телефону находим сделку.
      // Другого следа у переписок нет: официальную метку Meta (ctwa_clid) отдаёт только
      // WhatsApp Business API, а наш номер подключён по QR — 0 меток из 52 сообщений.
      //
      // Правила счёта (решения CEO 09.09.2026):
      //   • сделка засчитывается, даже если заведена ДО рекламы — человек вернулся,
      //     реклама сработала. Такое касание помечаем «возврат клиента»;
      //   • спорный лид (кликал обоих) достаётся ПОСЛЕДНЕМУ касанию — это решается
      //     при построении отчёта, здесь просто пишем все касания;
      //   • один пост крутится в нескольких объявлениях → берём то, у которого был
      //     расход в день обращения. Если таких несколько — честно помечаем ad_ambiguous.
      //
      // Касания храним в своей таблице ad_touches: тег в amo не помнит ни дату касания,
      // ни объявление, ни кампанию, а деньги считать надо именно по ним.
      // Теги в amo — отдельно, для менеджеров, и только с админ-кодом.
      const days = Math.min(Math.max(Number(req.query.days || 30), 1), 180);
      const maxPhones = Math.min(Math.max(Number(req.query.limit || 60), 1), 200);
      const dryRunRaw = String(req.query.dry_run == null ? '1' : req.query.dry_run);
      const dryRun = dryRunRaw !== '0' && dryRunRaw !== 'false';
      const writeTags = String(req.query.tags || '') === '1' && !dryRun;
      // Права разведены намеренно: складывать касания в СВОЮ таблицу — обычная работа
      // отчёта, а вот менять теги в amoCRM (чужие данные, видят менеджеры) — только
      // с админ-кодом CEO.
      if(writeTags){
        const gate = checkAdminToken(req);
        if(!gate.ok) return bad(res, gate.unconfigured ? 503 : 403,
          gate.unconfigured ? 'targ_sync: не настроен ADMIN_TOKEN' : 'Нужен админ-код (x-admin-token), чтобы ставить теги в amoCRM');
      }

      // 1) Имена таргетологов по кабинетам — из тех же настроек, что и карточки на дашборде.
      let targByAcc = {};
      try {
        const rows = await sbSelect('app_settings', { key: 'eq.mkt_targetologs', limit: '1' });
        targByAcc = (rows.length && rows[0].value) || {};
      } catch(_){ targByAcc = {}; }
      const nameForAcc = (acc) => targByAcc[acc] || targByAcc[String(acc).replace(/^act_/, '')] || null;

      const base = selfBase(req);
      const tsErrors = [], tsIncomplete = []; // v1015: никаких тихих нулей
      if(days > 31) tsIncomplete.push({ source: 'meta', what: 'ads_perf', detail: 'расход по дням взят за последние 31 день из ' + days });

      // 2) Карта «пост → объявления» и расход объявлений по дням (для правила «что крутилось в тот день»).
      // v1015: дни — по поясу страны (KG — Бишкек), расход по дням тоже в бишкекских днях (v=2).
      const until = localIso(Date.now(), country);
      // v1015: расход по дням нужен только для выбора объявления — не больше 31 дня,
      // иначе почасовой пересчёт кабинета Лос-Анджелеса не уложится по времени
      const perfDays = Math.min(days, 31);
      const sinceIso = localIso(Date.now() - perfDays * 86400000, country);
      const [adsR, perfR] = await Promise.all([
        selfFetch(base, '/api/meta-ads?endpoint=ads_map'),
        selfFetch(base, `/api/meta-ads?endpoint=ads_perf&daily=1&since=${sinceIso}&until=${until}&country=${country}&v=2`)
      ]);
      const adsJson = adsR.json, perfJson = selfFailed(perfR) ? null : perfR.json;
      if(selfFailed(adsR) || !Array.isArray(adsJson.ads)) return res.status(502).json({ error: 'Не удалось получить карту объявлений (ads_map): ' + ((adsJson && adsJson.error) || adsR.status), code: (adsJson && adsJson.code) || 'meta_error' });
      ((adsJson.errors) || []).forEach(e => tsErrors.push(e));
      if(!perfJson){
        tsErrors.push({ source: 'meta', kind: 'other', code: perfR.json && perfR.json.code, message: 'расход по дням: ' + ((perfR.json && perfR.json.error) || perfR.status) });
        tsIncomplete.push({ source: 'meta', what: 'ads_perf', detail: 'без расхода по дням объявление выбрано по первому совпадению' });
      }
      const spendByAdDay = {}, kindByAdDay = {};
      ((perfJson && perfJson.days) || []).forEach(d => {
        spendByAdDay[d.ad_id + '|' + d.date] = d.spend;
        kindByAdDay[d.ad_id + '|' + d.date] = d.result_kind || null;
      });

      const byShort = {}, byStory = {}, byPost = {}, byText = {};
      const push = (map, key, ad) => { if(!key) return; (map[key] = map[key] || []).push(ad); };
      // v954: узнаём объявление и по ТЕКСТУ первого сообщения, когда ссылки нет —
      // человек мог её стереть. Тексты кнопок берём из кабинета (ice_breakers, автотекст),
      // плюс ручная привязка из настроек mkt_text_codes: { "демо": "act_…" }.
      const normText = (v) => String(v || '').toLowerCase().replace(/[^a-zа-яё0-9]+/gi, ' ').trim();
      adsJson.ads.forEach(a => {
        push(byShort, a.ig_shortcode, a);
        push(byStory, a.story_id, a);
        push(byPost, a.post_id, a);
        const w = a.welcome; if(!w) return;
        const tf = w.text_format || {}; const msg = tf.message || {};
        const texts = [];
        (msg.ice_breakers || []).forEach(x => texts.push(x.title || x.question || x.text));
        [msg.autofill_message, tf.autofill_message].forEach(x => { if(x && x.content) texts.push(x.content); });
        texts.forEach(t => push(byText, normText(t), a));
      });
      let textCodes = {};
      try {
        const rows = await sbSelect('app_settings', { key: 'eq.mkt_text_codes', limit: '1' });
        textCodes = (rows.length && rows[0].value) || {};
      } catch(_){}
      Object.keys(textCodes).forEach(k => {
        const acc = String(textCodes[k] || '');
        const ads = adsJson.ads.filter(a => a.account === acc && String(a.dest || '').toUpperCase() === 'WHATSAPP');
        if(ads.length) byText[normText(k)] = ads;
        else if(acc) byText[normText(k)] = [{ ad_id: null, ad_name: null, campaign_id: null, campaign: null, account: acc }];
      });

      // Из нескольких объявлений с одним постом выбираем так:
      //   1) крутилось ли оно в день обращения (был расход);
      //   2) ведёт ли оно в переписку. Человек написал в WhatsApp — значит объявление
      //      с лидформой его привести не могло, там другая кнопка. Без этого шага
      //      переписки приписывались кампании IH_Лидформы, чего в жизни не бывает.
      function pickAd(list, dayIso, wantChat){
        if(!list || !list.length) return null;
        if(list.length === 1) return { ad: list[0], ambiguous: false };
        let live = list.filter(a => (spendByAdDay[a.ad_id + '|' + dayIso] || 0) > 0);
        if(!live.length) live = list.slice();
        if(wantChat){
          // v938: сначала по настройке группы (куда ведёт объявление), потом по факту дня.
          const wa = live.filter(a => String(a.dest || '').toUpperCase() === 'WHATSAPP');
          const chat = wa.length ? wa : live.filter(a => kindByAdDay[a.ad_id + '|' + dayIso] === 'Начало переписки');
          if(chat.length) live = chat;
        }
        if(live.length === 1) return { ad: live[0], ambiguous: false };
        live.sort((x, y) => (spendByAdDay[y.ad_id + '|' + dayIso] || 0) - (spendByAdDay[x.ad_id + '|' + dayIso] || 0));
        return { ad: live[0], ambiguous: true };
      }

      // 3) Переписки из приёмника Wazzup: ссылка на объявление лежит в первом сообщении.
      const since = new Date(Date.now() - days * 86400000).toISOString();
      const events = await sbSelect('wazzup_events', {
        received_at: 'gte.' + since, order: 'received_at.asc', limit: 2000
      });
      // v1015: упёрлись в потолок — свежие переписки не просмотрены (порядок чиним на этапе B)
      if(events.length >= 2000) tsIncomplete.push({ source: 'db', what: 'chats', detail: 'просмотрены первые 2000 сообщений' });

      const shortCache = {};
      async function expandFbMe(code){
        if(shortCache[code] !== undefined) return shortCache[code];
        let out = null;
        try {
          const r = await fetch('https://fb.me/' + code, { redirect: 'manual' });
          const loc = r.headers.get('location') || '';
          const story = loc.match(/story_fbid=(\d+)/);
          const pid = loc.match(/[?&]id=(\d+)/);
          if(story) out = { post: story[1], page: pid ? pid[1] : null };
        } catch(_){ out = null; }
        shortCache[code] = out;
        return out;
      }

      const touches = [], noLink = [];
      for(const e of events){
        if(e.kind !== 'message' || e.direction === 'out') continue;
        const txt = String(e.message_text || '');
        const phone = e.phone ? String(e.phone) : null;
        if(!phone || phone.length > 15) continue; // групповые чаты приходят длинным id
        const dayIso = localIso(Date.parse(e.received_at), country); // v1015: день по Бишкеку, а не по UTC
        let list = null, src = null;
        const ig = txt.match(/instagram\.com\/(?:p|reel|tv)\/([A-Za-z0-9_-]+)/);
        const fb = txt.match(/fb\.me\/([A-Za-z0-9]+)/);
        if(e.ad_source_id){ // официальная метка Meta — если после переезда на WABA она пойдёт
          const a = adsJson.ads.filter(x => String(x.ad_id) === String(e.ad_source_id));
          if(a.length){ list = a; src = 'метка Meta ' + e.ad_source_id; }
        }
        if(!list && ig){ list = byShort[ig[1]] || null; src = 'instagram.com/p/' + ig[1]; }
        if(!list && fb){
          const ex = await expandFbMe(fb[1]);
          if(ex) list = byStory[(ex.page || '') + '_' + ex.post] || byPost[ex.post] || null;
          src = 'fb.me/' + fb[1];
        }
        if(!src){
          const k = normText(txt.split('\n')[0]);
          const byT = k ? byText[k] : null;
          // текст должен указывать на ОДИН кабинет, иначе это не метка
          if(byT && byT.length && new Set(byT.map(a => a.account)).size === 1){ list = byT; src = 'текст «' + txt.split('\n')[0].slice(0, 40) + '»'; }
        }
        if(!src) continue;
        const picked = pickAd(list, dayIso, true);
        if(!picked){ noLink.push({ phone, at: e.received_at, link: src, why: 'объявления с такой ссылкой в кабинетах нет' }); continue; }
        touches.push({ message_id: e.message_id || (phone + '@' + e.received_at), phone, at: e.received_at, link: src,
          ad: picked.ad, ambiguous: picked.ambiguous });
      }

      // 4) Телефон → сделка. Берём ту, что ближе всего по времени к рекламе: обычно она
      //    создаётся через секунды после обращения, но если человек уже был в работе —
      //    засчитываем его старую сделку и помечаем это как возврат клиента.
      const leadCache = new Map();
      const rowsToSave = [], skipped = [], notFound = [];
      let processed = 0;
      for(const t of touches){
        if(processed >= maxPhones){ tsIncomplete.push({ source: 'amo', what: 'touches', detail: 'обработано ' + processed + ' из ' + touches.length }); break; }
        processed++;
        const acc = t.ad.account;
        const targ = nameForAcc(acc);
        if(!targ){ skipped.push({ phone: t.phone, why: 'у кабинета ' + acc + ' не вписано имя таргетолога' }); continue; }
        const adTs = Math.floor(new Date(t.at).getTime() / 1000);
        let found = leadCache.get(t.phone);
        if(found === undefined){
          let contacts = [];
          try {
            const tail = t.phone.length > 9 ? t.phone.slice(-9) : t.phone;
            const r = await amoFetch(`/contacts?query=${encodeURIComponent(tail)}&limit=10&with=leads`, env);
            contacts = (r && r._embedded && r._embedded.contacts) || [];
          } catch(e){ skipped.push({ phone: t.phone, why: 'поиск в amo не удался: ' + e.message }); leadCache.set(t.phone, null); continue; }
          const ids = [];
          contacts.forEach(c => ((c._embedded && c._embedded.leads) || []).forEach(l => { if(!ids.includes(l.id)) ids.push(l.id); }));
          // v1015: сделки одним запросом, а не по одной
          const lb = ids.length ? (await fetchLeadsByIds(env, ids.slice(0, 8), '', null)).leads : {};
          const leads = ids.slice(0, 8).map(id => lb[id]).filter(Boolean);
          found = { contact_id: contacts.length ? contacts[0].id : null, contact_name: contacts.length ? contacts[0].name : null, leads };
          leadCache.set(t.phone, found);
        }
        if(!found || !found.leads.length){
          notFound.push({ phone: t.phone, at: t.at, targetolog: targ, campaign: t.ad.campaign,
            contact_id: (found && found.contact_id) || null, contact_name: (found && found.contact_name) || null,
            why: (found && found.contact_id) ? 'контакт есть, сделки нет' : 'ни контакта, ни сделки' });
          continue;
        }
        const best = found.leads.slice().sort((a, b) =>
          Math.abs(Number(a.created_at || 0) - adTs) - Math.abs(Number(b.created_at || 0) - adTs))[0];
        const gap = Math.abs(Number(best.created_at || 0) - adTs);
        rowsToSave.push({
          country: country, message_id: t.message_id, phone: t.phone,
          touched_at: t.at, account: acc, targetolog: targ,
          campaign_id: t.ad.campaign_id || null, campaign: t.ad.campaign || null,
          ad_id: t.ad.ad_id || null, ad_name: t.ad.ad_name || null,
          ad_ambiguous: !!t.ambiguous, link: t.link, source: 'wazzup_link',
          lead_id: best.id, contact_id: found.contact_id,
          lead_created: new Date(Number(best.created_at || 0) * 1000).toISOString(),
          _lead_name: best.name, _returning: gap > 7 * 86400,
          _tags: ((best._embedded && best._embedded.tags) || []).map(x => String(x.name || ''))
        });
      }

      // 5) Запись. Касания в свою таблицу — по одному на сообщение, повторный прогон дублей не плодит.
      let saved = 0; const saveErrors = [];
      let tagged = 0; const tagErrors = [];
      if(!dryRun){
        const clean = rowsToSave.map(r => {
          const c = Object.assign({}, r);
          delete c._lead_name; delete c._returning; delete c._tags;
          return c;
        });
        try {
          if(clean.length) await sbInsertIgnoreDup('ad_touches', clean, 'country,message_id');
          saved = clean.length;
        } catch(e){ saveErrors.push(e.message || String(e)); }

        // Тег в amo — по отдельной команде: он нужен менеджерам в карточке сделки,
        // на расчёты дашборда не влияет. amo умеет только заменять список тегов целиком.
        if(writeTags){
          const done = new Set();
          for(const r of rowsToSave){
            const tag = 'таргет-' + String(r.targetolog).trim().toLowerCase().replace(/\s+/g, '-');
            const key = r.lead_id + '|' + tag;
            if(done.has(key)) continue;
            done.add(key);
            if(r._tags.some(x => x.toLowerCase() === tag)) continue;
            try {
              const cur = await amoFetch(`/leads/${r.lead_id}`, env);
              const keep = ((cur._embedded && cur._embedded.tags) || []).map(x => ({ id: x.id }));
              keep.push({ name: tag });
              await amoMutate('PATCH', `/leads/${r.lead_id}`, { _embedded: { tags: keep } }, env);
              tagged++;
            } catch(e){ tagErrors.push({ lead_id: r.lead_id, error: e.message }); }
          }
        }
      }

      return res.status(200).json({
        country, days, dry_run: dryRun, write_tags: writeTags,
        cabinets: (adsJson.cabinets || []).map(c => ({ account: c.account, targetolog: nameForAcc(c.account), ads: c.ads || 0, ok: c.ok })),
        chats_with_ad_link: touches.length,
        matched: rowsToSave.length,
        returning_clients: rowsToSave.filter(r => r._returning).length,
        ambiguous_ads: rowsToSave.filter(r => r.ad_ambiguous).length,
        saved, save_errors: saveErrors,
        tagged, tag_errors: tagErrors,
        touches: rowsToSave.map(r => ({
          at: r.touched_at, phone: r.phone, targetolog: r.targetolog,
          campaign: r.campaign, ad_name: r.ad_name, ad_ambiguous: r.ad_ambiguous,
          lead_id: r.lead_id, lead_name: r._lead_name, lead_created: r.lead_created,
          returning: r._returning, tags_now: r._tags
        })),
        ad_link_no_deal: notFound,
        skipped: skipped,
        link_unknown: noLink,
        errors: tsErrors, incomplete: tsIncomplete,
        message: dryRun
          ? `Ничего не записано. Готово к сохранению: ${rowsToSave.length} касаний. Применить — dry_run=false (и tags=1, если ставить теги в amo).`
          : `Сохранено касаний: ${saved}. Тегов проставлено: ${tagged}.`
      });
    }
    if(action === 'targ_forms'){
      // v931: второй канал разметки — заявки с лидформ.
      // Переписки узнаём по ссылке на пост, а лидформа ссылки не присылает: человек
      // заполняет форму внутри Facebook, и в amoCRM сделка приходит как «Facebook №…».
      // Зато сама Meta отдаёт такую заявку вместе с номером объявления и телефоном —
      // по телефону и находим сделку. Телефоны наружу не отдаём: APP_TOKEN публичный,
      // поэтому вся работа с ними идёт здесь, на сервере.
      const days = Math.min(Math.max(Number(req.query.days || 30), 1), 90);
      const dryRunRaw = String(req.query.dry_run == null ? '1' : req.query.dry_run);
      const dryRun = dryRunRaw !== '0' && dryRunRaw !== 'false';
      const sinceTs = Math.floor(Date.now() / 1000) - days * 86400;
      const fullPhones = !!(req.headers['x-admin-token'] && checkAdminToken(req).ok);

      // v931.3: отдельный доступ для заявок. Страница с лидформами лежит в другом
      // бизнес-портфолио, поэтому у неё свой системный пользователь (salesdoc-leads)
      // и свой токен. Основной META_ACCESS_TOKEN не трогаем — на нём держится
      // вся статистика расхода.
      const TOKEN = String(process.env.META_LEADS_TOKEN || process.env.META_ACCESS_TOKEN || '').trim();
      if(!TOKEN) return bad(res, 500, 'META_LEADS_TOKEN не задан');
      async function metaGet(path, params, tokenOverride){
        const qs = new URLSearchParams(Object.assign({ access_token: tokenOverride || TOKEN }, params || {}));
        const r = await fetch(`https://graph.facebook.com/v21.0${path}?${qs.toString()}`);
        const j = await r.json().catch(() => null);
        if(!r.ok || (j && j.error)){
          const e = new Error(((j && j.error && j.error.message) || ('Meta ' + r.status)));
          e.code = (j && j.error && j.error.code) || r.status;
          throw e;
        }
        return j;
      }

      // Кто ведёт какой кабинет + список объявлений (у карты нет персональных данных).
      let targByAcc = {};
      try {
        const rows = await sbSelect('app_settings', { key: 'eq.mkt_targetologs', limit: '1' });
        targByAcc = (rows.length && rows[0].value) || {};
      } catch(_){ targByAcc = {}; }
      const nameForAcc = (acc) => targByAcc[acc] || targByAcc[String(acc).replace(/^act_/, '')] || null;

      const base = selfBase(req);
      const tfErrors = [], tfIncomplete = []; // v1015
      const adsR = await selfFetch(base, '/api/meta-ads?endpoint=ads_map');
      const adsJson = adsR.json;
      if(selfFailed(adsR) || !Array.isArray(adsJson.ads)) return res.status(502).json({ error: 'Не удалось получить список объявлений: ' + ((adsJson && adsJson.error) || adsR.status), code: (adsJson && adsJson.code) || 'meta_error' });
      (adsJson.errors || []).forEach(e => tfErrors.push(e));

      // Тянем заявки по каждому объявлению. Meta хранит их 90 дней.
      const phoneKeys = /phone|тел|номер/i;
      const raw = [], adErrors = [];
      let scanned = 0, okCount = 0, errCount = 0;
      // v931.6: спрашиваем заявки у САМИХ ФОРМ, а не у каждого объявления.
      // Форма принадлежит Странице, к которой у нас есть доступ; объявлений же 167,
      // часть из них крутится со страниц, куда доступа нет, и они шумят ошибками.
      const adById = {};
      adsJson.ads.forEach(a => { adById[a.ad_id] = a; });
      const forms = {};
      adsJson.ads.forEach(a => { if(a.form_id && !forms[a.form_id]) forms[a.form_id] = a; });
      // v931.7: часть объявлений номер формы не отдаёт (динамические креативы), и такие
      // заявки терялись — например весь сентябрь у Ибрагима. Поэтому спрашиваем полный
      // список форм у самой Страницы, а кабинет потом берём по ad_id каждой заявки.
      const pages = [...new Set(adsJson.ads.map(a => a.page_id).filter(Boolean))];
      const pageInfo = [];
      const pageTokens = {};
      for(const pg of pages){
        let added = 0, err = null, tok = null;
        try {
          // Формы принадлежат Странице, и Graph отдаёт их только по токену самой Страницы.
          const pt = await metaGet(`/${pg}`, { fields: 'access_token,name' });
          tok = (pt && pt.access_token) || null;
          if(tok) pageTokens[pg] = tok;
        } catch(e){ err = 'токен страницы: ' + e.message; }
        try {
          const r = await metaGet(`/${pg}/leadgen_forms`, { fields: 'id,name', limit: 200 }, tok);
          ((r && r.data) || []).forEach(fm => {
            if(!forms[fm.id]){
              forms[fm.id] = { ad_name: fm.name || null, ad_id: null, campaign: null,
                campaign_id: null, account: null, page_id: pg };
              added++;
            }
          });
        } catch(e){ err = (err ? err + ' | ' : '') + e.message; }
        pageInfo.push({ page: pg, forms_added: added, error: err });
        if(err) tfErrors.push({ source: 'meta', kind: /190/.test(err) ? 'token' : 'perm', message: 'страница ' + pg + ': ' + String(err).slice(0, 200) });
      }
      const targets = Object.keys(forms).length
        ? Object.keys(forms).map(fid => ({ kind: 'form', id: fid, ad: forms[fid] }))
        : adsJson.ads.map(a => ({ kind: 'ad', id: a.ad_id, ad: a }));
      if(targets.length > 250) tfIncomplete.push({ source: 'meta', what: 'forms', detail: 'просмотрено 250 форм из ' + targets.length });
      for(const t of targets){
        if(scanned >= 250) break;
        scanned++;
        let page = null;
        try {
          page = await metaGet(`/${t.id}/leads`, {
            fields: 'id,created_time,ad_id,ad_name,campaign_id,campaign_name,form_id,field_data',
            filtering: JSON.stringify([{ field: 'time_created', operator: 'GREATER_THAN', value: sinceTs }]),
            limit: 200
          }, pageTokens[t.ad && t.ad.page_id]);
          okCount++;
          // v1015: заявок больше 200 — листаем дальше (только чтение), с потолком
          let next = page && page.paging && page.paging.next;
          for(let pn = 0; next && pn < 10; pn++){
            const r = await fetch(next);
            const j = await r.json().catch(() => null);
            if(!r.ok || !j || j.error) throw Object.assign(new Error((j && j.error && j.error.message) || ('Meta ' + r.status)), { code: (j && j.error && j.error.code) || r.status });
            page.data = (page.data || []).concat(j.data || []);
            next = j.paging && j.paging.next;
          }
          if(next) tfIncomplete.push({ source: 'meta', what: 'form_leads', detail: 'форма ' + t.id + ': показаны первые 2200 заявок' });
        } catch(e){
          errCount++;
          if(adErrors.length < 5) adErrors.push({ kind: t.kind, id: t.id, name: t.ad.ad_name, code: e.code, error: e.message });
          if(Number(e.code) === 190) tfErrors.push({ source: 'meta', code: 190, kind: 'token', message: 'заявки лидформ: ' + e.message });
          continue;
        }
        ((page && page.data) || []).forEach(l => {
          let phone = '', fname = '';
          ((l.field_data) || []).forEach(f => {
            if(!phone && phoneKeys.test(String(f.name || ''))) phone = String((f.values || [])[0] || '');
            if(!fname && /name|имя|фио/i.test(String(f.name || ''))) fname = String((f.values || [])[0] || '');
          });
          const digits = phone.replace(/\D/g, '');
          if(digits.length < 9) return;
          // Кабинет берём у объявления, которое привело заявку: одна форма может
          // стоять в объявлениях разных кампаний.
          const src = adById[l.ad_id] || t.ad;
          if(!src || !src.account) return; // кабинет неизвестен — приписать некому
          raw.push({ lead: l.id, at: l.created_time, phone: digits, fname: fname, form_id: l.form_id || t.id,
            ad_id: l.ad_id || src.ad_id, ad_name: l.ad_name || src.ad_name,
            campaign_id: l.campaign_id || src.campaign_id, campaign: l.campaign_name || src.campaign,
            account: src.account });
        });
      }

      // По телефону ищем сделку — так же, как в переписках.
      // v1015 (инцидент с частотой запросов): один поиск контакта на номер, не больше
      // maxSearch поисков за запрос; сделки всех найденных — пачками по 50, а не по одной.
      const rowsToSave = [], notFound = [], skipped = [];
      const seen = new Set();
      const maxSearch = Math.min(Math.max(Number(req.query.limit || 100), 1), 150);
      const byTail = new Map();
      const todo = [];
      let searches = 0, capped = 0;
      for(const f of raw){
        if(seen.has(f.lead)) continue;
        seen.add(f.lead);
        const targ = nameForAcc(f.account);
        if(!targ){ skipped.push({ ad: f.ad_name, why: 'у кабинета ' + f.account + ' не вписано имя таргетолога' }); continue; }
        // v957: ищем по ХВОСТУ номера. В форме телефон приходит как +996555…, а менеджер
        // в amo сохраняет «0555…» или «555…» — полный номер не совпадал, и живые
        // заявки числились «нет в CRM». Последние 9 цифр одинаковы в любом формате.
        const tail = f.phone.length > 9 ? f.phone.slice(-9) : f.phone;
        if(!byTail.has(tail)){
          if(searches >= maxSearch){ capped++; continue; }
          searches++;
          try {
            const r = await amoFetch(`/contacts?query=${encodeURIComponent(tail)}&limit=10&with=leads`, env);
            byTail.set(tail, (r && r._embedded && r._embedded.contacts) || []);
          } catch(e){
            if(Number(e.status) === 401 || Number(e.status) === 403 || e.status === 0) throw e;
            skipped.push({ ad: f.ad_name, why: 'поиск в amo не удался: ' + e.message });
            byTail.set(tail, null);
            continue;
          }
        }
        if(byTail.get(tail) === null) continue;
        todo.push({ f, targ, tail });
      }
      if(capped) tfIncomplete.push({ source: 'amo', what: 'contacts', detail: 'не проверено заявок: ' + capped });
      const idsOfTail = (tail) => {
        const ids = [];
        (byTail.get(tail) || []).forEach(c => ((c._embedded && c._embedded.leads) || []).forEach(l => { if(!ids.includes(l.id)) ids.push(l.id); }));
        return ids.slice(0, 8);
      };
      const allIds = new Set();
      todo.forEach(x => idsOfTail(x.tail).forEach(id => allIds.add(id)));
      const leadById = allIds.size ? (await fetchLeadsByIds(env, allIds, '', null)).leads : {};
      for(const { f, targ, tail } of todo){
        const adTs = Math.floor(new Date(f.at).getTime() / 1000);
        const contacts = byTail.get(tail) || [];
        const leads = idsOfTail(tail).map(id => leadById[id]).filter(Boolean);
        if(!leads.length){
          notFound.push({ at: f.at, targetolog: targ, campaign: f.campaign, ad_name: f.ad_name,
            form_id: f.form_id || null, campaign_id: f.campaign_id || null, // v1015: для продукта
            name: f.fname || '', phone_masked: f.phone.slice(0, 3) + ' ••• ' + f.phone.slice(-4), phone_tail: f.phone.slice(-4),
            phone_full: fullPhones ? f.phone : undefined,
            why: contacts.length ? 'контакт есть, сделки нет' : 'заявка есть в рекламе, а в amoCRM её нет' });
          continue;
        }
        const best = leads.slice().sort((x, y) =>
          Math.abs(Number(x.created_at || 0) - adTs) - Math.abs(Number(y.created_at || 0) - adTs))[0];
        rowsToSave.push({
          country: country, message_id: 'lg:' + f.lead, phone: f.phone,
          touched_at: f.at, account: f.account, targetolog: targ,
          campaign_id: f.campaign_id || null, campaign: f.campaign || null,
          ad_id: f.ad_id || null, ad_name: f.ad_name || null,
          ad_ambiguous: false, link: 'лидформа ' + (f.form_id || ''), source: 'meta_leadform',
          lead_id: best.id, contact_id: contacts.length ? contacts[0].id : null,
          lead_created: new Date(Number(best.created_at || 0) * 1000).toISOString(),
          _lead_name: best.name
        });
      }

      let saved = 0; const saveErrors = [];
      if(!dryRun && rowsToSave.length){
        const clean = rowsToSave.map(r => { const c = Object.assign({}, r); delete c._lead_name; return c; });
        try { await sbInsertIgnoreDup('ad_touches', clean, 'country,message_id'); saved = clean.length; }
        catch(e){ saveErrors.push(e.message || String(e)); }
      }

      return res.status(200).json({
        country, days, dry_run: dryRun,
        ads_scanned: scanned, sources_ok: okCount, sources_failed: errCount, pages: pageInfo,
        forms_leads_found: raw.length,
        matched: rowsToSave.length,
        saved, save_errors: saveErrors,
        ad_errors: adErrors,
        errors: (errCount && okCount === 0 && !tfErrors.some(x => x.kind === 'token'))
          ? tfErrors.concat([{ source: 'meta', kind: 'perm', message: 'заявки лидформ не отдал ни один источник (' + errCount + ')' }]) : tfErrors,
        incomplete: tfIncomplete.concat(errCount && okCount ? [{ source: 'meta', what: 'forms', detail: 'не открылись формы: ' + errCount }] : []),
        touches: rowsToSave.map(r => ({ at: r.touched_at, targetolog: r.targetolog, campaign: r.campaign,
          ad_name: r.ad_name, lead_id: r.lead_id, lead_name: r._lead_name })),
        not_found: notFound,
        skipped: skipped,
        message: raw.length === 0
          ? 'Заявок лидформ не получили. Если в ad_errors стоит про права — доступу нужно разрешение leads_retrieval на страницу.'
          : (dryRun ? `Готово к сохранению: ${rowsToSave.length} заявок. Применить — dry_run=false.`
                    : `Сохранено: ${saved}.`)
      });
    }
    if(action === 'targ_unmatched'){
      // v950: обратились с рекламы, но в CRM их не нашли. CEO хочет видеть таких людей
      // поимённо, чтобы найти вручную. Два источника: переписки Wazzup (телефон и имя
      // контакта уже есть) и заявки лидформ Meta (имя из формы + хвост телефона).
      // Полный телефон отдаём только сотруднику с подписанной сессией и правом на
      // Маркетинг — APP_TOKEN публичный, а телефоны клиентов наружу утекать не должны.
      // v1015: дни по поясу страны (KG — Бишкек), все страницы таблиц, ошибки — в errors[],
      // у каждой строки продукт; ?product=SD|Z24|SHTURM — фильтр.
      const since = String(req.query.since || localIso(Date.now() - 30 * 86400000, country));
      const until = String(req.query.until || localIso(Date.now(), country));
      const product = productParam(req.query);
      const gate = await requirePermSoft(req, res, 'view_marketing');
      if(!gate.ok) return;
      // v958: полный список для выгрузки — по админ-коду CEO. Подписанная сессия
      // у пользователей пока не везде, а телефоны клиентов по публичному ключу
      // отдавать нельзя.
      const wantFull = String(req.query.full || '') === '1';
      let adminOk = false;
      if(wantFull){
        const g = checkAdminToken(req);
        if(!g.ok) return bad(res, g.unconfigured ? 503 : 403, g.unconfigured ? 'ADMIN_TOKEN не настроен' : 'Нужен админ-код');
        adminOk = true;
      }
      const trusted = !!(gate.caller && gate.caller.trusted) || adminOk;
      const mask = (p) => { const d = String(p || '').replace(/\D/g, ''); return d.length < 7 ? '' : d.slice(0, 3) + ' ••• ' + d.slice(-4); };
      const fromMs = dayStartMs(since, country), toMs = dayEndMs(until, country);
      const days = Math.min(90, Math.max(1, Math.ceil((Date.now() - fromMs) / 86400000) + 1));
      const errors = [], incomplete = [];
      const cfg = await loadProducts();

      const base = selfBase(req);
      // админ-код пробрасываем дальше, чтобы лидформы тоже отдали полный номер
      const extraHdr = adminOk ? { 'x-admin-token': String(req.headers['x-admin-token'] || '') } : null;
      let targByAcc = {};
      try { const rows = await sbSelect('app_settings', { key: 'eq.mkt_targetologs', limit: '1' }); targByAcc = (rows.length && rows[0].value) || {}; } catch(_){}
      const nameForAcc = (acc) => targByAcc[acc] || targByAcc[String(acc).replace(/^act_/, '')] || ('кабинет ' + String(acc).replace(/^act_/, ''));

      const out = [];
      // 1) Переписки: сообщения со ссылкой на объявление, у которых нет касания в ad_touches.
      try {
        const adsR = await selfFetch(base, '/api/meta-ads?endpoint=ads_map');
        if(selfFailed(adsR)){
          errors.push({ source: 'meta', kind: (adsR.json && adsR.json.code) === 'meta_token' ? 'token' : 'other', code: adsR.json && adsR.json.code, message: 'карта объявлений: ' + ((adsR.json && adsR.json.error) || adsR.status) });
        } else (adsR.json.errors || []).forEach(e => errors.push(e));
        const adsJson = selfFailed(adsR) ? null : adsR.json;
        const byShort = {}, byStory = {}, byPost = {};
        ((adsJson && adsJson.ads) || []).forEach(a => {
          if(a.ig_shortcode && !byShort[a.ig_shortcode]) byShort[a.ig_shortcode] = a;
          if(a.story_id && !byStory[a.story_id]) byStory[a.story_id] = a;
          if(a.post_id && !byPost[a.post_id]) byPost[a.post_id] = a;
        });
        const events = (await sbSelectAll('wazzup_events', {
          select: 'id,received_at,kind,direction,phone,message_text,contact_name',
          received_at: 'gte.' + new Date(fromMs).toISOString(), order: 'received_at.asc,id.asc'
        })).filter(e => Date.parse(e.received_at) < toMs);
        const touched = new Set((await sbSelectAll('ad_touches', {
          country: 'eq.' + country, select: 'phone,touched_at,message_id',
          touched_at: 'gte.' + new Date(fromMs).toISOString(), order: 'touched_at.asc,message_id.asc'
        })).map(r => String(r.phone)));
        const seen = new Set();
        const fbCache = {};
        for(const e of events){
          if(e.kind !== 'message' || e.direction === 'out') continue;
          const phone = e.phone ? String(e.phone) : '';
          if(!phone || phone.length > 15 || seen.has(phone)) continue;
          const txt = String(e.message_text || '');
          const ig = txt.match(/instagram\.com\/(?:p|reel|tv)\/([A-Za-z0-9_-]+)/);
          const fb = txt.match(/fb\.me\/([A-Za-z0-9]+)/);
          if(!ig && !fb) continue;
          let ad = ig ? byShort[ig[1]] : null;
          if(!ad && fb){
            if(fbCache[fb[1]] === undefined){
              try {
                const r = await fetch('https://fb.me/' + fb[1], { redirect: 'manual' });
                const loc = r.headers.get('location') || '';
                const st = loc.match(/story_fbid=(\d+)/), pid = loc.match(/[?&]id=(\d+)/);
                fbCache[fb[1]] = st ? (byStory[(pid ? pid[1] : '') + '_' + st[1]] || byPost[st[1]] || null) : null;
              } catch(_){ fbCache[fb[1]] = null; }
            }
            ad = fbCache[fb[1]];
          }
          seen.add(phone);
          if(touched.has(phone)) continue;
          out.push({ at: e.received_at, kind: 'переписка', name: e.contact_name || '',
            phone: trusted ? phone : mask(phone), phone_tail: phone.slice(-4),
            targetolog: ad ? nameForAcc(ad.account) : 'объявление не опознано', campaign: ad ? ad.campaign : null, ad_name: ad ? ad.ad_name : null,
            first_line: txt.split('\n')[0].slice(0, 40),
            product: ad ? classifyCampaign(cfg, { id: ad.campaign_id, name: ad.campaign }) : (cfg.default || 'SD') });
        }
      } catch(e){ errors.push({ source: 'db', kind: 'other', message: 'переписки: ' + String(e.message || e).slice(0, 200) }); }

      // 2) Заявки лидформ без сделки — из сухого прогона.
      try {
        // v1015: заявки лидформ не спрашиваем на каждое открытие экрана — это сотни запросов
        // в amo. Держим 30 минут; одинаковые запросы, пришедшие разом, ждут один ответ.
        const fR = await memo(['tf', country, days, adminOk ? 1 : 0].join('|'), 30 * 60 * 1000,
          () => selfFetch(base, `/api/amo?action=targ_forms&country=${country}&days=${days}&limit=200`, extraHdr), selfFailed);
        if(selfFailed(fR)){
          errors.push({ source: 'meta', kind: (fR.json && fR.json.code) === 'meta_token' ? 'token' : 'other', code: fR.json && fR.json.code, message: 'заявки: ' + ((fR.json && fR.json.error) || fR.status) });
        } else {
          (fR.json.errors || []).forEach(x => errors.push(x));
          (fR.json.incomplete || []).forEach(x => incomplete.push(x));
        }
        const f = selfFailed(fR) ? null : fR.json;
        ((f && f.not_found) || []).forEach(x => {
          const ms = Date.parse(x.at);
          if(!Number.isFinite(ms) || ms < fromMs || ms >= toMs) return;
          out.push({ at: x.at, kind: 'заявка', name: x.name || '', phone: (adminOk && x.phone_full) ? x.phone_full : (x.phone_masked || ''), phone_tail: x.phone_tail || '',
            targetolog: x.targetolog, campaign: x.campaign, ad_name: x.ad_name, first_line: '',
            product: x.form_id ? classifyForm(cfg, x.form_id, x.campaign || x.campaign_id ? { [x.form_id]: { campaign_id: x.campaign_id, campaign: x.campaign } } : null)
              : classifyCampaign(cfg, { id: x.campaign_id, name: x.campaign }) });
        });
      } catch(e){ errors.push({ source: 'meta', kind: 'other', message: 'заявки: ' + String(e.message || e).slice(0, 200) }); }

      const items = product === 'ALL' ? out : out.filter(x => x.product === product);
      items.sort((a, b) => (b.at || '') < (a.at || '') ? -1 : 1);
      const amoSub = String(env.AMO_SUBDOMAIN || '').replace(/\s+/g, '');
      return res.status(200).json({ country, since, until, trusted, product, count: items.length,
        amo_search: `https://${amoSub}.amocrm.ru/leads/list/?query=`, items, errors, incomplete });
    }
    if(action === 'targ_report'){
      // v1015: &v=2 — правило месяца «по дате обращения» и честные Квал/Встреча/Счёт;
      // &product=SD|Z24|SHTURM — только объявления и сделки этого продукта.
      const v2 = String(req.query.v || '') === '2';
      const product = productParam(req.query);
      // v946: отчёт тяжёлый (Meta + amo по каждой сделке, до 40 с на холодном старте).
      // Держим готовый ответ 4 минуты: экран открывают чаще, чем меняются данные.
      const trKey = [country, String(req.query.since || ''), String(req.query.until || ''), product, v2 ? 2 : 1].join('|');
      const trHit = _trCache.get(trKey);
      if(trHit && Date.now() - trHit.t < 4 * 60 * 1000 && String(req.query.fresh || '') !== '1'){
        res.setHeader('X-Cache', 'HIT');
        return res.status(200).json(trHit.v);
      }
      // v929: отчёт по таргетологам и объявлениям.
      // Слева цифры ровно как в рекламном кабинете (потрачено, результаты, цена результата,
      // показы, охват), справа — что из этих людей вышло в CRM: в работе, не квал и почему,
      // не взяли в работу, продали и на сколько. Считаем ПО ДАТЕ РЕКЛАМНОГО КАСАНИЯ:
      // если человека завели в августе, а вернула его сентябрьская реклама — продажа
      // ложится в сентябрь, туда же, где потрачены деньги (решение CEO 09.09.2026).
      // v1015: дни по поясу страны (KG — Бишкек).
      const since = String(req.query.since || localIso(Date.now() - 30 * 86400000, country));
      const until = String(req.query.until || localIso(Date.now(), country));
      const fromMs = dayStartMs(since, country), toMs = dayEndMs(until, country);
      const fromS = Math.floor(fromMs / 1000), toS = Math.floor(toMs / 1000) - 1;
      const base = selfBase(req);
      const errors = [], incomplete = [];

      const [perfR, mapR, settingsRows, pipelines, cfg] = await Promise.all([
        selfFetch(base, `/api/meta-ads?endpoint=ads_perf&since=${since}&until=${until}&country=${country}${v2 ? '&v=2' : ''}`),
        selfFetch(base, '/api/meta-ads?endpoint=ads_map'),
        sbSelect('app_settings', { key: 'in.(mkt_targetologs,mkt_costs)' }).catch(() => []),
        getPipelines(env),
        loadProducts()
      ]);
      // v1015: реклама не ответила совсем — это ошибка, а не «0 потрачено»
      if(selfFailed(perfR) || !Array.isArray(perfR.json.ads)){
        const pj = perfR.json || {};
        return res.status(502).json({ error: 'Реклама: ' + (pj.error || ('нет ответа ' + perfR.status)), code: pj.code || 'meta_error', errors: pj.errors || [] });
      }
      const perf = perfR.json;
      (perf.errors || []).forEach(e => errors.push(e));
      (perf.incomplete || []).forEach(e => incomplete.push(e));
      const map = selfFailed(mapR) ? null : mapR.json;
      if(!map) incomplete.push({ source: 'meta', what: 'ads_map', detail: 'картинки объявлений и формы не загрузились' });
      const sett = {};
      (settingsRows || []).forEach(r => { sett[r.key] = r.value; });
      const targByAcc = sett.mkt_targetologs || {};
      const nameForAcc = (acc) => targByAcc[acc] || targByAcc[String(acc).replace(/^act_/, '')] || null;
      const rate = Number(((sett.mkt_costs || {})[country] || {}).usd_rate) || 0;

      const thumbByAd = {}, adsByForm = {};
      (((map && map.ads) || [])).forEach(a => {
        if(a.ad_id) thumbByAd[a.ad_id] = a.thumb || null;
        if(a.form_id && !adsByForm[a.form_id]) adsByForm[a.form_id] = a;
      });

      // 1) Касания за период. Одна сделка — одно касание: если человек кликал несколько
      //    объявлений, заслуга у ПОСЛЕДНЕГО (решение CEO).
      //    v1015 (v=2): касание засчитывается, только если оно и есть обращение в этом
      //    периоде — новое (сделка создана в пределах 7 дней) или возврат клиента.
      const lastByLead = new Map();
      let leads = {};
      let touchesTotal = 0;
      let sharedSc = null;
      if(v2){
        // v1015: та же основа периода, что у lead_report — без повторных запросов в amo
        const base = await periodBase(env, country, fromS, toS);
        if(base.error) return bad(res, 500, base.error);
        const ar = base.ar;
        sharedSc = base.sc;
        errors.push(...ar.errors); incomplete.push(...ar.incomplete);
        touchesTotal = ar.touches_total;
        ar.items.forEach(x => {
          if(!x.arrival.touch) return;
          lastByLead.set(Number(x.lead.id), Object.assign({}, x.arrival.touch, { _kind: x.arrival.arrival_kind }));
          leads[x.lead.id] = x.lead;
        });
      } else {
        let inRange = [];
        try { inRange = await loadTouches(country, fromMs, toMs); }
        catch(e){ errors.push({ source: 'db', kind: 'other', message: 'рекламные касания: ' + String(e.message || e).slice(0, 200) }); }
        touchesTotal = inRange.length;
        inRange.forEach(t => { if(t.lead_id) lastByLead.set(Number(t.lead_id), t); });
        const fr = await fetchLeadsByIds(env, lastByLead.keys(), 'contacts', errors);
        leads = fr.leads;
        if(fr.failed) incomplete.push({ source: 'amo', what: 'deals', detail: 'не загрузились сделки: ' + fr.failed });
      }

      // 2) Этапы воронки: что считать «не взяли в работу», «в работе», «слились», «продажа».
      const p = pipelines.find(x => /^лид/i.test(x.name || '')) || pipelines.find(x => x.is_main) || pipelines[0];
      const isLost = (st) => Number(st.id) === 143 || Number(st.sort) === 11000 || /закрыт.*не.*реализ|не реализ/i.test(String(st.name || ''));
      const isWon = (st) => Number(st.id) === 142 || Number(st.sort) === 10000 || /успешн.*реализ/i.test(String(st.name || ''));
      const flow = (p ? p.statuses : []).filter(st => !isLost(st) && !isWon(st)).sort((a, b) => a.sort - b.sort);
      const firstIds = new Set(flow.slice(0, 1).map(st => st.id)); // самый первый этап = ещё не взяли
      const stName = {};
      pipelines.forEach(pl => pl.statuses.forEach(st => { if(stName[st.id] == null) stName[st.id] = st.name; }));
      // v1015: честные Квал/Встреча/Счёт — по истории этапов, «Отложили» и отказ движением не считаются
      const model = buildStageModel(p ? p.statuses : [], { honest: true });
      const sc = sharedSc || await scanStatusEvents(env, new Set(Object.keys(leads).map(Number)), fromS - NEAR_SEC, toS);
      if(sc.error){
        if(Number(sc.error.status) === 401 || Number(sc.error.status) === 403) throw sc.error;
        errors.push(amoErrOf(sc.error, 'история этапов'));
      }
      if(sc.truncated) incomplete.push({ source: 'amo', what: 'events', detail: 'история этапов просмотрена не полностью' });

      // Причины отказа — их выбирает менеджер, когда закрывает сделку.
      let lossName = {};
      try {
        // v1015: справочник причин — 10 минут из памяти
        const lr = await memo('lr|' + String(env.AMO_SUBDOMAIN || '').replace(/\s+/g, ''), 10 * 60 * 1000, () => amoFetch('/leads/loss_reasons?limit=250', env));
        ((lr && lr._embedded && lr._embedded.loss_reasons) || []).forEach(x => { lossName[x.id] = x.name; });
      } catch(_){}

      // v947: имя клиента живёт в контакте и компании, а сделка часто называется
      // «Сделка #…» или «Facebook №…». Подтягиваем имена пачками, чтобы на экране
      // было «Нурсултан Табалдиев · Айчурок Фармацевтика», а не номер.
      const cids = new Set(), coids = new Set();
      Object.keys(leads).forEach(id => {
        const e = leads[id]._embedded || {};
        (e.contacts || []).forEach(c => cids.add(c.id));
        (e.companies || []).forEach(c => coids.add(c.id));
      });
      lastByLead.forEach(t => { if(t.contact_id) cids.add(Number(t.contact_id)); });
      const nameOf = async (path, ids, key) => {
        const out = {};
        const arr = [...ids].filter(Boolean);
        for(let i = 0; i < arr.length; i += 50){
          const q = arr.slice(i, i + 50).map((x, k) => `filter[id][${k}]=${x}`).join('&');
          try {
            const r = await amoFetch(`${path}?${q}&limit=250`, env);
            (((r && r._embedded) || {})[key] || []).forEach(x => { out[x.id] = x.name || ''; });
          } catch(_){}
        }
        return out;
      };
      const cname = await nameOf('/contacts', cids, 'contacts');
      const coname = await nameOf('/companies', coids, 'companies');
      const clientOf = (l, t) => {
        const e = (l && l._embedded) || {};
        const main = (e.contacts || []).find(c => c.is_main) || (e.contacts || [])[0];
        const cn = (main && cname[main.id]) || (t && t.contact_id && cname[Number(t.contact_id)]) || '';
        const co = ((e.companies || [])[0] && coname[(e.companies || [])[0].id]) || '';
        return { client: cn, company: co };
      };

      // 3) Раскладываем по объявлениям.
      const byAd = new Map();
      const slot = (adId) => {
        if(!byAd.has(adId)) byAd.set(adId, {
          crm_leads: 0, in_work: 0, not_taken: 0, lost: 0, won: 0, won_sum: 0,
          qual: 0, meet: 0, inv: 0,
          loss_reasons: {}, deals: []
        });
        return byAd.get(adId);
      };
      const amoSub = String(env.AMO_SUBDOMAIN || '').replace(/\s+/g, '');
      lastByLead.forEach((t, leadId) => {
        const l = leads[leadId];
        const tags = ((l && l._embedded && l._embedded.tags) || []).map(x => x.name).filter(Boolean);
        const prod = productOfLead(cfg, { tags }, t, adsByForm);
        if(product !== 'ALL' && prod !== product) return;
        const s = slot(t.ad_id || ('camp:' + (t.campaign_id || t.account)));
        s.crm_leads++;
        if(!l) return;
        const st = (p ? p.statuses : []).find(x => x.id === l.status_id) || null;
        let bucket = 'in_work';
        if(st && isWon(st)){ bucket = 'won'; s.won++; s.won_sum += Number(l.price || 0); }
        else if(st && isLost(st)){
          bucket = 'lost'; s.lost++;
          const why = lossName[l.loss_reason_id] || 'причина не указана';
          s.loss_reasons[why] = (s.loss_reasons[why] || 0) + 1;
        }
        else if(firstIds.has(l.status_id)){ bucket = 'not_taken'; s.not_taken++; }
        else { s.in_work++; }
        const reached = reachedOf(model, l, sc);
        const fl = reachedFlags(model, reached);
        if(fl.qual) s.qual++;
        if(fl.meet) s.meet++;
        if(fl.inv) s.inv++;
        const who = clientOf(l, t);
        s.deals.push({ lead_id: leadId, name: l.name, client: who.client, company: who.company,
          amo_url: `https://${amoSub}.amocrm.ru/leads/detail/${leadId}`, stage: stName[l.status_id] || '—',
          bucket, price: Number(l.price || 0), touched_at: t.touched_at,
          lead_created: t.lead_created, ad_ambiguous: !!t.ad_ambiguous,
          reached_sort: reached, qual: fl.qual, meet: fl.meet, inv: fl.inv, product: prod,
          arrival_kind: t._kind || null });
      });

      // 4) Собираем ответ: у каждого таргетолога его объявления с расходом.
      const out = {};
      ((perf && perf.ads) || []).forEach(a => {
        if(product !== 'ALL' && classifyCampaign(cfg, { id: a.campaign_id, name: a.campaign }) !== product) return;
        const targ = nameForAcc(a.account) || ('кабинет ' + a.account);
        if(!out[targ]) out[targ] = { targetolog: targ, account: a.account, spend: 0,
          chats: 0, leads_meta: 0, link_clicks: 0,
          crm_leads: 0, in_work: 0, not_taken: 0, lost: 0, won: 0, won_sum: 0, qual: 0, meet: 0, inv: 0, ads: [] };
        const t = out[targ];
        const s = byAd.get(a.ad_id) || null;
        t.spend += a.spend;
        // Переписки, заявки и клики нельзя складывать в одно число: у кампании «МК»
        // результат — клики по ссылке, и 135 кликов рядом с 17 перепискам врут в разы.
        if(a.result_kind === 'Начало переписки') t.chats += a.results;
        else if(a.result_kind === 'Заявки') t.leads_meta += a.results;
        else t.link_clicks += a.results;
        if(s){ t.crm_leads += s.crm_leads; t.in_work += s.in_work; t.not_taken += s.not_taken;
               t.lost += s.lost; t.won += s.won; t.won_sum += s.won_sum;
               t.qual += s.qual; t.meet += s.meet; t.inv += s.inv; }
        t.ads.push({
          ad_id: a.ad_id, ad_name: a.ad_name, campaign: a.campaign, thumb: thumbByAd[a.ad_id] || null,
          spend: a.spend, results: a.results, result_kind: a.result_kind, cost_per_result: a.cost_per_result,
          impressions: a.impressions, reach: a.reach, ctr: a.ctr,
          crm: s ? { leads: s.crm_leads, in_work: s.in_work, not_taken: s.not_taken,
                     lost: s.lost, won: s.won, won_sum: Math.round(s.won_sum),
                     qual: s.qual, meet: s.meet, inv: s.inv,
                     loss_reasons: s.loss_reasons, deals: s.deals }
                 : { leads: 0, in_work: 0, not_taken: 0, lost: 0, won: 0, won_sum: 0, qual: 0, meet: 0, inv: 0, loss_reasons: {}, deals: [] }
        });
      });
      const list = Object.values(out).map(t => {
        const revUsd = rate > 0 ? t.won_sum / rate : null;
        t.ads.sort((x, y) => (y.crm.won_sum - x.crm.won_sum) || (y.crm.leads - x.crm.leads) || (y.spend - x.spend));
        return { ...t, spend: Math.round(t.spend * 100) / 100, won_sum: Math.round(t.won_sum),
          revenue_usd: revUsd == null ? null : Math.round(revUsd * 100) / 100,
          profit_usd: revUsd == null ? null : Math.round((revUsd - t.spend) * 100) / 100,
          roi: (revUsd != null && t.spend > 0) ? Math.round(revUsd / t.spend * 100) / 100 : null };
      }).sort((a, b) => b.spend - a.spend);

      const trOut = {
        country, since, until, usd_rate: rate || null, product, month_rule: v2 ? 'arrival' : 'touch',
        qual_stage: stageRef(model.qualStage), meet_stage: stageRef(model.meetStage), inv_stage: stageRef(model.invStage),
        targetologs: list,
        touches_total: touchesTotal,
        leads_attributed: lastByLead.size,
        errors, incomplete,
        note: 'Слева — цифры рекламного кабинета. Справа — только те люди, которых удалось узнать '
          + 'по ссылке на объявление в первом сообщении WhatsApp. Переписки копятся с 03.09.2026; '
          + 'заявки из Instagram Direct и звонки следа рекламы не несут и сюда не попадают.'
      };
      if(!errors.length) _trCache.set(trKey, { t: Date.now(), v: trOut }); // v1015: сбой не кэшируем
      return res.status(200).json(trOut);
    }
    if(action === 'lead_report'){
      // v897: отчёт по лидам за период — для экрана «Маркетинг».
      // ?slim=1 — без списка лидов (нужен для сравнения с прошлым месяцем).
      const fromTs = req.query.from ? Number(req.query.from) : null;
      const toTs = req.query.to ? Number(req.query.to) : null;
      if(!fromTs) return bad(res, 400, 'Need ?from=<unix> (&to=<unix>)');
      const slim = String(req.query.slim || '') === '1';
      // v1015: &v=2 — лиды по дате обращения, честный «Квал», продукт у каждого лида.
      // Отдаём ВСЕ продукты: фронт фильтрует сам, без нового запроса при переключении.
      const v2 = String(req.query.v || '') === '2';
      const key = country + '|' + fromTs + '|' + (toTs || 0) + '|' + (v2 ? 2 : 1);
      // v1015: прошлый период (slim) меняется редко — держим 30 минут
      let data = _lrGet(key, slim ? 30 * 60 * 1000 : LR_TTL_MS);
      if(!data){
        const cfg = v2 ? await loadProducts() : null;
        data = await buildLeadReport(env, fromTs, toTs, { v2, country, cfg });
        if(!data.error && !(data.errors && data.errors.length)) _lrSet(key, data); // сбой не кэшируем
      }
      if(data.error) return bad(res, 500, data.error);
      const out = Object.assign({ country: country, product: productParam(req.query) }, data, { _subdomain: env.AMO_SUBDOMAIN });
      if(slim && v2){
        // v1015: для сравнения с прошлым периодом фронту нужны лишь поля фильтров и этапов
        out.leads = (data.leads || []).map(l => ({ id: l.id, name: l.name, created: l.created, manager: l.manager, origin: l.origin,
          source: l.source, product: l.product, arrival_at: l.arrival_at, arrival_kind: l.arrival_kind, status_id: l.status_id,
          reached_sort: l.reached_sort, is_won: l.is_won, is_lost: l.is_lost, price: l.price }));
        out.leads_slim = true;
      } else if(slim){ out.leads = []; out.leads_omitted = true; }
      return res.status(200).json(out);
    }
    if(action === 'geo_quals'){
      // v883: квалы по стране за период — для дашборда «Страны» в Маркетинге.
      // Лид считается дошедшим до этапа, если он СЕЙЧАС на этом этапе или дальше,
      // ЛИБО когда-то на нём был (история смен статуса) — иначе слитые лиды теряются,
      // а их в воронке большинство, и конверсия получалась бы втрое ниже реальной.
      const fromTs = req.query.from ? Number(req.query.from) : null;
      const toTs = req.query.to ? Number(req.query.to) : null;
      if(!fromTs) return bad(res, 400, 'Need ?from=<unix> (&to=<unix>)');

      const pipelines = await getPipelines(env);
      const p = pipelines.find(x => /^лид/i.test(x.name || '')) || pipelines.find(x => x.is_main) || pipelines[0];
      if(!p) return bad(res, 500, 'no pipelines found');

      // Карта «этап → насколько далеко по воронке». Отказные этапы (sort 11000) НЕ значат,
      // что лид прошёл всю воронку — их reach берём только из истории смен статуса.
      // «Успешно реализовано» наоборот засчитываем как пройденную воронку целиком.
      // v1015 (v=2): «Отложили на период» тоже не движение вперёд; добавлен «Квал».
      const gqV2 = String(req.query.v || '') === '2';
      const gqModel = buildStageModel(p.statuses, { honest: gqV2 });
      const flow = gqModel.flow;
      const isWonStatus = (st) => gqModel.wonIds.has(st.id);
      const stMeeting = gqModel.meetStage;
      const stInvoice = gqModel.invStage;
      const stQual = gqModel.qualStage;

      // 1) лиды, созданные в периоде
      let dateFilter = `&filter[created_at][from]=${fromTs}`;
      if(toTs) dateFilter += `&filter[created_at][to]=${toTs}`;
      const leads = [];
      let truncated = false;
      for(let page = 1; page <= 8; page++){
        const data = await amoFetch(`/leads?filter[pipeline_id]=${p.id}${dateFilter}&limit=250&page=${page}`, env);
        if(!data) break;
        const batch = (data._embedded && data._embedded.leads) || [];
        if(!batch.length) break;
        leads.push(...batch);
        if(batch.length < 250) break;
        if(page === 8) truncated = true;
      }
      const leadIds = new Set(leads.map(l => l.id));

      // 2) история смен статуса с начала периода — чтобы поймать тех, кто прошёл этап и слился
      // v1015: общий разбор истории (scanStatusEvents), как в lead_report и targ_report
      const sc = await scanStatusEvents(env, leadIds, fromTs, toTs);
      if(sc.error && (Number(sc.error.status) === 401 || Number(sc.error.status) === 403)) throw sc.error;
      const reachedSort = new Map(); // lead_id → максимальный sort этапа, где лид когда-либо был
      leads.forEach(l => { const r = reachedOf(gqModel, l, sc); if(r != null) reachedSort.set(l.id, r); });
      const eventsScanned = sc.scanned, eventsTruncated = sc.truncated, eventsError = sc.error ? (sc.error.message || String(sc.error)) : null;
      const gqErrors = sc.error ? [amoErrOf(sc.error, 'история этапов')] : [];
      const gqIncomplete = [];
      if(truncated) gqIncomplete.push({ source: 'amo', what: 'leads', detail: 'показаны первые 2000' });
      if(sc.truncated) gqIncomplete.push({ source: 'amo', what: 'events', detail: 'история этапов просмотрена не полностью' });

      // 3) считаем: «дошёл до этапа» = максимальный достигнутый sort >= sort этапа.
      // «Успешно реализовано» (sort 10000) проходит все этапы автоматически.
      const countReached = (st) => {
        if(!st) return null;
        let n = 0;
        reachedSort.forEach(v => { if(v >= Number(st.sort)) n++; });
        return n;
      };
      const wonIds = new Set(p.statuses.filter(isWonStatus).map(st => st.id));
      const wonLeads = leads.filter(l => wonIds.has(l.status_id));

      return res.status(200).json({
        country: country,
        pipeline: { id: p.id, name: p.name },
        from: fromTs, to: toTs || null,
        leads: leads.length,
        truncated: truncated,
        stages: {
          ...(gqV2 ? { qual: stQual ? { id: stQual.id, name: stQual.name, sort: stQual.sort, count: countReached(stQual) } : null } : {}),
          meeting: stMeeting ? { id: stMeeting.id, name: stMeeting.name, sort: stMeeting.sort, count: countReached(stMeeting) } : null,
          invoice: stInvoice ? { id: stInvoice.id, name: stInvoice.name, sort: stInvoice.sort, count: countReached(stInvoice) } : null
        },
        won: { count: wonLeads.length, sum: wonLeads.reduce((a,l) => a + Number(l.price||0), 0) },
        flow: flow.map(st => ({ id: st.id, name: st.name, sort: st.sort })),
        events: { scanned: eventsScanned, truncated: eventsTruncated, error: eventsError },
        errors: gqErrors, incomplete: gqIncomplete,
        _subdomain: env.AMO_SUBDOMAIN
      });
    }
    if(action === 'phone_lookup'){
      // v317: debug — поиск контакта/лида в amo по конкретному телефону, в разных форматах
      const phone = String(req.query.phone || '').replace(/\D/g, '');
      if(!phone) return bad(res, 400, 'Need ?phone=...');
      const variants = [phone, '+' + phone, phone.slice(-10), '8' + phone.slice(-10), phone.slice(-9)];
      const results = {};
      for(const v of variants){
        try {
          const r = await amoFetch(`/contacts?query=${encodeURIComponent(v)}&limit=5`, env);
          const found = (r && r._embedded && r._embedded.contacts) || [];
          results[v] = found.map(c => ({
            id: c.id, name: c.name,
            phones: (c.custom_fields_values || []).filter(f => f.field_code === 'PHONE')
              .flatMap(f => (f.values || []).map(v => v.value))
          }));
        } catch(e){
          results[v] = { error: e.message };
        }
      }
      return res.status(200).json({ phone_normalized: phone, search_variants: results });
    }
    if(action === 'sheets_audit'){
      // v314: сверка лидов из Google Sheets (Meta Lead Forms сырая выгрузка) с amo по телефону.
      //       Классификация по комментариям менеджеров: срм / ндз / не квал / брак / новый.
      const sheetId = String(req.query.sheet_id || '');
      const sheetName = String(req.query.sheet_name || 'Sheet1');
      if(!sheetId) return bad(res, 400, 'Need ?sheet_id=...');

      // 1. Читаем CSV из Google Sheets через gviz
      const csvUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(sheetName)}`;
      const csvResp = await fetch(csvUrl);
      if(!csvResp.ok) return bad(res, 502, `Sheets fetch failed: ${csvResp.status}`);
      const csv = await csvResp.text();

      // 2. Парсим строки и извлекаем телефон + комментарий
      // v1015: normalizePhone — общий из _phone.js (KG + KZ)

      function classifyComment(line){
        const t = String(line||'').toLowerCase();
        if(/номер не полн|плох.*номер|без номер/.test(t)) return 'broken';
        if(/не квал|сигарет|табак|алкогол|свинин/.test(t)) return 'not_qualified';
        // v663: упрощён избыточный regex /^|.../ (пустая альтернатива ^ матчила всё, но был
        // AND с реальной проверкой — поведение не менялось); оставлена осмысленная проверка
        if(/срм|crm|created/.test(t)) return 'in_amo_marked';
        if(/ндз|не дозв/.test(t)) return 'no_answer';
        return 'unprocessed';
      }

      const lines = csv.split('\n').filter(l => l.trim().length > 0);
      const sheetLeads = [];
      lines.forEach(line => {
        // Извлекаем все p:+7XXX или p:7XXX и берём первый валидный
        const phoneMatch = line.match(/p:\+?(\d{9,12})/);
        if(!phoneMatch) return;
        const phone = normalizePhone(phoneMatch[1], country);
        if(!phone) return;
        // Комментарий — берём ВСЮ строку для классификации (комментарии в разных колонках)
        const cls = classifyComment(line);
        sheetLeads.push({ phone: phone, classification: cls, raw_line: line.slice(0, 200) });
      });

      // 3. Тянем телефоны из amo (до 20 страниц = 5000 контактов).
      //    v315: ?pages=N (1..20) — по умолчанию 20, чтобы покрыть всю базу.
      const maxPages = Math.min(20, Math.max(1, Number(req.query.pages) || 20));
      const amoPhones = new Map();
      let amoPagesFetched = 0;
      let amoTruncated = false;
      for(let page = 1; page <= maxPages; page++){
        const data = await amoFetch(`/contacts?limit=250&page=${page}`, env);
        if(!data) break;
        const contacts = (data._embedded && data._embedded.contacts) || [];
        if(!contacts.length) break;
        amoPagesFetched++;
        contacts.forEach(c => {
          const cf = c.custom_fields_values || [];
          cf.forEach(f => {
            if(f.field_code === 'PHONE' && Array.isArray(f.values)){
              f.values.forEach(v => {
                const p = normalizePhone(v.value, country);
                if(p) amoPhones.set(p, c.id);
              });
            }
          });
        });
        if(contacts.length < 250) break;
        if(page === maxPages && contacts.length === 250) amoTruncated = true;
      }

      // 4. Сверяем: для каждого Sheets-лида ищем в amo (пасс 1 — bulk phones)
      const stillMissing = [];
      sheetLeads.forEach(l => {
        l.in_amo = amoPhones.has(l.phone);
        if(!l.in_amo) stillMissing.push(l);
      });

      // v316: пасс 2 — для не найденных делаем прямой query-поиск amo (учитывает все форматы хранения)
      let foundByQuery = 0;
      for(const l of stillMissing){
        try {
          const r = await amoFetch(`/contacts?query=${encodeURIComponent(l.phone)}&limit=1`, env);
          if(r && r._embedded && r._embedded.contacts && r._embedded.contacts.length > 0){
            l.in_amo = true;
            l.found_via_query = true;
            foundByQuery++;
          }
          // Альтернативный поиск — последние 10 цифр (на случай если в amo сохранено без 7/8)
          if(!l.in_amo){
            const last10 = l.phone.slice(-10);
            const r2 = await amoFetch(`/contacts?query=${encodeURIComponent(last10)}&limit=1`, env);
            if(r2 && r2._embedded && r2._embedded.contacts && r2._embedded.contacts.length > 0){
              l.in_amo = true;
              l.found_via_query = true;
              foundByQuery++;
            }
          }
        } catch(_){}
      }

      // 5. Пересчитываем после query-fallback
      let inAmo = 0, notInAmo = 0;
      const byClass = {};
      const mismatch_marked_not_in_amo = [];
      const urgent_unprocessed = [];
      sheetLeads.forEach(l => {
        if(l.in_amo) inAmo++; else notInAmo++;
        byClass[l.classification] = byClass[l.classification] || { total: 0, in_amo: 0, not_in_amo: 0 };
        byClass[l.classification].total++;
        if(l.in_amo) byClass[l.classification].in_amo++; else byClass[l.classification].not_in_amo++;
        if(l.classification === 'in_amo_marked' && !l.in_amo){
          mismatch_marked_not_in_amo.push({ phone: l.phone });
        }
        if(l.classification === 'unprocessed' && !l.in_amo){
          urgent_unprocessed.push({ phone: l.phone });
        }
      });

      return res.status(200).json({
        sheet: { id: sheetId, name: sheetName },
        total_rows_in_sheet: lines.length,
        leads_with_phone: sheetLeads.length,
        in_amo: inAmo,
        not_in_amo: notInAmo,
        amo_contacts_fetched: amoPhones.size,
        amo_pages_fetched: amoPagesFetched,
        amo_truncated_warning: amoTruncated,
        by_classification: byClass,
        urgent_unprocessed_count: urgent_unprocessed.length,
        urgent_unprocessed_sample: urgent_unprocessed.slice(0, 10),
        mismatch_marked_in_amo_but_not_found: mismatch_marked_not_in_amo.length,
        mismatch_sample: mismatch_marked_not_in_amo.slice(0, 10)
      });
    }
    if(action === 'tag_breakdown'){
      // v313: распределение тегов среди последних N лидов — чтобы понимать какие источники реально проставлены
      const limit = Math.min(250, Math.max(1, Number(req.query.limit) || 99));
      // Список всех тегов (id → name)
      const tagsData = await amoFetch('/leads/tags?limit=250', env);
      const allTags = (tagsData && tagsData._embedded && tagsData._embedded.tags) || [];
      const tagById = {};
      allTags.forEach(t => { tagById[t.id] = t.name; });
      // Последние N лидов с тегами
      const leadsData = await amoFetch(`/leads?order[created_at]=desc&limit=${limit}`, env);
      const leads = (leadsData && leadsData._embedded && leadsData._embedded.leads) || [];
      const tagCount = {};
      let withAnyTag = 0, withoutTag = 0;
      leads.forEach(l => {
        const tags = (l._embedded && l._embedded.tags) || [];
        if(tags.length > 0) withAnyTag++; else withoutTag++;
        tags.forEach(t => {
          const name = tagById[t.id] || t.name || ('id:'+t.id);
          tagCount[name] = (tagCount[name] || 0) + 1;
        });
      });
      const tagSorted = Object.entries(tagCount).sort((a,b) => b[1]-a[1]).map(([name, count]) => ({name, count}));
      // v318: возвращаем имена всех тегов чтоб видеть новые (от интеграций)
      const allTagNames = allTags.map(t => t.name).sort();
      return res.status(200).json({
        leads_fetched: leads.length,
        with_any_tag: withAnyTag,
        without_tag: withoutTag,
        all_tags_in_account: allTags.length,
        all_tag_names: allTagNames,
        top_tags: tagSorted
      });
    }
    return bad(res, 400, 'Unknown action. Use ?action=pipelines | funnel | tag_breakdown');
  } catch(e){
    // v1015: 401 от amo — это НЕ наша сессия; отдаём 502 с кодом, фронт покажет «ключ amo устарел»
    if(e && e.upstream === 'amo') return amoFail(res, e);
    return bad(res, e.status || 500, e.message, { data: e.data });
  }
}
