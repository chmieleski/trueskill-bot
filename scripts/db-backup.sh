#!/usr/bin/env bash
# Backup hosted Supabase public schema + data to a gzipped SQL file.
#
# Does not rewrite .env. Dump source is PROD_DIRECT_URL (session/direct,
# port 5432 — never the 6543 transaction pooler).
#
# Usage:
#   bash scripts/db-backup.sh
#   npm run db:backup
#
# Requires Docker. pg_dump runs inside postgres:17 (must be >= hosted major).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

IMAGE="${POSTGRES_IMAGE:-postgres:17}"
BACKUP_DIR="${ROOT}/.local/backups"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_FILE="${BACKUP_DIR}/prod-${STAMP}.sql.gz"

usage() {
  cat <<'EOF'
Backup hosted production public schema + data (gzipped SQL).

  bash scripts/db-backup.sh
  npm run db:backup

Dump source (first match wins):
  1. PROD_DIRECT_URL environment variable
  2. PROD_DIRECT_URL in .env
  3. DIRECT_URL in .env.prod
  4. DIRECT_URL in .env, only if it is not localhost

Output: .local/backups/prod-YYYYMMDD-HHMMSS.sql.gz

Restore into local Docker only:
  npm run db:restore -- .local/backups/prod-….sql.gz

Never pass a production password on the command line.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
  shift
done

# Read KEY=value from a dotenv file (last occurrence wins). Strips quotes.
env_get() {
  local file="$1"
  local key="$2"
  local line val

  [[ -f "$file" ]] || return 1
  line="$(grep -E "^[[:space:]]*(export[[:space:]]+)?${key}=" "$file" | tail -n 1)" || return 1
  [[ -n "${line}" ]] || return 1
  val="${line#*=}"
  val="${val%$'\r'}"
  val="${val#\"}"
  val="${val%\"}"
  val="${val#\'}"
  val="${val%\'}"
  printf '%s' "$val"
}

is_local_url() {
  local url="$1"
  [[ "$url" == *localhost* || "$url" == *127.0.0.1* || "$url" == *0.0.0.0* ]]
}

# Session pooler / direct connections need TLS. Transaction pooler (6543) cannot dump.
ensure_dump_url() {
  local url="$1"

  if [[ "$url" == *":6543/"* || "$url" == *":6543?"* ]]; then
    echo "Dump source uses port 6543 (transaction pooler). Use DIRECT_URL on 5432." >&2
    exit 1
  fi
  if is_local_url "$url"; then
    echo "Dump source points at localhost. Set PROD_DIRECT_URL to hosted Supabase (5432)." >&2
    exit 1
  fi
  if [[ "$url" != *"sslmode="* ]]; then
    if [[ "$url" == *"?"* ]]; then
      url="${url}&sslmode=require"
    else
      url="${url}?sslmode=require"
    fi
  fi
  printf '%s' "$url"
}

redact_url() {
  local url="$1"
  printf '%s\n' "$url" | sed -E 's#(://[^:/]+:)[^@]+@#\1***@#'
}

require_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    echo "Docker is required. Install Docker Desktop / engine, then retry." >&2
    exit 1
  fi
}

resolve_source_url() {
  local url=""

  if [[ -n "${PROD_DIRECT_URL:-}" ]]; then
    url="$PROD_DIRECT_URL"
  elif url="$(env_get "${ROOT}/.env" PROD_DIRECT_URL)" && [[ -n "$url" ]]; then
    :
  elif url="$(env_get "${ROOT}/.env.prod" DIRECT_URL)" && [[ -n "$url" ]]; then
    :
  elif url="$(env_get "${ROOT}/.env" DIRECT_URL)" && [[ -n "$url" ]]; then
    :
  else
    echo "No dump source. Set PROD_DIRECT_URL (hosted session/direct URL, port 5432)." >&2
    exit 1
  fi

  ensure_dump_url "$url"
}

require_docker

SOURCE_URL="$(resolve_source_url)"
mkdir -p "$BACKUP_DIR"

echo "Backing up public schema + data from $(redact_url "$SOURCE_URL")"
echo "→ ${BACKUP_FILE}"

# Stream pg_dump → gzip. Fail if either stage fails (pipefail).
docker run --rm "$IMAGE" \
  pg_dump "$SOURCE_URL" \
  --schema=public \
  --no-owner \
  --no-privileges \
  | gzip -c >"$BACKUP_FILE"

if [[ ! -s "$BACKUP_FILE" ]]; then
  echo "Backup file is empty: ${BACKUP_FILE}" >&2
  rm -f "$BACKUP_FILE"
  exit 1
fi

# Sanity-check: gzip header + decompressible SQL (first lines only).
if ! gzip -t "$BACKUP_FILE" 2>/dev/null; then
  echo "Backup is not valid gzip: ${BACKUP_FILE}" >&2
  exit 1
fi
# head may SIGPIPE gzip; ignore that when peeking.
peek="$(gzip -dc "$BACKUP_FILE" 2>/dev/null | head -n 20 || true)"
if ! printf '%s\n' "$peek" | grep -qiE 'PostgreSQL database dump|CREATE |SET '; then
  echo "Backup does not look like a Postgres SQL dump: ${BACKUP_FILE}" >&2
  exit 1
fi

echo "Wrote $(wc -c <"$BACKUP_FILE") bytes (gzipped)."
echo "Restore locally: npm run db:restore -- ${BACKUP_FILE#"$ROOT"/}"
