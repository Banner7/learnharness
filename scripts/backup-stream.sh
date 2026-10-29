#!/bin/sh
# Forced SSH command on the deployment host: streams the data directory as tar.
# Defaults to data/ beside this checkout's scripts/; set LH_BACKUP_DATA_DIR to override.
set -eu
LH_BACKUP_DATA_DIR="${LH_BACKUP_DATA_DIR:-$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)/data}"
[ -d "$LH_BACKUP_DATA_DIR" ] || { echo 'LearnHarness data directory missing' >&2; exit 1; }
exec tar -C "$LH_BACKUP_DATA_DIR" -cf - .
