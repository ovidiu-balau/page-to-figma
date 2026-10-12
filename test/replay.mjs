// Turns test/output/<name>.json into use_figma scripts (each under the 50k character limit):
//   <name>.img-N.js  uploads one image and returns its hash
//   <name>.doc.js    builds the frame with the real builder, given the hashes
//   node test/replay.mjs kitchen-sink [--autolayout] [--hashes='{"id":"hash"}']
import * as esbuild from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const name = args.find((a) => !a.startsWith('--')) ?? 'kitchen-sink';
const autoLayout = args.includes('--autolayout');
const hashes = JSON.parse(args.find((a) => a.startsWith('--hashes='))?.slice(9) ?? '{}');
const LIMIT = 49000;
const outDir = join(root, 'test/output/replay');
await mkdir(outDir, { recursive: true });
const data = JSON.parse(await readFile(join(root, `test/output/${name}.json`), 'utf8'));

// Big images are re-encoded smaller so each upload fits in one script; layout is unaffected.
async function shrink(images) {
  const big = Object.entries(images).filter(([, b64]) => b64.length > LIMIT - 1000);
  if (!big.length) return images;
  const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const page = await browser.newPage();
  const out = { ...images };
  for (const [id, b64] of big) {
    out[id] = await page.evaluate(async (src, limit) => {
      const img = new Image();
      img.src = 'data:image/png;base64,' + src;
      await img.decode();
      for (let scale = 1; scale > 0.05; scale *= 0.75) {
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(img.naturalWidth * scale));
        c.height = Math.max(1, Math.round(img.naturalHeight * scale));
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        const jpg = c.toDataURL('image/jpeg', 0.8).split(',')[1];
        if (jpg.length < limit) return jpg;
      }
      return null;
    }, b64, LIMIT - 1000);
  }
  await browser.close();
  return out;
}

const images = await shrink(data.images);
const files = [];
let i = 0;
for (const [id, b64] of Object.entries(images)) {
  if (!b64 || hashes[id]) continue;
  const file = join(outDir, `${name}.img-${i++}.js`);
  await writeFile(file, `const img = figma.createImage(figma.base64Decode(${JSON.stringify(b64)}));\nreturn { ${JSON.stringify(id)}: img.hash };\n`);
  files.push(file);
}

const bundle = await esbuild.build({ entryPoints: [join(root, 'test/replay-entry.ts')], bundle: true, write: false, minify: true, format: 'iife', target: 'es2019' });
const builder = bundle.outputFiles[0].text;
// Four decimals is far below a pixel and keeps scripts short enough to send inline.
const compact = (v) => JSON.stringify(v, (k, x) => (typeof x === 'number' ? Math.round(x * 1e4) / 1e4 : k === 'href' ? undefined : x));
const run = Date.now().toString(36);
// The builder is sent once and kept in a hidden text layer; each part script evaluates it from there.
const STASH = 'h2f-builder';
await writeFile(join(outDir, `${name}.builder.js`), `await figma.loadFontAsync({ family: 'Inter', style: 'Regular' });
const old = figma.currentPage.findOne((n) => n.name === '${STASH}'); if (old) old.remove();
const t = figma.createText(); t.name = '${STASH}'; t.characters = ${JSON.stringify(builder)}; t.visible = false; t.x = -100000;
return t.id;\n`);
files.push(join(outDir, `${name}.builder.js`));
const load = `new Function(figma.currentPage.findOne((n) => n.name === '${STASH}').characters)();`;
const budget = LIMIT - 2000;
let n = 0;
const emit = async (docName, parent, nodes) => {
  const part = { run, name: docName, parent, nodes };
  const call = `${load}\nreturn await globalThis.__replay(${compact(part)}, ${JSON.stringify(hashes)}, ${JSON.stringify(data.fontRequests ?? [])}, ${autoLayout});\n`;
  const file = join(outDir, `${name}.doc-${n++}.js`);
  await writeFile(file, call);
  files.push(file);
  if (call.length > LIMIT) console.log(`! ${file} is ${call.length} chars, over the limit`);
};
// Children that fit go out in greedy batches; one that does not fit becomes a shell plus its own batches.
async function split(docName, parent, children, path) {
  let batch = [];
  let size = 0;
  const flush = async () => { if (batch.length) await emit(docName, parent, batch); batch = []; size = 0; };
  const later = [];
  for (const [i, child] of children.entries()) {
    const len = compact(child).length;
    if (len > budget && child.children?.length) {
      const p = `${path}/${i}`;
      const shell = { data: { ...child, children: [] }, path: p };
      if (size + compact(shell).length > budget) await flush();
      batch.push(shell); size += compact(shell).length;
      later.push([child, p]);
      continue;
    }
    if (size + len > budget) await flush();
    batch.push({ data: child, path: null }); size += len;
  }
  await flush();
  for (const [child, p] of later) await split(docName, p, child.children, p);
}
for (const doc of data.docs) await split(doc.name, null, [doc.root], 'root');
await writeFile(join(outDir, `${name}.cleanup.js`), `const marks = figma.currentPage.findAll((n) => n.name.includes(' \\u2063h2f:'));
for (const n of marks) n.name = n.name.slice(0, n.name.indexOf(' \\u2063h2f:'));
figma.currentPage.findOne((n) => n.name === '${STASH}')?.remove();
return marks.length;\n`);
files.push(join(outDir, `${name}.cleanup.js`));
for (const f of files) console.log(`${f}  ${(await readFile(f, 'utf8')).length} chars`);
