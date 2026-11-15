// nc-harvest.mjs (Playwright) — harvest a 9U competition's full results incl per-quarter.
// Concurrent, two-phase. All calls run inside a Chromium page (WAF gate); token from
// localStorage; no credentials. gameSummary needs a non-empty competitionUniqueKey but
// returns each match's real competition regardless, so we filter by competitionName.
//
// WHY A SCAN: a comp's matches sit in several id blocks (created per weekly batch), scattered
// across the national id space. round/matches only seeds the recent/visible rounds, so earlier
// rounds are found by a coarse scan over [SCAN_LO..SCAN_HI], then each hit is expanded to grab
// its whole block. Fetches run CONC at a time so a wide scan completes inside the job timeout.
//
// Phase 1: collect match ids belonging to the comp (round/matches seeds + expand, + coarse scan).
// Phase 2: fetch periodScores for every collected id.
// Flushes matches-<id>.json periodically so a timeout never loses data.
//
// Env: COMP_ID, COMP_KEY, COMP_NAME, ORG_KEY, BOOT_KEY,
//   SCAN_LO, SCAN_HI, COARSE_STEP (default 6), CONC (default 10), GAP (default 60),
//   MAX_CALLS (default 60000), OUT_DIR.
// Exit 0 ran / 1 boot/token / 3 crash.

import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

const SITE = 'https://registration.netballconnect.com';
const LIVE = 'https://api-netball.squadi.com/livescores';
const ORG_KEY = (process.env.ORG_KEY || 'ab63c5b3-fd1a-41a6-a1a2-326989b20247').trim();
const COMP_ID = (process.env.COMP_ID || '5232').trim();
const COMP_KEY = (process.env.COMP_KEY || '8819433a-2375-4c6a-9039-4658036b083d').trim();
const COMP_NAME = (process.env.COMP_NAME || 'MENA - Club Competition SPRING FRI 9 & U NETSETGO').trim();
const BOOT_KEY = (process.env.BOOT_KEY || COMP_KEY).trim();
const SCAN_LO = parseInt(process.env.SCAN_LO || '0', 10);
const SCAN_HI = parseInt(process.env.SCAN_HI || '0', 10);
const COARSE_STEP = parseInt(process.env.COARSE_STEP || '6', 10);
const CONC = parseInt(process.env.CONC || '10', 10);
const GAP = parseInt(process.env.GAP || '60', 10);
const MAX_CALLS = parseInt(process.env.MAX_CALLS || '60000', 10);
const OUT = process.env.OUT_DIR || 'harvest-out';
const SUMMARY_FILE = process.env.GITHUB_STEP_SUMMARY || '';

let calls = 0;

