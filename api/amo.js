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
    let matched = false;
    tags.forEach(t => {
      const tn = String(t.name||'').toLowerCase();
      if(tn.includes('таргет таблица')) { tagCounts['таргет таблица']++; matched = true; }
      else if(tn === 'таргет' || tn.includes('таргет') && !tn.includes('таблица')) { tagCounts['ТАРГЕТ']++; matched = true; }
      else if(tn.includes('marquiz')) { tagCounts['marquiz']++; matched = true; }
    });
    if(matched) _accountedByTag++;
  });

  return {
    pipeline: { id: p.id, name: p.name },
    total_leads: leads.length,
    total_leads_unfiltered: allLeads.length,
    truncated: truncated,
    lost_count: lostCount,
    period: { from: fromTs || null, to: toTs || null },
    tag_filter: tagFilter || null,
    tag_counts: tagCounts,
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

export default async function handler(req, res){
  // v376: разрешаем POST для двусторонней синхронизации SD→amo (update_status, add_note).
  if(req.method !== 'GET' && req.method !== 'POST'){ return bad(res, 405, 'Only GET/POST'); }
  // v376: POST — защищены shared-secret APP_TOKEN. Иначе любой может менять статусы в amo.
  if(req.method === 'POST'){
    const expected = (process.env.APP_TOKEN || '').trim();
    if(expected){
      const got = (req.headers['x-app-token'] || '').toString().trim();
      if(got !== expected){
        return res.status(401).json({ error: 'Unauthorized' });
      }
    }
  }
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
    if(action === 'funnel'){
      const pipelineId = req.query.pipeline_id ? Number(req.query.pipeline_id) : null;
      const fromTs = req.query.from ? Number(req.query.from) : null;
      const toTs = req.query.to ? Number(req.query.to) : null;
      const tagFilter = req.query.tag || null; // v319: фильтр по тегу (имя)
      const data = await getFunnel(pipelineId, env, fromTs, toTs, tagFilter);
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
        if(/^|.*срм|crm|created/.test(t) && /срм|crm|created/.test(t)) {
          // 'srm' mentioned → в СРМ
          if(/срм|crm|created/.test(t)) return 'in_amo_marked';
        }
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
