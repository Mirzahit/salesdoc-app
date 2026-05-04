// /api/chat — Vercel Node serverless function (v147)
// Принимает {agentId, messages, context} и проксирует к Anthropic API.
// ENV: ANTHROPIC_API_KEY (обязательно), задать в Vercel Project Settings → Environment Variables.

import fs from 'node:fs';
import path from 'node:path';

let _agentsCache = null;
function loadAgents() {
  if (_agentsCache) return _agentsCache;
  // agents.json лежит рядом с chat.js
  const p = path.join(process.cwd(), 'api', 'agents.json');
  const raw = fs.readFileSync(p, 'utf8');
  _agentsCache = JSON.parse(raw);
  return _agentsCache;
}

function fmtKZT(n) {
  if (typeof n !== 'number' || isNaN(n)) return String(n);
  return Math.round(n).toLocaleString('ru-KZ') + ' ₸';
}

// v163: собираем контекст таргета для Маркетолога — дёргаем наш же /api/meta-ads
async function buildMarketingContext(req) {
  // Определяем base URL — на Vercel это req.headers.host + https://
  const host = (req && req.headers && req.headers.host) || 'salesdoc-app.vercel.app';
  const proto = host.includes('localhost') ? 'http' : 'https';
  const base = `${proto}://${host}`;

  // Параллельно тянем сводку 7 дней, 30 дней, ТЕКУЩИЙ календарный месяц,
  // динамику по дням за last_30d, инфо аккаунта и активные кампании.
  const [sum7, sum30, sumThisMonth, daily30, info, camps30] = await Promise.all([
    fetch(`${base}/api/meta-ads?endpoint=account_summary&period=last_7d`).then(r => r.json()).catch(e => ({ error: e.message })),
    fetch(`${base}/api/meta-ads?endpoint=account_summary&period=last_30d`).then(r => r.json()).catch(e => ({ error: e.message })),
    fetch(`${base}/api/meta-ads?endpoint=account_summary&period=this_month`).then(r => r.json()).catch(e => ({ error: e.message })),
    fetch(`${base}/api/meta-ads?endpoint=daily&period=last_30d`).then(r => r.json()).catch(e => ({ error: e.message })),
    fetch(`${base}/api/meta-ads?endpoint=account_info`).then(r => r.json()).catch(e => ({ error: e.message })),
    fetch(`${base}/api/meta-ads?endpoint=campaigns&period=last_30d`).then(r => r.json()).catch(e => ({ error: e.message }))
  ]);

  if (sum7.error) throw new Error('Meta Ads API: ' + sum7.error);

  const cur = (info && info.currency) || 'USD';
  const sym = cur === 'USD' ? '$' : (cur === 'KZT' ? '₸' : cur + ' ');
  const fmt = v => sym + (parseFloat(v || 0).toLocaleString('en-US', { maximumFractionDigits: 2 }));
  const num = v => Math.round(parseFloat(v || 0)).toLocaleString('en-US');

  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  const monthName = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'][today.getUTCMonth()];

  const out = ['<context>'];
  out.push(`Аккаунт Meta Ads: ${info.id || '—'} · валюта ${cur} · таймзона ${info.timezone_name || '—'}`);
  out.push(`Сегодня: ${todayStr} (${today.getUTCDate()} ${monthName} ${today.getUTCFullYear()} г.)`);
  out.push('');

  // Сводка last_7d
  const s7 = sum7.summary || {};
  const p7 = sum7.previous || {};
  if (s7.spend !== undefined) {
    out.push('## Последние 7 дней (' + (s7.date_start || '?') + ' — ' + (s7.date_stop || '?') + ')');
    out.push(`Расход: ${fmt(s7.spend)} · Лиды: ${num(s7.leads_count)} · CPL: ${s7.leads_count > 0 ? fmt(parseFloat(s7.spend) / s7.leads_count) : '—'}`);
    out.push(`Показы: ${num(s7.impressions)} · Клики: ${num(s7.clicks)} · CTR: ${parseFloat(s7.ctr || 0).toFixed(2)}% · CPC: ${fmt(s7.cpc)} · CPM: ${fmt(s7.cpm)}`);
    out.push(`Охват: ${num(s7.reach)} · Частота: ${parseFloat(s7.frequency || 0).toFixed(2)}`);
    if (p7.spend !== undefined) {
      out.push(`Прошлая неделя: Расход ${fmt(p7.spend)} · Лиды ${num(p7.leads_count)} · CTR ${parseFloat(p7.ctr || 0).toFixed(2)}%`);
    }
    out.push('');
  }

  // Сводка last_30d (rolling 30 — последние 30 дней)
  const s30 = (sum30 && sum30.summary) || {};
  if (s30.spend !== undefined) {
    out.push('## Последние 30 дней (rolling, не календарный месяц)');
    out.push(`Период: ${s30.date_start} — ${s30.date_stop}`);
    out.push(`Расход: ${fmt(s30.spend)} · Лиды: ${num(s30.leads_count)} · CPL: ${s30.leads_count > 0 ? fmt(parseFloat(s30.spend) / s30.leads_count) : '—'}`);
    out.push(`CTR: ${parseFloat(s30.ctr || 0).toFixed(2)}% · CPC: ${fmt(s30.cpc)} · Охват: ${num(s30.reach)}`);
    out.push('');
  }

  // Текущий календарный месяц (this_month) — с 1-го числа по сегодня
  const sM = (sumThisMonth && sumThisMonth.summary) || {};
  if (sM.spend !== undefined) {
    out.push(`## Текущий календарный месяц (${monthName} ${today.getUTCFullYear()})`);
    out.push(`Период: ${sM.date_start} — ${sM.date_stop}`);
    out.push(`Расход: ${fmt(sM.spend)} · Лиды: ${num(sM.leads_count)} · CPL: ${sM.leads_count > 0 ? fmt(parseFloat(sM.spend) / sM.leads_count) : '—'}`);
    out.push(`CTR: ${parseFloat(sM.ctr || 0).toFixed(2)}% · Охват: ${num(sM.reach)}`);
    out.push('');
  } else {
    out.push(`## Текущий календарный месяц (${monthName} ${today.getUTCFullYear()})`);
    out.push('Данных нет — месяц только начался либо не было показов.');
    out.push('');
  }

  // Кампании 30 дней — только активные с расходом >0
  const camps = ((camps30 && camps30.campaigns) || [])
    .filter(c => c.status === 'ACTIVE' && c.insights && parseFloat(c.insights.spend || 0) > 0)
    .sort((a, b) => parseFloat(b.insights.spend || 0) - parseFloat(a.insights.spend || 0))
    .slice(0, 10);
  if (camps.length) {
    out.push('## Активные кампании (30 дней, топ-10 по расходу)');
    out.push('кампания | расход | лиды | CPL | CTR | клики');
    camps.forEach(c => {
      const ins = c.insights;
      const leads = parseFloat(ins.leads_count || 0);
      const cpl = leads > 0 ? fmt(parseFloat(ins.spend) / leads) : '—';
      out.push(`${c.name} | ${fmt(ins.spend)} | ${num(leads)} | ${cpl} | ${parseFloat(ins.ctr || 0).toFixed(2)}% | ${num(ins.clicks)}`);
    });
    out.push('');
  }

  // Динамика по дням (только если данных 7+ дней)
  const days = (daily30 && daily30.days) || [];
  if (days.length >= 7) {
    out.push('## Расход и лиды по дням (последние 30)');
    days.forEach(d => {
      const lc = parseFloat(d.leads_count || 0);
      out.push(`${d.date_start}: расход ${fmt(d.spend)} · лиды ${num(lc)}${lc > 0 ? ` (CPL ${fmt(parseFloat(d.spend) / lc)})` : ''}`);
    });
    out.push('');
  }

  // Активные events для понимания типа конверсий
  const breakdown = (s7.actions_breakdown || []).filter(a => a.value > 0).slice(0, 10);
  if (breakdown.length) {
    out.push('## Какие события считаются (за 7 дней)');
    breakdown.forEach(a => {
      out.push(`${a.label}: ${num(a.value)}${a.cost ? ` (по ${fmt(a.cost)})` : ''}`);
    });
  }

  out.push('</context>');
  return out.join('\n');
}

