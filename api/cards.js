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
import { checkAuth, checkAdminToken } from './_auth.js';
import { almatyIso } from './_dates.js';

// v364: whitelist разрешённых стадий — иначе мусорный stage сохранится молча
const ALLOWED_STAGES = ['Новый','Настройка','Обучение','Тестирование','Активация','Архив'];
const ALLOWED_COUNTRIES = ['KZ','KG'];
// v370: категории Доходов которые создают карточку в Маршруте (от payment_bot)
// v414: 'Нов интеграция' убрана из IMPLEMENTATION_CATEGORIES — она шла в Google-таблицу.
// v430: 'Нов интеграция' теперь обрабатывается отдельно — создаёт запись в таблице
// integrations Supabase (главная карта клиента + временная карта интеграции).
// См. memory/project_client_card_architecture.md
const IMPLEMENTATION_CATEGORIES = ['Нов внедрение'];
const INTEGRATION_PAYMENT_CATEGORIES = ['Нов интеграция'];
const RENEWAL_CATEGORIES = ['абон. плата'];
// v794: KG-бот шлёт категории в другом написании («нов.интеграция», «нов.внедрение») —
// точное сравнение их игнорировало, карточки появлялись только через сутки из крон-синка.
// Сравниваем без регистра/точек/пробелов (как mapCategoryFromSheet в payments.js).
function _normCategory(c) { return String(c || '').toLowerCase().replace(/[^a-zа-яё0-9]/g, ''); }
function _catIn(list, cat) { const n = _normCategory(cat); return list.some(x => _normCategory(x) === n); }

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
      const params = { select: '*,clients(company_name,main_phone,curator_operator,country,billing_host)', order: 'created_at.desc' };
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
      // v817: фронт передаёт country в query (sbFetch), body может его не содержать —
      // без фолбэка карточка с доски KG молча писалась как KZ
      const country = (body.country || (req.query || {}).country || 'KZ').toUpperCase();
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

// v636: ПЕРЕИСПОЛЬЗУЕМОЕ ЯДРО — заводит клиента (если ещё нет) и создаёт карту внедрения
// (kanban_cards, стадия 'Новый') ИЛИ запись интеграции (integrations, статус 'Новая') по
// новой оплате. Вызывается из двух мест:
//   1) handlePaymentBotSync — оплатный бот (когда/если его включат);
//   2) payments.js importSheetsForCountry / handlePost — крон-синк Sheets→Supabase и ручное
//      добавление оплаты. Так новые клиенты попадают на доски БЕЗ бота.
// kind: 'impl' | 'integ'. Возвращает { action, client_id, card_id?|integration_id? }.
// Идемпотентность: дедуп по (country, sheet_row, sheet_month); fallback по client_id
// (активная карта / интеграция «Новая» той же датой) — на случай отсутствия sheet-полей.
// v810: оператор новой интеграции подтягивается с Внедрения клиента —
// сначала постоянный ведущий (clients.curator_operator), иначе оператор последней карты Маршрута.
// Сбой не критичен: карточка создастся без оператора, как раньше.
async function operatorFromImplementation(clientId) {
  if (!clientId) return null;
  try {
    const cl = await sbSelect('clients', { client_id: 'eq.' + clientId, select: 'curator_operator', limit: '1' });
    const cur = cl.length ? String(cl[0].curator_operator || '').trim() : '';
    if (cur) return cur;
    const cards = await sbSelect('kanban_cards', {
      client_id: 'eq.' + clientId, select: 'operator', order: 'created_at.desc', limit: '5'
    });
    const withOp = cards.find(c => String(c.operator || '').trim());
    return withOp ? String(withOp.operator).trim() : null;
  } catch (_) { return null; }
}

