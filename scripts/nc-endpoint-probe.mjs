// nc-endpoint-probe.mjs  (Playwright edition)
// Tests the project's core question:
//   Can the HIDDEN rounds' matches and per-quarter scores be read from the API
//   after the public fixture page has hidden them?
//
// WHY PLAYWRIGHT, not Node fetch:
//   api-netball.squadi.com sits behind a WAF that fingerprints the client. Node's
//   fetch() gets a blanket nginx "403 Forbidden" (confirmed 2026-11-15, endpoint probe
//   run 1) while the SAME calls from real Chromium return 200. So every API call here
//   is issued from INSIDE the loaded site page (page.evaluate -> window.fetch), which
//   carries the browser's TLS/HTTP2 fingerprint, the correct Origin/Referer, and the
//   static token the app already placed in localStorage. This mirrors the site exactly.
//
// Env (defaults target the 9U NetSetGo comp 5232):
//   COMP_ID     numeric competition id              (default 5232)
//   COMP_KEY    competitionUniqueKey (uuid)         (default 8819433a-2375-4c6a-9039-4658036b083d)
//   ORG_KEY     organisationKey (uuid)              (default ab63c5b3-fd1a-41a6-a1a2-326989b20247)
//   YEAR_ID     year ref id                         (default 8)
//   TEAM_ID     a numeric team id in the comp       (default 228160)
//   MATCH_ID    known match id to test directly     (default: auto-discovered)
//   OUT_DIR     output folder                       (default endpoint-out)
//
// Exit codes (explicit, never a silent pass):
//   0  battery ran and a verdict was reached
//   1  fixture page unreachable, or no token in localStorage (app did not boot)
//   3  unexpected error

import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

const SITE = 'https://registration.netballconnect.com';
const LIVE = 'https://api-netball.squadi.com/livescores';
const API = 'https://api-netball.squadi.com';

const COMP_ID = (process.env.COMP_ID || '5232').trim();
const COMP_KEY = (process.env.COMP_KEY || '8819433a-2375-4c6a-9039-4658036b083d').trim();
const ORG_KEY = (process.env.ORG_KEY || 'ab63c5b3-fd1a-41a6-a1a2-326989b20247').trim();
const YEAR_ID = (process.env.YEAR_ID || '8').trim();
const TEAM_ID = (process.env.TEAM_ID || '228160').trim();
const MATCH_ID_IN = (process.env.MATCH_ID || '').trim();
const OUT = process.env.OUT_DIR || 'endpoint-out';
const SUMMARY_FILE = process.env.GITHUB_STEP_SUMMARY || '';

const FIXTURE_URL = `${SITE}/livescoreSeasonFixture?yearId=${YEAR_ID}&organisationKey=${ORG_KEY}&competitionUniqueKey=${COMP_KEY}&divisionId=All`;

const results = [];
let seq = 0;

