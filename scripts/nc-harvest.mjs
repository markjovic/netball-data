// nc-harvest.mjs (Playwright) — harvest 9U competition results incl per-quarter scores.
// Concurrent, two-phase, polite. All calls run inside a Chromium page (WAF gate); token from
// localStorage; no credentials. gameSummary needs a non-empty competitionUniqueKey but returns
// each match's real competition regardless, so we filter by competitionName.
//
// WHY A SCAN: a comp's matches sit in several id blocks (created per weekly batch), scattered
// across the national id space. round/matches only seeds the recent/visible rounds, so earlier
// rounds are found by a coarse scan over [SCAN_LO..SCAN_HI], then each hit is expanded to grab
// its whole block. Fetches run CONC at a time (with a small delay between batches) so a wide scan
// completes inside the job timeout without hammering the API.
//
// MULTI-COMP: set COMP_NAMES to a comma-separated list to collect several competitions from one
// scan pass (any whose matches fall in the scanned id range). One matches-<compId>.json per comp.
// COMP_ID/COMP_KEY/COMP_NAME remain the "primary": used for round/matches seeds + the gameSummary key.
//
// Phase 1: collect match ids (round/matches seeds + expand, + coarse scan). Phase 2: periodScores.
// Flushes each matches-<compId>.json periodically so a timeout never loses data.
//
// Env: COMP_ID, COMP_KEY, COMP_NAME, COMP_NAMES (optional comma list, defaults to COMP_NAME),
//   ORG_KEY, BOOT_KEY, SCAN_LO, SCAN_HI, COARSE_STEP (default 6), CONC (default 8),
//   BATCH_DELAY ms between batches (default 120), GAP (default 60), MAX_CALLS (default 60000), OUT_DIR.
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
const COMP_NAMES = (process.env.COMP_NAMES || COMP_NAME).split(',').map((s) => s.trim()).filter(Boolean);
const NAME_SET = new Set(COMP_NAMES);
const BOOT_KEY = (process.env.BOOT_KEY || COMP_KEY).trim();
const SCAN_LO = parseInt(process.env.SCAN_LO || '0', 10);
const SCAN_HI = parseInt(process.env.SCAN_HI || '0', 10);
const COARSE_STEP = parseInt(process.env.COARSE_STEP || '6', 10);
const CONC = parseInt(process.env.CONC || '8', 10);
const BATCH_DELAY = parseInt(process.env.BATCH_DELAY || '120', 10);
const GAP = parseInt(process.env.GAP || '60', 10);
const MAX_CALLS = parseInt(process.env.MAX_CALLS || '60000', 10);
const OUT = process.env.OUT_DIR || 'harvest-out';
const SUMMARY_FILE = process.env.GITHUB_STEP_SUMMARY || '';
// SURVEY mode: coarse-scan [SCAN_LO..SCAN_HI] with NO name filter, tally every competition seen
// (id range + date range) so finished/hidden comps can be located. No expand, no periodScores.
const SURVEY = /^(1|true|yes|on)$/i.test((process.env.SURVEY || '').trim());
// PROBE mode: diagnostic gameSummary scoping test. PROBE_IDS = comma match ids; KEYS = comma comp keys.
const PROBE_IDS = (process.env.PROBE_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
const KEYS = (process.env.KEYS || '').split(',').map((s) => s.trim()).filter(Boolean);
// RAW mode: dump raw bodies of arbitrary endpoints (;;-separated) for structure inspection.
const RAW_URLS = (process.env.RAW_URLS || '').split(';;').map((s) => s.trim()).filter(Boolean);

let calls = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const slug = (s) => (s || 'unknown').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 60).toLowerCase();
const log = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
// schema confirm: keys + raw matchData of the first recorded hit (so we verify field names, not guess)
let schemaSample = null;
const firstVal = (o, keys) => { for (const k of keys) { const v = o && o[k]; if (v != null && v !== '' && typeof v !== 'object') return v; } return ''; };
const objVal = (o, keys, prop) => { for (const k of keys) { const v = o && o[k]; if (v && typeof v === 'object' && v[prop] != null) return v[prop]; } return ''; };

