// Shared contract between the UI iframe (extraction) and the main thread (Figma node creation).
// Every coordinate is in CSS pixels, relative to the parent node's top-left corner.

export interface RGBA {
  r: number; // 0..1
  g: number;
  b: number;
  a: number;
}

export interface GradientStop {
  color: RGBA;
  position: number; // 0..1
}

export type Fill =
  | { kind: 'solid'; color: RGBA }
  | {
      kind: 'linear' | 'radial' | 'angular';
      stops: GradientStop[];
      // Affine transform from the node's unit square into Figma gradient space.
      transform: [[number, number, number], [number, number, number]];
    }
  | {
      kind: 'image';
      imageId: string; // key into the image table sent alongside the tree
      scaleMode: 'FILL' | 'FIT' | 'CROP' | 'TILE';
      scalingFactor?: number; // TILE only
      // CROP only: transform placing the image inside the node.
      transform?: [[number, number, number], [number, number, number]];
    };

export interface Shadow {
  type: 'DROP_SHADOW' | 'INNER_SHADOW';
  color: RGBA;
  x: number;
  y: number;
  blur: number;
  spread: number;
}

export interface Border {
  top: number;
  right: number;
  bottom: number;
  left: number;
  color: RGBA;
  // Set when the four sides use different colors; the builder then draws each side separately.
  sideColors?: [RGBA, RGBA, RGBA, RGBA];
  style: 'solid' | 'dashed' | 'dotted';
}

export interface BoxStyle {
  fills: Fill[]; // bottom-most first (Figma order)
  border?: Border;
  radius?: [number, number, number, number]; // tl, tr, br, bl
  shadows?: Shadow[];
  layerBlur?: number;
  backgroundBlur?: number;
  opacity?: number;
  blendMode?: BlendMode;
  clips?: boolean;
}

export interface TextRun {
  text: string;
  fontFamily: string; // CSS font-family stack, resolved by the main thread
  fontWeight: number;
  italic: boolean;
  fontSize: number;
  lineHeight: number | null; // px, null = normal
  letterSpacing: number; // px
  color?: RGBA; // omitted when the run is gradient-filled
  gradient?: Fill;
  // Box the gradient was measured against (page coordinates); remapped onto the text node, then dropped.
  gradientBox?: { x: number; y: number; width: number; height: number };
  decoration: 'NONE' | 'UNDERLINE' | 'STRIKETHROUGH';
  textCase: 'ORIGINAL' | 'UPPER' | 'LOWER' | 'TITLE';
  href?: string;
}

export interface AutoLayout {
  mode: 'HORIZONTAL' | 'VERTICAL';
  wrap: boolean;
  gap: number;
  crossGap: number;
  padding: [number, number, number, number]; // t r b l
  primaryAlign: 'MIN' | 'CENTER' | 'MAX' | 'SPACE_BETWEEN';
  counterAlign: 'MIN' | 'CENTER' | 'MAX' | 'BASELINE';
}

export interface ChildLayout {
  grow?: boolean;
  stretch?: boolean;
  absolute?: boolean; // keep x/y even inside an auto layout parent
}

interface BaseNode {
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation?: number; // degrees, counter-clockwise as in Figma
  childLayout?: ChildLayout;
}

export interface FrameData extends BaseNode {
  type: 'FRAME';
  style: BoxStyle;
  layout?: AutoLayout;
  children: NodeData[];
}

export interface TextData extends BaseNode {
  type: 'TEXT';
  runs: TextRun[];
  align: 'LEFT' | 'CENTER' | 'RIGHT' | 'JUSTIFIED';
  singleLine: boolean;
  // Text placed beside other inline boxes: Figma tightens tracking slightly if its glyphs run wider.
  fit?: boolean;
  shadows?: Shadow[];
  opacity?: number;
}

export interface ImageData extends BaseNode {
  type: 'IMAGE';
  style: BoxStyle; // includes the image fill
}

export interface SvgData extends BaseNode {
  type: 'SVG';
  svg: string;
  opacity?: number;
}

export type NodeData = FrameData | TextData | ImageData | SvgData;

export type BlendMode =
  | 'NORMAL' | 'MULTIPLY' | 'SCREEN' | 'OVERLAY' | 'DARKEN' | 'LIGHTEN'
  | 'COLOR_DODGE' | 'COLOR_BURN' | 'HARD_LIGHT' | 'SOFT_LIGHT'
  | 'DIFFERENCE' | 'EXCLUSION' | 'HUE' | 'SATURATION' | 'COLOR' | 'LUMINOSITY';

export interface ImportDocument {
  name: string;
  root: FrameData;
}

export interface FontRequest {
  family: string; // CSS font-family stack
  weight: number;
  italic: boolean;
}

export interface FontResolution {
  // CSS stack -> Figma family, for stacks that resolved to an installed font.
  families: Record<string, string>;
  missing: string[]; // first named family of each stack that could not be resolved
  available: string[]; // every Figma family, for the mapping sheet
}

export interface ImportSettings {
  autoLayout: boolean;
  includeImages: boolean;
  components?: boolean; // repeated parts become components; text and colors become styles
}

// UI -> main
export type UiMessage =
  | { type: 'ui-ready' }
  | { type: 'save-settings'; settings: PersistedSettings }
  | { type: 'check-fonts'; requests: FontRequest[] }
  | { type: 'begin-batch'; total: number }
  | { type: 'image'; id: string; bytes: Uint8Array }
  | { type: 'doc-chunk'; docId: string; index: number; total: number; data: string }
  | { type: 'import-doc'; docId: string; fontMap: Record<string, string>; settings: ImportSettings }
  | { type: 'end-batch' }
  | { type: 'cancel' }
  | { type: 'notify'; message: string; error?: boolean };

// main -> UI
export type MainMessage =
  | { type: 'settings'; settings: PersistedSettings | null }
  | { type: 'fonts'; resolution: FontResolution }
  | { type: 'progress'; message: string; done?: number; total?: number }
  | { type: 'doc-done'; docId: string; nodeCount: number }
  | { type: 'batch-done'; frames: number; cancelled: boolean }
  | { type: 'error'; message: string };

export interface PersistedSettings {
  tab: 'url' | 'file' | 'code' | 'options';
  url: string;
  html: string;
  css: string;
  darkMode: boolean;
  autoLayout: boolean;
  includeImages: boolean;
  hideOverlays: boolean;
  components: boolean;
  tailwind: boolean;
  disablePreflight: boolean;
  tailwindConfig: string;
  rootFontSize: number;
  proxyUrl: string;
  viewport: string;
}

export const DEFAULT_SETTINGS: PersistedSettings = {
  tab: 'url',
  url: '',
  html: '',
  css: '',
  darkMode: false,
  autoLayout: true,
  includeImages: true,
  hideOverlays: true,
  components: true,
  tailwind: true,
  disablePreflight: true,
  tailwindConfig: '',
  rootFontSize: 16,
  proxyUrl: '',
  viewport: 'source-default',
};
