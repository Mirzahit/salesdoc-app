/**
 * SalesDoc Telegram Bot — backend для операторов (Айдос/Акбар/Самат) + CEO.
 *
 * Setup-чеклист (одна страница: см. BOT-SETUP.md):
 *  1. @BotFather → создать бота → получить BOT_TOKEN
 *  2. Apps Script: новый проект → вставить этот файл
 *  3. Script Properties: BOT_TOKEN, SPREADSHEET_ID (тот же что у канбана)
 *  4. Deploy as Web App (Execute as: Me, Access: Anyone) → копируем WEB_APP_URL
 *  5. Открыть в браузере: https://api.telegram.org/bot{BOT_TOKEN}/setWebhook?url={WEB_APP_URL}
 *  6. Time-triggers (в GAS UI):
 *      - dailyMorning: каждое утро в 08:00
 *      - slaCheck: каждый час
 *      - eventPusher: каждую минуту
 *  7. Открыть бота в Telegram, написать /start ADMIN-CODE — привязка CEO
 *  8. Каждому оператору сгенерировать invite-код в SalesDoc (/Управление/Telegram-бот)
 *     и передать команду /start ИМЯ-КОД
 *
 * Структура Sheets:
 *  Карточки         — канбан (существующий, читаем)
 *  Operators        — name | telegram_id | invite_code | role (operator|ceo) | active | tz
 *  Bot Events       — id | created_at | type | target | payload | status | sent_at
 *  Bot SLA          — stage | limit_days       (дни-лимит на этап)
 *
 * Бот сам создаёт листы Operators / Bot Events / Bot SLA при первом запуске
 * через initSheets() — больше ничего вручную делать не надо.
 */

var BOT_TOKEN = PropertiesService.getScriptProperties().getProperty('BOT_TOKEN');
var SHEET_ID = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
var TG_API = 'https://api.telegram.org/bot' + BOT_TOKEN;

var SHEETS = {
 cards: 'Карточки',
 operators: 'Operators',
 events: 'Bot Events',
 sla: 'Bot SLA'
};

var DEFAULT_SLA = [
 ['В очереди', 3],
 ['Взят в работу', 7],
 ['Настройка сервера', 5],
 ['Обучение полевых', 7],
 ['Обучения офисных', 5],
 ['Обучение Руководства', 3],
 ['Активация', 2]
];

// ===== ENTRY POINTS =====

function doGet(e){
 return ContentService.createTextOutput(JSON.stringify({ok:true, time:new Date().toISOString()}))
 .setMimeType(ContentService.MimeType.JSON);
}

function doPost(e){
 try {
 var update = JSON.parse(e.postData.contents);
 if(update.message) handleMessage(update.message);
 else if(update.callback_query) handleCallback(update.callback_query);
 } catch(err){
 logError('doPost', err);
 }
 return ContentService.createTextOutput('ok');
}

// ===== INIT =====

function initSheets(){
 var ss = SpreadsheetApp.openById(SHEET_ID);
 if(!ss.getSheetByName(SHEETS.operators)){
 var s = ss.insertSheet(SHEETS.operators);
 s.appendRow(['name','telegram_id','invite_code','role','active','tz']);
 // дефолтные пустые строки под операторов
 ['Айдос','Акбар','Самат'].forEach(function(n){ s.appendRow([n,'','','operator',true,'Asia/Almaty']); });
 }
 if(!ss.getSheetByName(SHEETS.events)){
 var ev = ss.insertSheet(SHEETS.events);
 ev.appendRow(['id','created_at','type','target','payload','status','sent_at']);
 }
 if(!ss.getSheetByName(SHEETS.sla)){
 var sla = ss.insertSheet(SHEETS.sla);
 sla.appendRow(['stage','limit_days']);
 DEFAULT_SLA.forEach(function(r){ sla.appendRow(r); });
 }
}

// ===== HANDLE MESSAGE =====

