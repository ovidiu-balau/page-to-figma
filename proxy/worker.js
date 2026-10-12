// CORS proxy for the Page to Figma plugin, as a Cloudflare Worker (free tier is plenty).
//
//   npx wrangler deploy proxy/worker.js --name page-to-figma-proxy --compatibility-date 2026-01-01
//
// Then paste the worker URL into the plugin's Options > CORS proxy URL. Requests look like
// https://<worker>/?url=<encoded target>. Only GET is relayed, nothing is stored, and cookies are
// never forwarded, so it cannot act as you on other sites.
const MAX_BYTES = 25 * 1024 * 1024;

export default {
  async fetch(request) {
    const cors = {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, OPTIONS',
      'access-control-allow-headers': '*',
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (request.method !== 'GET') return new Response('Only GET is supported', { status: 405, headers: cors });
    const target = new URL(request.url).searchParams.get('url');
    let url;
    try {
      url = new URL(target ?? '');
    } catch {
      return new Response('Pass the page to fetch as ?url=', { status: 400, headers: cors });
    }
    if (!/^https?:$/.test(url.protocol)) return new Response('Only http and https URLs', { status: 400, headers: cors });
    const upstream = await fetch(url.href, {
      redirect: 'follow',
      headers: {
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36',
        accept: request.headers.get('accept') ?? '*/*',
        'accept-language': request.headers.get('accept-language') ?? 'en',
      },
    });
    const length = Number(upstream.headers.get('content-length') ?? 0);
    if (length > MAX_BYTES) return new Response('Resource too large', { status: 413, headers: cors });
    const headers = new Headers(cors);
    for (const h of ['content-type', 'cache-control', 'last-modified', 'etag']) {
      const v = upstream.headers.get(h);
      if (v) headers.set(h, v);
    }
    headers.set('x-final-url', upstream.url);
    return new Response(upstream.body, { status: upstream.status, headers });
  },
};
