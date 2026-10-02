// v1017: превью-сборка Vercel смотрит в ту же боевую базу и тот же amo, что и прод.
// Поэтому в превью программа НИЧЕГО не записывает: любой запрос наружу, кроме чтения, обрывается
// здесь, до сети. Подключается одной строкой `import './_preview_guard.js';` в начале каждого api-файла.
// В проде (VERCEL_ENV=production) и локально модуль ничего не делает.
//
// Разрешено в превью:
//   • любые GET/HEAD (чтение Supabase, amo, Meta, свои же эндпоинты);
//   • POST в Upstash только для счётчика частоты запросов к amo (INCR/EXPIRE ключей amo:*) —
//     без него ограничитель не работает, а данных он не меняет.
// Запрещено: запись в Supabase (POST/PATCH/DELETE/PUT), загрузка файлов, любые не-GET в amo,
// Telegram, Anthropic, Google Apps Script (у таблиц запись бывает и через GET — Apps Script закрыт целиком).

// Включается ТОЛЬКО при явном признаке превью: Vercel сам ставит VERCEL_ENV='preview' превью-сборкам
// и 'production' — проду. Нет переменной (локально, другой хостинг) или любое другое значение — защита
// выключена, запись работает как обычно. Дополнительно: если Vercel пометил сборку как прод
// (VERCEL_TARGET_ENV='production'), защита не включается, даже если VERCEL_ENV почему-то 'preview'.
export const PREVIEW_READONLY = String(process.env.VERCEL_ENV || '') === 'preview'
  && String(process.env.VERCEL_TARGET_ENV || '') !== 'production';

export class PreviewReadonlyError extends Error {
  constructor(what){ super('В превью запись отключена' + (what ? ': ' + what : '')); this.code = 'preview_readonly'; this.status = 403; }
}

export function isAllowedInPreview(url, init){
  const method = String((init && init.method) || 'GET').toUpperCase();
  let host = '';
  try { host = new URL(String(url)).host; } catch(_){ return false; }
  if(/script\.google(usercontent)?\.com$/.test(host)) return false;          // Apps Script — закрыт целиком
  if(method === 'GET' || method === 'HEAD') return true;
  const kvHost = (() => { try { return new URL(String(process.env.KV_REST_API_URL || '')).host; } catch(_){ return ''; } })();
  if(kvHost && host === kvHost && method === 'POST'){
    try {
      const cmds = JSON.parse(String((init && init.body) || ''));
      return Array.isArray(cmds) && cmds.length > 0 && cmds.every(c => Array.isArray(c)
        && /^(INCR|EXPIRE)$/i.test(String(c[0])) && /^amo/i.test(String(c[1] || '')));
    } catch(_){ return false; }
  }
  return false;
}

if(PREVIEW_READONLY && !globalThis.__sdPreviewGuard){
  globalThis.__sdPreviewGuard = true;
  console.warn('[preview] режим только чтения включён (VERCEL_ENV=preview)'); // видно в логах, если включился там, где не должен
  const realFetch = globalThis.fetch;
  globalThis.fetch = async function(url, init){
    const u = (url && typeof url === 'object' && url.url) ? url.url : url;
    const i = init || ((url && typeof url === 'object' && url.method) ? { method: url.method } : undefined);
    if(!isAllowedInPreview(u, i)){
      let host = ''; try { host = new URL(String(u)).host; } catch(_){}
      console.warn('[preview] запись заблокирована:', String((i && i.method) || 'GET'), host);
      throw new PreviewReadonlyError(host);
    }
    return realFetch(url, init);
  };
}