function handleMessage(msg){
 var chatId = msg.chat.id;
 var text = (msg.text || '').trim();
 var op = getOperatorByTgId(chatId);

 // /start INVITE_CODE
 if(text.indexOf('/start') === 0){
 var code = text.substring(6).trim();
 if(!code){
 if(op) return sendMessage(chatId, 'Ты уже привязан, ' + op.name + '. Команды: /menu /clients /today');
 return sendMessage(chatId, 'Чтобы привязаться, попроси у CEO invite-код и пришли:\n/start ВАШ-КОД');
 }
 var linked = linkOperator(code, chatId, msg.from);
 if(linked) sendMessage(chatId, 'Готово, ' + linked.name + '! Ты привязан к SalesDoc.\n\n/menu — главное меню\n/today — задачи на сегодня\n/clients — мои клиенты');
 else sendMessage(chatId, 'Не нашёл такой invite-код. Спроси у CEO актуальный код.');
 return;
 }

 if(!op){
 return sendMessage(chatId, 'Ты не привязан к SalesDoc. Команда:\n/start ВАШ-КОД');
 }

 // /menu
 if(text === '/menu' || text === '/start'){
 return sendMenu(chatId, op);
 }
 // /today
 if(text === '/today'){
 return sendDailyAgenda(chatId, op);
 }
 // /clients
 if(text === '/clients'){
 return sendMyClients(chatId, op);
 }
 // /sla — статус SLA только для CEO
 if(text === '/sla' && op.role === 'ceo'){
 return sendSlaStatus(chatId);
 }
 // /c <host> — быстрый поиск клиента
 if(text.indexOf('/c ') === 0){
 var query = text.substring(3).trim();
 return sendClientCard(chatId, query);
 }

 // По умолчанию — попробуем найти клиента по тексту
 if(text.length >= 2){
 return sendClientCard(chatId, text);
 }
}

// ===== HANDLE CALLBACK (нажатия inline-кнопок) =====

function handleCallback(cb){
 var chatId = cb.message.chat.id;
 var msgId = cb.message.message_id;
 var data = cb.data || '';
 var op = getOperatorByTgId(chatId);
 if(!op){ return answerCallback(cb.id, 'Сначала /start КОД'); }

 // формат: action|param1|param2
 var parts = data.split('|');
 var action = parts[0];

 if(action === 'take'){
 // Взять карточку в работу
 var row = parseInt(parts[1]);
 updateCard(row, {operator: op.name, stage: 'Взят в работу'});
 editMessage(chatId, msgId, '✅ Взял в работу: ' + parts[2]);
 answerCallback(cb.id, 'Готово');
 return;
 }
 if(action === 'pass'){
 // Передать другому — список операторов
 var others = listOperators().filter(function(o){ return o.name !== op.name && o.active; });
 var keyboard = others.map(function(o){ return [{text: o.name, callback_data: 'passto|' + parts[1] + '|' + o.name + '|' + parts[2]}]; });
 keyboard.push([{text:'« Отмена', callback_data:'cancel'}]);
 editMessage(chatId, msgId, 'Кому передать?', keyboard);
 answerCallback(cb.id);
 return;
 }
 if(action === 'passto'){
 var row2 = parseInt(parts[1]);
 var toName = parts[2];
 updateCard(row2, {operator: toName});
 editMessage(chatId, msgId, '🔁 Передал ' + parts[3] + ' → ' + toName);
 // отправим уведомление принимающему
 var to = getOperatorByName(toName);
 if(to && to.telegram_id){
 sendMessage(to.telegram_id, '🔁 Тебе передали клиента: ' + parts[3] + '\nОт: ' + op.name);
 }
 answerCallback(cb.id, 'Передал');
 return;
 }
 if(action === 'view'){
 sendClientCard(chatId, parts[1]);
 answerCallback(cb.id);
 return;
 }
 if(action === 'sla_ack'){
 // Оператор сказал что в курсе SLA
 var row3 = parseInt(parts[1]);
 markSlaAck(row3, op.name);
 editMessage(chatId, msgId, '✓ Зафиксировано. Возьмёшь к концу дня.');
 answerCallback(cb.id, 'OK');
 return;
 }
 if(action === 'cancel'){
 editMessage(chatId, msgId, 'Отменено.');
 answerCallback(cb.id);
 return;
 }
 if(action === 'menu'){
 sendMenu(chatId, op);
 answerCallback(cb.id);
 return;
 }
 answerCallback(cb.id);
}

