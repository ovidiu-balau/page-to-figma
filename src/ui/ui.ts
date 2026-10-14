import { DEFAULT_SETTINGS, type ExistingMode, type FontRequest, type FontResolution, type ImportDocument, type PersistedSettings } from '../shared/types';
import { firstNamedFamily } from '../shared/font-names';
import { extractDocument, materializePseudos } from './extract/walker';
import { ImageRegistry } from './extract/images';
import { detectPages, showPage, type InPage } from './pages';
import { delay, frames, render, type RenderOptions, type Rendered } from './render';
import { findScreen, matchScore, screenNames } from './screens';
import { fromCapture, fromCode, isCapture, loadFiles, loadUrl, type SourceDoc } from './sources';
import { nextMessage, onMain, post, sendDocument } from './transport';

type Tab = PersistedSettings['tab'];
type SourceTab = Exclude<Tab, 'options'>;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const els = {
  status: $('status'),
  importBtn: $<HTMLButtonElement>('import-btn'),
  url: $<HTMLInputElement>('url-input'),
  dark: $<HTMLInputElement>('dark-mode'),
  html: $<HTMLTextAreaElement>('html-input'),
  css: $<HTMLTextAreaElement>('css-input'),
  autoLayout: $<HTMLInputElement>('opt-autolayout'),
  overlays: $<HTMLInputElement>('opt-overlays'),
  components: $<HTMLInputElement>('opt-components'),
  existing: $<HTMLSelectElement>('opt-existing'),
  images: $<HTMLInputElement>('opt-images'),
  tailwind: $<HTMLInputElement>('opt-tailwind'),
  preflight: $<HTMLInputElement>('opt-preflight'),
  twConfig: $<HTMLTextAreaElement>('tailwind-config'),
  fontSize: $<HTMLInputElement>('opt-fontsize'),
  proxy: $<HTMLInputElement>('proxy-url'),
  viewport: $<HTMLSelectElement>('viewport'),
  fileInput: $<HTMLInputElement>('file-input'),
  dropzone: $<HTMLButtonElement>('dropzone'),
  dropTitle: $('dropzone-title'),
  dropDesc: $('dropzone-description'),
  pagesList: $('pages-list'),
  pagesAll: $<HTMLInputElement>('pages-all'),
  pagesSub: $('pages-sub'),
  pagesTitle: $('pages-title'),
  existingSheet: $('existing-sheet'),
  existingList: $('existing-list'),
  existingSub: $('existing-sub'),
  fontSheet: $('font-sheet'),
  fontList: $('font-list'),
  fontCount: $('font-count'),
  renderHost: $('render-host'),
};

let settings: PersistedSettings = { ...DEFAULT_SETTINGS };
let currentTab: Tab = 'url';
let sourceTab: SourceTab = 'url';
let files: File[] = [];
let busy = false;
let cancelled = false;
let picker: { resolve: (picked: boolean) => void } | null = null;

class CancelledImport extends Error {}

function setStatus(text: string, kind: 'info' | 'working' | 'success' | 'error' = 'working'): void {
  els.status.textContent = text;
  els.status.className = `status ${kind}`;
  els.status.title = text;
}

function checkCancelled(): void {
  if (cancelled) throw new CancelledImport();
}

// Settings

function readForm(): PersistedSettings {
  return {
    tab: currentTab,
    url: els.url.value,
    html: els.html.value,
    css: els.css.value,
    darkMode: els.dark.checked,
    autoLayout: els.autoLayout.checked,
    includeImages: els.images.checked,
    hideOverlays: els.overlays.checked,
    components: els.components.checked,
    existing: els.existing.value as ExistingMode,
    tailwind: els.tailwind.checked,
    disablePreflight: els.preflight.checked,
    tailwindConfig: els.twConfig.value,
    rootFontSize: Math.min(200, Math.max(1, Number(els.fontSize.value) || 16)),
    proxyUrl: els.proxy.value.trim(),
    viewport: els.viewport.value,
  };
}

