// v828: экшен setSeated для деплоя «SalesDoc — Users API» (тот же, где appendPayment).
//
// ЧТО ДЕЛАЕТ: кнопка «Посажена» в программе теперь пишет «Да»/«Нет» в колонку L листа
// «Доходы» — как это делал бот. Без этого экшена кнопка выдаёт ошибку и ничего не портит.
//
// КАК УСТАНОВИТЬ (2 минуты):
// 1. script.google.com → проект «SalesDoc — Users API» (где добавляли appendPayment в v823)
// 2. В функции doPost, рядом с веткой appendPayment, вставить блок ниже
//    (var data = JSON.parse(e.postData.contents) там уже есть)
// 3. Deploy → Manage deployments → карандаш → Version: New version → Deploy
//    (URL остаётся прежним, в программе ничего менять не нужно)
//
// ---- ВСТАВИТЬ В doPost: ----

if (data.action === 'setSeated') {
  try {
    var ssS = SpreadsheetApp.openById(data.spreadsheetId);
    var shS = ssS.getSheetByName(data.sheet);
    if (!shS) {
      return ContentService.createTextOutput(JSON.stringify({ ok: false, error: 'лист «' + data.sheet + '» не найден' }))
        .setMimeType(ContentService.MimeType.JSON);
    }
    var rowS = parseInt(data.row, 10);
    if (!rowS || rowS < 2) {
      return ContentService.createTextOutput(JSON.stringify({ ok: false, error: 'некорректная строка' }))
        .setMimeType(ContentService.MimeType.JSON);
    }
    // Защита от сдвига строк: колонка B (Компания) должна совпасть с ожидаемой.
    // Если в листе добавили/удалили строку выше — честно отказываем, а не портим чужую запись.
    var compS = String(shS.getRange(rowS, 2).getValue() || '').trim();
    if (data.company && compS && compS.toLowerCase() !== String(data.company).trim().toLowerCase()) {
      return ContentService.createTextOutput(JSON.stringify({ ok: false, error: 'строка сместилась: в листе «' + compS + '», ожидали «' + data.company + '». Дождитесь ближайшего синка (раз в час) и повторите.' }))
        .setMimeType(ContentService.MimeType.JSON);
    }
    shS.getRange(rowS, 12).setValue(String(data.value || 'Да')); // L — «Посажена»
    return ContentService.createTextOutput(JSON.stringify({ ok: true }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (errS) {
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: String(errS && errS.message || errS) }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}
