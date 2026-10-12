// Local relay between the browser extension and the Figma plugin. No dependencies.
//
//   node relay/server.mjs            (listens on http://localhost:7801)
//
// POST /captures      a page capture from the extension (chrome-extension:// origin) or from
//                     scripts/send.mjs on this machine (no Origin header)
// GET  /events        the plugin listens here (server-sent events) for new captures
// GET  /captures/:id  the plugin downloads a capture
// GET  /health        liveness check
//
// Captures stay in memory and only on this machine. Old ones are dropped after an hour or when the
// total passes 300 MB.
import http from 'node:http';
import { randomUUID } from 'node:crypto';

const PORT = Number(process.env.H2F_RELAY_PORT ?? 7801);
const MAX_TOTAL = 300 * 1024 * 1024;
const MAX_AGE_MS = 60 * 60 * 1000;

const captures = new Map(); // id -> { meta, body, at, delivered }
const listeners = new Set();

function prune() {
  const now = Date.now();
  let total = 0;
  for (const [id, c] of [...captures].reverse()) {
    total += c.body.length;
    if (now - c.at > MAX_AGE_MS || total > MAX_TOTAL) captures.delete(id);
  }
}

function announce(res, id, c) {
  res.write(`event: capture\ndata: ${JSON.stringify({ id, ...c.meta })}\n\n`);
}

function readBody(req, limit = 400 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('too large'));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function handle(req, res) {
  const origin = req.headers.origin ?? '';
  const fromExtension = origin.startsWith('chrome-extension://');
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  // Reads are open to the plugin (which has a null origin); writes only to the extension and to local
  // command-line senders. Browsers always send an Origin on a cross-origin POST, and a web page cannot
  // send the custom header without a preflight, which is refused here.
  const fromLocalTool = !req.headers.origin;
  res.setHeader('access-control-allow-origin', fromExtension ? origin : '*');
  res.setHeader('access-control-allow-private-network', 'true');
  if (req.method === 'OPTIONS') {
    if (!fromExtension) return res.writeHead(403).end();
    res.writeHead(204, {
      'access-control-allow-methods': 'POST, GET',
      'access-control-allow-headers': 'content-type, x-h2f-capture',
    });
    return res.end();
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, listeners: listeners.size, captures: captures.size }));
  }

  if (req.method === 'GET' && url.pathname === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(': connected\n\n');
    // Captures sent while no plugin was open are delivered on the next connection.
    for (const [id, c] of captures) if (!c.delivered) announce(res, id, c);
    listeners.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => {
      clearInterval(ping);
      listeners.delete(res);
    });
    return;
  }

  const match = url.pathname.match(/^\/captures\/([\w-]+)$/);
  if (req.method === 'GET' && match) {
    const c = captures.get(match[1]);
    if (!c) return res.writeHead(404).end('gone');
    c.delivered = true;
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(c.body);
  }

  if (req.method === 'POST' && url.pathname === '/captures') {
    if (!(fromExtension || fromLocalTool) || req.headers['x-h2f-capture'] !== '1') return res.writeHead(403).end('forbidden');
    try {
      const body = await readBody(req);
      const data = JSON.parse(body.toString('utf8'));
      const id = randomUUID();
      const meta = { title: String(data.title ?? '').slice(0, 200), url: String(data.url ?? ''), width: Number(data.width) || 1440, size: body.length };
      const c = { meta, body, at: Date.now(), delivered: false };
      captures.set(id, c);
      prune();
      for (const l of listeners) announce(l, id, c);
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ id, listeners: listeners.size }));
    } catch (err) {
      return res.writeHead(400).end(String(err.message ?? err));
    }
  }

  res.writeHead(404).end('not found');
}

// Figma only allows localhost (not 127.0.0.1) as a development domain, and localhost can resolve to
// either loopback address, so the relay listens on both. Neither is reachable from other machines.
http.createServer(handle).listen(PORT, '127.0.0.1', () => console.log(`Page to Figma relay on http://localhost:${PORT}`));
http.createServer(handle).listen(PORT, '::1').on('error', () => {
  // no IPv6 loopback on this machine: 127.0.0.1 is enough
});
