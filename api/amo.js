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
    return bad(res, 400, 'Unknown action. Use ?action=pipelines or ?action=funnel');
  } catch(e){
    return bad(res, e.status || 500, e.message, { data: e.data });
  }
}
