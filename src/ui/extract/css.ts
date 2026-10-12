import type { RGBA } from '../../shared/types';

// Split on a separator at parenthesis depth 0 (commas between gradient stops, spaces between tokens).
export function splitTop(value: string, sep: ',' | ' '): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = '';
  let cur = '';
  for (const ch of value) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    const isSep = sep === ' ' ? /\s/.test(ch) : ch === sep;
    if (isSep && depth === 0) {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export function px(value: string | null | undefined): number {
  const n = parseFloat(value ?? '');
  return Number.isFinite(n) ? n : 0;
}

let canvasCtx: CanvasRenderingContext2D | null = null;
const colorCache = new Map<string, RGBA | null>();

const RGB_RE = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/i;

// Parses any CSS color the browser understands. Modern spaces (oklch, lab, color(display-p3 …)) go
// through a canvas so they come back as sRGB, the same way the browser paints them.
export function parseColor(input: string | null | undefined): RGBA | null {
  if (!input) return null;
  const value = input.trim();
  if (!value || value === 'none') return null;
  if (value === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  const cached = colorCache.get(value);
  if (cached !== undefined) return cached;
  let result: RGBA | null = null;
  const m = value.match(RGB_RE);
  if (m) {
    const alpha = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    result = { r: +m[1] / 255, g: +m[2] / 255, b: +m[3] / 255, a: alpha };
  } else {
    if (!canvasCtx) {
      const c = document.createElement('canvas');
      c.width = c.height = 1;
      canvasCtx = c.getContext('2d', { willReadFrequently: true });
    }
    const ctx = canvasCtx!;
    ctx.fillStyle = '#010203';
    ctx.fillStyle = value;
    const accepted = ctx.fillStyle !== '#010203' || value.toLowerCase() === '#010203';
    if (accepted) {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillRect(0, 0, 1, 1);
      const d = ctx.getImageData(0, 0, 1, 1).data;
      const a = d[3] / 255;
      // getImageData returns premultiplied-then-unpremultiplied bytes; low alpha loses precision but stays close.
      result = a === 0 ? { r: 0, g: 0, b: 0, a: 0 } : { r: d[0] / 255, g: d[1] / 255, b: d[2] / 255, a };
    }
  }
  colorCache.set(value, result);
  return result;
}

export function visible(c: RGBA | null | undefined): c is RGBA {
  return !!c && c.a > 0.001;
}

export function withAlpha(c: RGBA, opacity: number): RGBA {
  return { ...c, a: c.a * opacity };
}

// CSS <length> or <percentage> resolved against a reference size.
export function lengthOrPercent(token: string, reference: number, fontSize = 16): number | null {
  const t = token.trim();
  if (t.endsWith('%')) return (parseFloat(t) / 100) * reference;
  if (t.endsWith('px')) return parseFloat(t);
  if (t.endsWith('rem')) return parseFloat(t) * 16;
  if (t.endsWith('em')) return parseFloat(t) * fontSize;
  if (/^-?[\d.]+$/.test(t)) return parseFloat(t);
  return null;
}

export function angleToDegrees(token: string): number | null {
  const t = token.trim().toLowerCase();
  const n = parseFloat(t);
  if (!Number.isFinite(n)) return null;
  if (t.endsWith('deg')) return n;
  if (t.endsWith('grad')) return n * 0.9;
  if (t.endsWith('rad')) return (n * 180) / Math.PI;
  if (t.endsWith('turn')) return n * 360;
  if (n === 0) return 0;
  return null;
}
