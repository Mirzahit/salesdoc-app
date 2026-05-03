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

    const { agentId, messages, context } = req.body || {};
    if (!agentId || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'Нужны поля {agentId, messages[]}' });
    }

    const cfg = loadAgents();
    const agent = cfg.agents?.[agentId];
    if (!agent) {
      return res.status(400).json({ error: `Агент "${agentId}" не найден в agents.json` });
    }

    // Контекст вкручиваем в первое user-сообщение
    const ctxBlock = buildContextBlock(context);
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
