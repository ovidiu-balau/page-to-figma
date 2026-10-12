// One click: capture the tab, inline what the plugin cannot fetch on its own (cross-origin
// stylesheets, fonts and images, using this browser's access), and hand it to the local relay. If
// the relay is not running, the capture is downloaded so it can be dropped into Upload File.
import { captureDom } from './capture.js';

const RELAY = 'http://127.0.0.1:7801';
const LIMITS = { asset: 8 * 1024 * 1024, fonts: 20 * 1024 * 1024, images: 60 * 1024 * 1024 };
const URL_IN_CSS = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;

function badge(tabId, text, color, title) {
  chrome.action.setBadgeText({ tabId, text });
  if (color) chrome.action.setBadgeBackgroundColor({ tabId, color });
  if (title) chrome.action.setTitle({ tabId, title });
}

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let out = '';
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(out);
}

async function fetchAsDataUrl(url, budget) {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buffer = await res.arrayBuffer();
  if (buffer.byteLength > LIMITS.asset || buffer.byteLength > budget.left) throw new Error('over budget');
  budget.left -= buffer.byteLength;
  const type = (res.headers.get('content-type') || 'application/octet-stream').split(';')[0];
  return `data:${type};base64,${toBase64(buffer)}`;
}

function absCss(css, base) {
  return css.replace(URL_IN_CSS, (all, q, ref) => (/^(data|blob):/i.test(ref) ? all : `url(${q}${new URL(ref, base).href}${q})`));
}

async function fetchSheet(href, depth = 0) {
  const res = await fetch(href, { credentials: 'include' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  let css = absCss(await res.text(), href);
  if (depth < 2) {
    for (const m of [...css.matchAll(/@import\s+(?:url\(\s*)?["']?([^"')\s;]+)["']?\s*\)?([^;]*);/g)]) {
      try {
        const inner = await fetchSheet(new URL(m[1], href).href, depth + 1);
        css = css.replace(m[0], m[2].trim() ? `@media ${m[2].trim()} {\n${inner}\n}` : inner);
      } catch {
        // left as an @import
      }
    }
  }
  return css;
}

// Webfonts need CORS to load inside the plugin, so every font the CSS declares is embedded.
async function inlineFonts(css, budget) {
  const faces = css.match(/@font-face\s*{[^}]*}/g) ?? [];
  for (const face of faces) {
    let replaced = face;
    for (const m of face.matchAll(URL_IN_CSS)) {
      if (m[2].startsWith('data:')) continue;
      try {
        replaced = replaced.split(m[2]).join(await fetchAsDataUrl(m[2], budget));
      } catch {
        // the browser falls back to the next source or font
      }
    }
    if (replaced !== face) css = css.split(face).join(replaced);
  }
  return css;
}

async function build(tabId) {
  const [{ result: snap }] = await chrome.scripting.executeScript({ target: { tabId }, func: captureDom });
  const fontBudget = { left: LIMITS.fonts };
  const imageBudget = { left: LIMITS.images };
  const texts = [];
  for (const sheet of snap.sheets) {
    let text = sheet.text;
    if (text === undefined) {
      try {
        text = await fetchSheet(sheet.href);
      } catch {
        text = `@import url("${sheet.href}");`;
      }
    }
    text = await inlineFonts(text, fontBudget);
    texts.push(sheet.media && sheet.media !== 'all' ? `@media ${sheet.media} {\n${text}\n}` : text);
  }
  let html = snap.html;
  texts.forEach((text, i) => {
    html = html.replace(`<style data-h2f-sheet="${i}"></style>`, () => `<style>\n${text.replace(/<\/style/gi, '<\\/style')}\n</style>`);
  });
  // Images in use are embedded so logged-in and CORS-less images still come through.
  const embedded = {};
  await Promise.all(
    snap.assets.map(async (url) => {
      try {
        embedded[url] = await fetchAsDataUrl(url, imageBudget);
      } catch {
        // left as a URL: the plugin tries it directly or through its proxy
      }
    }),
  );
  for (const [url, data] of Object.entries(embedded)) {
    html = html.split(url).join(data);
    html = html.split(url.replace(/&/g, '&amp;')).join(data);
  }
  return { version: 1, kind: 'h2f-capture', url: snap.url, title: snap.title, width: snap.width, height: snap.height, html };
}

async function send(capture) {
  const res = await fetch(`${RELAY}/captures`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-h2f-capture': '1' },
    body: JSON.stringify(capture),
  });
  if (!res.ok) throw new Error(`relay answered ${res.status}`);
  return res.json();
}

async function download(capture) {
  const name = (capture.title || 'page').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'page';
  const url = `data:application/json;base64,${toBase64(new TextEncoder().encode(JSON.stringify(capture)))}`;
  await chrome.downloads.download({ url, filename: `${name}.h2f.json`, saveAs: false });
}

async function sendTab(tab) {
  if (!tab.id || !/^https?:|^file:/.test(tab.url ?? '')) {
    badge(tab.id, '!', '#dc2626', 'This page cannot be captured');
    return;
  }
  badge(tab.id, '…', '#71717a', 'Capturing…');
  let capture;
  try {
    capture = await build(tab.id);
  } catch (err) {
    badge(tab.id, '!', '#dc2626', `Capture failed: ${err.message ?? err}`);
    return;
  }
  try {
    const { listeners } = await send(capture);
    badge(tab.id, '✓', '#16a34a', listeners ? 'Sent to Figma' : 'Queued. Open the Page to Figma plugin in Figma to import it.');
  } catch {
    await download(capture);
    badge(tab.id, '↓', '#ca8a04', 'The relay is not running, so the capture was downloaded. Drop the .h2f.json file into Upload File.');
  }
  setTimeout(() => badge(tab.id, ''), 6000);
}

chrome.action.onClicked.addListener(sendTab);
// Lets automated tests trigger the same path as a click.
globalThis.sendTab = sendTab;
