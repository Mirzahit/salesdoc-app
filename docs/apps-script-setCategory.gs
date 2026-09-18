// v1002: экшен setCategory для деплоя «SalesDoc — Users API (Reset/Disable Password) v152»
// (тот же проект, где appendPayment и setSeated).
//
// ЧТО ДЕЛАЕТ: клик по статье в таблице оплат (или поле «Статья» в форме «Изменить») пишет
// новую статью в колонку C листа «Доходы». Без этого экшена программа выдаёт ошибку
// «лист не обновился», откатывает базу и ничего не портит.
//
// КАК УСТАНОВИТЬ (2 минуты). В скрипте doPost — диспетчер по p.action, а сами действия —
// отдельные функции (setSeatedAction и т.п.). Нужно две вставки:
//
// 1. В doPost после строк
//        } else if (p.action === 'setSeated') {
//          result = setSeatedAction(sid, p.sheet, p.row, p.company, p.value);
//    добавить ветку:

    } else if (p.action === 'setCategory') {
      result = setCategoryAction(sid, p.sheet, p.row, p.company, p.value);

// 2. В конец файла (после setSeatedAction) добавить функцию:

// v1002: смена статьи из программы — пишет новую статью в колонку C листа «Доходы».
// Перед записью сверяет компанию (колонка B): если строки листа сдвинулись — отказ, чужую запись не портим.
function setCategoryAction(spreadsheetId, sheetName, rowIndex, company, value) {
  var ss = SpreadsheetApp.openById(spreadsheetId);
  var sh = ss.getSheetByName(sheetName);
  if (!sh) return { ok: false, error: 'лист «' + sheetName + '» не найден' };
  var row = parseInt(rowIndex, 10);
  if (!row || row < 2) return { ok: false, error: 'некорректная строка' };
  var val = String(value || '').trim();
  if (!val) return { ok: false, error: 'статья пустая' };
  var comp = String(sh.getRange(row, 2).getValue() || '').trim();
  if (company && comp && comp.toLowerCase() !== String(company).trim().toLowerCase()) {
    return { ok: false, error: 'строка сместилась: в листе «' + comp + '», ожидали «' + company + '». Дождитесь синка (раз в час) и повторите.' };
  }
  sh.getRange(row, 3).setValue(val); // C — Статья
  return { ok: true, rowIndex: row };
}

// 3. Ctrl+S, затем: Начать развертывание → Управление развертываниями → карандаш →
//    Версия: Новая версия → Развернуть. URL остаётся прежним, в программе ничего менять не нужно.
