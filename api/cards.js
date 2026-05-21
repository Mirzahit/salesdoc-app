// /api/cards — CRUD карточек Канбана Внедрения (kanban_cards) И тикетов поддержки (tickets).
// Объединено в один endpoint из-за лимита Vercel Hobby = 12 serverless functions (мы на пределе).
//
// === Карточки Канбана (Маршрут клиента, основное использование):
// GET  /api/cards               → все активные карточки (не архивные)
// GET  /api/cards?operator=Айдос → карточки оператора
// GET  /api/cards?id=UUID       → одна карточка
// POST /api/cards               → создать карточку (body: { client_id, stage, operator, ... })
// POST /api/cards (v370)        → ИЛИ синхронизация от оплатного бота:
//                                 { source:'payment_bot', company, category, tariff, ... }
// PATCH /api/cards?id=UUID      → изменить (body: { stage: 'Активация', ... })
// DELETE /api/cards?id=UUID     → архивировать (soft delete: stage='Архив')
//
// === Тикеты поддержки (v378, after активации клиента):
// GET  /api/cards?entity=ticket                  → все тикеты (status!=closed)
// GET  /api/cards?entity=ticket&operator=Айдос   → мои тикеты
// GET  /api/cards?entity=ticket&client_id=X      → тикеты клиента
// GET  /api/cards?entity=ticket&sla_overdue=1    → просроченные по SLA
// GET  /api/cards?entity=ticket&id=UUID          → один тикет
// POST /api/cards?entity=ticket                  → создать тикет (body: { client_id, title, ... })
// PATCH /api/cards?entity=ticket&id=UUID         → изменить (status, operator, priority, ...)
// DELETE /api/cards?entity=ticket&id=UUID        → закрыть (status='closed')

import { sbSelect, sbInsert, sbUpdate } from './_supabase.js';
import { checkAuth } from './_auth.js';

// v364: whitelist разрешённых стадий — иначе мусорный stage сохранится молча
const ALLOWED_STAGES = ['Новый','Настройка','Обучение','Тестирование','Активация','Архив'];
const ALLOWED_COUNTRIES = ['KZ','KG'];
// v370: категории Доходов которые создают карточку в Маршруте (от payment_bot)
// v414: 'Нов интеграция' убрана — она ведётся в отдельной странице «Очередь интеграции»
// (Google Sheet 11ZnhVoLvIJRHeeJk0u-fZI2G5crWNHIpV9RDOVtDQJ4), её туда тянет отдельный модуль.
// Раньше платёж за интеграцию плодил дубль-карточку в канбане Внедрения рядом с карточкой Внедрения
// того же клиента. Теперь интеграция остаётся только в своей Очереди, во Внедрение не попадает.
const IMPLEMENTATION_CATEGORIES = ['Нов внедрение'];
const RENEWAL_CATEGORIES = ['абон. плата'];

// v378: Тикет-система поддержки
const TICKET_STATUSES = ['new','in_progress','waiting_client','solved','closed','reopened'];
const TICKET_PRIORITIES = ['low','normal','high','critical'];
const TICKET_CHANNELS = ['whatsapp','email','phone','form','manual'];
const TICKET_CATEGORIES = ['bug','question','training','feature_request','other'];
// v413: whitelist операторов — раньше можно было через curl вписать любое имя.
// null/'' разрешён — означает «не назначен».
const TICKET_OPERATORS = ['Айдос','Акбар','Самат','Нурай'];
// SLA в часах по приоритету. Дедлайн ответа = created_at + N часов.
const TICKET_SLA_HOURS = { critical: 2, high: 4, normal: 24, low: 72 };
function calculateTicketSLA(priority) {
  const hours = TICKET_SLA_HOURS[priority] || TICKET_SLA_HOURS.normal;
  return new Date(Date.now() + hours * 3600 * 1000).toISOString();
}

