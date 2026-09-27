// Сопоставление вкладки листа «Доходы» с базой (план v1011, CEO 27.09.2026). Чистая функция — без обращений к базе,
// поэтому её можно прогнать «на чтение» на настоящих данных до включения.
//
// ЗАЧЕМ. Раньше импорт сопоставлял только по номеру строки и удалял из базы оплаты, чьей строки в листе нет.
// После удаления строк Б июля (23.09) крон молча стёр из базы 51 оплату с чеками. Теперь:
//   1) оплата = клиент + дата + сумма (ключ содержания), одинаковые считаются ПО КОЛИЧЕСТВУ:
//      три строки «Суйор 12 480» в листе и три в базе — все три на месте; в листе две — помечается одна;
//   2) строка переехала (сдвиг после удаления/вставки выше) — меняется только номер строки;
//   3) на том же месте тот же клиент и дата, но другая сумма/статья — это правка, обновляется на месте;
//   4) оплата, которой нет ни в одной строке вкладки, НЕ удаляется — помечается «пропала из таблицы» (sheet_missing_at);
//   5) строка есть физически (непустая «Компания»), но не разобралась — её оплату не трогаем вовсе;
//   6) если за раз пропадает больше 30% оплат вкладки — вкладку не трогаем (похоже на битую загрузку листа).

export const MISSING_GUARD_SHARE = 0.3;

export function normCompany(s) { return String(s || '').toLowerCase().replace(/[«»"'`.,()]/g, ' ').replace(/\s+/g, ' ').trim(); }
export function contentKey(r) { return normCompany(r.company_name) + '::' + String(r.paid_at || '').slice(0, 10) + '::' + Math.round(parseFloat(r.amount || 0)); }
function sameClientDay(a, b) { return normCompany(a.company_name) === normCompany(b.company_name) && String(a.paid_at || '').slice(0, 10) === String(b.paid_at || '').slice(0, 10); }

// sheetRows — разобранные строки листа этой вкладки (sheet_row, company_name, paid_at, amount, …)
// dbRows    — оплаты базы этой вкладки (sheets_import, та же таблица), в т.ч. уже помеченные пропавшими (sheet_row может быть null)
// physicalRows — Set номеров строк, где «Компания» не пустая (даже если строка не разобралась)
export function planTabSync(sheetRows, dbRows, physicalRows) {
  const S = sheetRows.slice().sort((a, b) => a.sheet_row - b.sheet_row);
  const E = dbRows.slice().sort((a, b) => (a.sheet_row || 1e9) - (b.sheet_row || 1e9));
  const pairs = [];          // { s, e, how: 'same' | 'moved' | 'edited' }
  const usedS = new Set(), usedE = new Set();
  // 1) на своём месте с тем же содержанием
  const eByRow = new Map(); E.forEach(e => { if (e.sheet_row != null) eByRow.set(e.sheet_row, e); });
  for (const s of S) { const e = eByRow.get(s.sheet_row); if (e && !usedE.has(e.id) && contentKey(e) === contentKey(s)) { pairs.push({ s, e, how: 'same' }); usedS.add(s); usedE.add(e.id); } }
  // 2) то же содержание на другом месте — по количеству, по порядку строк
  const freeE = new Map();
  for (const e of E) { if (usedE.has(e.id)) continue; const k = contentKey(e); if (!freeE.has(k)) freeE.set(k, []); freeE.get(k).push(e); }
  for (const s of S) { if (usedS.has(s)) continue; const list = freeE.get(contentKey(s)); if (list && list.length) { const e = list.shift(); pairs.push({ s, e, how: 'moved' }); usedS.add(s); usedE.add(e.id); } }
  // 3) правка на месте: та же строка, тот же клиент и дата, другое содержание (сумма)
  for (const s of S) { if (usedS.has(s)) continue; const e = eByRow.get(s.sheet_row); if (e && !usedE.has(e.id) && sameClientDay(e, s)) { pairs.push({ s, e, how: 'edited' }); usedS.add(s); usedE.add(e.id); } }
  const inserts = S.filter(s => !usedS.has(s));
  const leftE = E.filter(e => !usedE.has(e.id));
  const untouched = leftE.filter(e => e.sheet_row != null && physicalRows && physicalRows.has(e.sheet_row) && !S.some(s => s.sheet_row === e.sheet_row)); // строка есть, но не разобралась
  const missing = leftE.filter(e => !untouched.includes(e));
  const newlyMissing = missing.filter(e => !e.sheet_missing_at);
  const liveCount = E.filter(e => !e.sheet_missing_at).length;
  const guard = liveCount >= 10 && newlyMissing.length > liveCount * MISSING_GUARD_SHARE;
  // номера строк, которые займут оплаты листа, — пропавшие с этими номерами надо освободить (sheet_row → null)
  const takenRows = new Set(S.map(s => s.sheet_row));
  const release = missing.filter(e => e.sheet_row != null && takenRows.has(e.sheet_row)).map(e => e.id);
  const moves = pairs.filter(p => p.s.sheet_row !== p.e.sheet_row).map(p => ({ id: p.e.id, from: p.e.sheet_row, to: p.s.sheet_row }));
  const restored = pairs.filter(p => p.e.sheet_missing_at).map(p => p.e.id); // строку вернули — снять пометку
  return { pairs, moves, inserts, missing, newlyMissing, release, restored, untouched, guard };
}
