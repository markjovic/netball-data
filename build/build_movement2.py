# build_movement2.py — MENA junior player movement per club: 9&U (Friday) AND 11&U (Saturday) teams, 6 seasons.
# Box keys: D<season>.<band>|<kind[:name]> (destination) / S<season>.<band>|<kind[:name]> (source); band = 9 or 11.
# Usage: python3 build_movement2.py <users-scan.json> <netball-data.json> <out movement.json> <grades-<id>.json …>
# Positions per season: a player's 9U team, else their 11U team (Saturday MENA comp, team name with 11U/U11).
# Within-club moves are links; moves to/from other clubs, other associations, new players, returners, 13U+,
# 'sat out' and 'no later record' are named source/destination boxes. Aggregates + pseudonymous P-codes only.
import json, re, sys, collections, hashlib
scan_p, nd_p, out_p = sys.argv[1:4]
S = json.load(open(scan_p, encoding='utf-8-sig'))
ND = json.load(open(nd_p, encoding='utf-8-sig'))
GR = {}
for gp_ in sys.argv[4:]:
    g_ = json.load(open(gp_, encoding='utf-8-sig')); GR[g_['compId']] = g_
if S.get('failedIds'): sys.exit(f"scan has {len(S['failedIds'])} failed ids - refusing to build")
import os
CFG = json.load(open(os.environ['MOVEMENT_CONFIG'], encoding='utf-8-sig')) if os.environ.get('MOVEMENT_CONFIG') else None
if CFG:   # seasons from data/config.json: the last movementSeasons 9U seasons
    M11_OF_TERM = dict(CFG['elevenComps'])
    # only seasons that have been built (a new season with no fixtures yet is left out) and whose term has a
    # Saturday 11U comp configured (a season whose 11U comp isn't published yet is left out, with a warning)
    for x in CFG['seasons']:
        if x['compId'] in ND and x['term'] not in M11_OF_TERM: print(f"::warning::movement: {x['label']} left out - no 11U (Saturday) comp configured for {x['term']} yet")
    SEASONS = [(x['compId'], x['label'], x['term']) for x in CFG['seasons'] if x['compId'] in ND and x['term'] in M11_OF_TERM][-CFG.get('movementSeasons', 6):]
else:
    SEASONS = [('2402', '2024 Autumn', '2024H1'), ('2939', '2024 Spring', '2024H2'), ('3465', '2025 Autumn', '2025H1'),
               ('4057', '2025 Spring', '2025H2'), ('4596', '2026 Autumn', '2026H1'), ('5232', '2026 Spring', '2026H2')]
    M11_OF_TERM = {'2024H1': '2403', '2024H2': '2937', '2025H1': '3467', '2025H2': '4144', '2026H1': '4595', '2026H2': '5224'}
missing11 = [t for _, _, t in SEASONS if t not in M11_OF_TERM]
if missing11: sys.exit(f'no 11U (Saturday) competition configured for terms {missing11} - add to config elevenComps')
NINE = [c for c, _, _ in SEASONS]; LABELS = [l for _, l, _ in SEASONS]; TERMS = [t for _, _, t in SEASONS]; NS = len(SEASONS)
ELEVEN = [M11_OF_TERM[t] for t in TERMS]
COMP = {
 '1141': ('2022H2','M9'),  '1324': ('2022H2','OTH'), '1581': ('2023H1','M9'),  '1641': ('2023H1','OTH'),
 '2053': ('2023H2','M9'),  '2239': ('2023H2','OTH'), '2402': ('2024H1','M9'),  '2403': ('2024H1','M11'),
 '2513': ('2024H1','OTH'), '2578': ('2024H1','OTH'), '2937': ('2024H2','M11'), '2939': ('2024H2','M9'),
 '2957': ('2024H2','OTH'), '3276': ('2024H2','OTH'), '3465': ('2025H1','M9'),  '3467': ('2025H1','M11'),
 '3537': ('2025H1','OTH'), '3621': ('2025H1','OTH'), '4035': ('2025H2','OTH'), '4057': ('2025H2','M9'),
 '4085': ('2025H2','OTH'),
 '4144': ('2025H2','M11'), '4342': ('2025H2','OTH'), '4506': ('2026H1','OTH'), '4595': ('2026H1','M11'),
 '4596': ('2026H1','M9'),  '4689': ('2026H1','OTH'), '4720': ('2026H1','OTH'), '4753': ('2026H1','OTH'),
 '4887': ('2026H1','TRN'), '4941': ('2026H1','OTH'), '4968': ('2026H1','OTH'), '5174': ('2026H2','OTH'),
 '5190': ('2026H2','OTH'), '5224': ('2026H2','M11'), '5232': ('2026H2','M9'),  '5249': ('2026H2','OTH'),
 '5300': ('2026H2','OTH'), '5332': ('2026H2','OTH'), '5565': ('2026H2','OTH'), '5654': ('2026H2','TRN'),
}

