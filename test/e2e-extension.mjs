// End to end: Chrome with the extension, the relay, and the plugin UI listening. A browser-button
// send of a fixture page must arrive in the plugin and be imported at the tab's width.
//   node test/e2e-extension.mjs [fixture.html] [tab-width]
import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { extname, join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = process.argv[2] ?? 'kitchen-sink.html';
const tabWidth = Number(process.argv[3] ?? 1280);
const harness = (await readFile(join(root, 'test/harness.mjs'), 'utf8')).match(/const HARNESS = `([\s\S]*?)`;\n/)[1];
const TYPES = { '.html': 'text/html', '.css': 'text/css', '.png': 'image/png' };
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/__harness') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(harness); }
  try { const f = join(root, decodeURIComponent(u.pathname)); const b = await readFile(f); res.writeHead(200, { 'content-type': TYPES[extname(f)] ?? 'application/octet-stream' }); res.end(b); } catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const relay = spawn(process.execPath, [join(root, 'relay/server.mjs')], { stdio: 'inherit' });
await new Promise((r) => setTimeout(r, 400));

const ext = join(root, 'extension');
// Branded Chrome ignores --load-extension, so the unpacked extension is installed over CDP.
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  pipe: true,
  enableExtensions: true,
});
try {
  const extId = await browser.installExtension(ext);
  console.log(`extension installed (${extId})`);
  const plugin = await browser.newPage();
  plugin.on('console', (m) => m.type() === 'error' && !/404|ERR_/.test(m.text()) && console.log('  [plugin]', m.text()));
  await plugin.setViewport({ width: 700, height: 760 });
  await plugin.goto(`${base}/__harness`);
  await plugin.waitForFunction(() => window.__cap.types.includes('ui-ready'));
  const ui = plugin.frames().find((f) => f !== plugin.mainFrame());
  await ui.waitForFunction(() => !document.getElementById('relay-chip').hidden, { timeout: 15000 });
  console.log('plugin connected to relay');

  const page = await browser.newPage();
  await page.setViewport({ width: tabWidth, height: 800 });
  const fixtureUrl = /^https?:/.test(fixture) ? fixture : `${base}/test/fixtures/${fixture}`;
  await page.goto(fixtureUrl, { waitUntil: 'networkidle2', timeout: 60000 });
  await new Promise((r) => setTimeout(r, 1500));
  // Something only the live page has: a typed form value.
  await page.evaluate(() => { const i = document.querySelector('input[type=text]'); if (i) i.value = 'typed@example.com'; });
  await page.bringToFront();

  const worker = await (await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().includes('background.js'))).worker();
  const started = Date.now();
  const outcome = await worker.evaluate(async (target) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((t) => t.url === target) ?? tabs.find((t) => t.url?.startsWith(new URL(target).origin));
    if (!tab) return { error: 'tab not found', urls: tabs.map((t) => t.url) };
    await globalThis.sendTab(tab);
    return { title: await chrome.action.getTitle({ tabId: tab.id }), badge: await chrome.action.getBadgeText({ tabId: tab.id }) };
  }, fixtureUrl);
  console.log('extension says:', JSON.stringify(outcome));
  console.log(`browser button pressed (${Date.now() - started} ms to capture and send)`);

  let last = '';
  for (let i = 0; i < 120; i++) {
    const status = await ui.$eval('#status', (el) => `${el.className}|${el.textContent}`);
    if (status !== last) console.log('  status:', (last = status));
    if (await plugin.evaluate(() => window.__cap.done)) break;
    if (/error/.test(status)) throw new Error(status);
    await new Promise((r) => setTimeout(r, 500));
  }
  await plugin.waitForFunction(() => window.__cap.done, { timeout: 1000 });
  const docs = await plugin.evaluate(() => Object.values(window.__cap.docs));
  const doc = docs[0];
  let nodes = 0;
  const texts = [];
  (function walk(n) { nodes++; if (n.type === 'TEXT') texts.push(n.runs.map((r) => r.text).join('')); (n.children ?? []).forEach(walk); })(doc.root);
  // Same shape as the harness output, so test/replay.mjs e2e can build it in Figma.
  const cap = await plugin.evaluate(() => ({ docs: Object.values(window.__cap.docs), images: window.__cap.images, fontRequests: window.__cap.fontRequests }));
  await writeFile(join(root, 'test/output/e2e.json'), JSON.stringify(cap));
  await page.screenshot({ path: join(root, 'test/output/e2e.png'), fullPage: true });
  console.log(`imported "${doc.name}" at ${doc.root.width}px wide, ${nodes} nodes, ${Date.now() - started} ms end to end`);
  console.log(`typed value carried over: ${texts.includes('typed@example.com')}`);
} finally {
  await browser.close();
  relay.kill();
  server.close();
}