function applySettings(s: PersistedSettings): void {
  settings = { ...DEFAULT_SETTINGS, ...s };
  els.url.value = settings.url;
  els.html.value = settings.html;
  els.css.value = settings.css;
  els.dark.checked = settings.darkMode;
  els.autoLayout.checked = settings.autoLayout;
  els.images.checked = settings.includeImages;
  els.overlays.checked = settings.hideOverlays;
  els.components.checked = settings.components;
  els.existing.value = settings.existing;
  if (!els.existing.value) els.existing.value = 'ask';
  els.tailwind.checked = settings.tailwind;
  els.preflight.checked = settings.disablePreflight;
  els.twConfig.value = settings.tailwindConfig;
  els.fontSize.value = String(settings.rootFontSize);
  els.proxy.value = settings.proxyUrl;
  els.viewport.value = settings.viewport;
  if (!els.viewport.value) els.viewport.value = 'source-default';
  selectTab(settings.tab === 'file' ? 'url' : settings.tab);
}

let saveTimer = 0;
function scheduleSave(): void {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    settings = readForm();
    post({ type: 'save-settings', settings });
  }, 300);
}

// Tabs

const IMPORT_LABEL: Record<SourceTab, () => string> = {
  url: () => 'Import URL',
  file: () => (files.length ? 'Import files' : 'Choose files'),
  code: () => 'Import code',
};

function refreshButton(): void {
  if (busy) return;
  els.importBtn.textContent = IMPORT_LABEL[sourceTab]();
  els.importBtn.classList.remove('cancel');
}

function selectTab(tab: Tab): void {
  currentTab = tab;
  if (tab !== 'options') sourceTab = tab;
  for (const btn of Array.from(document.querySelectorAll<HTMLButtonElement>('.tab'))) {
    const on = btn.dataset.tab === tab;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-selected', String(on));
    btn.tabIndex = on ? 0 : -1;
  }
  for (const panel of Array.from(document.querySelectorAll<HTMLElement>('.panel'))) {
    panel.classList.toggle('active', panel.id === `panel-${tab}`);
  }
  refreshButton();
}

function bindTabs(): void {
  const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>('.tab'));
  tabs.forEach((btn, i) => {
    btn.addEventListener('click', () => {
      if (picker) return;
      selectTab(btn.dataset.tab as Tab);
      scheduleSave();
    });
    btn.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
      next.focus();
      next.click();
    });
  });
  for (const link of Array.from(document.querySelectorAll<HTMLButtonElement>('[data-switch-tab]'))) {
    link.addEventListener('click', () => selectTab(link.dataset.switchTab as Tab));
  }
  for (const clear of Array.from(document.querySelectorAll<HTMLButtonElement>('[data-clear]'))) {
    clear.addEventListener('click', () => {
      const target = $<HTMLInputElement>(clear.dataset.clear!);
      target.value = '';
      target.focus();
      scheduleSave();
    });
  }
}

// Files

function setFiles(list: File[]): void {
  files = list;
  if (!files.length) {
    els.dropTitle.textContent = 'Choose files or drop them here';
    els.dropDesc.textContent = 'HTML files, with their CSS and images, or a ZIP';
  } else {
    const html = files.filter((f) => /\.(html?|zip)$/i.test(f.name));
    els.dropTitle.textContent = files.length === 1 ? files[0].name : `${files.length} files selected`;
    els.dropDesc.textContent = html.length
      ? `${html.map((f) => f.name).slice(0, 3).join(', ')}${html.length > 3 ? ` and ${html.length - 3} more` : ''}. Click to change.`
      : 'No HTML or ZIP file in this selection yet.';
  }
  refreshButton();
}

