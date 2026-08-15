#!/usr/bin/env bash
# Restore a gzipped (or plain) SQL backup into local Docker Postgres only.
#
# Never restores to hosted / production URLs. Wipes local dbzbot and loads
# schema + data from the dump (no prisma migrate — DDL is in the backup).
#
# Usage:
#   bash scripts/db-restore-local.sh
#   bash scripts/db-restore-local.sh .local/backups/prod-….sql.gz
#   npm run db:restore
#   npm run db:restore -- .local/backups/prod-….sql.gz
#
# Default file: newest .local/backups/prod-*.sql.gz

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

IMAGE="${POSTGRES_IMAGE:-postgres:17}"
CONTAINER="${POSTGRES_CONTAINER:-dbz-bot-postgres}"
POSTGRES_PORT="${POSTGRES_PORT:-5433}"
LOCAL_URL="postgresql://postgres:postgres@127.0.0.1:${POSTGRES_PORT}/dbzbot?schema=public"
BACKUP_DIR="${ROOT}/.local/backups"
BACKUP_FILE=""

usage() {
  cat <<'EOF'
Restore a SQL backup into local Docker Postgres (dbzbot).

  bash scripts/db-restore-local.sh [path/to/backup.sql.gz]
  npm run db:restore -- [path/to/backup.sql.gz]

Default: newest .local/backups/prod-*.sql.gz

Accepts .sql or .sql.gz. Recreates local dbzbot from the dump.
Does NOT write to production. Does NOT run prisma migrate.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h | --help)
      usage
      exit 0
      ;;
    -*)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
    *)
      if [[ -n "$BACKUP_FILE" ]]; then
        echo "Pass at most one backup path." >&2
        exit 1
      fi
      BACKUP_FILE="$1"
      ;;
  esac
  shift
done

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

resolve_backup_file() {
  if [[ -n "$BACKUP_FILE" ]]; then
    if [[ "$BACKUP_FILE" != /* ]]; then
      BACKUP_FILE="${ROOT}/${BACKUP_FILE}"
    fi
  else
    if [[ ! -d "$BACKUP_DIR" ]]; then
      echo "No backups in ${BACKUP_DIR}. Run npm run db:backup first." >&2
      exit 1
    fi
    BACKUP_FILE="$(ls -1t "${BACKUP_DIR}"/prod-*.sql.gz 2>/dev/null | head -n 1 || true)"
    if [[ -z "$BACKUP_FILE" ]]; then
      echo "No prod-*.sql.gz in ${BACKUP_DIR}. Run npm run db:backup first." >&2
      exit 1
    fi
  fi

  if [[ ! -f "$BACKUP_FILE" ]]; then
    echo "Backup not found: ${BACKUP_FILE}" >&2
    exit 1
  fi
  if [[ ! -s "$BACKUP_FILE" ]]; then
    echo "Backup file is empty: ${BACKUP_FILE}" >&2
    exit 1
  fi
}

stream_backup() {
  case "$BACKUP_FILE" in
    *.gz)
      gzip -dc "$BACKUP_FILE"
      ;;
    *)
      cat "$BACKUP_FILE"
      ;;
  esac
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

restore_backup() {
  echo "Restoring ${BACKUP_FILE} into local dbzbot…"
  {
    echo "SET session_replication_role = replica;"
    stream_backup
    echo "SET session_replication_role = DEFAULT;"
  } | docker exec -i "$CONTAINER" psql -U postgres -d dbzbot -v ON_ERROR_STOP=1 >/dev/null

  echo "Restore finished."
  echo "Point DATABASE_URL and DIRECT_URL at:"
  echo "  ${LOCAL_URL}"
  echo "Restored Discord channel/message IDs belong to the backup source. Use a test guild/bot token."
}

require_docker
resolve_backup_file
start_local_postgres
reset_local_database
restore_backup
