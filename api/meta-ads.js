// /api/meta-ads — Vercel Node serverless. Прокси к Meta Graph API.
// ENV: META_ACCESS_TOKEN, META_AD_ACCOUNT_ID (например act_105673026201294)
// ENV для KG (если есть отдельный кабинет): META_AD_ACCOUNT_ID_KG, META_ACCESS_TOKEN_KG (опц., иначе используется общий)
// META_BUSINESS_ID (опц.)
// При вызове можно передать ?country=KG чтобы переключиться на KG-кабинет (по умолчанию KZ)
// Использование с фронта:
//   GET /api/meta-ads?endpoint=account_summary&period=last_7d
//   GET /api/meta-ads?endpoint=daily&period=last_30d
//   GET /api/meta-ads?endpoint=campaigns&period=last_30d
//   GET /api/meta-ads?endpoint=adsets&campaign_id=123&period=last_30d
//   GET /api/meta-ads?endpoint=ads&adset_id=456&period=last_30d

import { checkAuth } from './_auth.js';

const META_API_VERSION = 'v21.0';
const ALLOWED_PERIODS = new Set([
  'today','yesterday','this_month','last_month','this_quarter','maximum',
  'last_3d','last_7d','last_14d','last_28d','last_30d','last_90d','last_year','this_year'
]);
// v2: добавлены actions/action_values/cost_per_action_type — там лежат лиды/регистрации/покупки
// (если кампания настроена на лидген или есть Pixel). inline_link_clicks — переходы на сайт.
const INSIGHT_FIELDS = 'spend,impressions,clicks,inline_link_clicks,ctr,cpc,cpm,reach,frequency,actions,action_values,cost_per_action_type,date_start,date_stop';

// Маппинг action_type → человекочитаемое название для UI и фильтрации
const ACTION_TYPE_LABELS = {
  'lead': 'Лиды',
  'leadgen.other': 'Лиды (форма)',
  'onsite_conversion.lead_grouped': 'Лиды (форма Meta)',
  'complete_registration': 'Регистрации',
  'onsite_conversion.purchase': 'Покупки',
  'purchase': 'Покупки',
  'add_to_cart': 'Добавления в корзину',
  'initiate_checkout': 'Начало оформления',
  'subscribe': 'Подписки',
  'onsite_conversion.messaging_first_reply': 'Сообщения (первый ответ)',
  'onsite_conversion.messaging_conversation_started_7d': 'Начатые диалоги',
  'link_click': 'Переходы по ссылке',
  'landing_page_view': 'Просмотры лендинга',
  'video_view': 'Просмотры видео',
  'page_engagement': 'Реакции на страницу',
  'post_engagement': 'Реакции на пост'
};
// v344: для счётчика и сортировки — все типы которые в принципе могут быть лидом.
// Сам подсчёт ниже умный: берёт конкретные (форма/сайт) если есть, иначе generic `lead` fallback.
const LEAD_ACTION_TYPES = new Set(['lead','leadgen.other','onsite_conversion.lead_grouped']);
const LEAD_SPECIFIC_TYPES = new Set(['leadgen.other','onsite_conversion.lead_grouped']);

function summarizeLeads(actions, costPerActionType) {
  if (!Array.isArray(actions)) return { count: 0, breakdown: [], other_conversions: 0 };
  let specificSum = 0;
  let genericLead = 0;
  const breakdown = [];
  actions.forEach(a => {
    const type = a.action_type;
    const value = parseFloat(a.value || 0);
    if (LEAD_SPECIFIC_TYPES.has(type)) specificSum += value;
    else if (type === 'lead') genericLead = Math.max(genericLead, value);
    breakdown.push({
      action_type: type,
      label: ACTION_TYPE_LABELS[type] || type,
      value,
      cost: (() => {
        const c = (costPerActionType||[]).find(x => x.action_type === type);
        return c ? parseFloat(c.value) : null;
      })()
    });
  });
  // v443 откат: возвращаем generic `lead` как основную цифру (как было до v442).
  // Причина отката: после v442 цифра лидов (только формы+сайт) стала МЕНЬШЕ чем
  // «попало в amo» — связка визуально ломалась. CEO решил вернуть как было.
  // Расхождение с Meta-кабинетом принимаем как known issue.
  const leadCount = genericLead > 0 ? genericLead : specificSum;
  const otherConversions = 0;
  breakdown.sort((a,b) => {
    const aLead = LEAD_ACTION_TYPES.has(a.action_type) ? 1 : 0;
    const bLead = LEAD_ACTION_TYPES.has(b.action_type) ? 1 : 0;
    if (aLead !== bLead) return bLead - aLead;
    return b.value - a.value;
  });
  return { count: leadCount, breakdown, other_conversions: otherConversions };
}

