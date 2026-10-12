import type {
  AutoLayout, BoxStyle, Fill, FontRequest, FrameData, ImageData, ImportDocument, NodeData, SvgData, TextData,
} from '../../shared/types';
import { blendMode, parseBorder, parseFilter, parseRadius, parseShadows } from './box';
import { lengthOrPercent, parseColor, px, splitTop, visible } from './css';
import { parseGradient, remapGradient } from './gradient';
import { ImageRegistry } from './images';
import { serializeSvg, svgFromMarkup } from './svg';
import { collectRuns, isIconText, lineBoxes, lineSlices, rasterizeIcon, runStyle } from './text';
import { fetchText } from '../net';

export interface ExtractOptions {
  autoLayout: boolean;
  includeImages: boolean;
  proxy: string;
  hideOverlays?: boolean;
}

interface Ctx {
  win: Window;
  doc: Document;
  opts: ExtractOptions;
  images: ImageRegistry;
  fonts: Map<string, FontRequest>;
  inlineCache: WeakMap<Element, boolean>;
  count: number;
  propagatedBody: boolean;
  onProgress: (count: number) => void;
}

interface Origin {
  x: number;
  y: number;
}

interface Entry {
  node: NodeData;
  el: Element | null;
  cs: CSSStyleDeclaration | null;
  z: number;
  order: number;
}

const SKIP = new Set([
  'script', 'style', 'link', 'meta', 'head', 'noscript', 'template', 'title', 'base', 'param', 'source', 'track',
  'datalist', 'h2f-hidden',
]);
const REPLACED = new Set(['img', 'svg', 'canvas', 'video', 'iframe', 'input', 'textarea', 'select', 'object', 'embed', 'picture']);

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

// Layer names a designer would give: what the element is for, not its generated class names.
const LANDMARKS: Record<string, string> = {
  header: 'Header', nav: 'Navigation', footer: 'Footer', main: 'Main', aside: 'Sidebar', form: 'Form',
  button: 'Button', a: 'Link', ul: 'List', ol: 'List', li: 'List item', table: 'Table', figure: 'Figure',
  img: 'Image', picture: 'Image', svg: 'Icon', video: 'Video', canvas: 'Canvas', iframe: 'Embed',
  input: 'Input', textarea: 'Text area', select: 'Select', label: 'Label', blockquote: 'Quote', dialog: 'Dialog',
  details: 'Details', summary: 'Summary', hr: 'Divider', body: 'Page',
  h1: 'Heading', h2: 'Heading', h3: 'Heading', h4: 'Heading', h5: 'Heading', h6: 'Heading', p: 'Paragraph',
};
const ROLES: Record<string, string> = {
  banner: 'Header', navigation: 'Navigation', contentinfo: 'Footer', dialog: 'Dialog', alertdialog: 'Dialog',
  button: 'Button', link: 'Link', tablist: 'Tabs', tab: 'Tab', tabpanel: 'Tab panel', menu: 'Menu', list: 'List',
  listitem: 'List item', search: 'Search', img: 'Image', progressbar: 'Progress', switch: 'Switch', checkbox: 'Checkbox',
};

function sentence(words: string): string {
  const s = words.replace(/[-_]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\s+/g, ' ').trim().toLowerCase();
  return s ? s[0].toUpperCase() + s.slice(1) : '';
}