export async function ensureBoardEntryForPayment(opts) {
  const company = (opts.company || '').trim();
  const country = (opts.country || 'KZ').toUpperCase();
  const kind = opts.kind;
  const period_months = parseInt(opts.period_months, 10) || 1;
  const sheet_row = opts.sheet_row != null ? parseInt(opts.sheet_row, 10) : null;
  const sheet_month = opts.sheet_month != null ? parseInt(opts.sheet_month, 10) : null;
  if (!company) throw new Error('company обязателен');
  if (!ALLOWED_COUNTRIES.includes(country)) throw new Error('country должен быть KZ или KG');
  if (kind !== 'impl' && kind !== 'integ') throw new Error('kind должен быть impl|integ');

  // Найти/создать клиента (точное имя + country; имя из колонки «Компания» стабильно).
  const existing = await sbSelect('clients', {
    country: 'eq.' + country, company_name: 'eq.' + company, select: '*', limit: '1'
  });
  let clientId;
  if (existing.length) {
    clientId = existing[0].client_id;
    if (existing[0].subscription_period_months !== period_months) {
      await sbUpdate('clients', { client_id: 'eq.' + clientId }, {
        subscription_period_months: period_months, updated_at: new Date().toISOString()
      });
    }
  } else {
    // Авто-генерация client_id: SD-KZ-2026-NNNNN
    const last = await sbSelect('clients', {
      select: 'client_id', country: 'eq.' + country, order: 'created_at.desc', limit: '1'
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
      client_id: clientId, company_name: company, country: country,
      status: 'onboarding', subscription_period_months: period_months
    });
  }

  if (kind === 'integ') {
    if (sheet_row != null && sheet_month != null) { // v663: sheet_month=0 (Sheets-импорт) — реальное значение, не falsy-пропуск дедупа
      const existInteg = await sbSelect('integrations', {
        country: 'eq.' + country, sheet_row: 'eq.' + sheet_row, sheet_month: 'eq.' + sheet_month,
        select: 'id,client_id,status', limit: '1'
      });
      if (existInteg.length) {
        return { action: 'already_synced_integration', integration_id: existInteg[0].id, client_id: existInteg[0].client_id };
      }
    }
    const todayIso = opts.date_paid || almatyIso(); // v817: было по Гринвичу — ночная оплата уезжала на вчера
    const recentInteg = await sbSelect('integrations', {
      client_id: 'eq.' + clientId, status: 'eq.Новая', date_paid: 'eq.' + todayIso,
      select: 'id,client_id,status', limit: '1'
    });
    if (recentInteg.length) {
      return { action: 'already_synced_integration_by_date', integration_id: recentInteg[0].id, client_id: recentInteg[0].client_id };
    }
    const inserted = await sbInsert('integrations', {
      client_id: clientId, company_name: company, country: country, status: 'Новая',
      manager: (opts.manager || '').trim() || null, date_paid: todayIso,
      operator: await operatorFromImplementation(clientId), // v810: оператор с Внедрения клиента
      package: opts.tariff || null, sheet_row: sheet_row, sheet_month: sheet_month
    });
    return { action: 'integration_created', integration_id: inserted[0].id, client_id: clientId };
  }

  // kind === 'impl'
  if (sheet_row != null && sheet_month != null) { // v663: sheet_month=0 (Sheets-импорт) — реальное значение, не falsy-пропуск дедупа
    const existCard = await sbSelect('kanban_cards', {
      country: 'eq.' + country, sheet_row: 'eq.' + sheet_row, sheet_month: 'eq.' + sheet_month,
      select: 'id,client_id,stage', limit: '1'
    });
    if (existCard.length) {
      return { action: 'already_synced', card_id: existCard[0].id, client_id: existCard[0].client_id };
    }
  }
  // v636: fallback-дедуп без sheet-полей (ручная оплата) — активная карта того же клиента.
  const activeCard = await sbSelect('kanban_cards', {
    client_id: 'eq.' + clientId, stage: 'neq.Архив', select: 'id,client_id,stage', limit: '1'
  });
  if (activeCard.length) {
    return { action: 'already_has_card', card_id: activeCard[0].id, client_id: activeCard[0].client_id };
  }
  const card = await sbInsert('kanban_cards', {
    client_id: clientId, stage: 'Новый', country: country, tariff: opts.tariff || null,
    payment_amount: opts.amount ? parseInt(opts.amount, 10) : null,
    sales_manager: (opts.manager || '').trim() || null,
    payment_category: opts.category || null, stage_entered_at: new Date().toISOString(),
    sheet_row: sheet_row, sheet_month: sheet_month
  });
  return { action: 'card_created', card_id: card[0].id, client_id: clientId };
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
  // v794: сравнение без регистра/точек — KG-вариант «нов.интеграция» раньше игнорировался
  const isImpl = _catIn(IMPLEMENTATION_CATEGORIES, category);
  const isInteg = _catIn(INTEGRATION_PAYMENT_CATEGORIES, category);
  const isRenewal = _catIn(RENEWAL_CATEGORIES, category);
  if (!isImpl && !isInteg && !isRenewal) {
    return res.status(200).json({ ok: true, action: 'ignored', reason: 'category not in implementation/integration/renewal whitelist' });
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

  // isImpl/isInteg: делегируем в общее ядро (то же используется крон-импортом оплат).
  // v636: дедуп клиента/карты/интеграции и создание клиента теперь внутри ядра.
  const r = await ensureBoardEntryForPayment({
    company: company,
    country: country,
    kind: isInteg ? 'integ' : 'impl',
    period_months: period_months,
    manager: body.manager,
    tariff: body.tariff,
    amount: body.amount,
    category: category,
    sheet_row: sheet_row,
    sheet_month: sheet_month
  });
  const created = (r.action === 'card_created' || r.action === 'integration_created');
  return res.status(created ? 201 : 200).json({ ok: true, company: company, ...r });
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
      // v663: явный фильтр по status имеет приоритет; SLA-дефолт только если status не задан
      if (!status) params['status'] = 'in.(new,in_progress,waiting_client,reopened)';
    }
    // По умолчанию скрываем закрытые если нет явного фильтра по status.
    // all=1 — показать все, включая закрытые (для ленты карточки клиента — историческая хронология).
    else if (!status && req.query.all !== '1' && req.query.all !== 'true') {
      params['status'] = 'neq.closed';
    }
    params['select'] = '*,clients(company_name,main_phone,curator_operator,country,billing_host)';
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
    // v460: для manual-создания требуем ответственного. Auto-creation из бота (channel=whatsapp/phone/email/form)
    // может приходить без оператора — будет назначен позже вручную.
    if (channel === 'manual' && (!body.operator || !String(body.operator).trim())) {
      return res.status(400).json({ ok: false, error: 'operator обязателен при ручном создании тикета (нельзя создать без ответственного)' });
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

    // v460: пауза SLA в стадии «Ждём ответ от клиента».
    // Logic:
    //  → moving INTO waiting_client: сохраняем момент начала ожидания
    //  → moving OUT of waiting_client: считаем сколько ждали, пушим sla_due_at вперёд на это время,
    //    добавляем к waiting_total_seconds, обнуляем waiting_started_at
    // v643: graceful degradation — колонки waiting_started_at/waiting_total_seconds могут
    // отсутствовать в проде (миграция 2026-05-25-tickets-waiting-pause.sql не применена).
    // Тогда SELECT/UPDATE с ними падает (42703) и тикет вообще нельзя переместить. Оборачиваем
    // паузу SLA в try/catch: нет колонок → просто пропускаем паузу, перемещение работает.
    // Применят миграцию — фича включится сама без правок кода.
    if (body.status && body.status !== undefined) {
      try {
        const cur = await sbSelect('tickets', { id: 'eq.' + id, select: 'status,sla_due_at,waiting_started_at,waiting_total_seconds' });
        if (cur.length) {
          const oldStatus = cur[0].status;
          const newStatus = body.status;
          if (newStatus === 'waiting_client' && oldStatus !== 'waiting_client') {
            // Вход в ожидание — фиксируем момент
            patch.waiting_started_at = new Date().toISOString();
          } else if (oldStatus === 'waiting_client' && newStatus !== 'waiting_client') {
            // Выход из ожидания — пушим SLA вперёд на длительность паузы
            if (cur[0].waiting_started_at) {
              const pauseStart = new Date(cur[0].waiting_started_at).getTime();
              const pauseMs = Date.now() - pauseStart;
              if (pauseMs > 0) {
                // Пушим sla_due_at вперёд на pauseMs миллисекунд
                if (cur[0].sla_due_at) {
                  const newDue = new Date(new Date(cur[0].sla_due_at).getTime() + pauseMs);
                  patch.sla_due_at = newDue.toISOString();
                }
                // Накопленный счётчик пауз
                patch.waiting_total_seconds = (cur[0].waiting_total_seconds || 0) + Math.round(pauseMs / 1000);
              }
              patch.waiting_started_at = null;
            }
          }
        }
      } catch (e) {
        // Нет колонок паузы SLA — не блокируем перемещение тикета. На всякий случай чистим patch.
        if (/waiting_started_at|waiting_total_seconds|42703/i.test(String((e && e.message) || ''))) {
          delete patch.waiting_started_at;
          delete patch.waiting_total_seconds;
        } else { throw e; }
      }
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
// v794: type/package валидируем по whitelist — но только НОВЫЕ значения (POST/PATCH).
// Старые строки из Sheets-импорта со свободными значениями продолжают жить, пока их не трогают.
const INTEGRATION_TYPES = ['Интеграция','Доработка','Разработка'];
const INTEGRATION_PACKAGES = ['Стандарт','Стандарт+','Премиум','Услуга'];

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

// v431: маппинг статусов из Sheets в INTEGRATION_STATUSES Supabase.
// В Sheets было несколько вариаций одного смысла («Выполняется» = «В работе»),
// схлопываем их к нашему чистому списку.
const SHEET_STATUS_MAP = {
  'Выполняется': 'В работе',
  'Тестируют': 'В работе',
  'В очереди': 'Новая',
  'Очередь': 'Новая',
  'Новая': 'Новая',
  'В работе': 'В работе',
  'На паузе': 'На паузе',
  'Готово': 'Готово',
  'Протестирован': 'Готово',
  'Отменено': 'Отменено',
  'Перенесено': 'Отменено',
  'Архив': 'Архив'
};
const SHEET_ACTIVE_STATUSES = new Set(['Выполняется','Тестируют','В очереди','Очередь','Новая','В работе','На паузе']);

async function handleSheetsImport(req, res) {
  // v592 SEC: массовое создание клиентов/интеграций — только с админ-кодом
  const _g = checkAdminToken(req);
  if (!_g.ok) return res.status(_g.unconfigured ? 503 : 403).json({ ok: false, error: _g.unconfigured ? 'Импорт недоступен: не настроен ADMIN_TOKEN' : 'Нужен админ-код', needAdminToken: !_g.unconfigured });
  const dryRun = String(req.query.dry_run || '1') !== '0' && req.query.dry_run !== 'false';
  // v431: ?active_only=1 — переносим только незавершённые работы (не Готово/Отменено/Перенесено).
  // Архив остаётся в Sheets.
  const activeOnly = String(req.query.active_only || '0') === '1' || req.query.active_only === 'true';

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
  let matched = []; // { sheet_row, company, client_id, comment? }
  let unmatched = []; // строки без клиента
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
    const rawStatus = String(r[6]||'').trim() || 'Новая';
    // v431: фильтр active_only — пропускаем завершённые/отменённые
    if (activeOnly && !SHEET_ACTIVE_STATUSES.has(rawStatus)) {
      skipped.push({ sheet_row: sheetRow, reason: 'status=' + rawStatus + ' (не активная)' });
      continue;
    }
    const status = SHEET_STATUS_MAP[rawStatus] || 'Новая';
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
      // v436 FIX: sheet_month=0 для Sheets-импорта. Партиальный uniq-индекс
      // требует чтобы оба поля были не-null. Иначе повторный импорт продублирует.
      sheet_month: 0,
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

  // v436 FIX: pre-check на повторный импорт. Если sheet_row+country уже есть
  // в integrations — пропускаем строку, не дублируем. Защита от случайного
  // повторного запуска import_sheets — раньше создавал бы 11 → 22 → 33.
  if (!dryRun) {
    const existingRows = await sbSelect('integrations', {
      select: 'sheet_row,country',
      sheet_row: 'not.is.null'
    });
    const existingKeys = new Set(existingRows.map(r => r.country + ':' + r.sheet_row));
    const beforeFilter = matched.length + unmatched.length;
    matched = matched.filter(r => !existingKeys.has(r.country + ':' + r.sheet_row));
    unmatched = unmatched.filter(r => !existingKeys.has(r.country + ':' + r.sheet_row));
    const afterFilter = matched.length + unmatched.length;
    if (beforeFilter !== afterFilter) {
      skipped.push({ reason: 'already_imported', count: beforeFilter - afterFilter });
    }
  }

  // 4. Дедуп тех у кого клиент не найден — по нормализованному имени.
  // Для каждой уникальной компании создаём главную карту в clients и привязываем
  // все её интеграции к этому новому client_id.
  const unmatchedByName = {}; // norm_name → { country, company_name, rows: [] }
  unmatched.forEach(r => {
    const key = _normName(r.company_name);
    if (!unmatchedByName[key]) {
      unmatchedByName[key] = { country: r.country, company_name: r.company_name, rows: [] };
    }
    unmatchedByName[key].rows.push(r);
  });
  const newClientsPlan = Object.values(unmatchedByName);

  const planSummary = {
    ok: true,
    dry_run: dryRun,
    total_rows_in_sheet: rows.length - 1,
    skipped_empty: skipped.length,
    will_match_existing_clients: matched.length,
    will_create_new_clients: newClientsPlan.length,
    will_total_integrations: matched.length + unmatched.length,
    will_add_history_notes: matched.filter(r => r.comment).length + unmatched.filter(r => r.comment).length,
    sample_new_clients: newClientsPlan.slice(0, 10).map(g => ({ company: g.company_name, integrations: g.rows.length, country: g.country }))
  };

  if (dryRun) {
    planSummary.message = 'DRY RUN — ничего не записано. Запусти с &dry_run=0 чтобы реально импортировать.';
    return res.status(200).json(planSummary);
  }

  // 5. Реальный импорт. Сначала создаём новых клиентов, потом интеграции.
  let createdClients = 0;
  const newClientsErrors = [];

  // Находим начальные номера client_id для KZ и KG (нужно генерить SD-KZ-2026-NNNNN)
  const year = new Date().getFullYear();
  const nextNumByCountry = { KZ: 1, KG: 1 };
  for (const cn of ['KZ','KG']) {
    const last = await sbSelect('clients', {
      select: 'client_id',
      country: 'eq.' + cn,
      order: 'created_at.desc',
      limit: '1'
    });
    if (last.length) {
      const m = (last[0].client_id || '').match(new RegExp('SD-[A-Z]{2}-\\d{4}-(\\d+)'));
      if (m) nextNumByCountry[cn] = parseInt(m[1], 10) + 1;
    }
  }

  for (const g of newClientsPlan) {
    const cn = ['KZ','KG'].includes(g.country) ? g.country : 'KZ';
    const num = nextNumByCountry[cn]++;
    const cid = 'SD-' + cn + '-' + year + '-' + String(num).padStart(5, '0');
    try {
      // status='active' — безопасное предположение для исторических интеграций
      // (если интегратор работал с клиентом — клиент скорее всего реальный)
      await sbInsert('clients', {
        client_id: cid,
        company_name: g.company_name,
        country: cn,
        status: 'active'
      });
      createdClients++;
      // Привязываем все интеграции этой компании к новому client_id
      g.rows.forEach(r => { r.client_id = cid; });
    } catch (e) {
      newClientsErrors.push({ company: g.company_name, error: e.message });
    }
  }

  // 6. Теперь все строки имеют client_id (matched + unmatched после создания)
  const allRows = matched.concat(unmatched.filter(r => r.client_id));
  let inserted = 0;
  let historyAdded = 0;
  const failures = [];
  for (let i = 0; i < allRows.length; i += 50) {
    const batch = allRows.slice(i, i + 50);
    try {
      const result = await sbInsert('integrations', batch);
      inserted += result.length;
      // Для каждой вставленной записи, у которой есть комментарий, пишем в card_history
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
            historyAdded++;
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
  planSummary.created_clients = createdClients;
  planSummary.new_clients_errors = newClientsErrors;
  planSummary.inserted_integrations = inserted;
  planSummary.history_notes_added = historyAdded;
  planSummary.failures = failures;
  planSummary.message = `Готово. Создано ${createdClients} главных карт клиентов, импортировано ${inserted} интеграций, добавлено ${historyAdded} заметок в ленту. Ошибок: ${failures.length + newClientsErrors.length}.`;
  return res.status(200).json(planSummary);
}

async function handleIntegrationsRoute(req, res) {
  // v430: импорт из Sheets — отдельный action
  if (req.method === 'POST' && (req.query.action || '').toLowerCase() === 'import_sheets') {
    return await handleSheetsImport(req, res);
  }

  // v431: дозапись заметок-комментариев из integrations.comment в card_history.
  // Нужно после миграции CHECK constraint event_type для integration_note.
  // Проходит по интеграциям с непустым comment и client_id, проверяет нет ли
  // уже записи в card_history с attachment_url='integration:<id>', если нет — пишет.
  if (req.method === 'POST' && (req.query.action || '').toLowerCase() === 'backfill_integration_notes') {
    const _gb = checkAdminToken(req); // v592 SEC: массовая запись в ленту — только админ-код
    if (!_gb.ok) return res.status(_gb.unconfigured ? 503 : 403).json({ ok: false, error: _gb.unconfigured ? 'Недоступно: не настроен ADMIN_TOKEN' : 'Нужен админ-код', needAdminToken: !_gb.unconfigured });
    const integs = await sbSelect('integrations', {
      select: 'id,client_id,comment,operator'
    });
    let processed = 0;
    let added = 0;
    const errors = [];
    for (const it of integs) {
      if (!it.comment || !it.client_id) continue; // фильтр на JS — у кого нет client_id, пропускаем
      processed++;
      // Проверка — нет ли уже записи (идемпотентность)
      const exists = await sbSelect('card_history', {
        client_id: 'eq.' + it.client_id,
        attachment_url: 'eq.integration:' + it.id,
        select: 'id',
        limit: '1'
      });
      if (exists.length) continue;
      try {
        await sbInsert('card_history', {
          client_id: it.client_id,
          event_type: 'integration_note',
          text: it.comment,
          author: it.operator || 'Интегратор',
          attachment_url: 'integration:' + it.id
        });
        added++;
      } catch (e) {
        errors.push({ integration_id: it.id, error: e.message });
      }
    }
    return res.status(200).json({
      ok: true,
      processed,
      added,
      errors,
      message: `Просмотрено ${processed} интеграций с комментарием, добавлено ${added} новых заметок в ленту.`
    });
  }

  if (req.method === 'GET') {
    const { id, client_id, operator, status, country, type, package: pkg, include_archive } = req.query || {};
    // v592 SEC: секреты (login_password, server) отдаём ТОЛЬКО в детальном запросе (по id/client_id),
    // а в общем списке доски — нет, иначе любой с бандл-токеном выкачивает учётки клиентов.
    const isDetail = !!(id || client_id);
    const SAFE_COLS = 'id,client_id,company_name,country,status,type,package,db_type,operator,manager,date_paid,date_taken,deadline,date_done,contact_persons,comment,sheet_row,created_at,updated_at,sheet_month,queue_pos';
    const params = {
      select: (isDetail ? '*' : SAFE_COLS) + ',clients(company_name,main_phone,curator_operator,status)',
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
    if (body.type && !INTEGRATION_TYPES.includes(body.type)) {
      return res.status(400).json({ ok: false, error: 'type должен быть один из: ' + INTEGRATION_TYPES.join(', ') });
    }
    if (body.package && !INTEGRATION_PACKAGES.includes(body.package)) {
      return res.status(400).json({ ok: false, error: 'package должен быть один из: ' + INTEGRATION_PACKAGES.join(', ') });
    }
    const row = {
      client_id: body.client_id || null,
      company_name: String(body.company_name).trim(),
      country: country,
      status: statusVal,
      type: body.type || null,
      package: body.package || null,
      db_type: body.db_type || null,
      operator: body.operator || await operatorFromImplementation(body.client_id) || null, // v810
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
    // Whitelist изменяемых полей. Защита от случайной перезаписи id/created_at.
    // client_id меняется только через явную ветку ниже (v820), с проверкой существования клиента.
    const ALLOWED_FIELDS = ['company_name','status','type','package','db_type','operator','manager',
                            'date_paid','date_taken','deadline','date_done',
                            'login_password','server','contact_persons','comment','country','queue_pos','custom_fields'];
    const patch = {};
    Object.keys(rawBody).forEach(k => {
      if (ALLOWED_FIELDS.includes(k)) patch[k] = rawBody[k];
    });
    // v820: быстрая привязка клиента из очереди. client_id меняется только явно
    // и только на существующего клиента (или null — отвязка).
    if ('client_id' in rawBody) {
      if (rawBody.client_id == null || rawBody.client_id === '') {
        patch.client_id = null;
      } else {
        const cid = String(rawBody.client_id);
        const cl = await sbSelect('clients', { client_id: 'eq.' + cid, select: 'client_id', limit: '1' });
        if (!cl.length) return res.status(400).json({ ok: false, error: 'клиент не найден: ' + cid });
        patch.client_id = cid;
      }
    }
    if (patch.status && !INTEGRATION_STATUSES.includes(patch.status)) {
      return res.status(400).json({ ok: false, error: 'status должен быть один из: ' + INTEGRATION_STATUSES.join(', ') });
    }
    if (patch.type && !INTEGRATION_TYPES.includes(patch.type)) {
      return res.status(400).json({ ok: false, error: 'type должен быть один из: ' + INTEGRATION_TYPES.join(', ') });
    }
    if (patch.package && !INTEGRATION_PACKAGES.includes(patch.package)) {
      return res.status(400).json({ ok: false, error: 'package должен быть один из: ' + INTEGRATION_PACKAGES.join(', ') });
    }
    if (patch.country && !ALLOWED_COUNTRIES.includes(patch.country)) {
      return res.status(400).json({ ok: false, error: 'country должен быть KZ или KG' });
    }
    // v796: значения своих полей — только плоский объект строк (защита от мусора в jsonb)
    if (patch.custom_fields != null) {
      if (typeof patch.custom_fields !== 'object' || Array.isArray(patch.custom_fields)) {
        return res.status(400).json({ ok: false, error: 'custom_fields должен быть объектом' });
      }
      const cleaned = {};
      Object.keys(patch.custom_fields).slice(0, 50).forEach(k => {
        const v = patch.custom_fields[k];
        if (v == null || v === '') return;
        cleaned[String(k).slice(0, 60)] = String(v).slice(0, 2000);
      });
      patch.custom_fields = cleaned;
    }
    if (!Object.keys(patch).length) {
      return res.status(400).json({ ok: false, error: 'нечего обновлять' });
    }
    // v794: авто-даты при смене статуса. Единая точка для всех путей (inline-редактор,
    // статус-чип, drag&drop, боты). Даты date-only по Алматы (UTC+5).
    // «В работе» → date_taken=сегодня, deadline=+14 дней (если пустые).
    // «Готово»/«Отменено» → date_done=сегодня (если пустой) — иначе доска и аналитика
    // считают завершение по deadline/updated_at и относят его не к тому месяцу.
    if (patch.status && ['В работе', 'Готово', 'Отменено'].includes(patch.status)) {
      const cur = await sbSelect('integrations', { id: 'eq.' + id, select: 'status,date_taken,deadline,date_done', limit: '1' });
      if (cur.length && cur[0].status !== patch.status) {
        const almaty = new Date(Date.now() + 5 * 3600 * 1000);
        const iso = d => d.toISOString().slice(0, 10);
        if (patch.status === 'В работе') {
          if (!cur[0].date_taken && !patch.date_taken) patch.date_taken = iso(almaty);
          if (!cur[0].deadline && !patch.deadline) {
            patch.deadline = iso(new Date(almaty.getTime() + 14 * 86400000));
          }
        } else {
          if (!cur[0].date_done && !patch.date_done) patch.date_done = iso(almaty);
        }
      }
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
