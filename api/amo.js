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

async function getFunnel(pipelineId, env, fromTs, toTs){
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
  const leads = [];
  let truncated = false;
  for(let page = 1; page <= 5; page++){
    const data = await amoFetch(`/leads?filter[pipeline_id]=${p.id}${dateFilter}&limit=250&page=${page}`, env);
    if(!data) break;
    const batch = (data._embedded && data._embedded.leads) || [];
    if(!batch.length) break;
    leads.push(...batch);
    if(batch.length < 250) break;
    if(page === 5 && batch.length === 250){ truncated = true; }
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

  return {
    pipeline: { id: p.id, name: p.name },
    total_leads: leads.length,
    truncated: truncated,
    lost_count: lostCount,
    period: { from: fromTs || null, to: toTs || null },
    stages: stages,
    logical_flow: logicalFlow
  };
}

export default async function handler(req, res){
  if(req.method !== 'GET'){ return bad(res, 405, 'Only GET'); }
  const env = {
    AMO_SUBDOMAIN: process.env.AMO_SUBDOMAIN,
    AMO_TOKEN: process.env.AMO_TOKEN,
    AMO_ACCOUNT_ID: process.env.AMO_ACCOUNT_ID
  };
  if(!env.AMO_SUBDOMAIN || !env.AMO_TOKEN){
    return bad(res, 500, 'AMO env not configured: set AMO_SUBDOMAIN and AMO_TOKEN in Vercel');
  }

  const action = String((req.query && req.query.action) || '').toLowerCase();

  try {
    if(action === 'pipelines'){
      const list = await getPipelines(env);
      return res.status(200).json({ pipelines: list });
    }
    if(action === 'funnel'){
      const pipelineId = req.query.pipeline_id ? Number(req.query.pipeline_id) : null;
      // v312: период фильтрует по created_at лида. Передавать как unix-секунды.
      const fromTs = req.query.from ? Number(req.query.from) : null;
      const toTs = req.query.to ? Number(req.query.to) : null;
      const data = await getFunnel(pipelineId, env, fromTs, toTs);
      return res.status(200).json(data);
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
      return res.status(200).json({
        leads_fetched: leads.length,
        with_any_tag: withAnyTag,
        without_tag: withoutTag,
        all_tags_in_account: allTags.length,
        top_tags: tagSorted
      });
    }
    return bad(res, 400, 'Unknown action. Use ?action=pipelines | funnel | tag_breakdown');
  } catch(e){
    return bad(res, e.status || 500, e.message, { data: e.data });
  }
}