function bindFiles(): void {
  els.dropzone.addEventListener('click', () => els.fileInput.click());
  els.fileInput.addEventListener('change', () => setFiles(Array.from(els.fileInput.files ?? [])));
  const panel = $('panel-file');
  panel.addEventListener('dragover', (e) => {
    e.preventDefault();
    els.dropzone.classList.add('dragging');
  });
  panel.addEventListener('dragleave', () => els.dropzone.classList.remove('dragging'));
  panel.addEventListener('drop', (e) => {
    e.preventDefault();
    els.dropzone.classList.remove('dragging');
    setFiles(Array.from(e.dataTransfer?.files ?? []));
  });
}

// Import pipeline

function viewportSize(): { width: number; height: number } {
  const v = els.viewport.value;
  const width = v === 'source-default' ? 1440 : Number(v) || 1440;
  const heights: Record<number, number> = { 1920: 1080, 1440: 900, 1024: 768, 768: 1024, 390: 844 };
  return { width, height: heights[width] ?? 900 };
}

function renderOptions(): RenderOptions {
  const s = readForm();
  return {
    ...viewportSize(),
    darkMode: sourceTab === 'url' ? s.darkMode : false,
    tailwind: s.tailwind,
    disablePreflight: s.disablePreflight,
    tailwindConfig: s.tailwindConfig,
    rootFontSize: s.rootFontSize,
  };
}

async function loadSources(): Promise<SourceDoc[]> {
  const s = readForm();
  if (sourceTab === 'url') {
    if (!s.url.trim()) throw new Error('Enter a URL to import.');
    return [await loadUrl(s.url, s.proxyUrl, (m) => setStatus(m))];
  }
  if (sourceTab === 'code') {
    if (!s.html.trim()) throw new Error('Paste some HTML to import.');
    return [fromCode(s.html, s.css)];
  }
  if (!files.length) throw new Error('Choose at least one HTML or ZIP file.');
  return loadFiles(files, (m) => setStatus(m));
}

interface Candidate {
  docIndex: number;
  page: InPage | null;
  region?: Element[]; // one screen of a long page
  name: string;
  source: string;
  selected: boolean;
}

// Pages or screens asked for by name ("send the Payment screen"): in-page pages first, then labelled
// screens. Returns what was found and the names that matched nothing.
function pickByName(docIndex: number, source: SourceDoc, pages: InPage[], r: Rendered): { found: Candidate[]; missing: string[] } {
  const found: Candidate[] = [];
  const missing: string[] = [];
  for (const want of source.only ?? []) {
    const page = pages.length >= 2
      ? pages.map((p) => ({ p, score: matchScore(want, p.name) })).filter((m) => m.score).sort((a, b) => b.score - a.score)[0]?.p
      : undefined;
    if (page) {
      found.push({ docIndex, page, name: page.name, source: source.name, selected: true });
      continue;
    }
    const screen = findScreen(r.doc, r.win, want);
    if (screen) found.push({ docIndex, page: null, region: screen.els, name: `${source.name} / ${screen.name}`, source: source.name, selected: true });
    else missing.push(want);
  }
  return { found, missing };
}

// Asks whether frames that are already on the page are replaced or kept beside a new copy.
function askExisting(names: string[]): Promise<'replace' | 'copy' | null> {
  els.existingList.innerHTML = '';
  for (const n of names) {
    const row = document.createElement('div');
    row.className = 'existing-row';
    row.textContent = n;
    row.title = n;
    els.existingList.appendChild(row);
  }
  els.existingSub.textContent = names.length === 1
    ? 'A frame with this name is already on this page. Replace it in place, or add a new copy beside it?'
    : `${names.length} frames with these names are already on this page. Replace them in place, or add new copies beside them?`;
  els.existingSheet.hidden = false;
  setStatus('Already in Figma: replace or add a copy?', 'info');
  return new Promise((resolve) => {
    const close = (value: 'replace' | 'copy' | null) => {
      els.existingSheet.hidden = true;
      for (const id of ['existing-replace', 'existing-copy', 'existing-close']) $(id).onclick = null;
      resolve(value);
    };
    $('existing-replace').onclick = () => close('replace');
    $('existing-copy').onclick = () => close('copy');
    $('existing-close').onclick = () => close(null);
  });
}