// v150: формируем расширенный контекст — всё что у агента есть про финансы.
// Содержит: общие итоги, сводку по месяцам, полный список платежей в компактной форме.
function buildContextBlock(ctx) {
  if (!ctx || typeof ctx !== 'object') return '';
  if (ctx.error) return `<context>\nОшибка сборки контекста: ${ctx.error}\n</context>`;

  const out = [];
  out.push('<context>');
  out.push(`Страна: ${ctx.country || '—'} · Сегодня: ${ctx.today || '—'} · UI-период (на экране у пользователя): ${ctx.ui_current_period_label || '—'}`);
  out.push('');

  // Общие итоги (по всем периодам)
  const t = ctx.totals || {};
  out.push('## Общие итоги (за все периоды)');
  out.push(`Платежей: ${t.count ?? 0} · Сумма: ${fmtKZT(t.total||0)} · Оплачено: ${fmtKZT(t.paid||0)} · В ожидании: ${fmtKZT(t.pending||0)}`);
  out.push(`Сотрудников: ${ctx.employees_count ?? 0} · Актов: ${ctx.acts_count ?? 0}`);
  out.push('');

  // Сводка по месяцам
  if (Array.isArray(ctx.by_month) && ctx.by_month.length) {
    out.push('## Сводка по месяцам');
    out.push('месяц | платежей | всего | оплачено | в ожидании | топ-менеджер');
    ctx.by_month.forEach(m => {
      const top = (m.top_managers && m.top_managers[0]) ? `${m.top_managers[0].name} (${fmtKZT(m.top_managers[0].amount)})` : '—';
      out.push(`${m.month} | ${m.count} | ${fmtKZT(m.total)} | ${fmtKZT(m.paid)} | ${fmtKZT(m.pending)} | ${top}`);
    });
    out.push('');

    // По каждому месяцу — детализация по статьям и топ-5 менеджеров
    out.push('## Детализация по месяцам (статьи + топ менеджеров)');
    ctx.by_month.forEach(m => {
      out.push(`### ${m.month}`);
      if (m.by_category && Object.keys(m.by_category).length) {
        const cats = Object.entries(m.by_category).sort((a,b)=>b[1]-a[1]);
        out.push('  статьи: ' + cats.map(([k,v]) => `${k}=${fmtKZT(v)}`).join(' · '));
      }
      if (m.top_managers && m.top_managers.length) {
        out.push('  менеджеры: ' + m.top_managers.map(x => `${x.name}=${fmtKZT(x.amount)}`).join(' · '));
      }
    });
    out.push('');
  }

  // Полный список платежей в компактной форме (CSV-like)
  if (Array.isArray(ctx.payments) && ctx.payments.length) {
    out.push(`## Все платежи (${ctx.payments.length} записей)`);
    out.push('Формат: дата | клиент | сумма ₸ | менеджер | статья | статус | банк | seated');
    ctx.payments.forEach(p => {
      out.push(`${p.d}|${p.c}|${p.a}|${p.m}|${p.cat}|${p.s}|${p.b}|${p.seated?'1':'0'}`);
    });
    out.push('');
  }

  out.push('Используй эти данные первыми. Не выдумывай альтернативные цифры. Если нужного среза нет — скажи, какие данные дополнительно нужны.');
  out.push('</context>');
  return out.join('\n');
}

