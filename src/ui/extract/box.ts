import type { BlendMode, Border, RGBA, Shadow } from '../../shared/types';
import { parseColor, px, splitTop, visible } from './css';

export function parseShadows(value: string, allowInset = true): Shadow[] {
  if (!value || value === 'none') return [];
  const out: Shadow[] = [];
  for (const layer of splitTop(value, ',')) {
    const tokens = splitTop(layer, ' ');
    let inset = false;
    const lengths: number[] = [];
    const colorParts: string[] = [];
    for (const t of tokens) {
      if (t === 'inset') inset = true;
      else if (/^-?[\d.]+(px)?$/.test(t)) lengths.push(parseFloat(t));
      else colorParts.push(t);
    }
    if (inset && !allowInset) continue;
    const color = parseColor(colorParts.join(' ') || 'rgba(0,0,0,1)');
    if (!visible(color) || lengths.length < 2) continue;
    if (lengths.every((l) => l === 0)) continue; // zero-size shadows paint nothing
    out.push({
      type: inset ? 'INNER_SHADOW' : 'DROP_SHADOW',
      color,
      x: lengths[0],
      y: lengths[1],
      blur: lengths[2] ?? 0,
      spread: lengths[3] ?? 0,
    });
  }
  // CSS paints the first shadow on top; Figma paints the last effect on top.
  return out.reverse();
}

export interface FilterResult {
  blur?: number;
  shadows: Shadow[];
  opacity: number;
}

export function parseFilter(value: string): FilterResult {
  const res: FilterResult = { shadows: [], opacity: 1 };
  if (!value || value === 'none') return res;
  const re = /([a-z-]+)\(((?:[^()]|\([^()]*\))*)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(value))) {
    const [, fn, arg] = m;
    if (fn === 'blur') res.blur = px(arg) * 2; // Figma blur radius ≈ 2× the CSS standard deviation
    else if (fn === 'opacity') res.opacity *= arg.trim().endsWith('%') ? parseFloat(arg) / 100 : parseFloat(arg);
    else if (fn === 'drop-shadow') res.shadows.push(...parseShadows(arg, false).map((s) => ({ ...s, spread: 0 })));
  }
  return res;
}

const BLEND: Record<string, BlendMode> = {
  normal: 'NORMAL', multiply: 'MULTIPLY', screen: 'SCREEN', overlay: 'OVERLAY', darken: 'DARKEN',
  lighten: 'LIGHTEN', 'color-dodge': 'COLOR_DODGE', 'color-burn': 'COLOR_BURN', 'hard-light': 'HARD_LIGHT',
  'soft-light': 'SOFT_LIGHT', difference: 'DIFFERENCE', exclusion: 'EXCLUSION', hue: 'HUE',
  saturation: 'SATURATION', color: 'COLOR', luminosity: 'LUMINOSITY',
};

export function blendMode(value: string): BlendMode | undefined {
  const b = BLEND[value];
  return b && b !== 'NORMAL' ? b : undefined;
}

export function parseBorder(cs: CSSStyleDeclaration): Border | undefined {
  const sides = ['Top', 'Right', 'Bottom', 'Left'] as const;
  const widths = sides.map((s) => {
    const style = cs.getPropertyValue(`border-${s.toLowerCase()}-style`);
    return style === 'none' || style === 'hidden' ? 0 : px(cs.getPropertyValue(`border-${s.toLowerCase()}-width`));
  });
  const colors = sides.map((s) => parseColor(cs.getPropertyValue(`border-${s.toLowerCase()}-color`)));
  const active = widths.map((w, i) => w > 0 && visible(colors[i]));
  if (!active.some(Boolean)) return undefined;
  const firstActive = active.indexOf(true);
  let color = colors[firstActive]!;
  const same = (a: RGBA | null, b: RGBA | null) =>
    !!a && !!b && Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b) + Math.abs(a.a - b.a) < 0.01;
  const uniformColor = active.every((on, i) => !on || same(colors[i], color));
  const styleName = cs.getPropertyValue(`border-${sides[firstActive].toLowerCase()}-style`);
  // Browsers shade inset/outset/groove/ridge borders; a mid-tone of the color is the closest flat match.
  if (/inset|outset|groove|ridge/.test(styleName)) {
    for (let i = 0; i < colors.length; i++) {
      const c = colors[i];
      if (c) colors[i] = { r: c.r * 0.5 + 0.4, g: c.g * 0.5 + 0.4, b: c.b * 0.5 + 0.4, a: c.a };
    }
    color = colors[firstActive]!;
  }
  const transparent: RGBA = { r: 0, g: 0, b: 0, a: 0 };
  return {
    top: active[0] ? widths[0] : 0,
    right: active[1] ? widths[1] : 0,
    bottom: active[2] ? widths[2] : 0,
    left: active[3] ? widths[3] : 0,
    color,
    sideColors: uniformColor ? undefined : (colors.map((c, i) => (active[i] ? c! : transparent)) as [RGBA, RGBA, RGBA, RGBA]),
    style: styleName === 'dashed' ? 'dashed' : styleName === 'dotted' ? 'dotted' : 'solid',
  };
}

function cornerRadius(value: string, w: number, h: number): number {
  // Elliptical corners ("10px 20px") collapse to the smaller radius; Figma corners are circular.
  const [hv, vv = hv] = value.trim().split(/\s+/);
  const resolve = (v: string, ref: number) => (v.endsWith('%') ? (parseFloat(v) / 100) * ref : px(v));
  return Math.max(0, Math.min(resolve(hv, w), resolve(vv, h)));
}

export function parseRadius(cs: CSSStyleDeclaration, w: number, h: number): [number, number, number, number] | undefined {
  const r = [
    cornerRadius(cs.borderTopLeftRadius, w, h),
    cornerRadius(cs.borderTopRightRadius, w, h),
    cornerRadius(cs.borderBottomRightRadius, w, h),
    cornerRadius(cs.borderBottomLeftRadius, w, h),
  ] as [number, number, number, number];
  return r.some((v) => v > 0) ? r : undefined;
}
