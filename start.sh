#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
if command -v node >/dev/null 2>&1; then
  exec node --env-file-if-exists=.env server.js
fi
for vht_node in "$HOME/.local/share/vht-node/current/bin/node" "$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"; do
  if [[ -x "$vht_node" ]]; then
    exec "$vht_node" --env-file-if-exists=.env server.js
  fi
done
echo 'Cần Node.js 22+. Cài Node rồi chạy lại ./start.sh.' >&2
exit 1
