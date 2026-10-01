// v1015: самопроверка правил Маркетинга (телефоны, продукты, этапы, время, дата обращения).
// Запуск: node scripts/mkt-selftest.mjs — без сети и без ключей, только чистые функции.
import assert from 'node:assert/strict';
import { normalizePhone } from '../api/_phone.js';
import { localIso, dayStartMs, dayEndMs, addDaysIso, zonedToUtcMs, tzOffsetMinAt, bishkekIso } from '../api/_dates.js';
import {
  DEFAULT_PRODUCTS, classifyCampaign, classifyForm, formIdFromTags, productOfLead, validateProducts,
  buildStageModel, reachedFromVisited, reachedFlags, computeArrival, splitInt, splitMoney,
  shiftHourToDay, bishkekShiftRows, metaErrKind
} from '../api/_mkt.js';

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('ok   ' + name); }
  catch (e) { fail++; console.log('FAIL ' + name + '\n     ' + (e.message || e)); }
}
const cfg = DEFAULT_PRODUCTS;

// ── Телефоны ──
const phones = [
  ['+996 555 123 456', 'KG', '996555123456'], ['0555123456', 'KG', '996555123456'], ['555123456', 'KG', '996555123456'],
  ['87011234567', 'KZ', '77011234567'], ['7011234567', 'KZ', '77011234567'], ['+7 701 123 45 67', 'KZ', '77011234567'],
  ['+7 701 123 45 67', 'KG', '77011234567'], ['+996555123456', 'KZ', '996555123456'],
  ['12345', 'KG', null], ['<test lead: dummy data>', 'KG', null], ['00996555123456', 'KG', '996555123456'],
  ['+7747967614', 'KZ', null], ['5551234567', 'KG', null], ['87011234567', 'KG', null], ['555123456', 'KZ', null],
  ['0555123456', '', '996555123456'], ['87011234567', '', '77011234567']
];
phones.forEach(([raw, c, exp]) => t(`phone ${raw} [${c || 'любая'}] → ${exp}`, () => assert.equal(normalizePhone(raw, c), exp)));

// ── Продукты ──
t('«IH_Заказ24_тест» по номеру кампании → Z24', () => assert.equal(classifyCampaign(cfg, { id: '120251108502780444', name: 'IH_Заказ24_тест' }), 'Z24'));
t('z24_KG_LF_IBR_2026-10 → Z24', () => assert.equal(classifyCampaign(cfg, { id: '1', name: 'z24_KG_LF_IBR_2026-10' }), 'Z24'));
t('SHTURM_KG_LF_X → SHTURM', () => assert.equal(classifyCampaign(cfg, { id: '1', name: 'SHTURM_KG_LF_X' }), 'SHTURM'));
t('sd_kg_site_ih_2026-09 → SD', () => assert.equal(classifyCampaign(cfg, { id: '1', name: 'sd_kg_site_ih_2026-09' }), 'SD'));
t('«МК WhatsApp» → SD', () => assert.equal(classifyCampaign(cfg, { id: '1', name: 'МК WhatsApp' }), 'SD'));
t('SDX_promo → SD по умолчанию, не по началу', () => {
  const alt = { ...cfg, default: 'Z24' }; // если бы SDX совпал как SD-префикс, вышло бы SD
  assert.equal(classifyCampaign(alt, { id: '1', name: 'SDX_promo' }), 'Z24');
  assert.equal(classifyCampaign(cfg, { id: '1', name: 'SDX_promo' }), 'SD');
});
t('кампания Штурма по номеру', () => assert.equal(classifyCampaign(cfg, { id: '120251202836020444', name: 'Лидформа' }), 'SHTURM'));
t('форма 1056856707121847 → SD', () => assert.equal(classifyForm(cfg, '1056856707121847'), 'SD'));
t('форма 1775408007121079 → SHTURM', () => assert.equal(classifyForm(cfg, '1775408007121079'), 'SHTURM'));
t('неизвестная форма → по кампании объявления', () => assert.equal(classifyForm(cfg, '999999', { '999999': { campaign: 'Z24_KG_LF' } }), 'Z24'));
t('теги [таргет ибра, fb1640508510930310] → Z24', () => {
  assert.equal(formIdFromTags(['таргет ибра', 'fb1640508510930310']), '1640508510930310');
  assert.equal(productOfLead(cfg, { tags: ['таргет ибра', 'fb1640508510930310'] }, null), 'Z24');
});
t('тег формы главнее касания', () => assert.equal(productOfLead(cfg, { tags: ['fb1775408007121079'] }, { campaign: 'Z24_KG_CHAT' }), 'SHTURM'));
t('без тега — по касанию, без касания — SD', () => {
  assert.equal(productOfLead(cfg, { tags: [] }, { campaign: 'Z24_KG_CHAT' }), 'Z24');
  assert.equal(productOfLead(cfg, { tags: ['таргет'] }, null), 'SD');
});
t('настройка: проверка кодов и номеров', () => {
  assert.equal(validateProducts(cfg).ok, true);
  assert.equal(validateProducts({ products: [{ code: 'XX' }] }).ok, false);
  assert.equal(validateProducts({ products: [{ code: 'SD', campaign_ids: ['12a'] }] }).ok, false);
  assert.equal(validateProducts({ products: [{ code: 'SD', prefixes: ['С Д'] }] }).ok, false);
});

