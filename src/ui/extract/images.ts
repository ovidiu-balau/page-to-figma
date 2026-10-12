import { fetchResource } from '../net';

const MAX_SIDE = 4096; // Figma's image size limit
const CONCURRENCY = 6;

function hashString(s: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619);
    h2 = Math.imul(h2 ^ c, 2246822519);
  }
  return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36);
}

function isNativeFormat(b: Uint8Array): boolean {
  const png = b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
  const jpg = b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  const gif = b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46;
  return png || jpg || gif;
}

function looksLikeSvg(blob: Blob, bytes: Uint8Array): boolean {
  if (blob.type.includes('svg')) return true;
  const head = new TextDecoder().decode(bytes.slice(0, 256)).trimStart();
  return head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'));
}

async function canvasToPng(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'));
  if (!blob) throw new Error('canvas export failed');
  return new Uint8Array(await blob.arrayBuffer());
}

function fitSize(w: number, h: number, scale = 1): [number, number] {
  let W = Math.max(1, Math.round(w * scale));
  let H = Math.max(1, Math.round(h * scale));
  const k = Math.min(1, MAX_SIDE / Math.max(W, H));
  W = Math.max(1, Math.round(W * k));
  H = Math.max(1, Math.round(H * k));
  return [W, H];
}

async function loadImageElement(src: string): Promise<HTMLImageElement> {
  const img = new Image();
  img.decoding = 'async';
  img.src = src;
  await img.decode();
  return img;
}

// WebP, AVIF, SVG, BMP, ICO… are redrawn on a canvas because Figma only accepts PNG, JPEG and GIF.
async function toFigmaBytes(blob: Blob): Promise<Uint8Array> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (isNativeFormat(bytes)) {
    const bitmap = await createImageBitmap(blob).catch(() => null);
    if (!bitmap || (bitmap.width <= MAX_SIDE && bitmap.height <= MAX_SIDE)) return bytes;
  }
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  if (looksLikeSvg(blob, bytes)) {
    const url = URL.createObjectURL(new Blob([bytes], { type: 'image/svg+xml' }));
    try {
      const img = await loadImageElement(url);
      const w = img.naturalWidth || 300;
      const h = img.naturalHeight || 150;
      [canvas.width, canvas.height] = fitSize(w, h, Math.max(2, 512 / Math.max(w, h)));
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    } finally {
      URL.revokeObjectURL(url);
    }
  } else {
    const bitmap = await createImageBitmap(blob);
    [canvas.width, canvas.height] = fitSize(bitmap.width, bitmap.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  }
  return canvasToPng(canvas);
}

export class ImageRegistry {
  private urls = new Map<string, string>(); // id -> url
  private ready = new Map<string, Uint8Array>(); // id -> bytes produced in-page (canvas, icons)
  private sizes = new Map<string, Promise<{ w: number; h: number } | null>>();

  constructor(private proxy: string) {}

  register(url: string): string {
    const id = `u${hashString(url)}`;
    if (!this.ready.has(id)) this.urls.set(id, url);
    return id;
  }

  addBytes(bytes: Uint8Array): string {
    let sample = '';
    for (let i = 0; i < bytes.length; i += Math.max(1, Math.floor(bytes.length / 2048))) sample += String.fromCharCode(bytes[i]);
    const id = `b${hashString(sample + bytes.length)}`;
    this.ready.set(id, bytes);
    return id;
  }

  // Natural size of a (possibly cross-origin) image; display does not need CORS, only byte access does.
  sizeOf(url: string): Promise<{ w: number; h: number } | null> {
    let p = this.sizes.get(url);
    if (!p) {
      p = loadImageElement(url)
        .then((img) => ({ w: img.naturalWidth || 1, h: img.naturalHeight || 1 }))
        .catch(() => null);
      this.sizes.set(url, p);
    }
    return p;
  }

  get pending(): number {
    return this.urls.size + this.ready.size;
  }

  async collect(onProgress: (done: number, total: number) => void): Promise<{ images: Map<string, Uint8Array>; failed: number }> {
    const images = new Map<string, Uint8Array>(this.ready);
    const queue = [...this.urls.entries()];
    const total = queue.length;
    let done = 0;
    let failed = 0;
    const worker = async () => {
      for (let item = queue.shift(); item; item = queue.shift()) {
        const [id, url] = item;
        try {
          const blob = await (await fetchResource(url, this.proxy)).blob();
          images.set(id, await toFigmaBytes(blob));
        } catch {
          failed++;
        }
        onProgress(++done, total);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, total) }, worker));
    return { images, failed };
  }
}

export { canvasToPng };
