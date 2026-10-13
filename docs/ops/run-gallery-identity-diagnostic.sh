#!/usr/bin/env bash
# Gallery identity diagnostic — READ-ONLY runner. Prepared, NOT executed by the author.
# Run it only with the user's authorisation (docs/ops/gallery-incidents-deploy-plan.md §6).
#
#   export DIAG_DATABASE_URL   # typed or pasted at the prompt; never in a file, a chat or argv
#   docs/ops/run-gallery-identity-diagnostic.sh '<since>' <output-file>
#     since        start of the window, e.g. '2026-09-13 00:00:00-05' (baseline: 30 days ago)
#     output-file  path OUTSIDE this repository; it is created with mode 600
#
# What makes it read-only and keeps the credential out of sight:
#   - The session is opened with default_transaction_read_only=on (PGOPTIONS), and the SQL
#     file aborts if it is not; every query also runs inside BEGIN READ ONLY … ROLLBACK.
#   - The URL travels only as an environment variable: `docker run -e DIAG_DATABASE_URL`
#     passes it without putting its value on the host's command line; nothing echoes it,
#     and `set -x` is never enabled. The SQL prints the database NAME only — no host, user
#     or password.
#   - psql runs from the LOCAL postgres:16 image (--pull never: nothing is downloaded),
#     with -X (no psqlrc) and a 60 s statement timeout.
#   - The output holds personal data (names, phones, channel ids): mode 600, outside the repo.
set -euo pipefail
set +x

usage() { echo "usage: $0 '<since>' <output-file>   (export DIAG_DATABASE_URL first, with read -rs)" >&2; exit 2; }
[ "$#" -eq 2 ] || usage
since="$1"
out="$2"
client_id="${DIAG_CLIENT_ID:-6790e355-9048-47d0-99c2-7822419aa526}" # Gallery

if [ -z "${DIAG_DATABASE_URL:-}" ]; then
  echo "DIAG_DATABASE_URL is not set. Export it in this shell (read -rs DIAG_DATABASE_URL; export DIAG_DATABASE_URL)." >&2
  exit 2
fi
case "$client_id" in
  *[!0-9a-f-]*|"") echo "DIAG_CLIENT_ID must be a uuid" >&2; exit 2 ;;
esac
case "$since" in
  *[!0-9:\ +-]*|"") echo "since must look like 'YYYY-MM-DD HH:MM:SS-05'" >&2; exit 2 ;;
esac

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
out_dir="$(cd "$(dirname "$out")" && pwd)"
case "$out_dir/" in
  "$repo"/*) echo "refusing to write the output inside the repository ($repo)" >&2; exit 2 ;;
esac
out_path="$out_dir/$(basename "$out")"
[ -e "$out_path" ] && { echo "refusing to overwrite $out_path" >&2; exit 2; }

umask 077
: > "$out_path"
# A failed or aborted run leaves no partial output behind.
trap 'status=$?; [ "$status" -eq 0 ] || rm -f "$out_path"; exit "$status"' EXIT

docker run --rm -i --pull never \
  -e DIAG_DATABASE_URL \
  -e PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=60s' \
  -e PGAPPNAME='gallery-identity-diagnostic (read-only)' \
  -e PGCONNECT_TIMEOUT=15 \
  postgres:16 \
  sh -c 'exec psql "$DIAG_DATABASE_URL" -X -q -v ON_ERROR_STOP=1 -v client_id="$1" -v since="$2" -f -' \
  diag "$client_id" "$since" \
  < "$here/gallery-identity-diagnostic.sql" > "$out_path"

echo "Diagnostic written to $out_path (mode 600). It contains personal data: do not commit or paste it."