export default async function handler(req, res) {
  if (!checkAuth(req, res)) return;
  try {
    // v378: тикет-система склеена в /api/cards (лимит 12 функций Vercel).
    // entity=ticket → CRUD по таблице tickets вместо kanban_cards.
    // entity=ticket_comment → CRUD по таблице ticket_comments (v394).
    // v430: entity=integration → CRUD по таблице integrations (карты процесса интеграции).
    const entity = (req.query && (req.query.entity || req.query.kind) || '').toLowerCase();
    if (entity === 'ticket') {
      return await handleTicketsRoute(req, res);
    }
    if (entity === 'ticket_comment') {
      return await handleTicketCommentsRoute(req, res);
    }
    if (entity === 'integration') {
      return await handleIntegrationsRoute(req, res);
    }
    if (req.method === 'GET') {
      const { id, operator, stage, country } = req.query || {};
      const params = { select: '*,clients(company_name,main_phone,curator_operator,country)', order: 'created_at.desc' };
      if (id) params['id'] = 'eq.' + id;
      if (operator) params['operator'] = 'eq.' + operator;
      if (country) params['country'] = 'eq.' + country;
      if (stage) params['stage'] = 'eq.' + stage;
      else params['stage'] = 'neq.Архив';
      const data = await sbSelect('kanban_cards', params);
      return res.status(200).json({ ok: true, count: data.length, cards: data });
    }

    if (req.method === 'POST') {
      const body = await readBody(req);
      // v370: ветка синхронизации от оплатного бота (Telegram bot на Railway).
      // Бот после записи в Доходы 2026 шлёт сюда — мы решаем что делать в Supabase.
      if (body.source === 'payment_bot') {
        return await handlePaymentBotSync(body, res);
      }
      if (!body.client_id) return res.status(400).json({ ok: false, error: 'client_id обязателен' });
      const stage = body.stage || 'Новый';
      if (!ALLOWED_STAGES.includes(stage)) {
        return res.status(400).json({ ok: false, error: 'stage должен быть один из: ' + ALLOWED_STAGES.join(', ') });
      }
      const country = (body.country || 'KZ').toUpperCase();
      if (!ALLOWED_COUNTRIES.includes(country)) {
        return res.status(400).json({ ok: false, error: 'country должен быть KZ или KG' });
      }
      const card = {
        client_id: body.client_id,
        stage: stage,
        country: country,
        operator: body.operator || null,
        tariff: body.tariff || null,
        licenses_count: body.licenses_count || null,
        modules: body.modules || null,
        stage_entered_at: new Date().toISOString()
      };
      const result = await sbInsert('kanban_cards', card);
      return res.status(201).json({ ok: true, card: result[0] });
    }

    if (req.method === 'PATCH') {
      const { id } = req.query || {};
      if (!id) return res.status(400).json({ ok: false, error: 'нужен ?id=UUID' });
      const body = await readBody(req);
      const patch = {};
      if (body.stage) {
        if (!ALLOWED_STAGES.includes(body.stage)) {
          return res.status(400).json({ ok: false, error: 'stage должен быть один из: ' + ALLOWED_STAGES.join(', ') });
        }
        patch.stage = body.stage;
        patch.stage_entered_at = new Date().toISOString();
      }
      if (body.operator !== undefined) patch.operator = body.operator;
      if (body.tariff !== undefined) patch.tariff = body.tariff;
      if (body.licenses_count !== undefined) patch.licenses_count = body.licenses_count;
      if (body.modules !== undefined) patch.modules = body.modules;
      // v388: новые поля v377 теперь редактируются inline на карточке клиента
      if (body.payment_amount !== undefined) patch.payment_amount = body.payment_amount;
      if (body.sales_manager !== undefined) patch.sales_manager = body.sales_manager;
      if (body.payment_category !== undefined) patch.payment_category = body.payment_category;
      if (!Object.keys(patch).length) return res.status(400).json({ ok: false, error: 'нечего обновлять' });
      const result = await sbUpdate('kanban_cards', { id: 'eq.' + id }, patch);
      if (!result.length) return res.status(404).json({ ok: false, error: 'карточка не найдена' });
      return res.status(200).json({ ok: true, card: result[0] });
    }

    if (req.method === 'DELETE') {
      const { id } = req.query || {};
      if (!id) return res.status(400).json({ ok: false, error: 'нужен ?id=UUID' });
      const result = await sbUpdate('kanban_cards', { id: 'eq.' + id }, {
        stage: 'Архив',
        archived_at: new Date().toISOString()
      });
      if (!result.length) return res.status(404).json({ ok: false, error: 'карточка не найдена' });
      return res.status(200).json({ ok: true, card: result[0] });
    }

    return res.status(405).json({ ok: false, error: 'method not allowed' });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message || String(e) });
  }
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  return new Promise((resolve) => {
    let chunks = '';
    req.on('data', c => chunks += c);
    req.on('end', () => { try { resolve(JSON.parse(chunks || '{}')); } catch { resolve({}); } });
  });
}

