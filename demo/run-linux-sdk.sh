#!/usr/bin/env bash
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
bundle="${1:-$repo/$(node -p "const pkg = require(process.argv[1]); pkg.name + '-' + pkg.version + '.tgz'" "$repo/package.json")}"
bundle="$(realpath "$bundle")"
work="$(mktemp -d)"
export DSH_HOME="$work/dsh"
export DSH_TELEMETRY_DISABLED=1
export npm_config_registry=https://registry.npmjs.org
printf '{"name":"tooldna-linux-acceptance","private":true}\n' > "$work/package.json"
npm --prefix "$work" install --save-exact @deepseek-ai/dsh@0.2.2-rc.5
bin="$work/node_modules/@deepseek-ai/dsh/lib/bin.js"
node "$bin" --version
node "$bin" --profile sdk --dump-default-config >/dev/null
node "$bin" plugin --profile sdk add "$bundle"
node "$repo/demo/verify-sdk.mjs" "$bin" "$DSH_HOME"
node "$bin" plugin --profile sdk remove dsh-tooldna
node "$repo/demo/verify-sdk.mjs" "$bin" "$DSH_HOME" --control
if [[ "${TOOLDNA_VERIFY_WEB:-0}" == 1 ]]; then
  export DSH_HOME="$work/dsh-web"
  node "$bin" plugin --profile web add "$bundle"
  node "$repo/demo/verify-sdk.mjs" "$bin" "$DSH_HOME" --web
  node "$bin" plugin --profile web remove dsh-tooldna
  node "$repo/demo/verify-sdk.mjs" "$bin" "$DSH_HOME" --web --control
fi
printf 'Acceptance workspace %s\n' "$work"
