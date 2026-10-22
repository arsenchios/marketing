#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
runtime="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies"
if ! command -v node >/dev/null 2>&1; then
  if [ ! -x "$runtime/node/bin/node" ]; then echo 'Install Node.js 24+ to continue.' >&2; exit 1; fi
  PATH="$runtime/node/bin:$PATH"
fi
if [ -d "$runtime/bin/override" ]; then PATH="$runtime/bin/override:$runtime/bin/fallback:$PATH"; fi
if [ -d /opt/homebrew/bin ]; then PATH="/opt/homebrew/bin:$PATH"; fi
export PATH
action="${1:-dev}"
case "$action" in
  install) exec pnpm install --store-dir .pnpm-store ;;
  dev) exec node --import tsx server/index.ts ;;
  start) NODE_ENV=production; export NODE_ENV; exec node --import tsx server/index.ts ;;
  client-preview) exec node --import tsx scripts/client-preview.ts ;;
  check) exec node node_modules/typescript/bin/tsc --noEmit ;;
  test) exec node --import tsx --test tests/*.test.ts ;;
  build) node node_modules/typescript/bin/tsc --noEmit; exec node node_modules/vite/bin/vite.js build ;;
  *) echo 'Usage: ./scripts/local.sh [install|dev|start|client-preview|check|test|build]' >&2; exit 1 ;;
esac