// v370: обработка синхронизации от оплатного бота.
// Поведение по категории:
//   - 'Нов внедрение' / 'Нов интеграция' → создать клиента (если ещё нет)
//                                         + карточку в Маршруте на стадии 'Новый'.
//   - 'абон. плата'                       → найти клиента по company_name,
//                                         продлить next_billing_at на period_months.
//   - Прочее                              → 200 OK, действия не выполняем (но возвращаем
//                                         action='ignored' чтобы бот понимал почему).
// Идемпотентность: уникальный индекс на (country, sheet_month, sheet_row) в kanban_cards.
async function handlePaymentBotSync(body, res) {
  const company = (body.company || '').trim();
  const category = (body.category || '').trim();
  const country = (body.country || 'KZ').toUpperCase();
  const period_months = parseInt(body.period_months, 10) || 1;
  const sheet_row = body.sheet_row ? parseInt(body.sheet_row, 10) : null;
  const sheet_month = body.sheet_month ? parseInt(body.sheet_month, 10) : null;

  if (!company) return res.status(400).json({ ok: false, error: 'company обязателен' });
  if (!category) return res.status(400).json({ ok: false, error: 'category обязателен' });
  if (!ALLOWED_COUNTRIES.includes(country)) {
    return res.status(400).json({ ok: false, error: 'country должен быть KZ или KG' });
  }

  // Категории которые не создают и не продлевают (баланс, доработка, бот-услуги и т.п.).
  // Фиксируем приём, но действий не выполняем.
  const isImpl = IMPLEMENTATION_CATEGORIES.includes(category);
  const isRenewal = RENEWAL_CATEGORIES.includes(category);
  if (!isImpl && !isRenewal) {
    return res.status(200).json({ ok: true, action: 'ignored', reason: 'category not in implementation/renewal whitelist' });
  }

  // Ищем существующего клиента по точному имени (+ country).
  // Имя приходит из колонки B Доходов 2026 — сотрудник вводит его в боте,
  // поэтому в рамках одного клиента имя стабильно (нет дублей 777/7771/7772).
  const existing = await sbSelect('clients', {
    country: 'eq.' + country,
    company_name: 'eq.' + company,
    select: '*',
    limit: '1'
  });

  if (isRenewal) {
    // Продление подписки: клиент должен существовать. Если нет — это сигнал ошибки данных.
    if (!existing.length) {
      return res.status(404).json({
        ok: false,
        action: 'renewal_failed',
        error: 'клиент с именем «' + company + '» не найден в Supabase (country=' + country + '). Проверьте имя в Доходах.'
      });
    }
    const cl = existing[0];
    const newDate = addMonthsISO(new Date(), period_months);
    await sbUpdate('clients', { client_id: 'eq.' + cl.client_id }, {
      next_billing_at: newDate,
      subscription_period_months: period_months,
      updated_at: new Date().toISOString()
    });
    return res.status(200).json({
      ok: true,
      action: 'renewed',
      client_id: cl.client_id,
      next_billing_at: newDate
    });
  }

  // isImpl: новое внедрение/интеграция → клиент + карточка
  let clientId;
  if (existing.length) {
    clientId = existing[0].client_id;
    // Обновим период если пришёл — пригодится при активации (next_billing_at = act_date + period)
    if (existing[0].subscription_period_months !== period_months) {
      await sbUpdate('clients', { client_id: 'eq.' + clientId }, {
        subscription_period_months: period_months,
        updated_at: new Date().toISOString()
      });
    }
  } else {
    // Авто-генерация client_id: SD-KZ-2026-NNNNN
    const last = await sbSelect('clients', {
      select: 'client_id',
      country: 'eq.' + country,
      order: 'created_at.desc',
      limit: '1'
    });
    const year = new Date().getFullYear();
    const prefix = 'SD-' + country + '-' + year + '-';
    let nextNum = 1;
    if (last.length) {
      const m = (last[0].client_id || '').match(/SD-[A-Z]{2}-\d{4}-(\d+)/);
      if (m) nextNum = parseInt(m[1], 10) + 1;
    }
    clientId = prefix + String(nextNum).padStart(5, '0');
    await sbInsert('clients', {
      client_id: clientId,
      company_name: company,
      country: country,
      status: 'onboarding',
      subscription_period_months: period_months
    });
  }

  // Идемпотентность: если карточка для этого sheet_row уже есть — возвращаем её.
  // Защита от повторного вызова от бота (например при ретраях).
  if (sheet_row && sheet_month) {
    const existCard = await sbSelect('kanban_cards', {
      country: 'eq.' + country,
      sheet_row: 'eq.' + sheet_row,
      sheet_month: 'eq.' + sheet_month,
      select: 'id,client_id,stage',
      limit: '1'
    });
    if (existCard.length) {
      return res.status(200).json({
        ok: true,
        action: 'already_synced',
        card_id: existCard[0].id,
        client_id: existCard[0].client_id
      });
    }
  }

  // Создаём карточку. Оператора не назначаем — куратор сам возьмёт из «Новых».
  // v377: сохраняем дополнительно сумму пакета, менеджера продаж и категорию оплаты —
  // оператор сразу видит на карточке Канбана кто продал, за сколько и какой тип сделки.
  const cardRow = {
    client_id: clientId,
    stage: 'Новый',
    country: country,
    tariff: body.tariff || null,
    payment_amount: body.amount ? parseInt(body.amount, 10) : null,
    sales_manager: (body.manager || '').trim() || null,
    payment_category: category || null,
    stage_entered_at: new Date().toISOString(),
    sheet_row: sheet_row,
    sheet_month: sheet_month
  };
  const card = await sbInsert('kanban_cards', cardRow);

  return res.status(201).json({
    ok: true,
    action: 'card_created',
    card_id: card[0].id,
    client_id: clientId,
    company: company
  });
}

