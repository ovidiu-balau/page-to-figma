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
OLD_SKILL="$HOME/.claude/skills/send-to-figma"
if command -v claude >/dev/null 2>&1; then
  # As a Claude Code plugin from this folder; earlier versions copied the skill by hand.
  if [ -f "$OLD_SKILL/SKILL.md" ] && grep -q "Figma" "$OLD_SKILL/SKILL.md"; then rm -f "$OLD_SKILL/SKILL.md"; rmdir "$OLD_SKILL" 2>/dev/null || true; fi
  claude plugin marketplace add "$ROOT" >/dev/null 2>&1 || claude plugin marketplace update page-to-figma >/dev/null 2>&1 || true
  claude plugin install page-to-figma@page-to-figma >/dev/null 2>&1 || claude plugin update page-to-figma@page-to-figma >/dev/null 2>&1 || true
  claude plugin list 2>/dev/null | grep -q page-to-figma && echo "Claude plugin installed." || echo "Could not install the Claude plugin; in Claude Code run: /plugin marketplace add $ROOT"
else
  # No Claude Code CLI: install the skill directly, pointed at this folder.
  mkdir -p "$OLD_SKILL"
  sed "s#<root>#$ROOT#g; s#two levels up from this skill's base directory#this folder#" skills/send-to-figma/SKILL.md > "$OLD_SKILL/SKILL.md"
fi

cat <<DONE

Done. Two clicks left:
  Figma desktop:  Plugins > Development > Import plugin from manifest... and pick
                  $ROOT/manifest.json
  Chrome (optional, for the page button):  chrome://extensions > Developer mode >
                  Load unpacked > $ROOT/extension

Then in Claude, say "send this to Figma".
DONE
