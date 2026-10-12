// Fast loop for extraction work: runs the walker directly on a fixture page and prints the tree.
//   node test/extract-page.mjs kitchen-sink.html [--autolayout] [--filter=text]
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import puppeteer from 'puppeteer-core';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const fixture = args.find((a) => !a.startsWith('--')) ?? 'kitchen-sink.html';
const filter = args.find((a) => a.startsWith('--filter='))?.split('=')[1];
const TYPES = { '.html': 'text/html', '.css': 'text/css', '.png': 'image/png' };
const bundle = await esbuild.build({ entryPoints: [join(root, 'test/extract-entry.ts')], bundle: true, write: false, format: 'iife' });
const server = http.createServer(async (req, res) => {
  try {
    const file = join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'access-control-allow-origin': '*' });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[page error]', e.message));
await page.setViewport({ width: 1440, height: 900 });
await page.goto(`http://127.0.0.1:${server.address().port}/test/fixtures/${fixture}`, { waitUntil: 'networkidle0' });
await page.addScriptTag({ content: bundle.outputFiles[0].text });
const result = await page.evaluate((al) => window.__h2f.run(al), args.includes('--autolayout'));
function show(n, depth) {
  const pad = '  '.repeat(depth);
  let extra = '';
  if (n.type === 'TEXT') extra = ` "${n.runs.map((r) => r.text).join('').slice(0, 60).replace(/\n/g, '\\n')}" single=${n.singleLine} align=${n.align}`;
  if (n.style) extra += ` fills=[${n.style.fills.map((f) => f.kind).join(',')}]`;
  if (n.layout) extra += ` layout=${n.layout.mode}${n.layout.wrap ? '+wrap' : ''} gap=${n.layout.gap} ${n.layout.primaryAlign}/${n.layout.counterAlign}`;
  if (n.childLayout) extra += ` child=${JSON.stringify(n.childLayout)}`;
  const line = `${pad}${n.type} ${n.name} @${n.x},${n.y} ${n.width}x${n.height}${extra}`;
  if (!filter || line.toLowerCase().includes(filter.toLowerCase())) console.log(line);
  (n.children ?? []).forEach((c) => show(c, depth + 1));
}
show(result.doc.root, 0);
await browser.close();
server.close();
