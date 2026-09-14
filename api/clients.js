// /api/clients — CRUD Реестра клиентов.
//
// GET  /api/clients                          → все клиенты
// GET  /api/clients?status=active            → по статусу
// GET  /api/clients?curator=Айдос            → по куратору
// GET  /api/clients?client_id=SD-2026-1      → один клиент
// GET  /api/clients?renewal_within=7         → активные с next_billing_at в ближайшие N дней (v369)
// POST /api/clients                          → создать (body: { client_id, company_name, ... })
// PATCH /api/clients?client_id=SD-2026-1     → изменить (body: поля для обновления)

import { sbSelect, sbInsert, sbUpdate } from './_supabase.js';
import { checkAuth } from './_auth.js';
import { almatyIso } from './_dates.js';
import { canonOperator, operatorNames } from './_operators.js';
import { notifCreate, opEmailByName } from './_notify.js'; // v870: уведомление о передаче клиента // v859: операторы из «Сотрудников»
import { callerName } from './_caller.js'; // v960: кто нажал — для ленты клиента

const ALLOWED_STATUS = ['lead','sale','onboarding','active','paused','churned'];
const ALLOWED_COUNTRIES = ['KZ','KG'];
const ALLOWED_PERIODS = [1, 3, 6, 12]; // месяцев подписки
const STATUS_RU = { lead:'новый', sale:'продано', onboarding:'внедрение', active:'действующий', paused:'на паузе', churned:'ушёл' };

// v606: нормализация имени для анти-дубля (как _acNormForMerge на фронте / _normName в payments).
export function _normName(s) { return String(s || '').toLowerCase().replace(/[^a-zа-яё0-9]/gi, ''); }

// v960: запись в ленту клиента (card_history, event_type=system). Ошибка не валит операцию.
export async function logClientEvent(clientId, text, author) {
  try {
    await sbInsert('card_history', { client_id: clientId, event_type: 'system', text: String(text || '').slice(0, 500), author: author || null });
  } catch (e) { console.error('[client history]', e.message || e); }
}

// v960: дата следующей оплаты по календарному правилу: оплата (или активация) в месяце M
// на N месяцев закрывает доступ по конец месяца M+N-1; следующая оплата — 1-е число после.
// Одно правило для активации, продления ботом и пересчёта кроном (раньше их было три).
export function nextBillingAfter(dateIso, periodMonths) {
  const end = _accessEndUTC(dateIso, Math.max(1, parseInt(periodMonths, 10) || 1));
  if (!end || isNaN(end.getTime())) return null;
  return new Date(end.getTime() + 86400000).toISOString().slice(0, 10);
}

