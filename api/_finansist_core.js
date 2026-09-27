// v1006 «Финансист»: общее ядро расчётов для страницы (/api/finansist), агента (/api/finansist-agent)
// и ночного обхода (/api/cron-finansist). Одни и те же функции — одни и те же цифры в чате и на экране.
//
// Данные: payments/clients/employees из Supabase (только чтение), расходы — из Google-таблицы KG через
// Apps Script со снимком в finansist_expenses_cache (Apps Script отвечает 10–20 с), плюс суммы, внесённые
// бухгалтером в finansist_missing_data (status='filled'). Страна всегда KG.
//
// Правила расхождений («не тот счёт», «возможный дубль»): см. комментарии в findDisputes. Зарплата: isSalary/SALARY_RULES —
// зеркало функций fzIsSalary/FZ_SALARY_RULES в index.html, править синхронно.

import { sbSelect, sbSelectAll, sbUpsert, sbUpdate, sbDelete, sbInsert } from './_supabase.js';

export const COUNTRY = 'KG';
export const CURRENCY = 'сом';
export const SERVICE_CATS = ['implementation', 'integration', 'revision'];
export const LICENSE_CATS = ['subscription', 'license', 'extra'];
export const BANK_RULE_FROM = '2026-01-01';
export const DUP_WINDOW_DAYS = 3;
export const CAT_RU = { implementation: 'Внедрение', integration: 'Интеграция', subscription: 'Абонплата', license: 'Новый клиент', revision: 'Доработка', extra: 'Доп. лицензии', other: 'Прочее' };
export const BANK_LABELS = { license: 'М-банк лицензии', services: 'М-банк услуги', cash: 'Наличные', other: 'Другие счета', none: 'Счёт не указан' };
export const MONTHS_RU = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
export const MONTHS_RU_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

// Таблица расходов KG (та же, что читает фронт через /api/sheets) — листы по месяцам без года.
const EXP_SHEET_ID = '1wJaSorA_jLG7YJJaTT2XXV6j5SSjufutVFOuKsK1tdY';
const GS_URL = 'https://script.google.com/macros/s/AKfycbwwNL4CxOrSo4wXT3qci_dSSqi5tABLPUqHQPv2nWrn_WQhZsaOpfnwdygaqskzuHphvg/exec';

