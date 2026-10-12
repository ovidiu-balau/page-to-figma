// Turns repeated parts of a page into Figma components. Two parts repeat when they have the same
// structure and styling and differ only in their text, links and images; the first becomes the main
// component (kept on a Components board beside the import) and every occurrence, the first included,
// becomes an instance with its own text and images as overrides.
import type { BoxStyle, Fill, FrameData, NodeData, RGBA, TextRun } from '../shared/types';
import { applyRuns, buildFrame, toPaints, type BuildContext, type ComponentSystem } from './build';

const GENERIC = new Set(['Frame', 'Row', 'Column', 'Grid', 'Group', 'Container', 'Box', 'Item']);

const n = (v: number) => Math.round(v);
const c = (k: RGBA) => `${n(k.r * 255)},${n(k.g * 255)},${n(k.b * 255)},${Math.round(k.a * 100)}`;

function fillKey(f: Fill): string {
  if (f.kind === 'solid') return c(f.color);
  if (f.kind === 'image') return `img:${f.scaleMode}`; // the picture itself may differ between instances
  return `${f.kind}:${f.stops.map((s) => `${c(s.color)}@${Math.round(s.position * 100)}`).join(',')}`;
}

function boxKey(s: BoxStyle): string {
  const b = s.border;
  return [
    s.fills.map(fillKey).join('+'),
    b ? `${b.top},${b.right},${b.bottom},${b.left},${c(b.color)},${b.style},${b.sideColors?.map(c).join('/') ?? ''}` : '',
    s.radius?.map(n).join(',') ?? '',
    s.shadows?.map((h) => `${h.type}${c(h.color)}${n(h.x)},${n(h.y)},${n(h.blur)},${n(h.spread)}`).join('+') ?? '',
    s.opacity ?? '', s.blendMode ?? '', s.clips ? 'c' : '', s.layerBlur ?? '', s.backgroundBlur ?? '',
  ].join('|');
}

function runKey(r: TextRun): string {
  return [r.fontFamily, r.fontWeight, r.italic ? 'i' : '', r.fontSize, r.lineHeight ?? '', r.letterSpacing, r.color ? c(r.color) : '',
    r.gradient ? fillKey(r.gradient) : '', r.decoration, r.textCase].join(',');
}

function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

const hasBox = (s: BoxStyle) => s.fills.length > 0 || !!s.border || !!s.shadows?.length || !!s.radius?.some((r) => r > 0);

function* walk(node: NodeData): Generator<NodeData> {
  yield node;
  if (node.type === 'FRAME') for (const child of node.children) yield* walk(child);
}

function sameImages(a: Fill[], b: Fill[]): boolean {
  return a.length === b.length && a.every((f, i) => f.kind !== 'image' || (b[i].kind === 'image' && (b[i] as typeof f).imageId === f.imageId));
}

interface Group {
  name: string;
  members: FrameData[];
  main?: ComponentNode;
  mainData?: FrameData;
  ids?: Map<NodeData, string>; // node in the main occurrence -> id of its layer inside the component
}

export class Components implements ComponentSystem {
  private sigs = new Map<NodeData, string>();
  private groupOf = new Map<NodeData, Group>();
  private board: FrameNode | null = null;
  private names = new Map<string, number>();
  readonly record = new Map<NodeData, string>(); // node -> id of the layer that shows it in the document
  count = 0;

  constructor(root: FrameData, private autoLayout: boolean, private boardName: string) {
    const groups = new Map<string, Group>();
    for (const node of walk(root)) {
      if (node === root || node.type !== 'FRAME' || !this.worthIt(node)) continue;
      const sig = this.sig(node);
      let g = groups.get(sig);
      if (!g) groups.set(sig, (g = { name: '', members: [] }));
      g.members.push(node);
    }
    // A part nested inside another occurrence of its own kind cannot be an instance of itself.
    for (const g of groups.values()) {
      if (g.members.length < 2) continue;
      const inside = new Set<NodeData>();
      for (const m of g.members) for (const d of walk(m)) if (d !== m) inside.add(d);
      g.members = g.members.filter((m) => !inside.has(m));
      if (g.members.length < 2) continue;
      for (const m of g.members) this.groupOf.set(m, g);
    }
  }

