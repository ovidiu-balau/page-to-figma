import type { SourceDoc } from './sources';

export interface RenderOptions {
  width: number;
  height: number;
  darkMode: boolean;
  tailwind: boolean;
  disablePreflight: boolean;
  tailwindConfig: string;
  rootFontSize: number;
}

export interface Rendered {
  win: Window;
  doc: Document;
  iframe: HTMLIFrameElement;
  dispose: () => void;
}

const TAILWIND_CDN = 'https://cdn.tailwindcss.com/3.4.17';
const TW_CLASS = /^(-?(m|p)[trblxy]?-|flex$|grid$|gap-|text-|bg-|w-|h-|min-|max-|rounded|shadow|border|items-|justify-|space-[xy]-|font-|leading-|tracking-|inset-|top-|left-|right-|bottom-|z-|col-span|grid-cols|hidden$|block$|inline-|absolute$|relative$|sticky$|fixed$|opacity-|overflow-|sm:|md:|lg:|xl:|2xl:|hover:|dark:)/;

function usesTailwind(html: string): boolean {
  if (/cdn\.tailwindcss\.com|--tw-/.test(html)) return false; // already ships its own Tailwind
  const classes = html.match(/class\s*=\s*"([^"]*)"/g) ?? [];
  let hits = 0;
  for (const attr of classes) {
    for (const c of attr.slice(attr.indexOf('"') + 1, -1).split(/\s+/)) if (TW_CLASS.test(c)) hits++;
    if (hits > 12) return true;
  }
  return false;
}

function tailwindConfig(opts: RenderOptions): string {
  let config: Record<string, unknown> = {};
  if (opts.tailwindConfig.trim()) {
    try {
      config = JSON.parse(opts.tailwindConfig);
    } catch {
      throw new Error('Custom Tailwind config is not valid JSON.');
    }
  }
  if (opts.disablePreflight) config.corePlugins = { ...(config.corePlugins as object), preflight: false };
  if (opts.darkMode) config.darkMode = 'class';
  return JSON.stringify(config);
}

// Runs before page scripts so theme logic that asks matchMedia sees a dark preference.
const DARK_MEDIA_PATCH = `<script>(function(){var m=window.matchMedia.bind(window);window.matchMedia=function(q){var r=m(q);if(/prefers-color-scheme/.test(q)){var dark=/dark/.test(q);return Object.assign(Object.create(r),{matches:dark,media:q,addListener:function(){},removeListener:function(){},addEventListener:function(){},removeEventListener:function(){}});}return r;};})();</script>`;

const FREEZE_STYLE = `<style data-h2f>*,*::before,*::after{transition:none!important;animation-duration:0s!important;animation-delay:0s!important;animation-iteration-count:1!important;caret-color:transparent!important;scroll-behavior:auto!important}</style>`;

function prepareHtml(source: SourceDoc, opts: RenderOptions): string {
  const head: string[] = [];
  if (opts.darkMode) head.push(DARK_MEDIA_PATCH);
  head.push(FREEZE_STYLE);
  if (source.fromCode || opts.rootFontSize !== 16) head.push(`<style data-h2f>html{font-size:${opts.rootFontSize}px}</style>`);
  const tail: string[] = [];
  if (opts.tailwind && (source.fromCode || usesTailwind(source.html))) {
    tail.push(`<script src="${TAILWIND_CDN}"></script><script>tailwind.config=${tailwindConfig(opts)}</script>`);
  }
  let html = source.html;
  const headOpen = html.match(/<head[^>]*>/i);
  if (headOpen) {
    // <base> must stay first so relative URLs in the injected markup resolve the same way.
    const afterBase = html.slice(headOpen.index! + headOpen[0].length).match(/^\s*<base[^>]*>/i);
    const at = headOpen.index! + headOpen[0].length + (afterBase ? afterBase[0].length : 0);
    html = html.slice(0, at) + head.join('') + html.slice(at);
  } else {
    html = `<head>${head.join('')}</head>` + html;
  }
  html = /<\/head>/i.test(html) ? html.replace(/<\/head>/i, `${tail.join('')}</head>`) : html + tail.join('');
  return html;
}