CLUB_KEYS = sorted(json.load(open(nd_p, encoding='utf-8-sig'))['_clubs'], key=len, reverse=True)
ALIAS = {'blackburn lake': 'BLNC'}
def club(team):
    # 2024 names are inconsistent ('U9 Trinity Lilac', 'ST JAMES NSG 9U BLUE', 'East Ringwood Blue', 'Blackburn Lake U9 Red'):
    # strip apostrophes and a leading age token, then take the longest known club key (or alias) the name starts with.
    t = (team or '').replace("'", '').replace('’', '').strip()
    t = re.sub(r'^(u\s*/?\s*\d+|\d+\s*&?\s*u)\s+', '', t, flags=re.I)
    low = t.lower()
    for a, k in ALIAS.items():
        if low.startswith(a): return k
    for k in CLUB_KEYS:
        if low.startswith(k.lower()): return k
    return re.sub(r'\s+(\d+\s*&?\s*u|u\s*/?\s*\d+)\b.*$', '', t, flags=re.I).strip()   # unknown club: old rule

def is11(team): return bool(re.search(r'(?<!\d)(11\s*&?\s*u|u\s*/?\s*11)(?!\d)', team or '', re.I))

sel = []
for p in S['players']:
    rows = [{**c, 'teamName': (c.get('teamName') or '').strip()} for c in p['comps']]
    if any(r['competitionId'] in NINE for r in rows) or any(r['competitionId'] in ELEVEN and is11(r['teamName']) for r in rows):
        sel.append((p, rows))
for c, _, t in SEASONS: COMP.setdefault(c, (t, 'M9'))
for t, c in M11_OF_TERM.items(): COMP.setdefault(c, (t, 'M11'))
ANCHORS = sorted((int(k), v[0]) for k, v in COMP.items())
def infer(cid, name):
    n = name.lower()
    kind = 'TRN' if re.search(r'tournament|carnival|championship|fling', n) else 'OTH'
    if 'mena' in n and re.search(r'9\s*&\s*u|9u|netsetgo', n) and re.search(r'\bfri', n): kind = 'M9'
    elif 'mena' in n and re.search(r'\bsat\b|saturday|u11 to open|11u to open', n): kind = 'M11'
    m = re.search(r'(20\d\d)\s*[/-]\s*(\d\d)\b', n)
    if m and 'summer' in n: return (f'20{m.group(2)}H1', kind, 'name')
    y = re.findall(r'20(2\d)', n)
    half = 'H1' if re.search(r'autumn|winter|season 1\b|\(feb', n) else ('H2' if re.search(r'spring|season 2\b', n) else None)
    if y and half: return (f'20{y[0]}{half}', kind, 'name')
    lower = [t for i, t in ANCHORS if i <= int(cid)]
    t = lower[-1] if lower else ANCHORS[0][1]
    if y and t[:4] < f'20{y[0]}': t = f'20{y[0]}H1'   # year in the name but no season word: not earlier than that year
    return (t, kind, 'id')
INFERRED = {}
for _, rows in sel:
    for r in rows:
        if r['competitionId'] not in COMP and r['competitionId'] not in INFERRED:
            INFERRED[r['competitionId']] = infer(r['competitionId'], r['competitionName'])
for k, (term, kind, how) in INFERRED.items(): COMP[k] = (term, kind)

