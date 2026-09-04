import re, csv, json, os
BARNFIX = json.load(open('barn_fix.json'))
SESSIONS = [(1,'1','Mon Sep 14',1,184),(2,'1','Tue Sep 15',190,377),
            (3,'2','Wed Sep 16',381,757),(4,'2','Thu Sep 17',758,1136),
            (5,'3','Sat Sep 19',1137,1552),(6,'3','Sun Sep 20',1553,1975),
            (7,'4','Mon Sep 21',1976,2392),(8,'4','Tue Sep 22',2393,2815),
            (9,'5A','Wed Sep 23',2816,3242),(10,'5A','Thu Sep 24',3243,3673),
            (11,'5B','Fri Sep 25',3674,4169),(12,'5B','Sat Sep 26',4170,4650)]
def sess_of(h):
    for i,(n,bk,day,lo,hi) in enumerate(SESSIONS):
        if lo <= h <= hi: return i
    return None
PDFBARN = json.load(open('pdf_barn.json'))

pages = open('full.txt', encoding='utf-8').read().split('\f')[:4642]
rows = list(csv.DictReader(open('/root/.claude/uploads/7aec7b8f-b96e-51a3-9a05-d51c9c5d36c2/30b867d7-catalog08_30_2026.csv', encoding='utf-8-sig')))
byhip = {int(r['Hip Number']): r for r in rows}

COLORS = r'(?:Dark Bay or Brown|Bay or Brown|Gray or Roan|Chestnut|Bay|Black|Gray|Roan|White|Dark Bay)'
SEXW   = r'(?:Colt|Filly|Gelding|Ridgling)'
MON    = r'(?:January|February|March|April|May|June|July|August|September|October|November|December)'
DAM_ENDS = [r'\n\d(?:st|nd|rd|th) dam\b', r'\nEngagements:', r'\nFoaled in\b', r'\nBy [A-Z]']

def hipno(p):
    m = re.search(r'Hip No\.\s*\n\s*(\d+)\s*\n', p) or re.search(r'Hip No\.[^\n]*\n[^\n]*\n\s*(\d+)\s*\n', p)
    return int(m.group(1)) if m else None

def section(p, start, end_pats):
    m = re.search(start, p)
    if not m: return None
    tail = p[m.end():]
    cut = min([e.start() for e in (re.search(x, tail) for x in end_pats) if e], default=len(tail))
    return ' '.join(tail[:cut].split()).strip() or None

def clip(s, n):
    if not s or len(s) <= n: return s
    cut = s.rfind(' ', 0, n)
    return s[:cut if cut > n*0.6 else n].rstrip(' ,;.') + '…'