// Простой in-memory кэш на 10 минут — Meta API rate-limited
const _cache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000;

function cacheGet(key) {
  const e = _cache.get(key);
  if (!e) return null;
  if (Date.now() - e.t > CACHE_TTL_MS) { _cache.delete(key); return null; }
  return e.v;
}
function cacheSet(key, v) { _cache.set(key, { t: Date.now(), v }); }

async function metaFetch(pathOrUrl, params, token) {
  const url = pathOrUrl.startsWith('http')
    ? new URL(pathOrUrl)
    : new URL(`https://graph.facebook.com/${META_API_VERSION}${pathOrUrl}`);
  if (params) Object.entries(params).forEach(([k,v]) => {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  });
  url.searchParams.set('access_token', token);
  const res = await fetch(url.toString());
  const json = await res.json();
  if (!res.ok || json.error) {
    const msg = json.error ? `${json.error.code}/${json.error.error_subcode||'-'}: ${json.error.message}` : `HTTP ${res.status}`;
    const e = new Error(msg); e.metaError = json.error || null; e.status = res.status;
    throw e;
  }
  return json;
}

function validatePeriod(p) {
  return p && ALLOWED_PERIODS.has(p) ? p : 'last_30d';
}

// Возвращает количество дней в периоде для расчёта предыдущего отрезка.
// Для нестандартных period (this_month, last_month и т.п.) — возвращаем null,
// сравнение тогда делаем эвристически (этот месяц vs прошлый).
function periodDays(p) {
  const m = { last_3d:3, last_7d:7, last_14d:14, last_28d:28, last_30d:30, last_90d:90, today:1, yesterday:1 };
  return m[p] || null;
}
function ymd(d) { return d.toISOString().slice(0,10); }
// Считает time_range предыдущего периода той же длины, заканчивающегося ровно перед текущим.
// Например: last_7d покрывает [T-7..T-1], previous → [T-14..T-8].
function previousRangeFor(p) {
  const days = periodDays(p);
  if (days) {
    const today = new Date();
    today.setUTCHours(0,0,0,0);
    const untilCurrent = new Date(today.getTime() - 1*86400000); // вчера (последний день текущего since-until)
    const sincePrev = new Date(untilCurrent.getTime() - (2*days - 1)*86400000);
    const untilPrev = new Date(untilCurrent.getTime() - days*86400000);
    return { since: ymd(sincePrev), until: ymd(untilPrev) };
  }
  if (p === 'this_month') return { date_preset: 'last_month' };
  if (p === 'last_month') {
    const today = new Date(); today.setUTCDate(1);
    const lastMonthEnd = new Date(today.getTime() - 1*86400000);
    const prevMonthStart = new Date(Date.UTC(lastMonthEnd.getUTCFullYear(), lastMonthEnd.getUTCMonth()-1, 1));
    const prevMonthEnd = new Date(today.getTime() - 1*86400000);
    prevMonthEnd.setUTCMonth(prevMonthEnd.getUTCMonth());
    prevMonthEnd.setUTCDate(0);
    return { since: ymd(prevMonthStart), until: ymd(prevMonthEnd) };
  }
  return null;
}

