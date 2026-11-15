// nc-endpoint-probe.mjs
// Targeted probe for the netball project's core question:
//   Can the HIDDEN rounds' scores (incl. per-quarter) be read from the API after the
//   public fixture page has hidden them?
//
// Background established by nc-surface-probe (see project doc):
//   - API host: https://api-netball.squadi.com, base /livescores. REST/JSON, GET.
//   - Auth is a STATIC app key shipped in the site bundle as REACT_APP_DEFAULT_AUTH_TOKEN,
//     also copied to localStorage['token'] and sent as the `authorization` header. Public,
//     shared, same for every visitor. This probe extracts it from the public bundle at
//     run time (self-healing if it rotates) - it is NOT stored in the repo.
//   - The fixture page calls /livescores/round/matches with
//       ignoreStatuses = JSON.stringify([Hidden])   // Hidden === 1
//     and the server returns hidden rounds as shells with matches:[] (matches stripped).
//
// This probe asks the server for the hidden matches directly, then tries to pull their
// scores and per-quarter breakdown.
//
// Env (all optional; defaults target the 9U NetSetGo comp 5232):
//   COMP_ID    numeric competition id            (default 5232)
//   COMP_KEY   competitionUniqueKey (uuid)        (default 8819433a-2375-4c6a-9039-4658036b083d)
//   TEAM_ID    a numeric team id in the comp      (default 228160  "BLNC 9U Eucalyptus")
//   MATCH_ID   a known match id to test directly  (default: auto-discovered)
//   OUT_DIR    output folder                      (default endpoint-out)
//
// Exit codes (explicit, never a silent pass):
//   0  battery ran and a verdict was reached
//   1  token extraction failed, or the baseline round/matches call was unreachable
//   3  unexpected error

import fs from 'node:fs/promises';
import path from 'node:path';

const SITE = 'https://registration.netballconnect.com';
const API = 'https://api-netball.squadi.com';
const LIVE = `${API}/livescores`;

const COMP_ID = (process.env.COMP_ID || '5232').trim();
const COMP_KEY = (process.env.COMP_KEY || '8819433a-2375-4c6a-9039-4658036b083d').trim();
const TEAM_ID = (process.env.TEAM_ID || '228160').trim();
const MATCH_ID_IN = (process.env.MATCH_ID || '').trim();
const OUT = process.env.OUT_DIR || 'endpoint-out';
const SUMMARY_FILE = process.env.GITHUB_STEP_SUMMARY || '';

const results = [];   // one row per request
let seq = 0;

const HEADERS = (token) => ({
  accept: 'application/json',
  authorization: token,
  origin: SITE,
  referer: `${SITE}/`,
  'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
});