  private worthIt(node: FrameData): boolean {
    if (node.width < 8 || node.height < 8 || !node.children.length) return false;
    let count = 0;
    for (const d of walk(node)) if (d !== node) count++;
    if (!hasBox(node.style) && node.children.length === 1) return false; // a plain wrapper adds nothing
    return hasBox(node.style) ? count >= 1 : count >= 3;
  }

  private sig(node: NodeData): string {
    let s = this.sigs.get(node);
    if (s) return s;
    const rot = node.rotation ? `r${n(node.rotation)}` : '';
    const cl = node.childLayout ? `${node.childLayout.absolute ? 'a' : ''}${node.childLayout.grow ? 'g' : ''}${node.childLayout.stretch ? 's' : ''}` : '';
    switch (node.type) {
      case 'TEXT':
        s = `T(${node.runs.filter((r) => r.text).map(runKey).join(';')}|${node.align}|${node.singleLine ? '1' : n(node.width)}|${node.opacity ?? ''}${rot}${cl})`;
        break;
      case 'IMAGE':
        s = `I(${boxKey(node.style)}|${n(node.width)}x${n(node.height)}${rot}${cl})`;
        break;
      case 'SVG':
        s = `S(${hash(node.svg)}|${n(node.width)}x${n(node.height)}|${node.opacity ?? ''}${rot}${cl})`;
        break;
      case 'FRAME': {
        const layout = this.autoLayout ? node.layout : undefined;
        // An Auto Layout frame resizes to its content, so its size may differ between instances.
        const size = layout ? '~' : `${n(node.width)}x${n(node.height)}`;
        const lk = layout ? `${layout.mode}${layout.wrap ? 'w' : ''},${n(layout.gap)},${layout.padding.map(n).join(',')},${layout.primaryAlign},${layout.counterAlign}` : '';
        // Centered and right-aligned text is placed by its anchor, so a longer label still matches.
        const at = (k: NodeData) => {
          const x = k.type === 'TEXT' && k.singleLine ? (k.align === 'CENTER' ? k.x + k.width / 2 : k.align === 'RIGHT' ? k.x + k.width : k.x) : k.x;
          return `@${n(x)},${n(k.y)}`;
        };
        const kids = node.children.map((k) => (layout && !k.childLayout?.absolute ? '' : at(k)) + this.sig(k));
        s = `F(${boxKey(node.style)}|${lk}|${size}${rot}${cl})[${kids.join(',')}]`;
        break;
      }
    }
    this.sigs.set(node, s);
    return s;
  }

  isOccurrence(node: NodeData): boolean {
    return this.groupOf.has(node);
  }

  boardNode(): FrameNode | null {
    return this.board;
  }

  private ensureBoard(): FrameNode {
    if (this.board) return this.board;
    const b = figma.createFrame();
    b.name = this.boardName;
    b.layoutMode = 'HORIZONTAL';
    b.layoutWrap = 'WRAP';
    b.itemSpacing = 48;
    b.counterAxisSpacing = 48;
    b.paddingTop = b.paddingRight = b.paddingBottom = b.paddingLeft = 48;
    b.primaryAxisSizingMode = 'FIXED';
    b.counterAxisSizingMode = 'AUTO';
    b.resize(1440, 200);
    b.fills = [{ type: 'SOLID', color: { r: 0.96, g: 0.96, b: 0.96 } }];
    b.cornerRadius = 16;
    b.clipsContent = false;
    this.board = b;
    return b;
  }

  private nameFor(node: FrameData): string {
    let base = node.name.split(' · ')[0].trim() || 'Component';
    if (GENERIC.has(base)) base = 'Card';
    const k = (this.names.get(base) ?? 0) + 1;
    this.names.set(base, k);
    return k === 1 ? base : `${base} ${k}`;
  }

