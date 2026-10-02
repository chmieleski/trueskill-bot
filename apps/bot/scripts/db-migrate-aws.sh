#!/usr/bin/env bash
# Migrate database from Supabase (or any PostgreSQL source) to AWS RDS PostgreSQL.
#
# Dumps the source public schema + data and streams it into AWS RDS with
# session_replication_role = replica so all constraints and tables restore cleanly.
#
# Supports automatic AWS SSM port-forwarding tunnel when running locally against
# a private RDS instance inside VPC.
#
# Usage:
#   bash apps/bot/scripts/db-migrate-aws.sh [options]
#   npm run db:migrate-aws
#
# Options:
#   --source <url>        Source PostgreSQL direct URL (5432)
#   --target <url>        Target AWS RDS PostgreSQL URL
#   --tunnel-port <port>  Local port for SSM port forwarding (default: 54332)
#   --no-tunnel           Disable automatic SSM tunnel attempt
#   --clean               Recreate target public schema without prompting
#   --no-backup           Do not save a local copy of the dump
#   --dry-run             Test connectivity to source & target only
#   -y, --yes             Skip confirmation prompts
#   -h, --help            Show this help

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

INFRA_DIR="${ROOT}/infra/aws"
BACKUP_DIR="${ROOT}/.local/backups"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_FILE="${BACKUP_DIR}/migration-source-${TIMESTAMP}.sql.gz"
IMAGE="${POSTGRES_IMAGE:-postgres:17}"
TUNNEL_PORT=54332

SOURCE_URL=""
TARGET_URL=""
AUTO_TUNNEL=1
CLEAN_TARGET=0
KEEP_BACKUP=1
DRY_RUN=0
ASSUME_YES=0
SSM_PID=""

usage() {
  cat <<'EOF'
Migrate PostgreSQL database (e.g. Supabase) to AWS RDS PostgreSQL.

Usage:
  bash apps/bot/scripts/db-migrate-aws.sh [options]
  npm run db:migrate-aws

Options:
  --source <url>        Source direct PostgreSQL URL (defaults to PROD_DIRECT_URL / direct_url)
  --target <url>        Target AWS RDS PostgreSQL URL (defaults to tofu/terraform output)
  --tunnel-port <port>  Local port to forward to RDS 5432 (default: 54332)
  --no-tunnel           Do not attempt automatic SSM tunnel to private RDS
  --clean               Drop and recreate target public schema before restore
  --no-backup           Skip writing local backup copy to .local/backups/
  --dry-run             Verify connectivity only; do not migrate
  -y, --yes             Answer yes to all prompts
  -h, --help            Show this help message

Requirements:
  - Docker (runs postgres:17 client) OR native pg_dump / psql (v17+)
  - AWS CLI + Session Manager plugin (if connecting to private RDS via SSM tunnel)
EOF
}

cleanup() {
  if [[ -n "$SSM_PID" ]]; then
    if kill -0 "$SSM_PID" 2>/dev/null; then
      echo "Shutting down SSM tunnel (PID ${SSM_PID})…"
      kill "$SSM_PID" 2>/dev/null || true
      wait "$SSM_PID" 2>/dev/null || true
    fi
  fi
}
trap cleanup EXIT INT TERM

while [[ $# -gt 0 ]]; do
  case "$1" in
    --source)
      SOURCE_URL="$2"
      shift
      ;;
    --target)
      TARGET_URL="$2"
      shift
      ;;
    --tunnel-port)
      TUNNEL_PORT="$2"
      shift
      ;;
    --no-tunnel)
      AUTO_TUNNEL=0
      ;;
    --clean)
      CLEAN_TARGET=1
      ;;
    --no-backup)
      KEEP_BACKUP=0
      ;;
    --dry-run)
      DRY_RUN=1
      ;;
    -y | --yes)
      ASSUME_YES=1
      ;;
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

redact_url() {
  local url="$1"
  printf '%s\n' "$url" | sed -E 's#(://[^:/]+:)[^@]+@#\1***@#'
}

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

