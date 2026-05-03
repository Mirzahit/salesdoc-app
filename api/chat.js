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

function buildContextBlock(ctx) {
  if (!ctx || typeof ctx !== 'object') return '';
  const lines = [
    '<context>',
    `Страна: ${ctx.country || '—'}`,
    `Период: ${ctx.period || '—'}`,
    `Сегодня: ${ctx.today || '—'}`,
    `Платежей в периоде: ${ctx.payments_count ?? 0}`,
    `Сумма всего: ${fmtKZT(ctx.total_amount || 0)}`,
    `  · оплачено: ${fmtKZT(ctx.paid_amount || 0)}`,
    `  · в ожидании: ${fmtKZT(ctx.pending_amount || 0)}`,
  ];
  if (ctx.by_category && Object.keys(ctx.by_category).length) {
    lines.push('По статьям:');
    for (const [k, v] of Object.entries(ctx.by_category)) {
      lines.push(`  · ${k}: ${fmtKZT(v)}`);
    }
  }
  if (Array.isArray(ctx.top_managers) && ctx.top_managers.length) {
    lines.push('Топ менеджеров:');
    ctx.top_managers.forEach((m, i) => {
      lines.push(`  ${i + 1}. ${m.name} — ${fmtKZT(m.amount)}`);
    });
  }
  lines.push(`Сотрудников: ${ctx.employees_count ?? 0}, актов: ${ctx.acts_count ?? 0}, всего платежей за все периоды: ${ctx.total_payments_all_periods ?? 0}`);
  lines.push('</context>');
  return lines.join('\n');
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
