// Runs proxy/worker.js on localhost for testing: node test/local-proxy.mjs [port]
import http from 'node:http';
import worker from '../proxy/worker.js';

const port = Number(process.argv[2] ?? 8787);
http.createServer(async (req, res) => {
  const response = await worker.fetch(new Request(`http://127.0.0.1:${port}${req.url}`, { method: req.method, headers: req.headers }));
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}).listen(port, '127.0.0.1', () => console.log(`proxy on http://127.0.0.1:${port}/`));
