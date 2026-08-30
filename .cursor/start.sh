#!/usr/bin/env bash
# Cloud Agent start: per-boot reconciliation. Brings the local PostgreSQL
# cluster up and reconciles the schema. Idempotent; returns once DB is ready.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1 && nvm use default >/dev/null 2>&1 || true

PGBIN="/usr/lib/postgresql/17/bin"
export PGDATA="$HOME/pgdata"
export PGPORT=5433
export PGPASSWORD=postgres

if [ ! -f "$PGDATA/PG_VERSION" ]; then
  echo "start: cluster missing — running install.sh"
  bash "$REPO_DIR/.cursor/install.sh"
fi

if ! "$PGBIN/pg_ctl" -D "$PGDATA" status >/dev/null 2>&1; then
  echo "==> Starting PostgreSQL on port $PGPORT"
  "$PGBIN/pg_ctl" -D "$PGDATA" -l "$HOME/pg.log" -w start
else
  echo "==> PostgreSQL already running"
fi

# Wait for readiness, then ensure DB + schema are current (idempotent).
for _ in $(seq 1 30); do
  if "$PGBIN/pg_isready" -h 127.0.0.1 -p "$PGPORT" -U postgres >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

if ! "$PGBIN/psql" -h 127.0.0.1 -p "$PGPORT" -U postgres -tc \
  "SELECT 1 FROM pg_database WHERE datname='dbzbot'" | grep -q 1; then
  "$PGBIN/createdb" -h 127.0.0.1 -p "$PGPORT" -U postgres dbzbot
fi

# Apply any migrations added on the current branch. Non-fatal so boot never hangs.
npx prisma migrate deploy || echo "start: migrate deploy skipped (see output above)"

echo "==> start.sh complete — PostgreSQL ready on 127.0.0.1:$PGPORT (db: dbzbot)"
