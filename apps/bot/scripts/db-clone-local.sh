#!/usr/bin/env bash
# Clone hosted Supabase public data into the local Docker Postgres.
#
# Does not rewrite .env. The dump source is PROD_DIRECT_URL (session/direct,
# port 5432 — never the 6543 transaction pooler). Local Prisma commands use a
# hardcoded compose URL so migrate/restore cannot hit production.
#
# Usage:
#   bash scripts/db-clone-local.sh
#   bash scripts/db-clone-local.sh --heroes-only
#   bash scripts/db-clone-local.sh --dump-only
#   bash scripts/db-clone-local.sh --restore-only
#
# Requires Docker. pg_dump/psql run inside the postgres:17 image (must be
# >= hosted Supabase major; pg_dump refuses a newer server).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

IMAGE="${POSTGRES_IMAGE:-postgres:17}"
CONTAINER="${POSTGRES_CONTAINER:-dbz-bot-postgres}"
POSTGRES_PORT="${POSTGRES_PORT:-5433}"
LOCAL_URL="postgresql://postgres:postgres@127.0.0.1:${POSTGRES_PORT}/dbzbot?schema=public"
DUMP_DIR="${ROOT}/.local"
DUMP_FILE="${DUMP_DIR}/prod-data.sql"

HEROES_ONLY=0
DUMP_ONLY=0
RESTORE_ONLY=0

usage() {
  cat <<'EOF'
Clone hosted Supabase public data into local Docker Postgres.

  bash scripts/db-clone-local.sh              dump prod + reset local + restore
  bash scripts/db-clone-local.sh --heroes-only
  bash scripts/db-clone-local.sh --dump-only
  bash scripts/db-clone-local.sh --restore-only

Dump source (first match wins):
  1. PROD_DIRECT_URL environment variable
  2. PROD_DIRECT_URL in .env
  3. DIRECT_URL in .env.prod
  4. DIRECT_URL in .env, only if it is not localhost

Never pass a production password on the command line.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --heroes-only) HEROES_ONLY=1 ;;
    --dump-only) DUMP_ONLY=1 ;;
    --restore-only) RESTORE_ONLY=1 ;;
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

if [[ "$DUMP_ONLY" -eq 1 && "$RESTORE_ONLY" -eq 1 ]]; then
  echo "Choose only one of --dump-only or --restore-only." >&2
  exit 1
fi

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

is_supabase_url() {
  local url="$1"
  [[ "$url" == *supabase.com* ]]
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
  if ! docker compose version >/dev/null 2>&1; then
    echo "Docker Compose v2 is required (docker compose)." >&2
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

local_pgdata_incompatible() {
  docker logs "$CONTAINER" 2>/dev/null | grep -qi "incompatible with server"
}

wait_for_postgres() {
  local i
  for i in $(seq 1 40); do
    if docker exec "$CONTAINER" pg_isready -U postgres -d dbzbot >/dev/null 2>&1; then
      return 0
    fi
    if [[ "$i" -ge 8 ]] && local_pgdata_incompatible; then
      return 1
    fi
    sleep 1
  done
  return 1
}

start_local_postgres() {
  echo "Starting local Postgres (docker compose)…"
  docker compose -f "${ROOT}/docker-compose.yml" up -d
  if wait_for_postgres; then
    return 0
  fi
  if local_pgdata_incompatible; then
    echo "Local volume is an older Postgres major. Recreating for ${IMAGE}…"
    docker compose -f "${ROOT}/docker-compose.yml" down -v
    docker compose -f "${ROOT}/docker-compose.yml" up -d
    if wait_for_postgres; then
      return 0
    fi
  fi
  echo "Local Postgres did not become ready (${CONTAINER})." >&2
  docker logs "$CONTAINER" >&2 || true
  exit 1
}

# Recreate the app database so a second clone does not hit PK conflicts.
reset_local_database() {
  echo "Recreating local database dbzbot…"
  docker exec -i "$CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 <<'SQL'
SELECT pg_terminate_backend(pid)
FROM pg_stat_activity
WHERE datname = 'dbzbot' AND pid <> pg_backend_pid();
DROP DATABASE IF EXISTS dbzbot;
CREATE DATABASE dbzbot;
SQL
}

apply_migrations() {
  echo "Applying Prisma migrations to local Postgres…"
  DATABASE_URL="$LOCAL_URL" DIRECT_URL="$LOCAL_URL" pnpm --filter @dbz/db migrate:deploy
}

dump_prod() {
  local source="$1"
  mkdir -p "$DUMP_DIR"

  echo "Dumping public data from $(redact_url "$source")"
  if [[ "$HEROES_ONLY" -eq 1 ]]; then
    echo "Mode: --heroes-only (table \"Hero\" only)"
    docker run --rm "$IMAGE" \
      pg_dump "$source" \
      --data-only \
      --no-owner \
      --no-privileges \
      --table='"Hero"' \
      >"$DUMP_FILE"
  else
    docker run --rm "$IMAGE" \
      pg_dump "$source" \
      --data-only \
      --schema=public \
      --no-owner \
      --no-privileges \
      --exclude-table=_prisma_migrations \
      --exclude-table='"Game"' \
      >"$DUMP_FILE"
  fi

  if [[ ! -s "$DUMP_FILE" ]]; then
    echo "Dump file is empty: ${DUMP_FILE}" >&2
    exit 1
  fi
  echo "Wrote $(wc -c <"$DUMP_FILE") bytes to ${DUMP_FILE}"
}

# Migration-seeded catalog tables are applied by prisma migrate deploy before restore.
# Older dumps may still include COPY blocks for these tables — strip them so PK inserts
# from migrations are not duplicated.
filter_migration_seeded_tables() {
  awk '
    /^COPY public\."Game"/ { skip=1; next }
    skip && /^\\\.$/ { skip=0; next }
    skip { next }
    { print }
  '
}

restore_dump() {
  if [[ ! -s "$DUMP_FILE" ]]; then
    echo "Missing dump file ${DUMP_FILE}. Run without --restore-only first." >&2
    exit 1
  fi

  echo "Restoring ${DUMP_FILE} into local dbzbot…"
  {
    echo "SET session_replication_role = replica;"
    filter_migration_seeded_tables <"$DUMP_FILE"
    echo "SET session_replication_role = DEFAULT;"
  } | docker exec -i "$CONTAINER" psql -U postgres -d dbzbot -v ON_ERROR_STOP=1 >/dev/null

  echo "Restore finished."
  echo "Point DATABASE_URL and DIRECT_URL at:"
  echo "  ${LOCAL_URL}"
  echo "Restored Discord channel/message IDs belong to production. Use a test guild/bot token, or --heroes-only."
}

require_docker

if [[ "$RESTORE_ONLY" -eq 1 ]]; then
  start_local_postgres
  reset_local_database
  apply_migrations
  restore_dump
  exit 0
fi

SOURCE_URL="$(resolve_source_url)"
dump_prod "$SOURCE_URL"

if [[ "$DUMP_ONLY" -eq 1 ]]; then
  echo "Dump-only: local database was not changed."
  exit 0
fi

start_local_postgres
reset_local_database
apply_migrations
restore_dump
