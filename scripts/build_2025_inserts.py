#!/usr/bin/env python3
"""Parses 24 Sheets JSON files (KZ + KG, 12 months of 2025)
and emits a single SQL file with INSERTs into public.payments.

Output:
  C:/Users/Мирзахит/Downloads/p2025/payments_2025_inserts.sql
  C:/Users/Мирзахит/Downloads/p2025/payments_2025_stats.json
"""
import json, os, re, sys
from datetime import date

SRC_DIR = r'C:/Users/Мирзахит/Downloads/p2025'
OUT_SQL = os.path.join(SRC_DIR, 'payments_2025_inserts.sql')
OUT_STATS = os.path.join(SRC_DIR, 'payments_2025_stats.json')

MONTHS = ['Янв','Фев','Мар','Апр','Май','Июн','Июл','Авг','Сен','Окт','Ноя','Дек']

COUNTRIES = {
    'KZ': {'sheet_id': '11ErpSR9fJ_T0ggWBrHjRB35cMs4yl84HedSO1Tf4Z08', 'currency': 'KZT', 'date_corr': 0},
    'KG': {'sheet_id': '1e34EE4DKuj2tzatlX1qBFEAEX7aDtky02R2HA2KE7_M', 'currency': 'KGS', 'date_corr': 1},
}


def parse_date(v, date_corr):
    if v is None: return None
    if isinstance(v, (int, float)):
        if v == 0: return None
        # Excel serial -> JS-like: (v-25569)*86400 sec since epoch
        import datetime
        try:
            d = datetime.datetime(1970,1,1) + datetime.timedelta(seconds=int(round((v-25569)*86400)))
            return d.strftime('%Y-%m-%d')
        except Exception:
            return None
    s = str(v).strip()
    if not s or s in ('0','-','—'): return None
    m1 = re.match(r'Date\((\d+),(\d+),(\d+)\)', s)
    if m1:
        return f"{m1.group(1)}-{int(m1.group(2))+1:02d}-{int(m1.group(3)):02d}"
    m2 = re.match(r'^(\d{1,2})\.(\d{1,2})\.(\d{4})', s)
    if m2:
        import datetime
        try:
            d = datetime.date(int(m2.group(3)), int(m2.group(2)), 1) + datetime.timedelta(days=int(m2.group(1))-1 + (date_corr or 0))
            return d.strftime('%Y-%m-%d')
        except Exception:
            return None
    if re.match(r'^\d{4}-\d{2}-\d{2}', s):
        return s[:10]
    return None


def map_category(cat):
    c = re.sub(r'\s+', ' ', re.sub(r'\.', ' ', str(cat or '').lower())).strip()
    if 'интеграц' in c: return 'integration'
    if 'внедрен' in c or 'доработ' in c: return 'implementation'
    if 'абон' in c or 'баланс' in c: return 'subscription'
    if 'лицен' in c or 'новый клиент' in c or 'нов клиент' in c: return 'license'
    return 'other'


def parse_num(v):
    if v is None: return None
    if isinstance(v, (int, float)): return v
    s = re.sub(r'[^0-9.,-]', '', re.sub(r'\s', '', str(v))).replace(',', '.')
    try:
        return float(s)
    except Exception:
        return None


def parse_row(row, hdr_row, cfg, month_name, month_idx, sheet_row_abs):
    if not row or len(row) < 2 or row[1] is None or str(row[1]).strip() == '':
        return None
    col_date, col_client, col_cat, col_mgr = 0, 1, 2, 5
    col_amt, col_bank, col_seated, col_tech = 12, 10, 11, 17
    col_activation = -1
    if hdr_row:
        for i, h in enumerate(hdr_row):
            s = str(h or '').lower()
            if s == 'дата' and i < 3: col_date = i
            elif s == 'компания': col_client = i
            elif 'стать' in s: col_cat = i
            elif s == 'менеджер': col_mgr = i
            elif 'сумма' in s and 'факт' in s: col_amt = i
            elif 'сумма' in s and 'факт' not in s and 'оста' not in s:
                if col_amt == 9: col_amt = i
            elif s == 'банк': col_bank = i
            elif 'посаж' in s: col_seated = i
            elif 'тех' in s and 'актив' not in s: col_tech = i
        if len(hdr_row) > 14 and 'актив' in str(hdr_row[14] or '').lower():
            col_activation = 14
        else:
            for i, h in enumerate(hdr_row):
                s = str(h or '').lower()
                if col_activation < 0 and 'дата' in s and 'актив' in s and 'цена' not in s:
                    col_activation = i
        if col_activation < 0: col_activation = 14

    def safe(row, i):
        return row[i] if i < len(row) else None

    amt_raw = safe(row, col_amt)
    if amt_raw is None or str(amt_raw).strip() == '':
        amt_raw = safe(row, 9)
    amount = parse_num(amt_raw)
    if not amount or amount <= 0: return None
    paid_at = parse_date(safe(row, col_date), cfg['date_corr'])
    if not paid_at:
        paid_at = f"2025-{month_idx+1:02d}-01"
    # force 2025
    if not paid_at.startswith('2025-'):
        paid_at = '2025-' + paid_at[5:]
    company = str(safe(row, col_client) or '').strip()
    if not company: return None
    cat_raw = str(safe(row, col_cat) or '').strip()
    act_date = parse_date(safe(row, col_activation), cfg['date_corr'])
    if not act_date and col_activation == 14:
        act_date = parse_date(safe(row, 15), cfg['date_corr'])
    period_n = parse_num(safe(row, 8))
    period = max(0, min(60, int(round(period_n)))) if period_n is not None else None
    seated_v = str(safe(row, col_seated) or '').strip()
    seated = seated_v in ('Да','да','+')
    return {
        'paid_at': paid_at,
        'company_name': company,
        'category_raw': cat_raw,
        'category': map_category(cat_raw),
        'amount': amount,
        'amount_planned': parse_num(safe(row, 9)),
        'manager_name': (str(safe(row, col_mgr) or '').strip() or None),
        'bank': (str(safe(row, col_bank) or '').strip() or None),
        'seated': seated,
        'tech_support': (str(safe(row, col_tech) or '').strip() or None),
        'qty': parse_num(safe(row, 4)),
        'price': parse_num(safe(row, 7)),
        'period_months': period,
        'activation_date': act_date,
        'period_start_raw': (str(safe(row, 19)).strip() if safe(row, 19) else None),
        'sheet_tab': month_name,
        'sheet_row': sheet_row_abs,
    }


