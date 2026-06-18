// Разовый безопасный бэкфилл недавних (с 2026-05-01) клиентов внедрения в Маршрут.
// Использует публичные эндпоинты (APP_TOKEN), без админ-кода. Идемпотентно.
// Превью:  node scripts/backfill-impl-recent.mjs
// Запись:  APPLY=1 node scripts/backfill-impl-recent.mjs
const APP = 'salesdoc-2026-route-secret-9k3xJ7';
const BASE = 'https://salesdoc-app.vercel.app';
const FROM = '2026-05-01';
const APPLY = process.env.APPLY === '1';
const H = { 'x-app-token': APP, 'Content-Type': 'application/json' };
const norm = s => String(s || '').toLowerCase().replace(/[«»"',.()]/g, ' ').replace(/\s+/g, ' ').trim();
const getj = async u => (await fetch(BASE + u, { headers: H })).json();
const post = async (u, body) => { const r = await fetch(BASE + u, { method: 'POST', headers: H, body: JSON.stringify(body) }); return { status: r.status, json: await r.json() }; };
const patch = async (u, body) => { const r = await fetch(BASE + u, { method: 'PATCH', headers: H, body: JSON.stringify(body) }); return { status: r.status, json: await r.json() }; };

const DONE = ['active', 'paused', 'churned'];
const results = { created: [], skipped_has_card: [], skipped_done: [], errors: [] };

for (const country of ['KZ', 'KG']) {
  // все карты (любой стадии) → client_id, чтобы не дублировать
  const cardsAll = await getj('/api/cards');
  const cardClientIds = new Set((cardsAll.cards || []).map(c => c.client_id));
  // клиенты страны (статус + имя→client_id)
  const cj = await getj('/api/clients?country=' + country);
  const clients = cj.clients || [];
  const clByName = new Map(); clients.forEach(c => clByName.set(norm(c.company_name), c));
  // множество всех существующих client_id (для генерации гарантированно свободного id) +
  // текущий максимум числового суффикса (авто-ген сервера ненадёжен — коллизит).
  const allIds = new Set(clients.map(c => c.client_id));
  let maxNum = 0;
  clients.forEach(c => { const m = String(c.client_id || '').match(/SD-[A-Z]{2}-\d{4}-(\d+)/); if (m) maxNum = Math.max(maxNum, parseInt(m[1], 10)); });
  const nextFreeId = () => { do { maxNum++; var id = 'SD-' + country + '-2026-' + String(maxNum).padStart(5, '0'); } while (allIds.has(id)); allIds.add(id); return id; };
  // оплаты внедрения с FROM
  const pj = await getj('/api/payments?country=' + country + '&category=implementation&limit=5000');
  const impl = (pj.payments || []).filter(p => String(p.paid_at) >= FROM);
  // уникальные по имени (берём самую свежую оплату клиента)
  const byName = new Map();
  for (const p of impl) { const n = norm(p.company_name); const ex = byName.get(n); if (!ex || String(p.paid_at) > String(ex.paid_at)) byName.set(n, p); }

  for (const [n, p] of byName) {
    const cl = clByName.get(n);
    const status = cl ? String(cl.status || '').toLowerCase() : null;
    let cid = cl ? cl.client_id : null;
    if (cid && cardClientIds.has(cid)) { results.skipped_has_card.push(p.company_name + ' (' + country + ')'); continue; }
    if (status && DONE.includes(status)) { results.skipped_done.push(p.company_name + ' [' + status + '] (' + country + ')'); continue; }

    if (!APPLY) { results.created.push(p.company_name + ' (' + country + ')' + (cid ? ' [есть клиент ' + cid + ']' : ' [новый клиент]')); continue; }

    try {
      // 1) клиент (новому присваиваем СВОЙ свободный client_id — авто-ген сервера коллизит;
      //    onboarding, без авто-задачи)
      if (!cid) {
        const newId = nextFreeId();
        const cr = await post('/api/clients', { client_id: newId, company_name: p.company_name, country, status: 'onboarding', skip_auto_task: true });
        cid = cr.json && cr.json.client && cr.json.client.client_id;
        if (!cid) throw new Error('client create failed: ' + JSON.stringify(cr.json));
      }
      // повторная защита: вдруг карта появилась
      if (cardClientIds.has(cid)) { results.skipped_has_card.push(p.company_name + ' (' + country + ')'); continue; }
      // 2) карта в стадии «Новый»
      const cardRes = await post('/api/cards', { client_id: cid, stage: 'Новый', country, tariff: 'Услуга' });
      const card = cardRes.json && cardRes.json.card;
      if (!card) throw new Error('card create failed: ' + JSON.stringify(cardRes.json));
      cardClientIds.add(cid);
      // 3) обогащение (сумма/менеджер/категория) — чтобы оператор видел контекст
      await patch('/api/cards?id=' + card.id, {
        payment_amount: p.amount != null ? Math.round(Number(p.amount)) : null,
        sales_manager: p.manager_name || null,
        payment_category: 'Нов внедрение'
      });
      results.created.push(p.company_name + ' (' + country + ') → ' + cid + ' / card ' + card.id);
    } catch (e) {
      results.errors.push(p.company_name + ' (' + country + '): ' + (e.message || e));
    }
  }
}

console.log(APPLY ? '=== ПРИМЕНЕНО ===' : '=== ПРЕВЬЮ (запись НЕ выполнялась) ===');
console.log('создать/создано:', results.created.length);
results.created.forEach(x => console.log('  +', x));
console.log('пропущено (уже есть карта):', results.skipped_has_card.length, results.skipped_has_card.join(', ') || '');
console.log('пропущено (завершённые):', results.skipped_done.length, results.skipped_done.join(', ') || '');
console.log('ошибки:', results.errors.length); results.errors.forEach(x => console.log('  !', x));