resolve_source_url() {
  local url=""

  if [[ -n "$SOURCE_URL" ]]; then
    url="$SOURCE_URL"
  elif [[ -n "${SOURCE_DATABASE_URL:-}" ]]; then
    url="$SOURCE_DATABASE_URL"
  elif [[ -n "${PROD_DIRECT_URL:-}" ]]; then
    url="$PROD_DIRECT_URL"
  elif url="$(env_get "${ROOT}/.env" PROD_DIRECT_URL)" && [[ -n "$url" ]]; then
    :
  elif url="$(env_get "${INFRA_DIR}/terraform.tfvars" direct_url)" && [[ -n "$url" ]]; then
    :
  elif url="$(env_get "${ROOT}/.env.production" DIRECT_URL)" && [[ -n "$url" ]]; then
    :
  elif url="$(env_get "${ROOT}/.env" DIRECT_URL)" && [[ -n "$url" ]] && ! is_local_url "$url"; then
    :
  fi

  if [[ -z "$url" ]]; then
    echo "Error: Could not resolve source database URL." >&2
    echo "Provide --source <url> or set PROD_DIRECT_URL in .env or direct_url in infra/aws/terraform.tfvars" >&2
    exit 1
  fi

  if [[ "$url" == *":6543/"* || "$url" == *":6543?"* ]]; then
    echo "Error: Source URL points to port 6543 (transaction pooler). Use session/direct port 5432." >&2
    exit 1
  fi

  if ! is_local_url "$url" && [[ "$url" != *"sslmode="* ]]; then
    if [[ "$url" == *"?"* ]]; then
      url="${url}&sslmode=require"
    else
      url="${url}?sslmode=require"
    fi
  fi

  SOURCE_URL="$url"
}

resolve_target_url() {
  local url=""

  if [[ -n "$TARGET_URL" ]]; then
    url="$TARGET_URL"
  elif [[ -n "${TARGET_DATABASE_URL:-}" ]]; then
    url="$TARGET_DATABASE_URL"
  elif [[ -n "${RDS_DATABASE_URL:-}" ]]; then
    url="$RDS_DATABASE_URL"
  fi

  # Attempt reading from tofu / terraform in infra/aws if still unset
  if [[ -z "$url" && -d "$INFRA_DIR" ]]; then
    if command -v tofu >/dev/null 2>&1; then
      url="$(tofu -chdir="$INFRA_DIR" output -raw rds_database_url 2>/dev/null || true)"
    elif command -v terraform >/dev/null 2>&1; then
      url="$(terraform -chdir="$INFRA_DIR" output -raw rds_database_url 2>/dev/null || true)"
    fi
  fi

  if [[ -z "$url" || "$url" == "No outputs found" || "$url" == *"://:@"* ]]; then
    echo "Error: Could not resolve target AWS RDS database URL." >&2
    echo "Make sure you ran 'tofu apply' in infra/aws or pass --target <url>." >&2
    exit 1
  fi

  TARGET_URL="$url"
}

# Determine whether native tools or docker should run pg commands
USE_DOCKER=0
check_tooling() {
  if command -v pg_dump >/dev/null 2>&1 && command -v psql >/dev/null 2>&1; then
    USE_DOCKER=0
  elif command -v docker >/dev/null 2>&1; then
    USE_DOCKER=1
  else
    echo "Error: Neither postgresql-client (pg_dump, psql) nor Docker was found." >&2
    echo "Install PostgreSQL client tools (e.g. 'sudo apt install postgresql-client') or start Docker." >&2
    exit 1
  fi
}

run_psql_cmd() {
  local conn="$1"
  local sql="$2"

  if [[ "$USE_DOCKER" -eq 1 ]]; then
    docker run --rm --net=host -i "$IMAGE" psql "$conn" -v ON_ERROR_STOP=1 -t -A -c "$sql"
  else
    psql "$conn" -v ON_ERROR_STOP=1 -t -A -c "$sql"
  fi
}

run_psql_stream() {
  local conn="$1"

  if [[ "$USE_DOCKER" -eq 1 ]]; then
    docker run --rm --net=host -i "$IMAGE" psql "$conn" -v ON_ERROR_STOP=1 >/dev/null
  else
    psql "$conn" -v ON_ERROR_STOP=1 >/dev/null
  fi
}