// ── Этапы: честный «дошёл» ──
const statuses = [
  { id: 1, sort: 10, name: 'Неразобранное' }, { id: 2, sort: 20, name: 'Взят в работу' },
  { id: 82205462, sort: 30, name: 'Квалификация пройдена' }, { id: 4, sort: 40, name: 'Назначена встреча' },
  { id: 5, sort: 50, name: 'Встреча проведена' }, { id: 6, sort: 60, name: 'Счёт выставлен' },
  { id: 7, sort: 70, name: 'Предоплата' }, { id: 87022638, sort: 120, name: 'Отложили на период' },
  { id: 142, sort: 10000, name: 'Успешно реализовано' }, { id: 143, sort: 11000, name: 'Закрыто и не реализовано' }
];
const model = buildStageModel(statuses);
const bySort = (s) => statuses.find(x => x.sort === s).id;
const path = (...sorts) => sorts.map(bySort);
t('Отложили не в воронке, максимум = Предоплата', () => {
  assert.equal(model.flow.some(s => s.id === 87022638), false);
  assert.equal(model.maxFlowSort, 70);
});
t('10→30→120: дошёл до 30, квал да, встреча нет', () => {
  const r = reachedFromVisited(model, path(10, 30, 120));
  assert.equal(r, 30);
  assert.deepEqual(reachedFlags(model, r), { qual: true, meet: false, inv: false });
});
t('10→120: квала нет', () => {
  const r = reachedFromVisited(model, path(10, 120));
  assert.equal(r, 10);
  assert.equal(reachedFlags(model, r).qual, false);
});
t('10→40→143: встреча да, квал да', () => {
  const r = reachedFromVisited(model, path(10, 40, 11000));
  assert.equal(r, 40);
  assert.deepEqual(reachedFlags(model, r), { qual: true, meet: true, inv: false });
});
t('успех → все этапы', () => {
  const r = reachedFromVisited(model, [142]);
  assert.deepEqual(reachedFlags(model, r), { qual: true, meet: true, inv: true });
});
t('старый режим (v1): Отложили считался этапом', () => assert.equal(buildStageModel(statuses, { honest: false }).maxFlowSort, 120));