// Page picker: thumbnails are live, scaled-down renders of each page.
async function pickPages(candidates: Candidate[], sources: SourceDoc[], opts: RenderOptions): Promise<boolean> {
  const previews: Rendered[] = [];
  els.pagesList.innerHTML = '';
  els.pagesTitle.textContent = `${candidates.length} pages found`;
  const thumbs: { el: HTMLElement; c: Candidate }[] = [];
  const update = () => {
    const n = candidates.filter((c) => c.selected).length;
    els.importBtn.textContent = n === 1 ? 'Import 1 page' : `Import ${n} pages`;
    els.importBtn.disabled = n === 0;
    els.pagesAll.checked = n === candidates.length;
    els.pagesAll.indeterminate = n > 0 && n < candidates.length;
  };
  for (const c of candidates) {
    const li = document.createElement('li');
    li.className = 'page-card';
    const thumb = document.createElement('div');
    thumb.className = 'page-thumb';
    thumb.innerHTML = '<span class="loading">Loading preview…</span>';
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.className = 'check';
    check.checked = c.selected;
    check.setAttribute('aria-label', `Import ${c.name}`);
    check.addEventListener('change', () => {
      c.selected = check.checked;
      li.classList.toggle('off', !c.selected);
      update();
    });
    thumb.addEventListener('click', (e) => {
      if (e.target !== check) check.click();
    });
    thumb.appendChild(check);
    const meta = document.createElement('div');
    meta.className = 'page-meta';
    const name = document.createElement('input');
    name.className = 'page-name';
    name.value = c.name;
    name.setAttribute('aria-label', 'Page name');
    name.addEventListener('input', () => (c.name = name.value.trim() || c.name));
    const source = document.createElement('span');
    source.className = 'page-source';
    source.textContent = c.source;
    meta.append(name, source);
    li.append(thumb, meta);
    els.pagesList.appendChild(li);
    thumbs.push({ el: thumb, c });
  }
  els.pagesAll.onchange = () => {
    for (const c of candidates) c.selected = els.pagesAll.checked;
    for (const li of Array.from(els.pagesList.children)) {
      li.classList.toggle('off', !els.pagesAll.checked);
      (li.querySelector('.check') as HTMLInputElement).checked = els.pagesAll.checked;
    }
    update();
  };
  for (const panel of Array.from(document.querySelectorAll<HTMLElement>('.panel'))) panel.classList.toggle('active', panel.id === 'panel-pages');
  els.importBtn.classList.remove('cancel');
  update();
  setStatus('Choose the pages to import', 'info');

  const chosen = new Promise<boolean>((resolve) => {
    picker = { resolve };
    $('pages-back').onclick = () => resolve(false);
  });
  // Previews render one at a time in the background while the user decides.
  void (async () => {
    for (const { el, c } of thumbs) {
      if (!picker) break;
      try {
        const r = await render(sources[c.docIndex], opts, el);
        previews.push(r);
        if (c.page) {
          const pages = detectPages(r.doc, r.win);
          const match = pages[c.page.index];
          if (match) showPage(match, pages, r.win);
        }
        const scale = el.clientWidth / opts.width;
        r.iframe.style.transform = `scale(${scale})`;
        el.querySelector('.loading')?.remove();
      } catch {
        el.querySelector('.loading')!.textContent = 'No preview';
      }
    }
  })();
  const ok = await chosen;
  picker = null;
  els.importBtn.disabled = false;
  for (const p of previews) p.dispose();
  return ok;
}

