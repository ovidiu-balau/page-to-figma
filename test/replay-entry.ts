// Replays an extracted document through the plugin's real builder inside a use_figma script.
// Big documents are split across scripts: a shell frame is built first (children left out), then
// later scripts append children into it, found again by a tag on its name (use_figma has no plugin
// data), which the last script strips.
import { buildNode, place, type BuildContext } from '../src/main/build';
import { resolveFonts } from '../src/main/fonts';
import type { FontRequest, NodeData } from '../src/shared/types';

interface Part {
  run: string;
  name: string;
  parent: string | null; // null: a new top-level frame
  nodes: { data: NodeData; path: string | null }[]; // path set: shell whose children come later
}

(globalThis as unknown as { __replay: unknown }).__replay = async (
  part: Part, hashes: Record<string, string>, fonts: FontRequest[], autoLayout: boolean,
) => {
  const resolution = await resolveFonts(fonts);
  const images = new Map<string, Image | null>();
  for (const [id, hash] of Object.entries(hashes)) images.set(id, figma.getImageByHash(hash));
  const ctx: BuildContext = {
    images, fontMap: resolution.families, settings: { autoLayout, includeImages: true },
    isCancelled: () => false, onProgress: () => {}, built: 0,
  };
  const tag = (path: string) => ` \u2063h2f:${part.run}:${path}`;
  const parent = part.parent === null
    ? figma.currentPage
    : (figma.currentPage.findOne((n) => n.name.endsWith(tag(part.parent!))) as FrameNode | null);
  if (!parent) throw new Error(`parent ${part.parent} not found`);
  const ids: string[] = [];
  for (const { data, path } of part.nodes) {
    const node = await buildNode(data, ctx);
    if (!node) continue;
        if (part.parent === null) {
      const frame = node as FrameNode;
      frame.clipsContent = true;
      frame.name = part.name;
      let right = 0;
      for (const n of figma.currentPage.children) right = Math.max(right, n.x + n.width);
      figma.currentPage.appendChild(frame);
      frame.x = right ? right + 200 : 0;
      frame.y = 0;
    } else {
      parent.appendChild(node);
      place(node, data, parent as FrameNode);
    }
    if (path !== null) node.name += tag(path);
    ids.push(node.id);
  }
  return { ids, nodes: ctx.built, missingFonts: resolution.missing };
};
