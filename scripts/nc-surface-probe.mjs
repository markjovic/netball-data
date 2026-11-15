// nc-surface-probe.mjs
// Step 1 probe for the netball project: load Netball Connect's public pages in a
// real Chromium and record every API call the pages make - host, path, method,
// status, request/response headers and response bodies.
//
// It answers four questions and nothing else:
//   1. which API host(s) the public site talks to
//   2. GraphQL or REST (by request shape)
//   3. how a session is established (cookies / auth headers seen, and on which call)
//   4. whether any response carries per-player data (key scan)
//
// Env:
//   FIXTURE_URL  required - a registration.netballconnect.com/livescoreSeasonFixture?... URL
//   MATCH_URL    optional - a matchSummary?... URL; if blank the first matchSummary link on
//                the fixture page is followed
//   OUT_DIR      output folder (default probe-out)
//
// Exit codes (explicit, never a silent pass):
//   0  fixture page and match page both probed, API calls captured
//   1  fixture page failed to load, or it made no API calls at all
//   2  fixture page probed, but no match page could be probed
//   3  unexpected error

import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

const FIXTURE_URL = (process.env.FIXTURE_URL || '').trim();
const MATCH_URL = (process.env.MATCH_URL || '').trim();
const OUT = process.env.OUT_DIR || 'probe-out';
const SUMMARY_FILE = process.env.GITHUB_STEP_SUMMARY || '';

// Hosts that are page furniture, not the vendor's data API.
const NOISE_HOST = /(google|gstatic|googletagmanager|doubleclick|facebook|hotjar|sentry|clarity|cloudflareinsights|fonts\.|newrelic|nr-data|segment|intercom|mapbox)/i;
// Header values we never write out in full.
const SECRET_HEADER = /^(cookie|set-cookie|authorization|x-auth.*|x-api-key|x-access-token|token)$/i;
// Keys that suggest per-player data.
const PLAYERISH = /(player|person|user|athlete|member|goal|attempt|shoot|shot|stat|position|minute|quarter|lineup|roster|participant)/i;

const calls = [];        // every xhr/fetch/json response
const failed = [];       // requestfailed events
const hosts = new Map(); // host -> {count, types:Set}
let seq = 0;
const pending = new Set(); // response handlers still running
const notes = [];          // non-fatal problems, always printed in the summary

function redact(name, value) {
  if (!SECRET_HEADER.test(name)) return value;
  const v = String(value);
  const scheme = /^(Bearer|Basic|JWT|Token)\s+/i.exec(v);
  const core = scheme ? v.slice(scheme[0].length) : v;
  const jwt = core.split('.').length === 3 && /^eyJ/.test(core);
  return `${scheme ? scheme[1] + ' ' : ''}<redacted len=${core.length}${jwt ? ' jwt' : ''}>`;
}

function redactHeaders(h) {
  const out = {};
  for (const [k, v] of Object.entries(h || {})) out[k] = redact(k, v);
  return out;
}

function classify(status, ctype, bodyText, bodyErr) {
  if (bodyErr) return 'transient';
  if (status === 401 || status === 403 || status === 429) {
    return /html/i.test(ctype) ? 'blocked(html-body,likely-WAF)' : 'blocked(app-level)';
  }
  if (status >= 500) return 'transient';
  if (status >= 200 && status < 300) {
    const t = (bodyText || '').trim();
    if (t === '' || t === '[]' || t === '{}' || t === 'null') return 'empty';
    if (/json/i.test(ctype) || /^[\[{]/.test(t)) return 'ok';
    return 'ok(non-json)';
  }
  if (status >= 300 && status < 400) return 'redirect';
  return `other(${status})`;
}

function keyPaths(obj, prefix = '', acc = new Set(), depth = 0) {
  if (depth > 8 || acc.size > 2000) return acc;
  if (Array.isArray(obj)) {
    for (const item of obj.slice(0, 5)) keyPaths(item, prefix + '[]', acc, depth + 1);
  } else if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) {
      const p = prefix ? `${prefix}.${k}` : k;
      acc.add(p);
      keyPaths(v, p, acc, depth + 1);
    }
  }
  return acc;
}

