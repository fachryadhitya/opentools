#!/usr/bin/env bash
set -euo pipefail

export PATH="$HOME/.bun/bin:$PATH"

mkdir -p "$(dirname "${DB_PATH:-./data/uses.sqlite}")"

exec bun run seed
