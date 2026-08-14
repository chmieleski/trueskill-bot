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
# Prefer repo script (picks up new SSM keys on deploy). Needs SSM_PREFIX via
# /etc/dbz-bot/ssm.env (written by cloud-init) or the environment.
if [[ -f /etc/dbz-bot/ssm.env ]]; then
  # shellcheck disable=SC1091
  source /etc/dbz-bot/ssm.env
fi
export APP_DIR="${APP_DIR:-$(cd "${SCRIPT_DIR}/../.." && pwd)}"
export APP_USER="${APP_USER:-ubuntu}"

if [[ -f "${APP_DIR}/deploy/aws/refresh-env.sh" && -n "${SSM_PREFIX:-}" ]]; then
  export SSM_PREFIX AWS_DEFAULT_REGION AWS_REGION APP_USER
  bash "${APP_DIR}/deploy/aws/refresh-env.sh"
elif [[ -x /usr/local/bin/dbz-bot-refresh-env ]]; then
  echo "WARN: SSM_PREFIX unset or no /etc/dbz-bot/ssm.env — using legacy dbz-bot-refresh-env." >&2
  echo "WARN: Create /etc/dbz-bot/ssm.env (see infra/aws/README.md) after tofu apply so new env keys sync." >&2
  /usr/local/bin/dbz-bot-refresh-env
else
  echo "No refresh-env.sh (with SSM_PREFIX) and no /usr/local/bin/dbz-bot-refresh-env" >&2
  exit 1
fi

echo "==> Installing, migrating, building, registering commands"
sudo -u "${APP_USER}" bash -lc "cd '${APP_DIR}' && npm ci && npx prisma migrate deploy && npm run build && npm run deploy-commands"

echo "==> Restarting dbz-bot"
systemctl restart dbz-bot
systemctl --no-pager --full status dbz-bot || true

echo "==> Update complete ($(sudo -u "${APP_USER}" git -C "${APP_DIR}" rev-parse --short HEAD))"
