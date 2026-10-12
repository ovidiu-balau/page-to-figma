import type { FontRequest, FontResolution } from '../shared/types';
import { GENERIC_FALLBACKS, isGeneric, splitStack } from '../shared/font-names';

interface StyleEntry {
  style: string;
  weight: number;
  italic: boolean;
}

interface FamilyEntry {
  family: string;
  styles: StyleEntry[];
}

const WEIGHT_WORDS: [RegExp, number][] = [
  [/hairline|thin/i, 100],
  [/extra\s*light|ultra\s*light/i, 200],
  [/light/i, 300],
  [/medium/i, 500],
  [/semi\s*bold|demi\s*bold/i, 600],
  [/extra\s*bold|ultra\s*bold/i, 800],
  [/black|heavy/i, 900],
  [/bold/i, 700],
];

let familyIndex: Map<string, FamilyEntry> | null = null;
const loaded = new Map<string, Promise<void>>();

export function styleWeight(style: string): number {
  for (const [re, w] of WEIGHT_WORDS) if (re.test(style)) return w;
  const numeric = style.match(/\b([1-9]00)\b/);
  return numeric ? Number(numeric[1]) : 400;
}

async function index(): Promise<Map<string, FamilyEntry>> {
  if (familyIndex) return familyIndex;
  const fonts = await figma.listAvailableFontsAsync();
  const map = new Map<string, FamilyEntry>();
  for (const f of fonts) {
    const key = f.fontName.family.toLowerCase();
    let entry = map.get(key);
    if (!entry) {
      entry = { family: f.fontName.family, styles: [] };
      map.set(key, entry);
    }
    entry.styles.push({
      style: f.fontName.style,
      weight: styleWeight(f.fontName.style),
      italic: /italic|oblique/i.test(f.fontName.style),
    });
  }
  familyIndex = map;
  return map;
}

function lookup(map: Map<string, FamilyEntry>, name: string): FamilyEntry | undefined {
  const lower = name.toLowerCase();
  const direct = map.get(lower);
  if (direct) return direct;
  const fallbacks = GENERIC_FALLBACKS[lower];
  if (fallbacks) {
    for (const f of fallbacks) {
      const hit = map.get(f.toLowerCase());
      if (hit) return hit;
    }
  }
  return undefined;
}

export async function resolveFonts(requests: FontRequest[]): Promise<FontResolution> {
  const map = await index();
  const families: Record<string, string> = {};
  const missing = new Set<string>();
  for (const req of requests) {
    if (req.family in families) continue;
    const names = splitStack(req.family);
    const firstNamed = names.find((n) => !isGeneric(n));
    let resolved: FamilyEntry | undefined;
    for (const n of names) {
      resolved = lookup(map, n);
      if (resolved) break;
    }
    if (firstNamed && !map.has(firstNamed.toLowerCase())) missing.add(firstNamed);
    families[req.family] = (resolved ?? map.get('inter') ?? map.values().next().value!).family;
  }
  return {
    families,
    missing: [...missing].sort(),
    available: [...map.values()].map((f) => f.family).sort((a, b) => a.localeCompare(b)),
  };
}

export async function pickFont(family: string, weight: number, italic: boolean): Promise<FontName> {
  const map = await index();
  const entry = map.get(family.toLowerCase()) ?? map.get('inter') ?? map.values().next().value!;
  let best = entry.styles[0];
  let bestScore = Infinity;
  for (const s of entry.styles) {
    // Prefer the exact slant, then the closest weight; ties go to the heavier side above 400, like browsers.
    const score =
      (s.italic === italic ? 0 : 1000) +
      Math.abs(s.weight - weight) * 2 +
      (s.weight > weight ? (weight >= 400 ? 0 : 1) : weight >= 400 ? 1 : 0) +
      (/variable/i.test(s.style) ? 5 : 0);
    if (score < bestScore) {
      bestScore = score;
      best = s;
    }
  }
  return { family: entry.family, style: best.style };
}

export function loadFont(font: FontName): Promise<void> {
  const key = `${font.family}::${font.style}`;
  let p = loaded.get(key);
  if (!p) {
    p = figma.loadFontAsync(font);
    loaded.set(key, p);
  }
  return p;
}