# Check if target host is reachable directly; if not, open SSM tunnel via EC2
setup_target_connection() {
  local host port db user pass rest

  # Extract host and port from TARGET_URL: postgresql://user:pass@host:port/dbname
  rest="${TARGET_URL#*://}"
  user="${rest%%:*}"
  rest="${rest#*:}"
  pass="${rest%%@*}"
  rest="${rest#*@}"
  host="${rest%%/*}"
  db="${rest#*/}"
  db="${db%%\?*}"

  if [[ "$host" == *:* ]]; then
    port="${host##*:}"
    host="${host%:*}"
  else
    port="5432"
  fi

  # Test if target host is directly reachable on port
  local reachable=0
  if timeout 3 bash -c "cat < /dev/null > /dev/tcp/${host}/${port}" 2>/dev/null; then
    reachable=1
  fi

  if [[ "$reachable" -eq 1 ]]; then
    return 0
  fi

  # If not directly reachable and host is in AWS RDS, attempt SSM tunnel through EC2
  if [[ "$AUTO_TUNNEL" -eq 1 && "$host" == *".rds.amazonaws.com"* ]]; then
    echo "Target RDS endpoint (${host}) is private inside AWS VPC and not reachable directly."

    if ! command -v aws >/dev/null 2>&1; then
      echo "Error: AWS CLI is required to establish SSM tunnel to private RDS." >&2
      exit 1
    fi

    # Find EC2 instance id
    local instance_id=""
    if command -v tofu >/dev/null 2>&1; then
      instance_id="$(tofu -chdir="$INFRA_DIR" output -raw instance_id 2>/dev/null || true)"
    elif command -v terraform >/dev/null 2>&1; then
      instance_id="$(terraform -chdir="$INFRA_DIR" output -raw instance_id 2>/dev/null || true)"
    fi

    if [[ -z "$instance_id" ]]; then
      echo "Could not discover instance_id from infra/aws. Provide --target through a tunnel or make RDS accessible." >&2
      exit 1
    fi

    local region
    region="$(env_get "${INFRA_DIR}/terraform.tfvars" aws_region || echo "eu-central-1")"

    echo "==> Opening background SSM port-forwarding tunnel to RDS via EC2 instance ${instance_id}…"
    echo "    Local port: ${TUNNEL_PORT} → RDS: ${host}:${port}"

    aws ssm start-session \
      --target "$instance_id" \
      --document-name AWS-StartPortForwardingSessionToRemoteHost \
      --parameters "host=\"${host}\",portNumber=\"${port}\",localPortNumber=\"${TUNNEL_PORT}\"" \
      --region "$region" >/dev/null 2>&1 &
    SSM_PID=$!

    # Wait up to 15 seconds for local port to become active
    local connected=0
    for _ in $(seq 1 30); do
      if timeout 1 bash -c "cat < /dev/null > /dev/tcp/127.0.0.1/${TUNNEL_PORT}" 2>/dev/null; then
        connected=1
        break
      fi
      sleep 0.5
    done

    if [[ "$connected" -ne 1 ]]; then
      echo "Error: SSM tunnel did not become ready on 127.0.0.1:${TUNNEL_PORT}." >&2
      exit 1
    fi

    echo "==> SSM tunnel established successfully."
    # Rewrite TARGET_URL to use the tunnel
    TARGET_URL="postgresql://${user}:${pass}@127.0.0.1:${TUNNEL_PORT}/${db}?schema=public"
  else
    echo "Warning: Target host ${host}:${port} could not be reached directly."
  fi
}

check_tooling
resolve_source_url
resolve_target_url
setup_target_connection

echo "=========================================================="
echo " AWS RDS Database Migration"
echo "=========================================================="
echo " Source: $(redact_url "$SOURCE_URL")"
echo " Target: $(redact_url "$TARGET_URL")"
echo " Tool:   $(if [[ "$USE_DOCKER" -eq 1 ]]; then echo "Docker (${IMAGE})"; else echo "Native PostgreSQL client"; fi)"
echo "=========================================================="

echo "Testing connection to source…"
if ! run_psql_cmd "$SOURCE_URL" "SELECT 1;" >/dev/null 2>&1; then
  echo "Error: Failed to connect to source database." >&2
  exit 1
fi
echo "Source connection OK."

echo "Testing connection to target…"
if ! run_psql_cmd "$TARGET_URL" "SELECT 1;" >/dev/null 2>&1; then
  echo "Error: Failed to connect to target database." >&2
  exit 1
