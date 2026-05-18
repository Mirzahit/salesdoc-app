// /api/meta-diag — диагностика: кому принадлежит META_ACCESS_TOKEN и какие ad accounts ему доступны.
// Полезно когда KG (или другой) кабинет возвращает "Ad account owner has NOT grant permission".

export default async function handler(req, res){
  const TOKEN = (process.env.META_ACCESS_TOKEN || '').trim();
  if(!TOKEN) return res.status(500).json({ error: 'no META_ACCESS_TOKEN' });

  const targetAccountKG = (process.env.META_AD_ACCOUNT_ID_KG || '').trim();
  const targetAccountKZ = (process.env.META_AD_ACCOUNT_ID || '').trim();

  async function fetchMeta(path){
    const url = 'https://graph.facebook.com/v21.0' + path + (path.includes('?')?'&':'?') + 'access_token=' + encodeURIComponent(TOKEN);
    const r = await fetch(url);
    return r.json();
  }

  try {
    const me = await fetchMeta('/me?fields=id,name,email');
    const adAccounts = await fetchMeta('/me/adaccounts?fields=id,name,account_status,business&limit=100');
    const businesses = await fetchMeta('/me/businesses?fields=id,name&limit=50');

    const accounts = (adAccounts.data || []).map(a => ({
      id: a.id,
      name: a.name,
      status: a.account_status,
      business: a.business ? { id: a.business.id, name: a.business.name } : null
    }));

    const hasKG = accounts.some(a => a.id === targetAccountKG);
    const hasKZ = accounts.some(a => a.id === targetAccountKZ);

    return res.status(200).json({
      token_owner: me,
      env_accounts: { KZ: targetAccountKZ, KG: targetAccountKG },
      visible_accounts_count: accounts.length,
      visible_accounts: accounts,
      businesses: businesses.data || [],
      diagnosis: {
        KZ_visible: hasKZ,
        KG_visible: hasKG,
        verdict: hasKG ? 'Токен ВИДИТ KG — должен работать' :
                 hasKZ ? 'Токен ВИДИТ только KZ, KG не виден — нужно выдать доступ или новый токен' :
                 'Токен НЕ видит ни KZ ни KG (странно)'
      }
    });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}