CLUBS_INFO = ND['_clubs']
nodes = collections.Counter(); band = {}; links = collections.Counter(); alsoN = collections.Counter()
dest = collections.Counter(); src = collections.Counter(); ageing = collections.defaultdict(collections.Counter)
summary = collections.Counter(); PLAYERS = []; hidden = 0
SALT = 'mena9u-7f3c1d'
def year(term): return int(term[:4])
for p, rows in sel:
    if p.get('isHidden') is True: hidden += 1
    byterm = collections.defaultdict(list)
    for r in rows: term, kind = COMP[r['competitionId']]; byterm[term].append((kind, r))
    pos = {}; also = {}
    for s in range(NS):
        r9 = [r for r in rows if r['competitionId'] == NINE[s]]
        r11 = [r for r in rows if r['competitionId'] == ELEVEN[s] and is11(r['teamName'])]
        if r9: pos[s] = (r9[0]['teamName'], '9');  also[s] = r11[0]['teamName'] if r11 else None
        elif r11: pos[s] = (r11[0]['teamName'], '11')
    if not pos: continue
    for s, (t, b) in pos.items(): nodes[(s, t)] += 1; band[(s, t)] = b
    for s, a in also.items():
        if a: alsoN[(s, a)] += 1
    def status(term, home):
        mena = [x for k, x in byterm.get(term, []) if k == 'M11']        # Saturday comp, older age group
        oth = [x for k, x in byterm.get(term, []) if k == 'OTH']
        if mena:
            c = club(mena[0]['teamName'])
            return ('up13', '') if c == home else ('to', c)
        if oth: return ('assoc', oth[0]['competitionName'].strip())
        return None
    hops = []
    seasons = sorted(pos)
    for s in seasons:
        t, b = pos[s]; home = club(t); key = f'{s}|{t}'
        later = [x for x in seasons if x > s]
        if later:
            n = min(later); tn, bn = pos[n]
            if club(tn) == home: links[(s, t, n, tn)] += 1; hops.append([key, f'{n}|{tn}'])
            else:
                dk = f'to:{club(tn)}'; dest[(s, t, dk)] += 1; hops.append([key, f'D{s+1}.{b}|{dk}'])
                sk = f'from:{home}'; src[(n, tn, sk)] += 1; hops.append([f'S{n-1}.{bn}|{sk}', f'{n}|{tn}'])
        elif s < NS - 1:
            st = status(TERMS[s + 1], home)
            if st: dk = st[0] if st[0] in ('up13',) else f'{st[0]}:{st[1]}'
            elif any(tm > TERMS[s + 1] and any(k in ('M9', 'M11', 'OTH') for k, _ in byterm[tm]) for tm in byterm): dk = 'gap'
            else: dk = 'none'
            dest[(s, t, dk)] += 1; hops.append([key, f'D{s+1}.{b}|{dk}'])
    first = seasons[0]
    if first > 0:
        t, b = pos[first]; prev = TERMS[first - 1]
        oth = [x for k, x in byterm.get(prev, []) if k == 'OTH']
        mena = [x for k, x in byterm.get(prev, []) if k in ('M11', 'M9')]
        if mena and club(mena[0]['teamName']) != club(t): sk = f'from:{club(mena[0]["teamName"])}'
        elif oth: sk = f'fromassoc:{oth[0]["competitionName"].strip()}'
        elif any(tm < TERMS[first] and any(k in ('M9', 'M11', 'OTH') for k, _ in byterm[tm]) for tm in byterm): sk = 'back'
        else: sk = 'new'
        src[(first, t, sk)] += 1; hops.append([f'S{first-1}.{b}|{sk}', f'{first}|{t}'])
    # ageing out of 11U after 2026 (two-year band, calendar year): first-year 11U players last played 9U in 2025
    last9 = max([year(COMP[r['competitionId']][0]) for r in rows if COMP[r['competitionId']][1] == 'M9'] or [0])
    y9 = {year(COMP[r['competitionId']][0]) for r in rows if COMP[r['competitionId']][1] == 'M9'}
    any11_early = any(COMP[r['competitionId']][1] == 'M11' and is11(r['teamName']) and year(COMP[r['competitionId']][0]) <= 2025
                      and year(COMP[r['competitionId']][0]) not in y9 for r in rows)   # 11U while also in 9U that year = playing up, not a 2nd year
    age = None
    for s in seasons:
        if pos[s][1] == '11' and TERMS[s].startswith('2026'):
            age = 'stay' if last9 >= 2025 else ('out' if (any11_early or 0 < last9 <= 2024) else 'unk')
            ageing[(s, pos[s][0])][age] += 1
    cells = []
    for s in range(NS):
        if s in pos:
            c = {'t': pos[s][0], 'b': pos[s][1]}
            if also.get(s): c['also'] = also[s]
            if pos[s][1] == '11' and TERMS[s].startswith('2026') and age: c['age'] = age
            cells.append(c)
        elif s < first: cells.append(None)
        else:
            prev = max(x for x in seasons if x < s); st = status(TERMS[s], club(pos[prev][0]))
            cells.append({'k': 'off'} if not st else {'k': st[0], 'l': st[1] if st[0] != 'up13' else next(x['teamName'] for k, x in byterm[TERMS[s]] if k == 'M11')})
    if p.get('isHidden') is not True:
        PLAYERS.append({'_o': (first, pos[first][0], hashlib.sha256((SALT + str(p['userId'])).encode()).hexdigest()), 's': cells, 'h': hops})
    # league summary (9U only, as before)
    nine = {s: pos[s] for s in pos if pos[s][1] == '9'}
    if nine:
        last = max(nine); now = byterm.get(TERMS[-1], [])
        if last == NS - 1:
            summary['still|' + ('also11' if any(k == 'M11' for k, _ in now) else 'only9')] += 1
            if len({club(nine[s][0]) for s in nine}) > 1: summary['still|changedClub'] += 1
        else:
            n11 = [x for k, x in now if k == 'M11']
            st = ('m11s' if club(n11[0]['teamName']) == club(nine[last][0]) else 'm11o') if n11 else ('oth' if any(k == 'OTH' for k, _ in now) else 'none')
            summary[f'left|{last}|{st}'] += 1

