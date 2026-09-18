// v1002: экшен setCategory для деплоя «SalesDoc — Users API» (тот же, где appendPayment и setSeated).
//
// ЧТО ДЕЛАЕТ: клик по статье в таблице оплат (или поле «Статья» в форме «Изменить») пишет
// новую статью в колонку C листа «Доходы». Без этого экшена программа выдаёт ошибку
// «лист не обновился», откатывает базу и ничего не портит.
//
// КАК УСТАНОВИТЬ (2 минуты):
// 1. script.google.com → проект «SalesDoc — Users API» (где добавляли setSeated в v828)
// 2. В функции doPost, рядом с веткой setSeated, вставить блок ниже
//    (var data = JSON.parse(e.postData.contents) там уже есть)
// 3. Deploy → Manage deployments → карандаш → Version: New version → Deploy
//    (URL остаётся прежним, в программе ничего менять не нужно)
//
// ---- ВСТАВИТЬ В doPost: ----

if (data.action === 'setCategory') {
  try {
    var ssC = SpreadsheetApp.openById(data.spreadsheetId);
    var shC = ssC.getSheetByName(data.sheet);
    if (!shC) {
      return ContentService.createTextOutput(JSON.stringify({ ok: false, error: 'лист «' + data.sheet + '» не найден' }))
        .setMimeType(ContentService.MimeType.JSON);
    }
    var rowC = parseInt(data.row, 10);
    if (!rowC || rowC < 2) {
      return ContentService.createTextOutput(JSON.stringify({ ok: false, error: 'некорректная строка' }))
        .setMimeType(ContentService.MimeType.JSON);
    }
    var valC = String(data.value || '').trim();
    if (!valC) {
      return ContentService.createTextOutput(JSON.stringify({ ok: false, error: 'статья пустая' }))
        .setMimeType(ContentService.MimeType.JSON);
    }
    // Защита от сдвига строк: колонка B (Компания) должна совпасть с ожидаемой.
    var compC = String(shC.getRange(rowC, 2).getValue() || '').trim();
    if (data.company && compC && compC.toLowerCase() !== String(data.company).trim().toLowerCase()) {
      return ContentService.createTextOutput(JSON.stringify({ ok: false, error: 'строка сместилась: в листе «' + compC + '», ожидали «' + data.company + '». Дождитесь ближайшего синка (раз в час) и повторите.' }))
        .setMimeType(ContentService.MimeType.JSON);
    }
    shC.getRange(rowC, 3).setValue(valC); // C — «Статья»
    return ContentService.createTextOutput(JSON.stringify({ ok: true }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (errC) {
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: String(errC && errC.message || errC) }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}