export default async function handler(req, res) {
  // CORS — на случай вызова не с того же origin (не критично, но безопасно)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'ANTHROPIC_API_KEY не задан в Vercel env' });
    }

    const { agentId, messages, context, userEmail } = req.body || {};
    if (!agentId || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'Нужны поля {agentId, messages[]}' });
    }

    // v151 SECURITY: серверная защита — Финансист только для CEO.
    // Это страховка на случай, если фронт обойдут. Список можно расширить
    // через ENV ASSISTANT_ALLOWED_EMAILS (через запятую).
    const allowedRaw = process.env.ASSISTANT_ALLOWED_EMAILS || 'office@salesdoc.io';
    const allowed = allowedRaw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    const callerEmail = String(userEmail || '').trim().toLowerCase();
    if (!callerEmail || allowed.indexOf(callerEmail) === -1) {
      return res.status(403).json({ error: 'Доступ запрещён: ассистент доступен только определённым пользователям.' });
    }

    const cfg = loadAgents();
    const agent = cfg.agents?.[agentId];
    if (!agent) {
      return res.status(400).json({ error: `Агент "${agentId}" не найден в agents.json` });
    }

    // Контекст вкручиваем в первое user-сообщение
    let ctxBlock = buildContextBlock(context);

    // v163: для Маркетолога — подтягиваем свежие данные Meta Ads и подмешиваем
    // в контекст. Это серверный fetch, токен в env.
    if (agentId === 'marketing') {
      try {
        const marketingCtx = await buildMarketingContext(req);
        ctxBlock = (ctxBlock ? ctxBlock + '\n\n' : '') + marketingCtx;
      } catch (mErr) {
        console.warn('marketing context build failed:', mErr.message);
        ctxBlock = (ctxBlock ? ctxBlock + '\n\n' : '') +
          `<context>\nMeta Ads API недоступен: ${mErr.message}\n</context>`;
      }
    }

    const msgs = messages.map(m => ({ role: m.role, content: m.content }));
    if (ctxBlock) {
      const firstUserIdx = msgs.findIndex(m => m.role === 'user');
      if (firstUserIdx !== -1) {
        msgs[firstUserIdx] = {
          role: 'user',
          content: ctxBlock + '\n\n' + msgs[firstUserIdx].content
        };
      }
    }

    // Anthropic API call (Messages API). Prompt caching на system-промпт.
    const apiResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: agent.model || cfg._default_model || 'claude-sonnet-4-5-20250929',
        max_tokens: agent.max_tokens || 1500,
        system: [
          {
            type: 'text',
            text: agent.system_prompt,
            cache_control: { type: 'ephemeral' }
          }
        ],
        messages: msgs
      })
    });

    if (!apiResp.ok) {
      const errTxt = await apiResp.text();
      return res.status(apiResp.status).json({
        error: `Anthropic API ${apiResp.status}: ${errTxt.slice(0, 500)}`
      });
    }

    const data = await apiResp.json();
    const reply = (data.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n')
      .trim();

    return res.status(200).json({
      reply,
      usage: data.usage || null,
      model: data.model || null
    });
  } catch (e) {
    return res.status(500).json({ error: e.message || String(e) });
  }
}
