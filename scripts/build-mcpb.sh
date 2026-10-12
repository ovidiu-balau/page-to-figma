#!/bin/sh
# Packs the Claude desktop extension: dist/page-to-figma.mcpb (a zip with the MCP server, the page
# helpers and the relay). Double-clicking the file installs it in the Claude app.
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/dist/page-to-figma.mcpb"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/server/lib"
cp "$ROOT/mcp/manifest.json" "$STAGE/manifest.json"
cp "$ROOT/assets/icon-512.png" "$STAGE/icon.png"
cp "$ROOT/mcp/server.mjs" "$STAGE/server/index.mjs"
cp "$ROOT/scripts/lib/page.mjs" "$STAGE/server/lib/page.mjs"
cp "$ROOT/relay/server.mjs" "$STAGE/server/relay.mjs"
mkdir -p "$ROOT/dist"
rm -f "$OUT"
(cd "$STAGE" && zip -qrX "$OUT" .)
echo "Built $OUT"
