// nc-backfill-probe.mjs  (Playwright edition) — TARGET-COMP deep check
// For each target 9U competition (current + two previous), determine exactly how its
// scores can be backfilled. All API calls run INSIDE the loaded site page (WAF needs a
// real browser; token from localStorage; no credentials).
//
// Per target it checks:
//   - competitions/list lookup (name, uniqueKey, status)
//   - round/matches by NUMERIC id and by uniqueKey (resolves the "0 rounds" case; saves
//     raw bodies; reports rounds/allRoundsHidden/hidden/visible/scored)
//   - teams/enduser/list (is the comp real? team count)
//   - DRAWS endpoint POST /competition/api/draws?userId= with body
//     {competitionUniqueKey:<key>, yearRefId, sourceSystem:"User"}  ← correct field name
//     (earlier run proved the token is accepted; it only complained the key field was missing).
//     If this returns the draw it is the MASTER KEY that unlocks every hidden season.
//   - ladder per SINGLE division (the endpoint rejects multi-division) — standings availability
// Then a per-comp verdict + recommended backfill route.
//
// Env: ORG_KEY (default ab63c5b3-…), TARGETS (compId:yearRefId list; default 5232:8,4596:8,4057:7),
//      BOOT_KEY (default 9U 2026 Spring key), OUT_DIR (default backfill-out).
// Exit 0 ran / 1 boot/token failed / 3 crash.

import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

const SITE = 'https://registration.netballconnect.com';
const LIVE = 'https://api-netball.squadi.com/livescores';
const COMPETITION = 'https://api-netball.squadi.com/competition';
const ORG_KEY = (process.env.ORG_KEY || 'ab63c5b3-fd1a-41a6-a1a2-326989b20247').trim();
const TARGETS = (process.env.TARGETS || '5232:8,4596:8,4057:7').split(',').map((s) => s.trim()).filter(Boolean)
  .map((s) => { const [id, year] = s.split(':'); return { id: id.trim(), year: (year || '8').trim() }; });
const BOOT_KEY = (process.env.BOOT_KEY || '8819433a-2375-4c6a-9039-4658036b083d').trim();
const OUT = process.env.OUT_DIR || 'backfill-out';
const SUMMARY_FILE = process.env.GITHUB_STEP_SUMMARY || '';
const YEAR_NAME = { '2': '2019', '1': '2020', '3': '2021', '4': '2022', '5': '2023', '6': '2024', '7': '2025', '8': '2026' };