// ---------- даты ----------
export function pad2(n) { return String(n).padStart(2, '0'); }
// «Сегодня» по Бишкеку (UTC+6, перевода часов нет). Не путать с almatyIso (UTC+5) — у KG свой пояс.
export function bishkekIso(ms) { return new Date((ms || Date.now()) + 6 * 3600 * 1000).toISOString().slice(0, 10); }
export function bishkekNow() { return new Date(Date.now() + 6 * 3600 * 1000); }
export function parseMonth(s) {
  const m = String(s || '').match(/^(\d{4})-(\d{2})$/);
  if (!m) return null;
  const y = +m[1], mo = +m[2];
  if (mo < 1 || mo > 12) return null;
  return { y, mo };
}
export function monthRange(y, mo) {
  const from = y + '-' + pad2(mo) + '-01';
  const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return { from, to: y + '-' + pad2(mo) + '-' + pad2(last), key: y + '-' + pad2(mo) };
}
export function monthKeyToRange(key) { const m = parseMonth(key); return m ? monthRange(m.y, m.mo) : null; }
export function shiftMonth(y, mo, k) { const d = new Date(Date.UTC(y, mo - 1 + k, 1)); return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1 }; }
export function shiftMonthKey(key, k) { const m = parseMonth(key); const s = shiftMonth(m.y, m.mo, k); return s.y + '-' + pad2(s.mo); }
export function currentMonthKey() { return bishkekIso().slice(0, 7); }
export function dayOf(iso) { return parseInt(String(iso || '').slice(8, 10), 10) || 0; }
export function daysBetween(a, b) { return Math.round((Date.parse(b) - Date.parse(a)) / 86400000); }
export function addDays(iso, k) { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + k); return d.toISOString().slice(0, 10); }
export function fmtDay(iso) { return iso ? dayOf(iso) + ' ' + MONTHS_RU_GEN[parseInt(iso.slice(5, 7), 10) - 1] : '—'; }
export function monthLabel(key) { const m = parseMonth(key); return m ? MONTHS_RU[m.mo - 1].toLowerCase() + ' ' + m.y : key; }
export function num(v) { const n = parseFloat(v); return isNaN(n) ? 0 : n; }
export function round(n) { return Math.round(+n || 0); }
export function normName(s) { return String(s || '').toLowerCase().replace(/[«»"',.()]/g, ' ').replace(/\s+/g, ' ').trim(); }

// Поле bank менеджер заполняет руками: «М Бизнес», «МБизнес», «Мбизнес Услуги», «МБизнес Усл», «РСК», «Касса …», «M-Bank».
export function bankKey(bank) {
  const s = String(bank || '').toLowerCase().replace(/\s+/g, '');
  if (!s) return 'none';
  if (/усл/.test(s)) return 'services';
  if (/мбизнес|м-?банк|m-?bank|mbusiness/.test(s)) return 'license';
  if (/касса|налич/.test(s)) return 'cash';
  return 'other';
}

// ---------- зарплата (зеркало index.html: fzPersonWord / fzNameKey / fzIsSalary / FZ_SALARY_RULES) ----------
export const NAME_ALIAS = { malika: 'малика', eliza: 'элиза', mirzahit: 'мирзахит', gulshan: 'гульшан', aselya: 'аселя', amir: 'амир' };
export const SALARY_RULES = [
  { person: 'Гульшан', category: /^услуг/i, note: /гульшан/i, cat_label: 'Услуги', note_label: 'в примечании «Гульшан»' },
];
export function personWord(s) { const ws = String(s || '').trim().split(/[\s,.(]+/).filter(Boolean); let i = 0; while (i < ws.length - 1 && /^(аванс|авансом|зп|зарплата|премия|бонус|бонусы|отпускные|расчет|расчёт|за|для|ост|остаток|отраб[а-яё]*)$/i.test(ws[i]) || (i < ws.length - 1 && namedMonthOf(ws[i]))) i++; return ws[i] || ''; }
export function nameKey(s) { let w = personWord(s).toLowerCase(); w = NAME_ALIAS[w] || w; return w.slice(0, 4); }
export function salaryRule(e) { const c = String((e && e.category) || '').trim(), n = String((e && e.note) || '').trim(); return SALARY_RULES.find(r => r.category.test(c) && r.note.test(n)) || null; }
export function isSalary(e) { const c = String((e && e.category) || '').trim().toLowerCase(); return c === 'зп' || /^зп[\s./-]|зарплат|оклад|аванс|бонус|премия|отпускн/.test(c) || !!salaryRule(e); }
export function isTransfer(e) { return /перенос/i.test(String((e && e.category) || '')); }

// ---------- зарплата по месяцу работы (CEO 27.09.2026) ----------
// Аванс дают 20–27 числа месяца, за который работали → месяц даты. Остаток дают ~10 числа следующего месяца →
// строка до 15 числа относится к прошлому месяцу, после 15-го — к текущему. Если в примечании назван месяц
// («июль», «расчет за июнь») — он главный. Изъятие владельца и все прочие строки — по дате выплаты.
// Сотрудники — ИП: сумма на руки и есть полный расход компании по человеку.
const MONTH_STEMS = ['янв', 'фев', 'мар', 'апр', 'ма[йя]', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
// «февр», «ост за февр», «июль», «марта»; длинные слова («маркетинг», «декларация») — не месяцы
export function namedMonthOf(word) { const w = String(word || '').toLowerCase(); if (w.length > 8) return 0; for (let i = 0; i < 12; i++) if (new RegExp('^' + MONTH_STEMS[i] + '[а-яё]*$').test(w)) return i + 1; return 0; }
export function namedMonth(note) { const ws = String(note || '').toLowerCase().split(/[^а-яё]+/).filter(Boolean); for (const w of ws) { const m = namedMonthOf(w); if (m) return m; } return 0; }
export function salaryPart(e) {
  const t = (String(e.category || '') + ' ' + String(e.note || '')).toLowerCase();
  if (/бонус|преми/.test(t)) return 'bonus';
  if (/отпускн/.test(t)) return 'leave';
  if (/аванс/.test(t) && !/за\s*выч/.test(t)) return 'advance';
  return 'rest';
}
export function payMonthOf(e) { const d = String(e.date || ''); return /^\d{4}-\d{2}/.test(d) ? d.slice(0, 7) : String(e.sheet_month || ''); } // по дате выплаты; лист может быть не тот (аванс Элизы 27.09 в листе августа)
export function workMonthOf(e, kind) {
  const pm = payMonthOf(e);
  if (kind === 'owner') return payMonthOf(e); // изъятие — когда забрал
  if (kind !== 'salary' && kind !== 'group') return String(e.sheet_month || payMonthOf(e)); // прочие расходы — месяц листа, как ведёт Гульшан (таргет 31.05 в листе июня = июнь)
  const nm = namedMonth(e.note);
  if (nm) { const base = parseMonth(pm) || parseMonth(payMonthOf(e)); let y = base.y; if (nm > base.mo) y -= 1; return y + '-' + pad2(nm); }
  if (salaryPart(e) === 'advance') {
    // Аванс на листе месяца M с датой месяца M+1 — скорее опечатка в дате (Элиза: «Аванс» 27.09 на листе августа, остаток за август
    // «за вычетом аванса» есть, аванса в августе нет). Пока Гульшан не ответила — аванс за месяц листа (CEO 27.09.2026).
    if (e.source === 'sheet' && e.sheet_month && pm === shiftMonthKey(e.sheet_month, 1)) { const ov = (currentRules().advance_month || {})[advanceRowKey(e)]; return ov || e.sheet_month; }
    return pm;
  }
  return dayOf(e.date) <= 15 ? shiftMonthKey(pm, -1) : pm;
}
export function advanceRowKey(e) { return String(e.sheet_month) + ':' + String(e.date || '').slice(0, 10) + ':' + round(e.amount) + ':' + nameKey(e.note); }
export function isAdvanceDateSuspect(e) { return e && e.source === 'sheet' && e.kind === 'salary' && e.part === 'advance' && !namedMonth(e.note) && e.sheet_month && payMonthOf(e) === shiftMonthKey(e.sheet_month, 1); }
export const SALARY_PAID_BY_DAY = 15; // до этого числа следующего месяца остаток за месяц ещё может быть не выплачен

// ---------- настройки правил (app_settings.finansist_rules; правятся на «Правилах и целях») ----------
// Значения по умолчанию — только стартовые, до первого сохранения на странице (CEO 27.09.2026).
// Отделы (CEO 27.09.2026): общие расходы делятся по отделам, не по людям. Продажи — прямые расходы (amo, телефония и АТС
// Билайн, WhatsApp, реклама) и доля офиса/аренды/воды; Поддержка — доля офиса/аренды/воды; Интеграция — только зарплата
// (работают удалённо из Казахстана); Администрация — Гульшан, Жибек и юрист, ничего не распределяется. Доля офиса делится
// между отделами с отметкой pool пропорционально числу людей. Налоги, банк и прочее общее — отдельной строкой.
// Выручка: внедрение и интеграция — Интеграции, остальная — Продажам. Меняется на «Правилах и целях» (finansist_rules.departments).
export const DEPT_DEFAULTS = [
  { key: 'sales', name: 'Продажи', people: ['амир', 'асел', 'айби'], groups: [], items: ['amo', 'telephony', 'whatsapp', 'ads', 'mobile_sales'], pool: true, revenue: ['rest'] },
  { key: 'support', name: 'Поддержка', people: ['мали', 'элиз'], groups: [], items: [], pool: true, revenue: [] },
  { key: 'integration', name: 'Интеграция', people: [], groups: ['Интеграция'], items: [], pool: false, revenue: ['services'] },
  { key: 'admin', name: 'Администрация', people: ['гуль', 'жибе'], groups: [], items: ['lawyer'], pool: false, revenue: [] },
];
// Что можно отнести на отдел напрямую, и что составляет общую долю офиса
export const ALLOC_ITEMS = [
  { key: 'amo', label: 'amoCRM' }, { key: 'telephony', label: 'Телефония и АТС Билайн' }, { key: 'whatsapp', label: 'WhatsApp' },
  { key: 'ads', label: 'Реклама и таргет' }, { key: 'mobile_sales', label: 'Мобильная связь менеджеров' }, { key: 'lawyer', label: 'Юрист' },
];
// Состав отделов меняется с даты (CEO 27.09.2026): прошлые месяцы считаются по своему составу. finansist_rules.departments_history —
// [{ from: 'YYYY-MM', departments }]; для месяца берётся последняя версия с from ≤ месяца, раньше первой — состав по умолчанию.
export function deptVersionFor(monthKey) {
  const R = currentRules(); let hist = Array.isArray(R.departments_history) ? R.departments_history.slice() : [];
  if (!hist.length && Array.isArray(R.departments) && R.departments !== DEPT_DEFAULTS) hist = [{ from: '2000-01', departments: R.departments }]; // сохранено до v1009 без даты
  hist.sort((a, b) => String(a.from).localeCompare(String(b.from)));
  let v = null; hist.forEach(h => { if (String(h.from) <= String(monthKey)) v = h; });
  return v ? { from: v.from, departments: v.departments, custom: true } : { from: null, departments: DEPT_DEFAULTS, custom: false };
}
export const POOL_ITEMS = [{ key: 'rent', label: 'Аренда' }, { key: 'office', label: 'Офис' }, { key: 'water', label: 'Вода' }];
export const DEPT_REVENUE = [{ key: 'services', label: 'Внедрение и интеграция', cats: ['implementation', 'integration'] }, { key: 'rest', label: 'Остальная выручка', cats: null }];
export const RULE_DEFAULTS = { integrators_kzt: 1500000, integrators_tolerance_pct: 3, safe_balance: null, owner_names: ['Мирзахит'], departments: DEPT_DEFAULTS };
// Принятые решения по «Прочему» с именем владельца (CEO 27.09.2026): июль 2026 — мебель и обои «для дома Мирзахита»
// 199 500 и «Мирзахит подотчет» 100 000 — изъятие владельца. Действуют и для похожих строк; ответ в настройках их перекрывает.
export const OWNER_OTHER_DECIDED = { 'для дома': 'owner', 'подотчет': 'owner' };
let _rules = null, _rulesTs = 0;
export function currentRules() { return _rules || Object.assign({}, RULE_DEFAULTS, { owner_other: Object.assign({}, OWNER_OTHER_DECIDED) }); }
export async function loadRules(force) {
  if (!force && _rules && Date.now() - _rulesTs < 60e3) return _rules;
  let v = {};
  try { const r = await sbSelect('app_settings', { key: 'eq.finansist_rules', limit: '1' }); v = (r[0] && r[0].value) || {}; } catch (_) {}
  _rules = Object.assign({}, RULE_DEFAULTS, v, { owner_other: Object.assign({}, OWNER_OTHER_DECIDED, v.owner_other || {}) }); _rulesTs = Date.now();
  return _rules;
}
export async function saveRules(patch) {
  const cur = await loadRules(true);
  const next = Object.assign({}, cur, patch);
  await sbUpsert('app_settings', { key: 'finansist_rules', value: next, updated_at: new Date().toISOString() }, 'key');
  _rules = next; _rulesTs = Date.now();
  return next;
}

// Группы команды: расходы на отдел целиком, а не на человека (CEO 27.09.2026: зарплата интеграторов в КЗ,
// платит кыргызская компания — это расход KG, связанный с выручкой по внедрению и интеграции).
// До августа 2026 интеграторам платили из Казахстана (CEO 27.09.2026): статья «Интеграция» в KG начинается с августа.
export const INTEGRATORS_PAID_FROM_KG_SINCE = '2026-08';
export const GROUP_RULES = [
  { group: 'Интеграция', category: /^услуг/i, note: /интегратор/i, revenue_cats: ['implementation', 'integration'], how: 'статья «Услуги», в примечании «интеграторам»' },
];
// Отдельные статьи внутри общих расходов. Юрист — внешний подрядчик, не сотрудник: сопоставляем по статье
// и слову «юрист», а не по имени (у сотрудницы Жибек и юриста одно имя).
export const SHARED_LABEL_RULES = [
  { label: 'Юрист, аутсорс', category: /^услуг/i, note: /юрист/i, how: 'статья «Услуги», в примечании слово «юрист»' },
];
export function groupRule(e) { const c = String((e && e.category) || '').trim(), n = String((e && e.note) || '').trim(); return GROUP_RULES.find(r => r.category.test(c) && r.note.test(n)) || null; }
export function sharedLabelRule(e) { const c = String((e && e.category) || '').trim(), n = String((e && e.note) || '').trim(); return SHARED_LABEL_RULES.find(r => r.category.test(c) && r.note.test(n)) || null; }
// Налоги компании (CEO 27.09.2026): официально оформлен только владелец, остальные ИП — налоги отдельной статьёй
// в общих расходах, к людям не привязываются. Вид — по примечанию; пеня — всегда вопрос.
export function taxKind(note) {
  const n = String(note || '').toLowerCase();
  if (/пен[яи]/.test(n)) return 'Пеня';
  if (/подоход/.test(n)) return 'Подоходный';
  if (/стр?[ао]х/.test(n)) return 'Страховые'; // «Страховые», опечатка «Стаховые»
  if (/гнпф/.test(n)) return 'ГНПФ';
  if (/единый/.test(n)) return 'Единый';
  return 'Прочие налоги';
}
export function isTax(e) { return /^налог/i.test(String((e && e.category) || '').trim()); }
// Статья «Прочее» с именем владельца (июль 2026: «мебель для дома Мирзахита», «Мирзахит подотчет»): НЕ изъятие
// автоматически (CEO 27.09.2026, вечер). Пока нет ответа — расход компании и вопрос «изъятие или расход?». Ответ
// хранится в app_settings.finansist_rules.owner_other { ключ похожести: 'owner' | 'company' } и применяется к похожим строкам.
export function isOwnerOtherCandidate(e) {
  if (!/^прочее$/i.test(String((e && e.category) || '').trim())) return false;
  const n = String((e && e.note) || '').toLowerCase();
  return (currentRules().owner_names || []).some(x => { const k = String(x || '').trim().toLowerCase(); return k.length >= 4 && n.indexOf(k) >= 0; });
}
// Ключ похожести: «для дома» (мебель, обои, посуда для дома), «подотчет», иначе текст без имени и цифр.
export function ownerOtherKey(e) {
  let n = String((e && e.note) || '').toLowerCase();
  (currentRules().owner_names || []).forEach(x => { const k = String(x || '').trim().toLowerCase(); if (k.length >= 4) n = n.split(k).join(' '); });
  n = n.replace(/[0-9.,$«»"'()]+/g, ' ').replace(/(^|\s)[а-яё]{1,2}(?=\s|$)/g, ' ').replace(/\s+/g, ' ').trim();
  if (/для\s+дома/.test(n)) return 'для дома';
  if (/подотч/.test(n)) return 'подотчет';
  return n.slice(0, 40) || 'прочее';
}
export function isOwnerName(name) { const k = nameKey(name); return !!k && (currentRules().owner_names || []).some(n => nameKey(n) === k); }
// Изъятие владельца: строка, похожая на зарплату, с именем владельца. Это не расход компании.
export function isOwnerDraw(e) { return isOwnerDrawMarked(e) || (isSalary(e) && !sharedLabelRule(e) && isOwnerName(e.note)); }
// Пометка «изъятие» в примечании (договорённость CEO с Гульшан 27.09.2026): деньги владельца, выданные через другого человека
// (транзит). Строка — изъятие владельца, на чьё бы имя ни была оформлена; в зарплату, команду и сверку с окладом не идёт.
export function isOwnerDrawMarked(e) { return /из[ъь]?ят/i.test(String((e && e.note) || '')); }
// Вид строки расходов: transfer | shared | salary | group | owner
export function classifyExpense(e) {
  if (e && e.source === 'expected' && e.expected_class) return e.expected_class; // ожидаемая зарплата — строка программы, не таблицы
  if (isTransfer(e)) return { kind: 'transfer' };
  if (isOwnerDrawMarked(e)) return { kind: 'owner', marked: true }; // «изъятие» в примечании — изъятие владельца, имя не важно
  if (isOwnerOtherCandidate(e)) { const key = ownerOtherKey(e); const d = (currentRules().owner_other || {})[key]; if (d === 'owner') return { kind: 'owner', owner_other: key }; return { kind: 'shared', label: String(e.category || 'Прочее').trim(), owner_other: key, owner_decided: d || null }; }
  if (isTax(e)) return { kind: 'shared', label: 'Налоги', tax_kind: taxKind(e.note) };
  const lab = sharedLabelRule(e); if (lab) return { kind: 'shared', label: lab.label };
  const g = groupRule(e); if (g) return { kind: 'group', group: g.group };
  if (isSalary(e)) { if (isOwnerName(e.note)) return { kind: 'owner' }; const r = salaryRule(e); return r ? { kind: 'salary', person_key: nameKey(r.person), person: r.person } : { kind: 'salary', person_key: nameKey(e.note), person: personWord(e.note) }; }
  return { kind: 'shared', label: String(e.category || 'Прочее').trim() };
}

// ---------- обязательные статьи месяца (что должно быть в расходах каждый месяц) ----------
// Сопоставление со строками таблицы: по статье (category) и/или примечанию (note). Показано на «Правилах и целях».
export const EXPECTED_ITEMS = [
  { key: 'rent', label: 'Аренда и коммуналка', category: /аренд|коммунал/i, note: /аренд|коммунал|технопарк/i, how: 'статья «Аренда» или примечание с «аренда», «коммуналка», «Технопарк»' }, // «офис»/«склад» нарочно нет: ловили мебель («Пуфик в офис»)
  { key: 'amo', label: 'amoCRM', category: /amo|амо/i, note: /\bamo|амо\s*срм|амосрм|amocrm/i, not_monthly: true, how: 'примечание с «amo», «амо», «amoCRM»; платится вперёд за несколько месяцев — пропуск не ищем, срок ведётся в «Предоплаченных расходах»' },
  { key: 'ads', label: 'Реклама и таргет', category: /реклам|таргет|маркет/i, note: /таргет|реклам|facebook|фейсбук|meta|инстаграм|instagram/i, how: 'статья «Реклама/Таргет» или примечание с «таргет», «реклама», «Facebook», «Instagram»' },
  { key: 'telephony', label: 'Виртуальная телефония', category: /телефони/i, note: /телефони|onlinepbx|pbx|sipuni|zadarma|билайн|beeline|(^|[^а-яё])атс([^а-яё]|$)/i, how: 'примечание с «телефония», «АТС», «Билайн» (счёт за АТС), «PBX», «Sipuni», «Zadarma»' }, // \b в JS не знает кириллицу — границы слова вручную
  { key: 'whatsapp', label: 'Платный WhatsApp', category: /whatsapp|ватсап|ваззап|wazzup/i, note: /whatsapp|ватсап|ваззап|wazzup/i, how: 'примечание с «WhatsApp», «Ватсап», «Wazzup»' },
  { key: 'water', label: 'Вода', category: /^вод[аы]?$/i, note: /(^|[^а-яё])вод[аыу]([^а-яё]|$)|кулер/i, not_monthly: true, track_last: true, max_gap_months: 2, how: 'статья «Вода» или примечание с «вода», «кулер» (например «Офис / Алтын Булак вода»); покупают не каждый месяц — показываем последнюю покупку, вопрос, если больше 2 месяцев без строки' },
  { key: 'taxi', label: 'Такси', category: /такси/i, note: /такси|яндекс/i, no_odd: true, how: 'статья «Такси» или примечание с «такси», «Яндекс»; сумма не сравнивается — такси каждый месяц разное' },
  { key: 'sim', label: 'Сим-карты и связь', category: /связ|сим/i, note: /сим|\bsim\b|мегаком|megacom|\bo!\b|nur\s*telecom|мобильн/i, exclude: /атс|телефони|билайн|beeline/i, how: 'статья «Связь» или примечание с «сим», «Мегаком», «O!», «мобильный», кроме АТС и Билайна (они — телефония)' },
];
export const ODD_THRESHOLD = 0.4; // отклонение от медианы прошлых месяцев больше 40% — «сумма резко отличается»

export function itemMatches(item, e) {
  if (!e || isTransfer(e) || isSalary(e) || groupRule(e)) return false;
  const c = String(e.category || ''), n = String(e.note || '');
  if (item.exclude && (item.exclude.test(n) || item.exclude.test(c))) return false;
  return item.category.test(c) || item.note.test(n);
}

// ---------- база: оплаты, клиенты, сотрудники (кэш 60 с на инстанс — чат дёргает инструменты подряд) ----------
let _base = null, _baseTs = 0;
export async function loadBase(force) {
  if (!force && _base && Date.now() - _baseTs < 60e3) return _base;
  const [payments, clients, employees] = await Promise.all([
    sbSelectAll('payments', { country: 'eq.' + COUNTRY, select: 'id,paid_at,company_name,client_id,category,category_raw,amount,qty,price,period_months,bank,manager_name,source,created_by,created_at,comment,receipt_path,sheet_tab,sheet_row,sheet_missing_at', order: 'paid_at.desc,id' }),
    sbSelectAll('clients', { country: 'eq.' + COUNTRY, select: 'client_id,company_name,city,status,next_billing_at,access_until,access_status,pay_reason,pay_reason_note,pay_reason_at,churned_at,subscription_period_months,support_operator,curator_operator,first_payment_date,last_payment_date', order: 'client_id' }),
    sbSelect('employees', { active: 'eq.true', select: 'name,pos,role,country,email', order: 'name', limit: '200' }),
  ]);
  _base = { payments, clients, employees: employees.filter(e => !e.country || e.country === COUNTRY) };
  _baseTs = Date.now();
  return _base;
}

// ---------- расходы: Google-таблица → снимок в finansist_expenses_cache → строки месяца ----------
function _gsToken() { const t = (process.env.SHEETS_TOKEN || '').trim(); return t ? '&token=' + encodeURIComponent(t) : ''; }
function _parseSheetDate(v) {
  if (v == null || v === '' || v === 0) return null;
  if (typeof v === 'number') { const d = new Date(Math.round((v - 25569) * 86400 * 1000)); return isNaN(d) ? null : d.toISOString().slice(0, 10); }
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/); if (m) return m[1] + '-' + m[2] + '-' + m[3];
  m = s.match(/^(\d{1,2})[.\/](\d{1,2})[.\/](\d{4})/); if (m) return m[3] + '-' + pad2(m[2]) + '-' + pad2(m[1]);
  m = s.match(/Date\((\d+),(\d+),(\d+)\)/); if (m) return m[1] + '-' + pad2(parseInt(m[2], 10) + 1) + '-' + pad2(m[3]);
  const d = new Date(s); return isNaN(d) ? null : d.toISOString().slice(0, 10);
}
async function _fetchExpenseSheet(tabName) {
  const tryOnce = async (name) => {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 28000);
    try {
      const r = await fetch(GS_URL + '?action=getSheet&sheet=' + encodeURIComponent(name) + '&spreadsheetId=' + EXP_SHEET_ID + '&range=A1:E1000' + _gsToken(), { signal: ctl.signal });
      if (!r.ok) throw new Error('Sheets ' + r.status);
      const j = await r.json();
      if (j.error) throw new Error('Sheets: ' + j.error);
      return j;
    } finally { clearTimeout(t); }
  };
  try { return await tryOnce(tabName); }
  catch (e) {
    if (!/Sheet not found/i.test(String(e && e.message || e))) throw e;
    return await tryOnce(tabName.toLowerCase());
  }
}
function _parseExpenseRows(json, monthKey) {
  const rows = (json && json.rows) || [];
  let headerIdx = -1;
  for (let i = 0; i < rows.length; i++) if (rows[i] && String(rows[i][0] || '').toLowerCase() === 'дата') { headerIdx = i; break; }
  const out = [];
  rows.slice(headerIdx >= 0 ? headerIdx + 1 : 1).forEach((row, i) => {
    if (!row || !row[0] || !row[3]) return;
    const amount = typeof row[3] === 'number' ? row[3] : parseFloat(String(row[3]).replace(/[^0-9.,-]/g, '').replace(',', '.'));
    if (!amount || amount <= 0) return;
    const date = _parseSheetDate(row[0]) || (monthKey + '-01');
    out.push({ id: monthKey + ':' + i, date, category: String(row[1] || 'Прочее').trim(), note: String(row[2] || '').trim(), amount, bank: String(row[4] || '').trim(), source: 'sheet', sheet_month: monthKey });
  });
  // дедуп как на фронте
  const seen = new Set();
  return out.filter(e => { const k = e.date + '|' + e.category + '|' + e.amount + '|' + e.note + '|' + e.bank; if (seen.has(k)) return false; seen.add(k); return true; });
}
// Снимок месяца: свежий (1 ч для текущего месяца, сутки для прошлых) — из кэша, иначе из таблицы.
// Таблица ведётся по текущему году: другие годы — «нет данных» (available:false).
export async function loadExpenseMonth(monthKey, opts) {
  opts = opts || {};
  const m = parseMonth(monthKey);
  const nowKey = currentMonthKey();
  if (!m || m.y !== +nowKey.slice(0, 4)) return { month: monthKey, rows: [], available: false, fetched_at: null };
  const ttl = monthKey === nowKey ? 3600e3 : 86400e3;
  let cached = null;
  try { const c = await sbSelect('finansist_expenses_cache', { month: 'eq.' + monthKey, limit: '1' }); cached = c[0] || null; } catch (_) {}
  if (cached && !opts.force && Date.now() - Date.parse(cached.fetched_at) < ttl) return { month: monthKey, rows: cached.rows || [], available: true, fetched_at: cached.fetched_at, from_cache: true };
  try {
    const json = await _fetchExpenseSheet(MONTHS_RU[m.mo - 1]);
    const rows = _parseExpenseRows(json, monthKey);
    const fetched_at = new Date().toISOString();
    try { await sbUpsert('finansist_expenses_cache', { month: monthKey, rows, fetched_at }, 'month'); } catch (e) { console.error('[finansist] cache write:', e.message); }
    return { month: monthKey, rows, available: true, fetched_at };
  } catch (e) {
    console.error('[finansist] expenses sheet ' + monthKey + ':', e.message);
    if (cached) return { month: monthKey, rows: cached.rows || [], available: true, fetched_at: cached.fetched_at, from_cache: true, stale: true };
    return { month: monthKey, rows: [], available: false, error: e.message };
  }
}
// Ручные суммы бухгалтера (status='filled') — виртуальные строки расходов, чтобы попадали во все расчёты.
export async function loadManualRows(monthKeys) {
  const rows = await sbSelect('finansist_missing_data', { country: 'eq.' + COUNTRY, status: 'eq.filled', limit: '1000' });
  const out = {};
  rows.forEach(r => {
    if (monthKeys && monthKeys.indexOf(r.month) < 0) return;
    (out[r.month] = out[r.month] || []).push({ id: 'manual:' + r.id, date: r.month + '-01', category: r.item_label, note: 'внесено вручную' + (r.filled_by_name ? ' (' + r.filled_by_name + ')' : ''), amount: num(r.amount), bank: '', source: 'manual', item_key: r.item_key });
  });
  return out;
}
// Строки каждого месяца: rows = всё, что относится к месяцу по работе ИЛИ по выплате; у строки есть
// work_month и pay_month. Для прибыли и «Команды» — expenseRows (по работе), для «Счетов» и «Кассы» — cashRows (по выплате).
export async function loadExpenses(monthKeys, opts) {
  const sheetKeys = Array.from(new Set([].concat.apply([], monthKeys.map(k => [shiftMonthKey(k, -1), k, shiftMonthKey(k, 1)])))).filter(k => k <= currentMonthKey()); // листа будущего месяца ещё нет
  const [snaps, manual, prepaid] = await Promise.all([Promise.all(sheetKeys.map(k => loadExpenseMonth(k, opts))), loadManualRows(sheetKeys), loadPrepaid(), loadRules()]);
  const sheets = {};
  snaps.forEach(sn => { sheets[sn.month] = { available: sn.available, fetched_at: sn.fetched_at, stale: !!sn.stale, rows: (sn.rows || []).concat(manual[sn.month] || []) }; });
  applyPrepaid(sheets, prepaid);
  const all = [];
  Object.keys(sheets).forEach(sk => (sheets[sk].rows || []).forEach(r => { const k = classifyExpense(r); const row = Object.assign({}, r, { sheet_month: r.sheet_month || sk }); row.kind = k.kind; row.pay_month = payMonthOf(row); row.work_month = workMonthOf(row, k.kind); if (k.kind === 'salary' || k.kind === 'group') row.part = salaryPart(row); all.push(row); }));
  const byMonth = {};
  monthKeys.forEach(k => {
    const sh = sheets[k] || { available: false };
    byMonth[k] = { available: !!sh.available, fetched_at: sh.fetched_at, stale: !!sh.stale, next_available: !!(sheets[shiftMonthKey(k, 1)] && sheets[shiftMonthKey(k, 1)].available), rows: all.filter(r => r.work_month === k || r.pay_month === k) };
  });
  if (!(opts && opts.no_expected)) { await addExpectedSalary(byMonth, all, monthKeys); await addExpectedTaxes(byMonth, monthKeys); }
  return byMonth;
}

// ---------- ожидаемые налоги (CEO 27.09.2026) ----------
// Налоги платят 20–25 числа того же месяца. Пока за текущий или прошлый месяц нет строки какого-то вида налога
// (подоходный, страховые, ГНПФ, единый), подставляется ожидаемая сумма — среднее этого вида за три прошлых месяца
// (сумма / 3). Пени и доплаты за другие месяцы («остаток от апреля и май») в среднее не берутся — это не налог месяца.
// Как только строка вида налога появляется, ожидаемая по этому виду исчезает.
export const TAX_KINDS_EXPECTED = ['Подоходный', 'Страховые', 'ГНПФ', 'Единый'];
export function isTaxArrears(e, sheetKey) { const n = String((e && e.note) || '').toLowerCase(); if (/остат|долг|задолж/.test(n)) return true; const nm = namedMonth(n); return !!nm && nm !== parseMonth(sheetKey).mo; }
export async function addExpectedTaxes(byMonth, monthKeys) {
  const openFrom = shiftMonthKey(currentMonthKey(), -1);
  for (const k of monthKeys) {
    const m = byMonth[k]; if (!m || !m.available || k < openFrom) continue;
    const have = new Set((m.rows || []).filter(e => e.source !== 'expected' && isTax(e) && (e.work_month || k) === k).map(e => taxKind(e.note)));
    const missing = TAX_KINDS_EXPECTED.filter(t => !have.has(t)); if (!missing.length) continue;
    const prev = [1, 2, 3].map(i => shiftMonthKey(k, -i));
    const snaps = await Promise.all(prev.map(j => loadExpenseMonth(j)));
    if (snaps.some(s => !s || !s.available)) continue; // без полной истории не угадываем
    const sums = {};
    snaps.forEach((s, i) => (s.rows || []).forEach(e => { if (!isTax(e) || isTaxArrears(e, prev[i])) return; const t = taxKind(e.note); if (TAX_KINDS_EXPECTED.indexOf(t) < 0) return; sums[t] = (sums[t] || 0) + num(e.amount); }));
    const label = MONTHS_RU[parseMonth(prev[2]).mo - 1].toLowerCase() + '–' + MONTHS_RU[parseMonth(prev[0]).mo - 1].toLowerCase();
    missing.forEach(t => {
      if (!sums[t]) return; const avg = Math.round(sums[t] / 3);
      m.rows.push({ id: 'expected-tax:' + k + ':' + t, source: 'expected', expected_kind: 'tax', category: 'Налоги', note: t + ' — ожидаемые, среднее за ' + label, amount: avg, date: null, sheet_month: k, work_month: k, pay_month: null, kind: 'shared', expected_name: t, expected_basis: 'среднее за ' + label, expected_total: avg, expected_class: { kind: 'shared', label: 'Налоги', tax_kind: t + ' (ожидаемые)' } });
    });
  }
  return byMonth;
}

// ---------- ожидаемая зарплата, пока месяц не закрыт (CEO 27.09.2026) ----------
// Пока остаток за месяц не выплачен, прибыль без него завышена (сентябрь 1 227 567), а проверка изъятий проходит всегда.
// Поэтому каждому, у кого за месяц ещё нет остатка, добавляется строка «ожидаемая» (source='expected', в «Кассу» и «Счета»
// не попадает): менеджер — итог «Моего дохода», если месяц там закрыт, иначе оклад; оклад в долларах — по последнему
// курсу доллара Нацбанка; оклад в сомах; оклада нет — выплата за прошлый месяц. Уже выплаченное (аванс) вычитается.
// Интеграторам (с августа 2026) — сумма в тенге по последнему курсу. Как только придёт остаток — строка исчезает сама.
export async function addExpectedSalary(byMonth, all, monthKeys) {
  const R = currentRules(); const today = bishkekIso();
  let calc = null, rates = null, base = null;
  for (const k of monthKeys) {
    const m = byMonth[k]; if (!m || !m.available) continue;
    const ss = salaryState(byMonth, k); if (!ss.pending) continue;
    if (!calc) [calc, rates, base] = await Promise.all([loadSalaryCalc(), loadFxRates(), loadBase()]);
    const prevK = shiftMonthKey(k, -1);
    const people = {};
    all.forEach(e => {
      if (e.source === 'expected' || e.kind !== 'salary' || (e.work_month !== k && e.work_month !== prevK)) return;
      const c = classifyExpense(e); if (c.kind !== 'salary' || !c.person_key) return;
      const p = people[c.person_key] = people[c.person_key] || { key: c.person_key, person: c.person, cur: 0, prev: 0, rest: false };
      if (e.work_month === k) { p.cur += num(e.amount); if ((e.part || salaryPart(e)) === 'rest') p.rest = true; } else p.prev += num(e.amount);
    });
    Object.values(people).forEach(p => {
      if (p.rest) return; // остаток за месяц пришёл — считаем по настоящим выплатам
      const emp = (base.employees || []).find(x => nameKey(x.name) === p.key);
      const email = emp && emp.email ? String(emp.email).toLowerCase() : null;
      const isManager = !!(email && calc.assign && calc.assign[email]);
      const closed = isManager && calc.closed && calc.closed[k] && calc.closed[k][email];
      const usd = R.oklad_usd ? num(R.oklad_usd[p.key]) : 0;
      let E = null, basis = '', parts = null;
      const sp = n => round(n).toLocaleString('ru-RU');
      if (closed) { E = num(closed.total); basis = 'по «Моему доходу»'; parts = { oklad: num(closed.oklad), percent: num(closed.bonus), kpi: num(closed.kpi) }; }
      else if (isManager) { const mp = managerPlanPay(emp, k, calc, base.payments); if (mp) { E = mp.oklad + mp.percent; parts = { oklad: mp.oklad, percent: mp.percent }; basis = 'оклад ' + sp(mp.oklad) + ' + процент ' + sp(mp.percent) + ' (новые продажи ' + sp(mp.sales) + ', ' + mp.pct + '% плана, ставка ' + String(mp.coeff).replace('.', ',') + '%)' + (mp.kpi_bonus > 0 ? '; премия KPI не учтена — звонки и встречи в Светофоре' : ''); } }
      else if (usd > 0) { const fx = fxRateFor(rates, today, 'USD'); if (fx) { E = usd * fx.rate; basis = round(usd) + ' $ по курсу ' + String(fx.rate).replace('.', ',') + ' на ' + fmtDay(fx.date); } }
      if (E == null && R.oklad && num(R.oklad[p.key]) > 0) { E = num(R.oklad[p.key]); basis = isManager ? 'по окладу, «Мой доход» за месяц ещё не закрыт' : 'по окладу'; }
      if (E == null && p.prev > 0) { E = p.prev; basis = 'по выплате за ' + monthLabel(prevK) + (usd > 0 ? ' (курса доллара нет)' : ', оклад не задан'); }
      if (E == null) return;
      const add = Math.round(E - p.cur); if (add <= 0) return;
      const name = emp && /[а-яё]/i.test(emp.name) ? String(emp.name).trim() : (p.person ? p.person.charAt(0).toUpperCase() + p.person.slice(1) : p.key); // «Амиру аванс» → «Амир» из списка сотрудников
      m.rows.push({ id: 'expected:' + k + ':' + p.key, source: 'expected', category: 'Ожидаемая зарплата', note: name + ' — ожидаемая, ' + basis, amount: add, date: null, sheet_month: k, work_month: k, pay_month: null, kind: 'salary', part: 'expected', expected_name: name, expected_basis: basis, expected_total: Math.round(E), expected_parts: parts, expected_class: { kind: 'salary', person_key: p.key, person: p.person } });
    });
    if (k >= INTEGRATORS_PAID_FROM_KG_SINCE) {
      const g = GROUP_RULES[0].group;
      const gCur = all.filter(e => e.kind === 'group' && e.work_month === k).reduce((a, e) => a + num(e.amount), 0);
      const gPrev = all.filter(e => e.kind === 'group' && e.work_month === prevK).reduce((a, e) => a + num(e.amount), 0);
      if (!gCur && gPrev > 0) {
        const fx = fxRateFor(rates, today, 'KZT'); let E = null, basis = '';
        if (fx && num(R.integrators_kzt) > 0) { E = num(R.integrators_kzt) * fx.rate; basis = round(R.integrators_kzt).toLocaleString('ru-RU') + ' тенге по курсу ' + String(fx.rate).replace('.', ',') + ' на ' + fmtDay(fx.date); }
        else { E = gPrev; basis = 'по выплате за ' + monthLabel(prevK) + ' (курса тенге нет)'; }
        m.rows.push({ id: 'expected:' + k + ':group', source: 'expected', category: 'Ожидаемая зарплата', note: 'Интеграторам — ожидаемая, ' + basis, amount: Math.round(E), date: null, sheet_month: k, work_month: k, pay_month: null, kind: 'group', part: 'expected', expected_name: g, expected_basis: basis, expected_total: Math.round(E), expected_class: { kind: 'group', group: g } });
      }
    }
  }
  return byMonth;
}

// ---------- предоплаченные расходы (CEO 27.09.2026: amoCRM 37 430 за 6 мес. = ~6 238 в месяц) ----------
// Список — в app_settings.finansist_prepaid.items: { id, label, item_key|null, amount, start:'YYYY-MM', months, added_by, added_at }.
// Правило: строка самой оплаты в месяце start из расходов убирается, вместо неё в каждый месяц срока
// кладётся равная доля (source='prepaid'). Обязательная статья в эти месяцы считается закрытой.
export async function loadPrepaid() {
  try { const r = await sbSelect('app_settings', { key: 'eq.finansist_prepaid', limit: '1' }); return ((r[0] && r[0].value && r[0].value.items) || []).filter(e => e && e.amount > 0 && e.months > 0 && parseMonth(e.start)); } catch (_) { return []; }
}
export async function savePrepaid(items) {
  await sbUpsert('app_settings', { key: 'finansist_prepaid', value: { items }, updated_at: new Date().toISOString() }, 'key');
  return items;
}
export function prepaidEnd(e) { return shiftMonthKey(e.start, e.months - 1); }
// поля предоплаты: note — пометка («уточняется»), renew_date — до какого числа оплачено (напоминание за месяц)
export function prepaidShare(e) { return Math.round(num(e.amount) / num(e.months) * 100) / 100; }
export function applyPrepaid(byMonth, prepaid) {
  (prepaid || []).forEach(e => {
    const item = e.item_key ? EXPECTED_ITEMS.find(i => i.key === e.item_key) : null;
    const share = prepaidShare(e);
    const end = prepaidEnd(e);
    Object.keys(byMonth).forEach(k => {
      const m = byMonth[k]; if (!m) return;
      if (k === e.start) {
        // сама оплата: та же статья (или любая, если статья не задана) и сумма ±1% — убираем, вместо неё доля
        m.rows = (m.rows || []).filter(r => !(r.source === 'sheet' && Math.abs(num(r.amount) - num(e.amount)) <= Math.max(1, num(e.amount) * 0.01) && (!item || itemMatches(item, r))));
      }
      if (k < e.start || k > end || !m.available) return;
      m.rows = (m.rows || []).concat([{ id: 'prepaid:' + e.id + ':' + k, date: k + '-01', category: e.label, note: 'предоплата ' + round(e.amount) + ' сом за ' + e.months + ' мес.' + (e.note ? ', ' + e.note : '') + ' (' + monthLabel(e.start) + ' – ' + monthLabel(end) + '), доля месяца', amount: share, bank: e.bank || '', source: 'prepaid', item_key: e.item_key || null, prepaid_id: e.id }]);
    });
  });
  return byMonth;
}
export function expenseRows(byMonth, monthKey) { const m = byMonth[monthKey]; if (!m || !m.available) return null; const rows = m.rows.filter(e => !isTransfer(e) && (e.work_month || monthKey) === monthKey); return rows.length ? rows : null; } // по месяцу работы; изъятия владельца внутри, expenseSummary считает их отдельно
export function cashRows(byMonth, monthKey) { const m = byMonth[monthKey]; if (!m || !m.available) return null; const rows = m.rows.filter(e => !isTransfer(e) && e.source !== 'expected' && (e.pay_month || monthKey) === monthKey); return rows.length ? rows : null; } // по дате выплаты — для «Счетов» и «Кассы»

export function expenseSummary(rows) {
  // total — расходы компании: зарплаты людей + группы (интеграция) + общие. Изъятие владельца и переносы — не расход.
  const o = { total: 0, salary_total: 0, people_salary_total: 0, salaries: {}, groups: {}, group_total: 0, shared_total: 0, shared_by_category: {}, taxes_by_kind: {}, tax_penalties: [], by_bank: {}, manual_total: 0, owner_total: 0, owner_rows: [], expected_total: 0, expected_rows: [], expected_tax_total: 0, expected_tax_rows: [] };
  (rows || []).forEach(e => {
    const a = num(e.amount); const k = classifyExpense(e);
    if (k.kind === 'transfer') return;
    if (k.kind === 'owner') { o.owner_total += a; o.owner_rows.push({ date: e.date, category: e.category, note: e.note, amount: a }); return; }
    o.total += a;
    if (e.source === 'manual') o.manual_total += a;
    if (e.source === 'expected') { if (e.expected_kind === 'tax') { o.expected_tax_total += a; o.expected_tax_rows.push({ name: e.expected_name, amount: a, basis: e.expected_basis }); } else { o.expected_total += a; o.expected_rows.push({ name: e.expected_name, amount: a, total: e.expected_total, basis: e.expected_basis, parts: e.expected_parts || null }); } }
    const bk = bankKey(e.bank); o.by_bank[bk] = (o.by_bank[bk] || 0) + a;
    if (k.kind === 'salary') { o.salary_total += a; o.people_salary_total += a; const nm = k.person; if (!o.salaries[k.person_key]) o.salaries[k.person_key] = { key: k.person_key, name: nm ? nm.charAt(0).toUpperCase() + nm.slice(1) : 'Без имени', sum: 0, n: 0, advance: 0, rest: 0, bonus: 0, leave: 0, expected: 0, rows: [] }; const sp = o.salaries[k.person_key]; sp.sum += a; sp.n++; const part = e.part || salaryPart(e); sp[part] = (sp[part] || 0) + a; if (e.expected_parts) sp.expected_parts = e.expected_parts; sp.rows.push({ date: e.date, note: e.note, amount: a, part, pay_month: e.pay_month || null }); }
    else if (k.kind === 'group') { o.salary_total += a; o.group_total += a; const g = o.groups[k.group] = o.groups[k.group] || { name: k.group, sum: 0, n: 0, expected: 0, rows: [] }; g.sum += a; g.n++; if (e.source === 'expected') g.expected += a; g.rows.push({ date: e.date, note: e.note, amount: a, expected: e.source === 'expected' }); }
    else { o.shared_by_category[k.label] = (o.shared_by_category[k.label] || 0) + a; o.shared_total += a; if (k.tax_kind) { o.taxes_by_kind[k.tax_kind] = (o.taxes_by_kind[k.tax_kind] || 0) + a; if (k.tax_kind === 'Пеня') o.tax_penalties.push({ date: e.date, note: e.note, amount: a }); } }
  });
  return o;
}

// ---------- расхождения ----------
export function findDisputes(all, range) {
  const issues = {};
  const push = (id, type, text, extra) => { (issues[id] = issues[id] || []).push(Object.assign({ type, text }, extra || {})); };
  all.forEach(p => {
    if (p.paid_at < BANK_RULE_FROM || num(p.amount) <= 0) return;
    const bk = bankKey(p.bank);
    if (bk !== 'license' && bk !== 'services') return;
    if (SERVICE_CATS.includes(p.category) && bk === 'license') push(p.id, 'bank', 'услуга на счёте лицензий');
    if (LICENSE_CATS.includes(p.category) && bk === 'services') push(p.id, 'bank', 'лицензия на счёте услуг');
  });
  const byClient = {};
  all.forEach(p => { if (num(p.amount) <= 0) return; const k = p.client_id || normName(p.company_name); (byClient[k] = byClient[k] || []).push(p); });
  Object.keys(byClient).forEach(k => {
    const rows = byClient[k].slice().sort((a, b) => a.paid_at < b.paid_at ? -1 : 1);
    for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++) {
      const a = rows[i], b = rows[j];
      if (daysBetween(a.paid_at, b.paid_at) > DUP_WINDOW_DAYS) break;
      if (a.category !== b.category || num(a.amount) !== num(b.amount)) continue;
      const pair = [String(a.id), String(b.id)].sort().join('+'); // один вопрос на пару, а не на каждую сторону
      push(a.id, 'dup', 'такой же платёж ' + fmtDay(b.paid_at), { pair });
      push(b.id, 'dup', 'такой же платёж ' + fmtDay(a.paid_at), { pair });
    }
  });
  // v1011: оплата пропала из листа «Доходы» — импорт её не удаляет, а помечает; здесь она становится спорной записью
  // и вопросом «удалить из программы или строку вернут». Удаление — только по ответу (answerQuestion).
  all.forEach(p => { if (p.sheet_missing_at) push(p.id, 'miss', 'строки нет в таблице «Доходы» с ' + fmtDay(String(p.sheet_missing_at).slice(0, 10)) + (p.sheet_tab ? ' (была на листе «' + p.sheet_tab + '»' + (p.sheet_row ? ', строка ' + p.sheet_row : '') + ')' : '') + (p.receipt_path ? '; у оплаты есть чек' : '')); });
  // Проверка по правилу декад удалена по решению CEO 27.09.2026: дни клиенту иногда дарят сознательно
  // (заплатил 20-го как за полный месяц — подарили 10 дней). Деньги считаем по факту оплаты.
  const list = all.filter(p => issues[p.id] && (!range || (p.paid_at >= range.from && p.paid_at <= range.to)))
    .map(p => ({ id: p.id, paid_at: p.paid_at, company_name: p.company_name, client_id: p.client_id, category: p.category, category_raw: p.category_raw, amount: num(p.amount), bank: p.bank, bank_key: bankKey(p.bank), manager_name: p.manager_name, source: p.source, created_by: p.created_by, issues: issues[p.id] }))
    .sort((a, b) => a.paid_at < b.paid_at ? 1 : -1);
  const counts = { bank: 0, dup: 0, miss: 0 };
  list.forEach(p => { const seen = {}; p.issues.forEach(i => { if (!seen[i.type]) { counts[i.type]++; seen[i.type] = 1; } }); });
  return { list, issues, counts };
}

// ---------- период: выручка, расходы, команда ----------
export function inRange(p, r) { return p.paid_at >= r.from && p.paid_at <= r.to; }
export function sumBy(rows, fn) { const o = {}; rows.forEach(p => { const k = fn(p) || '—'; o[k] = (o[k] || 0) + num(p.amount); }); return o; }

export function periodSummary(base, range, expRowsOrNull) {
  const cur = base.payments.filter(p => inRange(p, range));
  const revenue = cur.reduce((a, p) => a + num(p.amount), 0);
  const exp = expRowsOrNull ? expenseSummary(expRowsOrNull) : null;
  const profit = exp ? revenue - exp.total : null;
  const out = {
    from: range.from, to: range.to, count: cur.length, revenue,
    by_category: sumBy(cur, p => p.category), by_bank: sumBy(cur, p => bankKey(p.bank)), by_manager: sumBy(cur, p => p.manager_name),
    other_by_raw: sumBy(cur.filter(p => p.category === 'other'), p => p.category_raw || 'статья не указана'), // что внутри «Прочего» по исходной статье из таблицы
    expenses: exp ? exp.total : null, salaries: exp ? exp.salary_total : null, group_salaries: exp ? exp.group_total : null, shared: exp ? exp.shared_total : null, shared_by_category: exp ? exp.shared_by_category : null,
    manual_expenses: exp ? exp.manual_total : 0,
    profit,
    owner_draws: exp ? exp.owner_total : null, owner_draw_rows: exp ? exp.owner_rows : [],
    taxes_by_kind: exp ? exp.taxes_by_kind : null, tax_penalties: exp ? exp.tax_penalties : [],
    retained: exp ? profit - exp.owner_total : null, // «Осталось в компании» = прибыль − изъятие владельца
    expected_salary: exp ? exp.expected_total : 0, expected_salary_rows: exp ? exp.expected_rows : [], // пока остаток не выплачен — прибыль «ожидаемая»
    expected_taxes: exp ? exp.expected_tax_total : 0, expected_tax_rows: exp ? exp.expected_tax_rows : [], // налоги месяца ещё не заплачены — среднее за три месяца
    margin_pct: exp && revenue ? Math.round(profit / revenue * 1000) / 10 : null,
    salary_share_pct: exp && revenue ? Math.round(exp.salary_total / revenue * 100) : null,
  };
  return out;
}

// Зарплата за месяц считается выплаченной, когда наступило 15-е число следующего месяца, лист следующего месяца есть
// и у каждого, кто получил аванс за месяц, есть остаток. До этого прибыль месяца — предварительная.
export function salaryState(byMonth, monthKey) {
  const next = shiftMonthKey(monthKey, 1);
  const today = bishkekIso();
  const due = next + '-' + pad2(SALARY_PAID_BY_DAY);
  const rows = expenseRows(byMonth, monthKey) || [];
  const s = expenseSummary(rows);
  const noRest = Object.values(s.salaries).filter(p => p.advance > 0 && p.rest <= 0).map(p => p.name);
  const noAdvance = Object.values(s.salaries).filter(p => p.rest > 0 && p.advance <= 0 && p.rows.some(r => /за\s*выч[а-яё]*\s+[а-яё,\s]*аванс/i.test(r.note))).map(p => p.name);
  const pending = today < due || (byMonth[monthKey] && !byMonth[monthKey].next_available) || noRest.length > 0;
  return { pending, due, no_rest: noRest, no_advance: noAdvance, reason: today < due ? 'остаток за ' + monthLabel(monthKey) + ' выдают до ' + dayOf(due) + ' ' + MONTHS_RU_GEN[parseInt(next.slice(5, 7), 10) - 1] : (noRest.length ? 'нет остатка: ' + noRest.join(', ') : '') };
}

// Сверка выплаты с окладом (CEO 27.09.2026). Менеджеры: оклад + расчёт «Моего дохода» (app_settings.salary_closed
// за месяц, итог к выплате). Остальные: оклад из настроек. Сравниваем сумму на руки (аванс + остаток; у менеджеров
// и бонусы). Разница меньше порога — молчим; если меньше и в примечании «удержание»/«штраф» — причина названа, молчим.
export const PAY_TOLERANCE_SOM = 3000;
// Сверка выплат с окладом — только с августа 2026 (CEO 27.09.2026): оклады введены сейчас, какими они были раньше, неизвестно.
export const PAY_CHECK_FROM = '2026-08';
export const PAY_CHECK_BEFORE_NOTE = 'до начала сверки окладов';
let _calc = null, _calcTs = 0;
export async function loadSalaryCalc() {
  if (_calc && Date.now() - _calcTs < 60e3) return _calc;
  let closed = {}, grades = {};
  try { const r = await sbSelect('app_settings', { key: 'in.(salary_closed,salary_grades)', limit: '2' }); r.forEach(x => { if (x.key === 'salary_closed') closed = x.value || {}; if (x.key === 'salary_grades') grades = x.value || {}; }); } catch (_) {}
  _calc = { closed, assign: (grades && grades.assign) || {}, grades: (grades && Array.isArray(grades.grades)) ? grades.grades : [] }; _calcTs = Date.now();
  return _calc;
}
// Ожидаемая зарплата менеджера, пока месяц в «Моём доходе» не закрыт (CEO 27.09.2026) — та же формула, что на экране
// «Мой доход» (_incCalc): оклад грейда + процент с новых продаж месяца по шкале грейда. Новые продажи — оплаты, где
// исходная статья содержит «нов» и не «абон» (правило v989), по первому слову имени менеджера. План — из грейда (план
// из Светофора сервер не видит). Премия KPI зависит от звонков и встреч в Светофоре — при kpi_bonus > 0 не учитывается.
export function isNewSale(p) { const raw = String((p && p.category_raw) || '').toLowerCase(); return raw.indexOf('нов') >= 0 && raw.indexOf('абон') < 0; }
export function managerPlanPay(emp, monthKey, calc, payments) {
  const email = String((emp && emp.email) || '').toLowerCase(); const gid = calc && calc.assign && calc.assign[email];
  const g = gid && (calc.grades || []).find(x => x.id === gid); if (!g) return null;
  const first = String(emp.name || '').trim().split(/\s+/)[0].toLowerCase();
  const sales = (payments || []).filter(p => String(p.paid_at || '').slice(0, 7) === monthKey && isNewSale(p) && String(p.manager_name || '').trim().split(/\s+/)[0].toLowerCase() === first).reduce((a, p) => a + num(p.amount), 0);
  const plan = num(g.sales_plan); const pct = plan > 0 ? Math.round(sales / plan * 100) : 0;
  let coeff = 0; (g.scale || []).forEach(s => { if (pct >= num(s.min) && pct <= num(s.max)) coeff = num(s.pct); });
  return { oklad: num(g.salary), percent: Math.round(sales * coeff / 100), sales, plan, pct, coeff, kpi_bonus: num(g.kpi_bonus), grade: g.title };
}
export function expectedPay(person, monthKey, employees, calc, rates) {
  const R = currentRules();
  // Оклад в долларах (Жибек, 1 000 $, CEO 27.09.2026): каждую выплату переводим в доллары по курсу Нацбанка на её дату.
  // Курса на дату нет — «не проверено», не угадываем. Допуск — тот же процент, что у интеграторов.
  const usd = R.oklad_usd ? num(R.oklad_usd[person.key]) : 0;
  if (usd > 0) {
    const paid = (person.rows || []).filter(r => r.part === 'advance' || r.part === 'rest');
    const fact = person.advance + person.rest;
    const base = { kind: 'usd', usd_expected: usd, fact };
    if (!paid.length) return Object.assign(base, { expected: null, note: 'оклад ' + round(usd) + ' $' });
    const noRate = []; let usdPaid = 0;
    paid.forEach(r => { const fx = rates ? fxRateFor(rates, String(r.date || '').slice(0, 10), 'USD') : null; if (!fx) noRate.push(r.date); else usdPaid += num(r.amount) / fx.rate; });
    if (noRate.length) return Object.assign(base, { expected: null, unchecked: true, note: 'оклад ' + round(usd) + ' $; нет курса доллара Нацбанка на ' + noRate.map(fmtDay).join(', ') + ' — не проверено' });
    return Object.assign(base, { expected: Math.round(usd * fact / usdPaid), usd_paid: Math.round(usdPaid * 100) / 100, tol_pct: num(R.integrators_tolerance_pct) || 3, note: 'оклад ' + round(usd) + ' $ по курсу Нацбанка на даты выплат, выплачено ≈ ' + (Math.round(usdPaid * 10) / 10).toLocaleString('ru-RU') + ' $' });
  }
  const emp = (employees || []).find(e => nameKey(e.name) === person.key);
  const email = emp && emp.email ? String(emp.email).toLowerCase() : null;
  const isManager = !!(email && calc && calc.assign && calc.assign[email]);
  if (isManager) {
    const c = calc.closed && calc.closed[monthKey] && calc.closed[monthKey][email];
    if (!c) return { kind: 'calc', expected: null, note: 'расчёт «Моего дохода» за ' + monthLabel(monthKey) + ' не закрыт', fact: person.advance + person.rest + person.bonus };
    return { kind: 'calc', expected: num(c.total), note: 'оклад ' + round(c.oklad) + ' + переменная ' + round(num(c.total) - num(c.oklad)) + ' по «Моему доходу»', fact: person.advance + person.rest + person.bonus };
  }
  const ok = R.oklad && R.oklad[person.key];
  if (!ok) return { kind: 'oklad', expected: null, note: 'оклад не задан', fact: person.advance + person.rest };
  return { kind: 'oklad', expected: num(ok), note: 'оклад ' + round(ok), fact: person.advance + person.rest };
}
export function payCheck(person, exp) {
  if (exp.expected == null) return null;
  const diff = exp.fact - exp.expected;
  if (exp.tol_pct != null) { const pct = (exp.usd_paid - exp.usd_expected) / exp.usd_expected * 100; if (Math.abs(pct) <= exp.tol_pct) return null; if (diff < 0 && person.rows.some(r => /удержан|штраф|оп[оа]зд/i.test(r.note))) return null; return { diff, direction: diff < 0 ? 'less' : 'more', pct: Math.round(pct * 10) / 10 }; }
  if (Math.abs(diff) < PAY_TOLERANCE_SOM) return null;
  if (diff < 0 && person.rows.some(r => /удержан|штраф|оп[оа]зд/i.test(r.note))) return null; // причина названа: удержание, штраф, опоздание
  return { diff, direction: diff < 0 ? 'less' : 'more' };
}

export function teamRows(base, range, expRowsOrNull) {
  const cur = base.payments.filter(p => inRange(p, range));
  const exp = expRowsOrNull ? expenseSummary(expRowsOrNull) : null;
  const rows = {};
  cur.forEach(p => { const n = (p.manager_name || '').trim() || 'Без менеджера'; const k = nameKey(n); const t = rows[k] = rows[k] || { name: n, revenue: 0, count: 0, new_clients: 0, salary: 0, has_salary: false, owner: isOwnerName(n) }; t.revenue += num(p.amount); t.count++; if (p.category === 'license') t.new_clients++; });
  if (exp) Object.keys(exp.salaries).forEach(k => { const s = exp.salaries[k]; const t = rows[k] = rows[k] || { name: s.name, revenue: 0, count: 0, new_clients: 0, salary: 0, has_salary: false, owner: false }; t.salary = s.sum; t.has_salary = true; t.parts = { advance: s.advance, rest: s.rest, bonus: s.bonus, leave: s.leave, expected: s.expected || 0 }; t.pay_rows = s.rows; t.person_key = k; });
  // роль — из списка сотрудников (CEO 27.09.2026: Асель — менеджер по продажам, не поддержка; нет оплат за месяц — «выручки за месяц нет»)
  const roleOf = r => { const k = r.person_key || nameKey(r.name); const e = (base.employees || []).find(x => nameKey(x.name) === k); if (!e) return null; if (e.role === 'manager') return 'менеджер по продажам'; if (e.role === 'accountant') return 'бухгалтер'; if (e.role === 'admin') return 'руководитель'; if (e.role === 'operator') return /supp|sapp|поддерж/i.test(e.pos || '') ? 'поддержка' : 'оператор'; return null; };
  Object.values(rows).forEach(r => { r.role = r.owner ? 'владелец' : roleOf(r); });
  const statusOf = r => r.owner ? 'владелец' : ((!r.has_salary && r.revenue > 0) ? 'нет в расходах' : (r.revenue <= 0 ? (r.role === 'менеджер по продажам' ? 'выручки за месяц нет' : 'без выручки') : (r.revenue - r.salary >= 0 ? 'окупается' : 'в минусе')));
  const list = Object.values(rows).map(r => Object.assign(r, { result: r.revenue - r.salary, status: statusOf(r) }));
  list.sort((a, b) => b.revenue - a.revenue || b.salary - a.salary);
  // группы: выручка — оплаты по связанным статьям (эти же оплаты уже есть у менеджеров, в итог не добавляется)
  const groups = GROUP_RULES.map(g => {
    const rev = cur.filter(p => g.revenue_cats.includes(p.category));
    const revenue = rev.reduce((a, p) => a + num(p.amount), 0);
    const cost = exp && exp.groups[g.group] ? exp.groups[g.group].sum : 0;
    return { name: g.group, revenue, revenue_count: rev.length, revenue_cats: g.revenue_cats, cost, cost_expected: exp && exp.groups[g.group] ? exp.groups[g.group].expected || 0 : 0, cost_rows: exp && exp.groups[g.group] ? exp.groups[g.group].rows : [], result: revenue - cost, status: !exp ? 'расходов нет' : (cost <= 0 ? 'нет в расходах' : (revenue - cost >= 0 ? 'окупается' : 'в минусе')) };
  });
  const firstKgMonth = INTEGRATORS_PAID_FROM_KG_SINCE;
  groups.forEach(g => { if (g.name === 'Интеграция' && String(range.from).slice(0, 7) < firstKgMonth) g.note = 'до ' + monthLabel(firstKgMonth).replace(/^\S+/, m => MONTHS_RU_GEN[parseMonth(firstKgMonth).mo - 1]) + ' интеграторам платили из Казахстана — в расходах KG их нет, с августом сравнивать нельзя'; });
  return { rows: list, groups, has_expenses: !!exp, people_salary: exp ? exp.people_salary_total : null, shared: exp ? exp.shared_total : null, shared_by_category: exp ? exp.shared_by_category : null, taxes_by_kind: exp ? exp.taxes_by_kind : null, departments: departmentsFor(base, range, expRowsOrNull) };
}

// ---------- отделы (CEO 27.09.2026) ----------
// Статья общего расхода → ключ распределения. Налоги и всё, что не узнали, не распределяется.
export function allocItemOf(e) {
  const k = classifyExpense(e); if (k.kind !== 'shared') return null;
  if (k.label === 'Юрист, аутсорс') return 'lawyer';
  if (/связ|сим/i.test(String(e.category || '')) && /менеджер/i.test(String(e.note || ''))) return 'mobile_sales'; // «мобильный менеджеров», «тарифы менеджеров»
  if (k.tax_kind || k.label === 'Налоги') return null;
  for (const key of ['water', 'rent', 'amo', 'telephony', 'whatsapp', 'ads']) { const it = EXPECTED_ITEMS.find(i => i.key === key); if (it && itemMatches(it, e)) return key; }
  if (/^офис/i.test(String(e.category || '').trim())) return 'office';
  return null;
}
export function departmentsFor(base, range, expRows) {
  const ver = deptVersionFor(String(range.from).slice(0, 7));
  const depts = (ver.departments || DEPT_DEFAULTS).map(d => ({ key: d.key, name: d.name, people_keys: d.people || [], groups: d.groups || [], items: d.items || [], pool: !!d.pool, revenue_keys: d.revenue || [], people: [], salary: 0, salary_expected: 0, direct: {}, direct_total: 0, pooled: 0, revenue: 0, revenue_count: 0 }));
  const exp = expRows ? expenseSummary(expRows) : null;
  const unassigned = { people: [], groups: [], salary: 0, revenue: 0 };
  const byPerson = k => depts.find(d => d.people_keys.indexOf(k) >= 0);
  const nice = (k, n) => { const e = (base.employees || []).find(x => nameKey(x.name) === k); return e && /[а-яё]/i.test(e.name) ? String(e.name).trim() : n; }; // «Амиру аванс» → «Амир»
  if (exp) {
    Object.values(exp.salaries).forEach(s => { const d = byPerson(s.key); const row = { key: s.key, name: nice(s.key, s.name), salary: s.sum, expected: s.expected || 0, parts: s.expected_parts || null }; if (d) { d.people.push(row); d.salary += s.sum; d.salary_expected += s.expected || 0; } else { unassigned.people.push(row); unassigned.salary += s.sum; } });
    Object.values(exp.groups).forEach(g => { const d = depts.find(x => x.groups.indexOf(g.name) >= 0); const row = { key: 'group:' + g.name, name: g.name, salary: g.sum, expected: g.expected || 0, group: true }; if (d) { d.people.push(row); d.salary += g.sum; d.salary_expected += g.expected || 0; } else { unassigned.groups.push(row); unassigned.salary += g.sum; } });
  }
  const pool = { by_item: {}, total: 0, rows: [] }, undistributed = { by_label: {}, total: 0 };
  (expRows || []).forEach(e => {
    const k = classifyExpense(e); if (k.kind !== 'shared') return; const a = num(e.amount);
    const item = allocItemOf(e);
    const d = item && depts.find(x => x.items.indexOf(item) >= 0);
    if (d) { d.direct[item] = (d.direct[item] || 0) + a; d.direct_total += a; return; }
    if (item && POOL_ITEMS.some(p => p.key === item)) { pool.by_item[item] = (pool.by_item[item] || 0) + a; pool.total += a; return; }
    const lab = (item ? (ALLOC_ITEMS.find(x => x.key === item) || {}).label || item : k.label) + (e.source === 'expected' ? ' (ожидаемые)' : ''); undistributed.by_label[lab] = (undistributed.by_label[lab] || 0) + a; undistributed.total += a; if (e.source === 'expected') undistributed.expected = (undistributed.expected || 0) + a;
  });
  // доля офиса — по числу людей в отделах с отметкой pool (по составу из настроек)
  const poolDepts = depts.filter(d => d.pool && d.people_keys.length > 0); const heads = poolDepts.reduce((a, d) => a + d.people_keys.length, 0);
  if (pool.total && heads) poolDepts.forEach(d => { d.pooled = pool.total * d.people_keys.length / heads; d.pool_heads = d.people_keys.length; });
  else if (pool.total) { undistributed.by_label['Офис, аренда и вода'] = pool.total; undistributed.total += pool.total; }
  // выручка: внедрение и интеграция — отделу с «services», остальное — с «rest»
  const svc = (DEPT_REVENUE.find(r => r.key === 'services') || {}).cats || [];
  base.payments.filter(p => inRange(p, range)).forEach(p => { const key = svc.indexOf(p.category) >= 0 ? 'services' : 'rest'; const d = depts.find(x => x.revenue_keys.indexOf(key) >= 0); const a = num(p.amount); if (d) { d.revenue += a; d.revenue_count++; } else unassigned.revenue += a; });
  depts.forEach(d => { d.allocated = d.direct_total + d.pooled; d.cost = d.salary + d.allocated; d.result = d.revenue - d.cost; d.heads = d.people_keys.length; });
  const total_result = depts.reduce((a, d) => a + d.result, 0) + unassigned.revenue - unassigned.salary - undistributed.total;
  return { composition_from: ver.from, composition_custom: ver.custom, has_expenses: !!exp, departments: depts, pool: Object.assign(pool, { heads }), undistributed, unassigned, company_profit: exp ? total_result : null, company_expenses: exp ? exp.total : null };
}

// ---------- отток ----------
export function lastSubscriptionByClient(payments) {
  const o = {};
  payments.forEach(p => { if (!LICENSE_CATS.includes(p.category) || num(p.amount) <= 0) return; const k = p.client_id || normName(p.company_name); if (!o[k]) o[k] = p; });
  return o;
}
export function monthlyValue(p) { const m = num(p.period_months); return num(p.amount) / (m > 0 ? m : 1); }
export async function churnForMonth(base, range) {
  const lastSub = lastSubscriptionByClient(base.payments);
  const inMonthTs = ts => { const s = String(ts || '').slice(0, 10); return s >= range.from && s <= range.to; };
  const left = base.clients.filter(c => inMonthTs(c.churned_at) || ((c.pay_reason === 'churn' || c.pay_reason === 'decline') && inMonthTs(c.pay_reason_at))).map(c => {
    const last = lastSub[c.client_id] || lastSub[normName(c.company_name)];
    return { client_id: c.client_id, company_name: c.company_name, city: c.city, kind: c.pay_reason === 'decline' ? 'decline' : 'churn', reason: c.pay_reason_note || '', when: (c.churned_at || c.pay_reason_at || '').slice(0, 10), monthly: last ? Math.round(monthlyValue(last)) : 0, last_paid_at: last ? last.paid_at : null, operator: c.support_operator || null };
  });
  const [churnRows, licRows, licPeriods] = await Promise.all([
    sbSelectAll('churn_records', { country: 'eq.' + COUNTRY, period_month: 'eq.' + range.from, select: 'period_month,company_name,company_key,kind,prev_count,prev_amount,cur_count,cur_amount,diff,reason,reason_raw' }),
    sbSelectAll('churn_license_changes', { country: 'eq.' + COUNTRY, period_month: 'eq.' + range.from, select: 'period_month,company_key,license_type,m1_count,m2_count,diff' }),
    sbSelectAll('churn_license_changes', { country: 'eq.' + COUNTRY, select: 'period_month' }),
  ]);
  const licBy = {};
  licRows.forEach(r => { const o = licBy[r.company_key] = licBy[r.company_key] || { company_key: r.company_key, before: 0, after: 0, diff: 0 }; o.before += num(r.m1_count); o.after += num(r.m2_count); o.diff += num(r.diff); });
  const cur = base.payments.filter(p => inRange(p, range));
  const newRows = cur.filter(p => p.category === 'license' && num(p.amount) > 0);
  return {
    left, lost_monthly: left.reduce((a, c) => a + c.monthly, 0),
    new_monthly: Math.round(newRows.reduce((a, p) => a + monthlyValue(p), 0)),
    new_clients: new Set(newRows.map(p => p.client_id || normName(p.company_name))).size,
    records: churnRows.map(r => ({ company_name: r.company_name, kind: r.kind, prev_count: r.prev_count, cur_count: r.cur_count, prev_amount: num(r.prev_amount), cur_amount: num(r.cur_amount), diff: r.diff, reason: r.reason || r.reason_raw || '' })),
    license_changes: Object.values(licBy).filter(o => o.diff !== 0).sort((a, b) => a.diff - b.diff).slice(0, 40),
    periods_available: Array.from(new Set(churnRows.map(r => r.period_month).concat(licPeriods.map(r => r.period_month)))).filter(Boolean).sort().reverse(),
  };
}

// ---------- касса ----------
export function cashForecast(base, days) {
  const today = bishkekIso(); days = Math.min(90, Math.max(7, days || 30));
  const d90 = addDays(today, -90);
  const last90 = base.payments.filter(p => p.paid_at > d90 && p.paid_at <= today && num(p.amount) > 0);
  const lastSub = lastSubscriptionByClient(base.payments);
  const active = base.clients.filter(c => c.status === 'active');
  const estFor = c => { const last = lastSub[c.client_id] || lastSub[normName(c.company_name)]; return last ? num(last.amount) : 0; };
  const expected = active.filter(c => c.next_billing_at && c.next_billing_at >= today && c.next_billing_at <= addDays(today, 90)).map(c => ({ client_id: c.client_id, company_name: c.company_name, date: c.next_billing_at, est: estFor(c), months: c.subscription_period_months || null })).sort((a, b) => a.date < b.date ? -1 : 1);
  const overdue = active.filter(c => c.next_billing_at && c.next_billing_at < today);
  return { today, days, daily_avg_90: Math.round(last90.reduce((a, p) => a + num(p.amount), 0) / 90), inflow_90: last90.reduce((a, p) => a + num(p.amount), 0), expected, expected_30: expected.filter(e => e.date <= addDays(today, 30)).reduce((a, e) => a + e.est, 0), expected_60: expected.filter(e => e.date <= addDays(today, 60)).reduce((a, e) => a + e.est, 0), expected_90: expected.reduce((a, e) => a + e.est, 0), overdue_count: overdue.length, overdue_est: overdue.reduce((a, c) => a + estFor(c), 0) };
}

// ---------- недостающие данные ----------
function median(arr) { const a = arr.slice().sort((x, y) => x - y); if (!a.length) return null; const m = Math.floor(a.length / 2); return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; }
// Проверка месяца: по каждой обязательной статье — нашлись ли строки в таблице, сколько, и как это соотносится
// с медианой трёх прошлых месяцев, где данные были. Ручные суммы (source='manual') сюда не считаются как «настоящие».
// Когда проверка не имеет смысла: месяца в таблице нет вовсе (другой год, лист пуст) — «нет данных», а не
// «всё отсутствует»; текущий месяц до 20-го числа — статьи ещё могут быть просто не внесены («рано»).
export const MISSING_CHECK_FROM_DAY = 20;
export function missingCheckMode(byMonth, monthKey) {
  const m = byMonth[monthKey];
  if (!m || !m.available || !(m.rows || []).some(r => r.source === 'sheet')) return 'no_data';
  if (monthKey === currentMonthKey() && parseInt(bishkekIso().slice(8, 10), 10) < MISSING_CHECK_FROM_DAY) return 'early';
  return 'full';
}
export function checkMissing(byMonth, monthKey) {
  // «обычная сумма» — медиана трёх ближайших месяцев с данными, и назад, и вперёд (для прошлых месяцев соседи с обеих сторон точнее)
  const prevKeys = [-1, 1, -2, 2, -3, 3, -4, -5, -6].map(k => shiftMonthKey(monthKey, k)).filter(k => k <= currentMonthKey());
  const mode = missingCheckMode(byMonth, monthKey);
  const items = EXPECTED_ITEMS.map(item => {
    const cur = ((byMonth[monthKey] && byMonth[monthKey].rows) || []).filter(e => e.source !== 'manual' && (e.work_month || monthKey) === monthKey && itemMatches(item, e));
    const found = cur.reduce((a, e) => a + num(e.amount), 0);
    const prepaid = cur.some(e => e.source === 'prepaid'); // доля предоплаты — сумма известна по построению, сравнивать не с чем
    const prev = [];
    prevKeys.forEach(k => { const m = byMonth[k]; if (!m || !m.available || prev.length >= 3) return; const s = m.rows.filter(e => e.source !== 'manual' && (e.work_month || k) === k && itemMatches(item, e)).reduce((a, e) => a + num(e.amount), 0); if (s > 0) prev.push({ month: k, sum: s }); });
    const med = median(prev.map(p => p.sum));
    let status = 'ok';
    let track = null;
    if (item.track_last) {
      // последняя покупка — по всем загруженным месяцам не позже текущего
      const ks = Object.keys(byMonth).filter(k => k <= monthKey).sort().reverse();
      for (const k of ks) { const rr = (byMonth[k].rows || []).filter(e => e.source !== 'manual' && (e.work_month || k) === k && itemMatches(item, e)); if (rr.length) { const last = rr.map(e => String(e.date).slice(0, 10)).sort().pop(); const a = parseMonth(k), b = parseMonth(monthKey); track = { last_date: last, last_month: k, months_since: (b.y - a.y) * 12 + (b.mo - a.mo), amount: rr.reduce((x, e) => x + num(e.amount), 0), searched_from: ks[ks.length - 1] }; break; } }
      if (!track) track = { last_date: null, last_month: null, months_since: null, searched_from: ks[ks.length - 1] || monthKey };
    }
    if (mode === 'no_data') status = 'no_data';
    else if (item.track_last) status = (track.months_since == null || track.months_since > (item.max_gap_months || 2)) ? (mode === 'early' ? 'early' : 'missing') : 'ok';
    else if (!cur.length) status = item.not_monthly ? 'ok' : (mode === 'early' ? 'early' : 'missing');
    else if (prepaid) status = 'ok';
    else if (!item.no_odd && !item.not_monthly && med && Math.abs(found - med) / med > ODD_THRESHOLD) status = 'odd'; // неежемесячные (amo, вода) платят за разные сроки — «обычной суммы» у них нет
    return { item_key: item.key, item_label: item.label, status, prepaid, track, found_amount: found, found_rows: cur.map(e => ({ date: e.date, category: e.category, note: e.note, amount: e.amount, source: e.source })), expected_amount: med, prev, how: item.how };
  });
  items.mode = mode;
  return items;
}
// Синхронизация с таблицей finansist_missing_data. Возвращает актуальный список и что изменилось
// (в т.ч. «ручная сумма заменена настоящей строкой» — защита от двойного учёта).
export async function syncMissing(byMonth, monthKey) {
  const found = checkMissing(byMonth, monthKey);
  const existing = await sbSelect('finansist_missing_data', { country: 'eq.' + COUNTRY, month: 'eq.' + monthKey, limit: '100' });
  const exMap = {}; existing.forEach(r => { exMap[r.item_key] = r; });
  const changes = [];
  const now = new Date().toISOString();
  for (const it of found) {
    const ex = exMap[it.item_key];
    if (it.status === 'no_data' || it.status === 'early') { // рано судить: ничего не заводим, а старые «нет строки/отличается» (заведённые, пока данных не было) убираем
      if (ex && (ex.status === 'missing' || ex.status === 'odd')) { await sbDelete('finansist_missing_data', { id: 'eq.' + ex.id }); changes.push({ type: 'resolved', item: it, prev: ex }); }
      continue;
    }
    const note = (it.track && it.status === 'missing') ? (it.track.last_date ? 'Последняя покупка «' + it.item_label + '» — ' + fmtDay(it.track.last_date) + ', прошло ' + it.track.months_since + ' мес. Спросить у Гульшан: покупали ли и не забыли ли записать.' : 'Строк «' + it.item_label + '» нет с ' + monthLabel(it.track.searched_from) + '. Спросить у Гульшан: покупали ли и не забыли ли записать.') : it.status === 'missing'
      ? 'В таблице расходов за ' + monthLabel(monthKey) + ' нет строки «' + it.item_label + '». Спросить у Гульшан, почему её нет и какая сумма' + (it.expected_amount ? ' (обычно около ' + round(it.expected_amount) + ' сом). Пока не внесена, прибыль месяца завышена примерно на эту сумму' : '') + '.'
      : it.status === 'odd' ? '«' + it.item_label + '» за ' + monthLabel(monthKey) + ': ' + round(it.found_amount) + ' сом, обычно около ' + round(it.expected_amount) + ' сом. Уточнить у Гульшан, всё ли внесено.' : null;
    if (it.status === 'ok') {
      if (!ex) continue;
      if (ex.status === 'filled') { await sbUpdate('finansist_missing_data', { id: 'eq.' + ex.id }, { status: 'superseded', found_amount: it.found_amount, note: (it.prepaid ? 'Статья «' + it.item_label + '» закрыта предоплатой (' + round(it.found_amount) + ' сом в месяц)' : 'В таблице появилась настоящая строка «' + it.item_label + '» на ' + round(it.found_amount) + ' сом') + ' — ручная сумма ' + round(ex.amount) + ' сом больше не учитывается.', updated_at: now }); changes.push({ type: 'superseded', item: it, prev: ex }); }
      else if (ex.status === 'missing' || ex.status === 'odd') { await sbDelete('finansist_missing_data', { id: 'eq.' + ex.id }); changes.push({ type: 'resolved', item: it, prev: ex }); }
      continue;
    }
    if (!ex) { const ins = await sbInsert('finansist_missing_data', { country: COUNTRY, month: monthKey, item_key: it.item_key, item_label: it.item_label, status: it.status, expected_amount: it.expected_amount, found_amount: it.found_amount, note, created_at: now, updated_at: now }); exMap[it.item_key] = ins[0]; changes.push({ type: 'new', item: it }); continue; }
    if (ex.status === 'filled' || ex.status === 'ignored' || ex.status === 'superseded') {
      if (ex.status === 'superseded' && it.status === 'missing') { await sbUpdate('finansist_missing_data', { id: 'eq.' + ex.id }, { status: 'filled', note: 'Настоящая строка исчезла — снова учитываем ручную сумму.', updated_at: now }); changes.push({ type: 'refilled', item: it, prev: ex }); }
      continue;
    }
    if (ex.status !== it.status || round(ex.found_amount) !== round(it.found_amount) || round(ex.expected_amount) !== round(it.expected_amount) || (ex.note || '') !== (note || '')) { await sbUpdate('finansist_missing_data', { id: 'eq.' + ex.id }, { status: it.status, expected_amount: it.expected_amount, found_amount: it.found_amount, note, updated_at: now }); }
  }
  const rows = await sbSelect('finansist_missing_data', { country: 'eq.' + COUNTRY, month: 'eq.' + monthKey, order: 'item_key', limit: '100' });
  const tracked = found.filter(it => it.track).map(it => ({ item_key: it.item_key, item_label: it.item_label, status: it.status, last_date: it.track.last_date, months_since: it.track.months_since, amount: it.track.amount || null }));
  // статьи «по последней покупке» не делают прибыль неполной — их нельзя ждать каждый месяц
  return { items: rows, check: found, tracked, mode: found.mode, changes, incomplete: rows.some(r => (r.status === 'missing' || r.status === 'odd') && !(EXPECTED_ITEMS.find(i => i.key === r.item_key) || {}).track_last) };
}

// ---------- решения ----------
export async function loadDecisions() { return sbSelect('finansist_decisions', { country: 'eq.' + COUNTRY, active: 'eq.true', order: 'created_at.desc', limit: '200' }); }
export async function saveDecision(key, text, source, month, who, whoName) {
  const rows = await sbUpsert('finansist_decisions', { country: COUNTRY, key: String(key).slice(0, 200), text: String(text).slice(0, 1000), source, month: month || null, decided_by: who || null, decided_by_name: whoName || null, active: true, created_at: new Date().toISOString() }, 'country,key');
  return rows[0];
}

// ---------- расход на API: дневной лимит ----------
const DEFAULT_DAILY_LIMIT_USD = 2; // CEO 27.09.2026: агент — один отчёт в день, не постоянные разговоры
export async function getAgentLimits() {
  try { const r = await sbSelect('app_settings', { key: 'eq.finansist_agent_limits', limit: '1' }); const v = (r[0] && r[0].value) || {}; return { daily_usd: num(v.daily_usd) || DEFAULT_DAILY_LIMIT_USD }; } catch (_) { return { daily_usd: DEFAULT_DAILY_LIMIT_USD }; }
}
export async function getSpend(dayIso) {
  try { const r = await sbSelect('app_settings', { key: 'eq.finansist_agent_spend', limit: '1' }); const v = (r[0] && r[0].value) || {}; return { day: dayIso, usd: num(v[dayIso]), all: v }; } catch (_) { return { day: dayIso, usd: 0, all: {} }; }
}
export async function addSpend(dayIso, usd) {
  const cur = await getSpend(dayIso);
  const all = Object.assign({}, cur.all); all[dayIso] = Math.round((num(all[dayIso]) + usd) * 10000) / 10000;
  const keys = Object.keys(all).sort(); while (keys.length > 60) delete all[keys.shift()]; // храним два месяца
  await sbUpsert('app_settings', { key: 'finansist_agent_spend', value: all, updated_at: new Date().toISOString() }, 'key');
  return all[dayIso];
}

// ---------- сверка выплат по людям (для страницы и агента) ----------
export async function enrichTeamPay(team, employees, monthKey) {
  const [calc, rates] = await Promise.all([loadSalaryCalc(), loadFxRates()]);
  (team.rows || []).forEach(r => {
    if (!r.has_salary || r.owner) return;
    if (String(monthKey) < PAY_CHECK_FROM) { r.expected = null; r.expected_note = PAY_CHECK_BEFORE_NOTE + ' (с ' + MONTHS_RU_GEN[parseMonth(PAY_CHECK_FROM).mo - 1] + ' ' + PAY_CHECK_FROM.slice(0, 4) + ')'; r.pay_check = null; return; }
    const person = { key: r.person_key, advance: (r.parts && r.parts.advance) || 0, rest: (r.parts && r.parts.rest) || 0, bonus: (r.parts && r.parts.bonus) || 0, rows: r.pay_rows || [] };
    const exp = expectedPay(person, monthKey, employees, calc, rates);
    r.expected = exp.expected; r.expected_kind = exp.kind; r.expected_note = exp.note; r.fact_for_check = exp.fact; r.usd_paid = exp.usd_paid || null; r.usd_expected = exp.usd_expected || null; r.pay_unchecked = !!exp.unchecked;
    r.pay_check = payCheck(person, exp);
  });
  return team;
}
// Люди из зарплатных строк за месяцы (для поля «оклад» на «Правилах и целях»)
export async function payPeople(byMonth, employees, monthKey) {
  const calc = await loadSalaryCalc();
  const R = currentRules();
  const o = {};
  const win = monthKey ? [shiftMonthKey(monthKey, -2), shiftMonthKey(monthKey, -1), monthKey] : null; // три последних месяца работы — старые сотрудники не мешают
  Object.values(byMonth).forEach(m => (m.rows || []).forEach(e => { if (e.kind !== 'salary') return; if (win && win.indexOf(e.work_month) < 0) return; const k = classifyExpense(e); if (!o[k.person_key]) o[k.person_key] = { key: k.person_key, name: k.person ? k.person.charAt(0).toUpperCase() + k.person.slice(1) : k.person_key }; }));
  return Object.values(o).map(p => { const emp = (employees || []).find(e => nameKey(e.name) === p.key); const email = emp && emp.email ? String(emp.email).toLowerCase() : null; return Object.assign(p, { name: p.name, manager: !!(email && calc.assign && calc.assign[email]), oklad: R.oklad && R.oklad[p.key] != null ? num(R.oklad[p.key]) : null, oklad_usd: R.oklad_usd && R.oklad_usd[p.key] != null ? num(R.oklad_usd[p.key]) : null }); }).sort((a, b) => a.name.localeCompare(b.name, 'ru'));
}

// ---------- курс Нацбанка КР (тенге и доллар → сом) ----------
// Источник — официальный https://www.nbkr.kg/XML/daily.xml: отдаёт только курс на сегодня (архив по датам есть только
// HTML-страницей nbkr.kg index1.jsp?item=1562, его вписывают вручную). Доллар — для оклада Жибек (CEO 27.09.2026).
// Поэтому ночной крон каждый день сохраняет курс дня в app_settings.finansist_fx_rates; история копится с запуска.
// Для даты оплаты берём курс этой даты, в выходные/праздники — последний опубликованный, но не старше 5 дней.
// Курса нет — не угадываем: сверка «не проверено», Гульшан может вписать курс вручную на «Правилах и целях».
export const FX_MAX_AGE_DAYS = 5;
export async function loadFxRates() {
  try { const r = await sbSelect('app_settings', { key: 'eq.finansist_fx_rates', limit: '1' }); return (r[0] && r[0].value) || {}; } catch (_) { return {}; }
}
export async function saveFxRate(date, vals, src, who) {
  const cur = await loadFxRates();
  const v = typeof vals === 'number' ? { KZT: vals } : (vals || {});
  const next = Object.assign({}, cur[date] || {});
  if (num(v.KZT) > 0) next.KZT = num(v.KZT);
  if (num(v.USD) > 0) next.USD = num(v.USD);
  cur[date] = Object.assign(next, { src: src || 'nbkr', by: who || null, at: new Date().toISOString() });
  const keys = Object.keys(cur).sort(); while (keys.length > 800) delete cur[keys.shift()];
  await sbUpsert('app_settings', { key: 'finansist_fx_rates', value: cur, updated_at: new Date().toISOString() }, 'key');
  return cur[date];
}
export function fxRateFor(rates, date, cur) {
  const c = cur || 'KZT'; if (!rates || !/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return null;
  for (let d = 0; d <= FX_MAX_AGE_DAYS; d++) { const k = addDays(date, -d); if (rates[k] && num(rates[k][c]) > 0) return { rate: num(rates[k][c]), date: k, src: rates[k].src || 'nbkr' }; }
  return null;
}
export async function fetchNbkrToday() {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 15000);
  try {
    const r = await fetch('https://www.nbkr.kg/XML/daily.xml', { signal: ctl.signal, headers: { 'User-Agent': 'Mozilla/5.0 SalesDoc' } });
    if (!r.ok) throw new Error('НБКР ' + r.status);
    const txt = Buffer.from(await r.arrayBuffer()).toString('latin1'); // windows-1251, но нужны только цифры и латиница
    const dm = txt.match(/Date="(\d{2})\.(\d{2})\.(\d{4})"/);
    const km = txt.match(/ISOCode="KZT">\s*<Nominal>(\d+)<\/Nominal>\s*<Value>([\d,\.]+)<\/Value>/);
    const um = txt.match(/ISOCode="USD">\s*<Nominal>(\d+)<\/Nominal>\s*<Value>([\d,\.]+)<\/Value>/);
    if (!dm || !km) throw new Error('НБКР: не нашёл дату или курс тенге');
    return { date: dm[3] + '-' + dm[2] + '-' + dm[1], KZT: parseFloat(km[2].replace(',', '.')) / (parseInt(km[1], 10) || 1), USD: um ? parseFloat(um[2].replace(',', '.')) / (parseInt(um[1], 10) || 1) : null };
  } finally { clearTimeout(t); }
}
// Сверка оплат интеграторам за месяц выплаты: сколько сом должно было уйти по курсу на дату оплаты.
export function fxChecks(rows, rates) {
  const R = currentRules();
  const tol = num(R.integrators_tolerance_pct) || 0, kzt = num(R.integrators_kzt) || 0;
  return (rows || []).filter(e => e.kind === 'group').map(e => {
    const fx = fxRateFor(rates, String(e.date).slice(0, 10));
    if (!fx) return { date: e.date, note: e.note, fact: num(e.amount), status: 'no_rate' };
    const expected = kzt * fx.rate; const pct = expected ? (num(e.amount) - expected) / expected * 100 : null;
    return { date: e.date, note: e.note, fact: num(e.amount), rate: fx.rate, rate_date: fx.date, rate_src: fx.src, expected: Math.round(expected), pct: pct == null ? null : Math.round(pct * 10) / 10, status: pct != null && pct > tol ? 'over' : 'ok' };
  });
}