// A class or id worth showing: written by a person (card, price-tag), not generated (css-module
// hashes) or a utility (Tailwind's flex, p-4, md:grid).
function readableToken(token: string): string {
  if (!token || token.length < 3 || token.length > 40 || /[:[\]/.!#%]|__|--/.test(token)) return '';
  if (/^(no|print|screen|only|disp|display|visually|visible|show|hide|active|open|closed|selected|current|light|dark|mobile|desktop|tablet|small|large|medium|lg|md|sm|xl|xs)([-_]|$)/i.test(token) || /[-_](only|print|hidden|visible)$/i.test(token)) return '';
  if (/\d/.test(token.replace(/^h[1-6]$/, '')) && !/^[a-z]+-?[1-6]$/i.test(token)) return '';
  if (/^(flex|grid|block|inline|hidden|relative|absolute|fixed|sticky|static|container|row|col|clearfix|wrapper|inner|outer|content|js|is|has|u|d|w|h|p[xytrbl]?|m[xytrbl]?|text|font|bg|border|rounded|shadow|gap|space|items|justify|self|place|order|z|top|left|right|bottom|inset|overflow|opacity|transition|duration|ease|transform|translate|scale|rotate|cursor|select|pointer|sr|not|group|peer|dark|max|min|leading|tracking|align|whitespace|break|truncate|underline|uppercase|lowercase|capitalize|italic|antialiased|ring|outline|fill|stroke|object|aspect|columns|float|clear|isolate|mix|blur|backdrop|filter|list|appearance|resize|snap|scroll|touch|will|content|basis|grow|shrink|tw|css|sc|jsx|svelte|ng|ember|v)(-|$)/i.test(token)) return '';
  // A short namespace prefix (gh-, c-, o-) adds nothing to the name.
  const parts = token.split(/[-_]/);
  if (parts.length > 1 && parts[0].length <= 3) parts.shift();
  return sentence(parts.join(' '));
}

function nameOf(el: Element, cs?: CSSStyleDeclaration): string {
  const tag = el.localName;
  if (tag === 'h2f-pseudo') return el.getAttribute('data-which') ?? 'pseudo';
  const clip = (s: string) => (s.length > 48 ? s.slice(0, 47).trimEnd() + '…' : s);
  const aria = (el.getAttribute('aria-label') ?? '').trim();
  const role = el.getAttribute('role') ?? '';
  const kind = ROLES[role] ?? LANDMARKS[tag] ?? '';
  if (aria) return clip(kind && !aria.toLowerCase().includes(kind.toLowerCase()) ? `${kind} · ${aria}` : sentence(aria) || aria);
  if (tag === 'img') return clip(sentence(el.getAttribute('alt') ?? '') || 'Image');
  const own = readableToken(el.id) || (typeof el.className === 'string' ? el.className.trim().split(/\s+/).map(readableToken).find(Boolean) : '') || '';
  if (kind === 'Button' || kind === 'Link') {
    // innerText keeps the line breaks between blocks; the first line is the label.
    const raw = (el as HTMLElement).innerText ?? el.textContent ?? '';
    const text = (raw.split('\n').find((l) => l.trim()) ?? '').replace(/\s+/g, ' ').trim();
    if (text) return clip(`${kind} · ${text}`);
  }
  if ((tag === 'section' || tag === 'article') && !own) {
    const heading = el.querySelector('h1,h2,h3,h4,h5,h6')?.textContent?.replace(/\s+/g, ' ').trim();
    if (heading) return clip(`Section · ${heading}`);
  }
  if (own && kind && kind.toLowerCase().startsWith(own.toLowerCase())) return kind;
  if (own) return clip(kind && kind !== 'Page' ? `${kind} · ${own}` : own);
  if (kind) return kind;
  if (cs) {
    if (/grid/.test(cs.display)) return 'Grid';
    if (/flex/.test(cs.display)) return cs.flexDirection.startsWith('column') ? 'Column' : 'Row';
  }
  return tag === 'section' || tag === 'article' ? 'Section' : 'Frame';
}

// Pop-ups that float over the page (cookie banners, newsletter and chat prompts, modals) belong to
// the visit, not the design.
const OVERLAY_WORDS = /cookie|consent|gdpr|ccpa|onetrust|cookiebot|didomi|usercentrics|privacy-?banner|newsletter|subscribe|popup|pop-up|modal|overlay|lightbox|chat|intercom|drift|crisp|hubspot|zendesk|tawk|toast|snackbar|notification/i;

function isOverlay(el: Element, cs: CSSStyleDeclaration, win: Window): boolean {
  if (cs.position !== 'fixed' && !(el.localName === 'dialog' && el.hasAttribute('open'))) return false;
  const role = el.getAttribute('role') ?? '';
  if (el.localName === 'header' || el.localName === 'nav' || role === 'banner' || role === 'navigation') return false;
  if (el.localName === 'dialog' || role === 'dialog' || role === 'alertdialog' || el.getAttribute('aria-modal') === 'true') return true;
  const words = `${el.id} ${typeof el.className === 'string' ? el.className : ''} ${el.getAttribute('aria-label') ?? ''}`;
  if (OVERLAY_WORDS.test(words)) return true;
  // A dimmed backdrop covering the window.
  const r = el.getBoundingClientRect();
  const bg = parseColor(cs.backgroundColor);
  return r.width >= win.innerWidth * 0.9 && r.height >= win.innerHeight * 0.9 && !!bg && bg.a > 0.05 && bg.a < 0.95;
}

function hasBackground(cs: CSSStyleDeclaration): boolean {
  return visible(parseColor(cs.backgroundColor)) || (cs.backgroundImage !== 'none' && cs.backgroundImage !== '');
}

function clipsBackgroundToText(cs: CSSStyleDeclaration): boolean {
  return (cs.getPropertyValue('background-clip') || cs.getPropertyValue('-webkit-background-clip')) === 'text';
}

function hasBox(cs: CSSStyleDeclaration): boolean {
  // A background clipped to the glyphs is a text fill, not a box.
  if (hasBackground(cs) && !clipsBackgroundToText(cs)) return true;
  if (cs.boxShadow !== 'none') return true;
  const b = ['Top', 'Right', 'Bottom', 'Left'].some(
    (s) => cs.getPropertyValue(`border-${s.toLowerCase()}-style`) !== 'none' && px(cs.getPropertyValue(`border-${s.toLowerCase()}-width`)) > 0,
  );
  return b || (cs.backdropFilter !== 'none' && !!cs.backdropFilter);
}

function clips(cs: CSSStyleDeclaration): boolean {
  return [cs.overflowX, cs.overflowY].some((o) => o === 'hidden' || o === 'clip' || o === 'auto' || o === 'scroll');
}

function trackFont(ctx: Ctx, family: string, weight: number, italic: boolean): void {
  const key = `${family}|${weight}|${italic}`;
  if (!ctx.fonts.has(key)) ctx.fonts.set(key, { family, weight, italic });
}

// An inline element that can live inside one Figma text node: no box of its own, nothing replaced inside.
function isMergeable(el: Element, ctx: Ctx): boolean {
  const cached = ctx.inlineCache.get(el);
  if (cached !== undefined) return cached;
  let ok = false;
  if (el.localName === 'br') ok = true;
  else if (!REPLACED.has(el.localName) && !SKIP.has(el.localName)) {
    const cs = ctx.win.getComputedStyle(el);
    ok =
      cs.display === 'inline' &&
      cs.position === 'static' &&
      !hasBox(cs) &&
      px(cs.paddingLeft) + px(cs.paddingRight) + px(cs.marginLeft) + px(cs.marginRight) < 1 &&
      cs.transform === 'none' &&
      parseFloat(cs.opacity) === 1 &&
      Array.from(el.children).every((c) => isMergeable(c, ctx)) &&
      !Array.from(el.childNodes).some((n) => n.nodeType === Node.TEXT_NODE && isIconText(n.nodeValue ?? '', cs));
  }
  ctx.inlineCache.set(el, ok);
  return ok;
}

function isTextBlock(el: Element, ctx: Ctx): boolean {
  let hasText = false;
  for (const n of Array.from(el.childNodes)) {
    if (n.nodeType === Node.TEXT_NODE) {
      if ((n.nodeValue ?? '').trim()) hasText = true;
    } else if (n.nodeType === Node.ELEMENT_NODE) {
      const child = n as Element;
      if (SKIP.has(child.localName)) continue;
      if (!isMergeable(child, ctx)) return false;
      if ((child.textContent ?? '').trim()) hasText = true;
    }
  }
  return hasText;
}

// Screen-reader-only content (sr-only, visually-hidden) is clipped to nothing in the browser.
function visuallyHidden(el: Element, cs: CSSStyleDeclaration): boolean {
  if (/inset\(\s*50%|inset\(100%/.test(cs.clipPath) || /rect\(0(px)?,?\s*0(px)?,?\s*0(px)?,?\s*0(px)?\)/.test(cs.clip)) return true;
  if (cs.position !== 'absolute' || !clips(cs)) return false;
  const r = el.getBoundingClientRect();
  return r.width <= 1.01 && r.height <= 1.01;
}

function zKey(cs: CSSStyleDeclaration | null, parentCs: CSSStyleDeclaration | null): number {
  if (!cs) return 1;
  const positioned = cs.position !== 'static';
  const flexItem = !!parentCs && /flex|grid/.test(parentCs.display);
  const z = cs.zIndex === 'auto' ? null : parseInt(cs.zIndex, 10);
  if ((positioned || flexItem) && z !== null && z < 0) return -1000 + z;
  if (positioned || (flexItem && z !== null)) return 2 + Math.max(0, z ?? 0);
  return 1;
}

async function boxStyle(el: Element, cs: CSSStyleDeclaration, w: number, h: number, ctx: Ctx, extra: NodeData[]): Promise<BoxStyle> {
  const fontSize = px(cs.fontSize);
  const fills: Fill[] = [];
  const skipBg = ctx.propagatedBody && el === ctx.doc.body;
  const clipText = clipsBackgroundToText(cs);
  if (!skipBg && !clipText) {
    const bg = parseColor(cs.backgroundColor);
    if (visible(bg)) fills.push({ kind: 'solid', color: bg });
    const layers = cs.backgroundImage === 'none' ? [] : splitTop(cs.backgroundImage, ',');
    const sizes = splitTop(cs.backgroundSize, ',');
    const positions = splitTop(cs.backgroundPosition, ',');
    const repeats = splitTop(cs.backgroundRepeat, ',');
    // CSS lists the top layer first; Figma stacks fills bottom-up.
    for (let i = layers.length - 1; i >= 0; i--) {
      const layer = layers[i];
      if (layer.startsWith('url(')) {
        if (!ctx.opts.includeImages) continue;
        const url = layer.slice(4, -1).trim().replace(/^["']|["']$/g, '');
        const fill = await backgroundImageFill(url, w, h, sizes[i % sizes.length] ?? 'auto', positions[i % positions.length] ?? '0% 0%', repeats[i % repeats.length] ?? 'repeat', fontSize, ctx, extra, el);
        if (fill) fills.push(fill);
      } else {
        const g = parseGradient(layer, w, h, fontSize);
        if (g) fills.push(g);
      }
    }
  }
  const filter = parseFilter(cs.filter);
  const backdrop = parseFilter(cs.backdropFilter || cs.getPropertyValue('-webkit-backdrop-filter'));
  const opacity = parseFloat(cs.opacity) * filter.opacity;
  const style: BoxStyle = {
    fills,
    border: parseBorder(cs),
    radius: parseRadius(cs, w, h),
    shadows: [...parseShadows(cs.boxShadow), ...filter.shadows],
    layerBlur: filter.blur,
    backgroundBlur: backdrop.blur,
    opacity: opacity < 1 ? opacity : undefined,
    blendMode: blendMode(cs.mixBlendMode),
    clips: clips(cs),
  };
  if (!style.shadows!.length) delete style.shadows;
  return style;
}

type Matrix = [[number, number, number], [number, number, number]];

// Maps the layer's unit square onto the visible part of an image drawn at (ix, iy, iw, ih).
function cropTransform(ix: number, iy: number, iw: number, ih: number, cx: number, cy: number, cw: number, ch: number): Matrix {
  return [
    [cw / iw, 0, (cx - ix) / iw],
    [0, ch / ih, (cy - iy) / ih],
  ];
}

async function backgroundImageFill(
  url: string, w: number, h: number, size: string, position: string, repeat: string, fontSize: number,
  ctx: Ctx, extra: NodeData[], el: Element,
): Promise<Fill | null> {
  const natural = await ctx.images.sizeOf(url);
  if (!natural) return null;
  const id = ctx.images.register(url);
  let iw = natural.w;
  let ih = natural.h;
  if (size === 'cover' || size === 'contain') {
    const s = size === 'cover' ? Math.max(w / natural.w, h / natural.h) : Math.min(w / natural.w, h / natural.h);
    iw = natural.w * s;
    ih = natural.h * s;
  } else {
    const [sw = 'auto', sh = 'auto'] = size.split(/\s+/);
    const W = sw === 'auto' ? null : lengthOrPercent(sw, w, fontSize);
    const H = sh === 'auto' ? null : lengthOrPercent(sh, h, fontSize);
    if (W !== null && H !== null) [iw, ih] = [W, H];
    else if (W !== null) [iw, ih] = [W, (W / natural.w) * natural.h];
    else if (H !== null) [iw, ih] = [(H / natural.h) * natural.w, H];
  }
  const [px0 = '0%', py0 = '0%'] = position.split(/\s+/);
  const pos = (t: string, free: number) => (t.endsWith('%') ? (parseFloat(t) / 100) * free : lengthOrPercent(t, free, fontSize) ?? 0);
  const ix = pos(px0, w - iw);
  const iy = pos(py0, h - ih);
  const tiles = !/^no-repeat( no-repeat)?$/.test(repeat) && (iw < w - 0.5 || ih < h - 0.5);
  if (tiles) return { kind: 'image', imageId: id, scaleMode: 'TILE', scalingFactor: iw / natural.w };
  if (ix <= 0.5 && iy <= 0.5 && ix + iw >= w - 0.5 && iy + ih >= h - 0.5) {
    if (size === 'cover' && Math.abs(ix - (w - iw) / 2) < 1 && Math.abs(iy - (h - ih) / 2) < 1) {
      return { kind: 'image', imageId: id, scaleMode: 'FILL' };
    }
    return { kind: 'image', imageId: id, scaleMode: 'CROP', transform: cropTransform(ix, iy, iw, ih, 0, 0, w, h) };
  }
  if (size === 'contain' && Math.abs(ix - (w - iw) / 2) < 1 && Math.abs(iy - (h - ih) / 2) < 1) {
    return { kind: 'image', imageId: id, scaleMode: 'FIT' };
  }
  // A smaller, non-repeating image becomes its own layer, clipped to the box.
  const cx = Math.max(0, ix);
  const cy = Math.max(0, iy);
  const cw = Math.min(w, ix + iw) - cx;
  const ch = Math.min(h, iy + ih) - cy;
  if (cw > 0 && ch > 0) {
    extra.push({
      type: 'IMAGE',
      name: `${el.localName} background`,
      x: round(cx), y: round(cy), width: round(cw), height: round(ch),
      style: { fills: [{ kind: 'image', imageId: id, scaleMode: 'CROP', transform: cropTransform(ix, iy, iw, ih, cx, cy, cw, ch) }] },
      childLayout: { absolute: true },
    });
  }
  return null;
}

function objectFitFill(id: string, cs: CSSStyleDeclaration, w: number, h: number, nw: number, nh: number): Fill {
  const fit = cs.objectFit;
  const [opx = '50%', opy = '50%'] = cs.objectPosition.split(/\s+/);
  const centered = opx === '50%' && opy === '50%';
  if (fit === 'cover') {
    if (centered) return { kind: 'image', imageId: id, scaleMode: 'FILL' };
    const s = Math.max(w / nw, h / nh);
    const iw = nw * s;
    const ih = nh * s;
    const ix = (lengthOrPercent(opx, w - iw) ?? 0);
    const iy = (lengthOrPercent(opy, h - ih) ?? 0);
    return { kind: 'image', imageId: id, scaleMode: 'CROP', transform: cropTransform(ix, iy, iw, ih, 0, 0, w, h) };
  }
  if (fit === 'contain' || fit === 'scale-down') return { kind: 'image', imageId: id, scaleMode: 'FIT' };
  if (fit === 'none' && nw >= w && nh >= h) {
    const ix = lengthOrPercent(opx, w - nw) ?? 0;
    const iy = lengthOrPercent(opy, h - nh) ?? 0;
    return { kind: 'image', imageId: id, scaleMode: 'CROP', transform: cropTransform(ix, iy, nw, nh, 0, 0, w, h) };
  }
  if (fit === 'none') return { kind: 'image', imageId: id, scaleMode: 'FIT' };
  return { kind: 'image', imageId: id, scaleMode: 'CROP', transform: [[1, 0, 0], [0, 1, 0]] };
}

function contentBox(cs: CSSStyleDeclaration, rect: DOMRect) {
  const l = px(cs.borderLeftWidth) + px(cs.paddingLeft);
  const t = px(cs.borderTopWidth) + px(cs.paddingTop);
  const r = px(cs.borderRightWidth) + px(cs.paddingRight);
  const b = px(cs.borderBottomWidth) + px(cs.paddingBottom);
  return { left: rect.left + l, top: rect.top + t, width: Math.max(0, rect.width - l - r), height: Math.max(0, rect.height - t - b) };
}

function makeText(
  runs: TextData['runs'], lines: { left: number; right: number; top: number; bottom: number; center: number }[],
  cs: CSSStyleDeclaration, origin: Origin, ctx: Ctx, name?: string, block?: { left: number; width: number },
): TextData | null {
  if (!runs.length || !lines.length) return null;
  for (const r of runs) trackFont(ctx, r.fontFamily, r.fontWeight, r.italic);
  const lh = cs.lineHeight === 'normal' ? null : px(cs.lineHeight);
  const first = lines[0];
  const last = lines[lines.length - 1];
  const singleLine = lines.length === 1 && !runs.some((r) => r.text.includes('\n'));
  const lineH = lh ?? first.bottom - first.top;
  const top = first.center - lineH / 2;
  const bottom = last.center + (lh ?? last.bottom - last.top) / 2;
  const align: TextData['align'] =
    cs.textAlign === 'center' ? 'CENTER'
    : cs.textAlign === 'right' || cs.textAlign === 'end' ? 'RIGHT'
    : cs.textAlign === 'justify' ? 'JUSTIFIED'
    : 'LEFT';
  let left = Math.min(...lines.map((l) => l.left));
  let width = Math.max(...lines.map((l) => l.right)) - left;
  if (!singleLine && block) {
    left = block.left;
    width = block.width;
  }
  const box = { x: left, y: top, width, height: bottom - top };
  for (const r of runs) {
    if (r.gradient && r.gradientBox) r.gradient = remapGradient(r.gradient, r.gradientBox, box);
    delete r.gradientBox;
  }
  const textShadows = parseShadows(cs.textShadow, false).map((s) => ({ ...s, spread: 0 }));
  return {
    type: 'TEXT',
    name: name ?? runs.map((r) => r.text).join('').slice(0, 40),
    x: round(left - origin.x),
    y: round(top - origin.y),
    width: round(width),
    height: round(bottom - top),
    runs,
    align: singleLine ? (align === 'JUSTIFIED' ? 'LEFT' : align) : align,
    singleLine,
    shadows: textShadows.length ? textShadows : undefined,
  };
}

const ICON_CLASS = /^(fa|bi|ti|ri|bx|icon|ph|lucide|las|lab|la)-(?!solid$|regular$|brands$|light$|thin$|duotone$|sharp$|fw$|lg$|xl$|xs$|sm$|\dx$|spin$|pulse$|border$|inverse$|stack)[a-z0-9-]+$/;

// Icon layers are named after the icon class (fa-house, bi-alarm) or the ligature text (Material).
function iconName(text: string, from: Element | null): string {
  for (let el = from; el && el.localName !== 'body'; el = el.parentElement) {
    const hit = Array.from(el.classList).find((c) => ICON_CLASS.test(c));
    if (hit) return hit;
  }
  const t = text.trim();
  return /^[\w-]+$/.test(t) ? t : 'icon';
}

async function iconImage(text: string, cs: CSSStyleDeclaration, lines: ReturnType<typeof lineBoxes>, origin: Origin, ctx: Ctx, from: Element | null = null): Promise<ImageData | null> {
  if (!lines.length) return null;
  const l = lines[0];
  const box = { width: l.right - l.left, height: l.bottom - l.top };
  const bytes = await rasterizeIcon(text, cs, box, ctx.doc);
  if (!bytes) return null;
  const id = ctx.images.addBytes(bytes);
  return {
    type: 'IMAGE',
    name: iconName(text, from),
    x: round(l.left - origin.x), y: round(l.top - origin.y), width: round(box.width), height: round(box.height),
    style: { fills: [{ kind: 'image', imageId: id, scaleMode: 'FIT' }] },
  };
}

const MARKERS: Record<string, (n: number) => string> = {
  disc: () => '•', circle: () => '◦', square: () => '▪',
  decimal: (n) => `${n}.`,
  'decimal-leading-zero': (n) => `${n < 10 ? '0' : ''}${n}.`,
  'lower-alpha': (n) => `${String.fromCharCode(96 + ((n - 1) % 26) + 1)}.`,
  'lower-latin': (n) => `${String.fromCharCode(96 + ((n - 1) % 26) + 1)}.`,
  'upper-alpha': (n) => `${String.fromCharCode(64 + ((n - 1) % 26) + 1)}.`,
  'upper-latin': (n) => `${String.fromCharCode(64 + ((n - 1) % 26) + 1)}.`,
  'lower-roman': (n) => roman(n).toLowerCase() + '.',
  'upper-roman': (n) => roman(n) + '.',
};

function roman(n: number): string {
  const map: [number, string][] = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
  let out = '';
  for (const [v, s] of map) while (n >= v) { out += s; n -= v; }
  return out;
}

// Markers are not in the DOM. Their width is read from the page by briefly switching the item to
// list-style-position: inside and measuring how far the first line moves.
function markerWidth(el: Element, cs: CSSStyleDeclaration, ctx: Ctx): number | null {
  if (cs.listStylePosition === 'inside') return 0;
  const html = el as HTMLElement;
  const before = lineBoxes(el, ctx.doc)[0];
  if (!before) return null;
  const prev = html.style.getPropertyValue('list-style-position');
  const prevPriority = html.style.getPropertyPriority('list-style-position');
  html.style.setProperty('list-style-position', 'inside', 'important');
  const after = lineBoxes(el, ctx.doc)[0];
  html.style.setProperty('list-style-position', prev, prevPriority);
  if (!after || Math.abs(after.top - before.top) > 1) return null;
  const w = after.left - before.left;
  return w > 0 ? w : null;
}

const SYMBOLS = new Set(['disc', 'circle', 'square']);

function listMarker(el: Element, cs: CSSStyleDeclaration, rect: DOMRect, origin: Origin, ctx: Ctx): NodeData | null {
  if (cs.display !== 'list-item' || cs.listStyleType === 'none' || cs.listStyleImage !== 'none') return null;
  const parent = el.parentElement;
  let n = parent?.localName === 'ol' ? parseInt(parent.getAttribute('start') ?? '1', 10) || 1 : 1;
  for (let sib = parent?.firstElementChild; sib && sib !== el; sib = sib.nextElementSibling) {
    if (ctx.win.getComputedStyle(sib).display === 'list-item') n++;
  }
  const value = el.getAttribute('value');
  if (value && !Number.isNaN(parseInt(value, 10))) n = parseInt(value, 10);
  const markerCs = ctx.win.getComputedStyle(el, '::marker');
  const color = parseColor(markerCs.color) ?? parseColor(cs.color) ?? { r: 0, g: 0, b: 0, a: 1 };
  const fontSize = px(cs.fontSize);
  const canvas = ctx.doc.createElement('canvas').getContext('2d')!;
  canvas.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  const metrics = canvas.measureText('x');
  const ascent = metrics.fontBoundingBoxAscent ?? fontSize * 0.9;
  const lines = lineBoxes(el, ctx.doc);
  const lh = cs.lineHeight === 'normal' ? fontSize * 1.2 : px(cs.lineHeight);
  const cb = contentBox(cs, rect);
  const first = lines[0];
  const baseline = first ? first.top + ascent : cb.top + (lh - fontSize) / 2 + ascent;
  const type = cs.listStyleType;
  const measured = SYMBOLS.has(type) ? null : markerWidth(el, cs, ctx);

  if (SYMBOLS.has(type)) {
    // Measured from Chrome: the symbol is round(ascent / 3) wide, ends size + 7px before the text,
    // and is centred one symbol-height above the baseline.
    const size = Math.max(2, Math.round(ascent / 3));
    const right = cs.listStylePosition === 'inside' ? cb.left + size : cb.left - size - 7;
    const left = right - size;
    const cy = baseline - size;
    const fill = `rgba(${Math.round(color.r * 255)},${Math.round(color.g * 255)},${Math.round(color.b * 255)},${color.a})`;
    const shape =
      type === 'square' ? `<rect width="${size}" height="${size}" fill="${fill}"/>`
      : type === 'circle' ? `<circle cx="${size / 2}" cy="${size / 2}" r="${size / 2 - 0.5}" fill="none" stroke="${fill}"/>`
      : `<circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="${fill}"/>`;
    return {
      type: 'SVG',
      name: 'list marker',
      x: round(left - origin.x),
      y: round(cy - size / 2 - origin.y),
      width: size,
      height: size,
      svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${shape}</svg>`,
      childLayout: { absolute: true },
    };
  }

  const label = (MARKERS[type] ?? MARKERS.decimal)(n);
  const run = runStyle(el, cs, ctx.win, label);
  run.color = color;
  run.gradient = undefined;
  run.gradientBox = undefined;
  run.decoration = 'NONE';
  const textWidth = canvas.measureText(label).width;
  const boxWidth = measured ?? textWidth + canvas.measureText(' ').width;
  const left = cs.listStylePosition === 'inside' ? cb.left : cb.left - boxWidth;
  const lineH = run.lineHeight ?? lh;
  const center = first ? first.center : cb.top + lh / 2;
  trackFont(ctx, run.fontFamily, run.fontWeight, run.italic);
  return {
    type: 'TEXT',
    name: 'list marker',
    x: round(left - origin.x),
    y: round(center - lineH / 2 - origin.y),
    width: round(textWidth),
    height: round(lineH),
    runs: [run],
    align: 'LEFT',
    singleLine: true,
    childLayout: { absolute: true },
  };
}

function formText(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, cs: CSSStyleDeclaration, rect: DOMRect, ctx: Ctx): TextData | null {
  let value = '';
  let placeholder = false;
  // The page lives in another window, so instanceof against this window's classes never matches.
  const tag = el.localName;
  if (tag === 'select') value = (el as HTMLSelectElement).selectedOptions[0]?.text ?? '';
  else {
    value = el.value;
    if (tag === 'input' && (el as HTMLInputElement).type === 'password') value = '•'.repeat(value.length);
    const hint = (el as HTMLInputElement | HTMLTextAreaElement).placeholder;
    if (!value && hint) {
      value = hint;
      placeholder = true;
    }
  }
  if (!value) return null;
  const run = runStyle(el, cs, ctx.win, value);
  if (placeholder) {
    const pc = parseColor(ctx.win.getComputedStyle(el, '::placeholder').color);
    if (pc) run.color = pc;
  }
  trackFont(ctx, run.fontFamily, run.fontWeight, run.italic);
  const cb = contentBox(cs, rect);
  const lh = run.lineHeight ?? run.fontSize * 1.2;
  const multi = tag === 'textarea';
  const isButton = tag === 'input' && /^(button|submit|reset)$/.test((el as HTMLInputElement).type);
  return {
    type: 'TEXT',
    name: placeholder ? 'placeholder' : 'value',
    x: round(cb.left - rect.left),
    y: round(multi ? cb.top - rect.top : cb.top - rect.top + Math.max(0, (cb.height - lh) / 2)),
    width: round(cb.width),
    height: round(multi ? cb.height : lh),
    runs: [run],
    align: isButton || cs.textAlign === 'center' ? 'CENTER' : cs.textAlign === 'right' ? 'RIGHT' : 'LEFT',
    singleLine: !multi,
  };
}

function controlSvg(el: HTMLInputElement, cs: CSSStyleDeclaration, w: number, h: number): string {
  const accent = cs.accentColor && cs.accentColor !== 'auto' ? cs.accentColor : '#0075ff';
  if (el.type === 'radio') {
    const r = Math.min(w, h) / 2;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><circle cx="${w / 2}" cy="${h / 2}" r="${r - 0.5}" fill="${el.checked ? accent : '#fff'}" stroke="${el.checked ? accent : '#767676'}"/>${el.checked ? `<circle cx="${w / 2}" cy="${h / 2}" r="${r * 0.4}" fill="#fff"/>` : ''}</svg>`;
  }
  if (el.type === 'range') {
    const min = parseFloat(el.min || '0');
    const max = parseFloat(el.max || '100');
    const t = (parseFloat(el.value) - min) / (max - min || 1);
    const cx = 8 + t * (w - 16);
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect x="0" y="${h / 2 - 2}" width="${w}" height="4" rx="2" fill="#efefef" stroke="#b2b2b2" stroke-width="0.5"/><rect x="0" y="${h / 2 - 2}" width="${cx}" height="4" rx="2" fill="${accent}"/><circle cx="${cx}" cy="${h / 2}" r="8" fill="${accent}"/></svg>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="2.5" fill="${el.checked ? accent : '#fff'}" stroke="${el.checked ? accent : '#767676'}"/>${el.checked ? `<path d="M${w * 0.22} ${h * 0.52} L${w * 0.42} ${h * 0.72} L${w * 0.78} ${h * 0.3}" fill="none" stroke="#fff" stroke-width="${Math.max(1.5, w / 8)}" stroke-linecap="round" stroke-linejoin="round"/>` : ''}</svg>`;
}

interface Geometry {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation?: number;
  origin: Origin; // where this element's children are measured from
  restore?: () => void;
}

// Rotated elements are measured untransformed so their children keep local coordinates; the rotation
// is reapplied on the Figma frame around the rendered center. Translate/scale keep the rendered box.
function geometry(el: Element, cs: CSSStyleDeclaration, origin: Origin): Geometry {
  const rect = el.getBoundingClientRect();
  const isHtml = el.namespaceURI === 'http://www.w3.org/1999/xhtml';
  const m = isHtml ? cs.transform.match(/^matrix\(([^)]+)\)$/) : null;
  if (m) {
    const [a, b] = m[1].split(',').map(parseFloat);
    const angle = (Math.atan2(b, a) * 180) / Math.PI;
    if (Math.abs(angle) > 0.01) {
      const target = el as HTMLElement;
      const prev = target.style.getPropertyValue('transform');
      const prevPriority = target.style.getPropertyPriority('transform');
      const prevTransition = target.style.getPropertyValue('transition');
      target.style.setProperty('transition', 'none', 'important');
      target.style.setProperty('transform', 'none', 'important');
      const flat = el.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      return {
        x: cx - flat.width / 2 - origin.x,
        y: cy - flat.height / 2 - origin.y,
        width: flat.width,
        height: flat.height,
        rotation: -angle,
        origin: { x: flat.left, y: flat.top },
        restore: () => {
          target.style.setProperty('transform', prev, prevPriority);
          target.style.setProperty('transition', prevTransition);
        },
      };
    }
  }
  return { x: rect.left - origin.x, y: rect.top - origin.y, width: rect.width, height: rect.height, origin: { x: rect.left, y: rect.top } };
}

async function replaced(el: Element, cs: CSSStyleDeclaration, g: Geometry, ctx: Ctx, opacity: number): Promise<NodeData | null> {
  const rect = el.getBoundingClientRect();
  const base = { name: nameOf(el, cs), x: round(g.x), y: round(g.y), width: round(g.width), height: round(g.height), rotation: g.rotation };
  const tag = el.localName;
  if (tag === 'svg') {
    try {
      const svg = serializeSvg(el as SVGSVGElement, g.width, g.height, ctx.win);
      return { ...base, type: 'SVG', svg, opacity: opacity < 1 ? opacity : undefined } as SvgData;
    } catch {
      return null;
    }
  }
  const extra: NodeData[] = [];
  const style = await boxStyle(el, cs, g.width, g.height, ctx, extra);
  if (tag === 'img' || tag === 'picture') {
    const img = (tag === 'picture' ? el.querySelector('img') : el) as HTMLImageElement | null;
    if (!img) return null;
    const src = img.currentSrc || img.src;
    if (ctx.opts.includeImages && src && img.naturalWidth > 0) {
      if (/\.svg(\?|#|$)/i.test(src) || src.startsWith('data:image/svg')) {
        try {
          const markup = await fetchText(src, ctx.opts.proxy);
          const cb = contentBox(cs, rect);
          const svg = svgFromMarkup(markup, cb.width, cb.height);
          if (svg && !style.fills.length && !style.border && !style.radius && !style.shadows) {
            return { ...base, type: 'SVG', svg, opacity: style.opacity } as SvgData;
          }
        } catch {
          // falls back to a bitmap below
        }
      }
      style.fills.push(objectFitFill(ctx.images.register(src), cs, g.width, g.height, img.naturalWidth, img.naturalHeight));
    }
    return { ...base, type: 'IMAGE', style } as ImageData;
  }
  if (tag === 'canvas') {
    try {
      const data = (el as HTMLCanvasElement).toDataURL('image/png');
      const bytes = Uint8Array.from(atob(data.split(',')[1]), (c) => c.charCodeAt(0));
      style.fills.push({ kind: 'image', imageId: ctx.images.addBytes(bytes), scaleMode: 'CROP', transform: [[1, 0, 0], [0, 1, 0]] });
    } catch {
      // tainted canvas: keep the box
    }
    return { ...base, type: 'IMAGE', style } as ImageData;
  }
  if (tag === 'video') {
    const video = el as HTMLVideoElement;
    if (ctx.opts.includeImages && video.poster) {
      const size = await ctx.images.sizeOf(video.poster);
      if (size) style.fills.push(objectFitFill(ctx.images.register(video.poster), cs, g.width, g.height, size.w, size.h));
    }
    if (!style.fills.length) style.fills.push({ kind: 'solid', color: { r: 0.07, g: 0.07, b: 0.08, a: 1 } });
    return { ...base, type: 'IMAGE', style } as ImageData;
  }
  if (tag === 'iframe' || tag === 'object' || tag === 'embed') {
    if (!style.fills.length) style.fills.push({ kind: 'solid', color: { r: 0.96, g: 0.96, b: 0.96, a: 1 } });
    return { ...base, type: 'FRAME', style, children: [] } as FrameData;
  }
  if (tag === 'input' || tag === 'textarea' || tag === 'select') {
    const input = el as HTMLInputElement;
    if (input.type === 'hidden') return null;
    if (tag === 'input' && /^(checkbox|radio|range)$/.test(input.type) && cs.appearance !== 'none') {
      return { ...base, type: 'SVG', svg: controlSvg(input, cs, g.width, g.height) } as SvgData;
    }
    const children: NodeData[] = [...extra];
    const text = formText(el as HTMLInputElement, cs, rect, ctx);
    if (text) children.push(text);
    if (tag === 'select' && cs.appearance !== 'none') {
      const size = 10;
      children.push({
        type: 'SVG', name: 'chevron', x: round(g.width - px(cs.paddingRight) / 2 - size - 4), y: round(g.height / 2 - size / 4),
        width: size, height: size / 2,
        svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size / 2}" viewBox="0 0 10 5"><path d="M1 0.5l4 4 4-4" fill="none" stroke="${cs.color}" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
      } as SvgData);
    }
    style.clips = true;
    return { ...base, type: 'FRAME', style, children } as FrameData;
  }
  return null;
}

async function walkChildren(el: Element, parentCs: CSSStyleDeclaration, origin: Origin, ctx: Ctx, hidden: boolean): Promise<Entry[]> {
  const entries: Entry[] = [];
  let order = 0;
  // A closed <details> shows only its summary.
  const closed = el.localName === 'details' && !el.hasAttribute('open');
  const summary = closed ? Array.from(el.children).find((c) => c.localName === 'summary') : null;
  for (const child of Array.from(el.childNodes)) {
    if (closed && child !== summary) continue;
    if (child.nodeType === Node.TEXT_NODE) {
      if (hidden || !(child.nodeValue ?? '').trim()) continue;
      const parent = child.parentElement!;
      const pcs = ctx.win.getComputedStyle(parent);
      const lines = lineBoxes(child, ctx.doc);
      if (isIconText(child.nodeValue ?? '', pcs)) {
        const icon = await iconImage(child.nodeValue ?? '', pcs, lines, origin, ctx, parent);
        if (icon) entries.push({ node: icon, el: null, cs: null, z: 1, order: order++ });
        continue;
      }
      // Text sitting between boxes can start or end mid-line, so it is placed line by line exactly
      // where the browser put it instead of reflowing as one block.
      const pieces = lines.length > 1 ? lineSlices(child as Text, ctx.doc) : [{ text: child as Node, lines }];
      for (const piece of pieces) {
        const node = makeText(collectRuns(piece.text, ctx.win, () => false), piece.lines, pcs, origin, ctx);
        if (node) {
          node.fit = true;
          entries.push({ node, el: null, cs: null, z: 1, order: order++ });
        }
      }
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const childEl = child as Element;
    const nodes = await walkElement(childEl, origin, ctx);
    const ccs = nodes.length ? ctx.win.getComputedStyle(childEl) : null;
    for (const node of nodes) entries.push({ node, el: childEl, cs: ccs, z: zKey(ccs, parentCs), order: order++ });
  }
  return paintOrder(entries);
}

// A frame that draws nothing and only wraps one same-sized child (an <i> around an icon glyph, a
// wrapper div) adds a layer without adding meaning; the child takes its place.
function flatten(frame: FrameData): NodeData {
  const s = frame.style;
  const plain =
    !s.fills.length && !s.border && !s.shadows && !s.layerBlur && !s.backgroundBlur && !s.opacity && !s.blendMode &&
    !frame.rotation && !frame.layout && frame.children.length === 1;
  if (!plain) return frame;
  const child = frame.children[0];
  if (child.rotation || Math.abs(child.x) > 1 || Math.abs(child.y) > 1.5 || Math.abs(child.width - frame.width) > 1 || Math.abs(child.height - frame.height) > 2) {
    return frame;
  }
  return { ...child, x: round(frame.x + child.x), y: round(frame.y + child.y), childLayout: frame.childLayout ?? child.childLayout };
}

function overlaps(a: NodeData, b: NodeData): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

// CSS paints negative z-index layers first, then in-flow content, then positioned layers. Layers only
// move out of document order when they actually overlap, so the Figma layer list stays readable.
function paintOrder(entries: Entry[]): Entry[] {
  const out: Entry[] = [];
  for (const e of entries) {
    let i = out.length;
    while (i > 0 && out[i - 1].z > e.z && overlaps(out[i - 1].node, e.node)) i--;
    out.splice(i, 0, e);
  }
  return out;
}

function inFlow(e: Entry): boolean {
  return !e.cs || !/absolute|fixed/.test(e.cs.position);
}

// Auto Layout is only applied when it reproduces the browser's placement; otherwise children stay absolute.
function autoLayout(cs: CSSStyleDeclaration, frame: FrameData, entries: Entry[]): AutoLayout | undefined {
  const display = cs.display;
  const flex = display === 'flex' || display === 'inline-flex';
  const grid = display === 'grid' || display === 'inline-grid';
  if (!flex && !grid) return undefined;
  const items = entries.filter(inFlow);
  if (!items.length) return undefined;
  if (items.some((e) => e.node.rotation)) return undefined;
  for (const e of items) {
    if (!e.cs) continue;
    if (['marginTop', 'marginRight', 'marginBottom', 'marginLeft'].some((m) => Math.abs(px(e.cs![m as 'marginTop'])) > 0.5)) return undefined;
    if (e.cs.order !== '0') return undefined;
  }
  const padding: [number, number, number, number] = [
    px(cs.paddingTop) + px(cs.borderTopWidth), px(cs.paddingRight) + px(cs.borderRightWidth),
    px(cs.paddingBottom) + px(cs.borderBottomWidth), px(cs.paddingLeft) + px(cs.borderLeftWidth),
  ];
  const colGap = cs.columnGap === 'normal' ? 0 : px(cs.columnGap);
  const rowGap = cs.rowGap === 'normal' ? 0 : px(cs.rowGap);
  let mode: AutoLayout['mode'];
  let wrap = false;
  let gap: number;
  let crossGap = 0;
  if (flex) {
    const dir = cs.flexDirection;
    if (dir.endsWith('reverse')) return undefined;
    mode = dir.startsWith('column') ? 'VERTICAL' : 'HORIZONTAL';
    wrap = cs.flexWrap !== 'nowrap';
    if (wrap && mode === 'VERTICAL') return undefined;
    gap = mode === 'HORIZONTAL' ? colGap : rowGap;
    crossGap = rowGap;
  } else {
    mode = 'HORIZONTAL';
    wrap = true;
    gap = colGap;
    crossGap = rowGap;
  }
  const H = mode === 'HORIZONTAL';
  const pos = (n: NodeData) => (H ? n.x : n.y);
  const size = (n: NodeData) => (H ? n.width : n.height);
  const cpos = (n: NodeData) => (H ? n.y : n.x);
  const csize = (n: NodeData) => (H ? n.height : n.width);
  const start = H ? padding[3] : padding[0];
  const innerMain = (H ? frame.width : frame.height) - (H ? padding[1] + padding[3] : padding[0] + padding[2]);
  const crossStart = H ? padding[0] : padding[3];
  const innerCross = (H ? frame.height : frame.width) - (H ? padding[0] + padding[2] : padding[1] + padding[3]);
  const nodes = items.map((e) => e.node);
  const tol = 1.5;

  // Rows (for wrapping layouts) are detected from the rendered positions.
  const rows: NodeData[][] = [];
  for (const n of nodes) {
    const row = rows[rows.length - 1];
    if (row && (!wrap || pos(n) > pos(row[row.length - 1]) + tol)) row.push(n);
    else if (!row) rows.push([n]);
    else rows.push([n]);
  }
  if (!wrap && rows.length !== 1) return undefined;

  let primaryAlign: AutoLayout['primaryAlign'] = 'MIN';
  const jc = cs.justifyContent;
  if (/center/.test(jc)) primaryAlign = 'CENTER';
  else if (/flex-end|end|right/.test(jc) && !/space/.test(jc)) primaryAlign = 'MAX';
  else if (jc === 'space-between') primaryAlign = 'SPACE_BETWEEN';
  else if (/space-(around|evenly)/.test(jc)) return undefined;
  if (grid) primaryAlign = 'MIN';

  for (const row of rows) {
    const total = row.reduce((s, n) => s + size(n), 0) + gap * (row.length - 1);
    let cursor =
      primaryAlign === 'CENTER' ? start + (innerMain - total) / 2
      : primaryAlign === 'MAX' ? start + innerMain - total
      : start;
    const between = primaryAlign === 'SPACE_BETWEEN' && row.length > 1 ? (innerMain - row.reduce((s, n) => s + size(n), 0)) / (row.length - 1) : gap;
    for (const n of row) {
      if (Math.abs(pos(n) - cursor) > tol) return undefined;
      cursor += size(n) + between;
    }
  }
  if (wrap && rows.length > 1) {
    let y = crossStart;
    for (const row of rows) {
      const rowSize = Math.max(...row.map(csize));
      if (row.some((n) => Math.abs(cpos(n) - y) > tol)) return undefined;
      y += rowSize + crossGap;
    }
  }

  let counterAlign: AutoLayout['counterAlign'] = 'MIN';
  const ai = cs.alignItems;
  if (/center/.test(ai)) counterAlign = 'CENTER';
  else if (/flex-end|end/.test(ai)) counterAlign = 'MAX';
  else if (/baseline/.test(ai) && H && !wrap) counterAlign = 'BASELINE';
  const stretch = /normal|stretch/.test(ai);
  if (!wrap || rows.length === 1) {
    for (const e of items) {
      const n = e.node;
      const selfAlign = e.cs?.alignSelf ?? 'auto';
      if (selfAlign !== 'auto' && selfAlign !== ai && !(selfAlign === 'stretch' && stretch)) return undefined;
      const expected =
        counterAlign === 'CENTER' ? crossStart + (innerCross - csize(n)) / 2
        : counterAlign === 'MAX' ? crossStart + innerCross - csize(n)
        : crossStart;
      if (counterAlign !== 'BASELINE' && Math.abs(cpos(n) - expected) > tol) return undefined;
      if (stretch && Math.abs(csize(n) - innerCross) < tol && n.type === 'FRAME') n.childLayout = { ...n.childLayout, stretch: true };
      const grow = e.cs ? parseFloat(e.cs.flexGrow) > 0 : false;
      if (grow && flex && rows.length === 1 && n.type !== 'TEXT') n.childLayout = { ...n.childLayout, grow: true };
    }
  }
  for (const e of entries) if (!inFlow(e)) e.node.childLayout = { ...e.node.childLayout, absolute: true };
  return { mode, wrap: wrap && rows.length > 1, gap, crossGap, padding, primaryAlign, counterAlign };
}

async function walkElement(el: Element, origin: Origin, ctx: Ctx): Promise<NodeData[]> {
  const tag = el.localName;
  if (SKIP.has(tag)) return [];
  const cs = ctx.win.getComputedStyle(el);
  if (cs.display === 'none') return [];
  ctx.count++;
  if (ctx.count % 200 === 0) {
    ctx.onProgress(ctx.count);
    await new Promise((r) => setTimeout(r, 0));
  }
  const opacity = parseFloat(cs.opacity);
  if (opacity <= 0.001) return [];
  if (visuallyHidden(el, cs)) return [];
  if (ctx.opts.hideOverlays && isOverlay(el, cs, ctx.win)) return [];
  // Content the browser skips painting: a closed <details>, hidden="until-found", content-visibility.
  if (cs.display !== 'contents' && typeof el.checkVisibility === 'function' && !el.checkVisibility()) return [];
  const hidden = cs.visibility !== 'visible';
  if (cs.display === 'contents') return (await walkChildren(el, cs, origin, ctx, hidden)).map((e) => e.node);

  const g = geometry(el, cs, origin);
  try {
    if (REPLACED.has(tag)) {
      if (hidden) return [];
      const node = await replaced(el, cs, g, ctx, opacity);
      return node ? [node] : [];
    }

    const rect = el.getBoundingClientRect();
    const boxed = !hidden && hasBox(cs);
    const clip = clips(cs);
    const marker = !hidden ? listMarker(el, cs, rect, origin, ctx) : null;

    // Inline elements that could not merge into a text node: their fragments are drawn by the
    // children; only a decorated inline (badge, highlighted code) gets a frame of its own.
    if (cs.display === 'inline' && !boxed) {
      if (!hidden && isTextBlock(el, ctx)) {
        const lines = lineBoxes(el, ctx.doc);
        const raw = el.textContent ?? '';
        const text =
          isIconText(raw, cs) && el.children.length === 0
            ? await iconImage(raw, cs, lines, origin, ctx, el)
            : makeText(collectRuns(el, ctx.win, (c) => isMergeable(c, ctx)), lines, cs, origin, ctx);
        return text ? [text] : [];
      }
      return (await walkChildren(el, cs, origin, ctx, hidden)).map((e) => e.node);
    }

    const frameOrigin = g.origin;
    const textBlock = !hidden && isTextBlock(el, ctx);
    if (textBlock) {
      const lines = lineBoxes(el, ctx.doc);
      const raw = el.textContent ?? '';
      const simple = !boxed && !clip && opacity >= 1 && !g.rotation && !(cs.filter && cs.filter !== 'none');
      const target = simple ? origin : frameOrigin;
      let node: NodeData | null;
      if (isIconText(raw, cs) && el.children.length === 0) node = await iconImage(raw, cs, lines, target, ctx, el);
      else {
        const cb = contentBox(cs, g.rotation ? new DOMRect(frameOrigin.x, frameOrigin.y, g.width, g.height) : rect);
        node = makeText(collectRuns(el, ctx.win, (c) => isMergeable(c, ctx)), lines, cs, target, ctx, undefined, { left: cb.left, width: cb.width });
      }
      if (simple) return [marker, node].filter(Boolean) as NodeData[];
      const extra: NodeData[] = [];
      const style = await boxStyle(el, cs, g.width, g.height, ctx, extra);
      const frame: FrameData = {
        type: 'FRAME', name: nameOf(el, cs), x: round(g.x), y: round(g.y), width: round(g.width), height: round(g.height),
        rotation: g.rotation, style, children: [...extra, ...(node ? [node] : [])],
      };
      if (ctx.opts.autoLayout && node) {
        const layout = autoLayout(cs, frame, [{ node, el: null, cs: null, z: 1, order: 0 }]);
        if (layout) frame.layout = layout;
      }
      return [marker, frame].filter(Boolean) as NodeData[];
    }

    const extra: NodeData[] = [];
    const style: BoxStyle = hidden ? { fills: [] } : await boxStyle(el, cs, g.width, g.height, ctx, extra);
    if (hidden) style.clips = clip;
    const entries = await walkChildren(el, cs, frameOrigin, ctx, hidden);
    const frame: FrameData = {
      type: 'FRAME',
      name: nameOf(el, cs),
      x: round(g.x),
      y: round(g.y),
      width: round(g.width),
      height: round(g.height),
      rotation: g.rotation,
      style,
      children: [...extra, ...entries.map((e) => e.node)],
    };
    if (ctx.opts.autoLayout && !extra.length) {
      const layout = autoLayout(cs, frame, entries);
      if (layout) frame.layout = layout;
    }
    const flat = flatten(frame);
    return [marker, flat].filter(Boolean) as NodeData[];
  } finally {
    g.restore?.();
  }
}

// ::before/::after become real elements so they are measured and painted like everything else.
const PSEUDO_TAG = 'h2f-pseudo';

function contentText(content: string, el: Element): string | null {
  if (!content || content === 'none' || content === 'normal') return null;
  let out = '';
  const re = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|attr\(\s*([\w-]+)\s*\)|(url\([^)]*\))|([a-z-]+\([^)]*\))/gi;
  let m: RegExpExecArray | null;
  let any = false;
  while ((m = re.exec(content))) {
    any = true;
    if (m[1] !== undefined || m[2] !== undefined) {
      out += (m[1] ?? m[2]).replace(/\\([0-9a-f]{1,6})\s?/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16))).replace(/\\(.)/g, '$1');
    } else if (m[3]) out += el.getAttribute(m[3]) ?? '';
  }
  return any ? out : null;
}

export function materializePseudos(doc: Document, win: Window): () => void {
  const created: Element[] = [];
  const marked: Element[] = [];
  const work: { el: Element; which: '::before' | '::after'; text: string; style: [string, string][]; image?: string }[] = [];
  for (const el of Array.from(doc.body?.querySelectorAll('*') ?? [])) {
    if (REPLACED.has(el.localName) || SKIP.has(el.localName) || el.closest('svg')) continue;
    for (const which of ['::before', '::after'] as const) {
      const cs = win.getComputedStyle(el, which);
      const text = contentText(cs.content, el);
      if (text === null || cs.display === 'none') continue;
      const url = cs.content.match(/url\(\s*["']?([^"')]+)["']?\s*\)/)?.[1];
      const style: [string, string][] = [];
      for (let i = 0; i < cs.length; i++) {
        const prop = cs[i];
        if (prop === 'content' || prop.startsWith('--')) continue;
        style.push([prop, cs.getPropertyValue(prop)]);
      }
      work.push({ el, which, text, style, image: url });
    }
  }
  const sheet = doc.createElement('style');
  sheet.textContent = '[data-h2f-pseudo]::before,[data-h2f-pseudo]::after{content:none!important}';
  doc.head.appendChild(sheet);
  for (const w of work) {
    const span = doc.createElement(PSEUDO_TAG);
    span.setAttribute('data-which', w.which);
    for (const [prop, value] of w.style) span.style.setProperty(prop, value);
    if (w.image) {
      const img = doc.createElement('img');
      img.src = w.image;
      img.style.cssText = 'display:inline-block;max-width:100%';
      span.appendChild(img);
    }
    if (w.text) span.appendChild(doc.createTextNode(w.text));
    if (w.which === '::before') w.el.insertBefore(span, w.el.firstChild);
    else w.el.appendChild(span);
    w.el.setAttribute('data-h2f-pseudo', '');
    created.push(span);
    marked.push(w.el);
  }
  return () => {
    for (const c of created) c.remove();
    for (const m of marked) m.removeAttribute('data-h2f-pseudo');
    sheet.remove();
  };
}

export async function extractDocument(
  win: Window, name: string, viewportWidth: number, viewportHeight: number, opts: ExtractOptions,
  images: ImageRegistry, onProgress: (count: number) => void,
): Promise<{ doc: ImportDocument; fonts: FontRequest[]; nodeCount: number }> {
  const doc = win.document;
  const html = doc.documentElement;
  const body = doc.body ?? html;
  const htmlCs = win.getComputedStyle(html);
  const bodyCs = win.getComputedStyle(body);
  let canvas = parseColor(htmlCs.backgroundColor);
  let propagatedBody = false;
  if (!visible(canvas) && htmlCs.backgroundImage === 'none') {
    canvas = parseColor(bodyCs.backgroundColor);
    propagatedBody = bodyCs.backgroundImage === 'none';
  }
  const ctx: Ctx = {
    win, doc, opts, images, fonts: new Map(), inlineCache: new WeakMap(), count: 0, propagatedBody, onProgress,
  };
  const height = Math.max(html.scrollHeight, body.scrollHeight, viewportHeight);
  const rootStyle: BoxStyle = { fills: [{ kind: 'solid', color: visible(canvas) ? canvas : { r: 1, g: 1, b: 1, a: 1 } }] };
  if (htmlCs.backgroundImage !== 'none') {
    const extra: NodeData[] = [];
    const s = await boxStyle(html, htmlCs, viewportWidth, height, ctx, extra);
    rootStyle.fills.push(...s.fills.filter((f) => f.kind !== 'solid'));
  }
  const children = body === html ? [] : await walkElement(body, { x: 0, y: 0 }, ctx);
  const root: FrameData = {
    type: 'FRAME', name, x: 0, y: 0, width: viewportWidth, height: Math.ceil(height), style: { ...rootStyle, clips: true }, children,
  };
  // Pages often paint their background on a full-size wrapper rather than <body>; the frame takes the
  // colour you actually see so it reads right when selected and when resized taller.
  let cover: NodeData | undefined = root;
  for (let depth = 0; cover && depth < 6; depth++) {
    const next: NodeData | undefined = cover.type === 'FRAME'
      ? cover.children.find((c) => Math.abs(c.width - root.width) < 2 && c.height >= root.height - 2 && Math.abs(c.x) < 1 && Math.abs(c.y) < 1)
      : undefined;
    if (!next || next.type !== 'FRAME') break;
    const fill = next.style.fills[next.style.fills.length - 1];
    if (fill?.kind === 'solid' && fill.color.a >= 0.99 && !next.style.opacity) {
      root.style.fills = [fill];
      break;
    }
    cover = next;
  }
  return { doc: { name, root }, fonts: [...ctx.fonts.values()], nodeCount: ctx.count };
}
