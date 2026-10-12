#!/usr/bin/env node
// MCP server for the Claude desktop app: gives Claude a `send_to_figma` tool, so "send this to Figma"
// in a chat puts the artifact into the Page to Figma plugin as editable layers. No dependencies; it
// speaks MCP (JSON-RPC over stdio) directly and hands pages to the local relay, starting the relay
// if it is not running.
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';

const here = dirname(fileURLToPath(import.meta.url));
// In the repo the shared code lives in ../scripts and ../relay; the .mcpb bundle carries copies beside this file.
const lib = existsSync(join(here, 'lib', 'page.mjs')) ? join(here, 'lib', 'page.mjs') : join(here, '..', 'scripts', 'lib', 'page.mjs');
const relayScript = existsSync(join(here, 'relay.mjs')) ? join(here, 'relay.mjs') : join(here, '..', 'relay', 'server.mjs');
const { ensureRelay, pageFromFile, pageFromUrl, postCapture, reactPage, relayHealth } = await import(pathToFileURL(lib).href);

const VERSION = '1.1.0';
const PLUGIN_HINT = 'In Figma desktop, open Plugins > Page to Figma (or Plugins > Development > Page to Figma).';

const TOOLS = [
  {
    name: 'send_to_figma',
    title: 'Send to Figma',
    description:
      'Send a design into Figma as editable layers (frames, text, Auto Layout, components) through the Page to Figma plugin. ' +
      'Use when the user asks to send, put, export or import something into Figma. Give exactly one source: ' +
      '`react` for a React artifact (pass the complete component source as written, with its imports and default export; Tailwind classes work), ' +
      '`html` for an HTML artifact or any complete HTML document (inline its CSS), ' +
      '`url` for a public web page, or `path` for an HTML file on this computer. ' +
      'Always pass the full, final code, never a summary or an excerpt. It arrives as a new frame in the open Figma file.',
    inputSchema: {
      type: 'object',
      properties: {
        react: { type: 'string', description: 'Full source of a React component with a default export.' },
        html: { type: 'string', description: 'A complete HTML document.' },
        url: { type: 'string', description: 'A public http(s) page to fetch.' },
        path: { type: 'string', description: 'Absolute path to an HTML file on this computer.' },
        title: { type: 'string', description: 'Name for the Figma frame, e.g. the artifact title.' },
        width: { type: 'number', description: 'Viewport width in px. 1440 for desktop designs (default), 390 for mobile.' },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: 'figma_status',
    title: 'Figma connection status',
    description: 'Check whether the Page to Figma plugin is open and ready to receive designs.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
  },
];

const text = (t, isError = false) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });

async function sendToFigma(a) {
  const sources = ['react', 'html', 'url', 'path'].filter((k) => typeof a[k] === 'string' && a[k].trim());
  if (sources.length !== 1) return text('Give exactly one of react, html, url or path.', true);
  const width = Math.round(Math.min(3840, Math.max(240, Number(a.width) || 1440)));
  let html;
  let base = '';
  let title = a.title?.trim();
  if (a.react) html = reactPage(a.react, title || 'Component');
  else if (a.html) html = a.html;
  else if (a.url) {
    if (!/^https?:\/\//i.test(a.url)) return text('url must start with http:// or https://', true);
    ({ html, base } = await pageFromUrl(a.url));
    title ||= new URL(base).hostname;
  } else {
    html = /\.[jt]sx$/i.test(a.path) ? reactPage(await readFile(a.path, 'utf8'), title || 'Component') : await pageFromFile(a.path);
    title ||= basename(a.path).replace(/\.[^.]+$/, '');
  }
  title ||= html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim() || 'Design';
  if (!(await ensureRelay(relayScript))) {
    return text('Could not start the local relay on port 7801. Ask the user to run: npm run relay (in the Page to Figma folder).', true);
  }
  const { listeners } = await postCapture({ html, title, width, base });
  return text(
    listeners
      ? `Sent "${title}" to Figma (${width}px wide). It is being imported into the open file now as a new frame.`
      : `Queued "${title}". Figma is not listening yet: ${PLUGIN_HINT} It imports as soon as the plugin opens (within the hour).`,
  );
}

async function status() {
  const health = await relayHealth();
  if (!health) return text(`The relay is not running yet; it starts automatically on the first send. ${PLUGIN_HINT}`);
  return text(health.listeners ? 'Ready: the Page to Figma plugin is open in Figma.' : `The relay is running but the plugin is not open. ${PLUGIN_HINT}`);
}

async function call(method, params) {
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'page-to-figma', title: 'Page to Figma', version: VERSION },
        instructions: 'Use send_to_figma when the user wants a design, artifact or page in Figma.',
      };
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: TOOLS };
    case 'tools/call': {
      const args = params?.arguments ?? {};
      try {
        if (params?.name === 'send_to_figma') return await sendToFigma(args);
        if (params?.name === 'figma_status') return await status();
      } catch (err) {
        return text(err instanceof Error ? err.message : String(err), true);
      }
      throw Object.assign(new Error(`Unknown tool: ${params?.name}`), { code: -32602 });
    }
    default:
      throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
  }
}

const write = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', async (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  if (msg.id === undefined || msg.id === null) return; // notifications need no answer
  try {
    write({ jsonrpc: '2.0', id: msg.id, result: await call(msg.method, msg.params) });
  } catch (err) {
    write({ jsonrpc: '2.0', id: msg.id, error: { code: err.code ?? -32603, message: err.message } });
  }
});
