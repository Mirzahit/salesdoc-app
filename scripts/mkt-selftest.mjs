// v1015: самопроверка правил Маркетинга (телефоны, продукты, этапы, время, дата обращения).
// Запуск: node scripts/mkt-selftest.mjs — без сети и без ключей, только чистые функции.
import assert from 'node:assert/strict';
import { normalizePhone } from '../api/_phone.js';
import { localIso, dayStartMs, dayEndMs, addDaysIso, zonedToUtcMs, tzOffsetMinAt, bishkekIso } from '../api/_dates.js';
import {
  DEFAULT_PRODUCTS, classifyCampaign, classifyForm, formIdFromTags, productOfLead, validateProducts,
  buildStageModel, reachedFromVisited, reachedFlags, computeArrival, splitInt, splitMoney,
  shiftHourToDay, bishkekShiftRows, metaErrKind, classifyMetaLead, cpqTone, campaignDecision, sourceTypeOf, mergeBackfillMark, backfillNeeded, backfillPiece
} from '../api/_mkt.js';
import { normalizeHolidays, workMinutesBetween, toneOf, firstHumanAction, candidatesOf, collectTasks, collectWhatsapp, isAutoReply, normWaText,
  validateWaTemplates, WA_TEMPLATES_DEFAULT, piiAllowed, maskTail, applyWorkPii } from '../api/_mkt_work.js'; // v1017
