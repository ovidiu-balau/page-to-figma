import JSZip from 'jszip';
import type { ExistingMode } from '../shared/types';
import { fetchText } from './net';

export interface SourceDoc {
  name: string;
  html: string; // complete document markup, self-contained or carrying a <base href>
  baseUrl?: string;
  fromCode?: boolean; // pasted snippet: Tailwind and the root font size always apply
  width?: number; // browser captures keep the width they were taken at
  only?: string[]; // import just these pages or screens, by name
  existing?: ExistingMode; // overrides the plugin setting for this source
}

export interface Capture {
  kind: 'h2f-capture';
  version: number;
  url: string;
  title: string;
  width: number;
  height: number;
  html: string;
  // Sent from source (scripts/send.mjs) rather than frozen in a browser: its scripts still need to run.
  live?: boolean;
  only?: string[];
  existing?: ExistingMode;
}

function sendOptions(capture: Capture): Pick<SourceDoc, 'only' | 'existing'> {
  const only = Array.isArray(capture.only) ? capture.only.filter((n) => typeof n === 'string' && n.trim()).map((n) => n.trim()) : [];
  const existing = (['ask', 'replace', 'copy'] as const).find((m) => m === capture.existing);
  return { ...(only.length ? { only } : {}), ...(existing ? { existing } : {}) };
}

export function isCapture(value: unknown): value is Capture {
  return !!value && typeof value === 'object' && (value as Capture).kind === 'h2f-capture' && typeof (value as Capture).html === 'string';
}

// A browser capture is already frozen (scripts removed, styles and images inlined); it only needs a
// <base> so anything left as a relative URL still resolves against the original page. A live capture
// is page source, so its scripts stay and render it in the plugin.
export function fromCapture(capture: Capture): SourceDoc {
  const web = /^https?:/i.test(capture.url ?? '');
  if (capture.live && !web) return { name: capture.title || 'Page', html: capture.html, width: capture.width, ...sendOptions(capture) };
  const parsed = new DOMParser().parseFromString(capture.html, 'text/html');
  if (!capture.live) for (const s of Array.from(parsed.querySelectorAll('script'))) s.remove();
  if (web) {
    parsed.querySelector('base')?.remove();
    const base = parsed.createElement('base');
    base.href = capture.url;
    parsed.head.prepend(base);
  }
  return {
    name: capture.title || (web ? nameFromUrl(capture.url) : 'Page'),
    html: '<!DOCTYPE html>\n' + parsed.documentElement.outerHTML,
    baseUrl: web ? capture.url : undefined,
    width: capture.width,
    ...sendOptions(capture),
  };
}