// v960: ЕДИНАЯ активация клиента — все девять путей (последний этап доски, кнопка
// «Активировать», чек-лист «Передать», inline-статус, создание, импорт, продление ботом
// ушедшего) идут через неё. Раньше доска писала status напрямую, а следующий PATCH с фронта
// получал already_active и выбрасывал дату оплаты, период и куратора — у клиентов после
// внедрения next_billing_at не ставился, напоминания молчали.
// opts: { operator, period, activation_date, next_billing_at, actor, source }
// source: 'board' | 'button' | 'checklist' | 'status' | 'create' | 'bot' | 'import'
export async function activateClient(clientId, opts) {
  opts = opts || {};
  const rows = await sbSelect('clients', { client_id: 'eq.' + clientId, limit: '1' });
  if (!rows.length) return { ok: false, error: 'клиент не найден' };
  const cl = rows[0];
  const wasActive = cl.status === 'active';
  const patch = { updated_at: new Date().toISOString() };
  if (!wasActive) patch.status = 'active';
  // период: явный → существующий → 1
  const per = ALLOWED_PERIODS.includes(parseInt(opts.period, 10)) ? parseInt(opts.period, 10)
    : (ALLOWED_PERIODS.includes(parseInt(cl.subscription_period_months, 10)) ? parseInt(cl.subscription_period_months, 10) : 1);
  if (per !== cl.subscription_period_months) patch.subscription_period_months = per;
  // дата активации — Алматы, не Гринвич; не перезаписываем, если уже есть
  if (!cl.activation_date) patch.activation_date = opts.activation_date || almatyIso();
  // куратор = кто внедрял. Не перезаписываем уже назначенного.
  if (!cl.support_operator && opts.operator) {
    const who = await canonOperator(opts.operator, cl.country || 'KZ');
    if (who) patch.support_operator = who;
  }
  // следующая оплата: явная → существующая (если ещё в будущем) → календарное правило от сегодня
  const today = almatyIso();
  const curNb = cl.next_billing_at ? String(cl.next_billing_at).slice(0, 10) : null;
  if (opts.next_billing_at) patch.next_billing_at = String(opts.next_billing_at).slice(0, 10);
  else if (!curNb || curNb < today || !wasActive) patch.next_billing_at = nextBillingAfter(today, per);
  // возврат ушедшего/приостановленного — причина неоплаты больше не актуальна
  if (!wasActive && (cl.status === 'churned' || cl.status === 'paused') && cl.pay_reason) {
    patch.pay_reason = null; patch.pay_reason_at = null; patch.pay_reason_by = null;
  }
  const result = await sbUpdate('clients', { client_id: 'eq.' + clientId }, patch);
  const client = result[0] || Object.assign({}, cl, patch);
  if (!wasActive || opts.force_log) {
    const SRC = { board:'внедрение завершено', button:'кнопка «Активировать»', checklist:'чек-лист', status:'смена статуса', create:'создан как действующий', bot:'оплата абонплаты', import:'импорт' };
    const from = STATUS_RU[cl.status] || cl.status || '—';
    const who = client.support_operator ? (' · куратор ' + client.support_operator) : '';
    await logClientEvent(clientId, 'Статус: ' + from + ' → действующий · ' + (SRC[opts.source] || 'вручную') + who, opts.actor || (opts.source === 'bot' ? 'бот' : null));
  }
  return { ok: true, client, already_active: wasActive };
}

// v838: дата следующей оплаты из истории платежей.
// Раньше next_billing_at писал ТОЛЬКО бот при оплате «абон.плата» — у клиентов,
// пришедших из Sheets-импорта, поле пустое (в KG — 169 из 179 активных), поэтому
// напоминания о продлениях (api/_reminders.js) и виджет утренней сводки молчали.
// Правило совпадает с фронтом («Доступ до», index.html acGetActiveClients):
// биллинг календарный — оплата 10 мая на 1 мес закрывает доступ по 31 мая,
// значит следующая оплата 1 июня.
const RECALC_CATEGORIES = ['subscription', 'license'];

function _accessEndUTC(paidAt, periodMonths) {
  const y = parseInt(String(paidAt).slice(0, 4), 10);
  const m = parseInt(String(paidAt).slice(5, 7), 10); // 1-based
  if (!y || !m) return null;
  // день 0 следующего месяца = последний день месяца (m + period - 1)
  return new Date(Date.UTC(y, m - 1 + periodMonths, 0));
}

