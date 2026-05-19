// /api/cards — CRUD карточек Канбана Внедрения.
//
// GET  /api/cards               → все активные карточки (не архивные)
// GET  /api/cards?operator=Айдос → карточки оператора
// GET  /api/cards?id=UUID       → одна карточка
// POST /api/cards               → создать карточку (body: { client_id, stage, operator, ... })
// POST /api/cards (v370)        → ИЛИ синхронизация от оплатного бота:
//                                 { source:'payment_bot', company, category, tariff,
//                                   period_months, amount, manager, sheet_row, sheet_month, country }
// PATCH /api/cards?id=UUID      → изменить (body: { stage: 'Активация', ... })
// DELETE /api/cards?id=UUID     → архивировать (soft delete: stage='Архив', archived_at=now)

import { sbSelect, sbInsert, sbUpdate } from './_supabase.js';
import { checkAuth } from './_auth.js';

// v364: whitelist разрешённых стадий — иначе мусорный stage сохранится молча
const ALLOWED_STAGES = ['Новый','Настройка','Обучение','Тестирование','Активация','Архив'];
const ALLOWED_COUNTRIES = ['KZ','KG'];
// v370: категории Доходов которые создают карточку в Маршруте (от payment_bot)
const IMPLEMENTATION_CATEGORIES = ['Нов внедрение', 'Нов интеграция'];
const RENEWAL_CATEGORIES = ['абон. плата'];

export default async function handler(req, res) {
  if (!checkAuth(req, res)) return;
  try {
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
  const cardRow = {
    client_id: clientId,
    stage: 'Новый',
    country: country,
    tariff: body.tariff || null,
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

// v370: тот же хелпер что в /api/clients.js — добавить N месяцев к дате.
// Дублирую тут чтобы не плодить общий модуль (12-функций лимит Vercel Hobby).
function addMonthsISO(date, months) {
  const d = new Date(date);
  const day = d.getDate();
  d.setMonth(d.getMonth() + months);
  if (d.getDate() < day) d.setDate(0);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