function isGraphQL(url, method, postData) {
  if (/graphql/i.test(url)) return true;
  if (method === 'POST' && postData && /"query"\s*:\s*"/.test(postData)) return true;
  return false;
}

async function attach(page, label) {
  page.on('request', (req) => {
    try {
      const u = new URL(req.url());
      const e = hosts.get(u.host) || { count: 0, types: new Set() };
      e.count += 1; e.types.add(req.resourceType());
      hosts.set(u.host, e);
    } catch { /* data: / blob: urls */ }
  });
  page.on('requestfailed', (req) => {
    failed.push({ page: label, url: req.url(), method: req.method(), type: req.resourceType(), error: req.failure()?.errorText || 'unknown' });
  });
  page.on('response', (resp) => {
    const job = handleResponse(resp, label);
    pending.add(job);
    job.catch((e) => { failed.push({ page: label, url: resp.url(), method: resp.request().method(), type: 'capture', error: 'capture handler: ' + String(e && e.message || e) }); })
      .finally(() => pending.delete(job));
  });
}

async function handleResponse(resp, label) {
  {
    const req = resp.request();
    const type = req.resourceType();
    const ctype = resp.headers()['content-type'] || '';
    if (!(type === 'xhr' || type === 'fetch' || /json/i.test(ctype))) return;
    let u;
    try { u = new URL(resp.url()); } catch { return; }
    if (NOISE_HOST.test(u.host)) return;
    const id = String(++seq).padStart(3, '0');
    let bodyText = '';
    let bodyErr = '';
    try { bodyText = await resp.text(); } catch (e) { bodyErr = String(e && e.message || e); }
    let reqHeaders = {};
    try { reqHeaders = await req.allHeaders(); } catch (e) { reqHeaders = { _error: String(e && e.message || e) }; }
    let respHeaders = {};
    try { respHeaders = await resp.allHeaders(); } catch (e) { respHeaders = { _error: String(e && e.message || e) }; }
    const postData = req.postData() || '';
    const status = resp.status();
    const cls = classify(status, ctype, bodyText, bodyErr);
    let keys = [];
    let parseErr = '';
    if (bodyText && /^[\[{]/.test(bodyText.trim())) {
      try { keys = [...keyPaths(JSON.parse(bodyText))]; } catch (e) { parseErr = String(e && e.message || e); }
    }
    const ext = /json/i.test(ctype) || keys.length ? 'json' : 'txt';
    const bodyFile = `bodies/${id}.${ext}`;
    await fs.writeFile(path.join(OUT, bodyFile), bodyText || '');
    calls.push({
      id, page: label, method: req.method(), url: resp.url(), host: u.host, path: u.pathname,
      query: Object.fromEntries(u.searchParams), type, status, contentType: ctype, class: cls,
      bytes: Buffer.byteLength(bodyText || ''), bodyFile, bodyErr, parseErr,
      graphql: isGraphQL(resp.url(), req.method(), postData),
      postData: postData.length > 20000 ? postData.slice(0, 20000) + '...<truncated>' : postData,
      requestHeaders: redactHeaders(reqHeaders), responseHeaders: redactHeaders(respHeaders),
      keys, playerKeys: keys.filter((k) => PLAYERISH.test(k.split('.').pop())),
    });
  }
}

async function drain() {
  while (pending.size) await Promise.allSettled([...pending]);
}

async function loadAndSettle(page, url, label) {
  const resp = await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
  const status = resp ? resp.status() : null;
  // SPAs often fire a second wave after first paint.
  await page.waitForTimeout(6000);
  await drain();
  const html = await page.content();
  await fs.writeFile(path.join(OUT, `${label}.html`), html);
  // Screenshot is evidence only. Viewport-only (a full-page shot of the fixture page,
  // ~185 images, timed out on run 1) and never fatal - but a failure is always reported.
  try {
    await page.screenshot({ path: path.join(OUT, `${label}.png`), timeout: 15000 });
  } catch (e) {
    notes.push(`${label} screenshot failed (non-fatal): ${String(e && e.message || e).split('\n')[0]}`);
  }
  return status;
}

// Fixture-page links are click handlers, not <a href> (run 1). Build a matchSummary URL
// from the captured round/matches body instead, preferring a finished match.
async function deriveMatchUrl() {
  const rm = calls.filter((c) => c.page === 'fixture' && c.path.endsWith('/livescores/round/matches') && c.class === 'ok');
  if (!rm.length) return { url: '', why: 'no ok /livescores/round/matches response to derive a match from' };
  let data;
  try { data = JSON.parse(await fs.readFile(path.join(OUT, rm[0].bodyFile), 'utf8')); } catch (e) { return { url: '', why: 'round/matches body did not parse: ' + String(e && e.message || e) }; }
  const matches = [];
  for (const r of (data && data.rounds) || []) for (const m of r.matches || []) matches.push(m);
  if (!matches.length) return { url: '', why: 'round/matches held 0 matches' };
  const ended = matches.filter((m) => m.matchStatus === 'ENDED' || m.matchEnded === true);
  const m = ended.length ? ended[ended.length - 1] : matches[0];
  const competitionId = (m.competition && m.competition.id) || m.competitionId;
  if (m.id === undefined || competitionId === undefined) return { url: '', why: `chosen match has no id or competition id (keys: ${Object.keys(m).join(',')})` };
  const fx = new URL(FIXTURE_URL);
  const u = new URL('/matchSummary', fx.origin);
  u.searchParams.set('matchId', String(m.id));
  u.searchParams.set('competitionId', String(competitionId));
  const key = fx.searchParams.get('competitionUniqueKey');
  if (key) u.searchParams.set('competitionUniqueKey', key);
  return { url: u.toString(), why: `derived from round/matches: match ${m.id}, status ${m.matchStatus}, ${ended.length} of ${matches.length} matches ended` };
}

// Which competitions publish stats? Read from the captured competitions/list body.
async function competitionFlags() {
  const cl = calls.find((c) => c.path.endsWith('/livescores/competitions/list') && c.class === 'ok');
  if (!cl) return ['- competitions/list: **not captured**'];
  let list;
  try { list = JSON.parse(await fs.readFile(path.join(OUT, cl.bodyFile), 'utf8')); } catch (e) { return ['- competitions/list: **body did not parse** ' + String(e && e.message || e)]; }
  if (!Array.isArray(list)) return ['- competitions/list: **not an array** - see ' + cl.bodyFile];
  const flags = ['isPublicStats', 'enhancedStatistics', 'positionTracking', 'recordGoalAttempts', 'lineupSelectionEnabled'];
  const out = [`- competitions in list: ${list.length}`];
  for (const f of flags) {
    const vals = {};
    for (const c of list) { const v = JSON.stringify(c[f]); vals[v] = (vals[v] || 0) + 1; }
    out.push(`- ${f}: ${Object.entries(vals).map(([v, n]) => `${v}=${n}`).join(', ')}`);
  }
  const key = new URL(FIXTURE_URL).searchParams.get('competitionUniqueKey');
  const mine = list.find((c) => Object.values(c).some((v) => v === key));
  if (mine) {
    out.push(`- this competition: id ${mine.id}, "${mine.longName || mine.name || ''}", ` + flags.map((f) => `${f}=${JSON.stringify(mine[f])}`).join(', '));
  } else {
    out.push('- this competition: **not found in list by competitionUniqueKey**');
  }
  return out;
}

function mdEscape(s) { return String(s).replace(/\|/g, '\\|').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

async function writeSummary(result) {
  const lines = [];
  lines.push(`# Netball Connect surface probe`);
  lines.push('');
  lines.push(`- Fixture page: ${result.fixtureStatus === null ? 'NO RESPONSE' : 'HTTP ' + result.fixtureStatus}`);
  lines.push(`- Match page: ${result.matchProbed ? 'HTTP ' + result.matchStatus + ' (' + result.matchUrlSource + ')' : '**NOT PROBED - ' + mdEscape(result.matchReason) + '**'}`);
  lines.push(`- API calls captured: ${calls.length} (fixture ${calls.filter((c) => c.page === 'fixture').length}, match ${calls.filter((c) => c.page === 'match').length})`);
  lines.push(`- GraphQL calls: ${calls.filter((c) => c.graphql).length}`);
  lines.push(`- Failed requests: ${failed.length}`);
  lines.push(`- Exit code: ${result.exitCode} (${mdEscape(result.exitReason)})`);
  for (const n of notes) lines.push(`- NOTE: ${mdEscape(n)}`);
  lines.push('');
  lines.push('## Competition flags (from competitions/list)');
  lines.push('');
  for (const l of await competitionFlags()) lines.push(l);
  lines.push('');
  lines.push('## All hosts contacted');
  lines.push('');
  lines.push('| host | requests | resource types |');
  lines.push('|---|---|---|');
  for (const [h, e] of [...hosts.entries()].sort((a, b) => b[1].count - a[1].count)) {
    lines.push(`| ${h} | ${e.count} | ${[...e.types].join(', ')} |`);
  }
  lines.push('');
  lines.push('## API calls');
  lines.push('');
  lines.push('| id | page | method | host | path | status | class | bytes | gql | auth/cookie headers sent | player-ish keys |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const c of calls) {
    const auth = Object.keys(c.requestHeaders).filter((k) => SECRET_HEADER.test(k)).map((k) => `${k}: ${c.requestHeaders[k]}`).join('; ') || '-';
    const pk = c.playerKeys.slice(0, 12).join(', ') + (c.playerKeys.length > 12 ? ` (+${c.playerKeys.length - 12})` : '');
    lines.push(`| ${c.id} | ${c.page} | ${c.method} | ${c.host} | ${mdEscape(c.path)} | ${c.status} | ${c.class} | ${c.bytes} | ${c.graphql ? 'Y' : ''} | ${mdEscape(auth)} | ${mdEscape(pk || '-')} |`);
  }
  if (failed.length) {
    lines.push('');
    lines.push('## Failed requests');
    lines.push('');
    for (const f of failed) lines.push(`- [${f.page}] ${f.method} ${mdEscape(f.url)} (${f.type}): ${mdEscape(f.error)}`);
  }
  const md = lines.join('\n') + '\n';
  await fs.writeFile(path.join(OUT, 'SUMMARY.md'), md);
  if (SUMMARY_FILE) await fs.appendFile(SUMMARY_FILE, md);
  console.log(md);
}

async function main() {
  if (!FIXTURE_URL) { console.error('FIXTURE_URL is empty.'); process.exit(1); }
  await fs.mkdir(path.join(OUT, 'bodies'), { recursive: true });

  const result = { fixtureStatus: null, matchProbed: false, matchStatus: null, matchUrlSource: '', matchReason: '', exitCode: 3, exitReason: 'unexpected' };
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });

    const fixturePage = await context.newPage();
    await attach(fixturePage, 'fixture');
    try {
      result.fixtureStatus = await loadAndSettle(fixturePage, FIXTURE_URL, 'fixture');
    } catch (e) {
      result.exitCode = 1; result.exitReason = 'fixture page failed to load: ' + String(e && e.message || e);
    }

    if (result.exitCode !== 1) {
      const apiCalls = calls.filter((c) => c.page === 'fixture');
      if (apiCalls.length === 0) {
        result.exitCode = 1; result.exitReason = 'fixture page loaded but made NO API calls - see fixture.html / fixture.png';
      }
    }

    if (result.exitCode !== 1) {
      let matchUrl = MATCH_URL;
      result.matchUrlSource = MATCH_URL ? 'MATCH_URL input' : '';
      if (!matchUrl) {
        const links = await fixturePage.$$eval('a[href*="matchSummary"]', (as) => as.map((a) => a.href));
        await fs.writeFile(path.join(OUT, 'matchSummary-links.txt'), links.join('\n'));
        if (links.length) { matchUrl = links[0]; result.matchUrlSource = `first of ${links.length} matchSummary links on fixture page`; }
      }
      let deriveWhy = '';
      if (!matchUrl) {
        const d = await deriveMatchUrl();
        if (d.url) { matchUrl = d.url; result.matchUrlSource = d.why; } else { deriveWhy = d.why; }
      }
      if (!matchUrl) {
        result.exitCode = 2;
        result.matchReason = 'no MATCH_URL given, no matchSummary link on the page, and could not derive one: ' + deriveWhy;
        result.exitReason = 'match page not probed';
      } else {
        const matchPage = await context.newPage();
        await attach(matchPage, 'match');
        try {
          result.matchStatus = await loadAndSettle(matchPage, matchUrl, 'match');
          result.matchProbed = true;
          await fs.writeFile(path.join(OUT, 'match-url.txt'), matchUrl);
          if (calls.filter((c) => c.page === 'match').length === 0) {
            result.exitCode = 2; result.exitReason = 'match page loaded but made NO API calls';
          } else {
            result.exitCode = 0; result.exitReason = 'fixture and match pages probed';
          }
        } catch (e) {
          result.exitCode = 2; result.matchReason = 'match page failed to load: ' + String(e && e.message || e);
          result.exitReason = 'match page not probed';
        }
      }
    }
  } finally {
    await drain();
    await browser.close();
  }

  await fs.writeFile(path.join(OUT, 'calls.json'), JSON.stringify(calls, null, 2));
  await fs.writeFile(path.join(OUT, 'failed.json'), JSON.stringify(failed, null, 2));
  await fs.writeFile(path.join(OUT, 'hosts.json'), JSON.stringify(Object.fromEntries([...hosts].map(([h, e]) => [h, { count: e.count, types: [...e.types] }])), null, 2));
  await writeSummary(result);
  process.exit(result.exitCode);
}

main().catch(async (e) => {
  console.error('UNEXPECTED ERROR:', e && e.stack || e);
  try { await fs.writeFile(path.join(OUT, 'calls.json'), JSON.stringify(calls, null, 2)); } catch { /* best effort, error already reported */ }
  process.exit(3);
});
