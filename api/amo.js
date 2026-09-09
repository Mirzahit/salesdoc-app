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
import { sbSelect, sbInsertIgnoreDup } from './_supabase.js';
import { almatyIso } from './_dates.js';

function bad(res, code, msg, extra){
  res.status(code).json({ error: msg, ...(extra || {}) });
}

async function amoFetch(path, env){
  // v309: чистим whitespace из env-переменных. При вставке в Vercel UI часто
  //       копируются переносы строк, а в HTTP-заголовке они недопустимы.
  const token = String(env.AMO_TOKEN || '').replace(/\s+/g, '');
  const sub = String(env.AMO_SUBDOMAIN || '').replace(/\s+/g, '');
  const url = `https://${sub}.amocrm.ru/api/v4${path}`;
  const r = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    }
  });
  if(r.status === 204) return null; // empty response (no records)
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch(_){ data = { _raw: text }; }
  if(!r.ok){
    const err = new Error(`amo ${r.status}: ${data.title || data.detail || data['validation-errors'] || text.slice(0,200)}`);
    err.status = r.status;
    err.data = data;
    throw err;
  }
  return data;
}

async function getPipelines(env){
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
  const r = await fetch(url, {
    method: method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if(r.status === 204) return null;
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch(_){ data = { _raw: text }; }
  if(!r.ok){
    const err = new Error(`amo ${method} ${r.status}: ${data.title || data.detail || text.slice(0,200)}`);
    err.status = r.status;
    err.data = data;
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
function _lrGet(k){
  const e = _lrCache.get(k);
  if(!e) return null;
  if(Date.now() - e.t > LR_TTL_MS){ _lrCache.delete(k); return null; }
  return e.v;
}
function _lrSet(k, v){ _lrCache.set(k, { t: Date.now(), v }); }

async function buildLeadReport(env, fromTs, toTs){
  const pipelines = await getPipelines(env);
  const p = pipelines.find(x => /^лид/i.test(x.name || '')) || pipelines.find(x => x.is_main) || pipelines[0];
  if(!p) return { error: 'no pipelines found' };

  const isLossStatus = (st) => Number(st.id) === 143 || Number(st.sort) === 11000 || /закрыт.*не.*реализ|не реализ/i.test(String(st.name||''));
  const isWonStatus  = (st) => Number(st.id) === 142 || Number(st.sort) === 10000 || /успешн.*реализ/i.test(String(st.name||''));
  // «Живые» этапы по порядку. Отказ и успех в этот список не входят: отказ не значит
  // «прошёл всю воронку», успех наоборот засчитываем как пройденную воронку целиком.
  const flow = p.statuses.filter(st => !isLossStatus(st) && !isWonStatus(st)).sort((a,b) => a.sort - b.sort);
  const maxFlowSort = flow.length ? Number(flow[flow.length - 1].sort) : 0;
  const sortById = {}, nameById = {};
  p.statuses.forEach(st => {
    nameById[st.id] = st.name;
    if(isLossStatus(st)) return;
    sortById[st.id] = isWonStatus(st) ? maxFlowSort : Number(st.sort);
  });

  // менеджеры (id → имя)
  const userNameById = {};
  try {
    for(let up = 1; up <= 5; up++){
      const ud = await amoFetch(`/users?limit=250&page=${up}`, env);
      const arr = (ud && ud._embedded && ud._embedded.users) || [];
      arr.forEach(u => { userNameById[u.id] = u.name; });
      if(arr.length < 250) break;
    }
  } catch(_){}

  // 1) лиды, созданные в периоде
  let dateFilter = `&filter[created_at][from]=${fromTs}`;
  if(toTs) dateFilter += `&filter[created_at][to]=${toTs}`;
  const raw = [];
  let truncated = false;
  for(let page = 1; page <= 12; page++){
    const data = await amoFetch(`/leads?filter[pipeline_id]=${p.id}${dateFilter}&limit=250&page=${page}`, env);
    if(!data) break;
    const batch = (data._embedded && data._embedded.leads) || [];
    if(!batch.length) break;
    raw.push(...batch);
    if(batch.length < 250) break;
    if(page === 12) truncated = true;
  }
  const known = new Set(raw.map(l => l.id));

  // 2) история смен этапа — иначе лид, который дошёл до встречи и слился, теряется
  const reached = new Map();
  raw.forEach(l => { const s = sortById[l.status_id]; if(s !== undefined) reached.set(l.id, s); });
  let eventsScanned = 0, eventsTruncated = false, eventsError = null;
  try {
    for(let page = 1; page <= 40; page++){
      const evTo = Math.min(Math.floor(Date.now()/1000), (toTs ? toTs + 90*86400 : Math.floor(Date.now()/1000)));
        const ev = await amoFetch(`/events?filter[entity]=lead&filter[type][]=lead_status_changed&filter[created_at][from]=${fromTs}&filter[created_at][to]=${evTo}&limit=100&page=${page}`, env);
      if(!ev) break;
      const batch = (ev._embedded && ev._embedded.events) || [];
      if(!batch.length) break;
      eventsScanned += batch.length;
      batch.forEach(e => {
        const id = Number(e.entity_id);
        if(!known.has(id)) return;
        const after = (e.value_after && e.value_after[0] && e.value_after[0].lead_status) || null;
        if(!after) return;
        const s = sortById[after.id];
        if(s === undefined) return;
        const prev = reached.get(id);
        if(prev === undefined || s > prev) reached.set(id, s);
      });
      if(batch.length < 100) break;
      if(page === 40) eventsTruncated = true;
    }
  } catch(e){ eventsError = e.message || String(e); }

  const wonIds = new Set(p.statuses.filter(isWonStatus).map(st => st.id));
  const lostIds = new Set(p.statuses.filter(isLossStatus).map(st => st.id));
  const sub = String(env.AMO_SUBDOMAIN || '').replace(/\s+/g, '');

  const leads = raw.map(l => {
    const r = reached.has(l.id) ? reached.get(l.id) : null;
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
    return {
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
  }).sort((a, b) => b.created - a.created);

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
  return {
    pipeline: { id: p.id, name: p.name },
    origins, by_creator: byCreator,
    by_source: bySource, source_filled: withSource,
    from: fromTs, to: toTs || null,
    leads_total: leads.length,
    stages, leads, managers,
    won: { count: wonLeads.length, sum: wonLeads.reduce((a, l) => a + l.price, 0) },
    lost: { count: leads.filter(l => l.is_lost).length },
    truncated,
    events: { scanned: eventsScanned, truncated: eventsTruncated, error: eventsError }
  };
}

export default async function handler(req, res){
  // v376: разрешаем POST для двусторонней синхронизации SD→amo (update_status, add_note).
  if(req.method !== 'GET' && req.method !== 'POST'){ return bad(res, 405, 'Only GET/POST'); }
  // v591 SEC: app-token обязателен для ВСЕХ методов. Раньше проверялся только для POST,
  // из-за чего GET-действия (phone_lookup/lead_full/data_quality/apply_meta_tags) сливали
  // PII клиентов из amo и позволяли GET-мутацию тегов сделок без токена.
  if(!checkAuth(req, res)) return;
  // v361: поддержка двух amo-кабинетов (KZ + KG) через ?country=KG
  const country = String((req.query && req.query.country) || 'KZ').toUpperCase();
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
      const now = new Date();
      const yy = now.getFullYear(), mm = now.getMonth();
      const MONTHS_RU = ['Январь','Февраль','Март','Апрель','Май','Июнь','Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];
      let fromDate, toDate, label;
      // v630: кастомный диапазон from/to (YYYY-MM-DD). Если валиден — приоритет над period.
      const qFrom = String((req.query && req.query.from) || '').slice(0, 10);
      const qTo = String((req.query && req.query.to) || '').slice(0, 10);
      const _validDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);
      // v922: границы считаем по Алматы (UTC+5), сервер Vercel живёт в UTC —
      // иначе сделки, закрытые 1-го числа до 05:00, улетали в прошлый месяц.
      const almaty = (y, m, d) => new Date(Date.UTC(y, m, d) - 5*3600*1000);
      if(_validDate(qFrom) && _validDate(qTo)){
        fromDate = new Date(qFrom + 'T00:00:00+05:00');
        toDate = new Date(qTo + 'T23:59:59+05:00');
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
            date: l.closed_at ? almatyIso(l.closed_at*1000) : '', // v817: сделки, закрытые ночью, падали во вчерашний день
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

      function normalizePhone(p){
        const digits = String(p||'').replace(/\D/g, '');
        if(!digits) return null;
        let n = digits;
        if(n.startsWith('8') && n.length === 11) n = '7' + n.slice(1);
        if(n.length === 10) n = '7' + n;
        return n.length >= 10 ? n : null;
      }

      // 1. Phones из Sheets (Meta Lead Forms)
      const csvUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(sheetName)}&range=A1:Z2000`;
      const csvResp = await fetch(csvUrl);
      const csv = csvResp.ok ? await csvResp.text() : '';
      const sheetPhones = new Set();
      csv.split('\n').forEach(line => {
        const m = line.match(/p:\+?(\d{10,11})/);
        if(m){ const p = normalizePhone(m[1]); if(p) sheetPhones.add(p); }
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
      function normalizePhone(p){
        const digits = String(p||'').replace(/\D/g, '');
        if(!digits) return null;
        let n = digits;
        if(n.startsWith('8') && n.length === 11) n = '7' + n.slice(1);
        if(n.length === 10) n = '7' + n;
        return n.length >= 10 ? n : null;
      }
      const phones = new Set();
      csv.split('\n').forEach(line => {
        const m = line.match(/p:\+?(\d{10,11})/);
        if(m){ const p = normalizePhone(m[1]); if(p) phones.add(p); }
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
              // Подозрительный номер: длина не 10 (без кода страны) и не 11 (с 7)
              if(n.length !== 10 && n.length !== 11){
                badPhones.push({ contact_id: c.id, contact_name: c.name, raw_phone: rp, normalized: n, length: n.length });
              }
              const key = n.length >= 10 ? n.slice(-10) : n; // группируем по последним 10 цифр
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

      const proto = req.headers['x-forwarded-proto'] || 'https';
      const host = req.headers['x-forwarded-host'] || req.headers.host;
      const appTok = String(process.env.APP_TOKEN || '').trim();
      const selfGet = async (qs) => {
        const r = await fetch(`${proto}://${host}/api/meta-ads?${qs}`, {
          headers: { 'x-app-token': appTok, 'x-user-email': 'cron@salesdoc.io' }
        });
        return r.json().catch(() => null);
      };

      // 2) Карта «пост → объявления» и расход объявлений по дням (для правила «что крутилось в тот день»).
      const until = almatyIso(Date.now());
      const sinceIso = almatyIso(Date.now() - days * 86400000);
      const [adsJson, perfJson] = await Promise.all([
        selfGet('endpoint=ads_map'),
        selfGet(`endpoint=ads_perf&daily=1&since=${sinceIso}&until=${until}`)
      ]);
      if(!adsJson || !Array.isArray(adsJson.ads)) return bad(res, 502, 'Не удалось получить карту объявлений (ads_map)');
      const spendByAdDay = {}, kindByAdDay = {};
      ((perfJson && perfJson.days) || []).forEach(d => {
        spendByAdDay[d.ad_id + '|' + d.date] = d.spend;
        kindByAdDay[d.ad_id + '|' + d.date] = d.result_kind || null;
      });

      const byShort = {}, byStory = {}, byPost = {};
      const push = (map, key, ad) => { if(!key) return; (map[key] = map[key] || []).push(ad); };
      adsJson.ads.forEach(a => {
        push(byShort, a.ig_shortcode, a);
        push(byStory, a.story_id, a);
        push(byPost, a.post_id, a);
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
          const chat = live.filter(a => kindByAdDay[a.ad_id + '|' + dayIso] === 'Начало переписки');
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
        const dayIso = String(e.received_at || '').slice(0, 10);
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
        if(processed >= maxPhones) break;
        processed++;
        const acc = t.ad.account;
        const targ = nameForAcc(acc);
        if(!targ){ skipped.push({ phone: t.phone, why: 'у кабинета ' + acc + ' не вписано имя таргетолога' }); continue; }
        const adTs = Math.floor(new Date(t.at).getTime() / 1000);
        let found = leadCache.get(t.phone);
        if(found === undefined){
          let contacts = [];
          try {
            const r = await amoFetch(`/contacts?query=${encodeURIComponent(t.phone)}&limit=10&with=leads`, env);
            contacts = (r && r._embedded && r._embedded.contacts) || [];
          } catch(e){ skipped.push({ phone: t.phone, why: 'поиск в amo не удался: ' + e.message }); leadCache.set(t.phone, null); continue; }
          const ids = [];
          contacts.forEach(c => ((c._embedded && c._embedded.leads) || []).forEach(l => { if(!ids.includes(l.id)) ids.push(l.id); }));
          const leads = [];
          for(const id of ids.slice(0, 8)){
            try { const l = await amoFetch(`/leads/${id}`, env); if(l) leads.push(l); } catch(_){}
          }
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

      // v931.3: отдельный доступ для заявок. Страница с лидформами лежит в другом
      // бизнес-портфолио, поэтому у неё свой системный пользователь (salesdoc-leads)
      // и свой токен. Основной META_ACCESS_TOKEN не трогаем — на нём держится
      // вся статистика расхода.
      const TOKEN = String(process.env.META_LEADS_TOKEN || process.env.META_ACCESS_TOKEN || '').trim();
      if(!TOKEN) return bad(res, 500, 'META_LEADS_TOKEN не задан');
      async function metaGet(path, params){
        const qs = new URLSearchParams(Object.assign({ access_token: TOKEN }, params || {}));
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

      const proto = req.headers['x-forwarded-proto'] || 'https';
      const host = req.headers['x-forwarded-host'] || req.headers.host;
      const adsResp = await fetch(`${proto}://${host}/api/meta-ads?endpoint=ads_map`, {
        headers: { 'x-app-token': String(process.env.APP_TOKEN || '').trim(), 'x-user-email': 'cron@salesdoc.io' }
      });
      const adsJson = await adsResp.json().catch(() => null);
      if(!adsJson || !Array.isArray(adsJson.ads)) return bad(res, 502, 'Не удалось получить список объявлений');

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
      for(const pg of pages){
        try {
          const r = await metaGet(`/${pg}/leadgen_forms`, { fields: 'id,name', limit: 200 });
          ((r && r.data) || []).forEach(fm => {
            if(!forms[fm.id]) forms[fm.id] = { ad_name: fm.name || null, ad_id: null,
              campaign: null, campaign_id: null, account: null, page_id: pg };
          });
        } catch(_){}
      }
      const targets = Object.keys(forms).length
        ? Object.keys(forms).map(fid => ({ kind: 'form', id: fid, ad: forms[fid] }))
        : adsJson.ads.map(a => ({ kind: 'ad', id: a.ad_id, ad: a }));
      for(const t of targets){
        if(scanned >= 250) break;
        scanned++;
        let page = null;
        try {
          page = await metaGet(`/${t.id}/leads`, {
            fields: 'id,created_time,ad_id,ad_name,campaign_id,campaign_name,form_id,field_data',
            filtering: JSON.stringify([{ field: 'time_created', operator: 'GREATER_THAN', value: sinceTs }]),
            limit: 200
          });
          okCount++;
        } catch(e){
          errCount++;
          if(adErrors.length < 5) adErrors.push({ kind: t.kind, id: t.id, name: t.ad.ad_name, code: e.code, error: e.message });
          continue;
        }
        ((page && page.data) || []).forEach(l => {
          let phone = '';
          ((l.field_data) || []).forEach(f => {
            if(!phone && phoneKeys.test(String(f.name || ''))) phone = String((f.values || [])[0] || '');
          });
          const digits = phone.replace(/\D/g, '');
          if(digits.length < 9) return;
          // Кабинет берём у объявления, которое привело заявку: одна форма может
          // стоять в объявлениях разных кампаний.
          const src = adById[l.ad_id] || t.ad;
          if(!src || !src.account) return; // кабинет неизвестен — приписать некому
          raw.push({ lead: l.id, at: l.created_time, phone: digits, form_id: l.form_id || t.id,
            ad_id: l.ad_id || src.ad_id, ad_name: l.ad_name || src.ad_name,
            campaign_id: l.campaign_id || src.campaign_id, campaign: l.campaign_name || src.campaign,
            account: src.account });
        });
      }

      // По телефону ищем сделку — так же, как в переписках.
      const rowsToSave = [], notFound = [], skipped = [];
      const seen = new Set();
      for(const f of raw){
        if(seen.has(f.lead)) continue;
        seen.add(f.lead);
        const targ = nameForAcc(f.account);
        if(!targ){ skipped.push({ ad: f.ad_name, why: 'у кабинета ' + f.account + ' не вписано имя таргетолога' }); continue; }
        const adTs = Math.floor(new Date(f.at).getTime() / 1000);
        let contacts = [];
        try {
          const r = await amoFetch(`/contacts?query=${encodeURIComponent(f.phone)}&limit=10&with=leads`, env);
          contacts = (r && r._embedded && r._embedded.contacts) || [];
        } catch(e){ skipped.push({ ad: f.ad_name, why: 'поиск в amo не удался: ' + e.message }); continue; }
        const ids = [];
        contacts.forEach(c => ((c._embedded && c._embedded.leads) || []).forEach(l => { if(!ids.includes(l.id)) ids.push(l.id); }));
        const leads = [];
        for(const id of ids.slice(0, 8)){
          try { const l = await amoFetch(`/leads/${id}`, env); if(l) leads.push(l); } catch(_){}
        }
        if(!leads.length){
          notFound.push({ at: f.at, targetolog: targ, campaign: f.campaign, ad_name: f.ad_name,
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
        ads_scanned: scanned, sources_ok: okCount, sources_failed: errCount,
        forms_leads_found: raw.length,
        matched: rowsToSave.length,
        saved, save_errors: saveErrors,
        ad_errors: adErrors,
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
    if(action === 'targ_report'){
      // v929: отчёт по таргетологам и объявлениям.
      // Слева цифры ровно как в рекламном кабинете (потрачено, результаты, цена результата,
      // показы, охват), справа — что из этих людей вышло в CRM: в работе, не квал и почему,
      // не взяли в работу, продали и на сколько. Считаем ПО ДАТЕ РЕКЛАМНОГО КАСАНИЯ:
      // если человека завели в августе, а вернула его сентябрьская реклама — продажа
      // ложится в сентябрь, туда же, где потрачены деньги (решение CEO 09.09.2026).
      const since = String(req.query.since || almatyIso(Date.now() - 30 * 86400000));
      const until = String(req.query.until || almatyIso(Date.now()));
      const proto = req.headers['x-forwarded-proto'] || 'https';
      const host = req.headers['x-forwarded-host'] || req.headers.host;
      const appTok = String(process.env.APP_TOKEN || '').trim();
      const selfGet = async (qs) => {
        const r = await fetch(`${proto}://${host}/api/meta-ads?${qs}`, {
          headers: { 'x-app-token': appTok, 'x-user-email': 'cron@salesdoc.io' }
        });
        return r.json().catch(() => null);
      };

      const [perf, map, settingsRows, pipelines] = await Promise.all([
        selfGet(`endpoint=ads_perf&since=${since}&until=${until}`),
        selfGet('endpoint=ads_map'),
        sbSelect('app_settings', { key: 'in.(mkt_targetologs,mkt_costs)' }).catch(() => []),
        getPipelines(env)
      ]);
      const sett = {};
      (settingsRows || []).forEach(r => { sett[r.key] = r.value; });
      const targByAcc = sett.mkt_targetologs || {};
      const nameForAcc = (acc) => targByAcc[acc] || targByAcc[String(acc).replace(/^act_/, '')] || null;
      const rate = Number(((sett.mkt_costs || {})[country] || {}).usd_rate) || 0;

      const thumbByAd = {};
      (((map && map.ads) || [])).forEach(a => { if(a.ad_id) thumbByAd[a.ad_id] = a.thumb || null; });

      // 1) Касания за период. Одна сделка — одно касание: если человек кликал несколько
      //    объявлений, заслуга у ПОСЛЕДНЕГО (решение CEO).
      const touches = await sbSelect('ad_touches', {
        country: 'eq.' + country,
        touched_at: 'gte.' + since + 'T00:00:00',
        order: 'touched_at.asc', limit: 5000
      });
      const inRange = touches.filter(t => String(t.touched_at).slice(0, 10) <= until);
      const lastByLead = new Map();
      inRange.forEach(t => { if(t.lead_id) lastByLead.set(t.lead_id, t); });

      // 2) Этапы воронки: что считать «не взяли в работу», «в работе», «слились», «продажа».
      const p = pipelines.find(x => /^лид/i.test(x.name || '')) || pipelines.find(x => x.is_main) || pipelines[0];
      const isLost = (st) => Number(st.id) === 143 || Number(st.sort) === 11000 || /закрыт.*не.*реализ|не реализ/i.test(String(st.name || ''));
      const isWon = (st) => Number(st.id) === 142 || Number(st.sort) === 10000 || /успешн.*реализ/i.test(String(st.name || ''));
      const flow = (p ? p.statuses : []).filter(st => !isLost(st) && !isWon(st)).sort((a, b) => a.sort - b.sort);
      const firstIds = new Set(flow.slice(0, 1).map(st => st.id)); // самый первый этап = ещё не взяли
      const stName = {};
      (p ? p.statuses : []).forEach(st => { stName[st.id] = st.name; });

      // Причины отказа — их выбирает менеджер, когда закрывает сделку.
      let lossName = {};
      try {
        const lr = await amoFetch('/leads/loss_reasons?limit=250', env);
        ((lr && lr._embedded && lr._embedded.loss_reasons) || []).forEach(x => { lossName[x.id] = x.name; });
      } catch(_){}

      // 3) Тянем сами сделки.
      const leads = {};
      for(const id of lastByLead.keys()){
        try { const l = await amoFetch(`/leads/${id}`, env); if(l) leads[id] = l; } catch(_){}
      }

      // 4) Раскладываем по объявлениям.
      const byAd = new Map();
      const slot = (adId) => {
        if(!byAd.has(adId)) byAd.set(adId, {
          crm_leads: 0, in_work: 0, not_taken: 0, lost: 0, won: 0, won_sum: 0,
          loss_reasons: {}, deals: []
        });
        return byAd.get(adId);
      };
      lastByLead.forEach((t, leadId) => {
        const l = leads[leadId];
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
        s.deals.push({ lead_id: leadId, name: l.name, stage: stName[l.status_id] || '—',
          bucket, price: Number(l.price || 0), touched_at: t.touched_at,
          lead_created: t.lead_created, ad_ambiguous: !!t.ad_ambiguous });
      });

      // 5) Собираем ответ: у каждого таргетолога его объявления с расходом.
      const out = {};
      ((perf && perf.ads) || []).forEach(a => {
        const targ = nameForAcc(a.account) || ('кабинет ' + a.account);
        if(!out[targ]) out[targ] = { targetolog: targ, account: a.account, spend: 0,
          chats: 0, leads_meta: 0, link_clicks: 0,
          crm_leads: 0, in_work: 0, not_taken: 0, lost: 0, won: 0, won_sum: 0, ads: [] };
        const t = out[targ];
        const s = byAd.get(a.ad_id) || null;
        t.spend += a.spend;
        // Переписки, заявки и клики нельзя складывать в одно число: у кампании «МК»
        // результат — клики по ссылке, и 135 кликов рядом с 17 перепискам врут в разы.
        if(a.result_kind === 'Начало переписки') t.chats += a.results;
        else if(a.result_kind === 'Заявки') t.leads_meta += a.results;
        else t.link_clicks += a.results;
        if(s){ t.crm_leads += s.crm_leads; t.in_work += s.in_work; t.not_taken += s.not_taken;
               t.lost += s.lost; t.won += s.won; t.won_sum += s.won_sum; }
        t.ads.push({
          ad_id: a.ad_id, ad_name: a.ad_name, campaign: a.campaign, thumb: thumbByAd[a.ad_id] || null,
          spend: a.spend, results: a.results, result_kind: a.result_kind, cost_per_result: a.cost_per_result,
          impressions: a.impressions, reach: a.reach, ctr: a.ctr,
          crm: s ? { leads: s.crm_leads, in_work: s.in_work, not_taken: s.not_taken,
                     lost: s.lost, won: s.won, won_sum: Math.round(s.won_sum),
                     loss_reasons: s.loss_reasons, deals: s.deals }
                 : { leads: 0, in_work: 0, not_taken: 0, lost: 0, won: 0, won_sum: 0, loss_reasons: {}, deals: [] }
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

      return res.status(200).json({
        country, since, until, usd_rate: rate || null,
        targetologs: list,
        touches_total: inRange.length,
        leads_attributed: lastByLead.size,
        note: 'Слева — цифры рекламного кабинета. Справа — только те люди, которых удалось узнать '
          + 'по ссылке на объявление в первом сообщении WhatsApp. Переписки копятся с 03.09.2026; '
          + 'заявки из Instagram Direct и звонки следа рекламы не несут и сюда не попадают.'
      });
    }
    if(action === 'lead_report'){
      // v897: отчёт по лидам за период — для экрана «Маркетинг».
      // ?slim=1 — без списка лидов (нужен для сравнения с прошлым месяцем).
      const fromTs = req.query.from ? Number(req.query.from) : null;
      const toTs = req.query.to ? Number(req.query.to) : null;
      if(!fromTs) return bad(res, 400, 'Need ?from=<unix> (&to=<unix>)');
      const slim = String(req.query.slim || '') === '1';
      const key = country + '|' + fromTs + '|' + (toTs || 0);
      let data = _lrGet(key);
      if(!data){
        data = await buildLeadReport(env, fromTs, toTs);
        if(!data.error) _lrSet(key, data);
      }
      if(data.error) return bad(res, 500, data.error);
      const out = Object.assign({ country: country }, data, { _subdomain: env.AMO_SUBDOMAIN });
      if(slim){ out.leads = []; out.leads_omitted = true; }
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

      const isLossStatus = (st) => Number(st.id) === 143 || Number(st.sort) === 11000 || /закрыт.*не.*реализ|не реализ/i.test(String(st.name||''));
      const isWonStatus  = (st) => Number(st.id) === 142 || Number(st.sort) === 10000 || /успешн.*реализ/i.test(String(st.name||''));
      const flow = p.statuses.filter(st => !isLossStatus(st) && !isWonStatus(st)).sort((a,b) => a.sort - b.sort);
      // Карта «этап → насколько далеко по воронке». Отказные этапы (sort 11000) НЕ значат,
      // что лид прошёл всю воронку — их reach берём только из истории смен статуса.
      // «Успешно реализовано» наоборот засчитываем как пройденную воронку целиком.
      const maxFlowSort = flow.length ? Number(flow[flow.length - 1].sort) : 0;
      const sortById = {};
      p.statuses.forEach(st => {
        if(isLossStatus(st)) return;
        sortById[st.id] = isWonStatus(st) ? maxFlowSort : Number(st.sort);
      });

      const pick = (re) => flow.find(st => re.test(String(st.name||'').toLowerCase()));
      const stMeeting = pick(/назначен.*встреч|встреч.*назначен/);
      const stInvoice = pick(/сч[еёe]т.*выставл|выставл.*сч[еёe]т/);

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
      const reachedSort = new Map(); // lead_id → максимальный sort этапа, где лид когда-либо был
      leads.forEach(l => {
        const st = sortById[l.status_id];
        if(st !== undefined) reachedSort.set(l.id, st);
      });
      let eventsScanned = 0, eventsTruncated = false, eventsError = null;
      try {
        for(let page = 1; page <= 40; page++){
          const evTo = Math.min(Math.floor(Date.now()/1000), (toTs ? toTs + 90*86400 : Math.floor(Date.now()/1000)));
        const ev = await amoFetch(`/events?filter[entity]=lead&filter[type][]=lead_status_changed&filter[created_at][from]=${fromTs}&filter[created_at][to]=${evTo}&limit=100&page=${page}`, env);
          if(!ev) break;
          const batch = (ev._embedded && ev._embedded.events) || [];
          if(!batch.length) break;
          eventsScanned += batch.length;
          batch.forEach(e => {
            const id = Number(e.entity_id);
            if(!leadIds.has(id)) return;
            const after = (e.value_after && e.value_after[0] && e.value_after[0].lead_status) || null;
            if(!after) return;
            const st = sortById[after.id];
            if(st === undefined) return;
            const prev = reachedSort.get(id);
            if(prev === undefined || st > prev) reachedSort.set(id, st);
          });
          if(batch.length < 100) break;
          if(page === 40) eventsTruncated = true;
        }
      } catch(e){ eventsError = e.message || String(e); }

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
          meeting: stMeeting ? { id: stMeeting.id, name: stMeeting.name, sort: stMeeting.sort, count: countReached(stMeeting) } : null,
          invoice: stInvoice ? { id: stInvoice.id, name: stInvoice.name, sort: stInvoice.sort, count: countReached(stInvoice) } : null
        },
        won: { count: wonLeads.length, sum: wonLeads.reduce((a,l) => a + Number(l.price||0), 0) },
        flow: flow.map(st => ({ id: st.id, name: st.name, sort: st.sort })),
        events: { scanned: eventsScanned, truncated: eventsTruncated, error: eventsError },
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
      function normalizePhone(p){
        const digits = String(p||'').replace(/\D/g, '');
        if(!digits) return null;
        // Казахстан: +7 / 8 → 7
        let n = digits;
        if(n.startsWith('8') && n.length === 11) n = '7' + n.slice(1);
        if(n.length === 10) n = '7' + n;
        return n.length >= 10 ? n : null;
      }

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
        const phoneMatch = line.match(/p:\+?(\d{10,11})/);
        if(!phoneMatch) return;
        const phone = normalizePhone(phoneMatch[1]);
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
                const p = normalizePhone(v.value);
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
    return bad(res, e.status || 500, e.message, { data: e.data });
  }
}
