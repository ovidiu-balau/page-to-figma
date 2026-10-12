// Runs the built plugin UI the way Figma hosts it (null/opaque origin iframe) against local
// fixture pages, with a stand-in for the main thread that records everything the UI sends.
//
//   node test/harness.mjs [fixture.html ...] [--autolayout] [--dark] [--width=1440]
//
// Writes test/output/<name>.json (document + images) and <name>.png (browser reference screenshot).
import http from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { extname, join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'test/output');
const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')).map((a) => a.split('=')[0]));
const width = Number(args.find((a) => a.startsWith('--width='))?.split('=')[1] ?? 1440);
const fixtures = args.filter((a) => !a.startsWith('--'));
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.json': 'application/json', '.svg': 'image/svg+xml' };

const HARNESS = `<!DOCTYPE html><html><body style="margin:0">
<iframe id="ui" style="width:600px;height:700px;border:0"></iframe>
<script>
const cap = { docs: {}, chunks: {}, images: {}, types: [], fontRequests: null, done: false, settings: null };
window.__cap = cap;
const ui = document.getElementById('ui');
const params = new URLSearchParams(location.search);
const settings = JSON.parse(params.get('settings') || 'null');
function reply(m) { ui.contentWindow.postMessage({ pluginMessage: m }, '*'); }
function b64(u8) { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); }
addEventListener('message', (e) => {
  if (e.source !== ui.contentWindow) return;
  const m = e.data && e.data.pluginMessage;
  if (!m) return;
  cap.types.push(m.type);
  if (m.type === 'ui-ready') reply({ type: 'settings', settings });
  else if (m.type === 'check-fonts') {
    cap.fontRequests = m.requests;
    const missing = (params.get('missing') || '').split(',').filter(Boolean);
    reply({ type: 'fonts', resolution: { families: Object.fromEntries(m.requests.map((r) => [r.family, 'Inter'])), missing, available: ['Inter', 'Roboto', 'SF Pro', 'Geist', 'Playfair Display', 'JetBrains Mono'] } });
  } else if (m.type === 'image') cap.images[m.id] = b64(m.bytes);
  else if (m.type === 'doc-chunk') (cap.chunks[m.docId] = cap.chunks[m.docId] || [])[m.index] = m.data;
  else if (m.type === 'import-doc') {
    cap.docs[m.docId] = JSON.parse(cap.chunks[m.docId].join(''));
    cap.settings = m.settings;
    reply({ type: 'doc-done', docId: m.docId, nodeCount: 0 });
  } else if (m.type === 'end-batch') {
    cap.done = true;
    reply({ type: 'batch-done', frames: Object.keys(cap.docs).length, cancelled: false });
  }
});
// Figma serves plugin UIs with a null origin; a data: URL gives the same opaque-origin conditions.
fetch('/dist/ui.html').then((r) => r.text()).then((t) => { ui.src = 'data:text/html;charset=utf-8,' + encodeURIComponent(t); });
</script></body></html>`;

function serve() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/__harness') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(HARNESS);
    }
    try {
      const file = join(root, decodeURIComponent(url.pathname));
      if (!file.startsWith(root)) throw new Error('outside');
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'access-control-allow-origin': '*' });
      res.end(body);
    } catch {
      res.writeHead(404, { 'access-control-allow-origin': '*' });
      res.end('not found');
    }
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

