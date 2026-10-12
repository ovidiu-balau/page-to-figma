"use strict";
(() => {
  // src/shared/font-names.ts
  var GENERIC_FALLBACKS = {
    "sans-serif": ["Inter", "Roboto", "Arial"],
    "system-ui": ["SF Pro", "SF Pro Text", "Inter", "Roboto"],
    "-apple-system": ["SF Pro", "SF Pro Text", "Inter"],
    "blinkmacsystemfont": ["SF Pro", "SF Pro Text", "Inter"],
    "ui-sans-serif": ["SF Pro", "SF Pro Text", "Inter", "Roboto"],
    "segoe ui": ["Segoe UI", "Inter"],
    "serif": ["Noto Serif", "Georgia", "Times New Roman", "Inter"],
    "ui-serif": ["Noto Serif", "Georgia", "Inter"],
    "monospace": ["Roboto Mono", "JetBrains Mono", "Source Code Pro", "Courier New", "Inter"],
    "ui-monospace": ["SF Mono", "Roboto Mono", "JetBrains Mono", "Inter"],
    "sfmono-regular": ["SF Mono", "Roboto Mono", "Inter"],
    "cursive": ["Inter"],
    "fantasy": ["Inter"],
    "emoji": ["Inter"],
    "apple color emoji": ["Inter"],
    "segoe ui emoji": ["Inter"],
    "segoe ui symbol": ["Inter"],
    "noto color emoji": ["Inter"]
  };
  function splitStack(stack) {
    return stack.split(",").map((s) => s.trim().replace(/^["']|["']$/g, "").trim()).filter(Boolean);
  }
  function isGeneric(name) {
    const lower = name.toLowerCase();
    return lower in GENERIC_FALLBACKS || lower.startsWith("ui-");
  }

  // src/main/fonts.ts
  var WEIGHT_WORDS = [
    [/hairline|thin/i, 100],
    [/extra\s*light|ultra\s*light/i, 200],
    [/light/i, 300],
    [/medium/i, 500],
    [/semi\s*bold|demi\s*bold/i, 600],
    [/extra\s*bold|ultra\s*bold/i, 800],
    [/black|heavy/i, 900],
    [/bold/i, 700]
  ];
  var familyIndex = null;
  var loaded = /* @__PURE__ */ new Map();
  function styleWeight(style) {
    for (const [re, w] of WEIGHT_WORDS) if (re.test(style)) return w;
    const numeric = style.match(/\b([1-9]00)\b/);
    return numeric ? Number(numeric[1]) : 400;
  }
  async function index() {
    if (familyIndex) return familyIndex;
    const fonts = await figma.listAvailableFontsAsync();
    const map = /* @__PURE__ */ new Map();
    for (const f of fonts) {
      const key = f.fontName.family.toLowerCase();
      let entry = map.get(key);
      if (!entry) {
        entry = { family: f.fontName.family, styles: [] };
        map.set(key, entry);
      }
      entry.styles.push({
        style: f.fontName.style,
        weight: styleWeight(f.fontName.style),
        italic: /italic|oblique/i.test(f.fontName.style)
      });
    }
    familyIndex = map;
    return map;
  }
  function lookup(map, name) {
    const lower = name.toLowerCase();
    const direct = map.get(lower);
    if (direct) return direct;
    const fallbacks = GENERIC_FALLBACKS[lower];
    if (fallbacks) {
      for (const f of fallbacks) {
        const hit = map.get(f.toLowerCase());
        if (hit) return hit;
      }
    }
    return void 0;
  }
  async function resolveFonts(requests) {
    var _a;
    const map = await index();
    const families = {};
    const missing = /* @__PURE__ */ new Set();
    for (const req of requests) {
      if (req.family in families) continue;
      const names = splitStack(req.family);
      const firstNamed = names.find((n) => !isGeneric(n));
      let resolved;
      for (const n of names) {
        resolved = lookup(map, n);
        if (resolved) break;
      }
      if (firstNamed && !map.has(firstNamed.toLowerCase())) missing.add(firstNamed);
      families[req.family] = ((_a = resolved != null ? resolved : map.get("inter")) != null ? _a : map.values().next().value).family;
    }
    return {
      families,
      missing: [...missing].sort(),
      available: [...map.values()].map((f) => f.family).sort((a, b) => a.localeCompare(b))
    };
  }
  async function pickFont(family, weight, italic) {
    var _a, _b;
    const map = await index();
    const entry = (_b = (_a = map.get(family.toLowerCase())) != null ? _a : map.get("inter")) != null ? _b : map.values().next().value;
    let best = entry.styles[0];
    let bestScore = Infinity;
    for (const s of entry.styles) {
      const score = (s.italic === italic ? 0 : 1e3) + Math.abs(s.weight - weight) * 2 + (s.weight > weight ? weight >= 400 ? 0 : 1 : weight >= 400 ? 1 : 0) + (/variable/i.test(s.style) ? 5 : 0);
      if (score < bestScore) {
        bestScore = score;
        best = s;
      }
    }
    return { family: entry.family, style: best.style };
  }
  function loadFont(font) {
    const key = `${font.family}::${font.style}`;
    let p = loaded.get(key);
    if (!p) {
      p = figma.loadFontAsync(font);
      loaded.set(key, p);
    }
    return p;
  }

  // src/main/build.ts
  var CancelledError = class extends Error {
    constructor() {
      super("Import cancelled");
    }
  };
  var MIN_SIZE = 0.01;
  function rgb(c) {
    return { r: c.r, g: c.g, b: c.b };
  }
  function toPaint(fill, ctx) {
    var _a;
    if (fill.kind === "solid") {
      if (fill.color.a <= 0) return null;
      return { type: "SOLID", color: rgb(fill.color), opacity: fill.color.a };
    }
    if (fill.kind === "image") {
      const image = ctx.images.get(fill.imageId);
      if (!image) return null;
      const paint = {
        type: "IMAGE",
        imageHash: image.hash,
        scaleMode: fill.scaleMode,
        ...fill.scaleMode === "TILE" ? { scalingFactor: (_a = fill.scalingFactor) != null ? _a : 1 } : {},
        ...fill.scaleMode === "CROP" && fill.transform ? { imageTransform: fill.transform } : {}
      };
      return paint;
    }
    const type = fill.kind === "linear" ? "GRADIENT_LINEAR" : fill.kind === "radial" ? "GRADIENT_RADIAL" : "GRADIENT_ANGULAR";
    return {
      type,
      gradientTransform: fill.transform,
      gradientStops: fill.stops.map((s) => ({ color: { ...s.color }, position: Math.min(1, Math.max(0, s.position)) }))
    };
  }
  function toPaints(fills, ctx) {
    const out = [];
    for (const f of fills) {
      const p = toPaint(f, ctx);
      if (p) out.push(p);
    }
    return out;
  }
  function toEffects(style) {
    var _a;
    const effects = [];
    for (const s of (_a = style.shadows) != null ? _a : []) {
      effects.push({
        type: s.type,
        color: { ...s.color },
        offset: { x: s.x, y: s.y },
        radius: Math.max(0, s.blur),
        spread: s.spread,
        visible: true,
        blendMode: "NORMAL",
        ...s.type === "DROP_SHADOW" ? { showShadowBehindNode: false } : {}
      });
    }
    if (style.layerBlur) {
      effects.push({ type: "LAYER_BLUR", blurType: "NORMAL", radius: style.layerBlur, visible: true });
    }
    if (style.backgroundBlur) {
      effects.push({ type: "BACKGROUND_BLUR", blurType: "NORMAL", radius: style.backgroundBlur, visible: true });
    }
    return effects;
  }
  function applyBox(node, style, ctx, w, h) {
    node.fills = toPaints(style.fills, ctx);
    if (style.radius) {
      const max = Math.min(w, h) / 2;
      const [tl, tr, br, bl] = style.radius.map((r) => Math.min(r, max));
      if (tl === tr && tr === br && br === bl) node.cornerRadius = tl;
      else {
        node.topLeftRadius = tl;
        node.topRightRadius = tr;
        node.bottomRightRadius = br;
        node.bottomLeftRadius = bl;
      }
    }
    const b = style.border;
    if (b && !b.sideColors) {
      node.strokes = [{ type: "SOLID", color: rgb(b.color), opacity: b.color.a }];
      node.strokeAlign = "INSIDE";
      if (b.top === b.right && b.right === b.bottom && b.bottom === b.left) node.strokeWeight = b.top;
      else {
        node.strokeTopWeight = b.top;
        node.strokeRightWeight = b.right;
        node.strokeBottomWeight = b.bottom;
        node.strokeLeftWeight = b.left;
      }
      const weight = Math.max(b.top, b.right, b.bottom, b.left);
      if (b.style === "dashed") node.dashPattern = [weight * 2, weight * 2];
      if (b.style === "dotted") {
        node.dashPattern = [0, weight * 2];
        node.strokeCap = "ROUND";
      }
    }
    const effects = toEffects(style);
    if (effects.length) node.effects = effects;
    if (style.opacity !== void 0 && style.opacity < 1) node.opacity = style.opacity;
    if (style.blendMode && style.blendMode !== "NORMAL") node.blendMode = style.blendMode;
  }
  function addSideBorders(frame, style, w, h) {
    const b = style.border;
    if (!b || !b.sideColors) return;
    const sides = [
      [0, 0, w, b.top, b.sideColors[0], b.top],
      [w - b.right, 0, b.right, h, b.sideColors[1], b.right],
      [0, h - b.bottom, w, b.bottom, b.sideColors[2], b.bottom],
      [0, 0, b.left, h, b.sideColors[3], b.left]
    ];
    const names = ["border-top", "border-right", "border-bottom", "border-left"];
    sides.forEach(([x, y, sw, sh, color, weight], i) => {
      if (weight <= 0 || color.a <= 0) return;
      const r = figma.createRectangle();
      r.name = names[i];
      r.resize(Math.max(sw, MIN_SIZE), Math.max(sh, MIN_SIZE));
      r.fills = [{ type: "SOLID", color: rgb(color), opacity: color.a }];
      frame.appendChild(r);
      if (frame.layoutMode !== "NONE") r.layoutPositioning = "ABSOLUTE";
      r.x = x;
      r.y = y;
    });
  }
  function place(node, data, parent) {
    var _a, _b, _c;
    const inAutoLayout = parent.type === "FRAME" && parent.layoutMode !== "NONE";
    if (inAutoLayout && "layoutPositioning" in node) {
      if ((_a = data.childLayout) == null ? void 0 : _a.absolute) node.layoutPositioning = "ABSOLUTE";
      else {
        if ((_b = data.childLayout) == null ? void 0 : _b.grow) node.layoutGrow = 1;
        if ((_c = data.childLayout) == null ? void 0 : _c.stretch) node.layoutAlign = "STRETCH";
        return;
      }
    }
    if (data.rotation) {
      const t = data.rotation * Math.PI / 180;
      const cos = Math.cos(t);
      const sin = Math.sin(t);
      const cx = data.x + data.width / 2;
      const cy = data.y + data.height / 2;
      const x = cx - data.width / 2 * cos - data.height / 2 * sin;
      const y = cy + data.width / 2 * sin - data.height / 2 * cos;
      node.relativeTransform = [
        [cos, sin, x],
        [-sin, cos, y]
      ];
      return;
    }
    node.x = data.x;
    node.y = data.y;
  }
  async function tick(ctx) {
    ctx.built++;
    if (ctx.isCancelled()) throw new CancelledError();
    if (ctx.built % 150 === 0) {
      ctx.onProgress(ctx.built);
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  async function buildFrame(data, ctx) {
    var _a;
    const frame = figma.createFrame();
    frame.name = data.name;
    const w = Math.max(data.width, MIN_SIZE);
    const h = Math.max(data.height, MIN_SIZE);
    frame.resize(w, h);
    applyBox(frame, data.style, ctx, w, h);
    frame.clipsContent = !!data.style.clips;
    const layout = ctx.settings.autoLayout ? data.layout : void 0;
    if (layout) {
      frame.layoutMode = layout.mode;
      frame.layoutWrap = layout.wrap && layout.mode === "HORIZONTAL" ? "WRAP" : "NO_WRAP";
      frame.itemSpacing = layout.gap;
      if (layout.wrap) frame.counterAxisSpacing = layout.crossGap;
      [frame.paddingTop, frame.paddingRight, frame.paddingBottom, frame.paddingLeft] = layout.padding;
      frame.primaryAxisAlignItems = layout.primaryAlign;
      frame.counterAxisAlignItems = layout.counterAlign;
      frame.primaryAxisSizingMode = "FIXED";
      frame.counterAxisSizingMode = "FIXED";
      frame.resize(w, h);
    }
    for (const child of data.children) {
      const node = await buildNode(child, ctx);
      if (!node) continue;
      frame.appendChild(node);
      place(node, child, frame);
    }
    addSideBorders(frame, data.style, w, h);
    if (!frame.clipsContent && ((_a = data.style.shadows) == null ? void 0 : _a.some((s) => s.spread !== 0)) && childrenInside(frame)) {
      frame.clipsContent = true;
    }
    return frame;
  }
  function childrenInside(frame) {
    return frame.children.every(
      (c) => !("rotation" in c && c.rotation) && c.x >= -0.5 && c.y >= -0.5 && c.x + c.width <= frame.width + 0.5 && c.y + c.height <= frame.height + 0.5
    );
  }
  async function buildText(data, ctx) {
    var _a, _b;
    const runs = data.runs.filter((r) => r.text.length > 0);
    if (!runs.length) return null;
    const fonts = [];
    for (const run of runs) {
      const family = (_a = ctx.fontMap[run.fontFamily]) != null ? _a : "Inter";
      const font = await pickFont(family, run.fontWeight, run.italic);
      await loadFont(font);
      fonts.push(font);
    }
    const text = figma.createText();
    text.fontName = fonts[0];
    text.characters = runs.map((r) => r.text).join("");
    text.name = text.characters.replace(/\s+/g, " ").trim().slice(0, 40) || "Text";
    let start = 0;
    runs.forEach((run, i) => {
      const end = start + run.text.length;
      text.setRangeFontName(start, end, fonts[i]);
      text.setRangeFontSize(start, end, Math.max(1, run.fontSize));
      const paint = run.gradient ? toPaint(run.gradient, ctx) : run.color ? toPaint({ kind: "solid", color: run.color }, ctx) : null;
      text.setRangeFills(start, end, paint ? [paint] : []);
      text.setRangeLetterSpacing(start, end, { unit: "PIXELS", value: run.letterSpacing });
      text.setRangeLineHeight(start, end, run.lineHeight ? { unit: "PIXELS", value: run.lineHeight } : { unit: "AUTO" });
      if (run.decoration !== "NONE") text.setRangeTextDecoration(start, end, run.decoration);
      if (run.textCase !== "ORIGINAL") text.setRangeTextCase(start, end, run.textCase);
      if (run.href && /^https?:/i.test(run.href)) {
        try {
          text.setRangeHyperlink(start, end, { type: "URL", value: run.href });
        } catch {
        }
      }
      start = end;
    });
    text.textAlignHorizontal = data.align;
    if (data.singleLine) {
      text.textAutoResize = "WIDTH_AND_HEIGHT";
      const over = text.width - data.width;
      const chars = text.characters.length;
      if (data.fit && over > 0.75 && chars > 1 && over / data.width < 0.06) {
        let at = 0;
        runs.forEach((run) => {
          text.setRangeLetterSpacing(at, at + run.text.length, { unit: "PIXELS", value: run.letterSpacing - over / chars });
          at += run.text.length;
        });
      }
      const drift = text.width - data.width;
      if (data.align === "CENTER") data.x -= drift / 2;
      else if (data.align === "RIGHT") data.x -= drift;
    } else {
      const base = Math.max(data.width + Math.min(2, data.width * 0.02), 1);
      text.resize(base, Math.max(data.height, 1));
      text.textAutoResize = "HEIGHT";
      const lineSlack = ((_b = runs[0].lineHeight) != null ? _b : runs[0].fontSize * 1.2) / 2;
      for (let k = 1; k <= 8 && text.height > data.height + lineSlack; k++) {
        text.resize(base * (1 + k * 0.01), text.height);
        text.textAutoResize = "HEIGHT";
      }
    }
    const effects = toEffects({ shadows: data.shadows });
    if (effects.length) text.effects = effects;
    if (data.opacity !== void 0 && data.opacity < 1) text.opacity = data.opacity;
    return text;
  }
  function buildImage(data, ctx) {
    const rect = figma.createRectangle();
    rect.name = data.name;
    const w = Math.max(data.width, MIN_SIZE);
    const h = Math.max(data.height, MIN_SIZE);
    rect.resize(w, h);
    applyBox(rect, data.style, ctx, w, h);
    if (!rect.fills || rect.fills.length === 0) {
      rect.fills = [{ type: "SOLID", color: { r: 0.9, g: 0.9, b: 0.92 } }];
    }
    return rect;
  }
  function buildSvg(data) {
    try {
      const node = figma.createNodeFromSvg(data.svg);
      node.name = data.name;
      if (data.width > 0 && data.height > 0 && (Math.abs(node.width - data.width) > 0.5 || Math.abs(node.height - data.height) > 0.5)) {
        node.rescale(Math.min(data.width / Math.max(node.width, MIN_SIZE), data.height / Math.max(node.height, MIN_SIZE)));
        node.resize(Math.max(data.width, MIN_SIZE), Math.max(data.height, MIN_SIZE));
      }
      node.fills = [];
      node.clipsContent = false;
      if (data.opacity !== void 0 && data.opacity < 1) node.opacity = data.opacity;
      return node;
    } catch {
      const rect = figma.createRectangle();
      rect.name = `${data.name} (unsupported SVG)`;
      rect.resize(Math.max(data.width, MIN_SIZE), Math.max(data.height, MIN_SIZE));
      rect.fills = [{ type: "SOLID", color: { r: 0.9, g: 0.9, b: 0.92 } }];
      return rect;
    }
  }
  async function buildNode(data, ctx) {
    await tick(ctx);
    switch (data.type) {
      case "FRAME":
        return buildFrame(data, ctx);
      case "TEXT":
        return buildText(data, ctx);
      case "IMAGE":
        return buildImage(data, ctx);
      case "SVG":
        return buildSvg(data);
    }
  }
  async function buildRoot(root, ctx) {
    const frame = await buildNode(root, ctx);
    frame.clipsContent = true;
    return frame;
  }

  // src/main/code.ts
  var SETTINGS_KEY = "settings:v2";
  var OLD_SETTINGS_KEY = "settings:v1";
  var FRAME_GAP = 120;
  figma.showUI(__html__, { width: 600, height: 700, themeColors: true });
  function send(msg) {
    figma.ui.postMessage(msg);
  }
  var batch = null;
  var busy = false;
  function startPosition() {
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
  function newBatch() {
    const { x, y } = startPosition();
    return { images: /* @__PURE__ */ new Map(), chunks: /* @__PURE__ */ new Map(), frames: [], cursorX: x, cursorY: y, cancelled: false };
  }
  async function importDoc(msg) {
    if (!batch) batch = newBatch();
    const state = batch;
    const parts = state.chunks.get(msg.docId);
    state.chunks.delete(msg.docId);
    if (!parts || parts.some((p) => p === void 0)) throw new Error("Import data arrived incomplete. Please try again.");
    const doc = JSON.parse(parts.join(""));
    const ctx = {
      images: state.images,
      fontMap: msg.fontMap,
      settings: msg.settings,
      isCancelled: () => state.cancelled,
      onProgress: (built) => send({ type: "progress", message: `Creating layers\u2026 ${built}`, done: built }),
      built: 0
    };
    let frame = null;
    try {
      frame = await buildRoot(doc.root, ctx);
      frame.name = doc.name;
      frame.x = state.cursorX;
      frame.y = state.cursorY;
      figma.currentPage.appendChild(frame);
      state.cursorX += frame.width + FRAME_GAP;
      state.frames.push(frame);
      send({ type: "doc-done", docId: msg.docId, nodeCount: ctx.built });
    } catch (err) {
      if (frame && !frame.removed) frame.remove();
      throw err;
    }
  }
  function finishBatch() {
    const state = batch;
    batch = null;
    if (!state) return;
    const frames = state.frames.filter((f) => !f.removed);
    if (frames.length) {
      figma.currentPage.selection = frames;
      figma.viewport.scrollAndZoomIntoView(frames);
      figma.notify(frames.length === 1 ? `Imported "${frames[0].name}"` : `Imported ${frames.length} frames`);
    }
    send({ type: "batch-done", frames: frames.length, cancelled: state.cancelled });
  }
  async function handle(msg) {
    try {
      switch (msg.type) {
        case "ui-ready": {
          let settings = await figma.clientStorage.getAsync(SETTINGS_KEY);
          if (!settings) {
            const old = await figma.clientStorage.getAsync(OLD_SETTINGS_KEY);
            if (old) settings = { ...old, autoLayout: true, hideOverlays: true };
          }
          send({ type: "settings", settings: settings != null ? settings : null });
          break;
        }
        case "save-settings":
          await figma.clientStorage.setAsync(SETTINGS_KEY, msg.settings);
          break;
        case "check-fonts":
          send({ type: "fonts", resolution: await resolveFonts(msg.requests) });
          break;
        case "begin-batch":
          batch = newBatch();
          busy = true;
          break;
        case "image": {
          if (!batch) batch = newBatch();
          let image = null;
          try {
            image = figma.createImage(msg.bytes);
          } catch {
            image = null;
          }
          batch.images.set(msg.id, image);
          break;
        }
        case "doc-chunk": {
          if (!batch) batch = newBatch();
          let parts = batch.chunks.get(msg.docId);
          if (!parts) {
            parts = new Array(msg.total);
            batch.chunks.set(msg.docId, parts);
          }
          parts[msg.index] = msg.data;
          break;
        }
        case "import-doc":
          if (batch == null ? void 0 : batch.cancelled) break;
          await importDoc(msg);
          break;
        case "end-batch":
          busy = false;
          finishBatch();
          break;
        case "cancel":
          if (!busy) finishBatch();
          break;
        case "notify":
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
      console.error("[page-to-figma]", err);
      send({ type: "error", message });
    }
  }
  var queue = Promise.resolve();
  figma.ui.onmessage = (msg) => {
    if (msg.type === "cancel" && batch) batch.cancelled = true;
    queue = queue.then(() => handle(msg));
  };
})();
