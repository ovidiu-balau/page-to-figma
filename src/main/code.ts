import type { ImportDocument, MainMessage, UiMessage } from '../shared/types';
import { buildRoot, CancelledError, type BuildContext } from './build';
import { Components } from './components';
import { resolveFonts } from './fonts';
import { applyStyles } from './styles';

const SETTINGS_KEY = 'settings:v2';
// v2 turned Auto Layout and pop-up removal on by default; older saved settings adopt both once.
const OLD_SETTINGS_KEY = 'settings:v1';
const FRAME_GAP = 120;

figma.showUI(__html__, { width: 600, height: 700, themeColors: true });

function send(msg: MainMessage): void {
  figma.ui.postMessage(msg);
}

interface BatchState {
  images: Map<string, Image | null>;
  chunks: Map<string, string[]>;
  frames: FrameNode[];
  made: { components: number; text: number; color: number };
  updated: number;
  cursorX: number;
  cursorY: number;
  cancelled: boolean;
}

let batch: BatchState | null = null;
let busy = false;

function startPosition(): { x: number; y: number } {
  const children = figma.currentPage.children;
  if (!children.length) {
    const c = figma.viewport.center;
    return { x: Math.round(c.x), y: Math.round(c.y) };
  }
  let right = -Infinity;
  let top = Infinity;
  for (const n of children) {
    right = Math.max(right, n.x + n.width);
    top = Math.min(top, n.y);
  }
  return { x: Math.round(right + FRAME_GAP * 2), y: Math.round(top) };
}

function newBatch(): BatchState {
  const { x, y } = startPosition();
  return { images: new Map(), chunks: new Map(), frames: [], made: { components: 0, text: 0, color: 0 }, updated: 0, cursorX: x, cursorY: y, cancelled: false };
}

// Frames an import can stand in for: same name, on this page or in one of its sections.
function framesNamed(name: string): FrameNode[] {
  return figma.currentPage.findAll(
    (n) => n.type === 'FRAME' && n.name === name && (n.parent?.type === 'PAGE' || n.parent?.type === 'SECTION'),
  ) as FrameNode[];
}

// Puts a new node where an old one was (same parent, place in the layer list and position) and removes the old.
function swap(old: FrameNode, next: FrameNode): void {
  const parent = old.parent as BaseNode & ChildrenMixin;
  const { x, y } = old;
  parent.insertChild(parent.children.indexOf(old), next);
  next.x = x;
  next.y = y;
  old.remove();
}

async function importDoc(msg: Extract<UiMessage, { type: 'import-doc' }>): Promise<void> {
  if (!batch) batch = newBatch();
  const state = batch;
  const parts = state.chunks.get(msg.docId);
  state.chunks.delete(msg.docId);
  if (!parts || parts.some((p) => p === undefined)) throw new Error('Import data arrived incomplete. Please try again.');
  const doc = JSON.parse(parts.join('')) as ImportDocument;
  const components = msg.settings.components ? new Components(doc.root, msg.settings.autoLayout, `${doc.name} · Components`) : undefined;
  const ctx: BuildContext = {
    images: state.images,
    fontMap: msg.fontMap,
    settings: msg.settings,
    isCancelled: () => state.cancelled,
    onProgress: (built) => send({ type: 'progress', message: `Creating layers… ${built}`, done: built }),
    built: 0,
    components,
  };
  let frame: FrameNode | null = null;
  const before = new Set(figma.currentPage.children.map((c) => c.id));
  const old = msg.replace ? framesNamed(doc.name)[0] : undefined;
  const oldBoard = old ? framesNamed(`${doc.name} · Components`)[0] : undefined;
  try {
    frame = await buildRoot(doc.root, ctx);
    frame.name = doc.name;
    frame.x = state.cursorX;
    frame.y = state.cursorY;
    figma.currentPage.appendChild(frame);
    const board = components?.boardNode();
    if (board) {
      // Main components sit on a board under the page they came from.
      figma.currentPage.appendChild(board);
      // resize() fixes both axes, so the board is set to grow with its components again afterwards.
      board.resize(Math.max(frame.width, 600), board.height);
      board.counterAxisSizingMode = 'AUTO';
      board.x = frame.x;
      board.y = frame.y + frame.height + FRAME_GAP;
      state.made.components += components!.count;
    }
    if (msg.settings.components) {
      send({ type: 'progress', message: 'Creating text and color styles…' });
      try {
        const made = await applyStyles(board ? [board, frame] : [frame], doc.group ?? doc.name);
        state.made.text += made.text;
        state.made.color += made.color;
      } catch (err) {
        // The layers are already built; styles are a bonus and never cost the import.
        console.error('[page-to-figma] styles', err);
      }
    }
    if (old && !old.removed) {
      // An update takes the old frame's place; its components board is replaced and sits under it again.
      const parent = old.parent as BaseNode & ChildrenMixin;
      swap(old, frame);
      if (oldBoard && !oldBoard.removed) oldBoard.remove();
      if (board) {
        parent.insertChild(parent.children.indexOf(frame) + 1, board);
        board.x = frame.x;
        board.y = frame.y + frame.height + FRAME_GAP;
      }
      state.updated++;
    } else {
      state.cursorX += frame.width + FRAME_GAP;
    }
    state.frames.push(frame);
    send({ type: 'doc-done', docId: msg.docId, nodeCount: ctx.built });
  } catch (err) {
    // New layers start on the page, so a build that stops part-way leaves them there: remove them all.
    for (const node of [...figma.currentPage.children]) if (!before.has(node.id) && !node.removed) node.remove();
    if (frame && !frame.removed) frame.remove();
    const board = components?.boardNode();
    if (board && !board.removed) board.remove();
    throw err;
  }
}

