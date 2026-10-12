import type { Fill, GradientStop, RGBA } from '../../shared/types';
import { angleToDegrees, lengthOrPercent, parseColor, splitTop } from './css';

type Matrix = [[number, number, number], [number, number, number]];

function invert(m: Matrix): Matrix {
  const [[a, b, c], [d, e, f]] = m;
  const det = a * e - b * d || 1e-9;
  return [
    [e / det, -b / det, (b * f - c * e) / det],
    [-d / det, a / det, (c * d - a * f) / det],
  ];
}

// M maps Figma gradient space into the node's unit square; Figma wants the inverse.
function fromGradientSpace(ax: number, ay: number, bx: number, by: number, tx: number, ty: number): Matrix {
  return invert([
    [ax, bx, tx],
    [ay, by, ty],
  ]);
}

interface RawStop {
  color: RGBA;
  pos: number | null; // px along the gradient line, or null when omitted
}

function parseStops(args: string[], lineLength: number, fontSize: number): GradientStop[] | null {
  const raw: RawStop[] = [];
  for (const arg of args) {
    const tokens = splitTop(arg, ' ');
    const positions: number[] = [];
    const colorTokens: string[] = [];
    for (const t of tokens) {
      const l = /^-?[\d.]+(px|%|r?em)?$/.test(t)
        ? lengthOrPercent(t, lineLength, fontSize)
        : /^-?[\d.]+(deg|turn|g?rad)$/.test(t)
          ? (angleToDegrees(t)! / 360) * lineLength // conic stops, measured on a 360-unit line
          : null;
      if (l !== null && colorTokens.length + positions.length > 0) positions.push(l);
      else if (l !== null && tokens.length === 1) positions.push(l); // color hint
      else colorTokens.push(t);
    }
    if (!colorTokens.length) continue; // interpolation hints are dropped
    const color = parseColor(colorTokens.join(' '));
    if (!color) continue;
    if (!positions.length) raw.push({ color, pos: null });
    for (const p of positions) raw.push({ color, pos: p });
  }
  if (raw.length < 2) return raw.length === 1 ? [{ color: raw[0].color, position: 0 }, { color: raw[0].color, position: 1 }] : null;
  if (raw[0].pos === null) raw[0].pos = 0;
  if (raw[raw.length - 1].pos === null) raw[raw.length - 1].pos = lineLength;
  for (let i = 1; i < raw.length; i++) {
    if (raw[i].pos !== null) raw[i].pos = Math.max(raw[i].pos!, raw[i - 1].pos!);
  }
  for (let i = 1; i < raw.length; i++) {
    if (raw[i].pos !== null) continue;
    let j = i;
    while (raw[j].pos === null) j++;
    const start = raw[i - 1].pos!;
    const step = (raw[j].pos! - start) / (j - i + 1);
    for (let k = i; k < j; k++) raw[k].pos = start + step * (k - i + 1);
  }
  const len = lineLength || 1;
  return raw.map((s) => ({ color: s.color, position: Math.min(1, Math.max(0, s.pos! / len)) }));
}

function cornerAngle(dir: string, w: number, h: number): number | null {
  const words = dir.replace(/^to\s+/, '').split(/\s+/).sort().join(' ');
  const diag = (Math.atan2(h, w) * 180) / Math.PI;
  switch (words) {
    case 'top': return 0;
    case 'right': return 90;
    case 'bottom': return 180;
    case 'left': return 270;
    case 'right top': return diag;
    case 'bottom right': return 180 - diag;
    case 'bottom left': return 180 + diag;
    case 'left top': return 360 - diag;
  }
  return null;
}

function linear(args: string[], w: number, h: number, fontSize: number): Fill | null {
  let angle = 180;
  if (args.length) {
    const first = args[0].trim();
    if (first.startsWith('to ')) {
      angle = cornerAngle(first, w, h) ?? 180;
      args = args.slice(1);
    } else {
      const a = angleToDegrees(first);
      if (a !== null && !parseColor(first)) {
        angle = a;
        args = args.slice(1);
      }
    }
  }
  const rad = (angle * Math.PI) / 180;
  const sin = Math.sin(rad);
  const cos = Math.cos(rad);
  const L = Math.abs(w * sin) + Math.abs(h * cos);
  const stops = parseStops(args, L, fontSize);
  if (!stops) return null;
  // Gradient line in pixels, centered in the box, pointing along (sin, -cos).
  const x0 = w / 2 - (sin * L) / 2;
  const y0 = h / 2 + (cos * L) / 2;
  const dx = sin * L;
  const dy = -cos * L;
  const W = w || 1;
  const H = h || 1;
  const ax = dx / W;
  const ay = dy / H;
  const bx = -dy / W;
  const by = dx / H;
  return {
    kind: 'linear',
    stops,
    transform: fromGradientSpace(ax, ay, bx, by, x0 / W - 0.5 * bx, y0 / H - 0.5 * by),
  };
}

function parsePosition(tokens: string[], w: number, h: number, fontSize: number): [number, number] {
  let x = w / 2;
  let y = h / 2;
  const kw: Record<string, [string, number]> = {
    left: ['x', 0], right: ['x', 1], top: ['y', 0], bottom: ['y', 1], center: ['c', 0.5],
  };
  const nums: number[] = [];
  const axes: string[] = [];
  for (const t of tokens) {
    if (t in kw) {
      const [axis, f] = kw[t];
      if (axis === 'x') x = f * w;
      else if (axis === 'y') y = f * h;
      axes.push(axis);
    } else {
      nums.push(axes.length);
      const ref = nums.length === 1 && !axes.includes('x') ? w : h;
      const v = lengthOrPercent(t, ref, fontSize) ?? 0;
      if (nums.length === 1 && !axes.includes('x')) x = v;
      else y = v;
    }
  }
  return [x, y];
}

