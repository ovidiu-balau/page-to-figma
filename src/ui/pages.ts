// Single-file prototypes often hold several screens in one document and toggle them with classes or
// the hidden attribute. Detection finds the sibling group that behaves like that; showing a page swaps
// the "active" state onto it and hides its siblings, then everything is put back afterwards.

export interface InPage {
  index: number;
  name: string;
  el: Element;
}

const SELECTORS = [
  '[data-page]', '[data-screen]', '[data-view]', '[data-route]', '[data-tab-content]', '.page', '.screen', '.view',
  '.slide', '[role="tabpanel"]', 'section[id]', 'body > div[id]', 'main > div[id]',
];

const ACTIVE_CLASS = /^(active|is-active|current|is-current|show|shown|visible|is-visible|selected|open|is-open|on)$/;

function isHidden(el: Element, win: Window): boolean {
  const cs = win.getComputedStyle(el);
  return el.hasAttribute('hidden') || cs.display === 'none' || cs.visibility === 'hidden' || el.getAttribute('aria-hidden') === 'true';
}

function humanize(id: string): string {
  return id.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).trim();
}

function pageName(el: Element, i: number): string {
  for (const attr of ['data-page', 'data-screen', 'data-view', 'data-title', 'data-name', 'aria-label', 'data-route']) {
    const v = el.getAttribute(attr);
    if (v && v.trim() && v.length < 60) return humanize(v.replace(/^[#/]+/, ''));
  }
  if (el.id) return humanize(el.id);
  const heading = el.querySelector('h1, h2, h3')?.textContent?.trim();
  if (heading) return heading.slice(0, 40);
  return `Page ${i + 1}`;
}

function sharedKey(el: Element): string {
  const tokens = Array.from(el.classList).filter((c) => !ACTIVE_CLASS.test(c)).sort();
  return `${el.localName}|${tokens[0] ?? ''}`;
}

export function detectPages(doc: Document, win: Window): InPage[] {
  const groups = new Map<string, { parent: Element; members: Set<Element> }>();
  const add = (el: Element) => {
    const parent = el.parentElement;
    if (!parent || el.closest('nav, header, footer, [role="menu"], [role="listbox"], dialog')) return;
    const key = `${groups.size}`;
    let found: { parent: Element; members: Set<Element> } | undefined;
    for (const g of groups.values()) {
      const sample = g.members.values().next().value!;
      if (g.parent === parent && sharedKey(sample) === sharedKey(el)) found = g;
    }
    if (!found) {
      found = { parent, members: new Set() };
      groups.set(key, found);
    }
    found.members.add(el);
  };
  for (const sel of SELECTORS) {
    for (const el of Array.from(doc.querySelectorAll(sel))) add(el);
  }
  // Plain sibling screens: same tag and leading class, most of them hidden.
  for (const parent of Array.from(doc.querySelectorAll('body, main, #app, #root, .app, .container'))) {
    const kids = Array.from(parent.children).filter((c) => c.id || c.classList.length);
    if (kids.length >= 2 && kids.filter((k) => isHidden(k, win)).length >= 1) for (const k of kids) add(k);
  }
  let best: Element[] = [];
  let bestScore = 0;
  for (const g of groups.values()) {
    const members = Array.from(g.members);
    if (members.length < 2) continue;
    const hidden = members.filter((m) => isHidden(m, win)).length;
    if (hidden === 0 || hidden === members.length && members.length < 3) continue;
    if (members.some((m) => (m.textContent ?? '').trim().length < 10 && m.children.length < 2)) continue;
    // Prefer outermost groups with more content: those are screens, inner ones are tabs.
    let depth = 0;
    for (let p: Element | null = g.parent; p; p = p.parentElement) depth++;
    const score = members.reduce((s, m) => s + Math.min((m.textContent ?? '').length, 5000), 0) / depth;
    if (score > bestScore) {
      bestScore = score;
      best = members;
    }
  }
  best.sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  return best.map((el, index) => ({ index, el, name: pageName(el, index) }));
}

export function showPage(page: InPage, all: InPage[], win: Window): () => void {
  const saved = all.map((p) => ({
    el: p.el,
    cls: p.el.getAttribute('class'),
    hidden: p.el.hasAttribute('hidden'),
    style: p.el.getAttribute('style'),
    aria: p.el.getAttribute('aria-hidden'),
  }));
  const visible = all.find((p) => !isHidden(p.el, win));
  const activeClasses = visible ? Array.from(visible.el.classList).filter((c) => ACTIVE_CLASS.test(c)) : [];
  const shownDisplay = visible ? win.getComputedStyle(visible.el).display : 'block';
  for (const p of all) {
    const el = p.el as HTMLElement;
    if (p === page) {
      el.removeAttribute('hidden');
      el.removeAttribute('aria-hidden');
      for (const c of activeClasses) el.classList.add(c);
      if (el.style.display === 'none') el.style.removeProperty('display');
      if (win.getComputedStyle(el).display === 'none') el.style.setProperty('display', shownDisplay === 'none' ? 'block' : shownDisplay, 'important');
      if (win.getComputedStyle(el).visibility === 'hidden') el.style.setProperty('visibility', 'visible', 'important');
      if (parseFloat(win.getComputedStyle(el).opacity) === 0) el.style.setProperty('opacity', '1', 'important');
    } else {
      for (const c of activeClasses) el.classList.remove(c);
      el.style.setProperty('display', 'none', 'important');
    }
  }
  return () => {
    for (const s of saved) {
      const el = s.el as HTMLElement;
      if (s.cls === null) el.removeAttribute('class');
      else el.setAttribute('class', s.cls);
      if (s.style === null) el.removeAttribute('style');
      else el.setAttribute('style', s.style);
      if (s.hidden) el.setAttribute('hidden', '');
      else el.removeAttribute('hidden');
      if (s.aria === null) el.removeAttribute('aria-hidden');
      else el.setAttribute('aria-hidden', s.aria);
    }
  };
}
