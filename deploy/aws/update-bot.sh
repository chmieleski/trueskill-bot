#!/bin/bash
# Usage (on the instance): sudo ./deploy/aws/update-bot.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST_UPDATE="${SCRIPT_DIR}/host-update.sh"

if [[ ! -f "${HOST_UPDATE}" ]]; then
  echo "host-update.sh not found at ${HOST_UPDATE}" >&2
  exit 1
fi

exec bash "${HOST_UPDATE}"
