#!/bin/bash
# Thin wrapper for the updater installed by cloud-init on the EC2 host.
# Usage (on the instance): sudo ./deploy/aws/update-bot.sh
set -euo pipefail

if [[ ! -x /usr/local/bin/dbz-bot-update ]]; then
  echo "dbz-bot-update not found. Boot the instance with infra/aws Terraform user-data first." >&2
  exit 1
fi

exec /usr/local/bin/dbz-bot-update
