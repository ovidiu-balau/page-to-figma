# Page to Figma

A Figma plugin that turns web pages into editable Figma layers: frames, live text, vectors, images, gradients, shadows and Auto Layout. Send any page from Chrome with one click, or a design from Claude by saying "send this to Figma".

Free and open source (MIT). No account, no usage limits, nothing sent to a server: pages go from your browser or Claude to Figma through a small relay on your own Mac.

## Install (Figma desktop)

**Just the plugin:** download this repo ([ZIP](https://github.com/ovidiu-balau/page-to-figma/archive/refs/heads/main.zip)), then in
Figma desktop choose **Plugins > Development > Import plugin from manifest…** and pick `manifest.json`.
The built plugin is included, so URL, Upload File and Paste Code work straight away.

**Everything (browser button and Claude):** on a Mac with Node.js 18 or newer:

```sh
git clone https://github.com/ovidiu-balau/page-to-figma.git ~/Projects/page-to-figma
cd ~/Projects/page-to-figma
sh scripts/setup.sh
```

That builds the plugin, starts the relay at login and installs the `send-to-figma` Claude skill.

In Figma desktop: **Plugins > Development > Import plugin from manifest…** and pick `manifest.json` in this folder. It then appears under **Plugins > Development > Page to Figma**. After the first run, **Cmd + Option + P** reruns it.

## Send from the browser (one click)

The `extension/` folder is a Chrome extension with a single button. Clicking it on any tab captures the page exactly as you see it (signed-in pages, typed form values, JavaScript-rendered content), embeds its styles, fonts and images, and sends it to the plugin, which imports it straight away at the tab's width.

One-time setup:

1. **Relay** (a tiny local server the button talks to): `npm run relay` in a terminal, or `sh scripts/relay-install.sh` to start it automatically at login (`sh scripts/relay-install.sh uninstall` removes it). It only listens on `localhost:7801`, keeps captures in memory for an hour, and only accepts captures from the extension.
2. **Extension**: open `chrome://extensions`, switch on Developer mode, choose **Load unpacked** and pick the `extension` folder. Pin the "Send to Figma" button. The keyboard shortcut is **Alt + Shift + F**.
3. Open the plugin in Figma. The header shows **Browser button ready** when it is connected.

Then click the button on any tab. If the plugin is closed, the capture waits and imports the next time you open it. If the relay is not running, the button downloads a `.h2f.json` file instead; drop it into Upload File.

## Send from Claude

`scripts/send.mjs` pushes a page to the open plugin through the same relay, no browser needed:

```sh
npm run send -- page.html --title "Homepage" --width 1440      # a local file, with the files beside it embedded
npm run send -- https://example.com                            # a URL, fetched and rendered in the plugin
```

Pages keep their scripts, so designs that render with JavaScript still import. The `send-to-figma`
Claude skill (in `~/.claude/skills/send-to-figma`) uses this: in any Claude session, say "send this
to Figma" and the current artifact or Claude Design canvas lands in Figma, one frame per artboard.

## Use

- **URL**: paste a link. Most sites block direct requests from plugins, so set a CORS proxy in Options first (see below). "Capture in dark mode" applies the page's dark theme.
- **Upload File**: pick `.html` files together with their CSS and images, or a `.zip` of a saved site. Every HTML file becomes a page you can pick.
- **Paste Code**: HTML plus optional CSS. Tailwind classes work without a stylesheet.
- **Viewport**: the width the page is laid out at (1440 by default).

Single-file prototypes that switch between screens (`.screen.active`, `[data-page]`, `hidden` siblings, tab panels) are detected; a picker shows live previews so you can choose, rename and import several screens at once, each as its own frame.

If a page uses fonts Figma does not have, a sheet asks for a replacement for each before importing.

## Options

| Option | What it does |
| --- | --- |
| Use Auto Layout | On by default. Flex and Grid containers become Auto Layout frames, but only where Auto Layout reproduces the browser's placement exactly. Everything else keeps absolute positions. |
| Leave out pop-ups | On by default. Skips cookie banners, chat bubbles, newsletter prompts and modals that float over the page. |
| Include images | Downloads images and embeds them. WebP, AVIF and SVG images are converted for Figma. |
| Enable Tailwind CSS | Loads the Tailwind play CDN when markup uses Tailwind classes but ships no stylesheet. |
| Disable Preflight | Skips Tailwind's reset so the page's own styles win. |
| Custom Tailwind config | JSON merged into `tailwind.config`. |
| Root font size | Sets `html { font-size }`; applies to pasted code always, and to pages when not 16. |
| CORS proxy URL | Used when a page or image cannot be fetched directly. `{url}` is replaced with the target, otherwise `?url=` is appended. |

## CORS proxy

`proxy/worker.js` is a small Cloudflare Worker (free tier) that relays GET requests and adds CORS headers. It never forwards cookies.

```sh
npx wrangler deploy proxy/worker.js --name page-to-figma-proxy --compatibility-date 2026-01-01
```

Paste the resulting `https://page-to-figma-proxy.<you>.workers.dev/` into Options. For local testing, `node test/local-proxy.mjs` runs the same code on `http://127.0.0.1:8787/`.

## Development

```sh
npm run build       # dist/code.js and dist/ui.html
npm run watch       # rebuild on change
npm run typecheck
node test/harness.mjs                     # runs the built UI on the fixtures, writes test/output
node test/extract-page.mjs kitchen-sink.html [--autolayout]   # prints the extracted tree
node test/replay.mjs kitchen-sink         # use_figma scripts that build a capture in a Figma file
python3 test/compare.py ref.png figma.png out   # pixel diff of browser vs Figma renders
node test/ui-shots.mjs                    # screenshots of every UI state
node test/e2e-extension.mjs kitchen-sink.html 1280   # browser button > relay > plugin, end to end
```

`src/ui` renders the page in a hidden iframe and walks the DOM into a typed tree (`src/shared/types.ts`); `src/main` turns that tree into Figma nodes.

## Known limits

- Page scripts run inside the plugin's sandbox (needed for apps that render with JavaScript).
- Text uses Figma's font metrics, which can differ slightly from the browser's. Wrapped text is widened a little when Figma would otherwise add a line, and text squeezed between inline boxes gets slightly tighter tracking.
- Icon fonts are imported as sharp 4× bitmaps rather than vectors.
- Shadow DOM content and cross-origin iframes are not captured (iframes import as placeholders).