// ===== MENUS =====

function sendMenu(chatId, op){
 var keyboard = [
 [{text:'📋 Задачи сегодня', callback_data:'today'}],
 [{text:'👥 Мои клиенты', callback_data:'clients'}],
 [{text:'🔍 Найти клиента', callback_data:'search'}]
 ];
 if(op.role === 'ceo'){
 keyboard.push([{text:'📊 Статус SLA', callback_data:'sla'}]);
 }
 sendMessage(chatId, 'Главное меню — ' + op.name, keyboard);
}

function sendDailyAgenda(chatId, op){
 var cards = listCards();
 var mine = cards.filter(function(c){ return c.operator === op.name && !isActivated(c); });
 var todayStr = todayISO();
 var atRisk = mine.filter(function(c){ return slaOverdue(c); });

 var txt = '☀️ Привет, ' + op.name + '\n\n';
 txt += 'У тебя в работе: ' + mine.length + ' клиентов\n';
 txt += '🔥 С риском по SLA: ' + atRisk.length + '\n\n';

 if(atRisk.length){
 txt += 'Срочно:\n';
 atRisk.slice(0,5).forEach(function(c){
 txt += '• ' + c.client + ' — этап «' + c.stage + '» уже ' + daysOnStage(c) + ' дн\n';
 });
 } else {
 txt += '✓ Все клиенты в норме по срокам.';
 }

 sendMessage(chatId, txt, [
 [{text:'👥 Все мои клиенты', callback_data:'clients'}],
 [{text:'« Меню', callback_data:'menu'}]
 ]);
}

function sendMyClients(chatId, op){
 var cards = listCards().filter(function(c){ return c.operator === op.name && !isActivated(c); });
 if(!cards.length){
 return sendMessage(chatId, 'У тебя пока нет активных клиентов.', [[{text:'« Меню', callback_data:'menu'}]]);
 }
 var txt = '👥 Мои клиенты (' + cards.length + '):\n\n';
 cards.slice(0, 30).forEach(function(c){
 var days = daysOnStage(c);
 var icon = days > slaLimit(c.stage) ? '🔥' : (days > slaLimit(c.stage)/2 ? '⏳' : '✓');
 txt += icon + ' ' + c.client + ' · ' + c.stage + ' · ' + days + 'д\n';
 });
 if(cards.length > 30) txt += '\n...и ещё ' + (cards.length-30);
 sendMessage(chatId, txt, [[{text:'« Меню', callback_data:'menu'}]]);
}

function sendClientCard(chatId, query){
 query = String(query||'').toLowerCase().trim();
 if(!query) return;
 var cards = listCards();
 var found = cards.filter(function(c){
 return (c.client||'').toLowerCase().indexOf(query) >= 0;
 });
 if(!found.length){
 return sendMessage(chatId, 'Не нашёл клиента по запросу «' + query + '». Попробуй точнее.');
 }
 if(found.length > 1 && found.length <= 8){
 var keyboard = found.map(function(c){ return [{text: c.client, callback_data: 'view|' + c.client}]; });
 return sendMessage(chatId, 'Нашёл несколько, выбери:', keyboard);
 }
 var c = found[0];
 var txt = '📂 ' + c.client + '\n\n';
 txt += '📍 ' + c.stage + ' · ' + daysOnStage(c) + ' дн на этапе\n';
 txt += '👤 Оператор: ' + (c.operator || 'не назначен') + '\n';
 txt += '💰 ' + (c.amount ? fmtNum(c.amount) + ' ₸' : '—') + '\n';
 txt += '📅 Менеджер: ' + (c.manager || '—') + '\n';
 if(c.activDate) txt += '✅ Активирован: ' + c.activDate + '\n';
 sendMessage(chatId, txt, [
 [{text:'✅ Взять', callback_data:'take|' + c._row + '|' + c.client}],
 [{text:'🔁 Передать', callback_data:'pass|' + c._row + '|' + c.client}],
 [{text:'« Меню', callback_data:'menu'}]
 ]);
}

