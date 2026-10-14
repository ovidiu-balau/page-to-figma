// Finds one screen of a long page by its name, so "send the Payment screen" imports just that part.
// Design files often stack many screens in one document, each under a label ("02 · Payment") or as
// its own section; the name is matched against those labels and the part it labels is returned.

export interface Screen {
  name: string;
  els: Element[]; // one element, or a run of siblings that together make the screen
}

const LABELS = 'h1,h2,h3,h4,h5,h6,[data-screen-label],[data-screen],[data-page],[data-title],[data-name],section[aria-label],article[aria-label],div[aria-label],figure[aria-label]';
const ATTRS = ['data-screen-label', 'data-screen', 'data-page', 'data-title', 'data-name', 'aria-label'];

const words = (s: string): string[] =>
  (s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').match(/[a-z0-9]+/g) ?? []).map((w) => (/^\d+$/.test(w) ? String(Number(w)) : w));

// 0 when the label does not answer to the name; higher is a closer match.
export function matchScore(query: string, label: string): number {
  const q = words(query);
  const l = words(label);
  if (!q.length || !l.length) return 0;
  if (q.join(' ') === l.join(' ')) return 1000;
  const have = new Set(l);
  if (!q.every((w) => have.has(w))) return 0;
  return 500 - (l.length - q.length);
}

function shown(el: Element, win: Window): boolean {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && win.getComputedStyle(el).visibility !== 'hidden';
}

function hasBox(el: Element, win: Window): boolean {
  const cs = win.getComputedStyle(el);
  const bg = cs.backgroundColor.match(/[\d.]+/g)?.map(Number);
  const painted = !!bg && (bg.length < 4 || bg[3] > 0.05) && cs.backgroundColor !== 'transparent';
  return painted || cs.backgroundImage !== 'none' || cs.boxShadow !== 'none' || parseFloat(cs.borderTopWidth) > 0;
}

// A heading's own words, without the badges ("Main path") that sit inside it.
function labelText(el: Element, win: Window): string {
  for (const a of ATTRS) {
    const v = el.getAttribute(a)?.trim();
    if (v && !/^h[1-6]$/.test(el.localName)) return v;
  }
  let out = '';
  const visit = (n: Node) => {
    if (n.nodeType === Node.TEXT_NODE) out += n.nodeValue ?? '';
    else if (n.nodeType === Node.ELEMENT_NODE && !(n !== el && hasBox(n as Element, win))) n.childNodes.forEach(visit);
  };
  visit(el);
  return out.replace(/\s+/g, ' ').trim();
}

function labels(doc: Document, win: Window): { el: Element; text: string }[] {
  const out: { el: Element; text: string }[] = [];
  for (const el of Array.from(doc.body?.querySelectorAll(LABELS) ?? [])) {
    if (!shown(el, win)) continue;
    const text = labelText(el, win);
    if (text && text.length <= 140) out.push({ el, text });
  }
  return out;
}

// Names to suggest when a requested screen is not found: the page's top-level headings.
export function screenNames(doc: Document, win: Window, limit = 12): string[] {
  const all = labels(doc, win).filter((l) => /^h[1-3]$/.test(l.el.localName));
  return [...new Set(all.map((l) => l.text))].slice(0, limit);
}

const tall = (el: Element) => el.getBoundingClientRect().height;

// The part of the page a label names.
function region(label: Element, doc: Document, win: Window): Element[] {
  const r = label.getBoundingClientRect();
  if (!/^h[1-6]$/.test(label.localName)) {
    if (r.width >= 200 && r.height >= 120) return [label];
  }
  // Peers are the other labels of the same kind: the screen is the largest part that holds this one only.
  const peers = Array.from(doc.body.querySelectorAll(label.localName)).filter((p) => p !== label && shown(p, win));
  let best: Element | null = null;
  let child: Element = label;
  let a = label.parentElement;
  while (a && a !== doc.body && a !== doc.documentElement) {
    if (peers.some((p) => a!.contains(p))) break;
    if (tall(a) >= r.height + 80) best = a;
    child = a;
    a = a.parentElement;
  }
  let els: Element[];
  if (best) els = [best];
  else {
    // Labels and screens side by side in one container: the screen runs to the next label.
    els = [child];
    for (let s = child.nextElementSibling; s; s = s.nextElementSibling) {
      if (peers.some((p) => p === s || s!.contains(p))) break;
      els.push(s);
    }
  }
  return refine(els, label, win);
}

// When the label is an annotation above a drawn screen (a mock with its own background), the screen
// itself is what goes to Figma.
function refine(els: Element[], label: Element, win: Window): Element[] {
  const parts = els.length === 1 ? Array.from(els[0].children) : els;
  const rest = parts.filter((p) => !p.contains(label) && shown(p, win));
  const big = rest.filter((p) => tall(p) >= 150);
  if (big.length !== 1) return els;
  const holder = parts.find((p) => p.contains(label));
  const above = !holder || holder.getBoundingClientRect().bottom <= big[0].getBoundingClientRect().top + 1;
  // A drawn screen has its own surface, often one wrapper down.
  let screen: Element | null = big[0];
  while (screen && !hasBox(screen, win) && screen.children.length === 1) screen = screen.children[0];
  return above && screen && hasBox(screen, win) ? [screen] : els;
}

export function findScreen(doc: Document, win: Window, name: string): Screen | null {
  let best: { el: Element; text: string; score: number } | null = null;
  for (const l of labels(doc, win)) {
    const score = matchScore(name, l.text);
    if (score > (best?.score ?? 0)) best = { ...l, score };
  }
  if (!best) return null;
  return { name: best.text, els: region(best.el, doc, win) };
}