export async function recalcBillingForCountry(country, dryRun) {
  const cparams = {
    status: 'eq.active',
    select: 'client_id,company_name,country,next_billing_at,subscription_period_months',
    limit: '5000'
  };
  const pparams = {
    select: 'client_id,company_name,paid_at,category,period_months',
    category: 'in.(' + RECALC_CATEGORIES.join(',') + ')',
    order: 'paid_at.asc',
    limit: '20000'
  };
  if (country) { cparams['country'] = 'eq.' + country; pparams['country'] = 'eq.' + country; }

  const [clients, pays] = await Promise.all([sbSelect('clients', cparams), sbSelect('payments', pparams)]);

  const byId = {}, byName = {};
  clients.forEach(c => {
    byId[c.client_id] = c;
    const n = _normName(c.company_name);
    if (n && !byName[n]) byName[n] = c; // при дублях имени берём первого — привязка по client_id важнее
  });

  // Максимальная дата окончания доступа по каждому клиенту
  const endByClient = {}, perByClient = {};
  pays.forEach(p => {
    const per = Math.max(1, Math.round(Number(p.period_months) || 1));
    if (!p.paid_at) return;
    const cl = (p.client_id && byId[p.client_id]) || byName[_normName(p.company_name)];
    if (!cl) return;
    const end = _accessEndUTC(p.paid_at, per);
    if (!end || isNaN(end.getTime())) return;
    const k = cl.client_id;
    if (!endByClient[k] || end > endByClient[k]) { endByClient[k] = end; perByClient[k] = per; }
  });

  const changes = [];
  let unmatched = 0, kept = 0;
  clients.forEach(c => {
    const end = endByClient[c.client_id];
    if (!end) { unmatched++; return; }
    const next = new Date(end.getTime() + 86400000).toISOString().slice(0, 10); // первый неоплаченный день
    const cur = c.next_billing_at ? String(c.next_billing_at).slice(0, 10) : null;
    // Если в базе дата ПОЗЖЕ вычисленной — её поставил бот или человек вручную, не откатываем
    if (cur && cur >= next) { kept++; return; }
    changes.push({
      client_id: c.client_id,
      company_name: c.company_name,
      from: cur,
      to: next,
      period_months: perByClient[c.client_id] || null
    });
  });

  if (!dryRun) {
    for (const ch of changes) {
      const patch = { next_billing_at: ch.to, updated_at: new Date().toISOString() };
      if (ch.period_months && ALLOWED_PERIODS.includes(ch.period_months)) patch.subscription_period_months = ch.period_months;
      await sbUpdate('clients', { client_id: 'eq.' + ch.client_id }, patch);
    }
  }

  const today = almatyIso();
  return {
    ok: true,
    dry_run: !!dryRun,
    country: country || 'ALL',
    active_clients: clients.length,
    updated: changes.length,
    already_ok: kept,
    no_payments: unmatched,
    overdue_after: changes.filter(c => c.to < today).length,
    due_30d_after: changes.filter(c => c.to >= today && c.to <= almatyIso(Date.now() + 30 * 86400000)).length,
    sample: changes.slice(0, 20)
  };
}

async function handleRecalcBilling(req, res) {
  const country = String(req.query.country || '').toUpperCase();
  if (country && !ALLOWED_COUNTRIES.includes(country)) {
    return res.status(400).json({ ok: false, error: 'country должен быть KZ или KG' });
  }
  const dryRun = String(req.query.dry_run || '') === '1';
  const result = await recalcBillingForCountry(country, dryRun);
  return res.status(200).json(result);
}

