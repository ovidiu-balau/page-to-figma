// Creates local text and color styles from what an import uses and links its layers to them, so the
// page's type scale and palette show up in Figma's style pickers. Styles are grouped in a folder named
// after the page; importing the same page again reuses them.

interface TextKey {
  font: FontName;
  size: number;
  lineHeight: LineHeight;
  letterSpacing: LetterSpacing;
  decoration: TextDecoration;
  textCase: TextCase;
}

interface Seg {
  node: TextNode;
  start: number;
  end: number;
}

const r2 = (v: number) => Math.round(v * 100) / 100;
const lhKey = (l: LineHeight) => (l.unit === 'AUTO' ? 'auto' : `${r2(l.value)}${l.unit === 'PIXELS' ? 'px' : '%'}`);
const textKey = (k: TextKey) =>
  [k.font.family, k.font.style, r2(k.size), lhKey(k.lineHeight), r2(k.letterSpacing.value) + k.letterSpacing.unit, k.decoration, k.textCase].join('|');

const hex = (c: RGB) => '#' + [c.r, c.g, c.b].map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('').toUpperCase();
const paintKey = (p: SolidPaint) => `${hex(p.color)}${(p.opacity ?? 1) < 1 ? ` ${Math.round((p.opacity ?? 1) * 100)}%` : ''}`;

function soleSolid(paints: readonly Paint[] | typeof figma.mixed): SolidPaint | null {
  if (paints === figma.mixed || paints.length !== 1) return null;
  const p = paints[0];
  return p.type === 'SOLID' && p.visible !== false && !p.boundVariables?.color ? p : null;
}

function* layers(node: SceneNode): Generator<SceneNode> {
  yield node;
  if ('children' in node) for (const child of node.children) yield* layers(child);
}