// v394: CRUD комментариев к тикетам. Таблица ticket_comments создана миграцией v378.
async function handleTicketCommentsRoute(req, res) {
  if (req.method === 'GET') {
    const { ticket_id } = req.query || {};
    if (!ticket_id) return res.status(400).json({ ok: false, error: 'нужен ?ticket_id=UUID' });
    const items = await sbSelect('ticket_comments', {
      ticket_id: 'eq.' + ticket_id,
      order: 'created_at.asc'
    });
    return res.status(200).json({ ok: true, count: items.length, comments: items });
  }
  if (req.method === 'POST') {
    const body = await readBody(req);
    if (!body.ticket_id) return res.status(400).json({ ok: false, error: 'ticket_id обязателен' });
    if (!body.text || !String(body.text).trim()) return res.status(400).json({ ok: false, error: 'text обязателен' });
    const row = {
      ticket_id: body.ticket_id,
      author: body.author || null,
      text: String(body.text).trim().slice(0, 5000),
      channel: body.channel || 'internal',
      attachment_url: body.attachment_url || null
    };
    const result = await sbInsert('ticket_comments', row);
    return res.status(201).json({ ok: true, comment: result[0] });
  }
  return res.status(405).json({ ok: false, error: 'method not allowed' });
}

// v370: тот же хелпер что в /api/clients.js — добавить N месяцев к дате.
// Дублирую тут чтобы не плодить общий модуль (12-функций лимит Vercel Hobby).
function addMonthsISO(date, months) {
  const d = new Date(date);
  const day = d.getDate();
  d.setMonth(d.getMonth() + months);
  if (d.getDate() < day) d.setDate(0);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// v378: CRUD тикет-системы. Вызывается когда в /api/cards пришёл ?entity=ticket.
// Поддерживает GET (список/один), POST (создать), PATCH (изменить), DELETE (закрыть).
async function handleTicketsRoute(req, res) {
  if (req.method === 'GET') {
    const { id, status, operator, client_id, country, priority, sla_overdue } = req.query || {};
    const params = { order: 'created_at.desc' };
    if (id) params['id'] = 'eq.' + id;
    if (status) params['status'] = 'eq.' + status;
    if (operator) params['operator'] = 'eq.' + operator;
    if (client_id) params['client_id'] = 'eq.' + client_id;
    if (country) params['country'] = 'eq.' + country;
    if (priority) params['priority'] = 'eq.' + priority;
    // sla_overdue=1 → просроченные тикеты в работе (sla_due_at < now AND status НЕ закрыт)
    if (sla_overdue === '1' || sla_overdue === 'true') {
      params['sla_due_at'] = 'lt.' + new Date().toISOString();
      params['status'] = 'in.(new,in_progress,waiting_client,reopened)';
    }
    // По умолчанию скрываем закрытые если нет явного фильтра по status
    else if (!status) {
      params['status'] = 'neq.closed';
    }
    params['select'] = '*,clients(company_name,main_phone,curator_operator,country)';
    const data = await sbSelect('tickets', params);
    return res.status(200).json({ ok: true, count: data.length, tickets: data });
  }

  if (req.method === 'POST') {
    const body = await readBody(req);
    if (!body.client_id) return res.status(400).json({ ok: false, error: 'client_id обязателен (тикет привязан к клиенту)' });
    if (!body.title || !String(body.title).trim()) return res.status(400).json({ ok: false, error: 'title обязателен' });

    const country = (body.country || 'KZ').toUpperCase();
    if (!ALLOWED_COUNTRIES.includes(country)) {
      return res.status(400).json({ ok: false, error: 'country должен быть KZ или KG' });
    }
    const priority = body.priority || 'normal';
    if (!TICKET_PRIORITIES.includes(priority)) {
      return res.status(400).json({ ok: false, error: 'priority должен быть один из: ' + TICKET_PRIORITIES.join(', ') });
    }
    const channel = body.channel || 'manual';
    if (!TICKET_CHANNELS.includes(channel)) {
      return res.status(400).json({ ok: false, error: 'channel должен быть один из: ' + TICKET_CHANNELS.join(', ') });
    }
    if (body.category && !TICKET_CATEGORIES.includes(body.category)) {
      return res.status(400).json({ ok: false, error: 'category должен быть один из: ' + TICKET_CATEGORIES.join(', ') });
    }
    if (body.operator && !TICKET_OPERATORS.includes(body.operator)) {
      return res.status(400).json({ ok: false, error: 'operator должен быть один из: ' + TICKET_OPERATORS.join(', ') });
    }

    const ticket = {
      client_id: body.client_id,
      country: country,
      title: String(body.title).trim().slice(0, 200),
      description: body.description ? String(body.description).slice(0, 5000) : null,
      status: 'new',
      priority: priority,
      channel: channel,
      category: body.category || null,
      operator: body.operator || null,
      sla_due_at: calculateTicketSLA(priority)
    };
    const result = await sbInsert('tickets', ticket);
    return res.status(201).json({ ok: true, ticket: result[0] });
  }

  if (req.method === 'PATCH') {
    const { id } = req.query || {};
    if (!id) return res.status(400).json({ ok: false, error: 'нужен ?id=UUID' });
    const body = await readBody(req);

    // Валидация изменяемых полей
    if (body.status && !TICKET_STATUSES.includes(body.status)) {
      return res.status(400).json({ ok: false, error: 'status: ' + TICKET_STATUSES.join(', ') });
    }
    if (body.priority && !TICKET_PRIORITIES.includes(body.priority)) {
      return res.status(400).json({ ok: false, error: 'priority: ' + TICKET_PRIORITIES.join(', ') });
    }
    if (body.category && !TICKET_CATEGORIES.includes(body.category)) {
      return res.status(400).json({ ok: false, error: 'category: ' + TICKET_CATEGORIES.join(', ') });
    }
    // v413: PATCH тоже валидирует operator — раньше можно было через curl записать любое имя.
    // null разрешён (сброс назначения).
    if (body.operator && !TICKET_OPERATORS.includes(body.operator)) {
      return res.status(400).json({ ok: false, error: 'operator: ' + TICKET_OPERATORS.join(', ') });
    }

    const patch = { updated_at: new Date().toISOString() };
    ['status','priority','category','operator','title','description'].forEach(k => {
      if (body[k] !== undefined) patch[k] = body[k];
    });
    // v404: tags TEXT[] — массив коротких меток. Принимаем только массив строк,
    // обрезаем по 32 символа, дедуплицируем, максимум 12 тегов.
    if (body.tags !== undefined) {
      if (!Array.isArray(body.tags)) {
        return res.status(400).json({ ok: false, error: 'tags должен быть массивом строк' });
      }
      const seen = new Set();
      patch.tags = body.tags
        .map(t => String(t).trim().slice(0, 32))
        .filter(t => t.length > 0 && !seen.has(t) && (seen.add(t), true))
        .slice(0, 12);
    }

    // Авто-метки времени:
    // - при первом переводе в in_progress (взяли в работу) фиксируем first_response_at
    // - при переводе в solved фиксируем solved_at
    if (body.status === 'in_progress') {
      const existing = await sbSelect('tickets', { id: 'eq.' + id, select: 'first_response_at' });
      if (existing.length && !existing[0].first_response_at) {
        patch.first_response_at = new Date().toISOString();
      }
    }
    if (body.status === 'solved') {
      patch.solved_at = new Date().toISOString();
    }
    // Смена приоритета пересчитывает SLA (от текущего момента).
    // v413: сравниваем со старым — внешние интеграции (бот) могут шлёт тот же priority,
    // и тогда счётчик SLA не должен сбрасываться.
    if (body.priority) {
      const existingPrio = await sbSelect('tickets', { id: 'eq.' + id, select: 'priority' });
      if (existingPrio.length && existingPrio[0].priority !== body.priority) {
        patch.sla_due_at = calculateTicketSLA(body.priority);
      }
    }

    const result = await sbUpdate('tickets', { id: 'eq.' + id }, patch);
    if (!result.length) return res.status(404).json({ ok: false, error: 'тикет не найден' });
    return res.status(200).json({ ok: true, ticket: result[0] });
  }

  if (req.method === 'DELETE') {
    const { id } = req.query || {};
    if (!id) return res.status(400).json({ ok: false, error: 'нужен ?id=UUID' });
    // Soft delete: status='closed'. Полное удаление не предусмотрено.
    const result = await sbUpdate('tickets', { id: 'eq.' + id }, {
      status: 'closed',
      updated_at: new Date().toISOString()
    });
    if (!result.length) return res.status(404).json({ ok: false, error: 'тикет не найден' });
    return res.status(200).json({ ok: true, ticket: result[0] });
  }

  return res.status(405).json({ ok: false, error: 'method not allowed' });
}

// =============================================================================
// v430: INTEGRATIONS — карты процесса интеграции 1С/банк/касса/...
// Архитектура: client_id из clients = главная карта; integrations = временные
// карты привязанные к клиенту. См. memory/project_client_card_architecture.md
//
// GET    /api/cards?entity=integration                  → все активные (status != 'Архив')
// GET    /api/cards?entity=integration&id=UUID          → одна
// GET    /api/cards?entity=integration&client_id=X      → интеграции клиента (включая архив)
// GET    /api/cards?entity=integration&operator=Иван    → мои
// GET    /api/cards?entity=integration&status=Готово    → по статусу
// GET    /api/cards?entity=integration&country=KZ       → по стране
// POST   /api/cards?entity=integration                  → создать
// PATCH  /api/cards?entity=integration&id=UUID          → изменить
// DELETE /api/cards?entity=integration&id=UUID          → архивировать (status='Архив')
// =============================================================================

const INTEGRATION_STATUSES = ['Новая','В работе','Готово','Отменено','На паузе','Архив'];
// Type и Package оставлены свободными — у интеграторов могут появляться новые
// варианты, не хочется блокировать ввод и каждый раз ходить править код.
// Валидируем только то что точно зафиксировано (status, country).

// v430: разовый импорт интеграций из Google-таблицы.
// Параметры: ?action=import_sheets&dry_run=1 (по умолчанию dry_run=1)
// Источник: hardcoded Google Sheet ID 11ZnhVoLvIJRHeeJk0u-fZI2G5crWNHIpV9RDOVtDQJ4
const INTEG_SHEET_ID = '11ZnhVoLvIJRHeeJk0u-fZI2G5crWNHIpV9RDOVtDQJ4';

function _parseCsv(text) {
  const rows = [];
  let cur = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i+1] === '"') { field += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { cur.push(field); field = ''; }
      else if (c === '\n') { cur.push(field); rows.push(cur); cur = []; field = ''; }
      else if (c === '\r') { /* skip */ }
      else field += c;
    }
  }
  if (field || cur.length) { cur.push(field); rows.push(cur); }
  return rows;
}