function fontSheet(resolution: FontResolution): Promise<Record<string, string> | null> {
  els.fontList.innerHTML = '';
  els.fontCount.textContent = String(resolution.missing.length);
  const selects = new Map<string, HTMLSelectElement>();
  const options = resolution.available.map((f) => `<option>${f.replace(/</g, '&lt;')}</option>`).join('');
  for (const family of resolution.missing) {
    const row = document.createElement('div');
    row.className = 'font-row';
    const from = document.createElement('span');
    from.className = 'from';
    from.textContent = family;
    from.title = family;
    from.style.fontFamily = `"${family}", var(--font)`;
    const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    arrow.setAttribute('viewBox', '0 0 16 16');
    arrow.innerHTML = '<path d="M3 8h10M9.5 4.5 13 8l-3.5 3.5"/>';
    const select = document.createElement('select');
    select.innerHTML = options;
    const stack = Object.keys(resolution.families).find((s) => firstNamedFamily(s) === family);
    select.value = (stack && resolution.families[stack]) || 'Inter';
    row.append(from, arrow, select);
    els.fontList.appendChild(row);
    selects.set(family, select);
  }
  els.fontSheet.hidden = false;
  return new Promise((resolve) => {
    const close = (value: Record<string, string> | null) => {
      els.fontSheet.hidden = true;
      $('font-apply').onclick = null;
      $('font-close').onclick = null;
      resolve(value);
    };
    $('font-apply').onclick = () => close(Object.fromEntries([...selects].map(([k, s]) => [k, s.value])));
    $('font-close').onclick = () => close(null);
  });
}

function mergeFonts(all: FontRequest[][]): FontRequest[] {
  const map = new Map<string, FontRequest>();
  for (const list of all) for (const f of list) map.set(`${f.family}|${f.weight}|${f.italic}`, f);
  return [...map.values()];
}

