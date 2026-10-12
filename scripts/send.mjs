// Sends a page to the open Figma plugin through the local relay, without the browser.
//
//   node scripts/send.mjs <page.html | component.jsx | https://… | -> [--title "Name"] [--width 1440]
//                         [--react] [--base https://…] [--blobs dir] [--out file]
//
// --react: the input is a React component (a Claude artifact); it is rendered with Tailwind. Files
// ending in .jsx or .tsx are treated this way automatically.
// --blobs: a folder of uploaded assets saved by id (abc123.png); `/_blob/abc123` references in the page,
// as Claude Design artboards use them, are embedded from there.
//
// A local file is sent with the files next to it (stylesheets, scripts, images, fonts) embedded, so a
// saved artifact or a built page imports the same as in a browser. Scripts are kept and run in the
// plugin, so pages that render with JavaScript (React, Tailwind's CDN) still work.
import { readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureRelay, pageFromFile, pageFromUrl, postCapture, reactPage, RELAY } from './lib/page.mjs';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
};
const bool = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args.splice(i, 1), true) : false;
};
const title = flag('title');
const width = Number(flag('width') ?? 1440);
let base = flag('base') ?? '';
const blobs = flag('blobs');
const out = flag('out'); // write the page that would be sent, for testing
const target = args.find((a) => !a.startsWith('--'));
const react = bool('react') || /\.[jt]sx$/i.test(target ?? '');
if (!target) {
  console.error('Usage: node scripts/send.mjs <page.html | component.jsx | https://… | -> [--title "Name"] [--width 1440] [--react]');
  process.exit(2);
}

let html;
let name = title;
if (/^https?:\/\//i.test(target)) {
  const page = await pageFromUrl(target);
  html = page.html;
  base ||= page.base;
} else if (target === '-') {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  html = Buffer.concat(chunks).toString('utf8');
} else if (react) {
  name ||= basename(target).replace(/\.[jt]sx?$/i, '');
} else {
  html = await pageFromFile(target, { blobs });
  name ||= basename(target).replace(/\.html?$/i, '');
}
if (react) html = reactPage(html ?? (await readFile(resolve(target), 'utf8')), name || 'Component');
name ||= html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim() || (base ? new URL(base).hostname : 'Page');

if (out) {
  await writeFile(out, html);
  console.log(`Wrote ${out}`);
  process.exit(0);
}
const relayScript = join(dirname(fileURLToPath(import.meta.url)), '..', 'relay', 'server.mjs');
if (!(await ensureRelay(relayScript))) {
  console.error(`The relay is not running at ${RELAY} and could not be started. Run: npm run relay`);
  process.exit(1);
}
let result;
try {
  result = await postCapture({ html, title: name, width, base });
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
console.log(
  result.listeners
    ? `Sent "${name}" to Figma (${Math.round(html.length / 1024)} KB, ${width}px wide).`
    : `Queued "${name}". Open Page to Figma in Figma and it imports straight away.`,
);