// Парс «30.01.2026» → «2026-01-30» (ISO). Возвращает null если не распознали.
function _parseDmy(s) {
  if (!s) return null;
  const m = String(s).trim().match(/^(\d{1,2})[.\/](\d{1,2})[.\/](\d{4})$/);
  if (!m) return null;
  const dd = m[1].padStart(2, '0');
  const mm = m[2].padStart(2, '0');
  return m[3] + '-' + mm + '-' + dd;
}

// Нормализация названия для поиска клиента: lowercase, без знаков, схлопываем пробелы
function _normName(s) {
  return String(s||'').toLowerCase().replace(/[«»"',.()]/g, ' ').replace(/\s+/g, ' ').trim();
}

async function handleSheetsImport(req, res) {
  const dryRun = String(req.query.dry_run || '1') !== '0' && req.query.dry_run !== 'false';

  // 1. Тянем CSV из Google Sheets
  const csvUrl = `https://docs.google.com/spreadsheets/d/${INTEG_SHEET_ID}/gviz/tq?tqx=out:csv`;
  let csv;
  try {
    const r = await fetch(csvUrl);
    if (!r.ok) return res.status(502).json({ ok: false, error: 'Sheets fetch failed: ' + r.status });
    csv = await r.text();
  } catch (e) {
    return res.status(502).json({ ok: false, error: 'Sheets fetch error: ' + e.message });
  }

  const rows = _parseCsv(csv);
  if (rows.length < 2) return res.status(200).json({ ok: true, dry_run: dryRun, message: 'Пустая таблица', total: 0 });

  // 2. Загружаем всех клиентов один раз для поиска
  const allClients = await sbSelect('clients', { select: 'client_id,company_name' });
  const clientByName = {};
  allClients.forEach(c => {
    const k = _normName(c.company_name);
    if (k) clientByName[k] = c.client_id;
  });

  // 3. Парсим каждую строку Sheets (пропускаем первую — заголовки)
  const matched = []; // { sheet_row, company, client_id, comment? }
  const unmatched = []; // строки без клиента
  const skipped = []; // пустое название и т.п.

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || !r.length) continue;
    const sheetRow = i + 1; // Google Sheets row number (1-based + заголовок)
    const country = String(r[0]||'').trim().toUpperCase() || 'KZ';
    const datePaid = _parseDmy(r[1]);
    const dateTaken = _parseDmy(r[2]);
    const deadline = _parseDmy(r[3]);
    const dateDone = _parseDmy(r[4]);
    const company = String(r[5]||'').trim();
    if (!company) { skipped.push({ sheet_row: sheetRow, reason: 'empty company' }); continue; }
    const status = String(r[6]||'').trim() || 'Новая';
    const type = String(r[8]||'').trim() || null;
    const operator = String(r[9]||'').trim() || null;
    const manager = String(r[10]||'').trim() || null;
    const loginPassword = String(r[11]||'').trim() || null;
    const server = String(r[12]||'').trim() || null;
    const contactPersons = String(r[13]||'').trim() || null;
    const comment = String(r[14]||'').trim() || null;
    const dbType = String(r[15]||'').trim() || null;
    const pkg = String(r[16]||'').trim() || null;

    const clientId = clientByName[_normName(company)] || null;

    const row = {
      sheet_row: sheetRow,
      country: ['KZ','KG'].includes(country) ? country : 'KZ',
      company_name: company,
      status: INTEGRATION_STATUSES.includes(status) ? status : 'Новая',
      type, package: pkg, db_type: dbType,
      operator, manager,
      date_paid: datePaid, date_taken: dateTaken, deadline, date_done: dateDone,
      login_password: loginPassword, server, contact_persons: contactPersons,
      comment, // оставляем поле в integrations + ниже отдельно пишем в card_history
      client_id: clientId
    };

    if (clientId) matched.push(row);
    else unmatched.push(row);
  }

  const planSummary = {
    ok: true,
    dry_run: dryRun,
    total_rows_in_sheet: rows.length - 1,
    skipped_empty: skipped.length,
    will_match_client: matched.length,
    will_unmatched_client: unmatched.length,
    will_add_history_notes: matched.filter(r => r.comment).length,
    sample_matched: matched.slice(0, 5).map(r => ({ company: r.company_name, client_id: r.client_id, status: r.status })),
    sample_unmatched: unmatched.slice(0, 5).map(r => r.company_name)
  };

  if (dryRun) {
    planSummary.message = 'DRY RUN — ничего не записано. Запусти с &dry_run=0 чтобы реально импортировать.';
    return res.status(200).json(planSummary);
  }

  // 4. Реальный импорт. Сначала integrations — батчами по 50 чтобы не упереться в лимиты PostgREST.
  const allRows = matched.concat(unmatched);
  let inserted = 0;
  const failures = [];
  for (let i = 0; i < allRows.length; i += 50) {
    const batch = allRows.slice(i, i + 50);
    try {
      const result = await sbInsert('integrations', batch);
      inserted += result.length;
      // Для каждой вставленной записи, у которой есть client_id И есть комментарий, пишем в card_history
      for (let j = 0; j < result.length; j++) {
        const ins = result[j];
        const src = batch[j];
        if (src.client_id && src.comment) {
          try {
            await sbInsert('card_history', {
              client_id: src.client_id,
              event_type: 'integration_note',
              text: src.comment,
              author: src.operator || 'Интегратор',
              attachment_url: 'integration:' + ins.id
            });
          } catch (e) {
            failures.push({ company: src.company_name, error: 'history: ' + e.message });
          }
        }
      }
    } catch (e) {
      failures.push({ batch_start: i, error: e.message });
    }
  }

  planSummary.dry_run = false;
  planSummary.actually_inserted = inserted;
  planSummary.failures = failures;
  planSummary.message = `Готово. Импортировано ${inserted} интеграций из ${allRows.length}. Ошибок: ${failures.length}.`;
  return res.status(200).json(planSummary);
}

