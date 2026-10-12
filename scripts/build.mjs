// Bundles the main thread (dist/code.js) and the UI (dist/ui.html, with its script and styles inlined,
// because Figma loads the UI as a single HTML string).
import * as esbuild from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const watch = process.argv.includes('--watch');
const common = { bundle: true, target: 'es2019', logLevel: 'info', legalComments: 'none' };

async function buildUi() {
  const result = await esbuild.build({
    ...common,
    entryPoints: [resolve(root, 'src/ui/ui.ts')],
    format: 'iife',
    target: 'chrome100',
    minify: true,
    write: false,
  });
  // A literal "</script" inside the bundle would end the inline script early.
  const js = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
  const css = await readFile(resolve(root, 'src/ui/styles.css'), 'utf8');
  const template = await readFile(resolve(root, 'src/ui/index.html'), 'utf8');
  const html = template.replace('/*__CSS__*/', () => css).replace('/*__JS__*/', () => js);
  await writeFile(resolve(root, 'dist/ui.html'), html);
  console.log(`  dist/ui.html  ${(html.length / 1024).toFixed(1)}kb`);
}

const mainOptions = {
  ...common,
  entryPoints: [resolve(root, 'src/main/code.ts')],
  outfile: resolve(root, 'dist/code.js'),
  format: 'iife',
};

await mkdir(resolve(root, 'dist'), { recursive: true });
if (watch) {
  const main = await esbuild.context(mainOptions);
  await main.watch();
  const ui = await esbuild.context({
    entryPoints: [resolve(root, 'src/ui/ui.ts')],
    bundle: true,
    write: false,
    plugins: [{ name: 'inline', setup: (b) => b.onEnd(() => buildUi().catch(console.error)) }],
  });
  await ui.watch();
  console.log('watching…');
} else {
  await esbuild.build(mainOptions);
  await buildUi();
}
