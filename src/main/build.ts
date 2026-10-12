import type {
  BoxStyle, Fill, FrameData, ImageData, NodeData, RGBA, Shadow, SvgData, TextData, TextRun, ImportSettings,
} from '../shared/types';
import { loadFont, pickFont } from './fonts';

export class CancelledError extends Error {
  constructor() {
    super('Import cancelled');
  }
}

// Turns repeated parts into component instances (see components.ts).
export interface ComponentSystem {
  readonly record: Map<NodeData, string>;
  isOccurrence(node: NodeData): boolean;
  place(node: FrameData, ctx: BuildContext): Promise<SceneNode>;
}

export interface BuildContext {
  images: Map<string, Image | null>;
  fontMap: Record<string, string>; // CSS stack -> Figma family
  settings: ImportSettings;
  isCancelled: () => boolean;
  onProgress: (built: number) => void;
  built: number;
  components?: ComponentSystem;
}

const MIN_SIZE = 0.01;

function rgb(c: RGBA): RGB {
  return { r: c.r, g: c.g, b: c.b };
}

function toPaint(fill: Fill, ctx: BuildContext): Paint | null {
  if (fill.kind === 'solid') {
    if (fill.color.a <= 0) return null;
    return { type: 'SOLID', color: rgb(fill.color), opacity: fill.color.a };
  }
  if (fill.kind === 'image') {
    const image = ctx.images.get(fill.imageId);
    if (!image) return null;
    const paint: ImagePaint = {
      type: 'IMAGE',
      imageHash: image.hash,
      scaleMode: fill.scaleMode,
      ...(fill.scaleMode === 'TILE' ? { scalingFactor: fill.scalingFactor ?? 1 } : {}),
      ...(fill.scaleMode === 'CROP' && fill.transform ? { imageTransform: fill.transform as Transform } : {}),
    };
    return paint;
  }
  const type =
    fill.kind === 'linear' ? 'GRADIENT_LINEAR' : fill.kind === 'radial' ? 'GRADIENT_RADIAL' : 'GRADIENT_ANGULAR';
  return {
    type,
    gradientTransform: fill.transform as Transform,
    gradientStops: fill.stops.map((s) => ({ color: { ...s.color }, position: Math.min(1, Math.max(0, s.position)) })),
  };
}

export function toPaints(fills: Fill[], ctx: BuildContext): Paint[] {
  const out: Paint[] = [];
  for (const f of fills) {
    const p = toPaint(f, ctx);
    if (p) out.push(p);
  }
  return out;
}

function toEffects(style: { shadows?: Shadow[]; layerBlur?: number; backgroundBlur?: number }): Effect[] {
  const effects: Effect[] = [];
  for (const s of style.shadows ?? []) {
    effects.push({
      type: s.type,
      color: { ...s.color },
      offset: { x: s.x, y: s.y },
      radius: Math.max(0, s.blur),
      spread: s.spread,
      visible: true,
      blendMode: 'NORMAL',
      ...(s.type === 'DROP_SHADOW' ? { showShadowBehindNode: false } : {}),
    } as Effect);
  }
  if (style.layerBlur) {
    effects.push({ type: 'LAYER_BLUR', blurType: 'NORMAL', radius: style.layerBlur, visible: true });
  }
  if (style.backgroundBlur) {
    effects.push({ type: 'BACKGROUND_BLUR', blurType: 'NORMAL', radius: style.backgroundBlur, visible: true });
  }
  return effects;
}

type BoxNode = FrameNode | RectangleNode;