export default async function handler(req, res) {
  if (!checkAuth(req, res)) return;
  try {
    if (req.method === 'POST' && req.query.action === 'link_hosts') return await handleLinkHosts(req, res);
    if (req.method === 'POST' && req.query.action === 'recalc_billing') return await handleRecalcBilling(req, res);
    if (req.method === 'GET') {
      const { client_id, status, curator, search, country, renewal_within, limit } = req.query || {};
      const params = { order: 'updated_at.desc' };
      // v823: limit раньше молча игнорировался — PostgREST резал на 1000 строк и пикер
      // клиентов в форме оплаты «не находил» хвост списка (человек создавал дубль)
      const lim = parseInt(limit, 10);
      if (Number.isFinite(lim) && lim > 0) params['limit'] = String(Math.min(lim, 5000));
      if (client_id) params['client_id'] = 'eq.' + client_id;
      if (status) params['status'] = 'eq.' + status;
      if (curator) params['curator_operator'] = 'eq.' + curator;
      if (country) params['country'] = 'eq.' + country;
      if (search) params['company_name'] = 'ilike.*' + search + '*';
      // v369: фильтр для витрины «Мои клиенты» — продлевают в ближайшие N дней
      // renewal_within=7  → next_billing_at между today и today+7
      // renewal_within=-1 → уже просрочены (next_billing_at < today)
      if (renewal_within !== undefined) {
        const n = parseInt(renewal_within, 10);
        // v786: нечисловое значение раньше роняло запрос в 500 (new Date(NaN).toISOString())
        if (Number.isNaN(n)) {
          return res.status(400).json({ ok: false, error: 'renewal_within должен быть числом' });
        }
        const today = almatyIso(); // v817: было по Гринвичу — утром фильтр биллинга сдвигался на день
        // v819: если статус не задан явно — только действующие (иначе в списке продлений
        // всплывали отвалившиеся и приостановленные клиенты со старой датой биллинга)
        if (!status) params['status'] = 'eq.active';
        if (n < 0) {
          params['next_billing_at'] = 'lt.' + today;
        } else {
          const future = almatyIso(Date.now() + n * 86400000);
          // используем PostgREST `and=` для двух условий на одной колонке
          params['and'] = `(next_billing_at.gte.${today},next_billing_at.lte.${future})`;
        }
        params['order'] = 'next_billing_at.asc';
      }
      const data = await sbSelect('clients', params);
      return res.status(200).json({ ok: true, count: data.length, clients: data });
    }

    if (req.method === 'POST') {
      const body = await readBody(req);
      // v817: фронт передаёт country в query (sbFetch), body может его не содержать —
      // без фолбэка клиент с доски KG получал вечный SD-KZ- id
      const country = (body.country || (req.query || {}).country || 'KZ').toUpperCase();
      if (!ALLOWED_COUNTRIES.includes(country)) {
        return res.status(400).json({ ok: false, error: 'country должен быть KZ или KG' });
      }
      body.country = country;
      // v369: валидация периода подписки
      if (body.subscription_period_months !== undefined) {
        const p = parseInt(body.subscription_period_months, 10);
        if (!ALLOWED_PERIODS.includes(p)) {
          return res.status(400).json({ ok: false, error: 'subscription_period_months должен быть 1, 3, 6 или 12' });
        }
        body.subscription_period_months = p;
      }
      // v606: анти-дубль — если клиента с тем же нормализованным именем в стране уже есть,
      // возвращаем его, а не создаём второго (фронт откроет существующего).
      if (!body.client_id && body.company_name) {
        const _norm = _normName(body.company_name);
        if (_norm) {
          const _existing = await sbSelect('clients', { country: 'eq.' + country, select: 'client_id,company_name,status', limit: '2000' });
          const _m = _existing.find(c => _normName(c.company_name) === _norm);
          if (_m) return res.status(200).json({ ok: true, client: _m, existed: true });
        }
      }
      if (!body.client_id) {
        // v364: авто-генерация с префиксом страны: SD-KZ-2026-NNNN / SD-KG-2026-NNNN
        // Уменьшает риск гонки (хотя UNIQUE-индекс в БД всё равно нужен).
        // v882: раньше номер брали у ПОСЛЕДНЕГО СОЗДАННОГО клиента и прибавляли единицу.
        // Но номера не всегда идут в порядке создания: у KG последний созданный был
        // 00210, а самый большой существующий — 00214, поэтому программа предлагала
        // 00211 и падала с «такой номер уже есть». Берём максимальный номер года.
        const year = new Date().getFullYear();
        const prefix = 'SD-' + country + '-' + year + '-';
        const existing = await sbSelect('clients', {
          select: 'client_id',
          client_id: 'like.' + prefix + '%',
          order: 'client_id.desc',
          limit: '1'
        });
        let nextNum = 1;
        if (existing.length) {
          const m = String(existing[0].client_id || '').match(/-(\d+)$/);
          if (m) nextNum = parseInt(m[1], 10) + 1;
        }
        body.client_id = prefix + String(nextNum).padStart(5, '0');
        body._idAuto = { prefix, nextNum }; // для повтора при столкновении, снимем перед вставкой
      }
      if (!body.company_name) return res.status(400).json({ ok: false, error: 'company_name обязателен' });
      if (body.status && !ALLOWED_STATUS.includes(body.status)) {
        return res.status(400).json({ ok: false, error: 'status должен быть один из: ' + ALLOWED_STATUS.join(', ') });
      }
      // v638 FIX: skip_auto_task — служебный флаг, НЕ колонка таблицы. Раньше он попадал в
      // sbInsert(body) и Supabase падал с PGRST204 «column skip_auto_task not found» → флаг
      // никогда не работал. Снимаем перед вставкой, значение запоминаем для логики ниже.
      const skipAutoTask = body.skip_auto_task === true;
      delete body.skip_auto_task;
      // v882: если номер всё же заняли между проверкой и вставкой (двое заводят клиента
      // одновременно) — пробуем следующие. Без этого человек видел техническую ошибку
      // про duplicate key и не понимал, что делать.
      const idAuto = body._idAuto || null;
      delete body._idAuto;
      // v882: вставка с повтором — если номер успели занять, берём следующий свободный.
      let result;
      let attempt = 0;
      while (true) {
        try {
          result = await sbInsert('clients', body);
          break;
        } catch (e) {
          const msg = String((e && e.message) || e);
          const isDup = msg.includes('23505') || msg.toLowerCase().includes('duplicate key');
          if (!isDup || !idAuto || attempt >= 20) {
            if (isDup) {
              return res.status(409).json({ ok: false,
                error: 'Клиент с таким номером уже есть. Обновите страницу и попробуйте ещё раз.' });
            }
            throw e;
          }
          attempt++;
          body.client_id = idAuto.prefix + String(idAuto.nextNum + attempt).padStart(5, '0');
        }
      }

      // v452: авто-задача «Связаться» при создании клиента (spec §8 п.2).
      // Запускается всегда, кроме случая когда явно отключено body.skip_auto_task=true.
      // Errors here are логируются но не валят создание клиента.
      // v960: клиент, созданный сразу действующим (из «Действующих» / формы оплаты) — через
      // общую активацию: дата, период, следующая оплата, запись в ленту.
      if (result[0] && result[0].status === 'active') {
        try {
          const a = await activateClient(result[0].client_id, { operator: body.support_operator || null, period: body.subscription_period_months, actor: callerName(req) || null, source: 'create', force_log: true });
          if (a.ok && a.client) result[0] = a.client;
        } catch (e) { console.warn('[clients] activate on create failed:', e.message || e); }
      }
      if (result[0] && !skipAutoTask) {
        try {
          const userName = callerName(req)
            || body.curator_operator
            || 'system';
          const assignee = body.curator_operator || userName;
          const deadlineAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // +1 час
          await sbInsert('tasks', {
            client_id: result[0].client_id,
            type_id: 1,                    // «Связаться»
            text: 'Связаться с новым клиентом',
            deadline_at: deadlineAt,
            deadline_end_at: null,
            is_all_day: false,
            assignee_operator: assignee,
            created_by: userName,
            status: 'open'
          });
        } catch (taskErr) {
          console.warn('[clients] auto-task creation failed:', taskErr.message || taskErr);
        }
      }

      return res.status(201).json({ ok: true, client: result[0] });
    }

    if (req.method === 'PATCH') {
      const { client_id } = req.query || {};
      if (!client_id) return res.status(400).json({ ok: false, error: 'нужен ?client_id=...' });
      const rawBody = await readBody(req);
      // v388: whitelist изменяемых полей. Защита от случайной перезаписи client_id/created_at
      // и от опечаток имени поля (Supabase молча отказал бы или вернул 500 от PostgREST).
      // v420: добавлен implementation_contact (JSONB) — «Ответственный со стороны клиента
      // по внедрению». Структура: { name, position, phone, email }.
      // v838: pay_reason/pay_reason_note/free_until — причина неоплаты и подаренный период
      // v859: support_operator — кто ВЕДЁТ клиента. curator_operator отвечает на другой вопрос,
      // «кто продал»: там имена продавцов из amoCRM, и у 452 действующих клиентов из 538 пусто.
      // v960: activation_source / status_reason — служебные, в таблицу не пишутся (снимаются ниже)
      const ALLOWED_PATCH_FIELDS = ['company_name','main_phone','curator_operator','support_operator','status','country','subscription_period_months','next_billing_at','activation_date','amo_lead_id','renew','renewal_months','implementation_contact','billing_host','pay_reason','pay_reason_note','free_until','activation_source','status_reason'];
      const body = {};
      Object.keys(rawBody).forEach(k => {
        if (ALLOWED_PATCH_FIELDS.includes(k)) body[k] = rawBody[k];
      });
      // v859: оператора поддержки принимаем только из «Сотрудников» нужной страны и
      // приводим к тому написанию, как человек записан в базе. Пустая строка — снять.
      if (body.support_operator !== undefined) {
        const raw = String(body.support_operator || '').trim();
        if (!raw) {
          body.support_operator = null;
        } else {
          const own = await sbSelect('clients', { client_id: 'eq.' + client_id, select: 'country', limit: '1' });
          const cCountry = (own.length && own[0].country) || 'KZ';
          const canon = await canonOperator(raw, cCountry);
          if (!canon) {
            const known = await operatorNames(cCountry);
            return res.status(400).json({ ok: false, error: 'Такого оператора нет в сотрудниках ' + cCountry + '. Доступны: ' + (known.join(', ') || 'никого') });
          }
          body.support_operator = canon;
          // v870: человек должен узнать, что ему передали клиента, а не обнаружить это
          // случайно через неделю. Уведомление не должно ронять саму передачу.
          try {
            const prev = await sbSelect('clients', { client_id: 'eq.' + client_id, select: 'company_name,support_operator', limit: '1' });
            const wasName = (prev[0] || {}).support_operator || null;
            if (canon !== wasName) {
              const toEmail = await opEmailByName(canon);
              if (toEmail) {
                await notifCreate({
                  user_email: toEmail,
                  type: 'client_transferred',
                  title: 'Вам передали клиента: ' + ((prev[0] || {}).company_name || client_id),
                  body: wasName ? ('Раньше вёл ' + wasName) : 'Раньше ответственного не было',
                  entity_type: 'client',
                  entity_id: client_id,
                  client_id: client_id,
                  actor: callerName(req) || null
                });
              }
            }
          } catch (e) {
            console.error('[client transfer notify]', e.message || e);
          }
        }
      }
      // v960: смена куратора — в ленту клиента (раньше только уведомление; через полгода
      // никто не мог сказать, кто и когда передал клиента)
      if (body.support_operator !== undefined) {
        try {
          const prevRow = await sbSelect('clients', { client_id: 'eq.' + client_id, select: 'support_operator', limit: '1' });
          const was = (prevRow[0] || {}).support_operator || null;
          if (was !== body.support_operator) {
            await logClientEvent(client_id, body.support_operator ? ('Куратор: ' + (was || '—') + ' → ' + body.support_operator) : ('Куратор снят (был ' + (was || '—') + ')'), callerName(req) || null);
          }
        } catch (_) {}
      }
      // v838: причина ставится только из списка; пустая строка = снять причину
      if (body.pay_reason !== undefined) {
        const PAY_REASONS = ['churn', 'decline', 'debt', 'free'];
        if (body.pay_reason === '' || body.pay_reason === null) {
          body.pay_reason = null;
          body.pay_reason_at = null;
          body.pay_reason_by = null;
        } else if (!PAY_REASONS.includes(body.pay_reason)) {
          return res.status(400).json({ ok: false, error: 'pay_reason должен быть один из: ' + PAY_REASONS.join(', ') });
        } else {
          body.pay_reason_at = new Date().toISOString();
          body.pay_reason_by = callerName(req) || null;
        }
      }
      body.updated_at = new Date().toISOString();
      if (body.status && !ALLOWED_STATUS.includes(body.status)) {
        return res.status(400).json({ ok: false, error: 'status должен быть один из: ' + ALLOWED_STATUS.join(', ') });
      }
      // v369: валидация периода подписки
      if (body.subscription_period_months !== undefined) {
        const p = parseInt(body.subscription_period_months, 10);
        if (!ALLOWED_PERIODS.includes(p)) {
          return res.status(400).json({ ok: false, error: 'subscription_period_months должен быть 1, 3, 6 или 12' });
        }
        body.subscription_period_months = p;
      }
      // v369: спец-действие renew — продлить подписку на N месяцев (по умолчанию = текущему периоду)
      // body: { renew: true, renewal_months?: 3 }
      // Эффект: next_billing_at = today + months. Не меняет status/activation_date.
      if (body.renew === true) {
        const existing = await sbSelect('clients', { client_id: 'eq.' + client_id, select: 'subscription_period_months,next_billing_at' });
        if (!existing.length) return res.status(404).json({ ok: false, error: 'клиент не найден' });
        const months = ALLOWED_PERIODS.includes(parseInt(body.renewal_months, 10))
          ? parseInt(body.renewal_months, 10)
          : (existing[0].subscription_period_months || 1);
        body.next_billing_at = nextBillingAfter(almatyIso(), months); // v960: календарное правило, как у крона и бота
        body.subscription_period_months = months;
        delete body.renew;
        delete body.renewal_months;
        try { await logClientEvent(client_id, 'Продление на ' + months + ' мес · следующая оплата ' + body.next_billing_at, callerName(req) || null); } catch (_) {}
      }
      // v960: активация — через activateClient (одна логика на все пути). Остальные поля тела
      // применяются ПОСЛЕ: раньше при already_active они молча выбрасывались.
      let activation = null;
      if (body.status === 'active') {
        activation = await activateClient(client_id, {
          operator: body.support_operator || body.curator_operator || null,
          period: body.subscription_period_months,
          activation_date: body.activation_date,
          next_billing_at: body.next_billing_at,
          actor: callerName(req) || null,
          source: body.activation_source || 'status'
        });
        if (!activation.ok) return res.status(404).json({ ok: false, error: activation.error });
        delete body.status; delete body.activation_date; delete body.next_billing_at; delete body.subscription_period_months;
        if (body.curator_operator && !body.support_operator && activation.client && !activation.client.support_operator) { /* куратор уже обработан в activateClient как support_operator */ }
        delete body.curator_operator;
        if (Object.keys(body).length <= 1) { // только updated_at
          return res.status(200).json({ ok: true, client: activation.client, already_active: activation.already_active });
        }
      }
      // v960: остальные переходы статуса — в ленту клиента с актором и причиной
      if (body.status && body.status !== 'active') {
        try {
          const prevRow = await sbSelect('clients', { client_id: 'eq.' + client_id, select: 'status', limit: '1' });
          const was = (prevRow[0] || {}).status;
          if (was && was !== body.status) {
            const PAY_RU = { churn:'ушёл', decline:'отказ', debt:'долг', free:'бесплатный период' };
            const reason = body.pay_reason ? (' · ' + (PAY_RU[body.pay_reason] || body.pay_reason)) : (body.status_reason ? (' · ' + String(body.status_reason).slice(0, 120)) : '');
            await logClientEvent(client_id, 'Статус: ' + (STATUS_RU[was] || was) + ' → ' + (STATUS_RU[body.status] || body.status) + reason, callerName(req) || null);
          }
        } catch (_) {}
      }
      delete body.status_reason; delete body.activation_source;
      let result;
      try {
        result = await sbUpdate('clients', { client_id: 'eq.' + client_id }, body);
      } catch (e) {
        if (/uq_clients_billing_host|billing_host|duplicate|unique/i.test(e.message || '')) {
          return res.status(409).json({ ok: false, error: 'Это имя сервера уже занято другим клиентом' });
        }
        throw e;
      }
      if (!result.length) return res.status(404).json({ ok: false, error: 'клиент не найден' });
      if (activation) return res.status(200).json({ ok: true, client: result[0], already_active: activation.already_active });

      // v376 → v379: авто-синхронизация SD→amo при активации ОТМЕНЕНА.
      // Менеджеры продаж сами закрывают сделки в amo — не нужно ещё одного источника
      // изменений в amo. Endpoint /api/amo POST update_status оставлен на случай если
      // в будущем понадобится ручной триггер, но автоматический вызов отсюда убран.
      return res.status(200).json({ ok: true, client: result[0] });
    }

    return res.status(405).json({ ok: false, error: 'method not allowed' });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message || String(e) });
  }
}