function sendSlaStatus(chatId){
 var cards = listCards();
 var overdueByOp = {};
 cards.forEach(function(c){
 if(isActivated(c)) return;
 if(!slaOverdue(c)) return;
 var op = c.operator || '(нет оператора)';
 if(!overdueByOp[op]) overdueByOp[op] = [];
 overdueByOp[op].push(c);
 });
 var txt = '📊 Статус SLA\n\n';
 var totalOver = 0;
 Object.keys(overdueByOp).forEach(function(op){
 var arr = overdueByOp[op];
 totalOver += arr.length;
 txt += '👤 ' + op + ': ' + arr.length + ' просрочено\n';
 arr.slice(0,3).forEach(function(c){
 txt += ' • ' + c.client + ' (' + c.stage + ' ' + daysOnStage(c) + 'д)\n';
 });
 });
 if(!totalOver) txt += '✓ Всё в норме';
 sendMessage(chatId, txt);
}

// ===== TRIGGERS =====

function dailyMorning(){
 var ops = listOperators().filter(function(o){ return o.active && o.telegram_id; });
 ops.forEach(function(op){
 try { sendDailyAgenda(op.telegram_id, op); } catch(e){ logError('dailyMorning ' + op.name, e); }
 });
}

function slaCheck(){
 var cards = listCards();
 var ceos = listOperators().filter(function(o){ return o.role === 'ceo' && o.telegram_id; });
 var alerts = 0;
 cards.forEach(function(c){
 if(isActivated(c)) return;
 var days = daysOnStage(c);
 var limit = slaLimit(c.stage);
 if(days <= limit) return;
 // Шлём оператору если карточка превысила лимит и алерт ещё не отправлялся за последние 24ч
 if(!shouldSendSla(c, 24*60)) return;
 alerts++;
 var op = c.operator ? getOperatorByName(c.operator) : null;
 var msg = '🚨 SLA нарушен\n\n' + c.client + '\nЭтап «' + c.stage + '» уже ' + days + ' дн (лимит: ' + limit + ')';
 if(op && op.telegram_id){
 sendMessage(op.telegram_id, msg, [
 [{text:'📞 Я в курсе — закроем сегодня', callback_data:'sla_ack|' + c._row}],
 [{text:'🔁 Передать другому', callback_data:'pass|' + c._row + '|' + c.client}]
 ]);
 } else {
 // нет оператора — эскалация CEO
 ceos.forEach(function(ceo){
 sendMessage(ceo.telegram_id, '⚠️ ' + c.client + ' — нет оператора, ' + days + ' дн на «' + c.stage + '»');
 });
 }
 markSlaSent(c._row);
 });
 if(alerts) logEvent('sla_check_done', '', {alerts: alerts});
}

function eventPusher(){
 // Читаем Bot Events со status=pending, отправляем, ставим status=sent
 var ss = SpreadsheetApp.openById(SHEET_ID);
 var sh = ss.getSheetByName(SHEETS.events);
 if(!sh) return;
 var values = sh.getDataRange().getValues();
 for(var i=1;i<values.length;i++){
 var row = values[i];
 if(row[5] !== 'pending') continue;
 try {
 var payload = row[4] ? JSON.parse(row[4]) : {};
 var target = row[3]; // имя оператора, или 'ceo', или 'all'
 var type = row[2];
 deliverEvent(type, target, payload);
 sh.getRange(i+1, 6).setValue('sent');
 sh.getRange(i+1, 7).setValue(new Date());
 } catch(e){
 sh.getRange(i+1, 6).setValue('error: ' + e.message.slice(0,50));
 }
 }
}

