# build_all.py — weekly rebuild for the MENA 9U stats site (runs in GitHub Actions, or locally).
#
#   python3 build/build_all.py --today YYYY-MM-DD [--harvest DIR ...] [--careers FILE] [--scan FILE]
#
# Run from the repo root. Reads and writes data/*.json, writes index.html and movement.html.
#  1. --harvest DIR: each DIR is an nc-harvest HARVEST output. Its matches-<id>.json is MERGED into
#     data/matches-<id>.json (union by match id; a new record wins, except that a 0-0 never overwrites a
#     captured score and empty per-quarter data never overwrites captured quarters). _divisions-<id>.json
#     replaces data/_divisions-<id>.json when it has rows. Games with 1-3 quarters are flagged halfGame.
#  2. --careers FILE: a COMPLETE users-careers.json (USER_IDS refresh of data/players.json). Each player's
#     history is replaced by the fresh one.
#  3. --scan FILE: a COMPLETE users-history.json (full_history scan of new ids). Players with any MENA
#     competition are added to data/players.json; config scan.highWater moves to the highest netball id seen.
#  4. Every configured season whose matches file changed, or that is still in progress, is rebuilt with the
#     original builder (builddata2_core.build); 'static' seasons (2025 Autumn) are never rebuilt.
#  5. index.html = build/app2.html + data; movement.json/html = build_movement2.py + build/movement2-template.html.
# Any inconsistency stops the script with a non-zero exit, so the workflow commits nothing.
import argparse, json, os, sys, subprocess, datetime
sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import builddata2_core as B

ap = argparse.ArgumentParser()
ap.add_argument('--today', required=True)
ap.add_argument('--harvest', nargs='*', default=[])
ap.add_argument('--careers')
ap.add_argument('--scan')
ap.add_argument('--rebuild-all', action='store_true', help='rebuild every non-static season, not just changed/in-progress ones')
a = ap.parse_args()
TODAY = a.today
log = []
def say(m): print(m); log.append(m)
def load(p): return json.load(open(p, encoding='utf-8-sig'))
def save(p, obj, compact=True):
    with open(p, 'w', encoding='utf-8', newline='\n') as f:
        json.dump(obj, f, ensure_ascii=False, separators=(',', ':') if compact else None, indent=None if compact else 1)

CFG = load('data/config.json'); SEAS = {s['compId']: s for s in CFG['seasons']}
changed = set()

# 1. merge harvests
for d in a.harvest:
    for fn in sorted(os.listdir(d)):
        if not (fn.startswith('matches-') and fn.endswith('.json')): continue
        cid = fn[len('matches-'):-len('.json')]
        if cid not in SEAS: say(f'harvest {d}/{fn}: comp {cid} not in config — ignored'); continue
        new = load(os.path.join(d, fn)); path = f'data/matches-{cid}.json'
        old = load(path) if os.path.exists(path) else {'compId': cid, 'compName': new.get('compName'), 'matches': []}
        o = {m['id']: m for m in old['matches']}; before = json.dumps(old['matches'], sort_keys=True)
        kept = scored_new = 0
        for m in new['matches']:
            prev = o.get(m['id'])
            if prev and not (prev.get('t1') == 0 and prev.get('t2') == 0) and (m.get('t1') == 0 and m.get('t2') == 0):
                kept += 1; continue
            if prev and prev.get('periods') and not m.get('periods'): m['periods'] = prev['periods']
            o[m['id']] = m
        for m in o.values():
            q = len(m.get('periods') or [])
            if q == 2 and not (m.get('t1') == 0 and m.get('t2') == 0): m['halfGame'] = True   # washout half games (2026-10-23, 2026-11-20, 2025-08-15); 3 quarters = a source gap, not flagged
        merged = sorted(o.values(), key=lambda m: m['id'])
        if json.dumps(merged, sort_keys=True) != before:
            out = dict(old); out['matches'] = merged; out['count'] = len(merged); out['harvestedAt'] = new.get('harvestedAt')
            save(path, out); changed.add(cid)
        n_sc = sum(1 for m in merged if not (m.get('t1') == 0 and m.get('t2') == 0))
        say(f'{SEAS[cid]["label"]}: {len(new["matches"])} harvested, merged total {len(merged)} ({n_sc} scored); {kept} hidden 0-0 kept as previously captured')
        dv = os.path.join(d, f'_divisions-{cid}.json')
        if os.path.exists(dv) and load(dv).get('roundDivisionTeams'):
            if not os.path.exists(f'data/_divisions-{cid}.json') or load(dv) != load(f'data/_divisions-{cid}.json'):
                save(f'data/_divisions-{cid}.json', load(dv), compact=False); changed.add(cid)

# 2./3. players
P = load('data/players.json'); byid = {p['userId']: p for p in P['players']}
def slim(p): return {'userId': p['userId'], 'isHidden': p.get('isHidden'), 'comps': [{k: c.get(k) for k in ('competitionId', 'competitionName', 'teamId', 'teamName', 'divisionId', 'divisionName', 'games', 'isHidden')} for c in p['comps']]}
players_changed = False
if a.careers:
    C = load(a.careers)
    if C.get('failedIds'): sys.exit('careers refresh is not complete — refusing to use it')
    upd = 0
    for p in C['players']:
        if p['userId'] in byid and json.dumps(slim(p)['comps'], sort_keys=True) != json.dumps(byid[p['userId']]['comps'], sort_keys=True):
            byid[p['userId']] = slim(p); upd += 1
    say(f'players: careers refreshed for {len(C["players"])} ids, {upd} changed'); players_changed |= upd > 0