async function runImport(preset?: SourceDoc[]): Promise<void> {
  busy = true;
  cancelled = false;
  els.importBtn.textContent = 'Cancel';
  els.importBtn.classList.add('cancel');
  const rendered: Rendered[] = [];
  const s = readForm();
  try {
    const opts = renderOptions();
    const sources = preset ?? (await loadSources());
    if (preset) {
      opts.darkMode = false;
      if (sources[0]?.width) opts.width = Math.round(sources[0].width);
    }
    checkCancelled();

    const candidates: Candidate[] = [];
    const pagesByDoc: InPage[][] = [];
    const named = sources.some((src) => src.only?.length);
    const notFound: string[] = [];
    for (let i = 0; i < sources.length; i++) {
      setStatus(sources.length > 1 ? `Rendering ${i + 1} of ${sources.length}: ${sources[i].name}` : `Rendering ${sources[i].name}…`);
      const r = await render(sources[i], opts, els.renderHost);
      rendered.push(r);
      checkCancelled();
      const pages = detectPages(r.doc, r.win);
      pagesByDoc.push(pages);
      if (sources[i].only?.length) {
        const { found, missing } = pickByName(i, sources[i], pages, r);
        candidates.push(...found);
        notFound.push(...missing);
        if (!found.length) {
          const names = pages.length >= 2 ? pages.map((p) => p.name) : screenNames(r.doc, r.win);
          throw new Error(
            `Could not find ${missing.map((m) => `"${m}"`).join(' or ')} in ${sources[i].name}.` +
            (names.length ? ` Names on this page: ${names.join(', ')}.` : ''),
          );
        }
      } else if (pages.length >= 2) {
        for (const p of pages) candidates.push({ docIndex: i, page: p, name: p.name, source: `${sources[i].name} · in-page`, selected: true });
      } else {
        candidates.push({ docIndex: i, page: null, name: sources[i].name, source: sources[i].baseUrl ?? sources[i].name, selected: true });
      }
    }

    if (candidates.length > 1 && !named) {
      busy = false;
      const ok = await pickPages(candidates, sources, opts);
      busy = true;
      els.importBtn.textContent = 'Cancel';
      els.importBtn.classList.add('cancel');
      if (!ok) throw new CancelledImport();
    }
    const chosen = candidates.filter((c) => c.selected);

    const registry = new ImageRegistry(s.proxyUrl);
    const docs: { doc: ImportDocument; fonts: FontRequest[] }[] = [];
    for (const [n, c] of chosen.entries()) {
      checkCancelled();
      const r = rendered[c.docIndex];
      const restorePage = c.page ? showPage(c.page, pagesByDoc[c.docIndex], r.win) : null;
      await frames(r.win);
      await delay(c.page ? 200 : 0);
      const restorePseudos = materializePseudos(r.doc, r.win);
      try {
        const prefix = chosen.length > 1 ? `${n + 1}/${chosen.length} ` : '';
        const result = await extractDocument(
          r.win, c.name, opts.width, opts.height,
          { autoLayout: s.autoLayout, includeImages: s.includeImages, proxy: s.proxyUrl, hideOverlays: s.hideOverlays },
          registry, (count) => setStatus(`${prefix}Reading layout… ${count} elements`), c.region,
        );
        if (c.page || c.region) result.doc.group = sources[c.docIndex].name;
        docs.push(result);
      } finally {
        restorePseudos();
        restorePage?.();
      }
    }
    checkCancelled();

    // Frames already on the page with the same name are replaced in place or kept, as the sender or
    // the Options setting says; "ask" leaves it to the person at the canvas.
    const mode = sources.find((src) => src.existing)?.existing ?? s.existing;
    let replace = new Set<string>();
    if (mode !== 'copy') {
      post({ type: 'find-existing', names: docs.map((d) => d.doc.name) });
      const { names } = await nextMessage('existing');
      if (names.length) {
        const choice = mode === 'replace' ? 'replace' : await askExisting(names);
        if (!choice) throw new CancelledImport();
        if (choice === 'replace') replace = new Set(names);
      }
    }
    checkCancelled();

    setStatus('Checking fonts…');
    post({ type: 'check-fonts', requests: mergeFonts(docs.map((d) => d.fonts)) });
    const { resolution } = await nextMessage('fonts');
    const fontMap = { ...resolution.families };
    if (resolution.missing.length) {
      setStatus(`${resolution.missing.length} font${resolution.missing.length > 1 ? 's' : ''} need a replacement`, 'info');
      const mapping = await fontSheet(resolution);
      if (!mapping) throw new CancelledImport();
      for (const stack of Object.keys(fontMap)) {
        const family = firstNamedFamily(stack);
        if (family && mapping[family]) fontMap[stack] = mapping[family];
      }
    }
    checkCancelled();

    let failed = 0;
    let bytes = new Map<string, Uint8Array>();
    if (s.includeImages && registry.pending) {
      const res = await registry.collect((done, total) => setStatus(`Downloading images… ${done}/${total}`));
      bytes = res.images;
      failed = res.failed;
    }
    checkCancelled();

    post({ type: 'begin-batch', total: docs.length });
    for (const [id, data] of bytes) post({ type: 'image', id, bytes: data });
    for (const [n, d] of docs.entries()) {
      checkCancelled();
      const docId = `d${Date.now().toString(36)}${n}`;
      setStatus(docs.length > 1 ? `Creating layers for ${d.doc.name} (${n + 1}/${docs.length})…` : 'Creating layers…');
      await sendDocument(docId, d.doc);
      post({
        type: 'import-doc', docId, fontMap, replace: replace.has(d.doc.name),
        settings: { autoLayout: s.autoLayout, includeImages: s.includeImages, components: s.components },
      });
      const reply = await nextMessage(['doc-done', 'error', 'batch-done']);
      if (reply.type === 'error') throw new Error(reply.message);
      if (reply.type === 'batch-done') throw new CancelledImport();
    }
    post({ type: 'end-batch' });
    const done = await nextMessage('batch-done');
    const verb = replace.size === docs.length ? 'Updated' : 'Imported';
    let what = done.frames === 1 ? `${verb} "${docs[0].doc.name}"` : `${verb} ${done.frames} frames`;
    if (notFound.length) what += `. Not found: ${notFound.join(', ')}`;
    setStatus(failed ? `${what}. ${failed} image${failed > 1 ? 's' : ''} could not be downloaded${s.proxyUrl ? '' : ' (a CORS proxy can help)'}.` : what, 'success');
  } catch (err) {
    if (err instanceof CancelledImport) {
      post({ type: 'cancel' });
      setStatus('Import cancelled', 'info');
    } else {
      console.error(err);
      setStatus(err instanceof Error ? err.message : String(err), 'error');
    }
  } finally {
    for (const r of rendered) r.dispose();
    busy = false;
    cancelled = false;
    els.importBtn.disabled = false;
    selectTab(currentTab);
    setTimeout(() => void drainCaptures(), 0);
  }
}