function finishBatch(): void {
  const state = batch;
  batch = null;
  if (!state) return;
  const frames = state.frames.filter((f) => !f.removed);
  if (frames.length) {
    figma.currentPage.selection = frames;
    figma.viewport.scrollAndZoomIntoView(frames);
    const { components, text, color } = state.made;
    const extras = [
      components && `${components} component${components > 1 ? 's' : ''}`,
      text && `${text} text style${text > 1 ? 's' : ''}`,
      color && `${color} color style${color > 1 ? 's' : ''}`,
    ].filter(Boolean);
    const verb = state.updated === frames.length ? 'Updated' : 'Imported';
    const what = frames.length === 1 ? `${verb} "${frames[0].name}"` : `${verb} ${frames.length} frames`;
    figma.notify(extras.length ? `${what} with ${extras.join(', ')}` : what);
  }
  send({ type: 'batch-done', frames: frames.length, cancelled: state.cancelled });
}

async function handle(msg: UiMessage): Promise<void> {
  try {
    switch (msg.type) {
      case 'ui-ready': {
        let settings = await figma.clientStorage.getAsync(SETTINGS_KEY);
        if (!settings) {
          const old = await figma.clientStorage.getAsync(OLD_SETTINGS_KEY);
          if (old) settings = { ...old, autoLayout: true, hideOverlays: true };
        }
        send({ type: 'settings', settings: settings ?? null });
        break;
      }
      case 'save-settings':
        await figma.clientStorage.setAsync(SETTINGS_KEY, msg.settings);
        break;
      case 'find-existing':
        send({ type: 'existing', names: msg.names.filter((n) => framesNamed(n).length > 0) });
        break;
      case 'check-fonts':
        send({ type: 'fonts', resolution: await resolveFonts(msg.requests) });
        break;
      case 'begin-batch':
        batch = newBatch();
        busy = true;
        break;
      case 'image': {
        if (!batch) batch = newBatch();
        let image: Image | null = null;
        try {
          image = figma.createImage(msg.bytes);
        } catch {
          image = null; // unsupported format: the layer keeps a placeholder fill
        }
        batch.images.set(msg.id, image);
        break;
      }
      case 'doc-chunk': {
        if (!batch) batch = newBatch();
        let parts = batch.chunks.get(msg.docId);
        if (!parts) {
          parts = new Array(msg.total);
          batch.chunks.set(msg.docId, parts);
        }
        parts[msg.index] = msg.data;
        break;
      }
      case 'import-doc':
        if (batch?.cancelled) break;
        await importDoc(msg);
        break;
      case 'end-batch':
        busy = false;
        finishBatch();
        break;
      case 'cancel':
        if (!busy) finishBatch();
        break;
      case 'notify':
        figma.notify(msg.message, { error: msg.error });
        break;
    }
  } catch (err) {
    if (err instanceof CancelledError) {
      busy = false;
      finishBatch();
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error('[page-to-figma]', err);
    send({ type: 'error', message });
  }
}

// Figma does not await message handlers, so work is chained to keep chunks, imports and batch ends in order.
// Cancel flips the flag immediately so a running build can stop at its next checkpoint.
let queue: Promise<void> = Promise.resolve();
figma.ui.onmessage = (msg: UiMessage) => {
  if (msg.type === 'cancel' && batch) batch.cancelled = true;
  queue = queue.then(() => handle(msg));
};