fi
echo "Target connection OK."

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo ""
  echo "Dry-run mode: Source and target connections verified successfully. No data was transferred."
  exit 0
fi

# Count existing tables on target
EXISTING_TABLES="$(run_psql_cmd "$TARGET_URL" "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public';")"
if [[ "$EXISTING_TABLES" -gt 0 && "$CLEAN_TARGET" -eq 0 && "$ASSUME_YES" -eq 0 ]]; then
  echo ""
  echo "Warning: Target database already contains ${EXISTING_TABLES} table(s) in public schema."
  read -rp "Do you want to drop and recreate the public schema before migrating? (y/N) " confirm
  if [[ "$confirm" =~ ^[Yy]$ ]]; then
    CLEAN_TARGET=1
  fi
fi

if [[ "$EXISTING_TABLES" -gt 0 && "$CLEAN_TARGET" -eq 1 ]]; then
  echo "Recreating public schema on target database…"
  run_psql_stream "$TARGET_URL" <<'SQL'
DROP SCHEMA IF EXISTS public CASCADE;
CREATE SCHEMA public;
GRANT ALL ON SCHEMA public TO postgres;
GRANT ALL ON SCHEMA public TO public;
SQL
  echo "Target public schema reset."
fi

mkdir -p "$BACKUP_DIR"
DUMP_CMD_FILE="${BACKUP_DIR}/dump-${TIMESTAMP}.sql"

echo ""
echo "==> Dumping public schema + data from source…"
if [[ "$USE_DOCKER" -eq 1 ]]; then
  docker run --rm --net=host "$IMAGE" \
    pg_dump "$SOURCE_URL" \
    --schema=public \
    --no-owner \
    --no-privileges \
    >"$DUMP_CMD_FILE"
else
  pg_dump "$SOURCE_URL" \
    --schema=public \
    --no-owner \
    --no-privileges \
    >"$DUMP_CMD_FILE"
fi

if [[ ! -s "$DUMP_CMD_FILE" ]]; then
  echo "Error: Dump file is empty." >&2
  rm -f "$DUMP_CMD_FILE"
  exit 1
fi

DUMP_SIZE="$(wc -c <"$DUMP_CMD_FILE")"
echo "Dump completed (${DUMP_SIZE} bytes)."

if [[ "$KEEP_BACKUP" -eq 1 ]]; then
  gzip -c "$DUMP_CMD_FILE" > "$BACKUP_FILE"
  echo "Saved backup archive to: ${BACKUP_FILE}"
fi

echo ""
echo "==> Restoring dump into AWS RDS target…"
{
  echo "SET session_replication_role = replica;"
  cat "$DUMP_CMD_FILE"
  echo "SET session_replication_role = DEFAULT;"
} | run_psql_stream "$TARGET_URL"

rm -f "$DUMP_CMD_FILE"
echo "Restore finished successfully!"

echo ""
echo "==> Verifying table row counts between source and target:"
printf "%-25s | %-12s | %-12s\n" "Table" "Source Rows" "Target Rows"
echo "--------------------------------------------------------"

TABLES=("Match" "Player" "League" "PlayerRating" "Game" "GameHero" "GameItem" "_prisma_migrations")
for tbl in "${TABLES[@]}"; do
  s_cnt="$(run_psql_cmd "$SOURCE_URL" "SELECT count(*) FROM \"${tbl}\";" 2>/dev/null || echo "N/A")"
  t_cnt="$(run_psql_cmd "$TARGET_URL" "SELECT count(*) FROM \"${tbl}\";" 2>/dev/null || echo "N/A")"
  printf "%-25s | %-12s | %-12s\n" "$tbl" "$s_cnt" "$t_cnt"
done

echo ""
echo "=========================================================="
echo " Migration Complete!"
echo "=========================================================="
echo " Next Steps to cut over the bot:"
echo " 1. Update infra/aws/terraform.tfvars:"
echo "      use_rds_for_bot = true"
echo " 2. Apply Terraform to update SSM:"
echo "      cd infra/aws && tofu apply"
echo " 3. Refresh environment on the EC2 host:"
echo "      sudo dbz-bot-refresh-env"
echo "      sudo systemctl restart dbz-bot"
echo "=========================================================="
