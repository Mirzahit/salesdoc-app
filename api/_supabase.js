// v350: Тонкий helper для Supabase REST API через fetch.
// SDK @supabase/supabase-js на Node 20 требует WebSocket (для realtime) — он у нас не нужен.
// Поэтому ходим напрямую в PostgREST. Это проще, меньше зависимостей.
//
// Использование:
//   await sbSelect('operators', { order: 'name' });
//   await sbInsert('clients', { client_id: 'SD-2026-1', company_name: 'Roko' });
//   await sbUpdate('kanban_cards', { id: 'eq.xxx' }, { stage: 'Активация' });
//   await sbDelete('checklist_items', { card_id: 'eq.xxx' });

const URL_BASE = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SECRET_KEY;

function headers(extra) {
  return Object.assign({
    'apikey': KEY,
    'Authorization': 'Bearer ' + KEY,
    'Content-Type': 'application/json',
    'Accept': 'application/json'
  }, extra || {});
}

function checkEnv() {
  if (!URL_BASE || !KEY) {
    throw new Error('SUPABASE_URL или SUPABASE_SECRET_KEY не настроены в env');
  }
}

// SELECT: sbSelect('operators', { 'role': 'eq.integrator', order: 'name', limit: 10 })
export async function sbSelect(table, params) {
  checkEnv();
  const qs = new URLSearchParams();
  qs.set('select', (params && params.select) || '*');
  if (params) {
    Object.keys(params).forEach(k => {
      if (k === 'select') return;
      qs.set(k, params[k]);
    });
  }
  const url = `${URL_BASE}/rest/v1/${table}?${qs.toString()}`;
  const r = await fetch(url, { method: 'GET', headers: headers() });
  const text = await r.text();
  if (!r.ok) throw new Error(`SELECT ${table} failed [${r.status}]: ${text}`);
  return text ? JSON.parse(text) : [];
}

// INSERT: sbInsert('clients', { client_id: 'SD-1', company_name: 'X' }) или массив
export async function sbInsert(table, rowOrRows) {
  checkEnv();
  const body = Array.isArray(rowOrRows) ? rowOrRows : [rowOrRows];
  const r = await fetch(`${URL_BASE}/rest/v1/${table}`, {
    method: 'POST',
    headers: headers({ 'Prefer': 'return=representation' }),
    body: JSON.stringify(body)
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`INSERT ${table} failed [${r.status}]: ${text}`);
  return text ? JSON.parse(text) : [];
}

// UPSERT: то же что INSERT но с on-conflict
export async function sbUpsert(table, rowOrRows, onConflict) {
  checkEnv();
  const body = Array.isArray(rowOrRows) ? rowOrRows : [rowOrRows];
  const qs = onConflict ? `?on_conflict=${encodeURIComponent(onConflict)}` : '';
  const r = await fetch(`${URL_BASE}/rest/v1/${table}${qs}`, {
    method: 'POST',
    headers: headers({ 'Prefer': 'resolution=merge-duplicates,return=representation' }),
    body: JSON.stringify(body)
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`UPSERT ${table} failed [${r.status}]: ${text}`);
  return text ? JSON.parse(text) : [];
}

// v813: INSERT c игнором дублей по уникальному индексу — возвращает ТОЛЬКО реально вставленные
// строки (дубли молча отбрасываются). Нужен для идемпотентных уведомлений: по вставленным шлём
// Telegram, по отброшенным — нет. sbUpsert не подходит: merge перезаписал бы и вернул все.
export async function sbInsertIgnoreDup(table, rowOrRows, onConflict) {
  checkEnv();
  const body = Array.isArray(rowOrRows) ? rowOrRows : [rowOrRows];
  if (!body.length) return [];
  const qs = onConflict ? `?on_conflict=${encodeURIComponent(onConflict)}` : '';
  const r = await fetch(`${URL_BASE}/rest/v1/${table}${qs}`, {
    method: 'POST',
    headers: headers({ 'Prefer': 'resolution=ignore-duplicates,return=representation' }),
    body: JSON.stringify(body)
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`INSERT-IGNORE ${table} failed [${r.status}]: ${text}`);
  return text ? JSON.parse(text) : [];
}

// UPDATE: sbUpdate('kanban_cards', { id: 'eq.xxx' }, { stage: 'Активация' })
export async function sbUpdate(table, filterParams, patch) {
  checkEnv();
  const qs = new URLSearchParams();
  Object.keys(filterParams || {}).forEach(k => qs.set(k, filterParams[k]));
  const r = await fetch(`${URL_BASE}/rest/v1/${table}?${qs.toString()}`, {
    method: 'PATCH',
    headers: headers({ 'Prefer': 'return=representation' }),
    body: JSON.stringify(patch)
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`UPDATE ${table} failed [${r.status}]: ${text}`);
  return text ? JSON.parse(text) : [];
}

// DELETE: sbDelete('checklist_items', { card_id: 'eq.xxx' })
export async function sbDelete(table, filterParams) {
  checkEnv();
  const qs = new URLSearchParams();
  Object.keys(filterParams || {}).forEach(k => qs.set(k, filterParams[k]));
  const r = await fetch(`${URL_BASE}/rest/v1/${table}?${qs.toString()}`, {
    method: 'DELETE',
    headers: headers({ 'Prefer': 'return=representation' })
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`DELETE ${table} failed [${r.status}]: ${text}`);
  return text ? JSON.parse(text) : [];
}
