#!/bin/bash
# Ensure a swapfile exists. Safe to run repeatedly (idempotent).
# Usage: sudo bash /home/ubuntu/bot/deploy/aws/ensure-swap.sh
# Env: SWAP_SIZE_MB (default 2048), SWAP_FILE (default /swapfile)
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run as root: sudo bash $0" >&2
  exit 1
fi

SWAP_FILE="${SWAP_FILE:-/swapfile}"
SWAP_SIZE_MB="${SWAP_SIZE_MB:-2048}"

# Already active and backed by our file.
if swapon --show=NAME --noheadings 2>/dev/null | grep -qx "${SWAP_FILE}"; then
  echo "Swap already active at ${SWAP_FILE}"
  exit 0
fi

# Any swap is enough for deploy pressure (e.g. admin-created).
if [[ "$(swapon --show --noheadings 2>/dev/null | wc -l)" -gt 0 ]]; then
  echo "Swap already active (not ${SWAP_FILE}); leaving as-is"
  swapon --show || true
  exit 0
fi

echo "==> Creating ${SWAP_SIZE_MB}MiB swap at ${SWAP_FILE}"
if [[ ! -f "${SWAP_FILE}" ]]; then
  # fallocate is fast on ext4; dd fallback for unusual filesystems
  if ! fallocate -l "${SWAP_SIZE_MB}M" "${SWAP_FILE}" 2>/dev/null; then
    dd if=/dev/zero of="${SWAP_FILE}" bs=1M count="${SWAP_SIZE_MB}" status=progress
  fi
fi
chmod 600 "${SWAP_FILE}"
mkswap "${SWAP_FILE}"
swapon "${SWAP_FILE}"

if ! grep -qE "^${SWAP_FILE}\\s" /etc/fstab; then
  echo "${SWAP_FILE} none swap sw 0 0" >> /etc/fstab
fi

# Prefer keeping the bot in RAM; use swap under deploy pressure.
sysctl -w vm.swappiness=30 >/dev/null
if ! grep -q '^vm.swappiness=' /etc/sysctl.conf 2>/dev/null; then
  echo 'vm.swappiness=30' >> /etc/sysctl.conf
fi

swapon --show
echo "==> Swap ready"