function applyBox(node: BoxNode, style: BoxStyle, ctx: BuildContext, w: number, h: number): void {
  node.fills = toPaints(style.fills, ctx);
  if (style.radius) {
    const max = Math.min(w, h) / 2;
    const [tl, tr, br, bl] = style.radius.map((r) => Math.min(r, max));
    if (tl === tr && tr === br && br === bl) node.cornerRadius = tl;
    else {
      node.topLeftRadius = tl;
      node.topRightRadius = tr;
      node.bottomRightRadius = br;
      node.bottomLeftRadius = bl;
    }
  }
  const b = style.border;
  if (b && !b.sideColors) {
    node.strokes = [{ type: 'SOLID', color: rgb(b.color), opacity: b.color.a }];
    node.strokeAlign = 'INSIDE';
    if (b.top === b.right && b.right === b.bottom && b.bottom === b.left) node.strokeWeight = b.top;
    else {
      node.strokeTopWeight = b.top;
      node.strokeRightWeight = b.right;
      node.strokeBottomWeight = b.bottom;
      node.strokeLeftWeight = b.left;
    }
    const weight = Math.max(b.top, b.right, b.bottom, b.left);
    if (b.style === 'dashed') node.dashPattern = [weight * 2, weight * 2];
    if (b.style === 'dotted') {
      node.dashPattern = [0, weight * 2];
      node.strokeCap = 'ROUND';
    }
  }
  const effects = toEffects(style);
  if (effects.length) node.effects = effects;
  if (style.opacity !== undefined && style.opacity < 1) node.opacity = style.opacity;
  if (style.blendMode && style.blendMode !== 'NORMAL') node.blendMode = style.blendMode;
}

// Borders whose four sides differ in color are drawn as separate edge rectangles on top of the box.
function addSideBorders(frame: FrameNode, style: BoxStyle, w: number, h: number): void {
  const b = style.border;
  if (!b || !b.sideColors) return;
  const sides: [number, number, number, number, RGBA, number][] = [
    [0, 0, w, b.top, b.sideColors[0], b.top],
    [w - b.right, 0, b.right, h, b.sideColors[1], b.right],
    [0, h - b.bottom, w, b.bottom, b.sideColors[2], b.bottom],
    [0, 0, b.left, h, b.sideColors[3], b.left],
  ];
  const names = ['border-top', 'border-right', 'border-bottom', 'border-left'];
  sides.forEach(([x, y, sw, sh, color, weight], i) => {
    if (weight <= 0 || color.a <= 0) return;
    const r = figma.createRectangle();
    r.name = names[i];
    r.resize(Math.max(sw, MIN_SIZE), Math.max(sh, MIN_SIZE));
    r.fills = [{ type: 'SOLID', color: rgb(color), opacity: color.a }];
    frame.appendChild(r);
    if (frame.layoutMode !== 'NONE') r.layoutPositioning = 'ABSOLUTE';
    r.x = x;
    r.y = y;
  });
}

export function place(node: SceneNode, data: NodeData, parent: FrameNode | PageNode): void {
  const inAutoLayout = parent.type === 'FRAME' && parent.layoutMode !== 'NONE';
  if (inAutoLayout && 'layoutPositioning' in node) {
    if (data.childLayout?.absolute) node.layoutPositioning = 'ABSOLUTE';
    else {
      if (data.childLayout?.grow) (node as FrameNode).layoutGrow = 1;
      if (data.childLayout?.stretch) (node as FrameNode).layoutAlign = 'STRETCH';
      return;
    }
  }
  if (data.rotation) {
    // data.x/y is the unrotated box sharing the rendered center; Figma rotates around the top-left corner.
    const t = (data.rotation * Math.PI) / 180;
    const cos = Math.cos(t);
    const sin = Math.sin(t);
    const cx = data.x + data.width / 2;
    const cy = data.y + data.height / 2;
    const x = cx - (data.width / 2) * cos - (data.height / 2) * sin;
    const y = cy + (data.width / 2) * sin - (data.height / 2) * cos;
    node.relativeTransform = [
      [cos, sin, x],
      [-sin, cos, y],
    ];
    return;
  }
  node.x = data.x;
  node.y = data.y;
}

async function tick(ctx: BuildContext): Promise<void> {
  ctx.built++;
  if (ctx.isCancelled()) throw new CancelledError();
  if (ctx.built % 150 === 0) {
    ctx.onProgress(ctx.built);
    await new Promise((r) => setTimeout(r, 0));
  }
}