// ── Время ──
const LA = 'America/Los_Angeles';
t('LA 2026-09-30 10:00 (PDT) → Бишкек 2026-09-30 23:00', () => {
  const u = zonedToUtcMs(LA, 2026, 9, 30, 10);
  assert.equal(new Date(u + 6 * 3600000).toISOString().slice(0, 16), '2026-09-30T23:00');
  assert.equal(shiftHourToDay(LA, '2026-09-30', 10, 'KG'), '2026-09-30');
});
t('LA 2026-09-30 11:00 → Бишкек 2026-10-01 00:00', () => {
  const u = zonedToUtcMs(LA, 2026, 9, 30, 11);
  assert.equal(new Date(u + 6 * 3600000).toISOString().slice(0, 16), '2026-10-01T00:00');
  assert.equal(shiftHourToDay(LA, '2026-09-30', 11, 'KG'), '2026-10-01');
});
t('LA 2026-11-02 10:00 (PST) → Бишкек 2026-11-03 00:00', () => {
  const u = zonedToUtcMs(LA, 2026, 11, 2, 10);
  assert.equal(new Date(u + 6 * 3600000).toISOString().slice(0, 16), '2026-11-03T00:00');
  assert.equal(tzOffsetMinAt(LA, u), -480);
});
t('дни страны: KG +6, KZ +5', () => {
  assert.equal(dayStartMs('2026-09-01', 'KG'), Date.parse('2026-08-31T18:00:00Z'));
  assert.equal(dayEndMs('2026-09-30', 'KZ'), Date.parse('2026-09-30T19:00:00Z'));
  assert.equal(localIso(Date.parse('2026-09-30T18:30:00Z'), 'KG'), '2026-10-01');
  assert.equal(localIso(Date.parse('2026-09-30T18:30:00Z'), 'KZ'), '2026-09-30');
  assert.equal(bishkekIso(Date.parse('2026-09-30T18:00:00Z')), '2026-10-01');
  assert.equal(addDaysIso('2026-02-28', 1), '2026-03-01');
});
t('деление без потерь: целые и деньги', () => {
  const a = splitInt(7, { KG: 1, KZ: 1, UZ: 1 });
  assert.equal(Object.values(a).reduce((s, x) => s + x, 0), 7);
  const b = splitMoney(10.01, { KG: 2, KZ: 1 });
  assert.equal(Math.round(Object.values(b).reduce((s, x) => s + x, 0) * 100), 1001);
  assert.deepEqual(splitInt(5, {}), { '??': 5 });
});
t('часы кабинета LA → бишкекские дни, итоги сходятся точно', () => {
  // Почасовая статистика ВСЕГО кабинета за 2026-09-30: часы 0..23 по $1 и по 1 заявке.
  // Дневные строки кампании: KG 3/4, KZ 1/4.
  const hourly = [];
  for (let h = 0; h < 24; h++) hourly.push({ date_start: '2026-09-30',
    hourly_stats_aggregated_by_advertiser_time_zone: String(h).padStart(2, '0') + ':00:00 - ' + String(h).padStart(2, '0') + ':59:59',
    spend: '1.00', impressions: '10', clicks: '1', actions: [{ action_type: 'lead', value: '1' }] });
  const dayRows = [
    { date_start: '2026-09-30', campaign_id: 'c1', country: 'KG', spend: '18', impressions: '180', clicks: '18', reach: '100', actions: [{ action_type: 'lead', value: '18' }] },
    { date_start: '2026-09-30', campaign_id: 'c1', country: 'KZ', spend: '6', impressions: '60', clicks: '6', reach: '40', actions: [{ action_type: 'lead', value: '6' }] }
  ];
  const keyOf = (r) => r.campaign_id;
  // Бишкекский день 30.09 = часы LA 0..10 (11 ч); 01.10 = часы 11..23 (13 ч)
  const one = bishkekShiftRows({ hourlyRows: hourly, dayRows, tz: LA, country: 'KG', since: '2026-09-30', until: '2026-09-30',
    keyOf, daily: false });
  const sum = (rows, f) => rows.reduce((s, r) => s + Number(r[f] || 0), 0);
  const leads = (rows) => rows.reduce((s, r) => s + r.actions.reduce((a, x) => a + Number(x.value), 0), 0);
  assert.equal(Math.round(sum(one.rows, 'spend') * 100), 1100);
  // обрезка краем периода: каждая строка округляется отдельно — не больше ±1 на строку
  assert.ok(Math.abs(sum(one.rows, 'impressions') - 110) <= 2);
  assert.equal(leads(one.rows), 11);
  const kg = one.rows.find(r => r.country === 'KG');
  assert.ok(kg && Math.abs(kg.spend - 8.25) < 0.011, 'KG ≈ 3/4 расхода');
  const daily = bishkekShiftRows({ hourlyRows: hourly, dayRows, tz: LA, country: 'KG', since: '2026-09-30', until: '2026-10-01',
    keyOf, daily: true });
  const d30 = daily.rows.filter(r => r.date_start === '2026-09-30'), d01 = daily.rows.filter(r => r.date_start === '2026-10-01');
  assert.equal(Math.round(sum(d30, 'spend') * 100), 1100);
  assert.equal(Math.round(sum(d01, 'spend') * 100), 1300);
  assert.equal(leads(d30) + leads(d01), 24);
  assert.equal(sum(d30, 'impressions') + sum(d01, 'impressions'), 240);
  // у каждой строки (кампания × страна) итог за два дня сходится точно
  const kgAll = daily.rows.filter(r => r.country === 'KG');
  assert.equal(leads(kgAll), 18);
  assert.equal(Math.round(sum(kgAll, 'spend') * 100), 1800);
  // почасовые без действий — заявки делим по доле расхода
  const noAct = hourly.map(r => { const c = { ...r }; delete c.actions; return c; });
  const est = bishkekShiftRows({ hourlyRows: noAct, dayRows, tz: LA, country: 'KG', since: '2026-09-30', until: '2026-10-01',
    keyOf, daily: true });
  assert.equal(est.approx, true);
  assert.equal(leads(est.rows), 24); // без потерь и без ±1
});

