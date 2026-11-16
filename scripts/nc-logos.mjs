// nc-logos.mjs — collect each team's logo + dominant colour from Netball Connect gameSummary.
// gameSummary.teamData.team{1,2} carries {id,name,logoUrl}. Logos live on public GCS (not WAF).
// Fetch gameSummary in-page (WAF gate); download logos with node fetch; sharp → 72px badge + dominant colour.
// Output logos-<compId>.json = { "<teamName>": { colour:"#rrggbb", badge:"data:image/png;base64,..." } }.
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const PLAN = JSON.parse(process.env.LOGO_PLAN || '{"5232": {"key": "8819433a-2375-4c6a-9039-4658036b083d", "ids": [2797789, 2797790, 2797791, 2797792, 2797793, 2797794, 2797795, 2797796, 2797797, 2797798, 2797799, 2797800, 2797804, 2797805, 2797806, 2797807, 2797808, 2797809, 2870115, 2870125, 2797829]}, "4596": {"key": "712ca7c5-83b6-4ad8-9bcc-7e06adaae2d9", "ids": [2558159, 2558160, 2558161, 2558163, 2558164, 2558165, 2558166, 2558167, 2558168, 2558169, 2558171, 2558172, 2565697, 2565698, 2655162]}, "4057": {"key": "fe64adda-ae9c-4bfe-b1a1-c62a498a77ab", "ids": [2404608, 2404609, 2404610, 2404611, 2404612, 2404613, 2404614, 2404615, 2404616, 2404617, 2404618, 2404619, 2404620, 2404622, 2404623, 2404624, 2404625, 2404632]}}');
const SITE = 'https://registration.netballconnect.com';
const LIVE = 'https://api-netball.squadi.com/livescores';
const ORG_KEY = (process.env.ORG_KEY || 'ab63c5b3-fd1a-41a6-a1a2-326989b20247').trim();
const OUT = process.env.OUT_DIR || 'logos-out';
const CONC = 8;
const SUMMARY_FILE = process.env.GITHUB_STEP_SUMMARY || '';
const log = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);

async function dominant(buf) {
  const { data, info } = await sharp(buf).ensureAlpha().resize(28, 28, { fit: 'inside' }).raw().toBuffer({ resolveWithObject: true });
  const ch = info.channels; const bins = {};
  for (let i = 0; i < data.length; i += ch) {
    const a = ch > 3 ? data[i + 3] : 255; if (a < 140) continue;
    const r = data[i], g = data[i + 1], b = data[i + 2];
    if (r > 236 && g > 236 && b > 236) continue; if (r < 16 && g < 16 && b < 16) continue;
    const k = (r >> 4) + ',' + (g >> 4) + ',' + (b >> 4);
    (bins[k] = bins[k] || [0, 0, 0, 0]); bins[k][0]++; bins[k][1] += r; bins[k][2] += g; bins[k][3] += b;
  }
  let best = null, bc = 0; for (const k in bins) if (bins[k][0] > bc) { bc = bins[k][0]; best = bins[k]; }
  if (!best) return '#888888';
  const n = best[0];
  return '#' + [best[1] / n, best[2] / n, best[3] / n].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
}

async function main() {
  await fs.mkdir(OUT, { recursive: true });
  const browser = await chromium.launch();
  try {
    const firstKey = Object.values(PLAN)[0].key;
    const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 } });
    const page = await ctx.newPage();
    const r = await page.goto(`${SITE}/livescoreSeasonFixture?yearId=8&organisationKey=${ORG_KEY}&competitionUniqueKey=${firstKey}&divisionId=All`, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(6000);
    const tok = await page.evaluate(() => (localStorage.getItem('token') || '').length);
    if (!tok) { console.log('no token'); await browser.close(); process.exit(1); }
    log(`booted (HTTP ${r && r.status()})`);
    const batchGet = async (urls) => page.evaluate(async (list) => {
      const t = localStorage.getItem('token') || '';
      return Promise.all(list.map(async (u) => { try { const x = await fetch(u, { headers: { accept: 'application/json', authorization: t } }); return { url: u, status: x.status, body: await x.text() }; } catch (e) { return { url: u, status: 0, body: '' }; } }));
    }, urls);

    const lines = ['# Team logos'];
    for (const [cid, p] of Object.entries(PLAN)) {
      const teamLogo = {};
      for (let i = 0; i < p.ids.length; i += CONC) {
        const chunk = p.ids.slice(i, i + CONC).map((id) => `${LIVE}/matches/public/gameSummary?matchId=${id}&competitionUniqueKey=${p.key}`);
        const res = await batchGet(chunk);
        for (const x of res) { if (x.status !== 200) continue; let j = null; try { j = JSON.parse(x.body); } catch { continue; } const td = j.teamData || {}; for (const t of [td.team1, td.team2]) if (t && t.name) teamLogo[t.name] = t.logoUrl || ''; }
      }
      // distinct urls → process once
      const cache = {}; const out = {};
      for (const [name, url] of Object.entries(teamLogo)) {
        if (!url) { out[name] = { colour: '#888888', badge: '' }; continue; }
        if (!(url in cache)) {
          try { const resp = await fetch(url); if (!resp.ok) throw new Error('http ' + resp.status);
            const buf = Buffer.from(await resp.arrayBuffer());
            const badge = 'data:image/png;base64,' + (await sharp(buf).resize(72, 72, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer()).toString('base64');
            cache[url] = { colour: await dominant(buf), badge };
          } catch (e) { cache[url] = { colour: '#888888', badge: '' }; }
        }
        out[name] = cache[url];
      }
      await fs.writeFile(path.join(OUT, `logos-${cid}.json`), JSON.stringify(out));
      const withBadge = Object.values(out).filter((x) => x.badge).length;
      lines.push(`- ${cid}: ${Object.keys(out).length} teams, ${withBadge} with a logo`);
      log(`${cid}: ${Object.keys(out).length} teams, ${withBadge} logos`);
    }
    const o = lines.join('\n') + '\n'; await fs.writeFile(path.join(OUT, 'SUMMARY.md'), o); if (SUMMARY_FILE) await fs.appendFile(SUMMARY_FILE, o); console.log(o);
  } finally { await browser.close(); }
  process.exit(0);
}
main().catch((e) => { console.error('ERR', (e && e.stack) || e); process.exit(3); });