function deliverEvent(type, target, payload){
 var targets = [];
 if(target === 'ceo') targets = listOperators().filter(function(o){ return o.role === 'ceo' && o.telegram_id; });
 else if(target === 'all') targets = listOperators().filter(function(o){ return o.telegram_id && o.active; });
 else {
 var op = getOperatorByName(target);
 if(op && op.telegram_id) targets = [op];
 }
 targets.forEach(function(op){
 if(type === 'new_card'){
 var txt = '🔔 Новая карточка\n\n' + payload.client + '\n📍 ' + (payload.stage||'В очереди');
 if(payload.amount) txt += '\n💰 ' + fmtNum(payload.amount) + ' ₸';
 var kb = [
 [{text:'✅ Взять в работу', callback_data:'take|' + payload.row + '|' + payload.client}],
 [{text:'👁 Посмотреть', callback_data:'view|' + payload.client}]
 ];
 if(op.role !== 'operator') kb.push([{text:'🔁 Назначить оператора', callback_data:'pass|' + payload.row + '|' + payload.client}]);
 sendMessage(op.telegram_id, txt, kb);
 } else if(type === 'stage_change'){
 sendMessage(op.telegram_id, '📍 ' + payload.client + '\n' + payload.from + ' → ' + payload.to);
 } else if(type === 'note'){
 sendMessage(op.telegram_id, '📝 ' + payload.client + '\n«' + payload.note + '»');
 } else if(type === 'custom'){
 sendMessage(op.telegram_id, payload.text || '(пустое сообщение)');
 }
 });
}

// ===== SHEETS HELPERS =====

function listOperators(){
 var ss = SpreadsheetApp.openById(SHEET_ID);
 var sh = ss.getSheetByName(SHEETS.operators);
 if(!sh){ initSheets(); sh = ss.getSheetByName(SHEETS.operators); }
 var vals = sh.getDataRange().getValues();
 var out = [];
 for(var i=1;i<vals.length;i++){
 if(!vals[i][0]) continue;
 out.push({_row: i+1, name: vals[i][0], telegram_id: vals[i][1], invite_code: vals[i][2], role: vals[i][3]||'operator', active: vals[i][4] !== false, tz: vals[i][5]||'Asia/Almaty'});
 }
 return out;
}

function getOperatorByTgId(tgId){
 return listOperators().filter(function(o){ return String(o.telegram_id) === String(tgId); })[0] || null;
}

function getOperatorByName(name){
 return listOperators().filter(function(o){ return o.name === name; })[0] || null;
}

function linkOperator(code, tgId, fromUser){
 var ops = listOperators();
 for(var i=0;i<ops.length;i++){
 if(ops[i].invite_code && ops[i].invite_code === code){
 var ss = SpreadsheetApp.openById(SHEET_ID);
 var sh = ss.getSheetByName(SHEETS.operators);
 sh.getRange(ops[i]._row, 2).setValue(String(tgId));
 sh.getRange(ops[i]._row, 3).setValue(''); // одноразовый код
 return ops[i];
 }
 }
 return null;
}

