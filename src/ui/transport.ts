import type { ImportDocument, MainMessage, UiMessage } from '../shared/types';

const CHUNK = 256 * 1024;

export function post(msg: UiMessage): void {
  parent.postMessage({ pluginMessage: msg }, '*');
}

type Listener = (msg: MainMessage) => void;
const listeners = new Set<Listener>();

window.addEventListener('message', (event) => {
  const msg = event.data?.pluginMessage as MainMessage | undefined;
  if (msg && typeof msg === 'object' && 'type' in msg) for (const l of listeners) l(msg);
});

export function onMain(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function nextMessage<T extends MainMessage['type']>(type: T | T[]): Promise<Extract<MainMessage, { type: T }>> {
  const types = Array.isArray(type) ? type : [type];
  return new Promise((resolve) => {
    const off = onMain((msg) => {
      if ((types as string[]).includes(msg.type)) {
        off();
        resolve(msg as Extract<MainMessage, { type: T }>);
      }
    });
  });
}

// Large documents travel in slices so a single postMessage never blocks the canvas for long.
export async function sendDocument(docId: string, doc: ImportDocument): Promise<void> {
  const json = JSON.stringify(doc);
  const total = Math.max(1, Math.ceil(json.length / CHUNK));
  for (let i = 0; i < total; i++) {
    post({ type: 'doc-chunk', docId, index: i, total, data: json.slice(i * CHUNK, (i + 1) * CHUNK) });
    if (i % 8 === 7) await new Promise((r) => setTimeout(r, 0));
  }
}
