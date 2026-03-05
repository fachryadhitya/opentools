#!/usr/bin/env bash
set -euo pipefail

export PATH="$HOME/.bun/bin:$PATH"

db_path="${DB_PATH:-/var/data/uses.sqlite}"
db_dir="$(dirname "$db_path")"

if ! mkdir -p "$db_dir" 2>/dev/null; then
  echo "warn: cannot write to '$db_dir', falling back to ./data/uses.sqlite"
  db_path="./data/uses.sqlite"
  mkdir -p "$(dirname "$db_path")"
fi

export DB_PATH="$db_path"

exec bun run start
