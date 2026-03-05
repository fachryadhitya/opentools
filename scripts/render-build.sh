#!/usr/bin/env bash
set -euo pipefail

if [ ! -x "$HOME/.bun/bin/bun" ]; then
  curl -fsSL https://bun.sh/install | bash
fi

export PATH="$HOME/.bun/bin:$PATH"

bun install --frozen-lockfile
bun run build:css