async function main() {
  await fs.mkdir(OUT, { recursive: true });
  const notes = [];
  log(`mode: ${SURVEY ? 'SURVEY (locate comps, no harvest)' : 'HARVEST'}`);
  log(`config: primary comp ${COMP_ID} "${COMP_NAME}"`);
  log(`collecting ${COMP_NAMES.length} comp name(s): ${COMP_NAMES.map((n) => `"${n}"`).join(', ')}`);
  log(`scan ${SCAN_LO}..${SCAN_HI} step ${COARSE_STEP} | conc ${CONC} delay ${BATCH_DELAY}ms gap ${GAP} maxCalls ${MAX_CALLS}`);
  const browser = await chromium.launch();
  const found = new Map();           // id -> record (carries compId, compName)
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
    log(`booted, token ok (HTTP ${loadStatus})`);

    const batchGet = async (urls) => {
      calls += urls.length;
      const res = await page.evaluate(async (list) => {
        const tok = localStorage.getItem('token') || '';
        return Promise.all(list.map(async (u) => {
          try { const r = await fetch(u.url, { headers: { accept: 'application/json', authorization: tok } }); return { id: u.id, status: r.status, body: await r.text() }; }
          catch (e) { return { id: u.id, status: 0, body: '' }; }
        }));
      }, urls);
      if (BATCH_DELAY > 0) await sleep(BATCH_DELAY);
      return res;
    };

    // RAW: diagnostic. Fetch each URL in RAW_URLS (;;-separated; relative paths resolve against the
    // squadi api host) and dump raw bodies to raw.json. For inspecting endpoint structure/fields.
    if (RAW_URLS.length) {
      log(`RAW dump of ${RAW_URLS.length} url(s)`);
      const out = [];
      for (const u of RAW_URLS) {
        const url = /^https?:\/\//i.test(u) ? u : `https://api-netball.squadi.com${u.startsWith('/') ? '' : '/'}${u}`;
        const r = (await batchGet([{ id: 0, url }]))[0];
        out.push({ url, status: r.status, length: (r.body || '').length, body: (r.body || '').slice(0, 80000) });
        log(`[${r.status}] len ${(r.body || '').length} — ${url}`);
      }
      await fs.writeFile(path.join(OUT, 'raw.json'), JSON.stringify(out, null, 1));
      await writeSummary(['# Raw endpoint dump', '', ...out.map((o) => `- [${o.status}] len ${o.length} — ${o.url}`)]);
      await browser.close();
      process.exit(0);
    }

    // PROBE: diagnostic. For each PROBE_IDS x each KEYS, fetch gameSummary and report status +
    // competitionName; also keyless periodScores length. Answers: is gameSummary scoped to the key?
    if (PROBE_IDS.length) {
      const keys = KEYS.length ? KEYS : [COMP_KEY];
      log(`PROBE ${PROBE_IDS.length} id(s) x ${keys.length} key(s)`);
      const rows = [];
      for (const id of PROBE_IDS) {
        for (const k of keys) {
          const r = (await batchGet([{ id, url: `${LIVE}/matches/public/gameSummary?matchId=${id}&competitionUniqueKey=${k}` }]))[0];
          let name = '', keysSeen = ''; try { const j = JSON.parse(r.body); const md = j && j.matchData; if (md) { name = md.competitionName || ''; keysSeen = Object.keys(md).join(' '); } } catch {}
          rows.push({ id, key: k.slice(0, 8), status: r.status, name, keysSeen });
        }
        const ps = (await batchGet([{ id, url: `${LIVE}/matches/periodScores?matchId=${id}` }]))[0];
        let plen = 'err'; try { const a = JSON.parse(ps.body); plen = Array.isArray(a) ? String(a.length) : 'non-array'; } catch {}
        rows.push({ id, key: '(periodScores, no key)', status: ps.status, name: `periods=${plen}`, keysSeen: '' });
      }
      await fs.writeFile(path.join(OUT, 'probe.json'), JSON.stringify(rows, null, 1));
      const lines = ['# Probe — gameSummary key scoping', '', `| matchId | key | status | competitionName / periods |`, `|---|---|---|---|`,
        ...rows.map((r) => `| ${r.id} | ${r.key} | ${r.status} | ${(r.name || '').replace(/\|/g, '/')} |`), '',
        `matchData keys (first non-empty): ${(rows.find((r) => r.keysSeen) || {}).keysSeen || '(none)'}`];
      await writeSummary(lines);
      await browser.close();
      process.exit(0);
    }

    // SURVEY: locate every competition in a range (no name filter, no expand, no periodScores)
    if (SURVEY) {
      if (!(SCAN_LO && SCAN_HI && SCAN_HI > SCAN_LO)) return fail(browser, 'SURVEY needs SCAN_LO and SCAN_HI');
      const comps = new Map(); // competitionName -> {name, compId, count, idLo, idHi, dateLo, dateHi}
      const sample = [];
      for (let id = SCAN_LO; id <= SCAN_HI; id += COARSE_STEP) sample.push(id);
      log(`SURVEY ${SCAN_LO}..${SCAN_HI} step ${COARSE_STEP} — ${sample.length} sample ids`);
      const CHUNK = 600;
      for (let i = 0; i < sample.length && calls < MAX_CALLS; i += CHUNK) {
        const chunk = sample.slice(i, i + CHUNK).filter((id) => id > 0);
        const res = await batchGet(chunk.map((id) => ({ id, url: `${LIVE}/matches/public/gameSummary?matchId=${id}&competitionUniqueKey=${COMP_KEY}` })));
        for (const r of res) {
          if (r.status !== 200) continue;
          let j = null; try { j = JSON.parse(r.body); } catch { continue; }
          const md = j && j.matchData; if (!md || !md.competitionName) continue;
          const d = (md.startTime || '').slice(0, 10);
          let c = comps.get(md.competitionName);
          if (!c) { c = { name: md.competitionName, compId: md.competitionId != null ? String(md.competitionId) : '', count: 0, idLo: r.id, idHi: r.id, dateLo: d || '', dateHi: d || '' }; comps.set(md.competitionName, c); }
          c.count++; c.idLo = Math.min(c.idLo, r.id); c.idHi = Math.max(c.idHi, r.id);
          if (d) { if (!c.dateLo || d < c.dateLo) c.dateLo = d; if (!c.dateHi || d > c.dateHi) c.dateHi = d; }
        }
        const done = Math.min(i + CHUNK, sample.length);
        log(`survey ${done}/${sample.length} (${Math.round(done / sample.length * 100)}%) — ${comps.size} comps, ${calls} calls`);
      }
      const list = [...comps.values()].sort((a, b) => a.idLo - b.idLo);
      await fs.writeFile(path.join(OUT, 'survey.json'), JSON.stringify({ range: [SCAN_LO, SCAN_HI], step: COARSE_STEP, calls, comps: list }, null, 1));
      const lines = [`# Survey ${SCAN_LO}..${SCAN_HI} (step ${COARSE_STEP})`, '', `- ${list.length} competitions seen in ${calls} api calls${calls >= MAX_CALLS ? ' **(MAX_CALLS hit)**' : ''}`, '',
        `| idLo | idHi | hits | dates | competition |`, `|---|---|---|---|---|`,
        ...list.map((c) => `| ${c.idLo} | ${c.idHi} | ${c.count} | ${c.dateLo}..${c.dateHi} | ${c.name.replace(/\|/g, '/')} |`)];
      await writeSummary(lines);
      await browser.close();
      process.exit(0);
    }

    const recordIfComp = (id, body) => {
      let j = null; try { j = JSON.parse(body); } catch { return false; }
      const md = j && j.matchData; if (!md || !NAME_SET.has(md.competitionName)) return false;
      if (!schemaSample) schemaSample = { fromMatchId: id, matchDataKeys: Object.keys(md), teamDataKeys: Object.keys(j.teamData || {}), sampleMatchData: md };
      const td = j.teamData || {};
      // division (= grade/pool) and round — probe likely field names defensively; verify via _schema.json
      const divisionId = firstVal(md, ['divisionId', 'competitionDivisionId', 'divisionGradeId']) || objVal(md, ['division', 'competitionDivision', 'grade'], 'id');
      const division = firstVal(md, ['divisionName', 'competitionDivisionName', 'gradeName']) || objVal(md, ['division', 'competitionDivision', 'grade'], 'name') || (typeof md.division === 'string' ? md.division : '');
      const round = firstVal(md, ['roundName', 'roundNumber', 'round', 'matchRound']) || objVal(md, ['round'], 'name') || objVal(md, ['round'], 'roundNumber');
      found.set(id, { id, compId: md.competitionId != null ? String(md.competitionId) : '', compName: md.competitionName,
        divisionId: divisionId !== '' ? String(divisionId) : '', division: division || '', round: round !== '' ? String(round) : '',
        startTime: md.startTime, status: md.matchStatus, venue: md.venueName, court: md.venueCourtName,
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

    // group found records by competition and write one file per comp. gameSummary has no
    // competitionId and the key scopes the scan to one comp, so fall back to COMP_ID (not a slug).
    const groups = () => {
      const g = new Map();
      for (const r of found.values()) { const key = r.compId || COMP_ID || slug(r.compName); if (!g.has(key)) g.set(key, []); g.get(key).push(r); }
      return g;
    };
    const flush = async (phase) => {
      for (const [key, arr] of groups()) {
        arr.sort((a, b) => a.id - b.id);
        await fs.writeFile(path.join(OUT, `matches-${key}.json`), JSON.stringify({ compId: key, compName: arr[0].compName, harvestedAt: new Date().toISOString(), count: arr.length, phase, matches: arr }, null, 1));
      }
    };

    // Phase 1a: seeds from round/matches (primary comp) + expand. Also harvest the division (grade)
    // map and per-round team->division from the visible rounds (fallback for grade/regrade analysis).
    const rm = (await batchGet([{ id: 0, url: `${LIVE}/round/matches?competitionId=${COMP_ID}&divisionId=&teamIds=&ignoreStatuses=[1]` }]))[0];
    const seedIds = [];
    const divisionsFromRounds = {}; // divisionId -> name
    const roundDivisionTeams = [];  // {round, divisionId, division, matchId, team1Id, team2Id}
    try {
      const j = JSON.parse(rm.body);
      if (j && Array.isArray(j.rounds)) for (const r of j.rounds) {
        const rName = r.name != null ? String(r.name) : (r.roundNumber != null ? String(r.roundNumber) : '');
        for (const m of (r.matches || [])) {
          if (typeof m.id === 'number') seedIds.push(m.id);
          const dId = firstVal(m, ['divisionId', 'competitionDivisionId']) || objVal(m, ['division'], 'id');
          const dName = firstVal(m, ['divisionName']) || objVal(m, ['division'], 'name') || (typeof m.division === 'string' ? m.division : '');
          if (dId !== '' && dName) divisionsFromRounds[String(dId)] = dName;
          roundDivisionTeams.push({ round: rName, divisionId: dId !== '' ? String(dId) : '', division: dName || '',
            matchId: m.id, team1Id: m.team1 && m.team1.id, team2Id: m.team2 && m.team2.id });
        }
      }
    } catch {}
    notes.push(`round/matches seeds: ${seedIds.length}; divisions in visible rounds: ${Object.keys(divisionsFromRounds).length}`);
    log(`phase 1a: ${seedIds.length} seed ids from round/matches`);
    if (seedIds.length) { await probeMany(seedIds); await expandAround(seedIds); await flush('ids'); log(`phase 1a done: ${found.size} matches so far`); }

    // Phase 1b: coarse scan
    if (SCAN_LO && SCAN_HI && SCAN_HI > SCAN_LO) {
      notes.push(`coarse scan ${SCAN_LO}..${SCAN_HI} step ${COARSE_STEP} conc ${CONC}`);
      const sample = [];
      for (let id = SCAN_LO; id <= SCAN_HI; id += COARSE_STEP) sample.push(id);
      log(`phase 1b: coarse scan — ${sample.length} sample ids to check`);
      const CHUNK = 600;
      for (let i = 0; i < sample.length && !capped; i += CHUNK) {
        const hits = await probeMany(sample.slice(i, i + CHUNK));
        if (hits.length) await expandAround(hits);
        await flush('ids');
        const done = Math.min(i + CHUNK, sample.length);
        log(`scan ${done}/${sample.length} (${Math.round(done / sample.length * 100)}%) — found ${found.size} matches, ${calls} api calls`);
      }
    }
    if (capped) { notes.push(`**MAX_CALLS ${MAX_CALLS} hit** — narrow range / raise cap to resume`); log(`CAPPED at MAX_CALLS ${MAX_CALLS}`); }

    // Phase 2: periodScores for every collected id
    const ids = [...found.keys()];
    log(`phase 2: per-quarter scores for ${ids.length} matches`);
    for (let i = 0; i < ids.length && !capped; i += CONC) {
      if (calls >= MAX_CALLS) { capped = true; break; }
      const chunk = ids.slice(i, i + CONC);
      const res = await batchGet(chunk.map((id) => ({ id, url: `${LIVE}/matches/periodScores?matchId=${id}` })));
      for (const r of res) { if (r.status !== 200) continue; let ps = null; try { ps = JSON.parse(r.body); } catch {} if (Array.isArray(ps)) found.get(r.id).periods = ps.map((p) => ({ q: p.period, t1: p.team1Score, t2: p.team2Score })); }
      if ((i / CONC) % 25 === 0) log(`periods ${Math.min(i + CONC, ids.length)}/${ids.length}`);
    }

    for (const r of found.values()) if (!r.periods) r.periods = [];
    await flush('complete');

    // reference outputs: schema confirm + visible-round division map (grade / regrade analysis)
    if (schemaSample) await fs.writeFile(path.join(OUT, '_schema.json'), JSON.stringify(schemaSample, null, 1));
    await fs.writeFile(path.join(OUT, `_divisions-${COMP_ID}.json`), JSON.stringify({ compId: COMP_ID, divisionsFromRounds, roundDivisionTeams }, null, 1));

    // summary: per-comp breakdown
    const lines = [`# Harvest — ${COMP_NAMES.length} competition(s)`, '', `- total matches ${found.size}; api calls ${calls}${capped ? ' **(CAPPED)**' : ''}`, ''];
    for (const [key, arr] of groups()) {
      arr.sort((a, b) => a.id - b.id);
      const scored = arr.filter((m) => (m.t1 || 0) || (m.t2 || 0));
      const withQ = arr.filter((m) => m.periods.length);
      const withDiv = arr.filter((m) => m.division);
      const dates = [...new Set(arr.map((m) => (m.startTime || '').slice(0, 10)).filter(Boolean))].sort();
      const divs = [...new Set(arr.map((m) => m.division).filter(Boolean))].sort();
      const blocks = [];
      for (const m of arr) { const last = blocks[blocks.length - 1]; if (last && m.id - last.hi <= GAP) last.hi = m.id; else blocks.push({ lo: m.id, hi: m.id }); }
      lines.push(`## ${arr[0].compName} (matches-${key}.json)`,
        `- matches ${arr.length} (scored ${scored.length}, byes/0-0 ${arr.length - scored.length}); per-quarter ${withQ.length}; with division/grade ${withDiv.length}`,
        `- divisions/grades seen (${divs.length}): ${divs.join(' | ') || '—'}`,
        `- game dates (${dates.length}): ${dates.join(', ') || '—'}`,
        `- id blocks ${blocks.length}: ${blocks.map((b) => b.lo === b.hi ? `${b.lo}` : `${b.lo}-${b.hi}`).join(', ')}`, '');
    }
    lines.push(`- gameSummary matchData keys: ${schemaSample ? schemaSample.matchDataKeys.join(', ') : '(none recorded)'}`);
    lines.push(`- notes: ${notes.join('; ')}`);
    await writeSummary(lines);
  } finally {
    await browser.close();
  }
  process.exit(0);

  async function writeSummary(linesArr) { const o = linesArr.join('\n') + '\n'; await fs.writeFile(path.join(OUT, 'SUMMARY.md'), o); if (SUMMARY_FILE) await fs.appendFile(SUMMARY_FILE, o); console.log(o); }
}
async function fail(browser, msg) { const o = `# Harvest ${COMP_ID}\n\n**FAILED: ${msg}**\n`; await fs.writeFile(path.join(OUT, 'SUMMARY.md'), o); if (SUMMARY_FILE) await fs.appendFile(SUMMARY_FILE, o); console.log(o); await browser.close(); process.exit(1); }

main().catch(async (e) => { console.error('UNEXPECTED', (e && e.stack) || e); try { await fs.writeFile(path.join(OUT, 'crash.txt'), String((e && e.stack) || e)); } catch {} process.exit(3); });