function listCards(){
 var ss = SpreadsheetApp.openById(SHEET_ID);
 var sh = ss.getSheetByName(SHEETS.cards);
 if(!sh) return [];
 var vals = sh.getDataRange().getValues();
 if(vals.length < 2) return [];
 var headers = vals[0];
 var colMap = {};
 headers.forEach(function(h, i){ colMap[String(h).toLowerCase().trim()] = i; });
 var col = function(name){ return colMap[name.toLowerCase()] !== undefined ? colMap[name.toLowerCase()] : -1; };
 var iClient = col('Клиент'), iStage = col('Этап'), iOp = col('Оператор'),
 iMgr = col('Менеджер'), iAmt = col('Сумма'), iAct = col('ДатаАктивации'),
 iPay = col('ДатаОплаты'), iStageDate = col('ДатаЭтапа'), iSlaSent = col('SLA_Sent');
 var out = [];
 for(var i=1;i<vals.length;i++){
 if(!vals[i][iClient]) continue;
 out.push({
 _row: i+1,
 client: vals[i][iClient],
 stage: iStage>=0 ? vals[i][iStage] : '',
 operator: iOp>=0 ? vals[i][iOp] : '',
 manager: iMgr>=0 ? vals[i][iMgr] : '',
 amount: iAmt>=0 ? vals[i][iAmt] : 0,
 activDate: iAct>=0 ? vals[i][iAct] : '',
 payDate: iPay>=0 ? vals[i][iPay] : '',
 stageDate: iStageDate>=0 ? vals[i][iStageDate] : '',
 slaSent: iSlaSent>=0 ? vals[i][iSlaSent] : ''
 });
 }
 return out;
}

function updateCard(row, fields){
 var ss = SpreadsheetApp.openById(SHEET_ID);
 var sh = ss.getSheetByName(SHEETS.cards);
 if(!sh || !row) return;
 var headers = sh.getRange(1,1,1,sh.getLastColumn()).getValues()[0];
 Object.keys(fields).forEach(function(key){
 var colName = ({operator:'Оператор', stage:'Этап', activDate:'ДатаАктивации'})[key] || key;
 for(var i=0;i<headers.length;i++){
 if(String(headers[i]).toLowerCase().trim() === colName.toLowerCase()){
 sh.getRange(row, i+1).setValue(fields[key]);
 break;
 }
 }
 });
 if(fields.stage){
 // обновляем дату этапа
 for(var i=0;i<headers.length;i++){
 if(String(headers[i]).toLowerCase().trim() === 'датаэтапа'){
 sh.getRange(row, i+1).setValue(new Date());
 break;
 }
 }
 }
}

function slaLimit(stage){
 var ss = SpreadsheetApp.openById(SHEET_ID);
 var sh = ss.getSheetByName(SHEETS.sla);
 if(!sh){ initSheets(); sh = ss.getSheetByName(SHEETS.sla); }
 var vals = sh.getDataRange().getValues();
 for(var i=1;i<vals.length;i++){
 if(vals[i][0] === stage) return parseInt(vals[i][1]) || 7;
 }
 return 7;
}

function daysOnStage(c){
 var d = c.stageDate ? new Date(c.stageDate) : (c.payDate ? new Date(c.payDate) : null);
 if(!d || isNaN(d)) return 0;
 return Math.floor((new Date() - d) / 86400000);
}

function slaOverdue(c){
 return daysOnStage(c) > slaLimit(c.stage);
}

function isActivated(c){
 return c.stage === 'Активирован' || c.activDate;
}

function shouldSendSla(card, cooldownMin){
 if(!card.slaSent) return true;
 var last = new Date(card.slaSent);
 if(isNaN(last)) return true;
 return (new Date() - last) > cooldownMin * 60000;
}

function markSlaSent(row){
 var ss = SpreadsheetApp.openById(SHEET_ID);
 var sh = ss.getSheetByName(SHEETS.cards);
 var headers = sh.getRange(1,1,1,sh.getLastColumn()).getValues()[0];
 var idx = -1;
 for(var i=0;i<headers.length;i++) if(String(headers[i]).toLowerCase().indexOf('sla_sent') === 0){ idx = i; break; }
 if(idx < 0){ idx = headers.length; sh.getRange(1, idx+1).setValue('SLA_Sent'); }
 sh.getRange(row, idx+1).setValue(new Date());
}

