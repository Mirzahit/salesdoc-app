// /api/meta-ads — Vercel Node serverless. Прокси к Meta Graph API.
// ENV: META_ACCESS_TOKEN, META_AD_ACCOUNT_ID (например act_105673026201294), META_BUSINESS_ID (опц.)
// Использование с фронта:
//   GET /api/meta-ads?endpoint=account_summary&period=last_7d
//   GET /api/meta-ads?endpoint=daily&period=last_30d
//   GET /api/meta-ads?endpoint=campaigns&period=last_30d
//   GET /api/meta-ads?endpoint=adsets&campaign_id=123&period=last_30d
//   GET /api/meta-ads?endpoint=ads&adset_id=456&period=last_30d

const META_API_VERSION = 'v21.0';
const ALLOWED_PERIODS = new Set([
  'today','yesterday','this_month','last_month','this_quarter','maximum',
  'last_3d','last_7d','last_14d','last_28d','last_30d','last_90d','last_year','this_year'
]);
const INSIGHT_FIELDS = 'spend,impressions,clicks,ctr,cpc,cpm,reach,frequency,date_start,date_stop';

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

export default async function handler(req, res) {
  // CORS — на случай если фронт деплоится на другой домен
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const TOKEN = process.env.META_ACCESS_TOKEN;
  const ACCOUNT = process.env.META_AD_ACCOUNT_ID;
  if (!TOKEN || !ACCOUNT) {
    return res.status(500).json({
      error: 'Missing env',
      detail: 'META_ACCESS_TOKEN или META_AD_ACCOUNT_ID не заданы в Vercel Environment Variables. Зайди в Project Settings → Environments → Production → Environment Variables и добавь их, потом Redeploy.'
    });
  }

  const endpoint = String(req.query.endpoint || 'account_summary');
  const period = validatePeriod(String(req.query.period || 'last_30d'));
  const cacheKey = JSON.stringify({ endpoint, period, q: req.query });
  const cached = cacheGet(cacheKey);
  if (cached) {
    res.setHeader('X-Cache', 'HIT');
    return res.status(200).json(cached);
  }

  try {
    let result;

    if (endpoint === 'account_summary') {
      // Сводка по всему аккаунту за период
      const data = await metaFetch(`/${ACCOUNT}/insights`, {
        fields: INSIGHT_FIELDS,
        date_preset: period,
        level: 'account'
      }, TOKEN);
      result = { period, summary: (data.data && data.data[0]) || null };

    } else if (endpoint === 'daily') {
      // Разбивка по дням
      const data = await metaFetch(`/${ACCOUNT}/insights`, {
        fields: INSIGHT_FIELDS,
        date_preset: period,
        level: 'account',
        time_increment: 1
      }, TOKEN);
      result = { period, days: data.data || [] };

    } else if (endpoint === 'campaigns') {
      // Все кампании с инсайтами за период
      const data = await metaFetch(`/${ACCOUNT}/campaigns`, {
        fields: `id,name,status,objective,daily_budget,lifetime_budget,start_time,stop_time,insights.date_preset(${period}){${INSIGHT_FIELDS}}`,
        limit: 200
      }, TOKEN);
      result = { period, campaigns: (data.data || []).map(c => ({
        id: c.id,
        name: c.name,
        status: c.status,
        objective: c.objective,
        daily_budget: c.daily_budget ? Number(c.daily_budget)/100 : null,
        lifetime_budget: c.lifetime_budget ? Number(c.lifetime_budget)/100 : null,
        start_time: c.start_time || null,
        stop_time: c.stop_time || null,
        insights: (c.insights && c.insights.data && c.insights.data[0]) || null
      })) };

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

    } else {
      return res.status(400).json({ error: 'Unknown endpoint', allowed: ['account_summary','daily','campaigns','adsets','ads','account_info'] });
    }

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