// Разовая привязка биллинг-хостов к существующим клиентам. ТОЛЬКО UPDATE, новых не создаём.
// body: { country, links: [{ client_id, billing_host }, ...] }. Дедуп/конфликты/идемпотентность.
async function handleLinkHosts(req, res) {
  const body = await readBody(req);
  const country = (body.country || 'KZ').toUpperCase();
  if (!ALLOWED_COUNTRIES.includes(country)) return res.status(400).json({ ok: false, error: 'country должен быть KZ или KG' });
  const links = Array.isArray(body.links) ? body.links : [];
  if (!links.length) return res.status(400).json({ ok: false, error: 'links пуст — нечего привязывать' });

  // Существующие хосты страны → кто владелец
  const existing = await sbSelect('clients', { country: 'eq.' + country, select: 'client_id,billing_host', limit: '5000' });
  const hostOwner = {};
  existing.forEach(c => { if (c.billing_host) hostOwner[String(c.billing_host).toLowerCase()] = c.client_id; });

  const seen = {};
  const toApply = []; const conflicts = []; let skipped = 0;
  for (const l of links) {
    const cid = String((l && l.client_id) || '').trim();
    const host = String((l && l.billing_host) || '').trim().toLowerCase();
    if (!cid || !host) { conflicts.push({ client_id: cid, billing_host: host, reason: 'пустой client_id или хост' }); continue; }
    if (seen[host] && seen[host] !== cid) { conflicts.push({ client_id: cid, billing_host: host, reason: 'один хост у нескольких клиентов в файле' }); continue; }
    const owner = hostOwner[host];
    if (owner && owner === cid) { skipped++; continue; }                 // уже привязан тому же — идемпотентно
    if (owner && owner !== cid) { conflicts.push({ client_id: cid, billing_host: host, reason: 'хост уже у другого клиента (' + owner + ')' }); continue; }
    seen[host] = cid;
    toApply.push({ cid, host });
  }

  let linked = 0; const failed = [];
  for (const a of toApply) {
    try {
      const r = await sbUpdate('clients', { client_id: 'eq.' + a.cid, country: 'eq.' + country }, { billing_host: a.host, updated_at: new Date().toISOString() });
      if (r && r.length) linked++; else failed.push({ client_id: a.cid, billing_host: a.host, reason: 'клиент не найден' });
    } catch (e) {
      if (/duplicate|unique/i.test(e.message || '')) conflicts.push({ client_id: a.cid, billing_host: a.host, reason: 'конфликт уникальности хоста' });
      else failed.push({ client_id: a.cid, billing_host: a.host, reason: e.message });
    }
  }
  return res.status(200).json({ ok: true, linked, skipped, conflicts_count: conflicts.length, conflicts: conflicts.slice(0, 50), failed_count: failed.length, failed: failed.slice(0, 20) });
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  return new Promise((resolve) => {
    let chunks = '';
    req.on('data', c => chunks += c);
    req.on('end', () => { try { resolve(JSON.parse(chunks || '{}')); } catch { resolve({}); } });
  });
}

// v960: addMonthsISO («сегодня + N мес») удалён — все даты следующей оплаты считает
// nextBillingAfter по календарному правилу.

// v376→v379: функция syncActivationToAmo удалена. CEO решил не дёргать amo автоматически
// при активации в SalesDoc — менеджеры продаж сами закрывают сделки в amo. Endpoint
// /api/amo POST update_status оставлен (может пригодиться для ручного триггера),
// но из /api/clients больше не вызывается.