def sql_v(v):
    if v is None: return 'NULL'
    if isinstance(v, bool): return 'true' if v else 'false'
    if isinstance(v, (int, float)):
        # avoid trailing .0 for ints we stored as float
        if float(v).is_integer() and abs(v) < 1e15:
            return str(int(v))
        return repr(v)
    s = str(v).replace("'", "''")
    return "'" + s + "'"


def main():
    all_rows = []
    stats = {'by_country': {}, 'by_month': {}}
    for country, cfg in COUNTRIES.items():
        stats['by_country'][country] = {'rows': 0, 'sum': 0}
        for mi, month in enumerate(MONTHS):
            f = os.path.join(SRC_DIR, f'{country.lower()}_{month}.json')
            if not os.path.exists(f):
                print(f"MISS {f}", file=sys.stderr); continue
            try:
                with open(f, 'r', encoding='utf-8') as fh:
                    data = json.load(fh)
            except Exception as e:
                print(f"JSON ERR {f}: {e}", file=sys.stderr); continue
            rows = data.get('rows') or []
            if len(rows) < 2: continue
            # find header row
            hdr_idx = -1
            for ri, r in enumerate(rows):
                if r and len(r) > 1 and str(r[1] or '').strip() == 'Компания':
                    hdr_idx = ri; break
            hdr = rows[hdr_idx] if hdr_idx >= 0 else None
            start = hdr_idx + 1 if hdr_idx >= 0 else 4
            m_rows, m_sum = 0, 0
            for idx, row in enumerate(rows[start:]):
                sheet_row_abs = start + idx + 1
                p = parse_row(row, hdr, cfg, month, mi, sheet_row_abs)
                if not p: continue
                p['country'] = country
                p['currency'] = cfg['currency']
                p['source'] = 'sheets_import'
                p['sheet_id'] = cfg['sheet_id']
                all_rows.append(p)
                m_rows += 1
                m_sum += p['amount']
            stats['by_country'][country]['rows'] += m_rows
            stats['by_country'][country]['sum'] += m_sum
            stats['by_month'][f"{country}_{month}"] = {'rows': m_rows, 'sum': m_sum}

    # emit SQL
    cols = ['country','paid_at','company_name','category','category_raw','amount','amount_planned',
            'currency','qty','price','period_months','bank','manager_name','tech_support','seated',
            'activation_date','period_start_raw','source','sheet_id','sheet_tab','sheet_row']
    BATCH = 100
    out = []
    out.append(f"-- Auto-generated 2025 payments import (KZ+KG)")
    out.append(f"-- Total rows: {len(all_rows)}")
    out.append(f"-- Per-country: {json.dumps(stats['by_country'], ensure_ascii=False)}")
    out.append('')
    out.append('BEGIN;')
    out.append('')
    for i in range(0, len(all_rows), BATCH):
        slc = all_rows[i:i+BATCH]
        out.append(f"INSERT INTO payments ({', '.join(cols)}) VALUES")
        vals = []
        for p in slc:
            vs = [sql_v(p[c]) for c in cols]
            vals.append('  (' + ', '.join(vs) + ')')
        out.append(',\n'.join(vals))
        out.append('  ON CONFLICT DO NOTHING;')
        out.append('')
    out.append('COMMIT;')
    out.append('')
    with open(OUT_SQL, 'w', encoding='utf-8') as fh:
        fh.write('\n'.join(out))
    with open(OUT_STATS, 'w', encoding='utf-8') as fh:
        json.dump({'total_rows': len(all_rows), **stats}, fh, ensure_ascii=False, indent=2)
    print(f"OK rows={len(all_rows)} file={OUT_SQL}")
    print(f"stats={json.dumps(stats['by_country'], ensure_ascii=False)}")

if __name__ == '__main__':
    main()
