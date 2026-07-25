# Apps Script v823 — экшен appendPayment (запись оплаты в «Доходы»)

Зачем: с v823 оплату можно внести прямо в программе (форма «+ Оплата»). Программа сохраняет
платёж в Supabase и ДУБЛИРУЕТ строку в Google-таблицу «Доходы» — таблица остаётся страховкой.
Для этого Apps Script должен уметь дописывать строку в лист месяца. Пока экшен не задеплоен,
форма работает, но пишет только в Supabase и честно показывает «в таблицу не записалось».

## Где это править

Проект **«SalesDoc — Users API (Reset/Disable Password) v152»** на script.google.com
(standalone-проект с doPost: resetPassword/updatePassword/disableUser/enableUser).
Его деплой: `AKfycbwLMv7nA0ymu9wP6CPnQRXo9kf2sGkPyllFPq-3tHQPRpGUccZdjhlvEBcAxKAmeCtLPQ` —
этот же URL вписан в api/payments.js как APPEND_GS_URL. НЕ путать с деплоем чтения
таблиц (`AKfycbwwNL4...` в SHEET_CONFIG) — это разные проекты.

1. script.google.com → проект «SalesDoc — Users API...» → файл `Код.gs`.
2. Добавь функцию ниже в конец файла и ветку в `doPost`.
3. **Развернуть → Управлять развёртываниями → ✏️ → Версия: новая → Развернуть**.
   URL должен остаться прежним — не создавай новое развёртывание.

> 25.07.2026: код добавлен и задеплоен автоматически (Claude через Chrome). Файл оставлен
> как документация на случай пересоздания скрипта.

## 1. Код

```javascript
// === v823: APPEND PAYMENT ===================================================
// Дописывает строку оплаты в лист месяца таблицы «Доходы».
// Колонки: A=Дата, B=Компания, C=Статья, E=Кол-во лиц., F=Менеджер,
//          H=Цена, I=Период мес, J=Сумма план, K=Банк, M=Сумма факт.
// Дата приходит ISO (YYYY-MM-DD), УЖЕ скорректированная сервером под dateCorrection —
// кладём настоящий Date. LockService — чтобы две одновременные оплаты не легли в одну строку.

function appendPaymentAction(spreadsheetId, sheetName, r) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000); // ждём до 20с, если параллельно пишется другая оплата
  try {
    var ss = SpreadsheetApp.openById(spreadsheetId);
    var sh = ss.getSheetByName(sheetName);
    if (!sh) {
      // регистр названий листов в KG гуляет («июль» вместо «Июль») — ищем без учёта регистра
      var all = ss.getSheets();
      for (var i = 0; i < all.length; i++) {
        if (all[i].getName().toLowerCase() === String(sheetName).toLowerCase()) { sh = all[i]; break; }
      }
    }
    if (!sh) return { ok: false, error: 'sheet not found: ' + sheetName };
    r = r || {};
    var dateVal = '';
    var dm = String(r.date || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (dm) dateVal = new Date(+dm[1], +dm[2] - 1, +dm[3]);
    // одна строка одним вызовом (A..M): D, G, L остаются пустыми
    sh.appendRow([
      dateVal,                                  // A Дата
      r.company || '',                          // B Компания
      r.category || '',                         // C Статья
      '',                                       // D
      r.qty != null ? r.qty : '',               // E Кол-во лицензий
      r.manager || '',                          // F Менеджер
      '',                                       // G
      r.price != null ? r.price : '',           // H Цена
      r.period != null ? r.period : '',         // I Период (мес)
      r.amountPlan != null ? r.amountPlan : '', // J Сумма план
      r.bank || '',                             // K Банк
      '',                                       // L
      r.amountFact != null ? r.amountFact : ''  // M Сумма факт
    ]);
    return { ok: true, rowIndex: sh.getLastRow() };
  } finally {
    lock.releaseLock();
  }
}
```

## 2. Ветка в doPost

В существующем `doPost(e)` рядом с другими экшенами:

```javascript
  } else if (p.action === 'appendPayment') {
    result = appendPaymentAction(p.spreadsheetId, p.sheet, p.row);
```

## 3. Проверка после деплоя

1. В дашборде (страна KG) нажми «+ Оплата», внеси тестовый платёж на 1 сом с понятным
   названием клиента.
2. Тост должен сказать, что записалось и в базу, и в таблицу.
3. Открой «Доходы KG» → лист текущего месяца → внизу должна появиться строка с датой,
   компанией, статьёй и суммой в колонке M.
4. Проверка защиты от дублей: подожди часовой крон (или дёрни импорт вручную) и убедись,
   что платёж в разделе «Платежи» остался ОДИН.
5. Тестовую строку можно удалить из листа и платёж из программы (удаление доступно
   только для ручных; если платёж уже помечен как sheets_import — удали строку в листе
   и запусти пересборку месяца, либо удали запись через Supabase).
