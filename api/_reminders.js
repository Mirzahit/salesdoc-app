// v813: напоминания о дедлайнах — вызывается из cron-digest (почасовой крон 06-12 Алматы).
// Underscore-файл — не деплоится как функция, нового крона в vercel.json не нужно.
//
// Правила (утверждены CEO):
// - интеграции с deadline: за день и в день — оператору; просрочка раз в день — оператору + CEO;
// - внедрения >7 дней на этапе — оператору + CEO (алерт на 7-й, 14-й, 21-й день: ключ по неделям);
// - идемпотентность НЕ через last_sent, а через dedup_key — повторный запуск того же часа безопасен.

import { sbSelect, sbDelete } from './_supabase.js';
import { notifCreate, opEmailByName } from './_notify.js';

const CEO_EMAIL = 'office@salesdoc.io';

function almatyNow() { return new Date(Date.now() + 5 * 3600 * 1000); }
function isoDate(d) { return d.toISOString().slice(0, 10); }
function fmtD(iso) { const p = String(iso).slice(0, 10).split('-'); return p[2] + '.' + p[1] + '.' + p[0]; }

export async function runReminders() {
  const nowA = almatyNow();
  if (nowA.getUTCHours() !== 9) return { skipped: 'not_the_hour', almaty_hour: nowA.getUTCHours() };
  const today = isoDate(nowA);
  const tomorrow = isoDate(new Date(nowA.getTime() + 86400000));
  const rows = [];
  const unresolved = [];

  // --- Интеграции с дедлайном (активные статусы) ---
  const intgs = await sbSelect('integrations', {
    status: 'in.("Новая","В работе","На паузе")',
    deadline: 'not.is.null',
    select: 'id,client_id,company_name,operator,deadline'
  });
  for (const it of intgs) {
    const dl = String(it.deadline).slice(0, 10);
    const opEmail = it.operator ? await opEmailByName(it.operator) : null;
    if (it.operator && !opEmail) unresolved.push(it.operator);
    const base = { entity_type: 'integration', entity_id: it.id, client_id: it.client_id || null };
    if (dl === tomorrow) {
      if (opEmail) rows.push(Object.assign({}, base, {
        user_email: opEmail, type: 'intg_deadline',
        title: 'Завтра срок интеграции: ' + it.company_name,
        body: 'Дедлайн ' + fmtD(dl),
        dedup_key: 'intg_deadline:' + it.id + ':D-1'
      }));
    } else if (dl === today) {
      if (opEmail) rows.push(Object.assign({}, base, {
        user_email: opEmail, type: 'intg_deadline',
        title: 'Сегодня срок интеграции: ' + it.company_name,
        body: 'Дедлайн ' + fmtD(dl),
        dedup_key: 'intg_deadline:' + it.id + ':D0'
      }));
    } else if (dl < today) {
      const days = Math.round((new Date(today) - new Date(dl)) / 86400000);
      const item = {
        type: 'intg_overdue',
        title: 'Интеграция просрочена: ' + it.company_name,
        body: 'Срок был ' + fmtD(dl) + ' · ' + days + ' дн просрочки' + (it.operator ? ' · оператор ' + it.operator : ' · без оператора')
      };
      if (opEmail) rows.push(Object.assign({}, base, item, { user_email: opEmail, dedup_key: 'intg_overdue:' + it.id + ':' + today }));
      rows.push(Object.assign({}, base, item, { user_email: CEO_EMAIL, dedup_key: 'intg_overdue:' + it.id + ':' + today }));
    }
  }

  // --- Внедрения, зависшие на этапе >7 дней ---
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
  const cards = await sbSelect('kanban_cards', {
    stage: 'not.in.("Активация","Архив")',
    stage_entered_at: 'lt.' + weekAgo,
    select: 'id,client_id,stage,stage_entered_at,operator,clients(company_name)'
  });
  for (const c of cards) {
    const days = Math.floor((Date.now() - new Date(c.stage_entered_at)) / 86400000);
    if (!isFinite(days) || days < 7) continue;
    const week = Math.floor(days / 7); // напоминание на 7-й, 14-й, 21-й день — не каждый день
    const name = (c.clients && c.clients.company_name) || c.client_id || 'клиент';
    const opEmail = c.operator ? await opEmailByName(c.operator) : null;
    if (c.operator && !opEmail) unresolved.push(c.operator);
    const item = {
      entity_type: 'kanban_card', entity_id: c.id, client_id: c.client_id || null,
      type: 'impl_stuck',
      title: 'Внедрение зависло: ' + name,
      body: days + ' дн на этапе «' + c.stage + '»' + (c.operator ? ' · оператор ' + c.operator : ' · без оператора')
    };
    const key = 'impl_stuck:' + c.id + ':' + c.stage + ':w' + week;
    if (opEmail) rows.push(Object.assign({}, item, { user_email: opEmail, dedup_key: key }));
    rows.push(Object.assign({}, item, { user_email: CEO_EMAIL, dedup_key: key }));
  }

  const inserted = await notifCreate(rows);

  // Уборка: прочитанные уведомления старше 30 дней
  try {
    await sbDelete('notifications', {
      is_read: 'eq.true',
      created_at: 'lt.' + new Date(Date.now() - 30 * 86400000).toISOString()
    });
  } catch (_) {}

  if (unresolved.length) console.warn('[reminders] операторы без email:', Array.from(new Set(unresolved)).join(', '));
  return { created: inserted.length, candidates: rows.length, unresolved: Array.from(new Set(unresolved)) };
}