function radialOrConic(kind: 'radial' | 'conic', args: string[], w: number, h: number, fontSize: number): Fill | null {
  let cx = w / 2;
  let cy = h / 2;
  let shape = 'ellipse';
  let size = 'farthest-corner';
  let explicit: number[] = [];
  let from = 0;
  const first = args[0]?.trim() ?? '';
  const isPrelude = /^(circle|ellipse|closest|farthest|at\s|from\s|-?[\d.]+(px|%|r?em)\b)/.test(first) && !parseColor(first);
  if (isPrelude) {
    args = args.slice(1);
    const [before, after] = first.split(/\bat\b/);
    if (after) [cx, cy] = parsePosition(after.trim().split(/\s+/), w, h, fontSize);
    for (const t of before.trim().split(/\s+/).filter(Boolean)) {
      if (t === 'circle' || t === 'ellipse') shape = t;
      else if (/^(closest|farthest)-(side|corner)$/.test(t)) size = t;
      else if (t === 'from') continue;
      else if (kind === 'conic' && angleToDegrees(t) !== null && /deg|rad|turn|grad/.test(t)) from = angleToDegrees(t)!;
      else {
        const v = lengthOrPercent(t, explicit.length === 0 ? w : h, fontSize);
        if (v !== null) explicit.push(v);
      }
    }
  }
  const W = w || 1;
  const H = h || 1;
  if (kind === 'conic') {
    const stops = parseStops(args, 360, fontSize); // positions in % or deg both land on 0..1 via 360 reference
    if (!stops) return null;
    const r = Math.max(W, H);
    const t = ((from - 90) * Math.PI) / 180;
    const cos = Math.cos(t);
    const sin = Math.sin(t);
    // Rotate in pixel space so angles stay true on non-square boxes, then normalise to the unit square.
    const ax = (r * cos) / W;
    const ay = (r * sin) / H;
    const bx = (-r * sin) / W;
    const by = (r * cos) / H;
    return {
      kind: 'angular',
      stops,
      transform: fromGradientSpace(ax, ay, bx, by, cx / W - 0.5 * ax - 0.5 * bx, cy / H - 0.5 * ay - 0.5 * by),
    };
  }
  const sides = [cx, w - cx, cy, h - cy].map(Math.abs);
  let rx: number;
  let ry: number;
  if (explicit.length) {
    rx = explicit[0];
    ry = explicit[1] ?? explicit[0];
  } else if (shape === 'circle') {
    const corners = [
      Math.hypot(cx, cy), Math.hypot(w - cx, cy), Math.hypot(cx, h - cy), Math.hypot(w - cx, h - cy),
    ];
    const r =
      size === 'closest-side' ? Math.min(...sides)
      : size === 'farthest-side' ? Math.max(...sides)
      : size === 'closest-corner' ? Math.min(...corners)
      : Math.max(...corners);
    rx = ry = r;
  } else {
    const sx = size.startsWith('closest') ? Math.min(sides[0], sides[1]) : Math.max(sides[0], sides[1]);
    const sy = size.startsWith('closest') ? Math.min(sides[2], sides[3]) : Math.max(sides[2], sides[3]);
    const k = size.endsWith('corner') ? Math.SQRT2 : 1;
    rx = sx * k;
    ry = sy * k;
  }
  const stops = parseStops(args, rx || 1, fontSize);
  if (!stops) return null;
  const ax = (2 * rx) / W;
  const by = (2 * ry) / H;
  return {
    kind: 'radial',
    stops,
    transform: fromGradientSpace(ax, 0, 0, by, cx / W - 0.5 * ax, cy / H - 0.5 * by),
  };
}

// Re-expresses a gradient measured on one box in the unit space of another (a gradient-clipped span
// inside a larger text node).
export function remapGradient(
  fill: Fill, from: { x: number; y: number; width: number; height: number }, to: { x: number; y: number; width: number; height: number },
): Fill {
  if (fill.kind === 'solid' || fill.kind === 'image' || !from.width || !from.height) return fill;
  const [[a, b, c], [d, e, f]] = fill.transform;
  const sx = to.width / from.width;
  const sy = to.height / from.height;
  const tx = (to.x - from.x) / from.width;
  const ty = (to.y - from.y) / from.height;
  // T · A, where A maps text-node unit space into the span's unit space.
  return {
    ...fill,
    transform: [
      [a * sx, b * sy, a * tx + b * ty + c],
      [d * sx, e * sy, d * tx + e * ty + f],
    ],
  };
}

export function parseGradient(layer: string, w: number, h: number, fontSize = 16): Fill | null {
  const m = layer.match(/^(repeating-)?(linear|radial|conic)-gradient\(([\s\S]*)\)$/);
  if (!m) return null;
  const args = splitTop(m[3], ',');
  if (m[2] === 'linear') return linear(args, w, h, fontSize);
  return radialOrConic(m[2] === 'radial' ? 'radial' : 'conic', args, w, h, fontSize);
}
