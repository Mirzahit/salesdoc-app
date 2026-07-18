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
// v819: платёж считается «упавшим», если месячная цена < 70% медианы прошлых платежей клиента
const PAY_DROP_RATIO = 0.7;

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

  // --- v819: Продления и «клиент гаснет» (утверждено CEO 19.07.2026) ---
  // Окна сравниваются через >=, а не == — устойчиво к пропуску дня крона; повторы гасит dedup_key
  // (ключи включают next_billing_at/id платежа, после продления дата меняется и цикл начинается заново).
  // Блок в отдельном try/catch — его падение не должно ломать напоминания выше.
  try {
    const normName = s => String(s || '').toLowerCase().replace(/[«»"',.()]/g, ' ').replace(/\s+/g, ' ').trim();
    const in30 = isoDate(new Date(nowA.getTime() + 30 * 86400000));
    const cap45 = isoDate(new Date(nowA.getTime() - 45 * 86400000)); // не бэкфиллить давно погасших на первом запуске

    const cls = await sbSelect('clients', {
      status: 'eq.active',
      next_billing_at: 'not.is.null',
      and: '(next_billing_at.gte.' + cap45 + ',next_billing_at.lte.' + in30 + ')',
      select: 'client_id,company_name,curator_operator,next_billing_at,country'
    });

    // Платежи этих клиентов: кросс-чек «уже оплатил, но дату не сдвинули» + суммы для сводки CEO.
    // По определению проекта доступ продлевают абонплата/баланс (subscription) и лицензии/новый клиент (license).
    const ids = cls.map(c => c.client_id).filter(Boolean);
    let pays = [];
    if (ids.length) {
      pays = await sbSelect('payments', {
        client_id: 'in.(' + ids.map(i => '"' + i + '"').join(',') + ')',
        category: 'in.("subscription","license")',
        select: 'client_id,amount,period_months,paid_at,category',
        order: 'paid_at.asc', limit: '5000'
      });
    }
    // Фолбэк для платежей без client_id — матч по нормализованному имени внутри страны
    const paysNoId = await sbSelect('payments', {
      client_id: 'is.null',
      category: 'in.("subscription","license")',
      paid_at: 'gte.' + cap45,
      select: 'company_name,paid_at,country', limit: '2000'
    });
    const paidAfterByName = {};
    paysNoId.forEach(p => {
      const k = normName(p.company_name) + '|' + (p.country || '');
      const d = String(p.paid_at).slice(0, 10);
      if (!paidAfterByName[k] || d > paidAfterByName[k]) paidAfterByName[k] = d;
    });
    const lastPaidById = {};
    const lastSubAmountById = {}; // pays отсортированы по paid_at.asc — в мапе останется последний платёж
    pays.forEach(p => {
      const d = String(p.paid_at).slice(0, 10);
      if (!lastPaidById[p.client_id] || d > lastPaidById[p.client_id]) lastPaidById[p.client_id] = d;
      if (p.category === 'subscription') lastSubAmountById[p.client_id] = Number(p.amount) || 0;
    });

    for (const c of cls) {
      const nb = String(c.next_billing_at).slice(0, 10);
      const daysLeft = Math.round((new Date(nb) - new Date(today)) / 86400000);
      const opEmail = c.curator_operator ? await opEmailByName(c.curator_operator) : null;
      if (c.curator_operator && !opEmail) unresolved.push(c.curator_operator);
      if (!opEmail) continue; // без куратора некому слать — клиент всё равно виден в сводке CEO и утренней сводке
      const base = { entity_type: 'client', entity_id: c.client_id, client_id: c.client_id };
      if (daysLeft > 7 && daysLeft <= 30) {
        rows.push(Object.assign({}, base, {
          user_email: opEmail, type: 'renewal_due',
          title: 'Продление через ' + daysLeft + ' дн: ' + c.company_name,
          body: 'Дата оплаты ' + fmtD(nb) + ' · поговорите с клиентом заранее',
          dedup_key: 'renewal_d30:' + c.client_id + ':' + nb
        }));
      } else if (daysLeft >= 0) {
        rows.push(Object.assign({}, base, {
          user_email: opEmail, type: 'renewal_due',
          title: 'Оплата через ' + daysLeft + ' дн: ' + c.company_name,
          body: 'Дата оплаты ' + fmtD(nb) + ' · напомните клиенту',
          dedup_key: 'renewal_d7:' + c.client_id + ':' + nb
        }));
      } else {
        const over = -daysLeft;
        // Кросс-чек: платёж после даты биллинга (по client_id или по имени) = заплатил, дату ещё не сдвинули
        const paidAfter = (lastPaidById[c.client_id] && lastPaidById[c.client_id] >= nb)
          || ((paidAfterByName[normName(c.company_name) + '|' + (c.country || '')] || '') >= nb);
        if (paidAfter) continue;
        if (over >= 7) {
          rows.push(Object.assign({}, base, {
            user_email: opEmail, type: 'billing_overdue',
            title: 'Позвонить срочно: ' + c.company_name,
            body: 'Оплата просрочена на ' + over + ' дн (срок был ' + fmtD(nb) + ')',
            dedup_key: 'billing_overdue7:' + c.client_id + ':' + nb
          }));
        } else if (over >= 3) {
          rows.push(Object.assign({}, base, {
            user_email: opEmail, type: 'billing_overdue',
            title: 'Оплата просрочена: ' + c.company_name,
            body: over + ' дн после срока ' + fmtD(nb) + ' · свяжитесь с клиентом',
            dedup_key: 'billing_overdue3:' + c.client_id + ':' + nb
          }));
        }
      }
    }

    // «Сумма упала»: свежие подписочные платежи за 7 дней против медианы прошлых (мин. 3 платежа).
    // Сравниваем «месячную» цену amount/period_months — платежи за 3/6/12 мес не дают ложных тревог.
    const fresh = await sbSelect('payments', {
      category: 'eq.subscription',
      client_id: 'not.is.null',
      paid_at: 'gte.' + isoDate(new Date(nowA.getTime() - 7 * 86400000)),
      select: 'id,client_id,company_name,amount,period_months,paid_at', limit: '500'
    });
    if (fresh.length) {
      const fids = Array.from(new Set(fresh.map(p => p.client_id)));
      const inList = 'in.(' + fids.map(i => '"' + i + '"').join(',') + ')';
      const hist = await sbSelect('payments', {
        client_id: inList, category: 'eq.subscription',
        select: 'client_id,amount,period_months,paid_at', order: 'paid_at.asc', limit: '5000'
      });
      const clRows = await sbSelect('clients', { client_id: inList, select: 'client_id,company_name,curator_operator' });
      const clById = {};
      clRows.forEach(c => { clById[c.client_id] = c; });
      const monthly = p => (Number(p.amount) || 0) / (Number(p.period_months) || 1);
      for (const p of fresh) {
        const prev = hist
          .filter(h => h.client_id === p.client_id && String(h.paid_at) < String(p.paid_at))
          .map(monthly).filter(v => v > 0);
        if (prev.length < 3) continue;
        prev.sort((a, b) => a - b);
        const median = prev[Math.floor(prev.length / 2)];
        const cur = monthly(p);
        if (!(cur > 0) || cur >= PAY_DROP_RATIO * median) continue;
        const cl = clById[p.client_id];
        const opEmail = cl && cl.curator_operator ? await opEmailByName(cl.curator_operator) : null;
        if (!opEmail) { if (cl && cl.curator_operator) unresolved.push(cl.curator_operator); continue; }
        rows.push({
          entity_type: 'client', entity_id: p.client_id, client_id: p.client_id,
          user_email: opEmail, type: 'pay_drop',
          title: 'Платёж меньше обычного: ' + ((cl && cl.company_name) || p.company_name),
          body: 'Пришло ~' + Math.round(cur).toLocaleString('ru-RU') + '/мес против обычных ~' + Math.round(median).toLocaleString('ru-RU') + '/мес — узнайте, всё ли в порядке',
          dedup_key: 'pay_drop:' + p.id
        });
      }
    }

    // Сводка CEO — раз в неделю по понедельникам, одним сообщением (решение CEO: без копий каждого алерта)
    if (nowA.getUTCDay() === 1) {
      const weekEnd = isoDate(new Date(nowA.getTime() + 6 * 86400000));
      const week = cls.filter(c => String(c.next_billing_at).slice(0, 10) <= weekEnd);
      if (week.length) {
        const sums = {}; let overdueCnt = 0;
        week.forEach(c => {
          if (String(c.next_billing_at).slice(0, 10) < today) overdueCnt++;
          const cur = c.country === 'KG' ? 'сом' : '₸';
          sums[cur] = (sums[cur] || 0) + (lastSubAmountById[c.client_id] || 0);
        });
        const sumStr = Object.keys(sums).map(k => Math.round(sums[k]).toLocaleString('ru-RU') + ' ' + k).join(' · ');
        rows.push({
          user_email: CEO_EMAIL, type: 'renewals_summary',
          title: 'Продления на этой неделе: ' + week.length,
          body: 'Ожидается ' + sumStr + (overdueCnt ? ' · уже просрочено: ' + overdueCnt : ''),
          dedup_key: 'renewals_week:' + today
        });
      }
    }
  } catch (e) { console.warn('[reminders] блок продлений упал:', e.message); }

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
