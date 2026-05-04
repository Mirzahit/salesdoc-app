# Apps Script v152 — добавить write-экшены для Users

## Где это править

1. Открой Sheet «Академия Sales Doctor».
2. Меню **Расширения → Apps Script**.
3. В файле `Code.gs` (тот, где сейчас лежит код с `doGet`/`doPost`/`updateAvatar`) — добавь блок ниже **в конец файла** и обнови `doPost`, чтобы он понимал новые `action`.
4. Сверху-справа кнопка **Развернуть → Управлять развёртываниями → ✏️ → Версия: новая → Развернуть**. Без этого фронт продолжит видеть старую версию.

> URL развёртывания **должен остаться тот же** (`AKfycbww...vg/exec`). Если Apps Script предлагает создать новое развёртывание — нет, выбирай существующее и обнови его версию.

---

## 1. Колонка `is_temp` в Sheet

Sheet «Users» → ячейка **J1** → впиши заголовок: `is_temp`.

Содержимое ячеек J2:J… не трогай — пустота интерпретируется как FALSE.

---

## 2. Код для Apps Script

```javascript
// === v152: USERS WRITE-ENDPOINTS ============================================
// Колонки в листе "Users":
// A=id, B=name, C=pos, D=email, E=pass_hash, F=role, G=bonus, H=active, I=country, J=is_temp

function _findUserRow(sheet, userId) {
  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(userId)) return i + 1; // 1-based
  }
  return -1;
}

function resetPasswordAction(spreadsheetId, userId, passHash) {
  var ss = SpreadsheetApp.openById(spreadsheetId);
  var sh = ss.getSheetByName('Users');
  var row = _findUserRow(sh, userId);
  if (row < 0) return { ok: false, error: 'user not found' };
  sh.getRange(row, 5).setValue(passHash);   // E pass_hash
  sh.getRange(row, 10).setValue(true);      // J is_temp
  return { ok: true };
}

function updatePasswordAction(spreadsheetId, userId, passHash) {
  var ss = SpreadsheetApp.openById(spreadsheetId);
  var sh = ss.getSheetByName('Users');
  var row = _findUserRow(sh, userId);
  if (row < 0) return { ok: false, error: 'user not found' };
  sh.getRange(row, 5).setValue(passHash);   // E pass_hash
  sh.getRange(row, 10).setValue(false);     // J is_temp снимаем
  return { ok: true };
}

function disableUserAction(spreadsheetId, userId, passHash) {
  var ss = SpreadsheetApp.openById(spreadsheetId);
  var sh = ss.getSheetByName('Users');
  var row = _findUserRow(sh, userId);
  if (row < 0) return { ok: false, error: 'user not found' };
  sh.getRange(row, 5).setValue(passHash || ('disabled-' + Utilities.formatDate(new Date(),'GMT','yyyy-MM-dd')));
  sh.getRange(row, 8).setValue(false);      // H active
  return { ok: true };
}

function enableUserAction(spreadsheetId, userId) {
  var ss = SpreadsheetApp.openById(spreadsheetId);
  var sh = ss.getSheetByName('Users');
  var row = _findUserRow(sh, userId);
  if (row < 0) return { ok: false, error: 'user not found' };
  sh.getRange(row, 8).setValue(true);       // H active
  return { ok: true };
}
```

---

## 3. Подключение к `doPost`

Найди существующий `doPost(e)` в Code.gs — там уже есть ветка для `updateAvatar`. Добавь рядом ветки для новых экшенов. Должно получиться примерно так:

```javascript
function doPost(e) {
  var p = JSON.parse(e.postData.contents);
  var sid = p.spreadsheetId;
  var result;
  if (p.action === 'updateAvatar') {
    result = updateAvatarAction(sid, p.userId, p.avatar);    // существующий
  } else if (p.action === 'resetPassword') {
    result = resetPasswordAction(sid, p.userId, p.passHash);
  } else if (p.action === 'updatePassword') {
    result = updatePasswordAction(sid, p.userId, p.passHash);
  } else if (p.action === 'disableUser') {
    result = disableUserAction(sid, p.userId, p.passHash);
  } else if (p.action === 'enableUser') {
    result = enableUserAction(sid, p.userId);
  } else {
    result = { error: 'Unknown action: ' + p.action };
  }
  return ContentService.createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}
```

Если в твоём `doPost` структура другая — главное чтобы все четыре новые ветки попали в роутинг.

---

## 4. После сохранения

1. **Развернуть → Управлять развёртываниями → ✏️ → Версия: новая → Развернуть**.
2. Открой дашборд (после Vercel-деплоя v152 — ~30 секунд).
3. В Sheet → Users → возьми любого тестового сотрудника (можно Asem, она и так уволена) → в дашборде в карточке нажми «🔁 Сбросить пароль» → подтверди.
4. Проверь Sheet — у Asem колонка E должна стать `8d969eef…` (хеш `123456`), J должна стать `TRUE`.
5. Если так — всё работает. Если нет — F12 → Console → ищи ошибки от `_apiUsers`.
