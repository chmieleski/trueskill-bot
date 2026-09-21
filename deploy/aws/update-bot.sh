#!/bin/bash
# Download release tarball from S3, unpack to APP_DIR.next, run host-update.sh.
# Usage (on the instance): sudo RELEASE_BUCKET=... ./deploy/aws/update-bot.sh
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run as root: sudo $0" >&2
  exit 1
fi

APP_DIR="${APP_DIR:-/home/ubuntu/bot}"
APP_USER="${APP_USER:-ubuntu}"
RELEASE_BUCKET="${RELEASE_BUCKET:?RELEASE_BUCKET is required}"
RELEASE_SHA="${RELEASE_SHA:-}"
AWS_REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-eu-central-1}}"

STAGE_DIR="${APP_DIR}.next"
TMP_TAR="$(mktemp /tmp/dbz-bot-release.XXXXXX.tar.gz)"
TMP_EXTRACT="$(mktemp -d /tmp/dbz-bot-extract.XXXXXX)"

cleanup() {
  rm -f "${TMP_TAR}"
  # Only remove extract dir if it is still a temp path under /tmp.
  # After a successful mv into STAGE_DIR, TMP_EXTRACT is cleared so we
  # do not delete the staged release.
  if [[ -n "${TMP_EXTRACT}" && "${TMP_EXTRACT}" == /tmp/* ]]; then
    rm -rf "${TMP_EXTRACT}"
  fi
}
trap cleanup EXIT

if [[ -n "${RELEASE_SHA}" ]]; then
  KEY="bot/${RELEASE_SHA}.tar.gz"
else
  KEY="bot/latest"
fi

echo "==> Downloading s3://${RELEASE_BUCKET}/${KEY}"
aws s3 cp "s3://${RELEASE_BUCKET}/${KEY}" "${TMP_TAR}" --region "${AWS_REGION}"

echo "==> Unpacking to ${STAGE_DIR}"
rm -rf "${STAGE_DIR}"
mkdir -p "${TMP_EXTRACT}"
tar -xzf "${TMP_TAR}" -C "${TMP_EXTRACT}"
# Support tarballs with or without a single top-level folder
if [[ -f "${TMP_EXTRACT}/apps/bot/dist/index.js" ]]; then
  mv "${TMP_EXTRACT}" "${STAGE_DIR}"
  TMP_EXTRACT=""  # moved; skip rm in trap for extract
else
  echo "Tarball missing apps/bot/dist/index.js" >&2
  exit 1
fi

chown -R "${APP_USER}:${APP_USER}" "${STAGE_DIR}"

HOST_UPDATE="${STAGE_DIR}/deploy/aws/host-update.sh"
if [[ ! -f "${HOST_UPDATE}" ]]; then
  echo "host-update.sh missing in stage" >&2
  exit 1
fi

# Clean temp tarball before exec (EXIT trap does not run on successful exec).
rm -f "${TMP_TAR}"
TMP_TAR=""

export APP_DIR APP_USER
exec bash "${HOST_UPDATE}"