async function handleIntegrationsRoute(req, res) {
  // v430: импорт из Sheets — отдельный action
  if (req.method === 'POST' && (req.query.action || '').toLowerCase() === 'import_sheets') {
    return await handleSheetsImport(req, res);
  }

  if (req.method === 'GET') {
    const { id, client_id, operator, status, country, type, package: pkg, include_archive } = req.query || {};
    const params = {
      select: '*,clients(company_name,main_phone,curator_operator,status)',
      order: 'created_at.desc'
    };
    if (id) params['id'] = 'eq.' + id;
    if (client_id) {
      // Для конкретного клиента ВСЕГДА показываем и архив (нужно для истории клиента)
      params['client_id'] = 'eq.' + client_id;
    } else {
      // На общей доске по умолчанию архив прячем (если явно не попросили)
      if (!status && include_archive !== '1') params['status'] = 'neq.Архив';
    }
    if (operator) params['operator'] = 'eq.' + operator;
    if (status) params['status'] = 'eq.' + status;
    if (country) params['country'] = 'eq.' + country;
    if (type) params['type'] = 'eq.' + type;
    if (pkg) params['package'] = 'eq.' + pkg;
    const data = await sbSelect('integrations', params);
    return res.status(200).json({ ok: true, count: data.length, integrations: data });
  }

  if (req.method === 'POST') {
    const body = await readBody(req);
    if (!body.company_name || !String(body.company_name).trim()) {
      return res.status(400).json({ ok: false, error: 'company_name обязателен' });
    }
    const country = String(body.country || 'KZ').toUpperCase();
    if (!ALLOWED_COUNTRIES.includes(country)) {
      return res.status(400).json({ ok: false, error: 'country должен быть KZ или KG' });
    }
    const statusVal = body.status || 'Новая';
    if (!INTEGRATION_STATUSES.includes(statusVal)) {
      return res.status(400).json({ ok: false, error: 'status должен быть один из: ' + INTEGRATION_STATUSES.join(', ') });
    }
    const row = {
      client_id: body.client_id || null,
      company_name: String(body.company_name).trim(),
      country: country,
      status: statusVal,
      type: body.type || null,
      package: body.package || null,
      db_type: body.db_type || null,
      operator: body.operator || null,
      manager: body.manager || null,
      date_paid: body.date_paid || null,
      date_taken: body.date_taken || null,
      deadline: body.deadline || null,
      date_done: body.date_done || null,
      login_password: body.login_password || null,
      server: body.server || null,
      contact_persons: body.contact_persons || null,
      comment: body.comment || null,
      sheet_row: body.sheet_row || null
    };
    const result = await sbInsert('integrations', row);
    return res.status(201).json({ ok: true, integration: result[0] });
  }

  if (req.method === 'PATCH') {
    const { id } = req.query || {};
    if (!id) return res.status(400).json({ ok: false, error: 'нужен ?id=UUID' });
    const rawBody = await readBody(req);
    // Whitelist изменяемых полей. Защита от случайной перезаписи id/client_id/created_at.
    const ALLOWED_FIELDS = ['company_name','status','type','package','db_type','operator','manager',
                            'date_paid','date_taken','deadline','date_done',
                            'login_password','server','contact_persons','comment','country'];
    const patch = {};
    Object.keys(rawBody).forEach(k => {
      if (ALLOWED_FIELDS.includes(k)) patch[k] = rawBody[k];
    });
    if (patch.status && !INTEGRATION_STATUSES.includes(patch.status)) {
      return res.status(400).json({ ok: false, error: 'status должен быть один из: ' + INTEGRATION_STATUSES.join(', ') });
    }
    if (patch.country && !ALLOWED_COUNTRIES.includes(patch.country)) {
      return res.status(400).json({ ok: false, error: 'country должен быть KZ или KG' });
    }
    if (!Object.keys(patch).length) {
      return res.status(400).json({ ok: false, error: 'нечего обновлять' });
    }
    // updated_at обновляется триггером БД, тут не трогаем
    const result = await sbUpdate('integrations', { id: 'eq.' + id }, patch);
    if (!result.length) return res.status(404).json({ ok: false, error: 'интеграция не найдена' });
    return res.status(200).json({ ok: true, integration: result[0] });
  }

  if (req.method === 'DELETE') {
    const { id } = req.query || {};
    if (!id) return res.status(400).json({ ok: false, error: 'нужен ?id=UUID' });
    // Soft delete — переводим в статус Архив, ничего не теряем
    const result = await sbUpdate('integrations', { id: 'eq.' + id }, { status: 'Архив' });
    if (!result.length) return res.status(404).json({ ok: false, error: 'интеграция не найдена' });
    return res.status(200).json({ ok: true, integration: result[0] });
  }

  return res.status(405).json({ ok: false, error: 'method not allowed' });
}
