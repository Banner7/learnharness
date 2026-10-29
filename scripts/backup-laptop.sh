#!/usr/bin/env bash
# Run on the backup client. Requires SSH access, restic, and Node.js.
# Configure LH_REMOTE_DATA, LH_EXPORT_DIR and RESTIC_* before scheduling.
set -euo pipefail
: "${LH_REMOTE_DATA:?set LH_REMOTE_DATA to the absolute deployment host data directory}"
: "${LH_EXPORT_DIR:?set LH_EXPORT_DIR to the local Markdown export directory}"
: "${LH_SSH_TARGET:?set LH_SSH_TARGET to a forced-command SSH alias for the deployment host}"
: "${RESTIC_REPOSITORY:?set RESTIC_REPOSITORY}"
: "${RESTIC_PASSWORD_FILE:?set RESTIC_PASSWORD_FILE}"
case "$LH_REMOTE_DATA" in
  /*) ;;
  *) echo 'LH_REMOTE_DATA must be absolute' >&2; exit 2 ;;
esac
case "$LH_REMOTE_DATA" in
  *[!a-zA-Z0-9_./-]*) echo 'LH_REMOTE_DATA contains unsupported characters' >&2; exit 2 ;;
esac
case "$LH_EXPORT_DIR" in
  /*) ;;
  *) echo 'LH_EXPORT_DIR must be absolute' >&2; exit 2 ;;
esac
source_dir=$(dirname "${BASH_SOURCE[0]}")
staging=$(mktemp -d)
trap 'rm -rf -- "$staging"' EXIT
# pipefail ensures a failed SSH stream cannot create a successful snapshot.
ssh "$LH_SSH_TARGET" "tar -C '$LH_REMOTE_DATA' -cf - ." | tar -xf - -C "$staging"
restic backup --tag learnharness --stdin-filename learnharness-data.tar \
  --stdin-from-command -- tar -C "$staging" -cf - .
node "$source_dir/export-learn.mjs" "$staging" "$LH_EXPORT_DIR"
restic forget --tag learnharness --keep-daily 14 --keep-weekly 8 --keep-monthly 12
mkdir -p "$HOME/.local/state/learnharness-backup"
date -Is > "$HOME/.local/state/learnharness-backup/last-success"
