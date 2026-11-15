// nc-harvest.mjs  (Playwright) — harvest a 9U competition's full results incl per-quarter.
//
// Structure learned 2026-11-15: each DIVISION's whole season is one tight, near-consecutive
// block of match ids (gaps <=5), including hidden past rounds. A competition = a few such
// blocks. So we don't scan the whole id space — we get SEED ids and expand each block.
//
// Seeds come from:
//   1. round/matches (the current comp still lists upcoming matches — one+ per division), and
//   2. an optional COARSE scan over a bracket [SCAN_LO..SCAN_HI] step COARSE_STEP, for
//      FINISHED comps that return no rounds (no visible seeds).
// Each seed is expanded outward (walk +/- until GAP consecutive non-comp ids), collecting
// gameSummary + periodScores for every match whose competitionName matches. A global visited
// set means overlapping seeds don't re-probe. Division label is inherited from a seed's
// round/matches division when known.
//
// All calls run inside a Chromium page (WAF gate), token from localStorage, no credentials.
//
// Env:
//   COMP_ID (numeric), COMP_KEY (uuid), COMP_NAME (exact competitionName to match),
//   ORG_KEY (default ab63c5b3-…), BOOT_KEY (default 5232 key),
//   SCAN_LO, SCAN_HI, COARSE_STEP (default 12)  — optional coarse seed search for finished comps
//   GAP (default 80), MAX_CALLS (default 6000), DELAY_MS (default 30), OUT_DIR (default harvest-out)
// Exit 0 ran / 1 boot/token failed / 3 crash.

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
const COARSE_STEP = parseInt(process.env.COARSE_STEP || '12', 10);
const GAP = parseInt(process.env.GAP || '80', 10);
const MAX_CALLS = parseInt(process.env.MAX_CALLS || '6000', 10);
const DELAY_MS = parseInt(process.env.DELAY_MS || '30', 10);
const OUT = process.env.OUT_DIR || 'harvest-out';
const SUMMARY_FILE = process.env.GITHUB_STEP_SUMMARY || '';

