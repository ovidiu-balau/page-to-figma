import type { Fill, TextRun } from '../../shared/types';
import { parseColor, px, splitTop } from './css';
import { parseGradient } from './gradient';

export interface LineBox {
  left: number;
  right: number;
  top: number;
  bottom: number;
  center: number;
}

function collapse(text: string, ws: string): string {
  if (ws === 'pre' || ws === 'pre-wrap' || ws === 'break-spaces') return text;
  if (ws === 'pre-line') return text.replace(/[\t ]+/g, ' ').replace(/ ?\n ?/g, '\n');
  return text.replace(/[\t\n\r\f ]+/g, ' ');
}

function preserves(ws: string): boolean {
  return ws === 'pre' || ws === 'pre-wrap' || ws === 'break-spaces';
}

const TEXT_CASE: Record<string, TextRun['textCase']> = {
  uppercase: 'UPPER', lowercase: 'LOWER', capitalize: 'TITLE',
};

// background-clip: text paints the element's background through the glyphs.
function clipGradient(el: Element, win: Window): { fill: Fill; box: DOMRect } | undefined {
  for (let cur: Element | null = el; cur && cur !== el.ownerDocument.body; cur = cur.parentElement) {
    const cs = win.getComputedStyle(cur);
    const clip = cs.getPropertyValue('background-clip') || cs.getPropertyValue('-webkit-background-clip');
    if (clip === 'text') {
      const layer = splitTop(cs.backgroundImage, ',')[0];
      const r = cur.getBoundingClientRect();
      const fill = layer ? parseGradient(layer, r.width, r.height, px(cs.fontSize)) : null;
      return fill ? { fill, box: r } : undefined;
    }
    if (cs.display !== 'inline') break;
  }
  return undefined;
}

export function runStyle(el: Element, cs: CSSStyleDeclaration, win: Window, text: string): TextRun {
  const deco = cs.textDecorationLine || cs.getPropertyValue('text-decoration-line');
  const color = parseColor(cs.color) ?? { r: 0, g: 0, b: 0, a: 1 };
  const fillColor = parseColor(cs.getPropertyValue('-webkit-text-fill-color'));
  const gradient = (fillColor && fillColor.a === 0) || color.a === 0 ? clipGradient(el, win) : undefined;
  const anchor = el.closest('a');
  return {
    text,
    fontFamily: cs.fontFamily,
    fontWeight: parseInt(cs.fontWeight, 10) || 400,
    italic: cs.fontStyle !== 'normal',
    fontSize: px(cs.fontSize) || 16,
    lineHeight: cs.lineHeight === 'normal' ? null : px(cs.lineHeight),
    letterSpacing: cs.letterSpacing === 'normal' ? 0 : px(cs.letterSpacing),
    color: gradient ? undefined : fillColor && fillColor.a > 0 ? fillColor : color,
    gradient: gradient?.fill,
    gradientBox: gradient ? { x: gradient.box.left, y: gradient.box.top, width: gradient.box.width, height: gradient.box.height } : undefined,
    decoration: deco.includes('underline') ? 'UNDERLINE' : deco.includes('line-through') ? 'STRIKETHROUGH' : 'NONE',
    textCase: TEXT_CASE[cs.textTransform] ?? 'ORIGINAL',
    href: anchor?.href || undefined,
  };
}

interface RawRun {
  run: TextRun;
  keepsSpace: boolean;
}

// Collects text under `root` in document order. `include` decides which elements are descended into.
export function collectRuns(root: Node, win: Window, include: (el: Element) => boolean): TextRun[] {
  const raw: RawRun[] = [];
  const visit = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const parent = node.parentElement!;
      const cs = win.getComputedStyle(parent);
      if (cs.visibility !== 'visible') return;
      const text = collapse(node.nodeValue ?? '', cs.whiteSpace);
      if (text) raw.push({ run: runStyle(parent, cs, win, text), keepsSpace: preserves(cs.whiteSpace) });
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as Element;
    if (el.localName === 'br') {
      const cs = win.getComputedStyle(el.parentElement ?? el);
      raw.push({ run: runStyle(el.parentElement ?? el, cs, win, '\n'), keepsSpace: true });
      return;
    }
    if (!include(el)) return;
    for (const child of Array.from(el.childNodes)) visit(child);
  };
  if (root.nodeType === Node.TEXT_NODE) visit(root);
  else for (const child of Array.from(root.childNodes)) visit(child);

  // Cross-run whitespace collapsing, the way inline formatting joins adjacent text.
  let prevEndsBlank = true;
  for (const r of raw) {
    if (!r.keepsSpace) {
      if (prevEndsBlank) r.run.text = r.run.text.replace(/^ +/, '');
      r.run.text = r.run.text.replace(/ +\n/g, '\n');
    }
    if (r.run.text) prevEndsBlank = /[ \n]$/.test(r.run.text);
  }
  for (let i = raw.length - 1; i >= 0; i--) {
    if (raw[i].keepsSpace) break;
    raw[i].run.text = raw[i].run.text.replace(/[ \n]+$/, '');
    if (raw[i].run.text) break;
  }
  const runs = raw.map((r) => r.run).filter((r) => r.text.length > 0);
  // Adjacent runs with identical styling merge, which keeps Figma's range calls small.
  const merged: TextRun[] = [];
  for (const run of runs) {
    const last = merged[merged.length - 1];
    if (last && sameStyle(last, run)) last.text += run.text;
    else merged.push({ ...run });
  }
  return merged;
}

