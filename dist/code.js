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
      const firstNamed = names.find((n2) => !isGeneric(n2));
      let resolved;
      for (const n2 of names) {
        resolved = lookup(map, n2);
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
  function rgb(c2) {
    return { r: c2.r, g: c2.g, b: c2.b };
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
  async function buildFrame(data, ctx, asComponent = false) {
    var _a, _b;
    const frame = asComponent ? figma.createComponent() : figma.createFrame();
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
      const node = ((_a = ctx.components) == null ? void 0 : _a.isOccurrence(child)) ? await ctx.components.place(child, ctx) : await buildNode(child, ctx);
      if (!node) continue;
      frame.appendChild(node);
      place(node, child, frame);
    }
    addSideBorders(frame, data.style, w, h);
    if (!frame.clipsContent && ((_b = data.style.shadows) == null ? void 0 : _b.some((s) => s.spread !== 0)) && childrenInside(frame)) {
      frame.clipsContent = true;
    }
    return frame;
  }
  function childrenInside(frame) {
    return frame.children.every(
      (c2) => !("rotation" in c2 && c2.rotation) && c2.x >= -0.5 && c2.y >= -0.5 && c2.x + c2.width <= frame.width + 0.5 && c2.y + c2.height <= frame.height + 0.5
    );
  }
  async function applyRuns(text, runs, ctx) {
    var _a;
    const fonts = [];
    for (const run of runs) {
      const family = (_a = ctx.fontMap[run.fontFamily]) != null ? _a : "Inter";
      const font = await pickFont(family, run.fontWeight, run.italic);
      await loadFont(font);
      fonts.push(font);
    }
    if (text.characters.length) {
      for (const f of text.getRangeAllFontNames(0, text.characters.length)) await loadFont(f);
    }
    text.fontName = fonts[0];
    text.characters = runs.map((r) => r.text).join("");
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
  }
  async function buildText(data, ctx) {
    var _a;
    const runs = data.runs.filter((r) => r.text.length > 0);
    if (!runs.length) return null;
    const text = figma.createText();
    await applyRuns(text, runs, ctx);
    text.name = text.characters.replace(/\s+/g, " ").trim().slice(0, 40) || "Text";
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
      const lineSlack = ((_a = runs[0].lineHeight) != null ? _a : runs[0].fontSize * 1.2) / 2;
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
    let node;
    switch (data.type) {
      case "FRAME":
        node = await buildFrame(data, ctx);
        break;
      case "TEXT":
        node = await buildText(data, ctx);
        break;
      case "IMAGE":
        node = buildImage(data, ctx);
        break;
      case "SVG":
        node = buildSvg(data);
        break;
    }
    if (node && ctx.components) ctx.components.record.set(data, node.id);
    return node;
  }
  async function buildRoot(root, ctx) {
    const frame = await buildNode(root, ctx);
    frame.clipsContent = true;
    return frame;
  }

  // src/main/components.ts
  var GENERIC = /* @__PURE__ */ new Set(["Frame", "Row", "Column", "Grid", "Group", "Container", "Box", "Item"]);
  var n = (v) => Math.round(v);
  var c = (k) => `${n(k.r * 255)},${n(k.g * 255)},${n(k.b * 255)},${Math.round(k.a * 100)}`;
  function fillKey(f) {
    if (f.kind === "solid") return c(f.color);
    if (f.kind === "image") return `img:${f.scaleMode}`;
    return `${f.kind}:${f.stops.map((s) => `${c(s.color)}@${Math.round(s.position * 100)}`).join(",")}`;
  }
  function boxKey(s) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _i, _j;
    const b = s.border;
    return [
      s.fills.map(fillKey).join("+"),
      b ? `${b.top},${b.right},${b.bottom},${b.left},${c(b.color)},${b.style},${(_b = (_a = b.sideColors) == null ? void 0 : _a.map(c).join("/")) != null ? _b : ""}` : "",
      (_d = (_c = s.radius) == null ? void 0 : _c.map(n).join(",")) != null ? _d : "",
      (_f = (_e = s.shadows) == null ? void 0 : _e.map((h) => `${h.type}${c(h.color)}${n(h.x)},${n(h.y)},${n(h.blur)},${n(h.spread)}`).join("+")) != null ? _f : "",
      (_g = s.opacity) != null ? _g : "",
      (_h = s.blendMode) != null ? _h : "",
      s.clips ? "c" : "",
      (_i = s.layerBlur) != null ? _i : "",
      (_j = s.backgroundBlur) != null ? _j : ""
    ].join("|");
  }
  function runKey(r) {
    var _a;
    return [
      r.fontFamily,
      r.fontWeight,
      r.italic ? "i" : "",
      r.fontSize,
      (_a = r.lineHeight) != null ? _a : "",
      r.letterSpacing,
      r.color ? c(r.color) : "",
      r.gradient ? fillKey(r.gradient) : "",
      r.decoration,
      r.textCase
    ].join(",");
  }
  function hash(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = (h << 5) + h + s.charCodeAt(i) | 0;
    return (h >>> 0).toString(36);
  }
  var hasBox = (s) => {
    var _a, _b;
    return s.fills.length > 0 || !!s.border || !!((_a = s.shadows) == null ? void 0 : _a.length) || !!((_b = s.radius) == null ? void 0 : _b.some((r) => r > 0));
  };
  function* walk(node) {
    yield node;
    if (node.type === "FRAME") for (const child of node.children) yield* walk(child);
  }
  function sameImages(a, b) {
    return a.length === b.length && a.every((f, i) => f.kind !== "image" || b[i].kind === "image" && b[i].imageId === f.imageId);
  }
  var Components = class {
    constructor(root, autoLayout, boardName) {
      this.autoLayout = autoLayout;
      this.boardName = boardName;
      this.sigs = /* @__PURE__ */ new Map();
      this.groupOf = /* @__PURE__ */ new Map();
      this.board = null;
      this.names = /* @__PURE__ */ new Map();
      this.record = /* @__PURE__ */ new Map();
      // node -> id of the layer that shows it in the document
      this.count = 0;
      const groups = /* @__PURE__ */ new Map();
      for (const node of walk(root)) {
        if (node === root || node.type !== "FRAME" || !this.worthIt(node)) continue;
        const sig = this.sig(node);
        let g = groups.get(sig);
        if (!g) groups.set(sig, g = { name: "", members: [] });
        g.members.push(node);
      }
      for (const g of groups.values()) {
        if (g.members.length < 2) continue;
        const inside = /* @__PURE__ */ new Set();
        for (const m of g.members) for (const d of walk(m)) if (d !== m) inside.add(d);
        g.members = g.members.filter((m) => !inside.has(m));
        if (g.members.length < 2) continue;
        for (const m of g.members) this.groupOf.set(m, g);
      }
    }
    worthIt(node) {
      if (node.width < 8 || node.height < 8 || !node.children.length) return false;
      let count = 0;
      for (const d of walk(node)) if (d !== node) count++;
      if (!hasBox(node.style) && node.children.length === 1) return false;
      return hasBox(node.style) ? count >= 1 : count >= 3;
    }
    sig(node) {
      var _a, _b;
      let s = this.sigs.get(node);
      if (s) return s;
      const rot = node.rotation ? `r${n(node.rotation)}` : "";
      const cl = node.childLayout ? `${node.childLayout.absolute ? "a" : ""}${node.childLayout.grow ? "g" : ""}${node.childLayout.stretch ? "s" : ""}` : "";
      switch (node.type) {
        case "TEXT":
          s = `T(${node.runs.filter((r) => r.text).map(runKey).join(";")}|${node.align}|${node.singleLine ? "1" : n(node.width)}|${(_a = node.opacity) != null ? _a : ""}${rot}${cl})`;
          break;
        case "IMAGE":
          s = `I(${boxKey(node.style)}|${n(node.width)}x${n(node.height)}${rot}${cl})`;
          break;
        case "SVG":
          s = `S(${hash(node.svg)}|${n(node.width)}x${n(node.height)}|${(_b = node.opacity) != null ? _b : ""}${rot}${cl})`;
          break;
        case "FRAME": {
          const layout = this.autoLayout ? node.layout : void 0;
          const size = layout ? "~" : `${n(node.width)}x${n(node.height)}`;
          const lk = layout ? `${layout.mode}${layout.wrap ? "w" : ""},${n(layout.gap)},${layout.padding.map(n).join(",")},${layout.primaryAlign},${layout.counterAlign}` : "";
          const at = (k) => {
            const x = k.type === "TEXT" && k.singleLine ? k.align === "CENTER" ? k.x + k.width / 2 : k.align === "RIGHT" ? k.x + k.width : k.x : k.x;
            return `@${n(x)},${n(k.y)}`;
          };
          const kids = node.children.map((k) => {
            var _a2;
            return (layout && !((_a2 = k.childLayout) == null ? void 0 : _a2.absolute) ? "" : at(k)) + this.sig(k);
          });
          s = `F(${boxKey(node.style)}|${lk}|${size}${rot}${cl})[${kids.join(",")}]`;
          break;
        }
      }
      this.sigs.set(node, s);
      return s;
    }
    isOccurrence(node) {
      return this.groupOf.has(node);
    }
    boardNode() {
      return this.board;
    }
    ensureBoard() {
      if (this.board) return this.board;
      const b = figma.createFrame();
      b.name = this.boardName;
      b.layoutMode = "HORIZONTAL";
      b.layoutWrap = "WRAP";
      b.itemSpacing = 48;
      b.counterAxisSpacing = 48;
      b.paddingTop = b.paddingRight = b.paddingBottom = b.paddingLeft = 48;
      b.primaryAxisSizingMode = "FIXED";
      b.counterAxisSizingMode = "AUTO";
      b.resize(1440, 200);
      b.fills = [{ type: "SOLID", color: { r: 0.96, g: 0.96, b: 0.96 } }];
      b.cornerRadius = 16;
      b.clipsContent = false;
      this.board = b;
      return b;
    }
    nameFor(node) {
      var _a;
      let base = node.name.split(" \xB7 ")[0].trim() || "Component";
      if (GENERIC.has(base)) base = "Card";
      const k = ((_a = this.names.get(base)) != null ? _a : 0) + 1;
      this.names.set(base, k);
      return k === 1 ? base : `${base} ${k}`;
    }
    async place(node, ctx) {
      const g = this.groupOf.get(node);
      if (!g.main) {
        const main = await buildFrame(node, ctx, true);
        main.name = g.name = this.nameFor(node);
        this.ensureBoard().appendChild(main);
        g.main = main;
        g.mainData = node;
        g.ids = /* @__PURE__ */ new Map();
        for (const d of walk(node)) {
          const id = this.record.get(d);
          if (id && d !== node) g.ids.set(d, id);
        }
        await this.anchorLabels(node, main);
        this.count++;
      }
      const inst = g.main.createInstance();
      inst.name = node.name;
      if (Math.abs(inst.width - node.width) > 0.5 || Math.abs(inst.height - node.height) > 0.5) {
        inst.resize(Math.max(node.width, 0.01), Math.max(node.height, 0.01));
      }
      this.record.set(node, inst.id);
      const ids = g.ids;
      const sub = (id) => `I${inst.id};${id.replace(/^I/, "")}`;
      if (node === g.mainData) {
        for (const [d, id] of ids) this.record.set(d, sub(id));
      } else {
        await this.overrideChildren(g.mainData, node, sub, ids, ctx);
      }
      return inst;
    }
    // Single-line text grows to the right, and an instance cannot move its layers. So inside a main
    // component, centered and right-aligned labels get a box that reaches the frame's edge, with the text
    // aligned inside it: a longer label in an instance then stays on its anchor.
    async anchorLabels(frame, layerFrame) {
      var _a;
      const free = !this.autoLayout || !frame.layout;
      for (const k of frame.children) {
        const id = this.record.get(k);
        if (!id) continue;
        if (k.type === "FRAME") {
          const sub = await figma.getNodeByIdAsync(id);
          if (sub) await this.anchorLabels(k, sub);
        } else if (k.type === "TEXT" && k.singleLine && (k.align === "CENTER" || k.align === "RIGHT") && (free || ((_a = k.childLayout) == null ? void 0 : _a.absolute))) {
          const text = await figma.getNodeByIdAsync(id);
          if (!text || text.rotation) continue;
          const center = text.x + text.width / 2;
          const right = text.x + text.width;
          const half = Math.min(center, layerFrame.width - center);
          if (k.align === "CENTER" && half > text.width / 2) {
            text.textAutoResize = "HEIGHT";
            text.resize(half * 2, text.height);
            text.x = center - half;
          } else if (k.align === "RIGHT" && right > text.width) {
            text.textAutoResize = "HEIGHT";
            text.resize(right, text.height);
            text.x = 0;
          }
        }
      }
    }
    // Walks the main occurrence and this one side by side (same shape by construction) and gives the
    // instance this occurrence's own text, links and images.
    async overrideChildren(a, b, sub, ids, ctx) {
      for (let i = 0; i < a.children.length && i < b.children.length; i++) {
        const ca = a.children[i];
        const cb = b.children[i];
        const id = ids.get(ca);
        if (id) {
          const layerId = sub(id);
          this.record.set(cb, layerId);
          if (ca.type === "TEXT" && cb.type === "TEXT") {
            const key = (t) => t.runs.map((r) => {
              var _a;
              return `${r.text}\0${(_a = r.href) != null ? _a : ""}`;
            }).join("");
            if (key(ca) !== key(cb)) {
              const layer = await figma.getNodeByIdAsync(layerId);
              if (layer) await applyRuns(layer, cb.runs.filter((r) => r.text.length > 0), ctx);
            }
          } else if ((ca.type === "IMAGE" || ca.type === "FRAME") && (cb.type === "IMAGE" || cb.type === "FRAME")) {
            if (!sameImages(ca.style.fills, cb.style.fills)) {
              const layer = await figma.getNodeByIdAsync(layerId);
              if (layer) layer.fills = toPaints(cb.style.fills, ctx);
            }
          }
        }
        if (ca.type === "FRAME" && cb.type === "FRAME") await this.overrideChildren(ca, cb, sub, ids, ctx);
      }
    }
  };

  // src/main/styles.ts
  var r2 = (v) => Math.round(v * 100) / 100;
  var lhKey = (l) => l.unit === "AUTO" ? "auto" : `${r2(l.value)}${l.unit === "PIXELS" ? "px" : "%"}`;
  var textKey = (k) => [k.font.family, k.font.style, r2(k.size), lhKey(k.lineHeight), r2(k.letterSpacing.value) + k.letterSpacing.unit, k.decoration, k.textCase].join("|");
  var hex = (c2) => "#" + [c2.r, c2.g, c2.b].map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("").toUpperCase();
  var paintKey = (p) => {
    var _a, _b;
    return `${hex(p.color)}${((_a = p.opacity) != null ? _a : 1) < 1 ? ` ${Math.round(((_b = p.opacity) != null ? _b : 1) * 100)}%` : ""}`;
  };
  function soleSolid(paints) {
    var _a;
    if (paints === figma.mixed || paints.length !== 1) return null;
    const p = paints[0];
    return p.type === "SOLID" && p.visible !== false && !((_a = p.boundVariables) == null ? void 0 : _a.color) ? p : null;
  }
  function* layers(node) {
    yield node;
    if ("children" in node) for (const child of node.children) yield* layers(child);
  }
  async function applyStyles(roots, folder) {
    var _a, _b, _c, _d, _e;
    const prefix = folder.replace(/\//g, "-").replace(/\s+/g, " ").trim().slice(0, 48) || "Imported";
    const textUses = /* @__PURE__ */ new Map();
    const colorUses = /* @__PURE__ */ new Map();
    const color = (p) => {
      const k = paintKey(p);
      let u = colorUses.get(k);
      if (!u) colorUses.set(k, u = { paint: p, fills: [], strokes: [], text: [] });
      return u;
    };
    for (const root of roots) {
      for (const node of layers(root)) {
        if (node.type === "TEXT") {
          const segs = node.getStyledTextSegments(["fontName", "fontSize", "lineHeight", "letterSpacing", "textDecoration", "textCase", "fills"]);
          for (const s of segs) {
            const key = { font: s.fontName, size: s.fontSize, lineHeight: s.lineHeight, letterSpacing: s.letterSpacing, decoration: s.textDecoration, textCase: s.textCase };
            const k = textKey(key);
            let u = textUses.get(k);
            if (!u) textUses.set(k, u = { key, segs: [], chars: 0 });
            const seg = { node, start: s.start, end: s.end };
            u.segs.push(seg);
            u.chars += s.end - s.start;
            const p = soleSolid(s.fills);
            if (p) color(p).text.push(seg);
          }
        } else if ("fills" in node && node.type !== "INSTANCE") {
          const geo = node;
          const f = soleSolid(geo.fills);
          if (f) color(f).fills.push(geo);
          const s = soleSolid(geo.strokes);
          if (s) color(s).strokes.push(geo);
        }
      }
    }
    const bySize = /* @__PURE__ */ new Map();
    for (const u of textUses.values()) bySize.set(r2(u.key.size), ((_a = bySize.get(r2(u.key.size))) != null ? _a : 0) + u.chars);
    const body = (_c = (_b = [...bySize].sort((a, b) => b[1] - a[1])[0]) == null ? void 0 : _b[0]) != null ? _c : 16;
    const larger = [...bySize.keys()].filter((s) => s > body).sort((a, b) => b - a);
    const smaller = [...bySize.keys()].filter((s) => s < body).sort((a, b) => b - a);
    const SMALL = ["Small", "Caption", "Micro"];
    const sizeName = (s) => {
      if (s === body) return "Body";
      if (s > body) {
        const i2 = larger.indexOf(s);
        return i2 < 6 ? `Heading ${i2 + 1}` : `Large ${s}`;
      }
      const i = smaller.indexOf(s);
      return i < SMALL.length ? SMALL[i] : `Tiny ${s}`;
    };
    const keep = [...textUses.values()].filter((u) => u.segs.length >= 2 || u.key.size >= body * 1.2);
    await figma.loadFontAsync({ family: "Inter", style: "Regular" });
    const existingText = new Map((await figma.getLocalTextStylesAsync()).map((s) => [s.name, s]));
    const taken = /* @__PURE__ */ new Set();
    let textCount = 0;
    const groups = /* @__PURE__ */ new Map();
    for (const u of keep) {
      const s = r2(u.key.size);
      groups.set(s, [...(_d = groups.get(s)) != null ? _d : [], u]);
    }
    for (const [size, us] of groups) {
      us.sort((a, b) => b.chars - a.chars);
      for (const u of us) {
        let name = `${prefix}/Text/${sizeName(size)}`;
        if (us.length > 1) name += ` \xB7 ${u.key.font.style}`;
        if (u.key.textCase === "UPPER") name += " \xB7 Caps";
        if (u.key.decoration === "UNDERLINE") name += " \xB7 Underline";
        let unique = name;
        for (let i = 2; taken.has(unique); i++) unique = `${name} ${i}`;
        taken.add(unique);
        let style = existingText.get(unique);
        if (!style || textKey({ font: style.fontName, size: style.fontSize, lineHeight: style.lineHeight, letterSpacing: style.letterSpacing, decoration: style.textDecoration, textCase: style.textCase }) !== textKey(u.key)) {
          if (style) {
            let i = 2;
            while (existingText.has(`${unique} ${i}`) || taken.has(`${unique} ${i}`)) i++;
            unique = `${unique} ${i}`;
            taken.add(unique);
          }
          style = figma.createTextStyle();
          style.name = unique;
          style.fontName = u.key.font;
          style.fontSize = u.key.size;
          style.lineHeight = u.key.lineHeight;
          style.letterSpacing = u.key.letterSpacing;
          style.textDecoration = u.key.decoration;
          style.textCase = u.key.textCase;
          textCount++;
        }
        for (const seg of u.segs) {
          if (seg.node.getRangeTextStyleId(seg.start, seg.end) === style.id) continue;
          await seg.node.setRangeTextStyleIdAsync(seg.start, seg.end, style.id);
        }
      }
    }
    const existingPaint = new Map((await figma.getLocalPaintStylesAsync()).map((s) => [s.name, s]));
    let colorCount = 0;
    const colors = [...colorUses.entries()].map(([k, u]) => ({ k, u, uses: u.fills.length + u.strokes.length + u.text.length })).filter((c2) => c2.uses >= 2).sort((a, b) => b.uses - a.uses);
    for (const { k, u } of colors) {
      const name = `${prefix}/Color/${k}`;
      let style = existingPaint.get(name);
      if (!style) {
        style = figma.createPaintStyle();
        style.name = name;
        style.paints = [{ type: "SOLID", color: { ...u.paint.color }, opacity: (_e = u.paint.opacity) != null ? _e : 1 }];
        colorCount++;
      }
      for (const n2 of u.fills) if (n2.fillStyleId !== style.id) await n2.setFillStyleIdAsync(style.id);
      for (const n2 of u.strokes) if (n2.strokeStyleId !== style.id) await n2.setStrokeStyleIdAsync(style.id);
      for (const seg of u.text) {
        if (seg.node.getRangeFillStyleId(seg.start, seg.end) === style.id) continue;
        await seg.node.setRangeFillStyleIdAsync(seg.start, seg.end, style.id);
      }
    }
    return { text: textCount, color: colorCount };
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
      const c2 = figma.viewport.center;
      return { x: Math.round(c2.x), y: Math.round(c2.y) };
    }
    let right = -Infinity;
    let top = Infinity;
    for (const n2 of children) {
      right = Math.max(right, n2.x + n2.width);
      top = Math.min(top, n2.y);
    }
    return { x: Math.round(right + FRAME_GAP * 2), y: Math.round(top) };
  }
  function newBatch() {
    const { x, y } = startPosition();
    return { images: /* @__PURE__ */ new Map(), chunks: /* @__PURE__ */ new Map(), frames: [], made: { components: 0, text: 0, color: 0 }, updated: 0, cursorX: x, cursorY: y, cancelled: false };
  }
  function framesNamed(name) {
    return figma.currentPage.findAll(
      (n2) => {
        var _a, _b;
        return n2.type === "FRAME" && n2.name === name && (((_a = n2.parent) == null ? void 0 : _a.type) === "PAGE" || ((_b = n2.parent) == null ? void 0 : _b.type) === "SECTION");
      }
    );
  }
  function swap(old, next) {
    const parent = old.parent;
    const { x, y } = old;
    parent.insertChild(parent.children.indexOf(old), next);
    next.x = x;
    next.y = y;
    old.remove();
  }
  async function importDoc(msg) {
    var _a;
    if (!batch) batch = newBatch();
    const state = batch;
    const parts = state.chunks.get(msg.docId);
    state.chunks.delete(msg.docId);
    if (!parts || parts.some((p) => p === void 0)) throw new Error("Import data arrived incomplete. Please try again.");
    const doc = JSON.parse(parts.join(""));
    const components = msg.settings.components ? new Components(doc.root, msg.settings.autoLayout, `${doc.name} \xB7 Components`) : void 0;
    const ctx = {
      images: state.images,
      fontMap: msg.fontMap,
      settings: msg.settings,
      isCancelled: () => state.cancelled,
      onProgress: (built) => send({ type: "progress", message: `Creating layers\u2026 ${built}`, done: built }),
      built: 0,
      components
    };
    let frame = null;
    const before = new Set(figma.currentPage.children.map((c2) => c2.id));
    const old = msg.replace ? framesNamed(doc.name)[0] : void 0;
    const oldBoard = old ? framesNamed(`${doc.name} \xB7 Components`)[0] : void 0;
    try {
      frame = await buildRoot(doc.root, ctx);
      frame.name = doc.name;
      frame.x = state.cursorX;
      frame.y = state.cursorY;
      figma.currentPage.appendChild(frame);
      const board = components == null ? void 0 : components.boardNode();
      if (board) {
        figma.currentPage.appendChild(board);
        board.resize(Math.max(frame.width, 600), board.height);
        board.counterAxisSizingMode = "AUTO";
        board.x = frame.x;
        board.y = frame.y + frame.height + FRAME_GAP;
        state.made.components += components.count;
      }
      if (msg.settings.components) {
        send({ type: "progress", message: "Creating text and color styles\u2026" });
        try {
          const made = await applyStyles(board ? [board, frame] : [frame], (_a = doc.group) != null ? _a : doc.name);
          state.made.text += made.text;
          state.made.color += made.color;
        } catch (err) {
          console.error("[page-to-figma] styles", err);
        }
      }
      if (old && !old.removed) {
        const parent = old.parent;
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
      send({ type: "doc-done", docId: msg.docId, nodeCount: ctx.built });
    } catch (err) {
      for (const node of [...figma.currentPage.children]) if (!before.has(node.id) && !node.removed) node.remove();
      if (frame && !frame.removed) frame.remove();
      const board = components == null ? void 0 : components.boardNode();
      if (board && !board.removed) board.remove();
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
      const { components, text, color } = state.made;
      const extras = [
        components && `${components} component${components > 1 ? "s" : ""}`,
        text && `${text} text style${text > 1 ? "s" : ""}`,
        color && `${color} color style${color > 1 ? "s" : ""}`
      ].filter(Boolean);
      const verb = state.updated === frames.length ? "Updated" : "Imported";
      const what = frames.length === 1 ? `${verb} "${frames[0].name}"` : `${verb} ${frames.length} frames`;
      figma.notify(extras.length ? `${what} with ${extras.join(", ")}` : what);
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
        case "find-existing":
          send({ type: "existing", names: msg.names.filter((n2) => framesNamed(n2).length > 0) });
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