let calls = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await fs.mkdir(OUT, { recursive: true });
  const notes = [];
  const browser = await chromium.launch();
  const matches = new Map();   // id -> record
  const visited = new Set();   // ids probed
  let capped = false;
  try {
    const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 } });
    const page = await ctx.newPage();
    let loadStatus = null;
    try { const r = await page.goto(`${SITE}/livescoreSeasonFixture?yearId=8&organisationKey=${ORG_KEY}&competitionUniqueKey=${BOOT_KEY}&divisionId=All`, { waitUntil: 'networkidle', timeout: 60000 }); loadStatus = r ? r.status() : null; } catch (e) { await fail(`boot load failed: ${e.message || e}`); }
    await page.waitForTimeout(6000);
    const tokenLen = await page.evaluate(() => (localStorage.getItem('token') || '').length);
    if (!tokenLen) await fail(`no token after boot (HTTP ${loadStatus})`);

    const api = async (url) => {
      const r = await page.evaluate(async (u) => { try { const res = await fetch(u, { headers: { accept: 'application/json', authorization: localStorage.getItem('token') || '' } }); return { s: res.status, b: await res.text() }; } catch (e) { return { err: String((e && e.message) || e) }; } }, url);
      if (r.err) return { status: null, json: null };
      let j = null; try { j = JSON.parse(r.b); } catch {}
      return { status: r.s, json: j };
    };

    // probe one id: if it's our comp, record it (+periods). returns true if matched.
    const probe = async (id, divHint) => {
      if (visited.has(id)) return matches.has(id);
      visited.add(id);
      if (calls >= MAX_CALLS) { capped = true; return false; }
      calls++;
      const gs = await api(`${LIVE}/matches/public/gameSummary?matchId=${id}&competitionUniqueKey=${COMP_KEY}`);
      const md = gs.json && gs.json.matchData;
      if (!md || md.competitionName !== COMP_NAME) return false;
      let periods = [];
      if (calls < MAX_CALLS) { calls++; const ps = await api(`${LIVE}/matches/periodScores?matchId=${id}`); if (Array.isArray(ps.json)) periods = ps.json.map((p) => ({ q: p.period, t1: p.team1Score, t2: p.team2Score })); }
      const td = gs.json.teamData || {};
      matches.set(id, { id, startTime: md.startTime, status: md.matchStatus, venue: md.venueName, court: md.venueCourtName,
        division: divHint || null,
        team1: td.team1 && td.team1.name, team1Id: td.team1 && td.team1.id, team2: td.team2 && td.team2.name, team2Id: td.team2 && td.team2.id,
        t1: md.team1Score, t2: md.team2Score, periods });
      return true;
    };

    // expand a block around a seed
    const expand = async (seed, divHint) => {
      await probe(seed, divHint);
      let miss = 0;
      for (let id = seed - 1; id > seed - MAX_CALLS; id--) { if (capped) break; const ok = await probe(id, divHint); miss = ok ? 0 : miss + 1; if (miss >= GAP) break; await sleep(DELAY_MS); }
      miss = 0;
      for (let id = seed + 1; id < seed + MAX_CALLS; id++) { if (capped) break; const ok = await probe(id, divHint); miss = ok ? 0 : miss + 1; if (miss >= GAP) break; await sleep(DELAY_MS); }
    };

    // 1. seeds from round/matches (division-tagged)
    const seeds = []; // {id, division}
    const rm = await api(`${LIVE}/round/matches?competitionId=${COMP_ID}&divisionId=&teamIds=&ignoreStatuses=[1]`);
    if (rm.json && Array.isArray(rm.json.rounds)) {
      for (const r of rm.json.rounds) { const dn = r.division && (r.division.name || r.division.divisionName); for (const m of (r.matches || [])) if (typeof m.id === 'number') seeds.push({ id: m.id, division: dn || null }); }
    }
    notes.push(`round/matches seeds: ${seeds.length}`);

    // expand each seed (dedup blocks via visited)
    for (const s of seeds) { if (capped) break; if (!visited.has(s.id)) await expand(s.id, s.division); }

    // 2. optional coarse scan for finished comps (no/not-enough seeds)
    if (SCAN_LO && SCAN_HI && SCAN_HI > SCAN_LO) {
      notes.push(`coarse scan ${SCAN_LO}..${SCAN_HI} step ${COARSE_STEP}`);
      for (let id = SCAN_LO; id <= SCAN_HI && !capped; id += COARSE_STEP) {
        if (visited.has(id)) continue;
        const hit = await probe(id, null);
        if (hit) await expand(id, null);   // found a block, harvest it fully
        await sleep(DELAY_MS);
      }
    }

    if (capped) notes.push(`**stopped at MAX_CALLS=${MAX_CALLS}** — resume with a higher cap or narrower range`);
    const out = [...matches.values()].sort((a, b) => a.id - b.id);
    await fs.writeFile(path.join(OUT, `matches-${COMP_ID}.json`), JSON.stringify({ compId: COMP_ID, compKey: COMP_KEY, compName: COMP_NAME, harvestedAt: new Date().toISOString(), count: out.length, matches: out }, null, 1));

    const scored = out.filter((m) => (m.t1 || 0) || (m.t2 || 0));
    const withQ = out.filter((m) => m.periods && m.periods.length);
    const blocks = [];
    for (const m of out) { const last = blocks[blocks.length - 1]; if (last && m.id - last.hi <= GAP) last.hi = m.id; else blocks.push({ lo: m.id, hi: m.id }); }
    await writeSummary([
      `# Harvest ${COMP_ID} — ${COMP_NAME}`, '',
      `- matches: ${out.length} (scored ${scored.length}, byes/0-0 ${out.length - scored.length})`,
      `- with per-quarter: ${withQ.length}`,
      `- api calls: ${calls}${capped ? ' (CAPPED)' : ''}`,
      `- id blocks (divisions): ${blocks.length} → ${blocks.map((b) => b.lo === b.hi ? b.lo : `${b.lo}-${b.hi}`).join(', ')}`,
      `- notes: ${notes.join('; ')}`,
    ]);
  } finally {
    await browser.close();
  }
  process.exit(0);

  async function writeSummary(lines) { const o = lines.join('\n') + '\n'; await fs.writeFile(path.join(OUT, 'SUMMARY.md'), o); if (SUMMARY_FILE) await fs.appendFile(SUMMARY_FILE, o); console.log(o); }
  async function fail(msg) { await writeSummary([`# Harvest ${COMP_ID}`, '', `**FAILED: ${msg}**`]); await browser.close(); process.exit(1); }
}

main().catch(async (e) => { console.error('UNEXPECTED', (e && e.stack) || e); try { await fs.writeFile(path.join(OUT, 'crash.txt'), String((e && e.stack) || e)); } catch {} process.exit(3); });
