// v813: общий модуль уведомлений (колокольчик + Telegram через @salesdoc_reports_bot).
// Underscore-файл — НЕ деплоится как отдельная serverless-функция.
//
// notifCreate(rows)  → вставка с игнором дублей (dedup_key) + Telegram по реально вставленным.
// opEmailByName(имя) → резолв имени оператора (кириллица/латиница) в employees.email.
//
// Ошибки Telegram никогда не валят создание уведомления; ошибки создания
// уведомления никогда не должны валить основную операцию вызывающего кода
// (оборачивать вызовы notifCreate в try/catch на стороне генераторов).

import { sbSelect, sbUpdate, sbInsertIgnoreDup } from './_supabase.js';

const TG_TOKEN = process.env.TG_BOT_TOKEN || '';

// Кириллические имена операторов в карточках/задачах ↔ латинские логины-email в employees.
// Зеркало CRM_OP_ALIASES из index.html (~31223), в обратную сторону + команда интеграции.
const OP_ALIASES = {
  'айдос': 'aidos', 'акбар': 'akbar', 'самат': 'samat', 'нурай': 'nuray',
  'юлия': 'yulia', 'мирзахит': 'office@salesdoc.io'
};

let _empCache = null; // на время жизни инстанса функции — достаточно
async function _employees() {
  if (_empCache) return _empCache;
  _empCache = await sbSelect('employees', { active: 'not.is.false', select: 'email,name,tg_chat_id' });
  return _empCache;
}

// Имя («Акбар», «Aidos Hapez», «айдос») → email сотрудника или null.
export async function opEmailByName(name) {
  const first = String(name || '').trim().split(/\s+/)[0].toLowerCase();
  if (!first) return null;
  const emps = await _employees();
  // 1) прямое совпадение первого слова employees.name
  const direct = emps.find(e => String(e.name || '').trim().split(/\s+/)[0].toLowerCase() === first);
  if (direct) return String(direct.email || '').toLowerCase() || null;
  // 2) алиас кириллица → латинский логин/email
  const alias = OP_ALIASES[first];
  if (alias) {
    const byAlias = emps.find(e => {
      const em = String(e.email || '').toLowerCase();
      const nm = String(e.name || '').trim().split(/\s+/)[0].toLowerCase();
      return em === alias || nm === alias;
    });
    if (byAlias) return String(byAlias.email).toLowerCase();
    if (alias.includes('@')) return alias; // прямой email в алиасе (CEO)
  }
  console.warn('[notify] не смог сопоставить имя с сотрудником:', name);
  return null;
}

const TG_LABEL = {
  intg_deadline: 'Срок интеграции', intg_overdue: 'Просрочка',
  impl_stuck: 'Внедрение зависло', mention: 'Упоминание', task_assigned: 'Новая задача',
  // v819: удержание клиентов
  renewal_due: 'Продление подписки', billing_overdue: 'Оплата просрочена',
  pay_drop: 'Платёж меньше обычного', renewals_summary: 'Продления недели'
};

function _esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function _tgSend(chatId, row) {
  const text = '<b>' + _esc(TG_LABEL[row.type] || 'Уведомление') + '</b>\n'
    + _esc(row.title) + (row.body ? '\n' + _esc(row.body) : '');
  const r = await fetch('https://api.telegram.org/bot' + TG_TOKEN + '/sendMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    signal: AbortSignal.timeout(3000)
  });
  if (!r.ok) throw new Error('tg sendMessage ' + r.status);
}

// rows: [{user_email,type,title,body?,entity_type?,entity_id?,client_id?,actor?,dedup_key?}]
// Возвращает реально вставленные строки (дубли по dedup_key отброшены молча).
export async function notifCreate(rows) {
  const clean = (Array.isArray(rows) ? rows : [rows])
    .filter(r => r && r.user_email && r.type && r.title)
    .map(r => ({
      user_email: String(r.user_email).toLowerCase(),
      type: r.type,
      title: String(r.title).slice(0, 300),
      body: r.body ? String(r.body).slice(0, 500) : null,
      entity_type: r.entity_type || null,
      entity_id: r.entity_id || null,
      client_id: r.client_id || null,
      actor: r.actor || null,
      dedup_key: r.dedup_key || null
    }));
  if (!clean.length) return [];
  // Строкам без dedup_key (упоминания/задачи) дедуп не нужен — частичный
  // уникальный индекс null-ключи не видит, вставка проходит всегда.
  const inserted = await sbInsertIgnoreDup('notifications', clean, 'user_email,dedup_key');

  // Telegram — по вставленным, у кого привязан чат. Сбой TG не критичен.
  if (TG_TOKEN && inserted.length) {
    try {
      const emps = await _employees();
      const chatByEmail = {};
      emps.forEach(e => { if (e.tg_chat_id) chatByEmail[String(e.email).toLowerCase()] = e.tg_chat_id; });
      for (const row of inserted) {
        const chat = chatByEmail[row.user_email];
        if (!chat) continue;
        try {
          await _tgSend(chat, row);
          await sbUpdate('notifications', { id: 'eq.' + row.id }, { tg_sent: true });
        } catch (e) { console.warn('[notify] tg send failed:', row.id, e.message); }
      }
    } catch (e) { console.warn('[notify] tg batch failed:', e.message); }
  }
  return inserted;
}
