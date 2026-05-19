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

const ALLOWED_STATUS = ['lead','sale','onboarding','active','paused','churned'];
const ALLOWED_COUNTRIES = ['KZ','KG'];
const ALLOWED_PERIODS = [1, 3, 6, 12]; // месяцев подписки

export default async function handler(req, res) {
  if (!checkAuth(req, res)) return;
  try {
    if (req.method === 'GET') {
      const { client_id, status, curator, search, country, renewal_within } = req.query || {};
      const params = { order: 'updated_at.desc' };
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
        const today = new Date().toISOString().slice(0, 10);
        if (n < 0) {
          params['next_billing_at'] = 'lt.' + today;
        } else {
          const future = new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
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
      const country = (body.country || 'KZ').toUpperCase();
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
      if (!body.client_id) {
        // v364: авто-генерация с префиксом страны: SD-KZ-2026-NNNN / SD-KG-2026-NNNN
        // Уменьшает риск гонки (хотя UNIQUE-индекс в БД всё равно нужен).
        const existing = await sbSelect('clients', {
          select: 'client_id',
          country: 'eq.' + country,
          order: 'created_at.desc',
          limit: '1'
        });
        const year = new Date().getFullYear();
        const prefix = 'SD-' + country + '-' + year + '-';
        let nextNum = 1;
        if (existing.length) {
          const last = existing[0].client_id || '';
          const m = last.match(/SD-[A-Z]{2}-\d{4}-(\d+)/);
          if (m) nextNum = parseInt(m[1], 10) + 1;
        }
        body.client_id = prefix + String(nextNum).padStart(5, '0');
      }
      if (!body.company_name) return res.status(400).json({ ok: false, error: 'company_name обязателен' });
      if (body.status && !ALLOWED_STATUS.includes(body.status)) {
        return res.status(400).json({ ok: false, error: 'status должен быть один из: ' + ALLOWED_STATUS.join(', ') });
      }
      const result = await sbInsert('clients', body);
      return res.status(201).json({ ok: true, client: result[0] });
    }

    if (req.method === 'PATCH') {
      const { client_id } = req.query || {};
      if (!client_id) return res.status(400).json({ ok: false, error: 'нужен ?client_id=...' });
      const body = await readBody(req);
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
        body.next_billing_at = addMonthsISO(new Date(), months);
        body.subscription_period_months = months;
        delete body.renew;
        delete body.renewal_months;
      }
      // v364: идемпотентность активации — если уже active и снова шлют active, не пишем
      if (body.status === 'active') {
        const existing = await sbSelect('clients', { client_id: 'eq.' + client_id, select: 'status,activation_date,subscription_period_months,amo_lead_id,country' });
        if (existing[0] && existing[0].status === 'active') {
          return res.status(200).json({ ok: true, client: existing[0], already_active: true });
        }
        // v369: при активации автоматически проставляем next_billing_at = today + period месяцев.
        // Если в body явно передан next_billing_at — уважаем его (для случаев когда куратор знает точную дату).
        if (!body.next_billing_at) {
          const months = body.subscription_period_months
            || (existing[0] && existing[0].subscription_period_months)
            || 1;
          body.next_billing_at = addMonthsISO(new Date(), months);
          if (!body.subscription_period_months) body.subscription_period_months = months;
        }
        if (!body.activation_date) body.activation_date = new Date().toISOString().slice(0, 10);
      }
      const result = await sbUpdate('clients', { client_id: 'eq.' + client_id }, body);
      if (!result.length) return res.status(404).json({ ok: false, error: 'клиент не найден' });

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

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  return new Promise((resolve) => {
    let chunks = '';
    req.on('data', c => chunks += c);
    req.on('end', () => { try { resolve(JSON.parse(chunks || '{}')); } catch { resolve({}); } });
  });
}

// v369: добавляет N месяцев к дате, возвращает 'YYYY-MM-DD'.
// Делаем сами а не через Postgres чтобы поведение было предсказуемым в JS-логике.
function addMonthsISO(date, months) {
  const d = new Date(date);
  const day = d.getDate();
  d.setMonth(d.getMonth() + months);
  // Если в целевом месяце меньше дней (например 31 янв + 1 мес = 28 фев) — JS уже корректирует, но проверим
  if (d.getDate() < day) d.setDate(0); // последний день предыдущего месяца
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// v376→v379: функция syncActivationToAmo удалена. CEO решил не дёргать amo автоматически
// при активации в SalesDoc — менеджеры продаж сами закрывают сделки в amo. Endpoint
// /api/amo POST update_status оставлен (может пригодиться для ручного триггера),
// но из /api/clients больше не вызывается.