export async function applyStyles(roots: SceneNode[], folder: string): Promise<{ text: number; color: number }> {
  const prefix = folder.replace(/\//g, '-').replace(/\s+/g, ' ').trim().slice(0, 48) || 'Imported';
  const textUses = new Map<string, { key: TextKey; segs: Seg[]; chars: number }>();
  const colorUses = new Map<string, { paint: SolidPaint; fills: (GeometryMixin & SceneNode)[]; strokes: (GeometryMixin & SceneNode)[]; text: Seg[] }>();
  const color = (p: SolidPaint) => {
    const k = paintKey(p);
    let u = colorUses.get(k);
    if (!u) colorUses.set(k, (u = { paint: p, fills: [], strokes: [], text: [] }));
    return u;
  };

  for (const root of roots) {
    for (const node of layers(root)) {
      if (node.type === 'TEXT') {
        const segs = node.getStyledTextSegments(['fontName', 'fontSize', 'lineHeight', 'letterSpacing', 'textDecoration', 'textCase', 'fills']);
        for (const s of segs) {
          const key: TextKey = { font: s.fontName, size: s.fontSize, lineHeight: s.lineHeight, letterSpacing: s.letterSpacing, decoration: s.textDecoration, textCase: s.textCase };
          const k = textKey(key);
          let u = textUses.get(k);
          if (!u) textUses.set(k, (u = { key, segs: [], chars: 0 }));
          const seg = { node, start: s.start, end: s.end };
          u.segs.push(seg);
          u.chars += s.end - s.start;
          const p = soleSolid(s.fills);
          if (p) color(p).text.push(seg);
        }
      } else if ('fills' in node && node.type !== 'INSTANCE') {
        const geo = node as GeometryMixin & SceneNode;
        const f = soleSolid(geo.fills);
        if (f) color(f).fills.push(geo);
        const s = soleSolid(geo.strokes);
        if (s) color(s).strokes.push(geo);
      }
    }
  }

  // --- Text styles: the most used size is Body; larger sizes are headings, smaller ones small print.
  const bySize = new Map<number, number>();
  for (const u of textUses.values()) bySize.set(r2(u.key.size), (bySize.get(r2(u.key.size)) ?? 0) + u.chars);
  const body = [...bySize].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 16;
  const larger = [...bySize.keys()].filter((s) => s > body).sort((a, b) => b - a);
  const smaller = [...bySize.keys()].filter((s) => s < body).sort((a, b) => b - a);
  const SMALL = ['Small', 'Caption', 'Micro'];
  // Six heading levels like HTML; any further sizes above body text are named by their size.
  const sizeName = (s: number) => {
    if (s === body) return 'Body';
    if (s > body) {
      const i = larger.indexOf(s);
      return i < 6 ? `Heading ${i + 1}` : `Large ${s}`;
    }
    const i = smaller.indexOf(s);
    return i < SMALL.length ? SMALL[i] : `Tiny ${s}`;
  };

  // One-off sizes at or below body text are usually tweaks, not part of the type scale.
  const keep = [...textUses.values()].filter((u) => u.segs.length >= 2 || u.key.size >= body * 1.2);
  // A new text style starts in Inter Regular, which must be loaded before its font can change.
  await figma.loadFontAsync({ family: 'Inter', style: 'Regular' });
  const existingText = new Map((await figma.getLocalTextStylesAsync()).map((s) => [s.name, s]));
  const taken = new Set<string>();
  let textCount = 0;
  const groups = new Map<number, typeof keep>();
  for (const u of keep) {
    const s = r2(u.key.size);
    groups.set(s, [...(groups.get(s) ?? []), u]);
  }
  for (const [size, us] of groups) {
    us.sort((a, b) => b.chars - a.chars);
    for (const u of us) {
      let name = `${prefix}/Text/${sizeName(size)}`;
      if (us.length > 1) name += ` · ${u.key.font.style}`;
      if (u.key.textCase === 'UPPER') name += ' · Caps';
      if (u.key.decoration === 'UNDERLINE') name += ' · Underline';
      let unique = name;
      for (let i = 2; taken.has(unique); i++) unique = `${name} ${i}`;
      taken.add(unique);
      let style = existingText.get(unique);
      if (!style || textKey({ font: style.fontName, size: style.fontSize, lineHeight: style.lineHeight, letterSpacing: style.letterSpacing, decoration: style.textDecoration, textCase: style.textCase }) !== textKey(u.key)) {
        if (style) {
          let i = 2;
          while (existingText.has(`${unique} ${i}`) || taken.has(`${unique} ${i}`)) i++;
          unique = `${unique} ${i}`;
          taken.add(unique);
        }
        style = figma.createTextStyle();
        style.name = unique;
        style.fontName = u.key.font;
        style.fontSize = u.key.size;
        style.lineHeight = u.key.lineHeight;
        style.letterSpacing = u.key.letterSpacing;
        style.textDecoration = u.key.decoration;
        style.textCase = u.key.textCase;
        textCount++;
      }
      for (const seg of u.segs) {
        if (seg.node.getRangeTextStyleId(seg.start, seg.end) === style.id) continue; // inherited from the main component
        await seg.node.setRangeTextStyleIdAsync(seg.start, seg.end, style.id);
      }
    }
  }

  // --- Color styles for every color used more than once, most used first.
  const existingPaint = new Map((await figma.getLocalPaintStylesAsync()).map((s) => [s.name, s]));
  let colorCount = 0;
  const colors = [...colorUses.entries()]
    .map(([k, u]) => ({ k, u, uses: u.fills.length + u.strokes.length + u.text.length }))
    .filter((c) => c.uses >= 2)
    .sort((a, b) => b.uses - a.uses);
  for (const { k, u } of colors) {
    const name = `${prefix}/Color/${k}`;
    let style = existingPaint.get(name);
    if (!style) {
      style = figma.createPaintStyle();
      style.name = name;
      style.paints = [{ type: 'SOLID', color: { ...u.paint.color }, opacity: u.paint.opacity ?? 1 }];
      colorCount++;
    }
    for (const n of u.fills) if (n.fillStyleId !== style.id) await n.setFillStyleIdAsync(style.id);
    for (const n of u.strokes) if (n.strokeStyleId !== style.id) await n.setStrokeStyleIdAsync(style.id);
    for (const seg of u.text) {
      if (seg.node.getRangeFillStyleId(seg.start, seg.end) === style.id) continue;
      await seg.node.setRangeFillStyleIdAsync(seg.start, seg.end, style.id);
    }
  }
  return { text: textCount, color: colorCount };
}