recs = []
for p in pages:
    h = hipno(p)
    if h is None or h not in byhip: continue
    r = byhip[h]
    name = color = sexw = foaled = None

    m = re.search(r'\n(' + COLORS.upper() + r')\s+(' + SEXW.upper() + r')\s*\nFoaled (' + MON + r' \d{1,2}, \d{4})', p, re.I)
    if m and m.group(1).isupper():
        color, sexw, foaled = m.group(1).title(), m.group(2).title(), m.group(3)
    else:
        m = re.search(r'\n([A-Z][A-Z0-9 \'\.\-]{1,28})\n(' + COLORS + r') (' + SEXW + r'); foaled (' + MON + r' \d{1,2}, \d{4})', p)
        if m:
            name, color, sexw, foaled = m.group(1).strip().title(), m.group(2), m.group(3), m.group(4)
        else:
            m = re.search(r'\n(' + COLORS.upper() + r')\s+(' + SEXW.upper() + r')\s*\n', p)
            if m: color, sexw = m.group(1).title(), m.group(2).title()
            m = re.search(r'[Ff]oaled (' + MON + r' \d{1,2}, \d{4})', p)
            if m: foaled = m.group(1)

    sp = section(p, r'\nBy [A-Z][^\n]*', [r'\n1st dam\b', r'\nEngagements:', r'\nFoaled in\b'])
    bym = re.search(r'\nBy ([A-Z][^.(]*)\((\d{4})\)\.', p)
    sire_text = ('By ' + bym.group(1).strip() + ' (' + bym.group(2) + '). ' + (sp or '')).strip() if bym else (
        (re.search(r'\n(By [A-Z][^\n]*)', p).group(1) + ' ' + (sp or '')).strip() if re.search(r'\n(By [A-Z][^\n]*)', p) else None)

    em  = re.search(r'\nEngagements:\s*([^\n]+)', p)
    fim = re.search(r'\nFoaled in ([^.\n]+)', p)

    fx = BARNFIX.get(str(h))
    barn = fx['barn'] if fx else r['Barn'].strip()
    printed = ' '.join((PDFBARN.get(str(h)) or '').replace('&', ' & ').split())
    printed = printed if printed and re.sub(r'\D','',printed) != barn else None
    recs.append(dict(hip=h, name=name, sex=r['Sex'], sire=r['Sire'], dam=r['Dam'],
                     consignor=' '.join(r['Consignor'].split()), barn=barn, printed=printed,
                     color=color, sexw=sexw, foaled=foaled, sire_text=sire_text,
                     d1=clip(section(p, r'\n1st dam\b', DAM_ENDS), 520),
                     d2=clip(section(p, r'\n2nd dam\b', DAM_ENDS), 420),
                     eng=em.group(1).strip() if em else None,
                     state=fim.group(1).strip() if fim else None))

recs.sort(key=lambda x: x['hip'])
n = len(recs)
for k in ['color','foaled','sire_text','d1','d2','name']:
    print(f'  {k:10s} {100*sum(1 for v in recs if v[k])/n:5.1f}%')

# compact: intern sires / consignors / sire_text, months, states
sires = sorted({r['sire'] for r in recs}); si = {s:i for i,s in enumerate(sires)}
cons  = sorted({r['consignor'] for r in recs}); ci = {c:i for i,c in enumerate(cons)}
stxt  = {}
for r in recs:
    if r['sire_text']: stxt.setdefault(r['sire'], r['sire_text'])
sire_text = [stxt.get(s) for s in sires]
sts   = sorted({r['state'] for r in recs if r['state']}); ti = {s:i for i,s in enumerate(sts)}
MONS  = ['January','February','March','April','May','June','July','August','September','October','November','December']
COLS  = sorted({r['color'] for r in recs if r['color']}); coi = {c:i for i,c in enumerate(COLS)}

def fd(s):
    if not s: return None
    m = re.match(r'(\w+) (\d{1,2}), (\d{4})', s)
    return [MONS.index(m.group(1)), int(m.group(2))] if m else None

prs = sorted({r['printed'] for r in recs if r['printed']}); pri = {p:i for i,p in enumerate(prs)}
H = [[r['hip'], r['sex'], si[r['sire']], r['dam'], ci[r['consignor']], r['barn'],
      coi.get(r['color']), fd(r['foaled']), r['d1'], r['d2'], ti.get(r['state']),
      r['name'], 1 if r['eng'] else 0, pri.get(r['printed']), sess_of(r['hip'])] for r in recs]

data = dict(sires=sires, sire_text=sire_text, cons=cons, states=sts, colors=COLS, months=MONS, printed=prs, sessions=SESSIONS, H=H)
import collections as _c
_b = _c.Counter(r['barn'] for r in recs)
print('distinct barns now:', len(_b), '| any non-numeric:', [b for b in _b if not b.isdigit()])
print('hips carrying a printed two-barn note:', sum(1 for r in recs if r['printed']))
print('hips with no session:', sum(1 for r in recs if sess_of(r['hip']) is None))
json.dump(data, open('catalog.json','w'), separators=(',',':'))
print('compact MB:', round(os.path.getsize('catalog.json')/1048576, 2), '| hips:', n)
