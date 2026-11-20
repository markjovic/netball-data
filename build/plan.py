# plan.py — decide what this weekly run fetches. Writes GitHub step outputs (or prints them locally).
#   python3 -I build/plan.py TODAY FULL_RESCAN [comps.tsv] [competitions raw.json]
#   comps   : space-separated compIds to harvest = configured seasons still in progress (a fixture dated
#             today or later) or with no matches file yet; 'static' seasons are never harvested
#   fwd_lo  : first id of the forward new-player scan (highWater+1)
#   back_lo / back_hi : lookback scan range, or empty when no lookback is due (see PLAYER SCAN below)
#   find_ok : 'true' when the competition list was read; 'false' when it was missing or unreadable
# NEW SEASONS: when a competitions/list dump (nc-harvest RAW mode) is given, any MENA Friday 9&U club
# competition not yet in data/config.json is added as a season, and any MENA Saturday 11U club competition
# is added to elevenComps for its term. Both are listed in the step summary. config.json is rewritten only
# when something was added.
import json, os, re, sys, datetime
today, full = sys.argv[1], (sys.argv[2].lower() == 'true' if len(sys.argv) > 2 else False)
tsv = sys.argv[3] if len(sys.argv) > 3 and sys.argv[3] else None   # write compId<TAB>key<TAB>name lines for the harvest loop
raw = sys.argv[4] if len(sys.argv) > 4 and sys.argv[4] else None   # competitions/list dump
CFG_P = 'data/config.json'
cfg = json.load(open(CFG_P, encoding='utf-8-sig'))
notes = []

def is9(n):
    n = n.lower()
    return 'mena' in n and 'club competition' in n and not re.search(r'\bsat\b|saturday', n) and bool(re.search(r'netsetgo|\b9\s*&\s*u\b|\b9u\b|\b9&u\b', n))
def is11(n):
    n = n.lower()
    return 'mena' in n and 'club competition' in n and bool(re.search(r'\bsat\b|saturday', n)) and bool(re.search(r'\b11\s*&?\s*u\b|\bu\s*11\b', n))
def term_of(n, year):
    l = n.lower(); y = re.search(r'\b(20\d\d)\b', n); y = y.group(1) if y else year
    if not y: return None, None
    if 'autumn' in l or 'winter' in l: return f'{y}H1', f'{y} Autumn' if 'autumn' in l else f'{y} Winter'
    if 'spring' in l: return f'{y}H2', f'{y} Spring'
    return None, None

find_ok = 'false'
if raw:
    try:
        R = json.load(open(raw, encoding='utf-8-sig'))
        years = {}
        for r in R:
            if '/reference/year' in r['url'] and r['status'] == 200:
                years = {str(x['id']): x['description'] for x in json.loads(r['body'])}
        lists = [r for r in R if '/competitions/list' in r['url']]
        if not lists: raise ValueError('no competitions/list response in the dump')
        known9 = {s['compId'] for s in cfg['seasons']}
        added = False
        for r in lists:
            if r['status'] != 200: raise ValueError(f'HTTP {r["status"]} for {r["url"]}')
            if len(r['body']) != r['length']: raise ValueError(f'body truncated for {r["url"]}')
            yref = re.search(r'yearRefId=(\d+)', r['url']).group(1)
            year = years.get(yref)
            if years and year is None: raise ValueError(f'yearRefId {yref} not in the year list')
            for c in json.loads(r['body']):
                cid, name, key = str(c['id']), (c.get('longName') or c.get('name') or '').strip(), c.get('uniqueKey')
                if is9(name) and cid not in known9:
                    term, label = term_of(name, year)
                    if not term: notes.append(f'NOT ADDED (no Autumn/Spring in name): 9&U comp {cid} "{name}"'); continue
                    if any(s['term'] == term for s in cfg['seasons']):
                        notes.append(f'NOT ADDED (term {term} already has a 9&U season): comp {cid} "{name}"'); continue
                    cfg['seasons'].append({'compId': cid, 'label': label, 'term': term, 'key': key, 'name': name, 'colmap': None, 'addedBy': f'plan.py {today}'})
                    known9.add(cid); added = True; notes.append(f'NEW 9&U SEASON added: {label} — comp {cid} "{name}"')
                elif is11(name):
                    term, _ = term_of(name, year)
                    if term and term not in cfg['elevenComps']:
                        cfg['elevenComps'][term] = cid; added = True; notes.append(f'NEW 11U comp added for {term}: comp {cid} "{name}"')
                    elif term and cfg['elevenComps'][term] != cid:
                        notes.append(f'CHECK: second 11U comp for {term}: {cid} "{name}" (config has {cfg["elevenComps"][term]})')
        if added:
            cfg['seasons'].sort(key=lambda s: (s['term'], int(s['compId'])))
            cfg['elevenComps'] = dict(sorted(cfg['elevenComps'].items()))
            with open(CFG_P, 'w', encoding='utf-8', newline='\n') as f: json.dump(cfg, f, ensure_ascii=False, indent=1)
        find_ok = 'true'
        notes.append(f'competition list read: {sum(len(json.loads(r["body"])) for r in lists)} competitions in years ' + ', '.join(years.get(re.search(r"yearRefId=(\d+)", r["url"]).group(1), '?') for r in lists))
    except Exception as e:
        notes.append(f'COMPETITION LIST NOT READ — new seasons not checked this run: {e}')

