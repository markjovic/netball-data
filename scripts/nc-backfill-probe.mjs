// nc-backfill-probe.mjs  (Playwright edition)
// Backfill feasibility map for the 9U competition across seasons.
//
// Hiding is a PER-COMPETITION setting (11U comp 5224 was fully open; 9U comp 5232 hides).
// So past-season 9U comps may be OPEN — in which case round/matches returns every match id
// and backfill is trivial (then periodScores per id). This probe finds every 9U competition
// under the org across years and reports, for each, whether it is hidden or open.
//
// All API calls run INSIDE the loaded site page (the API WAF blocks non-browser clients;
// in-page fetch carries the browser fingerprint + the app's localStorage token; no credentials).
//
// Env:
//   ORG_KEY   organisationKey uuid  (default ab63c5b3-fd1a-41a6-a1a2-326989b20247)
//   YEARS     comma yearRefIds      (default 8,7,6,5,4,3  = 2026..2021)
//   NAME_RE   comp-name filter      (default "9\\s*&?\\s*u")  case-insensitive
//   BOOT_KEY  a comp uniqueKey to open for the token (default the 9U 2026 Spring comp)
//   OUT_DIR   output dir            (default backfill-out)
//
// Exit 0 ran / 1 page or token failed / 3 crash.

import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

const SITE = 'https://registration.netballconnect.com';
const LIVE = 'https://api-netball.squadi.com/livescores';
const ORG_KEY = (process.env.ORG_KEY || 'ab63c5b3-fd1a-41a6-a1a2-326989b20247').trim();
const YEARS = (process.env.YEARS || '8,7,6,5,4,3').split(',').map((s) => s.trim()).filter(Boolean);
const NAME_RE = new RegExp(process.env.NAME_RE || '9\\s*&?\\s*u', 'i');
const BOOT_KEY = (process.env.BOOT_KEY || '8819433a-2375-4c6a-9039-4658036b083d').trim();
const OUT = process.env.OUT_DIR || 'backfill-out';
const SUMMARY_FILE = process.env.GITHUB_STEP_SUMMARY || '';
const YEAR_NAME = { '2': '2019', '1': '2020', '3': '2021', '4': '2022', '5': '2023', '6': '2024', '7': '2025', '8': '2026' };