if a.scan:
    Sx = load(a.scan)
    if Sx.get('failedIds'): sys.exit('new-id scan is not complete — refusing to use it')
    add = 0; hi = CFG['scan']['highWater']
    for p in Sx['players']:
        hi = max(hi, p['userId'])
        if any('mena' in (c.get('competitionName') or '').lower() for c in p['comps']) and p['userId'] not in byid:
            byid[p['userId']] = slim(p); add += 1
    say(f'players: scanned {Sx.get("label")}, {len(Sx["players"])} netball players, {add} new MENA players added; high-water {CFG["scan"]["highWater"]} → {hi}')
    if hi != CFG['scan']['highWater']: CFG['scan']['highWater'] = hi; save('data/config.json', CFG, compact=False)
    players_changed |= add > 0
if players_changed:
    P['players'] = sorted(byid.values(), key=lambda p: p['userId']); P['updated'] = TODAY; save('data/players.json', P)

# 4. rebuild seasons
ND = load('data/netball-data.json')
for s in CFG['seasons']:
    cid = s['compId']; path = f'data/matches-{cid}.json'
    if s.get('builder') == 'static':
        if cid not in ND: sys.exit(f'{s["label"]} is static but missing from netball-data.json')
        continue
    if not os.path.exists(path): say(f'{s["label"]}: no matches yet — skipped'); continue
    M = load(path)['matches']
    ongoing = max((m.get('startTime') or '')[:10] for m in M) >= TODAY
    if cid in ND and cid not in changed and not ongoing and not a.rebuild_all: continue
    dv = f'data/_divisions-{cid}.json' if os.path.exists(f'data/_divisions-{cid}.json') else None
    colmap = s.get('colmap')
    if colmap is None and dv and s.get('autoColours', True):   # new season: colour names from players' division names
        names = {}
        for p in byid.values():
            for c in p['comps']:
                if c['competitionId'] == cid and c.get('divisionId') is not None:
                    names[str(c['divisionId'])] = (c.get('divisionName') or '').split('restrictions')[-1].replace('NetSetGo 9&U - Mixed', '').strip().upper()
        divs = {r['divisionId'] for r in load(dv)['roundDivisionTeams']}
        if divs and divs <= set(names) and all(names[x] for x in divs): colmap = {x: names[x] for x in divs}
    d = B.build(cid, s['label'], ongoing, path, colmap, dv if colmap else None)
    half = {m['id'] for m in M if m.get('halfGame') or (len(m.get('periods') or []) == 2 and not (m.get('t1') == 0 and m.get('t2') == 0))}
    for t in d['teams'].values():
        for g in t['games']:
            if g['mid'] in half: g['half'] = True
    ND[cid] = d
    say(f'{s["label"]}: rebuilt ({"in progress" if ongoing else "complete"}), {len(d["teams"])} teams, grades {[g["label"] for g in d["gradesView"]]}')
order = [s['compId'] for s in CFG['seasons'] if s['compId'] in ND][::-1]
ND = {**{k: ND[k] for k in order}, '_clubs': ND['_clubs'], '_order': order}
save('data/netball-data.json', ND)

# 5. pages
tpl = open('build/app2.html', encoding='utf-8').read(); data = open('data/netball-data.json', encoding='utf-8').read().strip()
if tpl.count('__DATA__') != 1 or '</script' in data: sys.exit('app template / data check failed')
open('index.html', 'w', encoding='utf-8', newline='\n').write(tpl.replace('__DATA__', data))
env = dict(os.environ, MOVEMENT_CONFIG='data/config.json')
grades = [f'data/{f}' for f in sorted(os.listdir('data')) if f.startswith('grades-') and f.endswith('.json')]
r = subprocess.run([sys.executable, '-I', 'build/build_movement2.py', 'data/players.json', 'data/netball-data.json', 'data/movement.json', *grades], env=env, capture_output=True, text=True)
print(r.stdout); print(r.stderr, file=sys.stderr)
if r.returncode: sys.exit('movement build failed')
tpl = open('build/movement2-template.html', encoding='utf-8').read(); data = open('data/movement.json', encoding='utf-8').read().strip()
if tpl.count('__DATA__') != 1 or '</script' in data: sys.exit('movement template / data check failed')
mv = json.loads(data); ids = {str(p['userId']) for p in byid.values()}
page = tpl.replace('__DATA__', data)
import re
if set(re.findall(r'\d{7,9}', page)) & ids: sys.exit('player ids found in movement.html — refusing to publish')
open('movement.html', 'w', encoding='utf-8', newline='\n').write(page)
say(f'pages built: index.html ({len(open("index.html", encoding="utf-8").read())//1024} KB), movement.html ({len(page)//1024} KB, {mv["stats"]["players"]} players)')
if os.environ.get('GITHUB_STEP_SUMMARY'):
    with open(os.environ['GITHUB_STEP_SUMMARY'], 'a', encoding='utf-8') as f: f.write('## Build\n\n' + '\n'.join('- ' + x for x in log) + '\n')