import { monthInfo, prevMonthOf, closeDue, fxForDays, fxSourceOf, parseNbkrArchive, planFxFill, buildCloseRow, decideCloseWrite, buildRecalc, idsDelta, liveIdsOf, recalcAccess, shortErr } from '../api/_mkt_close.js'; // v1019
import { leadIdFromDealName, decideMatch, mergeTouches, parseMetaLead, fxByDay, lgTouchToRow, maskPhone, cleanErr } from '../api/_meta_leads.js'; // v1017

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
t('v1019: касание 31.08 23:50, сделка 01.09 → сентябрь (месяц создания), из рекламы', () => {
  const lead = { created: sec('2026-09-01T10:00:00+06:00'), tags: [] };
  const tt = [touch('2026-08-31T17:50:00Z')];
  assert.equal(computeArrival(lead, tt, aug[0], aug[1]), null, 'в августе её нет');
  const a = computeArrival(lead, tt, sep[0], sep[1]);
  assert.ok(a, 'должна попасть в сентябрь');
  assert.equal(a.arrival_kind, 'ad');
  assert.equal(a.arrival_at, lead.created);
  assert.equal(a.touch.ad_id, 'a1');
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

// ── v1017: рабочее время «Не взято в работу» (2026-10-05 — понедельник, Бишкек +6) ──
const bk = (s) => Date.parse(s + '+06:00');
t('Пн 10:00→10:09 = 9', () => assert.equal(workMinutesBetween(bk('2026-10-05T10:00:00'), bk('2026-10-05T10:09:00'), []), 9));
t('Пн 17:50→Вт 09:10 = 20', () => assert.equal(workMinutesBetween(bk('2026-10-05T17:50:00'), bk('2026-10-06T09:10:00'), []), 20));
t('Пт 21:40→Пн 09:15 = 15', () => assert.equal(workMinutesBetween(bk('2026-10-02T21:40:00'), bk('2026-10-05T09:15:00'), []), 15));
t('Сб 12→15 = 0', () => assert.equal(workMinutesBetween(bk('2026-10-03T12:00:00'), bk('2026-10-03T15:00:00'), []), 0));
t('Ср 08:00→09:30 = 30', () => assert.equal(workMinutesBetween(bk('2026-10-07T08:00:00'), bk('2026-10-07T09:30:00'), []), 30));
t('Пн 09:00→Ср 09:00 = 1080', () => assert.equal(workMinutesBetween(bk('2026-10-05T09:00:00'), bk('2026-10-07T09:00:00'), []), 1080));
t('праздник Пн: Пт 17:00→Вт 09:30 = 90', () => assert.equal(workMinutesBetween(bk('2026-10-02T17:00:00'), bk('2026-10-06T09:30:00'), ['2026-10-05']), 90));
t('конец раньше начала = 0', () => assert.equal(workMinutesBetween(bk('2026-10-05T12:00:00'), bk('2026-10-05T11:00:00'), []), 0));
t('2026-10-05T03:00Z (09:00 Бишкек) +10 мин = 10', () => assert.equal(workMinutesBetween(Date.parse('2026-10-05T03:00:00Z'), Date.parse('2026-10-05T03:10:00Z'), new Set()), 10));
t('нормы: 15 норма, 16 и 60 поздно, 61 провал', () => {
  assert.equal(toneOf(15), 'ok'); assert.equal(toneOf(16), 'mid'); assert.equal(toneOf(60), 'mid'); assert.equal(toneOf(61), 'bad');
});
const C0 = 1790000000;
t('робот +1 с, человек сменил этап +20 мин → этап +20 мин', () => {
  const r = firstHumanAction(C0, candidatesOf({ notes: [{ created_at: C0 + 1, created_by: 0, note_type: 'common' }], statusEv: [{ created_at: C0 + 1200, created_by: 77 }] }));
  assert.deepEqual(r, { at: C0 + 1200, by: 77, kind: 'status' });
});
t('исходящий звонок контакту +5 мин раньше задачи +7 мин', () => {
  const r = firstHumanAction(C0, candidatesOf({ contactNotes: [{ created_at: C0 + 300, created_by: 5, note_type: 'call_out' }, { created_at: C0 + 100, created_by: 5, note_type: 'call_in' }],
    tasks: [{ created_at: C0 + 420, created_by: 6, is_completed: false }] }));
  assert.equal(r.at, C0 + 300); assert.equal(r.kind, 'call'); assert.equal(r.by, 5);
});
t('только робот → не взято', () => assert.equal(firstHumanAction(C0, candidatesOf({ notes: [{ created_at: C0 + 1, created_by: 0, note_type: 'common' }],
  tasks: [{ created_at: C0 + 2, created_by: 0, is_completed: false }], statusEv: [] })), null));
t('звонок до создания сделки не считается', () => assert.equal(firstHumanAction(C0, candidatesOf({ contactNotes: [{ created_at: C0 - 50, created_by: 5, note_type: 'call_out' }] })), null));
t('выбор не зависит от источника: любые кандидаты {at, human}', () => {
  const r = firstHumanAction(C0, [{ at: C0 + 50, kind: 'x', human: false }, { at: C0 + 90, kind: 'y', human: true, by: 3 }, { at: C0 + 70, kind: 'z', human: true, by: null, by_name: 'Айдана' }]);
  assert.deepEqual(r, { at: C0 + 70, by: null, kind: 'z', by_name: 'Айдана' });
});
t('задача закрыта человеком → task_done', () => {
  const r = firstHumanAction(C0, collectTasks([{ created_at: C0 + 1, created_by: 0, is_completed: true, updated_at: C0 + 600, responsible_user_id: 9 }]));
  assert.deepEqual(r, { at: C0 + 600, by: 9, kind: 'task_done' });
});
t('праздники: кривые даты отбрасываются, повторы убираются', () => {
  assert.deepEqual(normalizeHolidays(['2026-13-01', '2026-10-05', '2026-02-30', '2026-01-07', '2026-10-05', 'x']), ['2026-01-07', '2026-10-05']);
  assert.deepEqual(normalizeHolidays(null), []);
});
// WhatsApp (за флагом): шаблоны автоответов, автор
const wa = (at, dir, author, text) => ({ received_at: new Date((C0 + at) * 1000).toISOString(), kind: 'message', direction: dir, message_text: text, raw: { authorName: author } });
t('WhatsApp: шаблон автоответа и пустой автор — бот; Phone — ответственный; имя менеджера — он сам', () => {
  const c = collectWhatsapp([
    wa(5, 'in', '', 'Добрый день'),
    wa(6, 'out', '', 'Здравствуйте! Спасибо, что написали. Мы скоро ответим.'),
    wa(8, 'out', 'Phone', 'Здравствуйте!! Спасибо, что написали 🙂 Мы скоро ответим'),
    wa(30, 'out', 'Phone', 'Добрый день, подскажите город'),
    wa(40, 'out', 'Айдана', 'Отправила КП')
  ], { managers: { 'айдана': 11 }, responsibleId: 22 });
  assert.deepEqual(c.map(x => [x.human, x.by]), [[false, null], [false, null], [true, 22], [true, 11]]);
  assert.deepEqual(firstHumanAction(C0, c), { at: C0 + 30, by: 22, kind: 'whatsapp', by_name: 'Phone' });
});
t('WhatsApp: шаблон по началу текста, ё=е, без знаков', () => {
  assert.equal(isAutoReply('Здравствуйте! Хотите узнать подробнее о решении для управления товарами? Ответьте «да»', WA_TEMPLATES_DEFAULT), true);
  assert.equal(isAutoReply('здравствуйте не смогли принять ваш вызов но непременно ответим!!!', WA_TEMPLATES_DEFAULT), true);
  assert.equal(isAutoReply('Здравствуйте, когда удобно созвониться?', WA_TEMPLATES_DEFAULT), false);
  assert.equal(normWaText('  Ёлка, 🎄 ПРИВЕТ!  '), 'елка привет');
});
t('шаблоны автоответов: проверка настройки', () => {
  assert.deepEqual(validateWaTemplates([' a ', '', 'a', 'b']).value, ['a', 'b']);
  assert.equal(validateWaTemplates('x').ok, false);
  assert.equal(validateWaTemplates(['x'.repeat(301)]).ok, false);
  assert.equal(validateWaTemplates(Array.from({ length: 51 }, (_, i) => 's' + i)).ok, false);
});
// Кто видит телефоны и имена
t('персональные данные: подписанная сессия + admin/head/rop/manager или админ-код', () => {
  assert.equal(piiAllowed({ role: 'manager', trusted: true }), true);
  assert.equal(piiAllowed({ role: 'rop', trusted: true }), true);
  assert.equal(piiAllowed({ role: 'manager', trusted: false }), false);
  assert.equal(piiAllowed({ role: 'targetolog', trusted: true }), false);
  assert.equal(piiAllowed({ role: 'viewer', trusted: true }), false);
  assert.equal(piiAllowed({ role: 'admin', trusted: true, active: false }), false);
  assert.equal(piiAllowed(null), false);
  assert.equal(piiAllowed(null, true), true);
});
t('маска телефона: последние 4 цифры', () => {
  assert.equal(maskTail('996555123456'), '••• 3456');
  assert.equal(maskTail('+996 (555) 12-34-56'), '••• 3456');
  assert.equal(maskTail('12'), '');
  assert.equal(maskPhone('77011234567'), '••• 4567');
});
t('отчёт «не взято»: полный номер только с правом', () => {
  const row = { phone_masked: '••• 3456' }; Object.defineProperty(row, '_phone', { value: '996555123456', enumerable: false });
  const data = { leads: { 1: row } };
  const a = applyWorkPii(data, false), b = applyWorkPii(data, true);
  assert.equal(a.pii, false); assert.equal(a.leads[1].phone, undefined); assert.equal(JSON.stringify(a).includes('996555123456'), false);
  assert.equal(b.pii, true); assert.equal(b.leads[1].phone, '996555123456');
  assert.equal(JSON.stringify(data).includes('996555123456'), false);
});

// ── v1017: заявки лидформ ──
t('продукт заявки: SD_KG_LF_IH_2026-09 → SD', () => assert.equal(classifyMetaLead(cfg, { campaign_name: 'SD_KG_LF_IH_2026-09' }), 'SD'));
t('продукт заявки: неизвестно и без номеров → null', () => assert.equal(classifyMetaLead(cfg, { campaign_name: 'IH_Лидформы_SD', campaign_id: '1', form_id: '2' }), null));
t('продукт заявки: форма 1775408007121079 → SHTURM', () => assert.equal(classifyMetaLead(cfg, { campaign_name: 'IH_Штурм_тест', form_id: '1775408007121079' }), 'SHTURM'));
t('номер заявки из названия сделки', () => {
  assert.equal(leadIdFromDealName('Facebook №1234567890123'), '1234567890123');
  assert.equal(leadIdFromDealName('Facebook № 1234567890123 (копия)'), '1234567890123');
  assert.equal(leadIdFromDealName('Сделка #5'), null);
});
const mrow = (o) => Object.assign({ meta_lead_id: '900001', created_time: '2026-09-20T10:00:00Z', product: 'SD', form_id: '111111', phone_norm: '996555123456', full_name: 'Азамат', phone_raw: '+996555123456', answers: {} }, o || {});
const ctS = Math.floor(Date.parse('2026-09-20T10:00:00Z') / 1000);
t('сверка: тестовая заявка', () => assert.equal(decideMatch(mrow({ full_name: '<test lead: dummy data for full_name>', phone_norm: null }), {}).match_status, 'test'));
t('сверка: Zakaz24 → other_product (в amo не ищем)', () => assert.equal(decideMatch(mrow({ product: 'Z24' }), { dealByMetaId: new Map([['900001', { id: 1 }]]) }).match_status, 'other_product'));
t('сверка: номер в названии → matched', () => {
  const d = decideMatch(mrow(), { dealByMetaId: new Map([['900001', { id: 55, created_at: ctS + 5, created_by: 0, contact_id: 9 }]]) });
  assert.equal(d.match_status, 'matched'); assert.equal(d.match_method, 'lead_id'); assert.equal(d.amo_lead_id, 55); assert.equal(d.amo_contact_id, 9);
});
t('сверка: номер уже пришёл другой заявкой → duplicate', () => {
  const d = decideMatch(mrow(), { matchedPhones: new Map([['996555123456', '900000']]), phoneDeals: new Map([['996555123456', { contact_id: 1, deals: [{ id: 2, created_at: ctS, created_by: 0 }] }]]) });
  assert.equal(d.match_status, 'duplicate');
});
t('сверка: робот-сделка по телефону → renamed', () => {
  const d = decideMatch(mrow(), { phoneDeals: new Map([['996555123456', { contact_id: 3, deals: [{ id: 10, created_at: ctS - 90 * 86400, created_by: 7 }, { id: 11, created_at: ctS + 60, created_by: 0 }] }]]) });
  assert.equal(d.match_status, 'renamed'); assert.equal(d.amo_lead_id, 11); assert.equal(d.match_method, 'phone');
});
t('сверка: ручная сделка по телефону → manual', () => {
  const d = decideMatch(mrow(), { phoneDeals: new Map([['996555123456', { contact_id: 3, deals: [{ id: 12, created_at: ctS + 3600, created_by: 7 }] }]]) });
  assert.equal(d.match_status, 'manual'); assert.equal(d.amo_lead_id, 12);
});
t('сверка: форма не подключена', () => {
  const d = decideMatch(mrow(), { connectedForms: new Set(['222222']), phoneDeals: new Map() });
  assert.equal(d.match_status, 'not_found'); assert.equal(d.lost_reason, 'form_not_connected');
});
t('сверка: форма подключена, сделки нет → no_deal', () => {
  const d = decideMatch(mrow(), { connectedForms: new Set(['111111']) });
  assert.equal(d.match_status, 'not_found'); assert.equal(d.lost_reason, 'no_deal');
});
t('сверка: пустой номер → bad_phone; неизвестный продукт ищется как SD', () => {
  assert.equal(decideMatch(mrow({ phone_norm: null }), {}).match_status, 'bad_phone');
  assert.equal(decideMatch(mrow({ product: null }), { dealByMetaId: { '900001': { id: 1 } } }).match_status, 'matched');
});
t('разбор заявки Meta: телефон, имя, ответы, страна, продукт', () => {
  const r = parseMetaLead({ id: '1753000000000001', created_time: '2026-09-30T04:41:47+0000', form_id: '1640508510930310', campaign_name: 'IH_Заказ24_тест',
    field_data: [{ name: 'какой_у_вас_бизнес', values: ['дистрибуция'] }, { name: 'full_name', values: ['Айбек'] }, { name: 'phone_number', values: ['+77011234567'] }] }, cfg, { form_name: 'Z24 форма' });
  assert.equal(r.phone_norm, '77011234567'); assert.equal(r.country, 'KZ'); assert.equal(r.full_name, 'Айбек');
  assert.deepEqual(r.answers, { 'какой_у_вас_бизнес': 'дистрибуция' }); assert.equal(r.product, 'Z24');
  assert.equal(r.created_time, '2026-09-30T04:41:47.000Z'); assert.equal(r.recheck_until, '2026-10-14T04:41:47.000Z'); assert.equal(r.match_status, 'new');
});
t('общий источник касаний: lg:X выброшен, если заявка X есть в meta_leads', () => {
  const ad = [{ message_id: 'lg:777', touched_at: '2026-09-10T05:00:00Z', lead_id: 1 }, { message_id: 'lg:888', touched_at: '2026-09-11T05:00:00Z', lead_id: 2 },
    { message_id: 'wz1', touched_at: '2026-09-12T05:00:00Z', lead_id: 3 }];
  const ml = [{ meta_lead_id: '777', created_time: '2026-09-10T05:00:00Z', match_status: 'matched', amo_lead_id: 1, account_id: 'act_5', campaign_name: 'SD_X', form_id: '42' },
    { meta_lead_id: '999', created_time: '2026-09-13T05:00:00Z', match_status: 'not_found', amo_lead_id: null }];
  const m = mergeTouches(ad, ml, { act_5: 'Ибрагим' });
  assert.deepEqual(m.map(x => x.message_id), ['ml:777', 'lg:888', 'wz1']);
  assert.equal(m[0].source, 'meta_leadform'); assert.equal(m[0].targetolog, 'Ибрагим'); assert.equal(m[0].lead_id, 1); assert.equal(m[0].campaign, 'SD_X');
});
t('перенос lg:-строки: номер заявки, форма, телефон', () => {
  const r = lgTouchToRow({ message_id: 'lg:123456789', touched_at: '2026-09-01T00:00:00Z', link: 'лидформа 1056856707121847', phone: '0555123456', lead_id: '7' });
  assert.equal(r.meta_lead_id, '123456789'); assert.equal(r.form_id, '1056856707121847'); assert.equal(r.phone_norm, '996555123456'); assert.equal(r.amo_lead_id, 7);
});
t('курс: суббота → курс пятницы; 6 дней без курса → курс из настроек', () => {
  const rates = { '2026-10-02': { USD: 87.4, src: 'nbkr' }, '2026-09-20': { USD: 87.1 } };
  const fx = fxByDay(rates, ['2026-10-03', '2026-09-26'], 88);
  assert.deepEqual(fx.by_day['2026-10-03'], { rate: 87.4, src: 'nbkr', from: '2026-10-02' });
  assert.deepEqual(fx.by_day['2026-09-26'], { rate: 88, src: 'settings', from: null });
  assert.deepEqual(fxByDay(rates, ['2026-09-27'], null).missing_days, ['2026-09-27']);
});
t('решение по кампании по цене квала', () => {
  assert.equal(campaignDecision(9999, 5).label, 'Масштабировать');
  assert.equal(campaignDecision(10000, 5).label, 'Оптимизировать');
  assert.equal(campaignDecision(15000, 5).label, 'Отключить');
  assert.equal(campaignDecision(5000, 2).label, 'мало данных');
  assert.equal(cpqTone(9999), 'ok'); assert.equal(cpqTone(14999), 'mid'); assert.equal(cpqTone(15000), 'bad');
});

// ── v1017: утверждённое «тронул» ──
t('звонок call_out недозвон (status 6, 0 с) — считается', () => {
  const r = firstHumanAction(C0, candidatesOf({ contactNotes: [{ created_at: C0 + 240, created_by: 8, note_type: 'call_out', params: { call_status: 6, duration: 0, source: 'amo_beeline_kg' } }] }));
  assert.deepEqual(r, { at: C0 + 240, by: 8, kind: 'call' });
});
t('входящий call_in — не считается', () => assert.equal(firstHumanAction(C0, candidatesOf({ contactNotes: [{ created_at: C0 + 60, created_by: 8, note_type: 'call_in', params: { call_status: 4 } }] })), null));
t('примечание человека на контакте — считается, робота (ответы формы) — нет', () => {
  assert.equal(firstHumanAction(C0, candidatesOf({ contactNotes: [{ created_at: C0 + 1, created_by: 0, note_type: 'common' }] })), null);
  assert.equal(firstHumanAction(C0, candidatesOf({ contactNotes: [{ created_at: C0 + 90, created_by: 4, note_type: 'common' }] })).kind, 'note');
});
t('WhatsApp Phone — считается и засчитывается ответственному', () => {
  const r = firstHumanAction(C0, candidatesOf({ whatsapp: [wa(120, 'out', 'Phone', 'Добрый день, вы оставляли заявку?')], wa: { responsibleId: 22 } }));
  assert.deepEqual(r, { at: C0 + 120, by: 22, kind: 'whatsapp', by_name: 'Phone' });
});
t('WhatsApp по шаблону автоответа — не считается (и с Phone)', () => assert.equal(firstHumanAction(C0, candidatesOf({
  whatsapp: [wa(10, 'out', 'Phone', 'Здравствуйте. Не смогли принять ваш вызов. Но непременно ответим')], wa: { responsibleId: 22, templates: WA_TEMPLATES_DEFAULT } })), null));
t('WhatsApp без автора и входящие — не считаются', () => assert.equal(firstHumanAction(C0, candidatesOf({
  whatsapp: [wa(10, 'out', '', 'Любой текст'), wa(20, 'in', 'Клиент', 'Привет')], wa: { responsibleId: 22 } })), null));

// ── v1017 (QA) ──
t('сверка: старая сделка по телефону (2025) — заявка потеряна, а не «manual»', () => {
  const d = decideMatch(mrow(), { connectedForms: new Set(['111111']), phoneDeals: new Map([['996555123456', { contact_id: 3, deals: [{ id: 12, created_at: ctS - 200 * 86400, created_by: 7 }, { id: 13, created_at: ctS + 20 * 86400, created_by: 0 }] }]]) });
  assert.equal(d.match_status, 'not_found'); assert.equal(d.lost_reason, 'no_deal');
});
t('сверка: сделка за 23 ч до заявки и через 13 дней — в окне', () => {
  assert.equal(decideMatch(mrow(), { phoneDeals: new Map([['996555123456', { deals: [{ id: 1, created_at: ctS - 23 * 3600, created_by: 7 }] }]]) }).match_status, 'manual');
  assert.equal(decideMatch(mrow(), { phoneDeals: new Map([['996555123456', { deals: [{ id: 1, created_at: ctS + 13 * 86400, created_by: 0 }] }]]) }).match_status, 'renamed');
});
t('ошибка базы без «Failing row» (там телефон)', () => {
  assert.equal(cleanErr(new Error('INSERT-IGNORE meta_leads failed [400]: {"message":"null value", "details":"Failing row contains (123, 996555123456, Азамат)"}')).includes('996555123456'), false);
  assert.equal(cleanErr('ok text'), 'ok text');
});

// ── v1017 (b2): источник сделки ──
t('источник: лидформа по названию и по тегу fb…', () => {
  assert.equal(sourceTypeOf({ name: 'Facebook №1234567890', created_by: 0 }), 'form');
  assert.equal(sourceTypeOf({ name: 'Сделка #5', tags: ['таргет', 'fb1056856707121847'], created_by: 7 }), 'form');
  assert.equal(sourceTypeOf({ name: 'Сделка #5', tags: [{ name: 'fb1056856707121847' }], created_by: 0 }), 'form');
});
t('источник: звонок интеграции телефонии', () => {
  assert.equal(sourceTypeOf({ name: 'Исходящий звонок 0555123456', created_by: 0 }), 'call');
  assert.equal(sourceTypeOf({ name: 'Пропущенный вызов', created_by: 0 }), 'call');
  assert.equal(sourceTypeOf({ name: 'входящий', created_by: 0 }), 'call');
});
t('источник: прочая интеграция — переписка; сотрудник — вручную', () => {
  assert.equal(sourceTypeOf({ name: 'Сделка #77', created_by: 0, tags: ['whatsapp'] }), 'chat');
  assert.equal(sourceTypeOf({ name: 'Исходящий звонок', created_by: 5 }), 'manual');
  assert.equal(sourceTypeOf({ name: 'ТОО Ромашка', created_by: 5, tags: ['fbx'] }), 'manual');
});

// ── v1017 (b2): ночная дозаливка переписок ──
t('отметки дозаливки: соседние и пересекающиеся куски склеиваются', () => {
  const a = { from: '2026-09-09', to: '2026-09-20', matched: 5, checked: 50 };
  assert.deepEqual(mergeBackfillMark(a, { from: '2026-09-21', to: '2026-09-30', done_at: 'x', matched: 2, checked: 20 }),
    { from: '2026-09-09', to: '2026-09-30', done_at: 'x', matched: 7, checked: 70 });
  assert.equal(mergeBackfillMark(a, { from: '2026-09-15', to: '2026-09-25', matched: 0, checked: 1 }).to, '2026-09-25');
  assert.equal(mergeBackfillMark(a, { from: '2026-09-15', to: '2026-09-25', matched: 0, checked: 1 }).from, '2026-09-09');
});
t('отметки дозаливки: разрыв — новая отметка вместо старой; без старой — новая', () => {
  const n = { from: '2026-09-25', to: '2026-09-30', matched: 1, checked: 3 };
  assert.deepEqual(mergeBackfillMark({ from: '2026-09-09', to: '2026-09-20' }, n), n);
  assert.deepEqual(mergeBackfillMark(null, n), n);
});
t('нужна ли дозаливка', () => {
  const rq = { from: '2026-09-09', to: '2026-09-30' };
  assert.equal(backfillNeeded(rq, null), true);
  assert.equal(backfillNeeded(rq, { from: '2026-09-09', to: '2026-09-25' }), true);
  assert.equal(backfillNeeded(rq, { from: '2026-09-10', to: '2026-09-30' }), true);
  assert.equal(backfillNeeded(rq, { from: '2026-09-01', to: '2026-10-01' }), false);
  assert.equal(backfillNeeded(null, null), false);
});

t('дозаливка: куски ≤45 дней с конца отметки, не дальше сегодня', () => {
  const rq = { from: '2026-07-01', to: '2026-09-30' };
  assert.deepEqual(backfillPiece(rq, null, '2026-10-03'), { from: '2026-07-01', to: '2026-08-14' });
  assert.deepEqual(backfillPiece(rq, { from: '2026-07-01', to: '2026-08-14' }, '2026-10-03'), { from: '2026-08-15', to: '2026-09-28' });
  assert.deepEqual(backfillPiece(rq, { from: '2026-07-01', to: '2026-09-28' }, '2026-10-03'), { from: '2026-09-29', to: '2026-09-30' });
  assert.equal(backfillPiece(rq, { from: '2026-06-01', to: '2026-09-30' }, '2026-10-03'), null);
  assert.deepEqual(backfillPiece({ from: '2026-09-09', to: '2026-10-10' }, null, '2026-10-03'), { from: '2026-09-09', to: '2026-10-03' });
  assert.deepEqual(backfillPiece(rq, { from: '2026-08-01', to: '2026-08-20' }, '2026-10-03'), { from: '2026-07-01', to: '2026-08-14' });
});

// ── v1019: закрытие месяца ──
t('месяц: границы по Бишкеку, прошлый месяц, когда закрывать', () => {
  const mi = monthInfo('2026-09', 'KG');
  assert.equal(mi.first, '2026-09-01'); assert.equal(mi.until, '2026-09-30'); assert.equal(mi.days.length, 30);
  assert.equal(mi.fromTs, Date.parse('2026-09-01T00:00:00+06:00') / 1000); assert.equal(mi.toTs, Date.parse('2026-10-01T00:00:00+06:00') / 1000 - 1);
  assert.equal(prevMonthOf('2026-10-05'), '2026-09'); assert.equal(prevMonthOf('2027-01-05'), '2026-12');
  assert.equal(closeDue(5, 6), false); assert.equal(closeDue(5, 7), true); assert.equal(closeDue(6, 0), true); assert.equal(closeDue(4, 23), false);
  assert.equal(monthInfo('2026-13', 'KG'), null);
});
t('курс по дням: НБКР за день / архив / из Настроек / смешанный', () => {
  const rates = { '2026-09-01': { USD: 87.4, src: 'nbkr' }, '2026-09-02': { USD: 87.5, src: 'nbkr_archive' }, '2026-09-03': { KZT: 0.17, src: 'nbkr' } };
  const fx = fxForDays(rates, ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-20'], 88);
  assert.equal(fx.by_day['2026-09-01'].kind, 'daily'); assert.equal(fx.by_day['2026-09-02'].kind, 'archive');
  assert.equal(fx.by_day['2026-09-03'].kind, 'archive'); // ближайший опубликованный — 02.09 (архив)
  assert.equal(fx.by_day['2026-09-20'].kind, 'settings'); assert.equal(fx.source, 'mixed');
  assert.deepEqual([fx.days_daily, fx.days_archive, fx.days_settings], [1, 2, 1]);
  assert.equal(fxSourceOf({ daily: 30 }), 'daily'); assert.equal(fxSourceOf({ archive: 30 }), 'archive'); assert.equal(fxSourceOf({ settings: 30 }), 'settings');
  assert.deepEqual(fxForDays({}, ['2026-09-20'], null).missing, ['2026-09-20']);
});
const NBKR_SNIPPET = "<tr bgcolor=\"#EDEEEF\"><td class=\"stat-center\"><!--date-->30.09.2026<!--date--></td><td class=\"stat-right\"><!--value-->87,4483<!--value-->&nbsp;&nbsp;</td></tr><tr bgcolor=\"#EDEEEF\"><td class=\"stat-center\"><!--date-->29.09.2026<!--date--></td><td class=\"stat-right\"><!--value-->87,4485<!--value-->&nbsp;&nbsp;</td></tr><tr bgcolor=\"#EDEEEF\"><td class=\"stat-center\"><!--date-->28.09.2026<!--date--></td><td class=\"stat-right\"><!--value-->87,4482<!--value-->&nbsp;&nbsp;</td></tr><tr bgcolor=\"#EDEEEF\"><td class=\"stat-cente";
t('архив НБКР: разбор строк «дата → курс»', () => {
  const a = parseNbkrArchive(NBKR_SNIPPET);
  assert.equal(a['2026-09-30'], 87.4483); assert.equal(a['2026-09-29'], 87.4485);
  assert.ok(Object.keys(a).length >= 2);
  assert.deepEqual(parseNbkrArchive('<html>нет данных</html>'), {});
});
t('архив НБКР: дописываем только дни без доллара, существующие не трогаем', () => {
  const pl = planFxFill({ '2026-09-29': { USD: 87.1, src: 'nbkr' }, '2026-09-30': { KZT: 0.17 } }, { '2026-09-29': 87.4485, '2026-09-30': 87.4483 }, '2026-09-28', '2026-09-30');
  assert.deepEqual(pl.filled, ['2026-09-30']); assert.deepEqual(pl.skipped, ['2026-09-28', '2026-09-29']);
});
const key = { country: 'KG', product: 'SD', month: '2026-09-01' };
t('закрытие: закрытую строку не трогаем никогда', () => {
  assert.deepEqual(decideCloseWrite({ status: 'closed', attempts: 1 }, { ok: true, row: { spend_som: 1 } }, key, 'T'), { action: 'skip' });
  assert.deepEqual(decideCloseWrite({ status: 'closed' }, { ok: false, error: 'x' }, key, 'T'), { action: 'skip' });
});
t('закрытие: неудачи считаются, цифр нет, причина без телефонов', () => {
  const a = decideCloseWrite(null, { ok: false, error: 'amo 502' }, key, 'T1');
  assert.equal(a.row.status, 'failed'); assert.equal(a.row.attempts, 1); assert.equal(a.row.spend_som, null); assert.equal(a.row.last_attempt_at, 'T1');
  const b = decideCloseWrite(a.row, { ok: false, error: 'Failing row contains (996555123456)' }, key, 'T2');
  assert.equal(b.row.attempts, 2); assert.equal(b.row.last_error.includes('996555123456'), false);
  const c = decideCloseWrite(b.row, { ok: true, row: { spend_som: 100, leads_ad: 5 } }, key, 'T3');
  assert.equal(c.row.status, 'closed'); assert.equal(c.row.attempts, 3); assert.equal(c.row.closed_at, 'T3'); assert.equal(c.row.closed_by, 'cron'); assert.equal(c.row.leads_ad, 5);
  assert.equal(shortErr('ошибка 77011234567').includes('77011234567'), false);
});
t('пересчёт: история «было → стало», закрытие не сдвигается', () => {
  const ex = { status: 'closed', closed_at: 'T0', closed_by: 'cron', attempts: 1, recalc_count: 0, spend_som: 100, leads_ad: 5, lead_ids_ad: [1, 2] };
  const r = buildRecalc(ex, { spend_som: 120, leads_ad: 6, lead_ids_ad: [1, 2, 3] }, 'ceo@salesdoc.io', 'добавили оплаты', key, 'T9');
  assert.equal(r.update.closed_at, 'T0'); assert.equal(r.update.closed_by, 'cron'); assert.equal(r.update.recalc_count, 1); assert.equal(r.update.recalculated_at, 'T9');
  assert.equal(r.history.old_row.spend_som, 100); assert.equal(r.history.new_row.spend_som, 120); assert.equal(r.history.old_row.lead_ids_ad, undefined);
  assert.equal(r.history.changed_by, 'ceo@salesdoc.io'); assert.equal(r.history.reason, 'добавили оплаты');
  assert.ok(buildRecalc(ex, {}, 'a', 'кор', key, 'T').error);
  const f = buildRecalc({ status: 'failed', attempts: 4 }, { spend_som: 1 }, 'ceo@salesdoc.io', 'закрыть руками', key, 'T5');
  assert.equal(f.update.status, 'closed'); assert.equal(f.update.closed_by, 'ceo@salesdoc.io'); assert.equal(f.update.closed_at, 'T5'); assert.equal(f.update.recalc_count, 0);
});
t('пересчёт: только администратор с подписанной сессией', () => {
  assert.equal(recalcAccess({ role: 'admin', trusted: true }), 'ok');
  assert.equal(recalcAccess({ role: 'admin', trusted: false }), 'need_login');
  assert.equal(recalcAccess({ role: 'head', trusted: true }), 'forbidden');
  assert.equal(recalcAccess({ role: 'admin', trusted: true, active: false }), 'forbidden');
  assert.equal(recalcAccess(null), 'need_login');
});
t('уточнено после закрытия: прибавилось / ушло', () => {
  assert.deepEqual(idsDelta([1, 2, 3], [2, 3, 4, 5]), { added: 2, removed: 1 });
  const rp = { qual_stage: { sort: 30 }, leads: [{ id: 1, product: 'SD', arrival_kind: 'ad', reached_sort: 40 }, { id: 2, product: 'SD', arrival_kind: 'organic' }, { id: 3, product: 'Z24', arrival_kind: 'ad' }, { id: 4, arrival_kind: 'return', reached_sort: 10 }] };
  assert.deepEqual(liveIdsOf(rp, 'SD'), { ad: [1, 4], qual: [1] });
  assert.equal(liveIdsOf(rp, 'Z24'), null);
});
t('строка закрытия: цифры месяца из рекламы и amo', () => {
  const mi = monthInfo('2026-09', 'KG');
  const fx = fxForDays({ '2026-09-01': { USD: 87, src: 'nbkr' }, '2026-09-02': { USD: 88, src: 'nbkr' } }, ['2026-09-01', '2026-09-02'], null);
  const meta = { geo: { countries: [{ code: 'KG', spend: 30, impressions: 1000, link_clicks: 50, clicks: 70, leads: 4 }, { code: 'KZ', spend: 999 }], accounts: [{ msgs: 6 }] },
    daily: { days: [{ date: '2026-09-01', by_country: { KG: { spend: 10 }, KZ: { spend: 500 } } }, { date: '2026-09-02', by_country: { KG: { spend: 20 } } }] },
    camps: { campaigns: [{ id: 'c1', name: 'SD_KG_LF', by_country: { KG: { spend: 30 } } }] } };
  const rp = { qual_stage: { id: 3, name: 'Квалификация пройдена', sort: 30 }, meet_stage: { sort: 40 }, stages: [{ id: 1, name: 'Неразобранное', sort: 10 }, { id: 3, name: 'Квал', sort: 30 }],
    leads: [{ id: 1, product: 'SD', arrival_kind: 'ad', reached_sort: 30, source_type: 'form', manager: 'Асель', touch: { campaign_id: 'c1' } },
      { id: 2, product: 'SD', arrival_kind: 'ad', reached_sort: 10, source_type: 'chat', manager: 'Асель', is_lost: true, loss_reason: 'Дорого', touch: { campaign_id: 'c1' } },
      { id: 3, product: 'SD', arrival_kind: 'organic', reached_sort: 30, source_type: 'manual', manager: 'Бакыт' }] };
  const recon = { recon: { meta_total: 7, lost: { total: 1 }, pending_new: 0 } };
  const b = buildCloseRow({ product: 'SD', month: mi, meta, rp, recon, work: { leads: { 2: { taken_at: null, wait_wmin: 90 } }, managers: [] }, fx });
  assert.deepEqual(b.holes, []);
  assert.equal(b.row.spend_usd, 30); assert.equal(b.row.spend_som, 10 * 87 + 20 * 88); assert.equal(b.row.fx_source, 'daily');
  assert.deepEqual([b.row.leads_ad, b.row.leads_all, b.row.quals_ad, b.row.quals_all], [2, 3, 1, 2]);
  assert.equal(b.row.cpl_som, Math.round(2630 / 2)); assert.equal(b.row.cpq_som, 2630);
  assert.deepEqual(b.row.lead_ids_ad, [1, 2]); assert.deepEqual(b.row.lead_ids_qual, [1]);
  assert.equal(b.row.meta_form_leads, 7); assert.equal(b.row.lost, 1);
  assert.deepEqual(b.row.details.sources_ad, { form: 1, chat: 1, call: 0, manual: 0 });
  assert.equal(b.row.details.not_taken.ad.untaken, 1); assert.equal(b.row.details.not_taken.ad.late, 1);
  assert.equal(b.row.details.managers.ad[0].n, 1); // лид без «взял» в менеджерах не считается
  assert.deepEqual(b.row.details.loss_reasons.ad, [{ reason: 'Дорого', n: 1 }]);
  assert.equal(b.row.details.campaigns[0].leads, 2); assert.equal(b.row.details.campaigns[0].qual, 1);
  assert.equal(b.row.details.meta.meta_leads, 10);
  const z = buildCloseRow({ product: 'Z24', month: mi, meta, rp, recon, work: null, fx });
  assert.equal(z.row.leads_ad, null); assert.equal(z.row.spend_usd, 30);
  const hole = buildCloseRow({ product: 'SD', month: mi, meta, rp, recon, work: null, fx: fxForDays({}, ['2026-09-01'], null) });
  assert.ok(hole.holes.length && /курса/.test(hole.holes[0]));
});

console.log(`\n${pass} ok, ${fail} fail`);
process.exit(fail ? 1 : 0);
