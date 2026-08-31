#!/bin/bash
# Canonical production updater. Must run as root on the EC2 host.
# Usage: sudo bash /home/ubuntu/bot/deploy/aws/host-update.sh
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run as root: sudo bash $0" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${APP_DIR:-$(cd "${SCRIPT_DIR}/../.." && pwd)}"
BRANCH="${BRANCH:-main}"
APP_USER="${APP_USER:-ubuntu}"
LOCK_FILE="${LOCK_FILE:-/var/lock/dbz-bot-update.lock}"
READY_FILE="${READY_FILE:-/var/lib/dbz-bot/ready}"

# Serialize deploys (CI + manual + overlapping cloud-init repair).
exec 9>"${LOCK_FILE}"
if ! flock -w 1800 9; then
  echo "Timed out waiting for deploy lock ${LOCK_FILE} (another host-update held it for 30+ minutes)" >&2
  exit 1
fi

# shellcheck source=host-update-lib.sh
source "${SCRIPT_DIR}/host-update-lib.sh"

STAGE_DIR="$(host_update_stage_dir "${APP_DIR}")"
PREV_DIR="$(host_update_prev_dir "${APP_DIR}")"

echo "==> Ensuring swap (t3.micro has 1GiB RAM; npm ci needs headroom)"
if [[ -f "${APP_DIR}/deploy/aws/ensure-swap.sh" ]]; then
  bash "${APP_DIR}/deploy/aws/ensure-swap.sh"
else
  echo "WARN: ensure-swap.sh missing; continuing without swap setup" >&2
fi

UNIT_ACTIVE="no"
if systemctl is-active --quiet dbz-bot; then
  UNIT_ACTIVE="yes"
fi
host_update_handle_leftover_prev "${APP_DIR}" "${UNIT_ACTIVE}"

GITHUB_REMOTE="$(host_update_resolve_github_remote "${APP_DIR}" "${APP_USER}")"
host_update_persist_github_remote "${GITHUB_REMOTE}"
host_update_ensure_github_origin "${APP_DIR}" "${GITHUB_REMOTE}" "${APP_USER}"

echo "==> Updating ${APP_DIR} from origin/${BRANCH}"
sudo -u "${APP_USER}" git -C "${APP_DIR}" fetch --all
sudo -u "${APP_USER}" git -C "${APP_DIR}" checkout "${BRANCH}"
sudo -u "${APP_USER}" git -C "${APP_DIR}" pull --ff-only origin "${BRANCH}"

if [[ -f "${APP_DIR}/deploy/aws/ensure-swap.sh" ]]; then
  bash "${APP_DIR}/deploy/aws/ensure-swap.sh"
fi

echo "==> Preparing stage ${STAGE_DIR}"
rm -rf "${STAGE_DIR}"
sudo -u "${APP_USER}" git clone --local "${APP_DIR}" "${STAGE_DIR}"
host_update_ensure_github_origin "${STAGE_DIR}" "${GITHUB_REMOTE}" "${APP_USER}"
sudo -u "${APP_USER}" git -C "${STAGE_DIR}" fetch origin
sudo -u "${APP_USER}" git -C "${STAGE_DIR}" checkout "${BRANCH}"
sudo -u "${APP_USER}" git -C "${STAGE_DIR}" reset --hard "origin/${BRANCH}"

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
  echo "WARN: SSM_PREFIX unset or no /etc/dbz-bot/ssm.env — using legacy dbz-bot-refresh-env into stage." >&2
  APP_DIR="${STAGE_DIR}" /usr/local/bin/dbz-bot-refresh-env
else
  echo "No refresh-env.sh (with SSM_PREFIX) and no /usr/local/bin/dbz-bot-refresh-env" >&2
  rm -rf "${STAGE_DIR}"
  exit 1
fi

echo "==> Configuring git for HTTPS GitHub deps (openskill, etc.)"
sudo -u "${APP_USER}" git config --global url."https://github.com/".insteadOf ssh://git@github.com/
sudo -u "${APP_USER}" git config --global url."https://github.com/".insteadOf git@github.com:
sudo -u "${APP_USER}" git config --global url."https://github.com/".insteadOf git+ssh://git@github.com/

echo "==> Upgrading npm to 11 (Node 22 ships npm 10; openskill git dep fails on npm 10)"
npm install -g npm@11

echo "==> Installing and building in stage (live bot stays up)"
if ! sudo -u "${APP_USER}" bash -lc "cd '${STAGE_DIR}' && HUSKY=0 npm ci && npm run build && npm run deploy-commands"; then
  echo "Stage prepare failed; leaving live bot running" >&2
  rm -rf "${STAGE_DIR}"
  exit 1
fi

echo "==> Stopping dbz-bot for migrate and swap"
systemctl stop dbz-bot || true

echo "==> Migrating database from stage"
if ! sudo -u "${APP_USER}" bash -lc "cd '${STAGE_DIR}' && npx prisma migrate deploy"; then
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

echo "==> Update complete ($(sudo -u "${APP_USER}" git -C "${APP_DIR}" rev-parse --short HEAD))"