function markSlaAck(row, opName){
 var ss = SpreadsheetApp.openById(SHEET_ID);
 var sh = ss.getSheetByName(SHEETS.cards);
 var headers = sh.getRange(1,1,1,sh.getLastColumn()).getValues()[0];
 var idx = -1;
 for(var i=0;i<headers.length;i++) if(String(headers[i]).toLowerCase().indexOf('sla_ack') === 0){ idx = i; break; }
 if(idx < 0){ idx = headers.length; sh.getRange(1, idx+1).setValue('SLA_Ack'); }
 sh.getRange(row, idx+1).setValue(opName + ' @ ' + new Date().toISOString());
}

function logEvent(type, target, payload){
 var ss = SpreadsheetApp.openById(SHEET_ID);
 var sh = ss.getSheetByName(SHEETS.events);
 if(!sh){ initSheets(); sh = ss.getSheetByName(SHEETS.events); }
 sh.appendRow([Utilities.getUuid(), new Date(), type, target||'', JSON.stringify(payload||{}), 'sent', new Date()]);
}

function logError(where, err){
 try {
 var ss = SpreadsheetApp.openById(SHEET_ID);
 var sh = ss.getSheetByName(SHEETS.events);
 if(!sh) return;
 sh.appendRow([Utilities.getUuid(), new Date(), 'error', where, String(err && err.message || err), 'error', new Date()]);
 } catch(e){}
}

// ===== TELEGRAM API =====

function sendMessage(chatId, text, keyboard){
 var payload = {chat_id: chatId, text: text, parse_mode: 'HTML'};
 if(keyboard) payload.reply_markup = JSON.stringify({inline_keyboard: keyboard});
 try {
 UrlFetchApp.fetch(TG_API + '/sendMessage', {
 method: 'post', contentType: 'application/json', payload: JSON.stringify(payload), muteHttpExceptions: true
 });
 } catch(e){ logError('sendMessage', e); }
}

function editMessage(chatId, msgId, text, keyboard){
 var payload = {chat_id: chatId, message_id: msgId, text: text, parse_mode: 'HTML'};
 if(keyboard) payload.reply_markup = JSON.stringify({inline_keyboard: keyboard});
 try {
 UrlFetchApp.fetch(TG_API + '/editMessageText', {
 method: 'post', contentType: 'application/json', payload: JSON.stringify(payload), muteHttpExceptions: true
 });
 } catch(e){ logError('editMessage', e); }
}

function answerCallback(callbackId, text){
 try {
 UrlFetchApp.fetch(TG_API + '/answerCallbackQuery', {
 method: 'post', contentType: 'application/json',
 payload: JSON.stringify({callback_query_id: callbackId, text: text||''}),
 muteHttpExceptions: true
 });
 } catch(e){}
}

// ===== UTILS =====

function todayISO(){ return Utilities.formatDate(new Date(),'Asia/Almaty','yyyy-MM-dd'); }
function fmtNum(n){ return String(n).replace(/\B(?=(\d{3})+(?!\d))/g,' '); }

// Ручной тест: запусти эту функцию из GAS UI, увидишь свой telegram_id в логе
function testEcho(){
 Logger.log('Operators: ' + JSON.stringify(listOperators()));
 Logger.log('SLA: stage=Взят в работу limit=' + slaLimit('Взят в работу'));
 Logger.log('Cards: ' + listCards().length);
}

// Сгенерировать invite-код для оператора (запускай из SalesDoc или из GAS UI)
function generateInviteCode(operatorName){
 var ops = listOperators();
 for(var i=0;i<ops.length;i++){
 if(ops[i].name === operatorName){
 var code = operatorName.toUpperCase().replace(/[^А-ЯA-Z]/g,'').slice(0,4) + '-' + Math.random().toString(36).slice(2,7).toUpperCase();
 var ss = SpreadsheetApp.openById(SHEET_ID);
 var sh = ss.getSheetByName(SHEETS.operators);
 sh.getRange(ops[i]._row, 3).setValue(code);
 return code;
 }
 }
 return null;
}
