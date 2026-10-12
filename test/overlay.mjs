// Draws an extracted tree over the browser screenshot: frame outlines in magenta, text redrawn in
// the run styles. Misplaced layers show up as doubled or offset text.
//   node test/overlay.mjs news.ycombinator.com [crop-height]
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const name = process.argv[2];
const cropH = Number(process.argv[3] ?? 1200);
const data = JSON.parse(await readFile(join(root, `test/output/${name}.json`), 'utf8'));
const shot = (await readFile(join(root, `test/output/${name}.png`))).toString('base64');
const doc = data.docs[0];
const parts = [];
const css = (c) => (c ? `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},${c.a})` : 'red');
(function walk(n, ox, oy) {
  const x = ox + n.x;
  const y = oy + n.y;
  if (n.type === 'FRAME' || n.type === 'IMAGE' || n.type === 'SVG') {
    parts.push(`<div style="position:absolute;left:${x}px;top:${y}px;width:${n.width}px;height:${n.height}px;outline:1px solid rgba(255,0,255,.35);${n.rotation ? `transform:rotate(${-n.rotation}deg)` : ''}"></div>`);
  }
  if (n.type === 'TEXT') {
    const spans = n.runs.map((r) => `<span style="font-family:${r.fontFamily.replace(/"/g, "'")};font-weight:${r.fontWeight};font-style:${r.italic ? 'italic' : 'normal'};font-size:${r.fontSize}px;line-height:${r.lineHeight ? r.lineHeight + 'px' : 'normal'};letter-spacing:${r.letterSpacing}px;color:rgba(230,0,40,.85)">${r.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>')}</span>`).join('');
    parts.push(`<div style="position:absolute;left:${x}px;top:${y}px;${n.singleLine ? 'white-space:pre' : `width:${n.width}px;white-space:pre-wrap`};text-align:${n.align.toLowerCase()}">${spans}</div>`);
  }
  for (const c of n.children ?? []) walk(c, x, y);
})(doc.root, 0, 0);
const html = `<html><body style="margin:0"><div style="position:relative;width:${doc.root.width}px;height:${doc.root.height}px;background:url(data:image/png;base64,${shot}) no-repeat;"><div style="position:absolute;inset:0;background:rgba(255,255,255,.55)"></div>${parts.join('')}</div></body></html>`;
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const page = await browser.newPage();
await page.setViewport({ width: doc.root.width, height: Math.min(cropH, doc.root.height) });
await page.setContent(html, { waitUntil: 'networkidle0' });
await page.screenshot({ path: join(root, `test/output/compare/${name}-overlay.png`) });
await browser.close();
console.log(`test/output/compare/${name}-overlay.png`);