function applyDarkMode(doc: Document): void {
  const collected: string[] = [];
  const visit = (rules: CSSRuleList) => {
    for (const rule of Array.from(rules)) {
      // Rules come from the page's window, so check the rule type rather than instanceof.
      if (rule.type === CSSRule.MEDIA_RULE) {
        const media = rule as CSSMediaRule;
        if (/prefers-color-scheme\s*:\s*dark/.test(media.conditionText)) {
          for (const inner of Array.from(media.cssRules)) collected.push(inner.cssText);
        } else visit(media.cssRules);
      } else if ('cssRules' in rule && (rule as CSSGroupingRule).cssRules) {
        visit((rule as CSSGroupingRule).cssRules);
      }
    }
  };
  for (const sheet of Array.from(doc.styleSheets)) {
    try {
      visit(sheet.cssRules);
    } catch {
      // cross-origin sheet: rules are not readable
    }
  }
  if (collected.length) {
    const style = doc.createElement('style');
    style.setAttribute('data-h2f', 'dark');
    style.textContent = collected.join('\n');
    (doc.body ?? doc.head).appendChild(style);
  }
  const html = doc.documentElement;
  html.classList.add('dark');
  html.setAttribute('data-theme', 'dark');
  html.setAttribute('data-bs-theme', 'dark');
  html.style.colorScheme = 'dark';
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function frames(win: Window, n = 2): Promise<void> {
  return new Promise((resolve) => {
    const step = (left: number) => (left <= 0 ? resolve() : win.requestAnimationFrame(() => step(left - 1)));
    step(n);
    setTimeout(resolve, 200); // rAF can stall in a background frame
  });
}

async function waitForAssets(doc: Document): Promise<void> {
  for (const img of Array.from(doc.images)) {
    if (img.loading === 'lazy') img.loading = 'eager';
    const lazy = img.getAttribute('data-src') || img.getAttribute('data-lazy-src') || img.getAttribute('data-original');
    if (lazy && (!img.getAttribute('src') || img.src.startsWith('data:image/gif'))) img.src = lazy;
    const lazySet = img.getAttribute('data-srcset');
    if (lazySet && !img.getAttribute('srcset')) img.srcset = lazySet;
  }
  const pending = Array.from(doc.images)
    .filter((img) => !img.complete)
    .map((img) => new Promise<void>((r) => {
      img.addEventListener('load', () => r(), { once: true });
      img.addEventListener('error', () => r(), { once: true });
    }));
  await Promise.race([Promise.all(pending), delay(8000)]);
  await Promise.race([doc.fonts.ready.then(() => undefined), delay(5000)]);
}

export async function render(source: SourceDoc, opts: RenderOptions, host: HTMLElement): Promise<Rendered> {
  const iframe = document.createElement('iframe');
  iframe.setAttribute('aria-hidden', 'true');
  iframe.tabIndex = -1;
  iframe.style.cssText = `position:absolute;left:0;top:0;width:${opts.width}px;height:${opts.height}px;border:0;background:#fff`;
  const html = prepareHtml(source, opts);
  host.appendChild(iframe);
  // An about:blank frame written with document.write keeps this UI's origin even inside Figma's
  // sandboxed host, where a srcdoc frame would get a fresh opaque origin and be unreadable.
  const win = iframe.contentWindow;
  const doc = iframe.contentDocument;
  if (!win || !doc) {
    iframe.remove();
    throw new Error('The page could not be rendered.');
  }
  doc.open();
  const loaded = new Promise<void>((resolve) => win.addEventListener('load', () => resolve(), { once: true }));
  doc.write(html);
  doc.close();
  await Promise.race([loaded, delay(20000)]);
  if (!doc.documentElement) throw new Error('The page could not be rendered.');
  await waitForAssets(doc);
  if (opts.tailwind && html.includes(TAILWIND_CDN)) {
    // The Tailwind play CDN generates its stylesheet after load; give it a moment to settle.
    const start = Date.now();
    while (Date.now() - start < 3000 && !Array.from(doc.querySelectorAll('style')).some((s) => (s.textContent ?? '').includes('--tw-'))) {
      await delay(100);
    }
    await delay(150);
  }
  if (opts.darkMode) applyDarkMode(doc);
  await frames(win);
  await delay(120);
  return { win, doc, iframe, dispose: () => iframe.remove() };
}

export { frames, delay };