async function runFixture(browser, base, fixture) {
  const name = /^https?:/.test(fixture) ? new URL(fixture).hostname : fixture.replace(/\.html$/, '');
  const fixtureUrl = /^https?:/.test(fixture) ? fixture : `${base}/test/fixtures/${fixture}`;
  const isSnippet = fixture === 'tailwind.html';
  const settings = {
    tab: isSnippet ? 'code' : 'url', url: fixtureUrl, html: isSnippet ? await readFile(join(root, 'test/fixtures', fixture), 'utf8') : '', css: '',
    darkMode: flags.has('--dark'), autoLayout: flags.has('--autolayout'), includeImages: true, tailwind: true, disablePreflight: !isSnippet,
    tailwindConfig: '', rootFontSize: 16, proxyUrl: process.env.PROXY ?? '', viewport: String(width),
  };
  const page = await browser.newPage();
  page.on('console', (m) => { if (m.type() === 'error') console.log(`  [ui console] ${m.text()}`); });
  page.on('pageerror', (e) => console.log(`  [ui error] ${e.message}`));
  await page.setViewport({ width: 700, height: 760 });
  await page.goto(`${base}/__harness?settings=${encodeURIComponent(JSON.stringify(settings))}`);
  await page.waitForFunction(() => document.getElementById('ui').contentWindow && window.__cap.types.includes('ui-ready'));
  const ui = page.frames().find((f) => f !== page.mainFrame());
  await ui.waitForSelector('#import-btn');
  await new Promise((r) => setTimeout(r, 300));
  const started = Date.now();
  await ui.click('#import-btn');
  let lastStatus = '';
  let picked = false;
  for (;;) {
    const state = await page.evaluate(() => window.__cap.done);
    const status = await ui.$eval('#status', (s) => `${s.className}|${s.textContent}`);
    if (status !== lastStatus) {
      lastStatus = status;
      if (/error/.test(status)) throw new Error(`UI error: ${status}`);
    }
    if (!picked && (await ui.$eval('#panel-pages', (p) => p.classList.contains('active')).catch(() => false))) {
      picked = true;
      const names = await ui.$$eval('.page-name', (els) => els.map((e) => e.value));
      console.log(`  page picker: ${names.join(', ')}`);
      await new Promise((r) => setTimeout(r, 1500));
      await ui.click('#import-btn');
    }
    if (state) break;
    if (Date.now() - started > 90000) throw new Error(`timeout; last status ${status}`);
    await new Promise((r) => setTimeout(r, 200));
  }
  await ui.waitForFunction(() => /success|error/.test(document.getElementById('status').className), { timeout: 10000 }).catch(() => {});
  const cap = await page.evaluate(() => ({ docs: window.__cap.docs, images: window.__cap.images, fontRequests: window.__cap.fontRequests, types: window.__cap.types }));
  const finalStatus = await ui.$eval('#status', (s) => s.textContent);
  await page.close();

  const docs = Object.values(cap.docs);
  let nodes = 0;
  const count = (n) => { nodes++; (n.children ?? []).forEach(count); };
  docs.forEach((d) => count(d.root));
  await writeFile(join(out, `${name}.json`), JSON.stringify({ docs, images: cap.images, fontRequests: cap.fontRequests }, null, 1));

  if (isSnippet) {
    const ref = await browser.newPage();
    await ref.setViewport({ width, height: 900 });
    await ref.setContent(`<!DOCTYPE html><html><head><meta charset="utf-8"><style>html{font-size:16px}</style><script src="https://cdn.tailwindcss.com/3.4.17"></script></head><body>${settings.html}</body></html>`, { waitUntil: 'networkidle0' });
    await new Promise((r) => setTimeout(r, 800));
    await ref.screenshot({ path: join(out, `${name}.png`), fullPage: true });
    await ref.close();
  } else {
    const ref = await browser.newPage();
    await ref.setViewport({ width, height: 900 });
    if (flags.has('--dark')) await ref.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
    await ref.goto(fixtureUrl, { waitUntil: 'networkidle0' });
    await ref.screenshot({ path: join(out, `${name}.png`), fullPage: true });
    await ref.close();
  }
  console.log(`✓ ${fixture}: ${docs.length} doc(s), ${nodes} nodes, ${Object.keys(cap.images).length} images, ${cap.fontRequests?.length ?? 0} font styles, ${((Date.now() - started) / 1000).toFixed(1)}s. Status: "${finalStatus}"`);
}

await mkdir(out, { recursive: true });
const server = await serve();
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-first-run', '--no-default-browser-check'] });
let failed = 0;
try {
  for (const f of fixtures.length ? fixtures : ['kitchen-sink.html', 'prototype.html', 'tailwind.html']) {
    try {
      await runFixture(browser, base, f);
    } catch (err) {
      failed++;
      console.log(`✗ ${f}: ${err.message}`);
    }
  }
} finally {
  await browser.close();
  server.close();
}
process.exit(failed ? 1 : 0);
