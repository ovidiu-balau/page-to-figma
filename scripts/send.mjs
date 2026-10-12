// Sends a page to the open Figma plugin through the local relay, without the browser.
//
//   node scripts/send.mjs <page.html | https://… | -> [--title "Name"] [--width 1440] [--base https://…] [--blobs dir]
//
// --blobs: a folder of uploaded assets saved by id (abc123.png); `/_blob/abc123` references in the page,
// as Claude Design artboards use them, are embedded from there.
//
// A local file is sent with the files next to it (stylesheets, scripts, images, fonts) embedded, so a
// saved artifact or a built page imports the same as in a browser. Scripts are kept and run in the
// plugin, so pages that render with JavaScript (React, Tailwind's CDN) still work.
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, resolve } from 'node:path';

const RELAY = process.env.H2F_RELAY ?? 'http://localhost:7801';
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
};
const title = flag('title');
const width = Number(flag('width') ?? 1440);
let base = flag('base') ?? '';
const blobs = flag('blobs');
const out = flag('out'); // write the page that would be sent, for testing
const target = args[0];
if (!target) {
  console.error('Usage: node scripts/send.mjs <page.html | https://… | -> [--title "Name"] [--width 1440] [--base https://…]');
  process.exit(2);
}

const TYPES = {
  '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.avif': 'image/avif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
};
const URL_IN_CSS = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;
const isRelative = (ref) => !!ref && !/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(ref.trim());

async function localFile(dir, ref) {
  const path = resolve(dir, decodeURIComponent(ref.split(/[?#]/)[0]));
  try {
    if ((await stat(path)).isFile()) return path;
  } catch {
    // not there: left as written
  }
  return null;
}

async function dataUrl(path) {
  const type = TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';
  return `data:${type};base64,${(await readFile(path)).toString('base64')}`;
}

async function inlineCss(css, dir) {
  let out = css;
  for (const m of [...css.matchAll(URL_IN_CSS)]) {
    if (!isRelative(m[2])) continue;
    const path = await localFile(dir, m[2]);
    if (path) out = out.split(m[0]).join(`url("${await dataUrl(path)}")`);
  }
  return out;
}

// Embeds the files a local page refers to by relative path.
async function inlineLocal(html, dir) {
  const replaceAsync = async (text, re, fn) => {
    const parts = [];
    let last = 0;
    for (const m of text.matchAll(re)) {
      parts.push(text.slice(last, m.index), await fn(m));
      last = m.index + m[0].length;
    }
    return parts.join('') + text.slice(last);
  };
  html = await replaceAsync(html, /<link\b[^>]*>/gi, async (m) => {
    const tag = m[0];
    const href = tag.match(/href\s*=\s*["']([^"']+)["']/i)?.[1];
    if (!/rel\s*=\s*["']?stylesheet/i.test(tag) || !isRelative(href)) return tag;
    const path = await localFile(dir, href);
    if (!path) return tag;
    const media = tag.match(/media\s*=\s*["']([^"']+)["']/i)?.[1];
    return `<style${media ? ` media="${media}"` : ''}>\n${await inlineCss(await readFile(path, 'utf8'), dirname(path))}\n</style>`;
  });
  html = await replaceAsync(html, /<script\b([^>]*)\bsrc\s*=\s*["']([^"']+)["']([^>]*)>\s*<\/script>/gi, async (m) => {
    if (!isRelative(m[2])) return m[0];
    const path = await localFile(dir, m[2]);
    if (!path) return m[0];
    // Inline, a script must not contain "</script" or "<!--": the HTML parser would end it early
    // or switch into its escaped-comment mode. Both only occur inside strings, where the escape is inert.
    const code = (await readFile(path, 'utf8')).replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');
    return `<script${m[1]}${m[3]}>\n${code}\n</script>`;
  });
  html = await replaceAsync(html, /\b(src|poster|href)\s*=\s*(["'])([^"']+)\2/gi, async (m) => {
    if (!isRelative(m[3]) || !/\.(png|jpe?g|gif|webp|avif|svg|ico)(?:[?#]|$)/i.test(m[3])) return m[0];
    const path = await localFile(dir, m[3]);
    return path ? `${m[1]}=${m[2]}${await dataUrl(path)}${m[2]}` : m[0];
  });
  html = await replaceAsync(html, /<style\b[^>]*>([\s\S]*?)<\/style>/gi, async (m) => m[0].replace(m[1], await inlineCss(m[1], dir)));
  html = await replaceAsync(html, /style\s*=\s*"([^"]*url\([^"]*)"/gi, async (m) => `style="${await inlineCss(m[1], dir)}"`);
  return html;
}

async function inlineBlobs(text, dir) {
  const files = await readdir(dir).catch(() => []);
  const ids = new Set([...text.matchAll(/\/_blob\/([A-Za-z0-9_-]+)/g)].map((m) => m[1]));
  for (const id of ids) {
    const file = files.find((f) => f === id || f.startsWith(`${id}.`));
    if (file) text = text.split(`/_blob/${id}`).join(await dataUrl(resolve(dir, file)));
  }
  return text;
}

let html;
let name = title;
if (/^https?:\/\//i.test(target)) {
  const res = await fetch(target, { headers: { 'user-agent': 'Mozilla/5.0 (Macintosh) page-to-figma' } });
  if (!res.ok) throw new Error(`${target} answered ${res.status}`);
  html = await res.text();
  base ||= res.url;
} else if (target === '-') {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  html = Buffer.concat(chunks).toString('utf8');
} else {
  const path = resolve(target);
  html = await inlineLocal(await readFile(path, 'utf8'), dirname(path));
  if (blobs) html = await inlineBlobs(html, resolve(blobs));
  name ||= basename(path).replace(/\.html?$/i, '');
}
name ||= html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim() || (base ? new URL(base).hostname : 'Page');

if (out) {
  await writeFile(out, html);
  console.log(`Wrote ${out}`);
  process.exit(0);
}
const capture = { version: 1, kind: 'h2f-capture', live: true, url: base, title: name, width, height: 900, html };
let res;
try {
  res = await fetch(`${RELAY}/captures`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-h2f-capture': '1' },
    body: JSON.stringify(capture),
  });
} catch {
  console.error(`The relay is not running at ${RELAY}. Start it with: npm run relay (or sh scripts/relay-install.sh)`);
  process.exit(1);
}
if (!res.ok) {
  console.error(`The relay refused the page: ${res.status} ${await res.text()}`);
  process.exit(1);
}
const { listeners } = await res.json();
console.log(
  listeners
    ? `Sent "${name}" to Figma (${Math.round(html.length / 1024)} KB, ${width}px wide).`
    : `Queued "${name}". Open Page to Figma in Figma and it imports straight away.`,
);