function classify(status, ctype, bodyText, netErr) {
  if (netErr) return 'transient(network)';
  if (status === 401 || status === 403 || status === 429) return /html/i.test(ctype) ? 'blocked(html/WAF)' : 'blocked(app)';
  if (status >= 500) return 'transient(5xx)';
  if (status >= 200 && status < 300) {
    const t = (bodyText || '').trim();
    if (t === '' || t === '[]' || t === '{}' || t === 'null') return 'empty';
    return /json/i.test(ctype) || /^[[{]/.test(t) ? 'ok' : 'ok(non-json)';
  }
  return `other(${status})`;
}

async function hit(label, url, token) {
  const id = String(++seq).padStart(2, '0');
  let status = null, ctype = '', bodyText = '', netErr = '';
  try {
    const r = await fetch(url, { headers: HEADERS(token), redirect: 'manual' });
    status = r.status;
    ctype = r.headers.get('content-type') || '';
    bodyText = await r.text();
  } catch (e) {
    netErr = String(e && e.message || e);
  }
  const cls = classify(status, ctype, bodyText, netErr);
  let json = null, parseErr = '';
  if (bodyText && /^[[{]/.test(bodyText.trim())) {
    try { json = JSON.parse(bodyText); } catch (e) { parseErr = String(e && e.message || e); }
  }
  const ext = json ? 'json' : (netErr ? 'err' : 'txt');
  const file = `bodies/${id}-${label.replace(/[^a-z0-9]+/gi, '_')}.${ext}`;
  await fs.writeFile(path.join(OUT, file), netErr ? netErr : (bodyText || ''));
  const row = { id, label, url, status, class: cls, bytes: Buffer.byteLength(bodyText || ''), ctype, parseErr, netErr, file };
  results.push({ row, json });
  return { row, json };
}

// Summarise a /round/matches body for the hidden-rounds question.
function roundsStat(json) {
  if (!json || !Array.isArray(json.rounds)) return null;
  const rounds = json.rounds;
  let hiddenRounds = 0, matchesTotal = 0, matchesInHidden = 0, scoredTotal = 0, scoredInHidden = 0;
  const hiddenMatchIds = [];
  for (const r of rounds) {
    const hidden = r.isHidden === true;
    if (hidden) hiddenRounds++;
    for (const m of (r.matches || [])) {
      matchesTotal++;
      const scored = (m.team1Score || 0) !== 0 || (m.team2Score || 0) !== 0;
      if (scored) scoredTotal++;
      if (hidden) {
        matchesInHidden++;
        if (scored) scoredInHidden++;
        if (m.id !== undefined) hiddenMatchIds.push(m.id);
      }
    }
  }
  return {
    allRoundsHidden: json.allRoundsHidden, rounds: rounds.length, hiddenRounds,
    matchesTotal, matchesInHidden, scoredTotal, scoredInHidden, hiddenMatchIds,
  };
}

// Does a periodScores body actually contain per-quarter numbers?
function periodShape(json) {
  if (json === null || json === undefined) return 'no json';
  const txt = JSON.stringify(json);
  const hasPeriodWords = /period|quarter|qtr|"q[1-4]"|scoreBreakdown/i.test(txt);
  let n = 0;
  if (Array.isArray(json)) n = json.length;
  else if (json && typeof json === 'object') n = Object.keys(json).length;
  return `${Array.isArray(json) ? 'array' : typeof json} len/keys=${n}; period/quarter words: ${hasPeriodWords ? 'YES' : 'no'}; sample keys: ${topKeys(json)}`;
}
function topKeys(j) {
  if (Array.isArray(j)) return j.length ? `[]-> ${Object.keys(j[0] || {}).slice(0, 14).join(',')}` : '[]';
  if (j && typeof j === 'object') return Object.keys(j).slice(0, 14).join(',');
  return String(j);
}

async function extractToken() {
  // Find the hashed main bundle from the site root, then read REACT_APP_DEFAULT_AUTH_TOKEN.
  const root = await fetch(SITE, { headers: { 'user-agent': HEADERS('x')['user-agent'] } });
  const html = await root.text();
  await fs.writeFile(path.join(OUT, 'site-root.html'), html);
  const bundles = [...html.matchAll(/\/static\/js\/(main\.[A-Za-z0-9]+\.js)/g)].map((m) => m[1]);
  const uniq = [...new Set(bundles)];
  if (!uniq.length) throw new Error('no /static/js/main.*.js reference found in site root HTML');
  for (const b of uniq) {
    const r = await fetch(`${SITE}/static/js/${b}`, { headers: { 'user-agent': HEADERS('x')['user-agent'] } });
    if (!r.ok) continue;
    const js = await r.text();
    const m = js.match(/REACT_APP_DEFAULT_AUTH_TOKEN:"([^"]+)"/);
    if (m) return { token: m[1], bundle: b };
  }
  throw new Error(`REACT_APP_DEFAULT_AUTH_TOKEN not found in: ${uniq.join(', ')}`);
}

function md(s) { return String(s).replace(/\|/g, '\\|').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

async function writeSummary(verdict, token) {
  const L = [];
  L.push('# Netball Connect endpoint probe (hidden rounds + per-quarter)');
  L.push('');
  L.push(`- Competition: id ${COMP_ID}, key ${COMP_KEY}`);
  L.push(`- Auth token: extracted from bundle, length ${token ? token.length : 0} (static public app key; not stored)`);
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
    L.push(`| ${row.id} | ${md(row.label)} | ${row.status === null ? '-' : row.status} | ${row.class} | ${row.bytes} | ${md(row.netErr || row.parseErr || row._note || '')} |`);
  }
  const out = L.join('\n') + '\n';
  await fs.writeFile(path.join(OUT, 'SUMMARY.md'), out);
  if (SUMMARY_FILE) await fs.appendFile(SUMMARY_FILE, out);
  console.log(out);
}

async function main() {
  await fs.mkdir(path.join(OUT, 'bodies'), { recursive: true });
  const verdict = [];

  let token;
  try {
    const t = await extractToken();
    token = t.token;
    verdict.push(`Token extracted from ${t.bundle} (len ${token.length}).`);
  } catch (e) {
    console.error('TOKEN EXTRACTION FAILED:', e && e.message || e);
    await fs.writeFile(path.join(OUT, 'SUMMARY.md'), `# endpoint probe\n\n**FAILED: token extraction: ${String(e && e.message || e)}**\n`);
    if (SUMMARY_FILE) await fs.appendFile(SUMMARY_FILE, `token extraction failed: ${String(e && e.message || e)}\n`);
    process.exit(1);
  }

  // Battery A - round/matches variants. Label says what differs.
  const rm = (qs) => `${LIVE}/round/matches?${qs}`;
  const variants = [
    ['baseline ignoreStatuses=[1]', rm(`competitionId=${COMP_ID}&divisionId=&teamIds=&ignoreStatuses=[1]`)],
    ['no ignoreStatuses', rm(`competitionId=${COMP_ID}&divisionId=&teamIds=`)],
    ['ignoreStatuses=[]', rm(`competitionId=${COMP_ID}&divisionId=&teamIds=&ignoreStatuses=[]`)],
    ['ignoreStatuses=[0]', rm(`competitionId=${COMP_ID}&divisionId=&teamIds=&ignoreStatuses=[0]`)],
    [`team ${TEAM_ID} ignoreStatuses=[1]`, rm(`competitionId=${COMP_ID}&divisionId=&teamIds=[${TEAM_ID}]&ignoreStatuses=[1]`)],
    [`team ${TEAM_ID} no ignoreStatuses`, rm(`competitionId=${COMP_ID}&divisionId=&teamIds=[${TEAM_ID}]`)],
  ];

  let baselineReached = false;
  const discovered = new Set();
  let baselineHiddenMatches = 0;
  for (const [label, url] of variants) {
    const { row, json } = await hit(label, url, token);
    const rs = roundsStat(json);
    if (rs) {
      row._rs = rs;
      for (const id of rs.hiddenMatchIds) discovered.add(id);
      if (label.startsWith('baseline')) { baselineReached = row.class.startsWith('ok') || row.class === 'empty'; baselineHiddenMatches = rs.matchesInHidden; }
    } else if (label.startsWith('baseline')) {
      baselineReached = row.class.startsWith('ok') || row.class === 'empty';
    }
  }

  if (!baselineReached && results[0] && results[0].row.netErr) {
    verdict.push(`Baseline round/matches UNREACHABLE: ${results[0].row.netErr}. Cannot conclude.`);
    results.forEach(({ row }) => { /* keep */ });
    await writeSummary(verdict, token);
    process.exit(1);
  }

  // Compare: does any variant surface matches inside hidden rounds that the baseline hid?
  const best = results.filter((r) => r.row._rs).reduce((a, b) => (b.row._rs.matchesInHidden > (a ? a.row._rs.matchesInHidden : -1) ? b : a), null);
  const maxHidden = best ? best.row._rs.matchesInHidden : 0;
  if (maxHidden > 0) {
    verdict.push(`HIDDEN ROUNDS ARE READABLE: variant "${best.row.label}" returned ${maxHidden} matches inside hidden rounds (baseline returned ${baselineHiddenMatches}).`);
  } else {
    verdict.push(`Hidden rounds return NO matches in any round/matches variant (baseline and ${variants.length - 1} alternatives). The server strips matches from hidden rounds; dropping ignoreStatuses does not help.`);
  }

  // Pick a match id to test the score/period endpoints directly.
  let matchId = MATCH_ID_IN || (discovered.size ? [...discovered][0] : '');
  if (!matchId) {
    // fall back to any visible match id from the baseline, to at least learn endpoint shapes
    for (const { json } of results) {
      if (json && Array.isArray(json.rounds)) {
        for (const r of json.rounds) for (const m of (r.matches || [])) if (m.id !== undefined) { matchId = m.id; break; }
        if (matchId) break;
      }
    }
    if (matchId) verdict.push(`No hidden match id found; testing score/period endpoints against a VISIBLE match (${matchId}) to learn their shape only.`);
  } else {
    verdict.push(`Testing score/period endpoints against ${MATCH_ID_IN ? 'supplied' : 'discovered-hidden'} match ${matchId}.`);
  }

  if (matchId) {
    const chain = [
      ['matches/id', `${LIVE}/matches/id/${matchId}`],
      ['periodScores (livescores)', `${LIVE}/matches/periodScores?matchId=${matchId}`],
      ['periodScores (no livescores prefix)', `${API}/matches/periodScores?matchId=${matchId}`],
      ['gameSummary', `${LIVE}/matches/public/gameSummary?matchId=${matchId}&competitionUniqueKey=${COMP_KEY}`],
      ['matchEvents', `${LIVE}/matches/public/matchEvents?matchId=${matchId}`],
    ];
    for (const [label, url] of chain) {
      const { row, json } = await hit(label, url, token);
      if (/period/i.test(label)) { row._note = 'period shape: ' + periodShape(json); }
      if (label === 'matches/id' && json) {
        const m = Array.isArray(json) ? json[0] : json;
        const sc = m && (m.team1Score !== undefined);
        row._note = sc ? `score t1=${m.team1Score} t2=${m.team2Score} status=${m.matchStatus} isHidden?=${m.isHidden}` : 'no score field';
      }
    }
    const ps = results.find((r) => /period/i.test(r.row.label) && r.row.class.startsWith('ok'));
    if (ps) verdict.push(`per-quarter endpoint periodScores returned OK for match ${matchId}: ${periodShape(ps.json)}`);
    else verdict.push(`periodScores did not return usable data for match ${matchId} (see table).`);
  } else {
    verdict.push('No match id available at all; could not test score/period endpoints.');
  }

  await writeSummary(verdict, token);
  process.exit(0);
}

main().catch(async (e) => {
  console.error('UNEXPECTED ERROR:', e && e.stack || e);
  try { await fs.writeFile(path.join(OUT, 'crash.txt'), String(e && e.stack || e)); } catch { /* reported */ }
  process.exit(3);
});
