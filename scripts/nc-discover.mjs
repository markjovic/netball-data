// nc-discover.mjs (Playwright) — one-off: record what the public Netball Connect fixtures page loads,
// to find the endpoint that lists an organisation's competitions (with competitionUniqueKey) and the
// division names, so the weekly job can pick up new seasons by itself.
// Opens the fixtures page for ORG_KEY for each yearId in YEAR_IDS, records every JSON response from
// squadi/netballconnect hosts (url, status, first 300 KB of body) to discover.json, and the visible
// options of every <select>/dropdown on the page to dropdowns.json. Reads only public pages; no login.
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
const SITE = process.env.SITE || 'https://registration.netballconnect.com';
const ORG = (process.env.ORG_KEY || 'ab63c5b3-fd1a-41a6-a1a2-326989b20247').trim();
const YEARS = (process.env.YEAR_IDS || '8,9').split(',').map((s) => s.trim()).filter(Boolean);
const OUT = process.env.OUT_DIR || 'discover-out';
const log = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
await fs.mkdir(OUT, { recursive: true });
const browser = await chromium.launch();
const seen = []; const drops = [];
try {
  const ctx = await browser.newContext({ viewport: { width: 1300, height: 900 } });
  const page = await ctx.newPage();
  page.on('response', async (r) => {
    const u = r.url();
    if (!/squadi|netballconnect/i.test(u)) return;
    const ct = (r.headers()['content-type'] || '').toLowerCase();
    if (!ct.includes('json')) return;
    let body = ''; try { body = await r.text(); } catch {}
    seen.push({ url: u, method: r.request().method(), status: r.status(), postData: r.request().postData() || null, length: body.length, body: body.slice(0, 300000) });
  });
  for (const y of YEARS) {
    const url = `${SITE}/liveScoreSeasonFixture?yearId=${y}&organisationKey=${ORG}`;
    log(`open ${url}`);
    try { await page.goto(url, { waitUntil: 'networkidle', timeout: 90000 }); } catch (e) { log(`load: ${e.message}`); }
    await page.waitForTimeout(8000);
    const opts = await page.evaluate(() => [...document.querySelectorAll('select, [role="listbox"], [role="combobox"], .ant-select')].map((el) => ({ tag: el.tagName, cls: el.className && String(el.className).slice(0, 80), text: (el.innerText || '').slice(0, 2000) })));
    drops.push({ yearId: y, url, dropdowns: opts });
    // open each ant-design dropdown so its option list is rendered and fetched
    const sels = await page.$$('.ant-select-selector');
    for (let i = 0; i < sels.length; i++) {
      try { await sels[i].click(); await page.waitForTimeout(1500);
        const items = await page.evaluate(() => [...document.querySelectorAll('.ant-select-item-option, .ant-select-dropdown li')].map((e) => e.textContent.trim()).filter(Boolean));
        drops.push({ yearId: y, dropdown: i, options: items.slice(0, 300) });
        await page.keyboard.press('Escape'); await page.waitForTimeout(500);
      } catch (e) { log(`dropdown ${i}: ${e.message}`); }
    }
  }
} finally {
  await fs.writeFile(path.join(OUT, 'discover.json'), JSON.stringify(seen, null, 1));
  await fs.writeFile(path.join(OUT, 'dropdowns.json'), JSON.stringify(drops, null, 1));
  const lines = ['# Discover — fixtures page network calls', '', `${seen.length} JSON responses recorded`, '', '| status | method | length | url |', '|---|---|---|---|',
    ...seen.map((s) => `| ${s.status} | ${s.method} | ${s.length} | ${s.url.replace(/\|/g, '%7C').slice(0, 220)} |`)];
  await fs.writeFile(path.join(OUT, 'SUMMARY.md'), lines.join('\n') + '\n');
  if (process.env.GITHUB_STEP_SUMMARY) await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
  console.log(lines.join('\n'));
  await browser.close();
}