export async function buildFrame(data: FrameData, ctx: BuildContext, asComponent = false): Promise<FrameNode> {
  // A component takes the same frame properties, so it is built the same way.
  const frame = asComponent ? (figma.createComponent() as unknown as FrameNode) : figma.createFrame();
  frame.name = data.name;
  const w = Math.max(data.width, MIN_SIZE);
  const h = Math.max(data.height, MIN_SIZE);
  frame.resize(w, h);
  applyBox(frame, data.style, ctx, w, h);
  frame.clipsContent = !!data.style.clips;
  const layout = ctx.settings.autoLayout ? data.layout : undefined;
  if (layout) {
    frame.layoutMode = layout.mode;
    frame.layoutWrap = layout.wrap && layout.mode === 'HORIZONTAL' ? 'WRAP' : 'NO_WRAP';
    frame.itemSpacing = layout.gap;
    if (layout.wrap) frame.counterAxisSpacing = layout.crossGap;
    [frame.paddingTop, frame.paddingRight, frame.paddingBottom, frame.paddingLeft] = layout.padding;
    frame.primaryAxisAlignItems = layout.primaryAlign;
    frame.counterAxisAlignItems = layout.counterAlign;
    frame.primaryAxisSizingMode = 'FIXED';
    frame.counterAxisSizingMode = 'FIXED';
    frame.resize(w, h);
  }
  for (const child of data.children) {
    const node = ctx.components?.isOccurrence(child) ? await ctx.components.place(child as FrameData, ctx) : await buildNode(child, ctx);
    if (!node) continue;
    frame.appendChild(node);
    place(node, child, frame);
  }
  addSideBorders(frame, data.style, w, h);
  // Figma only applies shadow spread on frames that clip. Clipping is safe when nothing overflows.
  if (!frame.clipsContent && data.style.shadows?.some((s) => s.spread !== 0) && childrenInside(frame)) {
    frame.clipsContent = true;
  }
  return frame;
}

function childrenInside(frame: FrameNode): boolean {
  // Child x/y are parent-relative, which holds even before the frame is attached to the page.
  return frame.children.every(
    (c) => !('rotation' in c && c.rotation) && c.x >= -0.5 && c.y >= -0.5 && c.x + c.width <= frame.width + 0.5 && c.y + c.height <= frame.height + 0.5,
  );
}

// Sets a text layer's characters and styles them run by run. Also used for the text overrides of
// component instances.
export async function applyRuns(text: TextNode, runs: TextRun[], ctx: BuildContext): Promise<void> {
  const fonts: FontName[] = [];
  for (const run of runs) {
    const family = ctx.fontMap[run.fontFamily] ?? 'Inter';
    const font = await pickFont(family, run.fontWeight, run.italic);
    await loadFont(font);
    fonts.push(font);
  }
  if (text.characters.length) {
    // The layer's current fonts must be loaded before its characters can change.
    for (const f of text.getRangeAllFontNames(0, text.characters.length)) await loadFont(f);
  }
  text.fontName = fonts[0];
  text.characters = runs.map((r) => r.text).join('');
  let start = 0;
  runs.forEach((run, i) => {
    const end = start + run.text.length;
    text.setRangeFontName(start, end, fonts[i]);
    text.setRangeFontSize(start, end, Math.max(1, run.fontSize));
    const paint = run.gradient ? toPaint(run.gradient, ctx) : run.color ? toPaint({ kind: 'solid', color: run.color }, ctx) : null;
    text.setRangeFills(start, end, paint ? [paint] : []);
    text.setRangeLetterSpacing(start, end, { unit: 'PIXELS', value: run.letterSpacing });
    text.setRangeLineHeight(start, end, run.lineHeight ? { unit: 'PIXELS', value: run.lineHeight } : { unit: 'AUTO' });
    if (run.decoration !== 'NONE') text.setRangeTextDecoration(start, end, run.decoration);
    if (run.textCase !== 'ORIGINAL') text.setRangeTextCase(start, end, run.textCase);
    if (run.href && /^https?:/i.test(run.href)) {
      try {
        text.setRangeHyperlink(start, end, { type: 'URL', value: run.href });
      } catch {
        // invalid links are dropped rather than failing the import
      }
    }
    start = end;
  });
}

