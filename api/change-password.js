// /api/change-password — самостоятельная смена СВОЕГО пароля (v587).
// НЕ требует админ-кода: аутентификация = знание текущего пароля.
// POST { email, old_password, new_password } → проверяем old против хэша, ставим новый + is_temp=false.
import crypto from 'crypto';
import { sbSelect, sbUpdate } from './_supabase.js';
import { checkAuth } from './_auth.js';

function normEmail(s) { return String(s || '').trim().toLowerCase(); }
function sha256(s) { return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex'); }

export default async function handler(req, res) {
  if (!checkAuth(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method not allowed' });
  try {
    const body = await readBody(req);
    const email = normEmail(body.email);
    // единый generic-ответ — не палим существование/статус аккаунта (анти-энумерация)
    const GENERIC = 'Неверный текущий пароль или учётная запись недоступна';
    if (/[,*()%\s]/.test(email) || !email) return res.status(200).json({ ok: false, error: GENERIC });
    const oldP = String(body.old_password || '');
    const newP = String(body.new_password || '');
    if (!oldP || !newP) return res.status(200).json({ ok: false, error: 'Укажите старый и новый пароль' });
    if (newP.trim().length < 4) return res.status(200).json({ ok: false, error: 'Новый пароль слишком короткий' });

    // менять можно ТОЛЬКО свой пароль: заявленная личность (x-user-email) должна совпадать с email.
    const claimed = normEmail(req.headers['x-user-email']);
    if (claimed && claimed !== email) return res.status(200).json({ ok: false, error: GENERIC });

    const rows = await sbSelect('employees', { email: 'eq.' + email, select: 'id,pass_hash,active', limit: 1 });
    const emp = rows && rows[0];
    if (!emp || emp.active === false) return res.status(200).json({ ok: false, error: GENERIC });

    const stored = String(emp.pass_hash || '');
    const oldOk = stored && (stored === sha256(oldP.trim()) || stored === sha256(oldP));
    if (!oldOk) return res.status(200).json({ ok: false, error: GENERIC });

    await sbUpdate('employees', { id: 'eq.' + emp.id }, {
      pass_hash: sha256(newP.trim()),
      is_temp: false,
      updated_at: new Date().toISOString()
    });
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('[api/change-password] error:', e);
    return res.status(500).json({ ok: false, error: e.message || String(e) });
  }
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  return new Promise((resolve) => {
    let c = '';
    req.on('data', x => c += x);
    req.on('end', () => { try { resolve(JSON.parse(c || '{}')); } catch { resolve({}); } });
  });
}
