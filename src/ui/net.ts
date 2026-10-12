const TIMEOUT_MS = 20000;

export function proxied(url: string, proxy: string): string {
  const p = proxy.trim();
  if (p.includes('{url}')) return p.replace('{url}', encodeURIComponent(url));
  const sep = p.includes('?') ? (p.endsWith('?') || p.endsWith('&') ? '' : '&') : '?';
  return `${p}${sep}url=${encodeURIComponent(url)}`;
}

async function timedFetch(url: string): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, credentials: 'omit', redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res;
  } finally {
    clearTimeout(timer);
  }
}

// Same-origin and CORS-enabled resources load directly; everything else needs the user's proxy.
export async function fetchResource(url: string, proxy: string): Promise<Response> {
  if (/^(data|blob):/i.test(url)) return timedFetch(url);
  try {
    return await timedFetch(url);
  } catch (direct) {
    if (!proxy.trim()) throw direct;
    return timedFetch(proxied(url, proxy));
  }
}

export async function fetchText(url: string, proxy: string): Promise<string> {
  return (await fetchResource(url, proxy)).text();
}
