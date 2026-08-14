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

cd "${APP_DIR}"

echo "==> Updating ${APP_DIR} from origin/${BRANCH}"
sudo -u "${APP_USER}" git fetch --all
sudo -u "${APP_USER}" git checkout "${BRANCH}"
sudo -u "${APP_USER}" git pull --ff-only origin "${BRANCH}"

echo "==> Refreshing .env from SSM"
/usr/local/bin/dbz-bot-refresh-env

echo "==> Installing, migrating, building, registering commands"
sudo -u "${APP_USER}" bash -lc "cd '${APP_DIR}' && npm ci && npx prisma migrate deploy && npm run build && npm run deploy-commands"

echo "==> Restarting dbz-bot"
systemctl restart dbz-bot
systemctl --no-pager --full status dbz-bot || true

echo "==> Update complete ($(sudo -u "${APP_USER}" git -C "${APP_DIR}" rev-parse --short HEAD))"