const CSS_URL = /url\(\s*(["']?)([^"')]+)\1\s*\)/g;
const CSS_IMPORT = /@import\s+(?:url\(\s*)?["']?([^"')\s;]+)["']?\s*\)?([^;]*);/g;

function absolutize(ref: string, base: string): string {
  if (/^(data|blob|about|javascript|#)/i.test(ref)) return ref;
  try {
    return new URL(ref, base).href;
  } catch {
    return ref;
  }
}

function rewriteCssUrls(css: string, base: string, map: (url: string) => string = (u) => absolutize(u, base)): string {
  return css.replace(CSS_URL, (_, q, ref) => `url(${q}${map(ref)}${q})`);
}

async function inlineCss(css: string, cssUrl: string, proxy: string, depth = 0): Promise<string> {
  let out = rewriteCssUrls(css, cssUrl);
  if (depth > 2) return out;
  const imports = [...out.matchAll(CSS_IMPORT)];
  for (const m of imports) {
    const target = absolutize(m[1], cssUrl);
    try {
      const nested = await inlineCss(await fetchText(target, proxy), target, proxy, depth + 1);
      const media = m[2].trim();
      out = out.replace(m[0], media ? `@media ${media} {\n${nested}\n}` : nested);
    } catch {
      // unreachable imports stay as they are and may still load directly
    }
  }
  return out;
}

function nameFromUrl(url: string): string {
  try {
    const u = new URL(url);
    return (u.hostname + (u.pathname === '/' ? '' : u.pathname)).replace(/\/$/, '');
  } catch {
    return url;
  }
}

// Linked stylesheets are fetched and inlined so their rules are readable (dark mode, pseudo elements)
// and their relative url()s keep working inside the sandbox.
export async function loadUrl(rawUrl: string, proxy: string, onStatus: (s: string) => void): Promise<SourceDoc> {
  const url = /^[a-z]+:\/\//i.test(rawUrl.trim()) ? rawUrl.trim() : `https://${rawUrl.trim()}`;
  onStatus('Fetching page…');
  let html: string;
  try {
    html = await fetchText(url, proxy);
  } catch (err) {
    throw new Error(
      proxy.trim()
        ? `Could not fetch ${url} (${(err as Error).message}). Check the CORS proxy in Options.`
        : `Could not fetch ${url}. The site blocks direct requests: add a CORS proxy URL in Options, or upload the page as a file.`,
    );
  }
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  const base = parsed.querySelector('base[href]')?.getAttribute('href');
  const baseUrl = base ? absolutize(base, url) : url;
  const links = Array.from(parsed.querySelectorAll<HTMLLinkElement>('link[rel~="stylesheet"][href]'));
  let done = 0;
  await Promise.all(
    links.map(async (link) => {
      const href = absolutize(link.getAttribute('href')!, baseUrl);
      try {
        const css = await inlineCss(await fetchText(href, proxy), href, proxy);
        const style = parsed.createElement('style');
        const media = link.getAttribute('media');
        style.textContent = media && media !== 'all' ? `@media ${media} {\n${css}\n}` : css;
        style.setAttribute('data-href', href);
        link.replaceWith(style);
      } catch {
        link.setAttribute('href', href);
      }
      onStatus(`Loading styles… ${++done}/${links.length}`);
    }),
  );
  for (const style of Array.from(parsed.querySelectorAll('style:not([data-href])'))) {
    style.textContent = rewriteCssUrls(style.textContent ?? '', baseUrl);
  }
  parsed.querySelector('base')?.remove();
  const baseEl = parsed.createElement('base');
  baseEl.href = baseUrl;
  parsed.head.prepend(baseEl);
  const title = parsed.querySelector('title')?.textContent?.trim();
  return { name: title || nameFromUrl(url), html: '<!DOCTYPE html>\n' + parsed.documentElement.outerHTML, baseUrl };
}

export function fromCode(html: string, css: string): SourceDoc {
  const isDocument = /<html[\s>]/i.test(html);
  const styleTag = css.trim() ? `<style>\n${css}\n</style>` : '';
  const doc = isDocument
    ? html.replace(/<\/head>/i, `${styleTag}</head>`)
    : `<!DOCTYPE html><html><head><meta charset="utf-8">${styleTag}</head><body>${html}</body></html>`;
  const title = html.match(/<title>([^<]*)<\/title>/i)?.[1]?.trim();
  return { name: title || 'Pasted HTML', html: doc, fromCode: true };
}

interface VirtualFile {
  path: string; // normalised, forward slashes, no leading slash
  blob: Blob;
}

function normalize(path: string): string {
  const out: string[] = [];
  for (const part of path.replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

function dirname(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i + 1);
}

const MIME: Record<string, string> = {
  css: 'text/css', js: 'text/javascript', mjs: 'text/javascript', svg: 'image/svg+xml', png: 'image/png',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', ico: 'image/x-icon',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', json: 'application/json', mp4: 'video/mp4',
};

// Uploaded files (and ZIP contents) form one virtual folder; every relative reference in the HTML and
// CSS is resolved inside it and replaced with a blob: URL the sandbox can load.
class VirtualFolder {
  private files = new Map<string, VirtualFile>();
  private urls = new Map<string, string>();
  private cssCache = new Map<string, Promise<string>>();

  add(path: string, blob: Blob): void {
    const p = normalize(path);
    this.files.set(p.toLowerCase(), { path: p, blob });
  }

  get htmlFiles(): VirtualFile[] {
    return [...this.files.values()].filter((f) => /\.html?$/i.test(f.path) && !f.path.startsWith('__MACOSX/'));
  }

  private find(ref: string, fromDir: string): VirtualFile | undefined {
    const clean = decodeURIComponent(ref.split(/[?#]/)[0]);
    return this.files.get(normalize(fromDir + clean).toLowerCase()) ?? this.files.get(normalize(clean).toLowerCase());
  }

  private async url(file: VirtualFile): Promise<string> {
    let u = this.urls.get(file.path);
    if (!u) {
      const ext = file.path.split('.').pop()!.toLowerCase();
      let blob = file.blob;
      if (ext === 'css') blob = new Blob([await this.css(file)], { type: 'text/css' });
      else if (MIME[ext] && blob.type !== MIME[ext]) blob = new Blob([blob], { type: MIME[ext] });
      u = URL.createObjectURL(blob);
      this.urls.set(file.path, u);
    }
    return u;
  }

  private css(file: VirtualFile): Promise<string> {
    let p = this.cssCache.get(file.path);
    if (!p) {
      p = file.blob.text().then((css) => this.resolveCss(css, dirname(file.path)));
      this.cssCache.set(file.path, p);
    }
    return p;
  }

  private async resolveRef(ref: string, fromDir: string): Promise<string | null> {
    if (/^([a-z]+:|\/\/|#)/i.test(ref)) return null;
    const f = this.find(ref, fromDir);
    if (!f) return null;
    const hash = ref.includes('#') ? ref.slice(ref.indexOf('#')) : '';
    return (await this.url(f)) + hash;
  }

  private async resolveCss(css: string, dir: string): Promise<string> {
    const refs = new Map<string, string>();
    for (const m of css.matchAll(CSS_URL)) {
      const r = await this.resolveRef(m[2], dir);
      if (r) refs.set(m[2], r);
    }
    for (const m of css.matchAll(CSS_IMPORT)) {
      const r = await this.resolveRef(m[1], dir);
      if (r) refs.set(m[1], r);
    }
    return css
      .replace(CSS_URL, (all, q, ref) => (refs.has(ref) ? `url(${q}${refs.get(ref)}${q})` : all))
      .replace(CSS_IMPORT, (all, ref) => (refs.has(ref) ? all.replace(ref, refs.get(ref)!) : all));
  }

  async document(file: VirtualFile): Promise<SourceDoc> {
    const dir = dirname(file.path);
    const parsed = new DOMParser().parseFromString(await file.blob.text(), 'text/html');
    for (const link of Array.from(parsed.querySelectorAll<HTMLLinkElement>('link[rel~="stylesheet"][href]'))) {
      const f = this.find(link.getAttribute('href')!, dir);
      if (!f) continue;
      const style = parsed.createElement('style');
      style.textContent = await this.css(f);
      link.replaceWith(style);
    }
    for (const style of Array.from(parsed.querySelectorAll('style'))) {
      style.textContent = await this.resolveCss(style.textContent ?? '', dir);
    }
    for (const el of Array.from(parsed.querySelectorAll('[src],[href],[poster],[data-src],[srcset],[style]'))) {
      for (const attr of ['src', 'href', 'poster', 'data-src']) {
        const v = el.getAttribute(attr);
        if (!v || (attr === 'href' && el.localName === 'a')) continue;
        const r = await this.resolveRef(v, dir);
        if (r) el.setAttribute(attr, r);
      }
      const srcset = el.getAttribute('srcset');
      if (srcset) {
        const parts = await Promise.all(
          srcset.split(',').map(async (part) => {
            const [ref, ...desc] = part.trim().split(/\s+/);
            const r = await this.resolveRef(ref, dir);
            return [r ?? ref, ...desc].join(' ');
          }),
        );
        el.setAttribute('srcset', parts.join(', '));
      }
      const inline = el.getAttribute('style');
      if (inline && inline.includes('url(')) el.setAttribute('style', await this.resolveCss(inline, dir));
    }
    const title = parsed.querySelector('title')?.textContent?.trim();
    const base = file.path.split('/').pop()!.replace(/\.html?$/i, '');
    return { name: title || base, html: '<!DOCTYPE html>\n' + parsed.documentElement.outerHTML };
  }
}

export async function loadFiles(files: File[], onStatus: (s: string) => void): Promise<SourceDoc[]> {
  const folder = new VirtualFolder();
  const captures: SourceDoc[] = [];
  for (const file of files) {
    if (/\.json$/i.test(file.name)) {
      let data: unknown = null;
      try {
        data = JSON.parse(await file.text());
      } catch {
        // not JSON: treated as an asset below
      }
      if (isCapture(data)) {
        captures.push(fromCapture(data));
        continue;
      }
    }
    if (/\.zip$/i.test(file.name)) {
      onStatus(`Unpacking ${file.name}…`);
      const zip = await JSZip.loadAsync(file);
      const entries = Object.values(zip.files).filter((e) => !e.dir);
      for (const entry of entries) folder.add(entry.name, await entry.async('blob'));
    } else if (/\.mopack$/i.test(file.name)) {
      throw new Error('.mopack files are not supported. Save the page as HTML (or a ZIP of it), or use the Send to Figma browser button.');
    } else {
      folder.add(file.webkitRelativePath || file.name, file);
    }
  }
  const htmlFiles = folder.htmlFiles;
  if (!htmlFiles.length && captures.length) return captures;
  if (!htmlFiles.length) throw new Error('No .html file found in the selection.');
  // Every HTML file is offered; index pages and shallow paths come first so the page picker reads naturally.
  const rank = (p: string) => (/(^|\/)index\.html?$/i.test(p) ? 0 : 1) * 1000 + p.split('/').length * 10;
  const chosen = [...htmlFiles].sort((a, b) => rank(a.path) - rank(b.path) || a.path.localeCompare(b.path));
  const docs: SourceDoc[] = [...captures];
  for (const f of chosen) {
    onStatus(`Reading ${f.path}…`);
    docs.push(await folder.document(f));
  }
  return docs;
}
