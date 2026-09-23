#!/usr/bin/env bash
# Preview a pre-public source rename. Add --apply to write; see docs/DISTRIBUTION.md.
set -euo pipefail
exec node "$(cd -- "$(dirname -- "$0")" && pwd)/rename.mjs" "$@"
