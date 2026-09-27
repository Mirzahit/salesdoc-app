// /api/finansist-agent — чат и вопросы «Финансиста» (v1006). Право view_finansist (владелец и бухгалтер).
//
// GET  ?action=history&limit=60          → история чата (общая для владельца и бухгалтера)
// POST ?action=chat        { text }       → ход агента: инструменты, ответ, след; пишет в finansist_chat_messages
// POST ?action=refresh     { month }      → обход месяца вручную (кнопка «Обновить»); ночью то же делает крон
// GET  ?action=questions&month=YYYY-MM    → вопросы агента: открытые и отвеченные
// POST ?action=answer      { id, idx }    → ответ на вопрос + решение в finansist_decisions
// GET  ?action=missing&month=YYYY-MM      → недостающие данные месяца (с синхронизацией по таблице расходов)
// POST ?action=missing_fill   { id, amount } → бухгалтер внесла сумму (учитывается в расчётах, пока в таблице нет настоящей строки)
// POST ?action=missing_ignore { id }      → «такой статьи в этом месяце нет»
// GET  ?action=spend                      → расход на API сегодня и лимит
// GET  ?action=rules                      → настройки правил (app_settings.finansist_rules)
// POST ?action=rules_save  { integrators_kzt, integrators_tolerance_pct, safe_balance, owner_names } → сохранить
// GET  ?action=prepaid                    → предоплаченные расходы (app_settings.finansist_prepaid)
// POST ?action=prepaid_add { label, item_key, amount, start:'YYYY-MM', months }  → добавить
// POST ?action=prepaid_del { id }         → убрать

import { checkAuth } from './_auth.js';
import { requirePerm } from './_perm.js';
import { callerName } from './_caller.js';
import { sbSelect, sbUpdate } from './_supabase.js';
import * as C from './_finansist_core.js';
import { chatTurn, sweepMonth, answerQuestion, limitState } from './_finansist_agent.js';

export const config = { maxDuration: 300 };

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  return new Promise((resolve) => { let s = ''; req.on('data', c => s += c); req.on('end', () => { try { resolve(JSON.parse(s || '{}')); } catch { resolve({}); } }); });
}

