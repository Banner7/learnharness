#!/usr/bin/env bash
#
# THE EXACT NEW-USER SIMULATOR (owner, interlude 2026-09-22): one command,
# a fresh instance with zero keys and zero data on every launch.
# Credentials can then be configured in the scratch auth.json file.
#
#   bash scripts/dev-fresh.sh            # browser http://127.0.0.1:5173
#   npm run dev:fresh                    # backend http://127.0.0.1:3005
#   scripts/dev-fresh.sh --port 3006     # another backend port
#   scripts/dev-fresh.sh --keep         # don't wipe between runs
#                                        (multi-session testing)
#
# WHY A SWITCH, NOT AN ENV SCRUB: a script cannot merely unset shell
# *_API_KEY vars — the development runner loads .env.local (dev secrets)
# into the server env at boot, so a "fresh" instance would silently use the
# real keys. LH_IGNORE_ENV_KEYS=1 (the keys seam, src/server/keys.ts)
# deletes every managed key var from the process after the runner's env load:
# pi-ai reads provider keys from process.env NATIVELY at every request,
# so deletion hides keys from the whole app, model engines included.
#
#   LH_DATA_DIR     → .fresh-data/ (wiped each launch unless --keep)
#   LH_AUTH_FILE    → .fresh-data/auth.json (NEVER the repo-root auth.json
#                     — that file may symlink the real keys)
#   LH_IGNORE_ENV_KEYS=1
#
# Safe to rerun. The data dir is disposable scratch — never copy it back.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="3005"
DATA_DIR="$ROOT/.fresh-data"
KEEP=false

usage() {
	sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
	case "$1" in
	--port)
		[ $# -ge 2 ] || { echo "error: --port needs a value" >&2; exit 1; }
		PORT="$2"
		shift 2
		;;
	--port=*)
		PORT="${1#--port=}"
		shift
		;;
	--keep)
		KEEP=true
		shift
		;;
	-h | --help)
		usage
		exit 0
		;;
	*)
		echo "error: unknown flag: $1" >&2
		usage >&2
		exit 1
		;;
	esac
done

if ! [[ "$PORT" =~ ^[0-9]+$ ]]; then
	echo "error: --port must be a number, got \"$PORT\"" >&2
	exit 1
fi
case "$PORT" in
3000 | 3001 | 3002 | 3003 | 3004)
	echo "error: port $PORT is a standing assignment (3000 master, 3001 UI, 3002 graph, 3003 teacher, 3004 platform)" >&2
	echo "       — the fresh instance runs on a dedicated port (default 3005)" >&2
	exit 1
	;;
esac

if [ "$KEEP" != "true" ]; then
	rm -rf "$DATA_DIR"
else
	# --keep preserves prior sessions (multi-session testing); the dir is
	# still created if this is the first run.
	:
fi
mkdir -p "$DATA_DIR"

export LH_DATA_DIR="$DATA_DIR"
export LH_AUTH_FILE="$DATA_DIR/auth.json"
export LH_IGNORE_ENV_KEYS=1
export PORT

echo "── fresh-user instance ─────────────────────────────────"
echo "  browser  : http://127.0.0.1:5173 (LH_WEB_ORIGIN must match)"
echo "  API      : http://127.0.0.1:$PORT"
echo "  data dir : $DATA_DIR ($( [ "$KEEP" = "true" ] && echo 'kept across runs' || echo 'wiped next launch unless --keep' ))"
echo "  keys     : env keys hidden (LH_IGNORE_ENV_KEYS=1), auth.json empty"
echo "─────────────────────────────────────────────────────────"

cd "$ROOT"
exec npm run dev
