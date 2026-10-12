#!/bin/sh
# One-time setup on a Mac: builds the plugin, starts the relay at login and installs the
# send-to-figma Claude skill. Run from anywhere:  sh scripts/setup.sh
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is needed (version 18 or newer). Install it from https://nodejs.org and run this again."
  exit 1
fi
MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$MAJOR" -lt 18 ]; then
  echo "Node.js $MAJOR is too old; version 18 or newer is needed."
  exit 1
fi

echo "1/3 Building the plugin"
npm install --no-fund --no-audit --loglevel=error
npm run -s build

echo "2/3 Starting the relay (and at every login)"
sh scripts/relay-install.sh

echo "3/3 Installing the send-to-figma Claude skill"
SKILL="$HOME/.claude/skills/send-to-figma"
mkdir -p "$SKILL"
# The skill points at this folder, wherever it was unpacked.
sed "s#~/Projects/page-to-figma#$ROOT#g" claude-skill/send-to-figma/SKILL.md > "$SKILL/SKILL.md"

cat <<DONE

Done. Two clicks left:
  Figma desktop:  Plugins > Development > Import plugin from manifest... and pick
                  $ROOT/manifest.json
  Chrome (optional, for the page button):  chrome://extensions > Developer mode >
                  Load unpacked > $ROOT/extension

Then in Claude, say "send this to Figma".
DONE
