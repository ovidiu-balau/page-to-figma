// Injected into the tab. Freezes what is on screen into a self-describing snapshot: live form values,
// canvases, the current image sources and every stylesheet as the browser parsed it (including rules
// added from JavaScript). Scripts are dropped so nothing re-runs when the plugin renders it.
// Returns { url, title, width, height, html, sheets, assets }.
export function captureDom() {
  const abs = (u) => {
    try {
      return new URL(u, document.baseURI).href;
    } catch {
      return u;
    }
  };
  const assets = new Set();
  const URL_IN_CSS = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;
  const absCss = (css, base) => css.replace(URL_IN_CSS, (all, q, ref) => (/^(data|blob):/i.test(ref) ? all : `url(${q}${new URL(ref, base).href}${q})`));

  // Originals and clones line up one to one: document.querySelectorAll('*') starts with <html>.
  const originals = Array.from(document.querySelectorAll('*'));
  const root = document.documentElement.cloneNode(true);
  const copies = [root, ...root.querySelectorAll('*')];
  const drop = [];
  originals.forEach((o, i) => {
    const c = copies[i];
    if (!c) return;
    const tag = o.localName;
    if (tag === 'script' || tag === 'noscript' || tag === 'base' || (tag === 'link' && /preload|prefetch|modulepreload|stylesheet/i.test(o.rel))) {
      drop.push(c);
      return;
    }
    if (tag === 'style') {
      drop.push(c);
      return;
    }
    if (tag === 'input') {
      if (o.type === 'checkbox' || o.type === 'radio') o.checked ? c.setAttribute('checked', '') : c.removeAttribute('checked');
      else if (o.type !== 'file' && o.type !== 'password') c.setAttribute('value', o.value);
    } else if (tag === 'textarea') {
      c.textContent = o.value;
    } else if (tag === 'select') {
      Array.from(o.options).forEach((opt, j) => {
        const co = c.options?.[j];
        if (co) opt.selected ? co.setAttribute('selected', '') : co.removeAttribute('selected');
      });
    } else if (tag === 'canvas') {
      try {
        const img = document.createElement('img');
        img.src = o.toDataURL('image/png');
        img.setAttribute('style', o.getAttribute('style') ?? '');
        img.className = o.className;
        img.width = o.width;
        img.height = o.height;
        c.replaceWith(img);
      } catch {
        // tainted canvas: left empty
      }
    } else if (tag === 'img') {
      const src = o.currentSrc || o.src;
      if (src) {
        c.setAttribute('src', abs(src));
        assets.add(abs(src));
      }
      c.removeAttribute('srcset');
      c.removeAttribute('sizes');
      c.removeAttribute('loading');
    } else if (tag === 'source') {
      drop.push(c);
    } else if (tag === 'video' && o.poster) {
      c.setAttribute('poster', abs(o.poster));
      assets.add(abs(o.poster));
    } else if (tag === 'a' && o.getAttribute('href')) {
      c.setAttribute('href', o.href);
    } else if (tag === 'iframe') {
      // Embedded frames import as placeholders; not loading them avoids their scripts and CSP errors.
      if (o.getAttribute('src')) c.setAttribute('data-src', abs(o.getAttribute('src')));
      c.setAttribute('src', 'about:blank');
      c.removeAttribute('srcdoc');
    }
    if (o.getAttribute('style')?.includes('url(')) c.setAttribute('style', absCss(o.getAttribute('style'), document.baseURI));
    if (o.localName === 'image' || o.localName === 'use') {
      const href = o.getAttribute('href') || o.getAttribute('xlink:href');
      if (href && !href.startsWith('#')) c.setAttribute('href', abs(href));
    }
    // Images painted from CSS: only those actually in use get inlined.
    const bg = getComputedStyle(o).backgroundImage;
    if (bg && bg !== 'none') for (const m of bg.matchAll(URL_IN_CSS)) if (!m[2].startsWith('data:')) assets.add(abs(m[2]));
    for (const pseudo of ['::before', '::after']) {
      const p = getComputedStyle(o, pseudo);
      for (const value of [p.backgroundImage, p.content]) {
        if (value && value.includes('url(')) for (const m of value.matchAll(URL_IN_CSS)) if (!m[2].startsWith('data:')) assets.add(abs(m[2]));
      }
    }
  });
  for (const c of drop) c.remove();

  // Stylesheets in cascade order, as parsed. Cross-origin sheets cannot be read here; the extension
  // fetches those by URL.
  const sheets = [];
  const readSheet = (sheet) => {
    if (sheet.disabled) return;
    const media = sheet.media?.mediaText || '';
    try {
      const parts = [];
      for (const rule of Array.from(sheet.cssRules)) {
        if (rule.type === CSSRule.IMPORT_RULE && rule.styleSheet) {
          try {
            const inner = Array.from(rule.styleSheet.cssRules).map((r) => r.cssText).join('\n');
            const m = rule.media?.mediaText;
            parts.push(m ? `@media ${m} {\n${absCss(inner, rule.styleSheet.href || sheet.href || document.baseURI)}\n}` : absCss(inner, rule.styleSheet.href || sheet.href || document.baseURI));
          } catch {
            sheets.push({ href: rule.styleSheet.href, media: rule.media?.mediaText || '' });
          }
          continue;
        }
        parts.push(rule.cssText);
      }
      sheets.push({ text: absCss(parts.join('\n'), sheet.href || document.baseURI), media });
    } catch {
      if (sheet.href) sheets.push({ href: sheet.href, media });
    }
  };
  for (const sheet of Array.from(document.styleSheets)) readSheet(sheet);
  for (const sheet of document.adoptedStyleSheets ?? []) readSheet(sheet);

  const head = root.querySelector('head') ?? root.insertBefore(document.createElement('head'), root.firstChild);
  sheets.forEach((_, i) => {
    const s = document.createElement('style');
    s.setAttribute('data-h2f-sheet', String(i));
    head.appendChild(s);
  });
  const meta = document.createElement('meta');
  meta.setAttribute('charset', 'utf-8');
  head.prepend(meta);

  return {
    url: location.href,
    title: document.title || location.hostname,
    width: window.innerWidth,
    height: window.innerHeight,
    html: '<!DOCTYPE html>\n' + root.outerHTML,
    sheets,
    assets: [...assets].filter((u) => /^https?:/i.test(u)),
  };
}