function md(s) { return String(s).replace(/\|/g, '\\|').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

async function apiGet(page, url) {
  const r = await page.evaluate(async (u) => {
    try { const res = await fetch(u, { headers: { accept: 'application/json', authorization: localStorage.getItem('token') || '' } }); return { s: res.status, b: await res.text() }; } catch (e) { return { err: String((e && e.message) || e) }; }
  }, url);
  if (r.err) return { status: null, json: null, text: '', err: r.err };
  let json = null; try { json = JSON.parse(r.b); } catch { /* */ }
  return { status: r.s, json, text: r.b, err: '' };
}
async function apiPost(page, url, bodyObj) {
  const r = await page.evaluate(async (args) => {
    const [u, body] = args;
    try { const res = await fetch(u, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json', authorization: localStorage.getItem('token') || '' }, body: JSON.stringify(body) }); return { s: res.status, b: await res.text() }; } catch (e) { return { err: String((e && e.message) || e) }; }
  }, [url, bodyObj]);
  if (r.err) return { status: null, json: null, text: '', err: r.err };
  let json = null; try { json = JSON.parse(r.b); } catch { /* */ }
  return { status: r.s, json, text: r.b, err: '' };
}
function rstat(json) {
  if (!json || !Array.isArray(json.rounds)) return null;
  let hidden = 0, matches = 0, scored = 0;
  for (const r of json.rounds) { if (r.isHidden === true) hidden++; for (const m of (r.matches || [])) { matches++; if ((m.team1Score || 0) !== 0 || (m.team2Score || 0) !== 0) scored++; } }
  return { allRoundsHidden: json.allRoundsHidden, rounds: json.rounds.length, hidden, matches, scored };
}
// count matches anywhere in an arbitrary draws payload (rounds[].matches[], or a flat matches[])
function countDrawMatches(j) {
  let n = 0, ids = [];
  const walk = (o) => {
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o)) { o.forEach(walk); return; }
    if (o.matchId !== undefined || (o.id !== undefined && (o.team1Score !== undefined || o.team1 !== undefined || o.roundId !== undefined))) { n++; if (ids.length < 5) ids.push(o.matchId ?? o.id); }
    for (const k of Object.keys(o)) walk(o[k]);
  };
  walk(j);
  return { n, ids };
}

async function main() {
  await fs.mkdir(OUT, { recursive: true });
  const L = [];
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
    const page = await ctx.newPage();
    const bootUrl = `${SITE}/livescoreSeasonFixture?yearId=8&organisationKey=${ORG_KEY}&competitionUniqueKey=${BOOT_KEY}&divisionId=All`;
    let loadStatus = null;
    try { const r = await page.goto(bootUrl, { waitUntil: 'networkidle', timeout: 60000 }); loadStatus = r ? r.status() : null; } catch (e) { L.push(`**FAILED boot: ${md(String((e && e.message) || e))}**`); await finish(L); process.exit(1); }
    await page.waitForTimeout(6000);
    const tokenLen = await page.evaluate(() => (localStorage.getItem('token') || '').length);
    if (!tokenLen) { L.push(`**FAILED: no token (HTTP ${loadStatus})**`); await finish(L); process.exit(1); }
    L.push(`Boot OK (HTTP ${loadStatus}); token len ${tokenLen}. Targets: ${TARGETS.map((t) => t.id + '/' + (YEAR_NAME[t.year] || t.year)).join(', ')}.`);

    const listCache = {};
    async function compList(year) {
      if (!listCache[year]) { const { json } = await apiGet(page, `${LIVE}/competitions/list?organisationUniqueKey=${ORG_KEY}&yearRefId=${year}`); listCache[year] = Array.isArray(json) ? json : []; }
      return listCache[year];
    }

    const report = [];
    for (const t of TARGETS) {
      const list = await compList(t.year);
      const c = list.find((x) => String(x.id) === String(t.id));
      const key = c ? c.uniqueKey : '';
      const name = c ? (c.name || c.longName) : '(not found in list)';
      const entry = { id: t.id, year: t.year, key, name, status: c && c.statusRefId };

      const rmNum = await apiGet(page, `${LIVE}/round/matches?competitionId=${t.id}&divisionId=&teamIds=&ignoreStatuses=[1]`);
      await fs.writeFile(path.join(OUT, `rm-${t.id}-numeric.json`), rmNum.text || rmNum.err || '');
      entry.rmNumeric = rstat(rmNum.json) || { note: `HTTP ${rmNum.status} noRounds` };

      if (key) { const r = await apiGet(page, `${LIVE}/round/matches?competitionId=${key}&divisionId=&teamIds=&ignoreStatuses=[1]`); await fs.writeFile(path.join(OUT, `rm-${t.id}-bykey.json`), r.text || r.err || ''); entry.rmByKey = rstat(r.json) || { note: `HTTP ${r.status} noRounds` }; }

      if (key) { const r = await apiGet(page, `${LIVE}/teams/enduser/list?competitionId=${key}&organisationId=${ORG_KEY}`); entry.teams = Array.isArray(r.json) ? r.json.length : `HTTP ${r.status}`; }

      // DRAWS — correct field name competitionUniqueKey
      if (key) {
        entry.draws = [];
        entry.drawsMatches = 0;
        const orgId = c && c.organisationId;
        for (const uid of ['', '0']) {
          const r = await apiPost(page, `${COMPETITION}/api/draws?userId=${uid}`, { competitionUniqueKey: key, organisationId: orgId, yearRefId: Number(t.year), sourceSystem: 'User' });
          await fs.writeFile(path.join(OUT, `draws-${t.id}-uid${uid || 'blank'}.json`), (r.text || r.err || '').slice(0, 200000));
          let shape = r.err ? 'ERR' : `HTTP ${r.status}`;
          if (!r.err && r.json) {
            const j = r.json;
            if (j && j.errorCode !== undefined) shape += ` err:${j.message}`;
            else { const cm = countDrawMatches(j); shape += Array.isArray(j) ? ` array len ${j.length}` : ` keys:${Object.keys(j).slice(0, 6).join(',')}`; shape += ` matches~${cm.n}`; entry.drawsMatches = Math.max(entry.drawsMatches, cm.n); if (cm.ids.length) entry.drawsSampleIds = cm.ids; }
          }
          entry.draws.push(`uid"${uid}":${shape}`);
        }
      }

      // ladder per single division
      if (key) {
        const { json: dvs } = await apiGet(page, `${LIVE}/division?competitionKey=${key}`);
        entry.divisions = Array.isArray(dvs) ? dvs.length : 0;
        let ladderRows = 0, ladderOk = 0;
        for (const d of (Array.isArray(dvs) ? dvs.slice(0, 3) : [])) {
          const r = await apiGet(page, `${LIVE}/teams/ladder/v2?divisionIds=${d.id}&competitionKey=${key}&filteredOutCompStatuses=`);
          if (r.status === 200 && Array.isArray(r.json)) { ladderOk++; ladderRows += r.json.length; if (!entry.ladderSample && r.json[0]) { entry.ladderSample = Object.keys(r.json[0]).slice(0, 10).join(','); await fs.writeFile(path.join(OUT, `ladder-${t.id}.json`), JSON.stringify(r.json, null, 1).slice(0, 8000)); } }
          await page.waitForTimeout(120);
        }
        entry.ladder = `${ladderOk}/${Math.min(entry.divisions, 3)} divs ok, ${ladderRows} rows total`;
      }

      const rn = entry.rmNumeric, rk = entry.rmByKey;
      const best = (rn && rn.rounds) ? rn : ((rk && rk.rounds) ? rk : null);
      if (entry.drawsMatches > 0) entry.verdict = `DRAWS WORKS — full draw via draws endpoint (~${entry.drawsMatches} matches). Backfillable in full.`;
      else if (best && best.hidden === 0 && best.scored > 0) entry.verdict = 'OPEN — round/matches has all scores + periodScores.';
      else if (best && best.hidden > 0 && best.matches > 0) entry.verdict = 'PARTLY visible — some rounds readable; rest need id recovery.';
      else if (best && best.matches === 0 && best.rounds > 0) entry.verdict = 'HIDDEN, has round shells + visible-round anchors for id recovery.';
      else entry.verdict = 'FULLY HIDDEN — no rounds, no anchors; needs draws or ladder-only.';
      report.push(entry);
      await page.waitForTimeout(150);
    }
    await fs.writeFile(path.join(OUT, 'targets.json'), JSON.stringify(report, null, 1));

    L.push('');
    L.push('## Target 9U comps — backfill route');
    L.push('');
    L.push('| comp | year | name | rm(num) | rm(key) | teams | divs | draws | ladder | verdict |');
    L.push('|---|---|---|---|---|---|---|---|---|---|');
    for (const e of report) {
      const fmt = (r) => r ? (r.note ? r.note : `${r.rounds}r/${r.hidden}h/${r.matches}m/${r.scored}s`) : '-';
      L.push(`| ${e.id} | ${YEAR_NAME[e.year] || e.year} | ${md((e.name || '').slice(0, 26))} | ${fmt(e.rmNumeric)} | ${fmt(e.rmByKey)} | ${e.teams ?? '-'} | ${e.divisions ?? '-'} | ${md((e.draws || []).join(' '))} | ${md(e.ladder || '-')} | ${md(e.verdict)} |`);
    }
    L.push('');
    L.push('draws cell: `err:...` = rejected; `matches~N` = it RETURNED a draw with N matches (master key works). ladder gives team standings only (no per-quarter).');
  } finally {
    await browser.close();
  }
  await finish(L);
  process.exit(0);

  async function finish(lines) {
    const out = '# Netball Connect backfill — target 9U comps (current + 2 previous)\n\n' + lines.join('\n') + '\n';
    await fs.writeFile(path.join(OUT, 'SUMMARY.md'), out);
    if (SUMMARY_FILE) await fs.appendFile(SUMMARY_FILE, out);
    console.log(out);
  }
}

main().catch(async (e) => { console.error('UNEXPECTED ERROR:', (e && e.stack) || e); try { await fs.writeFile(path.join(OUT, 'crash.txt'), String((e && e.stack) || e)); } catch { /* */ } process.exit(3); });