function md(s) { return String(s).replace(/\|/g, '\\|').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

async function getJson(page, url) {
  const r = await page.evaluate(async (u) => {
    try { const res = await fetch(u, { headers: { accept: 'application/json', authorization: localStorage.getItem('token') || '' } }); const b = await res.text(); return { s: res.status, b }; } catch (e) { return { err: String((e && e.message) || e) }; }
  }, url);
  if (r.err) return { status: null, json: null, err: r.err, text: '' };
  let json = null; try { json = JSON.parse(r.b); } catch { /* non-json */ }
  return { status: r.s, json, text: r.b, err: '' };
}

function roundsStat(json) {
  if (!json || !Array.isArray(json.rounds)) return null;
  let hidden = 0, matches = 0, scored = 0;
  for (const r of json.rounds) { if (r.isHidden === true) hidden++; for (const m of (r.matches || [])) { matches++; if ((m.team1Score || 0) !== 0 || (m.team2Score || 0) !== 0) scored++; } }
  return { rounds: json.rounds.length, hidden, matches, scored };
}

async function main() {
  await fs.mkdir(OUT, { recursive: true });
  const lines = [];
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
    const page = await ctx.newPage();
    const bootUrl = `${SITE}/livescoreSeasonFixture?yearId=8&organisationKey=${ORG_KEY}&competitionUniqueKey=${BOOT_KEY}&divisionId=All`;
    let loadStatus = null;
    try { const r = await page.goto(bootUrl, { waitUntil: 'networkidle', timeout: 60000 }); loadStatus = r ? r.status() : null; } catch (e) {
      lines.push(`**FAILED: boot page load: ${md(String((e && e.message) || e))}**`); await finish(lines); process.exit(1);
    }
    await page.waitForTimeout(6000);
    const tokenLen = await page.evaluate(() => (localStorage.getItem('token') || '').length);
    if (!tokenLen) { lines.push(`**FAILED: no token after boot (HTTP ${loadStatus})**`); await finish(lines); process.exit(1); }
    lines.push(`Boot OK (HTTP ${loadStatus}); token len ${tokenLen}. Org ${ORG_KEY}. Filter /${NAME_RE.source}/i.`);
    lines.push('');

    // 1. find matching comps across years
    const comps = [];
    for (const y of YEARS) {
      const { json, status } = await getJson(page, `${LIVE}/competitions/list?organisationUniqueKey=${ORG_KEY}&yearRefId=${y}`);
      if (!Array.isArray(json)) { lines.push(`- year ${YEAR_NAME[y] || y}: competitions/list HTTP ${status}, not an array`); continue; }
      const hits = json.filter((c) => NAME_RE.test(c.name || c.longName || ''));
      lines.push(`- year ${YEAR_NAME[y] || y} (yearRefId ${y}): ${json.length} comps, ${hits.length} match the 9U filter`);
      for (const c of hits) comps.push({ id: c.id, key: c.uniqueKey, name: c.name || c.longName, year: y, status: c.statusRefId, org: c.organisationId });
    }
    await fs.writeFile(path.join(OUT, 'comps.json'), JSON.stringify(comps, null, 1));

    // 2. per comp: hidden vs open
    const rows = [];
    for (const c of comps) {
      const { json, status } = await getJson(page, `${LIVE}/round/matches?competitionId=${c.id}&divisionId=&teamIds=&ignoreStatuses=[1]`);
      const rs = roundsStat(json);
      let verdict;
      if (!rs) verdict = `no rounds (HTTP ${status})`;
      else if (rs.hidden === 0 && rs.scored > 0) verdict = 'OPEN — fully backfillable (round/matches has all scores)';
      else if (rs.hidden === 0 && rs.matches > 0) verdict = 'OPEN but unplayed/no scores yet';
      else if (rs.hidden > 0 && rs.scored > 0) verdict = 'PARTLY OPEN — some rounds visible with scores';
      else verdict = 'HIDDEN — matches stripped; needs id recovery';
      rows.push({ ...c, ...(rs || {}), verdict });
      await page.waitForTimeout(150);
    }
    await fs.writeFile(path.join(OUT, 'seasons.json'), JSON.stringify(rows, null, 1));

    lines.push('');
    lines.push('## 9U competitions by season — backfill feasibility');
    lines.push('');
    lines.push('| year | comp id | name | rounds | hidden | visible matches | scored | verdict |');
    lines.push('|---|---|---|---|---|---|---|---|');
    for (const r of rows) lines.push(`| ${YEAR_NAME[r.year] || r.year} | ${r.id} | ${md((r.name || '').slice(0, 44))} | ${r.rounds ?? '-'} | ${r.hidden ?? '-'} | ${r.matches ?? '-'} | ${r.scored ?? '-'} | ${md(r.verdict)} |`);
    lines.push('');
    const open = rows.filter((r) => /^OPEN — full/.test(r.verdict));
    const hidden = rows.filter((r) => /^HIDDEN/.test(r.verdict));
    lines.push(`**Summary: ${open.length} season(s) fully OPEN (trivial backfill), ${hidden.length} HIDDEN (need id recovery), ${rows.length - open.length - hidden.length} partial/other.**`);

    // 3. bonus: is the public ladder available for a hidden comp? (team standings from hidden results)
    const hc = rows.find((r) => /^HIDDEN/.test(r.verdict));
    if (hc) {
      const { json, status } = await getJson(page, `${LIVE}/teams/ladder/v2?divisionIds=&competitionKey=${hc.key}&filteredOutCompStatuses=`);
      const n = Array.isArray(json) ? json.length : (json && typeof json === 'object' ? Object.keys(json).length : 0);
      await fs.writeFile(path.join(OUT, 'ladder-sample.json'), JSON.stringify(json, null, 1).slice(0, 4000));
      lines.push('');
      lines.push(`Ladder test on hidden comp ${hc.id} (${YEAR_NAME[hc.year] || hc.year}): HTTP ${status}, ${n} entries — ${n ? 'public ladder available (team standings derived from hidden results)' : 'no ladder data'}.`);
    }
  } finally {
    await browser.close();
  }
  await finish(lines);
  process.exit(0);

  async function finish(L) {
    const out = '# Netball Connect backfill feasibility (9U across seasons)\n\n' + L.join('\n') + '\n';
    await fs.writeFile(path.join(OUT, 'SUMMARY.md'), out);
    if (SUMMARY_FILE) await fs.appendFile(SUMMARY_FILE, out);
    console.log(out);
  }
}

main().catch(async (e) => {
  console.error('UNEXPECTED ERROR:', (e && e.stack) || e);
  try { await fs.writeFile(path.join(OUT, 'crash.txt'), String((e && e.stack) || e)); } catch { /* reported */ }
  process.exit(3);
});
