// v850: единый справочник операторов поддержки.
// Underscore-файл — НЕ деплоится как отдельная serverless-функция (лимит функций Vercel).
//
// Зачем: список операторов был зашит прямо в код (TICKET_OPERATORS в cards.js:
// 'Айдос','Акбар','Самат','Нурай'). Из-за этого сервер отвечал 400 на любого другого
// человека, а Кыргызстан (Malika, Eliza) не мог пользоваться разделом вообще —
// его операторов просто нельзя было назначить на обращение.
//
// Отдельная сложность: сотрудники в базе записаны латиницей (Samat), а в старых
// обращениях operator лежит кириллицей (Самат). Поэтому имя всегда прогоняем через
// canonOperator — она приводит к тому виду, как человек записан в «Сотрудниках».

import { sbSelect } from './_supabase.js';

// Кто может быть ответственным по обращению. rop/head/admin — чтобы руководитель
// и директор могли взять обращение на себя.
const SUPPORT_ROLES = ['operator', 'rop', 'head', 'admin'];

// Кириллическое написание → первое слово имени сотрудника в employees (латиница).
// Нужно только для старых записей; новые пишутся уже каноническим именем.
const NAME_ALIASES = {
  'айдос': 'aidos', 'акбар': 'akbar', 'самат': 'samat', 'нурай': 'nuray',
  'малика': 'malika', 'элиза': 'eliza', 'мирзахит': 'mirzahit', 'арслан': 'arslan'
};

let _cache = null;
let _cacheAt = 0;
const CACHE_TTL_MS = 60 * 1000;

async function _employees() {
  const now = Date.now();
  if (_cache && (now - _cacheAt) < CACHE_TTL_MS) return _cache;
  _cache = await sbSelect('employees', { select: 'name,email,role,country,active' });
  _cacheAt = now;
  return _cache;
}

function _first(s) { return String(s || '').trim().split(/\s+/)[0].toLowerCase(); }

// Операторы поддержки страны. Сотрудник с пустой страной (например директор)
// доступен в обеих странах.
export async function supportOperators(country) {
  const rows = await _employees();
  const c = String(country || '').trim().toUpperCase();
  return rows.filter(function (e) {
    if (e.active === false) return false;
    if (!SUPPORT_ROLES.includes(String(e.role || '').toLowerCase())) return false;
    const ec = String(e.country || '').trim().toUpperCase();
    return !c || !ec || ec === c;
  });
}

export async function operatorNames(country) {
  return (await supportOperators(country)).map(function (e) { return e.name; }).filter(Boolean);
}

// Любое написание имени → имя как в «Сотрудниках», либо null если такого оператора нет.
export async function canonOperator(name, country) {
  const raw = String(name || '').trim();
  if (!raw) return null;
  const ops = await supportOperators(country);
  const low = raw.toLowerCase();
  const first = _first(raw);

  const exact = ops.find(function (e) { return String(e.name || '').trim().toLowerCase() === low; });
  if (exact) return exact.name;

  const byEmail = ops.find(function (e) { return String(e.email || '').trim().toLowerCase() === low; });
  if (byEmail) return byEmail.name;

  const byFirst = ops.find(function (e) { return _first(e.name) === first; });
  if (byFirst) return byFirst.name;

  const alias = NAME_ALIASES[first];
  if (alias) {
    const byAlias = ops.find(function (e) {
      return _first(e.name) === alias || String(e.email || '').toLowerCase().indexOf(alias + '@') === 0;
    });
    if (byAlias) return byAlias.name;
  }
  return null;
}

export async function isSupportOperator(name, country) {
  return !!(await canonOperator(name, country));
}