// ── Дата обращения ──
const touch = (iso, extra) => Object.assign({ touched_at: iso, campaign: 'SD_KG_CHAT', ad_id: 'a1', targetolog: 'Ибрагим' }, extra || {});
const sec = (iso) => Math.floor(Date.parse(iso) / 1000);
const aug = [sec('2026-08-01T00:00:00+06:00'), sec('2026-09-01T00:00:00+06:00') - 1];
const sep = [sec('2026-09-01T00:00:00+06:00'), sec('2026-10-01T00:00:00+06:00') - 1];
t('касание 31.08 23:50 по Бишкеку, сделка 01.09 → август', () => {
  const lead = { created: sec('2026-09-01T10:00:00+06:00'), tags: [] };
  const tt = [touch('2026-08-31T17:50:00Z')];
  const a = computeArrival(lead, tt, aug[0], aug[1]);
  assert.ok(a, 'должна попасть в август');
  assert.equal(a.arrival_kind, 'ad');
  assert.equal(a.arrival_at, sec('2026-08-31T17:50:00Z'));
  assert.equal(computeArrival(lead, tt, sep[0], sep[1]), null);
});
t('касание через 40 дней после создания → «возврат» в месяце касания', () => {
  const lead = { created: sec('2026-08-05T12:00:00+06:00'), tags: [] };
  const tt = [touch(new Date(Date.parse('2026-08-05T12:00:00+06:00') + 40 * 86400000).toISOString())];
  const a = computeArrival(lead, tt, sep[0], sep[1]);
  assert.ok(a);
  assert.equal(a.arrival_kind, 'return');
  assert.equal(a.touch.ad_id, 'a1');
  const inAug = computeArrival(lead, tt, aug[0], aug[1]);
  assert.equal(inAug.arrival_kind, 'organic');
  assert.equal(inAug.touch, null);
});
t('сделка 30.08, касание 02.09 → «ad» в августе, с касанием', () => {
  const lead = { created: sec('2026-08-30T12:00:00+06:00'), tags: [] };
  const tt = [touch('2026-09-02T06:00:00Z')];
  const a = computeArrival(lead, tt, aug[0], aug[1]);
  assert.ok(a);
  assert.equal(a.arrival_kind, 'ad');
  assert.equal(a.arrival_at, lead.created);
  assert.equal(a.touch.ad_id, 'a1');
  assert.equal(computeArrival(lead, tt, sep[0], sep[1]), null);
});
t('лидформа без касания → «ad», без всего → «organic»', () => {
  const created = sec('2026-09-10T12:00:00+06:00');
  assert.equal(computeArrival({ created, tags: ['fb1056856707121847'] }, [], sep[0], sep[1]).arrival_kind, 'ad');
  assert.equal(computeArrival({ created, tags: [] }, [], sep[0], sep[1]).arrival_kind, 'organic');
});

t('коды ошибок Meta', () => {
  assert.equal(metaErrKind(190), 'token');
  assert.equal(metaErrKind(10), 'perm');
  assert.equal(metaErrKind(200), 'perm');
  assert.equal(metaErrKind(1), 'other');
});

console.log(`\n${pass} ok, ${fail} fail`);
process.exit(fail ? 1 : 0);