// Browser button: the local relay announces captures over server-sent events and the plugin
// imports each one as soon as it is free.
const RELAY = 'http://localhost:7801';
const pendingCaptures: { id: string; title: string }[] = [];

function setRelay(connected: boolean): void {
  $('relay-chip').hidden = !connected;
  $('send-status').textContent = connected
    ? 'Connected. Click the browser button on any tab to send it here.'
    : 'Not connected. Start the relay with npm run relay, and load the extension folder in Chrome.';
}

async function drainCaptures(): Promise<void> {
  if (busy || picker || !pendingCaptures.length) return;
  const next = pendingCaptures.shift()!;
  try {
    setStatus(`Receiving ${next.title || 'page'} from the browser…`);
    const capture = await (await fetch(`${RELAY}/captures/${next.id}`)).json();
    if (!isCapture(capture)) throw new Error('The browser capture could not be read.');
    await runImport([fromCapture(capture)]);
  } catch (err) {
    setStatus(err instanceof Error ? err.message : String(err), 'error');
    setTimeout(() => void drainCaptures(), 0);
  }
}

function connectRelay(): void {
  let source: EventSource;
  try {
    source = new EventSource(`${RELAY}/events`);
  } catch {
    setRelay(false);
    return;
  }
  source.onopen = () => setRelay(true);
  source.onerror = () => {
    setRelay(false);
    // The browser retries on its own; after a hard failure, try again later.
    if (source.readyState === EventSource.CLOSED) setTimeout(connectRelay, 5000);
  };
  source.addEventListener('capture', (event) => {
    const meta = JSON.parse((event as MessageEvent).data) as { id: string; title: string };
    if (!pendingCaptures.some((c) => c.id === meta.id)) pendingCaptures.push(meta);
    void drainCaptures();
  });
}

function onImportClick(): void {
  if (picker) {
    picker.resolve(true);
    return;
  }
  if (busy) {
    cancelled = true;
    post({ type: 'cancel' });
    setStatus('Cancelling…');
    return;
  }
  if (sourceTab === 'file' && !files.length) {
    els.fileInput.click();
    return;
  }
  void runImport();
}

function init(): void {
  bindTabs();
  bindFiles();
  els.importBtn.addEventListener('click', onImportClick);
  for (const el of [els.url, els.html, els.css, els.twConfig, els.fontSize, els.proxy]) el.addEventListener('input', scheduleSave);
  for (const el of [els.dark, els.autoLayout, els.overlays, els.components, els.existing, els.images, els.tailwind, els.preflight, els.viewport]) el.addEventListener('change', scheduleSave);
  els.url.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !busy) void runImport();
  });
  onMain((msg) => {
    if (msg.type === 'settings' && msg.settings) applySettings(msg.settings);
    else if (msg.type === 'progress' && busy) setStatus(msg.message);
  });
  post({ type: 'ui-ready' });
  setStatus('Ready to import', 'info');
  setRelay(false);
  connectRelay();
}

init();