export default async function handler(req, res) {
  if (!checkAuth(req, res)) return;
  const gate = await requirePerm(req, res, 'view_finansist');
  if (!gate.ok) return;
  const caller = { email: gate.caller.email, name: callerName(req) || null, role: gate.caller.role };
  const action = String(req.query.action || '');
  try {
    if (req.method === 'GET') {
      if (action === 'history') {
        const lim = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 60));
        const rows = await sbSelect('finansist_chat_messages', { country: 'eq.' + C.COUNTRY, order: 'created_at.desc', limit: String(lim), select: 'id,role,content,tool_trace,author_email,author_name,cost_usd,created_at' });
        return res.status(200).json({ ok: true, messages: rows.reverse(), limit: await limitState() });
      }
      if (action === 'questions') {
        const month = C.parseMonth(req.query.month) ? String(req.query.month) : C.currentMonthKey();
        const rows = await sbSelect('finansist_questions', { country: 'eq.' + C.COUNTRY, month: 'eq.' + month, order: 'created_at.desc', limit: '300' });
        return res.status(200).json({ ok: true, month, questions: rows });
      }
      if (action === 'missing') {
        const month = C.parseMonth(req.query.month) ? String(req.query.month) : C.currentMonthKey();
        const keys = [0, -1, -2, -3, -4, -5, -6].map(k => C.shiftMonthKey(month, k));
        const byMonth = await C.loadExpenses(keys);
        const r = await C.syncMissing(byMonth, month);
        return res.status(200).json({ ok: true, month, items: r.items, check: r.check, incomplete: r.incomplete });
      }
      if (action === 'spend') return res.status(200).json({ ok: true, limit: await limitState() });
      if (action === 'prepaid') return res.status(200).json({ ok: true, items: await C.loadPrepaid() });
      if (action === 'rules') return res.status(200).json({ ok: true, rules: await C.loadRules(true) });
      return res.status(400).json({ ok: false, error: 'неизвестное действие' });
    }
    if (req.method === 'POST') {
      const body = await readBody(req);
      if (action === 'chat') {
        const text = String(body.text || '').trim();
        if (!text) return res.status(400).json({ ok: false, error: 'пустое сообщение' });
        if (text.length > 4000) return res.status(400).json({ ok: false, error: 'сообщение длиннее 4000 знаков' });
        const r = await chatTurn(text, caller);
        return res.status(200).json({ ok: true, reply: r.reply, cost_usd: r.cost_usd || 0, limit: r.limit });
      }
      if (action === 'refresh') {
        const month = C.parseMonth(body.month) ? String(body.month) : C.currentMonthKey();
        const r = await sweepMonth(month, { force: true });
        return res.status(200).json({ ok: true, result: { month: r.month, created: r.created, closed: r.closed, candidates: r.candidates, disputes: r.disputes, missing_changes: r.missing_changes.map(c => ({ type: c.type, item: c.item.item_key })), model_used: r.model_used, cost_usd: r.cost_usd } });
      }
      if (action === 'answer') {
        const idx = parseInt(body.idx, 10);
        if (!body.id || isNaN(idx)) return res.status(400).json({ ok: false, error: 'нужны id и idx' });
        await answerQuestion(String(body.id), idx, caller);
        return res.status(200).json({ ok: true });
      }
      if (action === 'rules_save') {
        const patch = {};
        const numOrNull = v => { if (v == null || String(v).trim() === '') return null; const n = Number(String(v).replace(/\s/g, '').replace(',', '.')); return isFinite(n) ? n : NaN; };
        if ('integrators_kzt' in body) { const v = numOrNull(body.integrators_kzt); if (v == null || isNaN(v) || v <= 0) return res.status(400).json({ ok: false, error: 'сумма интеграторам в тенге должна быть больше нуля' }); patch.integrators_kzt = v; }
        if ('integrators_tolerance_pct' in body) { const v = numOrNull(body.integrators_tolerance_pct); if (v == null || isNaN(v) || v < 0 || v > 50) return res.status(400).json({ ok: false, error: 'допуск — от 0 до 50%' }); patch.integrators_tolerance_pct = v; }
        if ('safe_balance' in body) { const v = numOrNull(body.safe_balance); if (isNaN(v) || (v != null && v < 0)) return res.status(400).json({ ok: false, error: 'безопасный остаток — число не меньше нуля или пусто' }); patch.safe_balance = v; }
        if ('owner_names' in body) { const arr = (Array.isArray(body.owner_names) ? body.owner_names : String(body.owner_names || '').split(',')).map(x => String(x).trim()).filter(Boolean).slice(0, 5); if (!arr.length) return res.status(400).json({ ok: false, error: 'укажите имя владельца, как оно пишется в примечаниях' }); patch.owner_names = arr; }
        const rules = await C.saveRules(patch);
        await C.saveDecision('rules:' + Object.keys(patch).sort().join(','), 'Настройки правил: ' + Object.entries(patch).map(([k, v]) => k + '=' + (Array.isArray(v) ? v.join(', ') : v)).join('; '), 'chat', null, caller.email, caller.name);
        return res.status(200).json({ ok: true, rules });
      }
      if (action === 'prepaid_add') {
        const label = String(body.label || '').trim().slice(0, 80);
        const amount = Number(String(body.amount == null ? '' : body.amount).replace(/\s/g, '').replace(',', '.'));
        const months = parseInt(body.months, 10);
        const start = String(body.start || '').slice(0, 7);
        const itemKey = body.item_key && C.EXPECTED_ITEMS.some(i => i.key === body.item_key) ? String(body.item_key) : null;
        if (!label) return res.status(400).json({ ok: false, error: 'укажите статью' });
        if (!isFinite(amount) || amount <= 0) return res.status(400).json({ ok: false, error: 'сумма должна быть больше нуля' });
        if (!months || months < 2 || months > 36) return res.status(400).json({ ok: false, error: 'срок — от 2 до 36 месяцев' });
        if (!C.parseMonth(start)) return res.status(400).json({ ok: false, error: 'месяц начала в формате YYYY-MM' });
        const items = await C.loadPrepaid();
        const e = { id: 'pp-' + Date.now().toString(36), label, item_key: itemKey, amount, start, months, added_by: caller.email, added_by_name: caller.name, added_at: new Date().toISOString() };
        items.push(e); await C.savePrepaid(items);
        await C.saveDecision('prepaid:' + e.id, label + ' — предоплата ' + Math.round(amount) + ' сом за ' + months + ' мес. с ' + C.monthLabel(start) + ', в месяц ' + Math.round(amount / months) + ' сом', 'question', start, caller.email, caller.name);
        return res.status(200).json({ ok: true, item: e, items });
      }
      if (action === 'prepaid_del') {
        const items = await C.loadPrepaid(); const left = items.filter(e => e.id !== String(body.id || ''));
        if (left.length === items.length) return res.status(404).json({ ok: false, error: 'запись не найдена' });
        await C.savePrepaid(left);
        return res.status(200).json({ ok: true, items: left });
      }
      if (action === 'missing_fill' || action === 'missing_ignore') {
        if (!body.id) return res.status(400).json({ ok: false, error: 'нужен id' });
        const rows = await sbSelect('finansist_missing_data', { id: 'eq.' + String(body.id), limit: '1' });
        if (!rows[0]) return res.status(404).json({ ok: false, error: 'запись не найдена' });
        const now = new Date().toISOString();
        if (action === 'missing_ignore') { await sbUpdate('finansist_missing_data', { id: 'eq.' + rows[0].id }, { status: 'ignored', filled_by: caller.email, filled_by_name: caller.name, filled_at: now, updated_at: now }); }
        else {
          const amount = Number(String(body.amount).replace(/\s/g, '').replace(',', '.'));
          if (!isFinite(amount) || amount <= 0) return res.status(400).json({ ok: false, error: 'сумма должна быть больше нуля' });
          if (rows[0].status === 'superseded') return res.status(409).json({ ok: false, error: 'по этой статье в таблице уже есть настоящая строка — ручная сумма не нужна' });
          await sbUpdate('finansist_missing_data', { id: 'eq.' + rows[0].id }, { status: 'filled', amount, filled_by: caller.email, filled_by_name: caller.name, filled_at: now, updated_at: now });
          await C.saveDecision('missing:' + rows[0].month + ':' + rows[0].item_key, rows[0].item_label + ' за ' + C.monthLabel(rows[0].month) + ' — внесено вручную ' + Math.round(amount) + ' сом', 'question', rows[0].month, caller.email, caller.name);
        }
        const upd = await sbSelect('finansist_missing_data', { id: 'eq.' + rows[0].id, limit: '1' });
        return res.status(200).json({ ok: true, item: upd[0] });
      }
      return res.status(400).json({ ok: false, error: 'неизвестное действие' });
    }
    return res.status(405).json({ ok: false, error: 'method not allowed' });
  } catch (e) {
    console.error('[api/finansist-agent]', action, e);
    return res.status(500).json({ ok: false, error: e.message || String(e) });
  }
}