GT = {cid: {t['team'].strip(): t for t in g['teams']} for cid, g in GR.items()}
NODES = []
for (s, team), n in sorted(nodes.items()):
    c = club(team); b = band[(s, team)]
    nd = {'sid': s, 'team': team, 'club': c, 'band': b, 'colour': CLUBS_INFO.get(c, {}).get('colour', '#7a8591'), 'n': n}
    if b == '9':
        if NINE[s] in GR:
            t = GT[NINE[s]].get(team)
            if not t or not t['final']: sys.exit(f'no {LABELS[s]} grade for {team}')
            nd.update(gi=GR[NINE[s]]['gradeOrder'].index(t['final']), g=t['final'], gp=t['gp'])
        else:
            gv = ND[NINE[s]]['gradesView']
            hit = [(i, x['label'], j) for i, x in enumerate(gv) for j, r in enumerate(x['ladder']) if (r.get('team') or '').strip() == team]
            if len(hit) != 1: sys.exit(f'grade lookup {NINE[s]} {team}: {len(hit)} matches')
            nd.update(gi=hit[0][0], g=hit[0][1], gp=hit[0][2] + 1)
    if (s, team) in ageing: nd['age'] = dict(ageing[(s, team)])
    if alsoN.get((s, team)): nd['alsoN'] = alsoN[(s, team)]   # also on this 11U team while playing 9U (counted in their 9U team)
    NODES.append(nd)
# partition checks: every node's players are fully accounted for on both sides
for nd in NODES:
    s, t = nd['sid'], nd['team']
    if s < NS - 1:
        out_ = sum(n for (a, ta, b, tb), n in links.items() if a == s and ta == t) + sum(n for (a, ta, k), n in dest.items() if a == s and ta == t)
        if out_ != nd['n']: sys.exit(f'out partition {s} {t}: {out_} vs {nd["n"]}')
    if s > 0:
        in_ = sum(n for (a, ta, b, tb), n in links.items() if b == s and tb == t) + sum(n for (b, tb, k), n in src.items() if b == s and tb == t)
        if in_ != nd['n']: sys.exit(f'in partition {s} {t}: {in_} vs {nd["n"]}')
PLAYERS.sort(key=lambda x: x['_o'])
for i, pl in enumerate(PLAYERS, 1): pl['c'] = f'P{i:03d}'; del pl['_o']
clubs = sorted({nd['club'] for nd in NODES if nd['club'] in CLUBS_INFO})
M = {'version': 2, 'seasons': LABELS, 'clubs': clubs, 'clubInfo': {c: CLUBS_INFO[c] for c in clubs}, 'nodes': NODES,
     'links': [{'sa': a, 'ta': ta, 'sb': b, 'tb': tb, 'n': n} for (a, ta, b, tb), n in sorted(links.items())],
     'dest': [{'sa': s, 'ta': t, 'k': k, 'n': n} for (s, t, k), n in sorted(dest.items())],
     'src': [{'sb': s, 'tb': t, 'k': k, 'n': n} for (s, t, k), n in sorted(src.items())],
     'summary': dict(sorted(summary.items())), 'players': PLAYERS,
     'stats': {'players': len(sel), 'hidden': hidden, 'source': S.get('label', ''),
               'inferredComps': {k: [COMP[k][0], COMP[k][1], how] for k, (_, _, how) in INFERRED.items()},
               'gradeBasis': {LABELS[NINE.index(c)]: g.get('note', '') for c, g in GR.items() if c in NINE}}}
json.dump(M, open(out_p, 'w', encoding='utf-8', newline='\n'), ensure_ascii=False, separators=(',', ':'))
print('players', len(sel), 'nodes', len(NODES), '(11U', sum(1 for n in NODES if n['band'] == '11'), ') links', len(links), 'dest', len(dest), 'src', len(src))
print('summary', M['summary'])