function sameStyle(a: TextRun, b: TextRun): boolean {
  return (
    a.fontFamily === b.fontFamily && a.fontWeight === b.fontWeight && a.italic === b.italic &&
    a.fontSize === b.fontSize && a.lineHeight === b.lineHeight && a.letterSpacing === b.letterSpacing &&
    a.decoration === b.decoration && a.textCase === b.textCase && a.href === b.href &&
    JSON.stringify(a.color) === JSON.stringify(b.color) && JSON.stringify(a.gradient) === JSON.stringify(b.gradient)
  );
}

// Rendered line boxes for a node's text, clustered by vertical position.
export function lineBoxes(node: Node, doc: Document): LineBox[] {
  const range = doc.createRange();
  range.selectNodeContents(node);
  const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0.5 && r.height > 0.5);
  const lines: LineBox[] = [];
  for (const r of rects.sort((a, b) => a.top + a.height / 2 - (b.top + b.height / 2))) {
    const center = r.top + r.height / 2;
    const line = lines.find((l) => Math.abs(l.center - center) < Math.max(2, (r.height / 2) * 0.8) || (center > l.top && center < l.bottom && r.top < l.center));
    if (line) {
      line.left = Math.min(line.left, r.left);
      line.right = Math.max(line.right, r.right);
      line.top = Math.min(line.top, r.top);
      line.bottom = Math.max(line.bottom, r.bottom);
    } else {
      lines.push({ left: r.left, right: r.right, top: r.top, bottom: r.bottom, center });
    }
  }
  return lines.sort((a, b) => a.top - b.top);
}

// Splits a wrapped text node into one detached text node per rendered line, each with its line box.
export function lineSlices(node: Text, doc: Document): { text: Node; lines: LineBox[] }[] {
  const raw = node.nodeValue ?? '';
  const range = doc.createRange();
  const slices: { start: number; end: number; box: LineBox }[] = [];
  let i = 0;
  while (i < raw.length) {
    const cp = raw.codePointAt(i)!;
    const len = cp > 0xffff ? 2 : 1;
    range.setStart(node, i);
    range.setEnd(node, i + len);
    const r = Array.from(range.getClientRects()).find((rect) => rect.width > 0 || rect.height > 0);
    const last = slices[slices.length - 1];
    if (r && r.width > 0) {
      const center = r.top + r.height / 2;
      if (last && center >= last.box.top && center <= last.box.bottom) {
        last.end = i + len;
        last.box.left = Math.min(last.box.left, r.left);
        last.box.right = Math.max(last.box.right, r.right);
      } else {
        slices.push({ start: i, end: i + len, box: { left: r.left, right: r.right, top: r.top, bottom: r.bottom, center } });
      }
    } else if (last) {
      last.end = i + len; // collapsed or trailing whitespace stays with the current line
    }
    i += len;
  }
  const parent = node.parentNode!;
  return slices.map((s) => {
    const piece = doc.createTextNode(raw.slice(s.start, s.end));
    // collectRuns reads styles from the parent element; a detached proxy keeps that lookup working.
    Object.defineProperty(piece, 'parentElement', { value: parent });
    return { text: piece, lines: [s.box] };
  });
}

const ICON_FONT = /awesome|\bfa[srbld]?\b|bootstrap-icons|material (icons|symbols)|phosphor|lucide|remixicon|ionicons|feather|icomoon|glyphicons|boxicons|tabler|iconfont|dashicons|codicon|icofont|themify|simple-line-icons|linearicons|la-|line awesome/i;

function isPrivateUse(text: string): boolean {
  const chars = Array.from(text.trim());
  if (!chars.length) return false;
  return chars.every((ch) => {
    const cp = ch.codePointAt(0)!;
    return (cp >= 0xe000 && cp <= 0xf8ff) || cp >= 0xf0000;
  });
}

export function isIconText(text: string, cs: CSSStyleDeclaration): boolean {
  const t = text.trim();
  if (!t) return false;
  if (isPrivateUse(t)) return true;
  // Ligature fonts (Material Symbols) render words like "home" as a glyph.
  return ICON_FONT.test(cs.fontFamily) && t.length < 40 && !/\s{2,}/.test(t);
}

// Icon fonts are drawn on a canvas inside the rendered page (where the webfont is loaded) and
// imported as a crisp 4× bitmap at the glyph's rendered box.
export async function rasterizeIcon(
  text: string, cs: CSSStyleDeclaration, box: { width: number; height: number }, doc: Document,
): Promise<Uint8Array | null> {
  const scale = 4;
  const canvas = doc.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(box.width * scale));
  canvas.height = Math.max(1, Math.ceil(box.height * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const fontSize = px(cs.fontSize) * scale;
  ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${fontSize}px ${cs.fontFamily}`;
  ctx.fillStyle = cs.color;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'center';
  const m = ctx.measureText(text.trim());
  const ascent = m.fontBoundingBoxAscent ?? fontSize * 0.8;
  const descent = m.fontBoundingBoxDescent ?? fontSize * 0.2;
  const baseline = (canvas.height - (ascent + descent)) / 2 + ascent;
  ctx.fillText(text.trim(), canvas.width / 2, baseline);
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'));
  return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
}
