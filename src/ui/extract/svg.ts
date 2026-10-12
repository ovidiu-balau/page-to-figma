const SVG_NS = 'http://www.w3.org/2000/svg';

// Presentation properties whose computed values are written back onto the clone, so class-based and
// inherited styling (including currentColor) survives outside the page.
const BAKED = [
  'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-linecap',
  'stroke-linejoin', 'stroke-dasharray', 'stroke-dashoffset', 'stroke-miterlimit', 'opacity',
  'stop-color', 'stop-opacity', 'font-family', 'font-size', 'font-weight', 'font-style', 'text-anchor',
  'dominant-baseline', 'clip-rule',
];

const DROP = new Set(['script', 'foreignobject', 'title', 'desc', 'metadata', 'style']);

function localRefs(value: string): string {
  // Computed url() values carry the document URL ("about:srcdoc#grad"); keep only the fragment.
  return value.replace(/url\(\s*["']?[^"')#]*#([^"')]+)["']?\s*\)/g, 'url(#$1)');
}

function bake(original: Element, clone: Element, win: Window): void {
  const cs = win.getComputedStyle(original);
  if (cs.display === 'none') {
    clone.remove();
    return;
  }
  const decl: string[] = [];
  for (const prop of BAKED) {
    const v = cs.getPropertyValue(prop);
    if (v) decl.push(`${prop}:${localRefs(v)}`);
  }
  if (cs.visibility === 'hidden') decl.push('visibility:hidden');
  clone.setAttribute('style', decl.join(';'));
  for (const attr of ['fill', 'stroke', 'stop-color']) {
    const v = clone.getAttribute(attr);
    if (v && /currentcolor/i.test(v)) clone.setAttribute(attr, cs.getPropertyValue(attr));
  }
}

function walkPair(original: Element, clone: Element, win: Window): void {
  const tag = original.localName.toLowerCase();
  if (DROP.has(tag)) {
    clone.remove();
    return;
  }
  bake(original, clone, win);
  const oKids = Array.from(original.children);
  const cKids = Array.from(clone.children);
  oKids.forEach((o, i) => cKids[i] && walkPair(o, cKids[i], win));
}

// <use> is expanded in place: Figma's SVG importer does not resolve references across the page.
function inlineUses(svg: SVGSVGElement, doc: Document): void {
  for (const use of Array.from(svg.querySelectorAll('use'))) {
    const href = use.getAttribute('href') || use.getAttribute('xlink:href') || '';
    if (!href.startsWith('#')) continue;
    const target = doc.getElementById(href.slice(1));
    if (!target) continue;
    const x = use.getAttribute('x') || '0';
    const y = use.getAttribute('y') || '0';
    const g = doc.createElementNS(SVG_NS, 'g');
    g.setAttribute('transform', `translate(${x} ${y})`);
    for (const a of ['class', 'style', 'fill', 'stroke', 'opacity']) {
      const v = use.getAttribute(a);
      if (v) g.setAttribute(a, v);
    }
    let content: Element;
    if (target.localName === 'symbol') {
      const inner = doc.createElementNS(SVG_NS, 'svg');
      const vb = target.getAttribute('viewBox');
      if (vb) inner.setAttribute('viewBox', vb);
      inner.setAttribute('width', use.getAttribute('width') || '100%');
      inner.setAttribute('height', use.getAttribute('height') || '100%');
      for (const child of Array.from(target.childNodes)) inner.appendChild(child.cloneNode(true));
      content = inner;
    } else {
      content = target.cloneNode(true) as Element;
      content.removeAttribute('id');
    }
    g.appendChild(content);
    use.replaceWith(g);
  }
}

export function serializeSvg(svg: SVGSVGElement, width: number, height: number, win: Window): string {
  const doc = svg.ownerDocument;
  // Expand <use> on a working copy first, then bake styles from a live, attached copy so selectors still match.
  const working = svg.cloneNode(true) as SVGSVGElement;
  working.style.position = 'absolute';
  working.style.left = '-99999px';
  working.style.top = '0';
  svg.parentNode?.insertBefore(working, svg.nextSibling);
  try {
    inlineUses(working, doc);
    const clone = working.cloneNode(true) as SVGSVGElement;
    walkPair(working, clone, win);
    const rootCs = win.getComputedStyle(svg);
    clone.removeAttribute('class');
    clone.setAttribute('xmlns', SVG_NS);
    clone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
    if (!clone.getAttribute('viewBox')) {
      const w = parseFloat(svg.getAttribute('width') || '') || width;
      const h = parseFloat(svg.getAttribute('height') || '') || height;
      clone.setAttribute('viewBox', `0 0 ${w} ${h}`);
    }
    clone.setAttribute('width', String(Math.max(width, 0.01)));
    clone.setAttribute('height', String(Math.max(height, 0.01)));
    const baked = BAKED.filter((p) => p !== 'opacity')
      .map((p) => `${p}:${localRefs(rootCs.getPropertyValue(p))}`)
      .filter((d) => !d.endsWith(':'));
    clone.setAttribute('style', baked.join(';'));
    return new XMLSerializer().serializeToString(clone);
  } finally {
    working.remove();
  }
}

export function svgFromMarkup(markup: string, width: number, height: number): string | null {
  const parsed = new DOMParser().parseFromString(markup, 'image/svg+xml');
  const svg = parsed.documentElement;
  if (!svg || svg.localName !== 'svg' || parsed.querySelector('parsererror')) return null;
  for (const el of Array.from(svg.querySelectorAll('script, foreignObject'))) el.remove();
  if (!svg.getAttribute('viewBox')) {
    const w = parseFloat(svg.getAttribute('width') || '') || width;
    const h = parseFloat(svg.getAttribute('height') || '') || height;
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  }
  svg.setAttribute('width', String(Math.max(width, 0.01)));
  svg.setAttribute('height', String(Math.max(height, 0.01)));
  svg.setAttribute('preserveAspectRatio', svg.getAttribute('preserveAspectRatio') || 'xMidYMid meet');
  return new XMLSerializer().serializeToString(svg);
}