  async place(node: FrameData, ctx: BuildContext): Promise<SceneNode> {
    const g = this.groupOf.get(node)!;
    if (!g.main) {
      const main = (await buildFrame(node, ctx, true)) as unknown as ComponentNode;
      main.name = g.name = this.nameFor(node);
      this.ensureBoard().appendChild(main);
      g.main = main;
      g.mainData = node;
      g.ids = new Map();
      for (const d of walk(node)) {
        const id = this.record.get(d);
        if (id && d !== node) g.ids.set(d, id);
      }
      await this.anchorLabels(node, main);
      this.count++;
    }
    const inst = g.main.createInstance();
    inst.name = node.name;
    if (Math.abs(inst.width - node.width) > 0.5 || Math.abs(inst.height - node.height) > 0.5) {
      inst.resize(Math.max(node.width, 0.01), Math.max(node.height, 0.01));
    }
    this.record.set(node, inst.id);
    const ids = g.ids!;
    const sub = (id: string) => `I${inst.id};${id.replace(/^I/, '')}`;
    if (node === g.mainData) {
      // The main occurrence itself: only record where its layers ended up inside the instance.
      for (const [d, id] of ids) this.record.set(d, sub(id));
    } else {
      await this.overrideChildren(g.mainData!, node, sub, ids, ctx);
    }
    return inst;
  }

  // Single-line text grows to the right, and an instance cannot move its layers. So inside a main
  // component, centered and right-aligned labels get a box that reaches the frame's edge, with the text
  // aligned inside it: a longer label in an instance then stays on its anchor.
  private async anchorLabels(frame: FrameData, layerFrame: FrameNode | ComponentNode): Promise<void> {
    const free = !this.autoLayout || !frame.layout;
    for (const k of frame.children) {
      const id = this.record.get(k);
      if (!id) continue;
      if (k.type === 'FRAME') {
        const sub = (await figma.getNodeByIdAsync(id)) as FrameNode | null;
        if (sub) await this.anchorLabels(k, sub);
      } else if (k.type === 'TEXT' && k.singleLine && (k.align === 'CENTER' || k.align === 'RIGHT') && (free || k.childLayout?.absolute)) {
        const text = (await figma.getNodeByIdAsync(id)) as TextNode | null;
        if (!text || text.rotation) continue;
        const center = text.x + text.width / 2;
        const right = text.x + text.width;
        const half = Math.min(center, layerFrame.width - center);
        if (k.align === 'CENTER' && half > text.width / 2) {
          text.textAutoResize = 'HEIGHT';
          text.resize(half * 2, text.height);
          text.x = center - half;
        } else if (k.align === 'RIGHT' && right > text.width) {
          text.textAutoResize = 'HEIGHT';
          text.resize(right, text.height);
          text.x = 0;
        }
      }
    }
  }

  // Walks the main occurrence and this one side by side (same shape by construction) and gives the
  // instance this occurrence's own text, links and images.
  private async overrideChildren(a: FrameData, b: FrameData, sub: (id: string) => string, ids: Map<NodeData, string>, ctx: BuildContext): Promise<void> {
    for (let i = 0; i < a.children.length && i < b.children.length; i++) {
      const ca = a.children[i];
      const cb = b.children[i];
      const id = ids.get(ca);
      if (id) {
        const layerId = sub(id);
        this.record.set(cb, layerId);
        if (ca.type === 'TEXT' && cb.type === 'TEXT') {
          const key = (t: typeof ca) => t.runs.map((r) => `${r.text}\u0000${r.href ?? ''}`).join('\u0001');
          if (key(ca) !== key(cb)) {
            const layer = (await figma.getNodeByIdAsync(layerId)) as TextNode | null;
            if (layer) await applyRuns(layer, cb.runs.filter((r) => r.text.length > 0), ctx);
          }
        } else if ((ca.type === 'IMAGE' || ca.type === 'FRAME') && (cb.type === 'IMAGE' || cb.type === 'FRAME')) {
          if (!sameImages(ca.style.fills, cb.style.fills)) {
            const layer = (await figma.getNodeByIdAsync(layerId)) as FrameNode | RectangleNode | null;
            if (layer) layer.fills = toPaints(cb.style.fills, ctx);
          }
        }
      }
      if (ca.type === 'FRAME' && cb.type === 'FRAME') await this.overrideChildren(ca, cb, sub, ids, ctx);
    }
  }
}
