#!/bin/bash
set -euo pipefail

CLASHD27_PATH="/Users/wiardvasen/clashd27"
LIBRARY_ROOT="${CLASHD27_LIBRARY_ROOT:-$CLASHD27_PATH/data}"
BACKUP_DIR="${CLASHD27_LIBRARY_BACKUP_DIR:-$CLASHD27_PATH/backups}"
STAMP="$(date +%Y-%m-%dT%H-%M-%S)"
ARCHIVE_PATH="$BACKUP_DIR/gap-library-backup-$STAMP.tar.gz"

mkdir -p "$BACKUP_DIR"

tar -czf "$ARCHIVE_PATH" \
  -C "$LIBRARY_ROOT" \
  gap-library.jsonl \
  gap-library-index.json \
  domains \
  library-runs

echo "$ARCHIVE_PATH"
