// Turns local files, URLs and React components into self-contained pages, and hands them to the
// relay. Shared by scripts/send.mjs (command line) and mcp/server.mjs (Claude desktop). No dependencies.
import { spawn } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';

export const RELAY = process.env.H2F_RELAY ?? 'http://localhost:7801';

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

async function replaceAsync(text, re, fn) {
  const parts = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    parts.push(text.slice(last, m.index), await fn(m));
    last = m.index + m[0].length;
  }
  return parts.join('') + text.slice(last);
}

// Inline, a script must not contain "</script" or "<!--": the HTML parser would end it early or
// switch into its escaped-comment mode. Both only occur inside strings, where the escape is inert.
const escapeScript = (code) => code.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');

// Embeds the files a local page refers to by relative path.
export async function inlineLocal(html, dir) {
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
    return `<script${m[1]}${m[3]}>\n${escapeScript(await readFile(path, 'utf8'))}\n</script>`;
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

// Replaces `/_blob/<id>` references (Claude Design uploads) with files saved by id in `dir`.
export async function inlineBlobs(text, dir) {
  const files = await readdir(dir).catch(() => []);
  const ids = new Set([...text.matchAll(/\/_blob\/([A-Za-z0-9_-]+)/g)].map((m) => m[1]));
  for (const id of ids) {
    const file = files.find((f) => f === id || f.startsWith(`${id}.`));
    if (file) text = text.split(`/_blob/${id}`).join(await dataUrl(resolve(dir, file)));
  }
  return text;
}

export async function pageFromFile(path, { blobs } = {}) {
  const full = resolve(path);
  let html = await inlineLocal(await readFile(full, 'utf8'), dirname(full));
  if (blobs) html = await inlineBlobs(html, resolve(blobs));
  return html;
}

export async function pageFromUrl(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (Macintosh) page-to-figma' } });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return { html: await res.text(), base: res.url };
}

// --- React components (Claude artifacts) -------------------------------------------------------

const REACT = 'https://esm.sh/react@18.3.1';
const REACT_DOM = 'https://esm.sh/react-dom@18.3.1';
const esm = (spec) => `https://esm.sh/${spec}${spec.includes('?') ? '&' : '?'}external=react,react-dom`;

// Wraps a React component (the default export of an artifact) in a page that renders it with Tailwind,
// the way Claude shows artifacts. Packages other than React load from esm.sh; the plugin waits for
// the root to fill before it reads the page.
export function reactPage(source, title = 'Component') {
  let code = source.replace(/^\s*['"]use client['"];?\s*$/m, '');
  // Bare package imports load from esm.sh; React itself goes through the import map so every
  // package shares one copy.
  code = code.replace(/(\bfrom\s*|\bimport\s*\(?\s*)(['"])([^'"./][^'"]*)\2/g, (m, lead, q, spec) =>
    /^(react|react-dom)(\/|$)/.test(spec) ? m : `${lead}${q}${esm(spec)}${q}`);
  let name = '__App';
  const fn = code.match(/export\s+default\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/);
  const cls = code.match(/export\s+default\s+class\s+([A-Za-z_$][\w$]*)/);
  const ref = code.match(/export\s+default\s+([A-Za-z_$][\w$]*)\s*;?\s*$/m);
  if (fn) {
    name = fn[1];
    code = code.replace(fn[0], fn[0].replace(/export\s+default\s+/, ''));
  } else if (cls) {
    name = cls[1];
    code = code.replace(cls[0], cls[0].replace(/export\s+default\s+/, ''));
  } else if (ref) {
    name = ref[1];
    code = code.replace(ref[0], '');
  } else if (/export\s+default\s+/.test(code)) {
    code = code.replace(/export\s+default\s+/, 'const __App = ');
  } else {
    const last = [...code.matchAll(/(?:function|const|class)\s+([A-Z][\w$]*)/g)].pop();
    if (!last) throw new Error('No React component found: expected a default export.');
    name = last[1];
  }
  const app = `${code}\nimport { createRoot as __createRoot } from 'react-dom/client';\nimport { jsx as __jsx } from 'react/jsx-runtime';\n__createRoot(document.getElementById('root')).render(__jsx(${name}, {}));\n`;
  const importMap = {
    imports: {
      react: REACT, 'react/': `${REACT}/`, 'react-dom': REACT_DOM, 'react-dom/': `${REACT_DOM}/`,
    },
  };
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<script src="https://cdn.tailwindcss.com/3.4.17"></script>
<script type="importmap">${JSON.stringify(importMap)}</script>
<script src="https://cdn.jsdelivr.net/npm/@babel/standalone@7.26.4/babel.min.js"></script>
</head><body><div id="root" data-h2f-wait></div>
<script type="text/plain" id="h2f-app">${escapeScript(app)}</script>
<script>
(function () {
  var root = document.getElementById('root');
  function fail(msg) { if (!root.childElementCount) root.textContent = 'Could not render this component: ' + msg; }
  window.addEventListener('error', function (e) { fail(e.message); });
  window.addEventListener('unhandledrejection', function (e) { fail(String(e.reason && e.reason.message || e.reason)); });
  try {
    var src = document.getElementById('h2f-app').textContent;
    var out = Babel.transform(src, { presets: [['react', { runtime: 'automatic' }], ['typescript', { isTSX: true, allExtensions: true }]], sourceType: 'module' }).code;
    var s = document.createElement('script');
    s.type = 'module';
    s.textContent = out;
    document.body.appendChild(s);
  } catch (e) { fail(e.message); }
})();
</script>
</body></html>`;
}

// --- Relay ------------------------------------------------------------------------------------

export async function relayHealth(relay = RELAY) {
  try {
    const res = await fetch(`${relay}/health`, { signal: AbortSignal.timeout(1500) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

// Starts the relay in the background if nothing answers. Returns its health, or null.
export async function ensureRelay(relayScript, relay = RELAY) {
  let health = await relayHealth(relay);
  if (health || !relayScript) return health;
  spawn(process.execPath, [relayScript], { detached: true, stdio: 'ignore' }).unref();
  for (let i = 0; i < 20 && !health; i++) {
    await new Promise((r) => setTimeout(r, 150));
    health = await relayHealth(relay);
  }
  return health;
}

// only: names of the pages or screens to import (all of them when empty).
// existing: what the plugin does when a frame with the same name is already there: 'ask', 'replace' or 'copy'.
export async function postCapture({ html, title, width = 1440, base = '', only = [], existing }, relay = RELAY) {
  const capture = { version: 1, kind: 'h2f-capture', live: true, url: base, title, width, height: 900, html };
  if (only.length) capture.only = only;
  if (existing) capture.existing = existing;
  const res = await fetch(`${relay}/captures`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-h2f-capture': '1' },
    body: JSON.stringify(capture),
  });
  if (!res.ok) throw new Error(`The relay refused the page: ${res.status} ${await res.text()}`);
  return res.json(); // { id, listeners }
}
