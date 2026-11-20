# plan.py — decide what this weekly run fetches. Writes GitHub step outputs (or prints them locally).
#   comps   : space-separated compIds to harvest = configured seasons still in progress (a fixture dated
#             today or later) or with no matches file yet; 'static' seasons are never harvested
#   scan_lo / scan_hi : id window for the new-player scan (full_rescan=true → from the configured floor)
import json, os, sys
today, full = sys.argv[1], (sys.argv[2].lower() == 'true' if len(sys.argv) > 2 else False)
tsv = sys.argv[3] if len(sys.argv) > 3 else None   # optional: write compId<TAB>key<TAB>name lines for the harvest loop
cfg = json.load(open('data/config.json', encoding='utf-8-sig'))
comps = []
for s in cfg['seasons']:
    if s.get('builder') == 'static': continue
    p = f"data/matches-{s['compId']}.json"
    if not os.path.exists(p): comps.append(s['compId']); continue
    last = max((m.get('startTime') or '')[:10] for m in json.load(open(p, encoding='utf-8-sig'))['matches'])
    if last >= today: comps.append(s['compId'])
hw, win = cfg['scan']['highWater'], cfg['scan']['window']
lo = cfg['scan']['floor'] if full else hw + 1
out = {'comps': ' '.join(comps), 'scan_lo': str(lo), 'scan_hi': str(hw + win)}
if tsv:
    with open(tsv, 'w', encoding='utf-8') as f:
        for c in comps:
            s = next(x for x in cfg['seasons'] if x['compId'] == c); f.write(f"{c}\t{s['key']}\t{s['name']}\n")
dest = os.environ.get('GITHUB_OUTPUT')
with (open(dest, 'a') if dest else sys.stdout) as f:
    for k, v in out.items(): f.write(f'{k}={v}\n')