comps = []
for s in cfg['seasons']:
    if s.get('builder') == 'static': continue
    p = f"data/matches-{s['compId']}.json"
    if not os.path.exists(p): comps.append(s['compId']); continue
    last = max((m.get('startTime') or '')[:10] for m in json.load(open(p, encoding='utf-8-sig'))['matches'])
    if last >= today: comps.append(s['compId'])
# PLAYER SCAN. Netball ids are ~25% dense and allocated at roughly 100k a year, but a new 9&U player's id is
# usually NOT new: in 2025-2026 only 7-41% of each season's first-timers had an id within 40k of that season's
# highest id, 58-78% within 100k, 84-92% within 200k and 96-100% within 300k (most registered 1-3 years before
# their first 9&U game). So two scans:
#   forward  : from highWater+1 in 5k blocks until a block has no netball players (the end of the allocated ids)
#   lookback : highWater-lookback .. highWater, to catch older ids that have just started playing. Run once a
#              day (scan.lastLookback) while a season is in its first lookbackDays (new players arrive at the
#              start of a season), or the whole range from floor when full_rescan is ticked.
sc = cfg['scan']; hw = sc['highWater']
back_lo = back_hi = ''
starting = []
for s in cfg['seasons']:
    p = f"data/matches-{s['compId']}.json"
    if s.get('builder') == 'static' or not os.path.exists(p): continue
    first = min((m.get('startTime') or '9999')[:10] for m in json.load(open(p, encoding='utf-8-sig'))['matches'])
    age = (datetime.date.fromisoformat(today) - datetime.date.fromisoformat(first)).days if first != '9999' else -1
    if 0 <= age <= sc.get('lookbackDays', 28): starting.append(f"{s['label']} (first fixture {first})")
if full:
    back_lo, back_hi = str(sc['floor']), str(hw); notes.append(f'player lookback: FULL rescan {sc["floor"]}..{hw}')
elif starting and sc.get('lastLookback') != today:
    back_lo, back_hi = str(hw - sc.get('lookback', 400000)), str(hw); notes.append(f'player lookback {back_lo}..{back_hi} — season starting: {", ".join(starting)}')
else:
    notes.append('player lookback: not needed this run' + (' (already done today)' if starting else ' (no season in its first weeks)'))
out = {'comps': ' '.join(comps), 'fwd_lo': str(hw + 1), 'back_lo': back_lo, 'back_hi': back_hi, 'find_ok': find_ok}
if tsv:
    with open(tsv, 'w', encoding='utf-8') as f:
        for c in comps:
            s = next(x for x in cfg['seasons'] if x['compId'] == c); f.write(f"{c}\t{s['key']}\t{s['name']}\n")
dest = os.environ.get('GITHUB_OUTPUT')
with (open(dest, 'a') if dest else sys.stdout) as f:
    for k, v in out.items(): f.write(f'{k}={v}\n')
for n in notes: print(n, file=sys.stderr)
if os.environ.get('GITHUB_STEP_SUMMARY') and notes:
    with open(os.environ['GITHUB_STEP_SUMMARY'], 'a', encoding='utf-8') as f: f.write(''.join(f'- {n}\n' for n in notes))
