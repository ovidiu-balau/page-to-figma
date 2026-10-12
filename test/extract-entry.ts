// Debug entry: exposes the extractor on window so a test page can run it on itself.
import { extractDocument, materializePseudos } from '../src/ui/extract/walker';
import { ImageRegistry } from '../src/ui/extract/images';

(window as unknown as { __h2f: unknown }).__h2f = {
  async run(autoLayout = false) {
    const restore = materializePseudos(document, window);
    try {
      const images = new ImageRegistry('');
      return await extractDocument(window, document.title || 'page', window.innerWidth, window.innerHeight, { autoLayout, includeImages: true, proxy: '' }, images, () => {});
    } finally {
      restore();
    }
  },
};