async function buildText(data: TextData, ctx: BuildContext): Promise<TextNode | null> {
  const runs = data.runs.filter((r) => r.text.length > 0);
  if (!runs.length) return null;
  const text = figma.createText();
  await applyRuns(text, runs, ctx);
  text.name = text.characters.replace(/\s+/g, ' ').trim().slice(0, 40) || 'Text';
  text.textAlignHorizontal = data.align;
  if (data.singleLine) {
    text.textAutoResize = 'WIDTH_AND_HEIGHT';
    // Text squeezed between inline boxes would overlap its neighbours if Figma's glyphs run wider
    // than the browser's, so its tracking is tightened by the difference (capped at a few percent).
    const over = text.width - data.width;
    const chars = text.characters.length;
    if (data.fit && over > 0.75 && chars > 1 && over / data.width < 0.06) {
      let at = 0;
      runs.forEach((run) => {
        text.setRangeLetterSpacing(at, at + run.text.length, { unit: 'PIXELS', value: run.letterSpacing - over / chars });
        at += run.text.length;
      });
    }
    // Keep the rendered box: centered/right text grows from its anchor, not from the left edge.
    const drift = text.width - data.width;
    if (data.align === 'CENTER') data.x -= drift / 2;
    else if (data.align === 'RIGHT') data.x -= drift;
  } else {
    // resize() can reset auto-resize, so the mode is set afterwards.
    const base = Math.max(data.width + Math.min(2, data.width * 0.02), 1);
    text.resize(base, Math.max(data.height, 1));
    text.textAutoResize = 'HEIGHT';
    // If Figma's metrics push words onto an extra line, widen slightly until the line count matches.
    const lineSlack = (runs[0].lineHeight ?? runs[0].fontSize * 1.2) / 2;
    for (let k = 1; k <= 8 && text.height > data.height + lineSlack; k++) {
      text.resize(base * (1 + k * 0.01), text.height);
      text.textAutoResize = 'HEIGHT';
    }
  }
  const effects = toEffects({ shadows: data.shadows });
  if (effects.length) text.effects = effects;
  if (data.opacity !== undefined && data.opacity < 1) text.opacity = data.opacity;
  return text;
}

function buildImage(data: ImageData, ctx: BuildContext): RectangleNode {
  const rect = figma.createRectangle();
  rect.name = data.name;
  const w = Math.max(data.width, MIN_SIZE);
  const h = Math.max(data.height, MIN_SIZE);
  rect.resize(w, h);
  applyBox(rect, data.style, ctx, w, h);
  if (!rect.fills || (rect.fills as Paint[]).length === 0) {
    rect.fills = [{ type: 'SOLID', color: { r: 0.9, g: 0.9, b: 0.92 } }];
  }
  return rect;
}

function buildSvg(data: SvgData): SceneNode {
  try {
    const node = figma.createNodeFromSvg(data.svg);
    node.name = data.name;
    if (data.width > 0 && data.height > 0 && (Math.abs(node.width - data.width) > 0.5 || Math.abs(node.height - data.height) > 0.5)) {
      node.rescale(Math.min(data.width / Math.max(node.width, MIN_SIZE), data.height / Math.max(node.height, MIN_SIZE)));
      node.resize(Math.max(data.width, MIN_SIZE), Math.max(data.height, MIN_SIZE));
    }
    node.fills = [];
    node.clipsContent = false;
    if (data.opacity !== undefined && data.opacity < 1) node.opacity = data.opacity;
    return node;
  } catch {
    const rect = figma.createRectangle();
    rect.name = `${data.name} (unsupported SVG)`;
    rect.resize(Math.max(data.width, MIN_SIZE), Math.max(data.height, MIN_SIZE));
    rect.fills = [{ type: 'SOLID', color: { r: 0.9, g: 0.9, b: 0.92 } }];
    return rect;
  }
}

export async function buildNode(data: NodeData, ctx: BuildContext): Promise<SceneNode | null> {
  await tick(ctx);
  let node: SceneNode | null;
  switch (data.type) {
    case 'FRAME':
      node = await buildFrame(data, ctx);
      break;
    case 'TEXT':
      node = await buildText(data, ctx);
      break;
    case 'IMAGE':
      node = buildImage(data, ctx);
      break;
    case 'SVG':
      node = buildSvg(data);
      break;
  }
  if (node && ctx.components) ctx.components.record.set(data, node.id);
  return node;
}

export async function buildRoot(root: FrameData, ctx: BuildContext): Promise<FrameNode> {
  const frame = (await buildNode(root, ctx)) as FrameNode;
  frame.clipsContent = true;
  return frame;
}
