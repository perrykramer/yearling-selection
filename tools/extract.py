import re, csv, json, collections

pages = open('full.txt', encoding='utf-8').read().split('\f')[:4642]
rows = list(csv.DictReader(open('/root/.claude/uploads/7aec7b8f-b96e-51a3-9a05-d51c9c5d36c2/30b867d7-catalog08_30_2026.csv', encoding='utf-8-sig')))
byhip = {int(r['Hip Number']): r for r in rows}

COLORS = r'(?:DARK BAY OR BROWN|BAY OR BROWN|GRAY OR ROAN|CHESTNUT|BAY|BLACK|GRAY|ROAN|WHITE|DARK BAY)'
SEXW  = r'(?:COLT|FILLY|GELDING|RIDGLING)'

def hipno(p):
    m = re.search(r'Hip No\.\s*\n\s*(\d+)\s*\n', p)
    if m: return int(m.group(1))
    m = re.search(r'Hip No\.[^\n]*\n[^\n]*\n\s*(\d+)\s*\n', p)
    return int(m.group(1)) if m else None

def section(p, start, end_pats):
    m = re.search(start, p)
    if not m: return None
    tail = p[m.end():]
    ends = [re.search(e, tail) for e in end_pats]
    cut = min([e.start() for e in ends if e], default=len(tail))
    return ' '.join(tail[:cut].split()).strip() or None

DAM_ENDS = [r'\n\d(?:st|nd|rd|th) dam\b', r'\nEngagements:', r'\nFoaled in\b', r'\nBy [A-Z]']

out = {}
for p in pages:
    h = hipno(p)
    if h is None or h not in byhip: continue
    r = byhip[h]

    cm = re.search(r'\n(' + COLORS + r')\s+(' + SEXW + r')\s*\n', p)
    color, sexw = (cm.group(1).title(), cm.group(2).title()) if cm else (None, None)

    fm = re.search(r'Foaled ([A-Z][a-z]+ \d{1,2}, \d{4})', p)
    fo = fm.group(1) if fm else None

    sire_p = section(p, r'\nBy [A-Z][^\n]*', [r'\n1st dam\b', r'\nEngagements:', r'\nFoaled in\b'])
    bym = re.search(r'\nBy ([A-Z][^.(]*)\((\d{4})\)\.', p)
    sire_line = None
    if bym:
        sire_line = ('By ' + bym.group(1).strip() + ' (' + bym.group(2) + ').' + (sire_p or '')).strip()
    elif sire_p:
        m2 = re.search(r'\n(By [A-Z][^\n]*)', p)
        sire_line = ((m2.group(1) if m2 else '') + ' ' + sire_p).strip()

    d1 = section(p, r'\n1st dam\b', DAM_ENDS)
    d2 = section(p, r'\n2nd dam\b', DAM_ENDS)
    d3 = section(p, r'\n3rd dam\b', DAM_ENDS)

    em = re.search(r'\nEngagements:\s*([^\n]+)', p)
    fim = re.search(r'\nFoaled in ([^.\n]+)', p)

    out[h] = dict(hip=h, sex=r['Sex'], sire=r['Sire'], dam=r['Dam'],
                  consignor=r['Consignor'].strip(), barn=r['Barn'],
                  color=color, sexw=sexw, foaled=fo,
                  sire_text=sire_line, d1=d1, d2=d2, d3=d3,
                  eng=em.group(1).strip() if em else None,
                  state=fim.group(1).strip() if fim else None)

json.dump(out, open('horses_full.json','w'), separators=(',',':'))
n=len(out)
def pct(k): return round(100*sum(1 for v in out.values() if v[k])/n,1)
print('hips:', n)
for k in ['color','foaled','sire_text','d1','d2','d3','eng','state']:
    print(f'  {k:10s} {pct(k):5.1f}%')
import os
print('raw json MB:', round(os.path.getsize('horses_full.json')/1048576,2))