function classify(status, ctype, bodyText, err) {
  if (err) return 'transient(err)';
  if (status === 401 || status === 403 || status === 429) return /html/i.test(ctype) || /^<|forbidden/i.test((bodyText || '').trim()) ? 'blocked(html/WAF)' : 'blocked(app)';
  if (status >= 500) return 'transient(5xx)';
  if (status >= 200 && status < 300) {
    const t = (bodyText || '').trim();
    if (t === '' || t === '[]' || t === '{}' || t === 'null') return 'empty';
    return /json/i.test(ctype) || /^[[{]/.test(t) ? 'ok' : 'ok(non-json)';
  }
  return `other(${status})`;
}

// Run one fetch INSIDE the page context and return a plain record.
async function hitInPage(page, label, url) {
  const id = String(++seq).padStart(2, '0');
  let res;
  try {
    res = await page.evaluate(async (u) => {
      try {
        // No credentials: the API sends access-control-allow-origin but NOT
        // access-control-allow-credentials, so credentials:'include' makes the browser
        // reject the response ("Failed to fetch"). The app calls without credentials.
        const r = await fetch(u, {
          headers: { accept: 'application/json', authorization: localStorage.getItem('token') || '' },
        });
        const body = await r.text();
        return { status: r.status, ctype: r.headers.get('content-type') || '', body };
      } catch (e) { return { err: String((e && e.message) || e) }; }
    }, url);
  } catch (e) {
    res = { err: 'page.evaluate failed: ' + String((e && e.message) || e) };
  }
  const bodyText = res.body || '';
  const cls = classify(res.status, res.ctype || '', bodyText, res.err);
  let json = null, parseErr = '';
  if (bodyText && /^[[{]/.test(bodyText.trim())) {
    try { json = JSON.parse(bodyText); } catch (e) { parseErr = String((e && e.message) || e); }
  }
  const ext = json ? 'json' : (res.err ? 'err' : 'txt');
  const file = `bodies/${id}-${label.replace(/[^a-z0-9]+/gi, '_')}.${ext}`;
  await fs.writeFile(path.join(OUT, file), res.err ? res.err : bodyText);
  const row = { id, label, url, status: res.status ?? null, class: cls, bytes: Buffer.byteLength(bodyText), ctype: res.ctype || '', parseErr, err: res.err || '', file };
  results.push({ row, json });
  return { row, json };
}

function roundsStat(json) {
  if (!json || !Array.isArray(json.rounds)) return null;
  let hiddenRounds = 0, matchesTotal = 0, matchesInHidden = 0, scoredTotal = 0, scoredInHidden = 0;
  const hiddenMatchIds = [];
  for (const r of json.rounds) {
    const hidden = r.isHidden === true;
    if (hidden) hiddenRounds++;
    for (const m of (r.matches || [])) {
      matchesTotal++;
      const scored = (m.team1Score || 0) !== 0 || (m.team2Score || 0) !== 0;
      if (scored) scoredTotal++;
      if (hidden) { matchesInHidden++; if (scored) scoredInHidden++; if (m.id !== undefined) hiddenMatchIds.push(m.id); }
    }
  }
  return { allRoundsHidden: json.allRoundsHidden, rounds: json.rounds.length, hiddenRounds, matchesTotal, matchesInHidden, scoredTotal, scoredInHidden, hiddenMatchIds };
}

function topKeys(j) {
  if (Array.isArray(j)) return j.length ? `[]-> ${Object.keys(j[0] || {}).slice(0, 16).join(',')}` : '[]';
  if (j && typeof j === 'object') return Object.keys(j).slice(0, 16).join(',');
  return String(j);
}
function periodShape(json) {
  if (json === null || json === undefined) return 'no json';
  const txt = JSON.stringify(json);
  const hasPeriod = /period|quarter|qtr|"q[1-4]"|scoreBreakdown|breakdown/i.test(txt);
  const n = Array.isArray(json) ? json.length : (json && typeof json === 'object' ? Object.keys(json).length : 0);
  return `${Array.isArray(json) ? 'array' : typeof json} len/keys=${n}; period/quarter words: ${hasPeriod ? 'YES' : 'no'}; keys: ${topKeys(json)}`;
}

function md(s) { return String(s).replace(/\|/g, '\\|').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

async function writeSummary(verdict, tokenLen) {
  const L = [];
  L.push('# Netball Connect endpoint probe (hidden rounds + per-quarter)');
  L.push('');
  L.push(`- Competition: id ${COMP_ID}, key ${COMP_KEY}`);
  L.push(`- API calls issued from inside the browser page (WAF-safe). Token len ${tokenLen}.`);
  L.push('');
  L.push('## Verdict');
  L.push('');
  for (const v of verdict) L.push(`- ${md(v)}`);
  L.push('');
  L.push('## round/matches variants (hidden-round recovery)');
  L.push('');
  L.push('| id | variant | status | class | rounds | hiddenRounds | matches | matchesInHidden | scored | scoredInHidden |');
  L.push('|---|---|---|---|---|---|---|---|---|---|');
  for (const { row } of results) {
    if (!row._rs) continue;
    const s = row._rs;
    L.push(`| ${row.id} | ${md(row.label)} | ${row.status} | ${row.class} | ${s.rounds} | ${s.hiddenRounds} | ${s.matchesTotal} | ${s.matchesInHidden} | ${s.scoredTotal} | ${s.scoredInHidden} |`);
  }
  L.push('');
  L.push('## all requests');
  L.push('');
  L.push('| id | label | status | class | bytes | note |');
  L.push('|---|---|---|---|---|---|');
  for (const { row } of results) {
    L.push(`| ${row.id} | ${md(row.label)} | ${row.status === null ? '-' : row.status} | ${row.class} | ${row.bytes} | ${md(row.err || row.parseErr || row._note || '')} |`);
  }
  // Inline the decisive bodies so the run summary is self-sufficient (no need to open the zip).
  const inline = results.filter(({ row }) => !row._rs); // _rs marks round/matches variants; inline only the match/score/period chain
  if (inline.length) {
    L.push('');
    L.push('## response bodies (match/score/period endpoints)');
    for (const { row, json } of inline) {
      const body = json !== null && json !== undefined ? JSON.stringify(json, null, 1) : '';
      const shown = body ? (body.length > 2000 ? body.slice(0, 2000) + '\n…(truncated; full body in artifact ' + row.file + ')' : body) : '(empty or non-JSON; see artifact ' + row.file + ')';
      L.push('');
      L.push(`### ${row.id} ${md(row.label)} — HTTP ${row.status === null ? 'ERR' : row.status} (${row.class})`);
      L.push('```json');
      L.push(shown);
      L.push('```');
    }
  }
  const out = L.join('\n') + '\n';
  await fs.writeFile(path.join(OUT, 'SUMMARY.md'), out);
  if (SUMMARY_FILE) await fs.appendFile(SUMMARY_FILE, out);
  console.log(out);
}

async function main() {
  await fs.mkdir(path.join(OUT, 'bodies'), { recursive: true });
  const verdict = [];
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
    const page = await ctx.newPage();
    let loadStatus = null;
    try {
      const r = await page.goto(FIXTURE_URL, { waitUntil: 'networkidle', timeout: 60000 });
      loadStatus = r ? r.status() : null;
    } catch (e) {
      verdict.push(`Fixture page failed to load: ${String((e && e.message) || e)}`);
      await writeSummary(verdict, 0);
      process.exit(1);
    }
    await page.waitForTimeout(6000);
    const tokenLen = await page.evaluate(() => (localStorage.getItem('token') || '').length);
    await page.screenshot({ path: path.join(OUT, 'fixture.png'), timeout: 15000 }).catch(() => {});
    if (!tokenLen) {
      verdict.push(`No token in localStorage after load (page HTTP ${loadStatus}). App did not boot; cannot issue authorized calls.`);
      await writeSummary(verdict, 0);
      process.exit(1);
    }
    verdict.push(`Fixture page loaded (HTTP ${loadStatus}); token present in localStorage (len ${tokenLen}).`);

    const rm = (qs) => `${LIVE}/round/matches?${qs}`;
    const variants = [
      ['baseline ignoreStatuses=[1]', rm(`competitionId=${COMP_ID}&divisionId=&teamIds=&ignoreStatuses=[1]`)],
      ['no ignoreStatuses', rm(`competitionId=${COMP_ID}&divisionId=&teamIds=`)],
      ['ignoreStatuses=[]', rm(`competitionId=${COMP_ID}&divisionId=&teamIds=&ignoreStatuses=[]`)],
      ['ignoreStatuses=[0]', rm(`competitionId=${COMP_ID}&divisionId=&teamIds=&ignoreStatuses=[0]`)],
      [`team ${TEAM_ID} ignoreStatuses=[1]`, rm(`competitionId=${COMP_ID}&divisionId=&teamIds=[${TEAM_ID}]&ignoreStatuses=[1]`)],
      [`team ${TEAM_ID} no ignoreStatuses`, rm(`competitionId=${COMP_ID}&divisionId=&teamIds=[${TEAM_ID}]`)],
    ];
    const discovered = new Set();
    let baselineOk = false, baselineHidden = 0;
    for (const [label, url] of variants) {
      const { row, json } = await hitInPage(page, label, url);
      const rs = roundsStat(json);
      if (rs) {
        row._rs = rs;
        rs.hiddenMatchIds.forEach((x) => discovered.add(x));
        if (label.startsWith('baseline')) { baselineOk = row.class.startsWith('ok') || row.class === 'empty'; baselineHidden = rs.matchesInHidden; }
      }
    }

    if (results.every((r) => r.row.class.startsWith('blocked'))) {
      verdict.push('Every API call was BLOCKED even from inside the browser - the WAF is refusing page-context calls too. Needs a different approach (see project doc).');
      await writeSummary(verdict, tokenLen);
      process.exit(0);
    }

    const best = results.filter((r) => r.row._rs).reduce((a, b) => (b.row._rs.matchesInHidden > (a ? a.row._rs.matchesInHidden : -1) ? b : a), null);
    const maxHidden = best ? best.row._rs.matchesInHidden : 0;
    if (maxHidden > 0) {
      verdict.push(`HIDDEN ROUNDS ARE READABLE: variant "${best.row.label}" returned ${maxHidden} matches inside hidden rounds (baseline returned ${baselineHidden}).`);
    } else if (baselineOk) {
      verdict.push(`Hidden rounds return NO matches in any of the ${variants.length} round/matches variants. The server strips matches from hidden rounds; dropping/altering ignoreStatuses does not help.`);
    }

    // Pick a match to test the score/period endpoints on. Priority:
    //   1. a discovered hidden match   (tests hide-bypass directly)
    //   2. the supplied MATCH_ID
    //   3. a PLAYED visible match (matchStatus ENDED, or a non-zero score) - so periodScores
    //      is tested on a game that actually happened, not an upcoming 0-0 fixture
    //   4. any visible match (last resort; shape only)
    let matchId = (discovered.size ? [...discovered][0] : '') || MATCH_ID_IN;
    let pick = discovered.size ? 'discovered-hidden' : (MATCH_ID_IN ? 'supplied' : '');
    if (!matchId) {
      let anyId = '', playedId = '';
      for (const { json } of results) {
        if (!json || !Array.isArray(json.rounds)) continue;
        for (const r of json.rounds) for (const m of (r.matches || [])) {
          if (m.id === undefined) continue;
          if (!anyId) anyId = m.id;
          const played = m.matchStatus === 'ENDED' || (m.team1Score || 0) !== 0 || (m.team2Score || 0) !== 0;
          if (played && !playedId) playedId = m.id;
        }
        if (playedId) break;
      }
      matchId = playedId || anyId;
      pick = playedId ? 'played-visible' : (anyId ? 'visible-upcoming(shape only)' : '');
    }
    const visibleOnly = pick === 'visible-upcoming(shape only)';
    if (matchId) {
      verdict.push(`Testing score/period endpoints on ${pick} match ${matchId}.`);
    } else {
      verdict.push('No match id available to test score/period endpoints.');
    }

    if (matchId) {
      const chain = [
        ['matches/id', `${LIVE}/matches/id/${matchId}`],
        ['periodScores (livescores)', `${LIVE}/matches/periodScores?matchId=${matchId}`],
        ['periodScores (no prefix)', `${API}/matches/periodScores?matchId=${matchId}`],
        ['gameSummary', `${LIVE}/matches/public/gameSummary?matchId=${matchId}&competitionUniqueKey=${COMP_KEY}`],
        ['matchEvents', `${LIVE}/matches/public/matchEvents?matchId=${matchId}`],
      ];
      for (const [label, url] of chain) {
        const { row, json } = await hitInPage(page, label, url);
        if (/period/i.test(label)) row._note = 'period shape: ' + periodShape(json);
        if (label === 'matches/id' && json) {
          const m = Array.isArray(json) ? json[0] : json;
          row._note = (m && m.team1Score !== undefined) ? `score t1=${m.team1Score} t2=${m.team2Score} status=${m.matchStatus} isHidden=${m.isHidden}` : 'no score field';
        }
      }
      const ps = results.find((r) => /period/i.test(r.row.label) && r.row.class.startsWith('ok'));
      if (ps) verdict.push(`${visibleOnly ? '(visible match) ' : ''}periodScores OK for match ${matchId}: ${periodShape(ps.json)}`);
      else verdict.push(`periodScores returned no usable data for match ${matchId} (see table).`);
    } else {
      verdict.push('No match id available at all; could not test score/period endpoints.');
    }

    await writeSummary(verdict, tokenLen);
  } finally {
    await browser.close();
  }
  process.exit(0);
}

main().catch(async (e) => {
  console.error('UNEXPECTED ERROR:', (e && e.stack) || e);
  try { await fs.writeFile(path.join(OUT, 'crash.txt'), String((e && e.stack) || e)); } catch { /* reported */ }
  process.exit(3);
});
