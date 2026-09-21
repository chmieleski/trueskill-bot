#!/bin/bash
# Canonical production updater. Must run as root on the EC2 host.
# Prerequisite: ${APP_DIR}.next is a full release tree (see update-bot.sh).
# Usage: sudo bash /home/ubuntu/bot/deploy/aws/host-update.sh
#    or: sudo bash /home/ubuntu/bot.next/deploy/aws/host-update.sh
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run as root: sudo bash $0" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# When invoked from bot.next/deploy/aws, APP_DIR should still be the live path.
APP_DIR="${APP_DIR:-/home/ubuntu/bot}"
APP_USER="${APP_USER:-ubuntu}"
LOCK_FILE="${LOCK_FILE:-/var/lock/dbz-bot-update.lock}"
READY_FILE="${READY_FILE:-/var/lib/dbz-bot/ready}"

exec 9>"${LOCK_FILE}"
if ! flock -w 1800 9; then
  echo "Timed out waiting for deploy lock ${LOCK_FILE}" >&2
  exit 1
fi

# shellcheck source=host-update-lib.sh
source "${SCRIPT_DIR}/host-update-lib.sh"

STAGE_DIR="$(host_update_stage_dir "${APP_DIR}")"
PREV_DIR="$(host_update_prev_dir "${APP_DIR}")"

if [[ ! -d "${STAGE_DIR}" ]]; then
  echo "Missing stage ${STAGE_DIR} — run update-bot.sh (S3 unpack) first" >&2
  exit 1
fi
if [[ ! -f "${STAGE_DIR}/apps/bot/dist/index.js" ]]; then
  echo "Stage missing apps/bot/dist/index.js" >&2
  exit 1
fi
if [[ ! -f "${STAGE_DIR}/RELEASE.json" ]]; then
  echo "Stage missing RELEASE.json" >&2
  exit 1
fi

if [[ -f "${STAGE_DIR}/deploy/aws/ensure-swap.sh" ]]; then
  bash "${STAGE_DIR}/deploy/aws/ensure-swap.sh" || true
fi

UNIT_ACTIVE="no"
if systemctl is-active --quiet dbz-bot; then
  UNIT_ACTIVE="yes"
fi
host_update_handle_leftover_prev "${APP_DIR}" "${UNIT_ACTIVE}"

echo "==> Refreshing stage .env from SSM"
if [[ -f /etc/dbz-bot/ssm.env ]]; then
  # shellcheck disable=SC1091
  source /etc/dbz-bot/ssm.env
fi
export APP_USER="${APP_USER:-ubuntu}"

if [[ -f "${STAGE_DIR}/deploy/aws/refresh-env.sh" && -n "${SSM_PREFIX:-}" ]]; then
  export SSM_PREFIX AWS_DEFAULT_REGION AWS_REGION APP_USER
  APP_DIR="${STAGE_DIR}" bash "${STAGE_DIR}/deploy/aws/refresh-env.sh"
elif [[ -x /usr/local/bin/dbz-bot-refresh-env ]]; then
  APP_DIR="${STAGE_DIR}" /usr/local/bin/dbz-bot-refresh-env
else
  echo "No refresh-env.sh (with SSM_PREFIX) and no /usr/local/bin/dbz-bot-refresh-env" >&2
  rm -rf "${STAGE_DIR}"
  exit 1
fi

echo "==> Deploying slash commands from stage"
# Replay node output on stderr — SSM stdout is capped (~24KB) and often truncated.
DEPLOY_CMDS_LOG="$(mktemp /tmp/dbz-deploy-commands.XXXXXX.log)"
if ! sudo -u "${APP_USER}" bash -lc "cd '${STAGE_DIR}' && node apps/bot/dist/deploy-commands.js" \
  >"${DEPLOY_CMDS_LOG}" 2>&1; then
  echo "deploy-commands failed; leaving live bot running" >&2
  cat "${DEPLOY_CMDS_LOG}" >&2 || true
  rm -f "${DEPLOY_CMDS_LOG}"
  rm -rf "${STAGE_DIR}"
  exit 1
fi
rm -f "${DEPLOY_CMDS_LOG}"

echo "==> Stopping dbz-bot for migrate and swap"
systemctl stop dbz-bot || true

echo "==> Migrating database from stage"
# Prisma 7 loads packages/db/prisma.config.ts (schema + DIRECT_URL); run from that package.
if ! sudo -u "${APP_USER}" bash -lc "set -a; source '${STAGE_DIR}/.env'; set +a; cd '${STAGE_DIR}/packages/db' && ../../node_modules/.bin/prisma migrate deploy"; then
  echo "Migrate failed; restarting previous bot" >&2
  rm -rf "${STAGE_DIR}"
  systemctl start dbz-bot || true
  exit 1
fi

echo "==> Promoting stage to ${APP_DIR}"
mv "${APP_DIR}" "${PREV_DIR}"
if ! mv "${STAGE_DIR}" "${APP_DIR}"; then
  echo "Stage promote failed; restoring ${PREV_DIR}" >&2
  mv "${PREV_DIR}" "${APP_DIR}" || true
  systemctl start dbz-bot || true
  exit 1
fi

echo "==> Starting dbz-bot"
if ! systemctl start dbz-bot; then
  echo "Start failed; previous tree is at ${PREV_DIR}" >&2
  echo "Manual restore: systemctl stop dbz-bot; mv ${APP_DIR} ${APP_DIR}.bad; mv ${PREV_DIR} ${APP_DIR}; systemctl start dbz-bot" >&2
  systemctl --no-pager --full status dbz-bot || true
  exit 1
fi
systemctl --no-pager --full status dbz-bot || true
rm -rf "${PREV_DIR}"

mkdir -p "$(dirname "${READY_FILE}")"
touch "${READY_FILE}"

echo "==> Update complete ($(cat "${APP_DIR}/RELEASE.json"))"
