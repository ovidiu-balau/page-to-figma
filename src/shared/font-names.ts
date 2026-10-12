// Font stack helpers shared by the UI (mapping sheet) and the main thread (resolution).

// System and generic names never appear in Figma's font list, so they map to sensible installed fonts.
export const GENERIC_FALLBACKS: Record<string, string[]> = {
  'sans-serif': ['Inter', 'Roboto', 'Arial'],
  'system-ui': ['SF Pro', 'SF Pro Text', 'Inter', 'Roboto'],
  '-apple-system': ['SF Pro', 'SF Pro Text', 'Inter'],
  'blinkmacsystemfont': ['SF Pro', 'SF Pro Text', 'Inter'],
  'ui-sans-serif': ['SF Pro', 'SF Pro Text', 'Inter', 'Roboto'],
  'segoe ui': ['Segoe UI', 'Inter'],
  'serif': ['Noto Serif', 'Georgia', 'Times New Roman', 'Inter'],
  'ui-serif': ['Noto Serif', 'Georgia', 'Inter'],
  'monospace': ['Roboto Mono', 'JetBrains Mono', 'Source Code Pro', 'Courier New', 'Inter'],
  'ui-monospace': ['SF Mono', 'Roboto Mono', 'JetBrains Mono', 'Inter'],
  'sfmono-regular': ['SF Mono', 'Roboto Mono', 'Inter'],
  'cursive': ['Inter'],
  'fantasy': ['Inter'],
  'emoji': ['Inter'],
  'apple color emoji': ['Inter'],
  'segoe ui emoji': ['Inter'],
  'segoe ui symbol': ['Inter'],
  'noto color emoji': ['Inter'],
};

export function splitStack(stack: string): string[] {
  return stack
    .split(',')
    .map((s) => s.trim().replace(/^["']|["']$/g, '').trim())
    .filter(Boolean);
}

export function isGeneric(name: string): boolean {
  const lower = name.toLowerCase();
  return lower in GENERIC_FALLBACKS || lower.startsWith('ui-');
}

export function firstNamedFamily(stack: string): string | undefined {
  return splitStack(stack).find((n) => !isGeneric(n));
}