export default async function handler(req, res) {
  // v626 SEC: эндпоинт same-origin. Убран wildcard CORS '*' (раньше любой сайт мог читать
  // рекламные бюджеты/эффективность кампаний). Добавлена проверка x-app-token (checkAuth).
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!checkAuth(req, res)) return;

  // v360: поддержка двух стран — KZ (по умолчанию) и KG (через ?country=KG).
  // .trim() убирает невидимые пробелы при копи-паст в Vercel UI.
  const country = String(req.query.country || 'KZ').toUpperCase();
  let TOKEN, ACCOUNT;
  if (country === 'KG') {
    ACCOUNT = (process.env.META_AD_ACCOUNT_ID_KG || '').trim();
    // Если отдельного KG-токена нет, используем общий (если оба кабинета под одним Business Manager)
    TOKEN = (process.env.META_ACCESS_TOKEN_KG || process.env.META_ACCESS_TOKEN || '').trim();
    if (!ACCOUNT) {
      return res.status(500).json({
        error: 'Missing env KG',
        detail: 'META_AD_ACCOUNT_ID_KG не задан. Добавь в Vercel env ID кыргызского рекламного кабинета (act_xxx), потом Redeploy.'
      });
    }
  } else {
    TOKEN = (process.env.META_ACCESS_TOKEN || '').trim();
    ACCOUNT = (process.env.META_AD_ACCOUNT_ID || '').trim();
  }
  if (!TOKEN || !ACCOUNT) {
    return res.status(500).json({
      error: 'Missing env',
      detail: 'META_ACCESS_TOKEN или META_AD_ACCOUNT_ID не заданы в Vercel Environment Variables. Зайди в Project Settings → Environments → Production → Environment Variables и добавь их, потом Redeploy.'
    });
  }

  const endpoint = String(req.query.endpoint || 'account_summary');
  const period = validatePeriod(String(req.query.period || 'last_30d'));
  // v442: country явно префиксом — раньше попадал внутрь req.query, но порядок ключей
  // в JSON.stringify не гарантирован, что давало риск смешения кэша KZ и KG.
  // v786: country в верхний регистр — 'kz' и 'KZ' раньше плодили два кэша (двойные запросы к Meta)
  const cacheKey = String(country || '').toUpperCase() + '|' + endpoint + '|' + period + '|' + JSON.stringify(req.query);
  const cached = cacheGet(cacheKey);
  if (cached) {
    res.setHeader('X-Cache', 'HIT');
    return res.status(200).json(cached);
  }

  try {
    let result;

    if (endpoint === 'account_summary') {
      // Сводка по аккаунту за период + аналогичный предыдущий период для сравнения
      const prevRange = previousRangeFor(period);
      const currentReq = metaFetch(`/${ACCOUNT}/insights`, {
        fields: INSIGHT_FIELDS,
        date_preset: period,
        level: 'account'
      }, TOKEN);
      const prevReq = prevRange ? metaFetch(`/${ACCOUNT}/insights`, {
        fields: INSIGHT_FIELDS,
        level: 'account',
        ...(prevRange.date_preset
          ? { date_preset: prevRange.date_preset }
          : { time_range: JSON.stringify({ since: prevRange.since, until: prevRange.until }) })
      }, TOKEN).catch(() => ({ data: [] })) : Promise.resolve({ data: [] });

      const [curData, prevData] = await Promise.all([currentReq, prevReq]);
      const cur = (curData.data && curData.data[0]) || null;
      const prev = (prevData.data && prevData.data[0]) || null;

      // Обогащаем leads breakdown'ом + other_conversions (v442 — для подписки под цифрой лидов).
      const enrich = (s) => {
        if (!s) return null;
        const leads = summarizeLeads(s.actions, s.cost_per_action_type);
        return { ...s, leads_count: leads.count, other_conversions: leads.other_conversions || 0, actions_breakdown: leads.breakdown };
      };
      result = {
        period,
        summary: enrich(cur),
        previous: enrich(prev),
        previous_range: prevRange
      };

    } else if (endpoint === 'daily') {
      // Разбивка по дням.
      // v797: limit обязателен — дефолтная страница Meta = 25 строк, и last_90d обрывался
      // на 25-м дне (недельная динамика в Маркетинге показывала апрель вместо июля).
      const data = await metaFetch(`/${ACCOUNT}/insights`, {
        fields: INSIGHT_FIELDS,
        date_preset: period,
        level: 'account',
        time_increment: 1,
        limit: 100
      }, TOKEN);
      const days = (data.data || []).map(d => {
        const leads = summarizeLeads(d.actions, d.cost_per_action_type);
        return { ...d, leads_count: leads.count };
      });
      result = { period, days };

    } else if (endpoint === 'campaigns') {
      // Все кампании с инсайтами за период
      const data = await metaFetch(`/${ACCOUNT}/campaigns`, {
        fields: `id,name,status,objective,daily_budget,lifetime_budget,start_time,stop_time,insights.date_preset(${period}){${INSIGHT_FIELDS}}`,
        limit: 200
      }, TOKEN);
      result = { period, campaigns: (data.data || []).map(c => {
        const ins = (c.insights && c.insights.data && c.insights.data[0]) || null;
        const leads = ins ? summarizeLeads(ins.actions, ins.cost_per_action_type) : { count: 0, breakdown: [] };
        return {
          id: c.id,
          name: c.name,
          status: c.status,
          objective: c.objective,
          daily_budget: c.daily_budget ? Number(c.daily_budget)/100 : null,
          lifetime_budget: c.lifetime_budget ? Number(c.lifetime_budget)/100 : null,
          start_time: c.start_time || null,
          stop_time: c.stop_time || null,
          insights: ins ? { ...ins, leads_count: leads.count, actions_breakdown: leads.breakdown } : null
        };
      }) };

    } else if (endpoint === 'adsets') {
      const campaignId = String(req.query.campaign_id || '');
      if (!campaignId) return res.status(400).json({ error: 'campaign_id required' });
      const data = await metaFetch(`/${campaignId}/adsets`, {
        fields: `id,name,status,daily_budget,lifetime_budget,targeting,insights.date_preset(${period}){${INSIGHT_FIELDS}}`,
        limit: 200
      }, TOKEN);
      result = { period, campaign_id: campaignId, adsets: (data.data || []).map(a => ({
        id: a.id,
        name: a.name,
        status: a.status,
        daily_budget: a.daily_budget ? Number(a.daily_budget)/100 : null,
        lifetime_budget: a.lifetime_budget ? Number(a.lifetime_budget)/100 : null,
        targeting_summary: a.targeting ? {
          countries: (a.targeting.geo_locations && a.targeting.geo_locations.countries) || [],
          age_min: a.targeting.age_min, age_max: a.targeting.age_max,
          genders: a.targeting.genders
        } : null,
        insights: (a.insights && a.insights.data && a.insights.data[0]) || null
      })) };

    } else if (endpoint === 'ads') {
      const adsetId = String(req.query.adset_id || '');
      if (!adsetId) return res.status(400).json({ error: 'adset_id required' });
      const data = await metaFetch(`/${adsetId}/ads`, {
        fields: `id,name,status,creative{thumbnail_url,title,body},insights.date_preset(${period}){${INSIGHT_FIELDS}}`,
        limit: 200
      }, TOKEN);
      result = { period, adset_id: adsetId, ads: (data.data || []).map(a => ({
        id: a.id,
        name: a.name,
        status: a.status,
        creative: a.creative || null,
        insights: (a.insights && a.insights.data && a.insights.data[0]) || null
      })) };

    } else if (endpoint === 'account_info') {
      // Метаданные аккаунта (валюта, таймзона)
      const data = await metaFetch(`/${ACCOUNT}`, {
        fields: 'id,name,currency,timezone_name,account_status,business_name,amount_spent,balance'
      }, TOKEN);
      result = data;

    } else if (endpoint === 'all_ads') {
      // Все объявления аккаунта за период (с пагинацией) — для рейтинга эффективности.
      // ВАЖНО: вложенный insights по многим объявлениям сразу → Meta error #1
      // "reduce the amount of data". Поэтому маленький limit на страницу + только
      // нужные поля insights (без cpm/reach/frequency/cpc/дат).
      const adInsightFields = 'spend,impressions,clicks,ctr,actions,cost_per_action_type';
      const adFields = `id,name,effective_status,campaign{name},adset{name},creative{thumbnail_url,object_type,video_id,image_hash},insights.date_preset(${period}){${adInsightFields}}`;
      const MAX_ADS = 500;
      const PAGE = 25;
      let collected = [];
      let truncated = false;
      let guard = 0;
      let data = await metaFetch(`/${ACCOUNT}/ads`, { fields: adFields, limit: PAGE }, TOKEN);
      while (data) {
        collected = collected.concat(data.data || []);
        if (collected.length >= MAX_ADS) { truncated = true; break; }
        const next = data.paging && data.paging.next;
        if (!next || guard++ > 40) break;
        data = await metaFetch(next, null, TOKEN);
      }
      const ads = collected.map(a => {
        const ins = (a.insights && a.insights.data && a.insights.data[0]) || null;
        const leads = ins ? summarizeLeads(ins.actions, ins.cost_per_action_type) : { count: 0 };
        const spend = ins ? parseFloat(ins.spend || 0) : 0;
        const cr = a.creative || {};
        return {
          id: a.id,
          name: a.name,
          effective_status: a.effective_status || null,
          campaign_name: (a.campaign && a.campaign.name) || null,
          adset_name: (a.adset && a.adset.name) || null,
          creative: {
            thumbnail_url: cr.thumbnail_url || null,
            type: cr.video_id ? 'видео' : 'баннер',
            video_id: cr.video_id || null,
            image_hash: cr.image_hash || null
          },
          spend,
          impressions: ins ? Number(ins.impressions || 0) : 0,
          clicks: ins ? Number(ins.clicks || 0) : 0,
          ctr: ins ? parseFloat(ins.ctr || 0) : 0,
          leads: leads.count || 0,
          cost_per_lead: (leads.count > 0) ? (spend / leads.count) : null
        };
      });
      result = { period, account_id: ACCOUNT, ads, truncated };

    } else {
      return res.status(400).json({ error: 'Unknown endpoint', allowed: ['account_summary','daily','campaigns','adsets','ads','all_ads','account_info'] });
    }

    // v442: метка страны в ответе — для отладки в DevTools Network видно какой кабинет ответил.
    result.country = country;
    cacheSet(cacheKey, result);
    res.setHeader('X-Cache', 'MISS');
    return res.status(200).json(result);

  } catch (err) {
    console.error('meta-ads error:', err);
    return res.status(err.status || 500).json({
      error: err.message || 'Meta API error',
      meta: err.metaError || null
    });
  }
}
