// Screenshots of the plugin UI in each state, hosted like Figma hosts it.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'test/output/ui');
await (await import('node:fs/promises')).mkdir(out, { recursive: true });
const harness = (await readFile(join(root, 'test/harness.mjs'), 'utf8')).match(/const HARNESS = `([\s\S]*?)`;\n/)[1];
const TYPES = { '.html': 'text/html', '.css': 'text/css', '.png': 'image/png' };
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/__harness') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(harness); }
  try { const f = join(root, decodeURIComponent(u.pathname)); const b = await readFile(f); res.writeHead(200, { 'content-type': TYPES[extname(f)] ?? 'application/octet-stream', 'access-control-allow-origin': '*' }); res.end(b); } catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const page = await browser.newPage();
await page.setViewport({ width: 600, height: 700, deviceScaleFactor: 2 });
const settings = { tab: 'url', url: `${base}/test/fixtures/prototype.html`, html: '', css: '', darkMode: false, autoLayout: false, includeImages: true, tailwind: true, disablePreflight: true, tailwindConfig: '', rootFontSize: 16, proxyUrl: '', viewport: 'source-default' };
await page.goto(`${base}/__harness?missing=Sohne,Founders Grotesk&settings=${encodeURIComponent(JSON.stringify(settings))}`);
await page.waitForFunction(() => window.__cap.types.includes('ui-ready'));
const ui = page.frames().find((f) => f !== page.mainFrame());
await new Promise((r) => setTimeout(r, 500));
const shot = async (n) => { await new Promise((r) => setTimeout(r, 350)); await page.screenshot({ path: join(out, `${n}.png`), clip: { x: 0, y: 0, width: 600, height: 700 } }); };
for (const tab of ['url', 'file', 'code', 'options']) { await ui.click(`#tab-${tab}`); await shot(tab); }
await ui.click('#tab-url');
await ui.click('#import-btn');
await ui.waitForFunction(() => document.getElementById('panel-pages').classList.contains('active'), { timeout: 30000 });
await new Promise((r) => setTimeout(r, 4000));
await shot('pages');
await ui.click('#import-btn');
await ui.waitForFunction(() => !document.getElementById('font-sheet').hidden, { timeout: 30000 });
await shot('fonts');
await ui.click('#font-apply');
await ui.waitForFunction(() => /success|error/.test(document.getElementById('status').className), { timeout: 30000 });
await shot('done');
await browser.close();
server.close();
console.log('ok');