async function main() {
  await fs.mkdir(OUT, { recursive: true });
  const notes = [];
  const browser = await chromium.launch();
  const found = new Map();
  const visited = new Set();
  let capped = false;
  try {
    const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 } });
    const page = await ctx.newPage();
    let loadStatus = null;
    try { const r = await page.goto(`${SITE}/livescoreSeasonFixture?yearId=8&organisationKey=${ORG_KEY}&competitionUniqueKey=${BOOT_KEY}&divisionId=All`, { waitUntil: 'networkidle', timeout: 60000 }); loadStatus = r ? r.status() : null; } catch (e) { return fail(browser, `boot load failed: ${e.message || e}`); }
    await page.waitForTimeout(6000);
    const tokenLen = await page.evaluate(() => (localStorage.getItem('token') || '').length);
    if (!tokenLen) return fail(browser, `no token after boot (HTTP ${loadStatus})`);

    const batchGet = async (urls) => {
      calls += urls.length;
      return page.evaluate(async (list) => {
        const tok = localStorage.getItem('token') || '';
        return Promise.all(list.map(async (u) => {
          try { const r = await fetch(u.url, { headers: { accept: 'application/json', authorization: tok } }); return { id: u.id, status: r.status, body: await r.text() }; }
          catch (e) { return { id: u.id, status: 0, body: '' }; }
        }));
      }, urls);
    };

    const recordIfComp = (id, body) => {
      let j = null; try { j = JSON.parse(body); } catch { return false; }
      const md = j && j.matchData; if (!md || md.competitionName !== COMP_NAME) return false;
      const td = j.teamData || {};
      found.set(id, { id, startTime: md.startTime, status: md.matchStatus, venue: md.venueName, court: md.venueCourtName,
        team1: td.team1 && td.team1.name, team1Id: td.team1 && td.team1.id, team2: td.team2 && td.team2.name, team2Id: td.team2 && td.team2.id,
        t1: md.team1Score, t2: md.team2Score });
      return true;
    };

    const probeMany = async (ids) => {
      const todo = ids.filter((id) => !visited.has(id) && id > 0);
      const hits = [];
      for (let i = 0; i < todo.length && !capped; i += CONC) {
        if (calls >= MAX_CALLS) { capped = true; break; }
        const chunk = todo.slice(i, i + CONC);
        chunk.forEach((id) => visited.add(id));
        const res = await batchGet(chunk.map((id) => ({ id, url: `${LIVE}/matches/public/gameSummary?matchId=${id}&competitionUniqueKey=${COMP_KEY}` })));
        for (const r of res) if (r.status === 200 && recordIfComp(r.id, r.body)) hits.push(r.id);
      }
      return hits;
    };

    // walk one direction from an id in CONC-sized batches; stop after GAP consecutive misses
    const expandDir = async (fromId, dir) => {
      let miss = 0, cur = fromId;
      while (miss < GAP && !capped) {
        const batch = [];
        for (let k = 1; k <= CONC; k++) { const id = cur + dir * k; if (id > 0) batch.push(id); }
        if (!batch.length) break;
        const before = found.size;
        await probeMany(batch);
        cur += dir * CONC;
        if (found.size > before) miss = 0; else miss += CONC;
      }
    };
    const expandAround = async (seedIds) => {
      for (const id of [...new Set(seedIds)]) { if (capped) break; await expandDir(id, -1); await expandDir(id, 1); }
    };

    const flush = async () => {
      const arr = [...found.values()].sort((a, b) => a.id - b.id);
      await fs.writeFile(path.join(OUT, `matches-${COMP_ID}.json`), JSON.stringify({ compId: COMP_ID, compKey: COMP_KEY, compName: COMP_NAME, harvestedAt: new Date().toISOString(), count: arr.length, phase: 'ids', matches: arr }, null, 1));
    };

    // Phase 1a: seeds from round/matches + expand
    const rm = (await batchGet([{ id: 0, url: `${LIVE}/round/matches?competitionId=${COMP_ID}&divisionId=&teamIds=&ignoreStatuses=[1]` }]))[0];
    const seedIds = [];
    try { const j = JSON.parse(rm.body); if (j && Array.isArray(j.rounds)) for (const r of j.rounds) for (const m of (r.matches || [])) if (typeof m.id === 'number') seedIds.push(m.id); } catch {}
    notes.push(`round/matches seeds: ${seedIds.length}`);
    if (seedIds.length) { await probeMany(seedIds); await expandAround(seedIds); await flush(); }

    // Phase 1b: coarse scan
    if (SCAN_LO && SCAN_HI && SCAN_HI > SCAN_LO) {
      notes.push(`coarse scan ${SCAN_LO}..${SCAN_HI} step ${COARSE_STEP} conc ${CONC}`);
      const sample = [];
      for (let id = SCAN_LO; id <= SCAN_HI; id += COARSE_STEP) sample.push(id);
      for (let i = 0; i < sample.length && !capped; i += 600) {
        const hits = await probeMany(sample.slice(i, i + 600));
        if (hits.length) await expandAround(hits);
        await flush();
      }
    }
    if (capped) notes.push(`**MAX_CALLS ${MAX_CALLS} hit** — narrow range / raise cap to resume`);

    // Phase 2: periodScores for all found ids
    const ids = [...found.keys()];
    for (let i = 0; i < ids.length && !capped; i += CONC) {
      if (calls >= MAX_CALLS) { capped = true; break; }
      const chunk = ids.slice(i, i + CONC);
      const res = await batchGet(chunk.map((id) => ({ id, url: `${LIVE}/matches/periodScores?matchId=${id}` })));
      for (const r of res) { if (r.status !== 200) continue; let ps = null; try { ps = JSON.parse(r.body); } catch {} if (Array.isArray(ps)) found.get(r.id).periods = ps.map((p) => ({ q: p.period, t1: p.team1Score, t2: p.team2Score })); }
    }

    const out = [...found.values()].sort((a, b) => a.id - b.id);
    out.forEach((m) => { if (!m.periods) m.periods = []; });
    await fs.writeFile(path.join(OUT, `matches-${COMP_ID}.json`), JSON.stringify({ compId: COMP_ID, compKey: COMP_KEY, compName: COMP_NAME, harvestedAt: new Date().toISOString(), count: out.length, phase: 'complete', matches: out }, null, 1));

    const scored = out.filter((m) => (m.t1 || 0) || (m.t2 || 0));
    const withQ = out.filter((m) => m.periods.length);
    const dates = [...new Set(out.map((m) => (m.startTime || '').slice(0, 10)).filter(Boolean))].sort();
    const blocks = [];
    for (const m of out) { const last = blocks[blocks.length - 1]; if (last && m.id - last.hi <= GAP) last.hi = m.id; else blocks.push({ lo: m.id, hi: m.id }); }
    await writeSummary([
      `# Harvest ${COMP_ID} — ${COMP_NAME}`, '',
      `- matches ${out.length} (scored ${scored.length}, byes/0-0 ${out.length - scored.length}); with per-quarter ${withQ.length}`,
      `- api calls ${calls}${capped ? ' (CAPPED)' : ''}`,
      `- game dates (${dates.length}): ${dates.join(', ')}`,
      `- id blocks ${blocks.length}: ${blocks.map((b) => b.lo === b.hi ? `${b.lo}` : `${b.lo}-${b.hi}`).join(', ')}`,
      `- notes: ${notes.join('; ')}`,
    ]);
  } finally {
    await browser.close();
  }
  process.exit(0);

  async function writeSummary(lines) { const o = lines.join('\n') + '\n'; await fs.writeFile(path.join(OUT, 'SUMMARY.md'), o); if (SUMMARY_FILE) await fs.appendFile(SUMMARY_FILE, o); console.log(o); }
}
async function fail(browser, msg) { const o = `# Harvest ${COMP_ID}\n\n**FAILED: ${msg}**\n`; await fs.writeFile(path.join(OUT, 'SUMMARY.md'), o); if (SUMMARY_FILE) await fs.appendFile(SUMMARY_FILE, o); console.log(o); await browser.close(); process.exit(1); }

main().catch(async (e) => { console.error('UNEXPECTED', (e && e.stack) || e); try { await fs.writeFile(path.join(OUT, 'crash.txt'), String((e && e.stack) || e)); } catch {} process.exit(3); });
