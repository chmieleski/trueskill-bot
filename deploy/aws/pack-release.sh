#!/usr/bin/env bash
# Assemble a portable bot release tree and tar it.
# Prerequisites: pnpm install, prisma generate, @dbz/bot build already done in repo root.
# Usage:
#   RELEASE_SHA=$(git rev-parse HEAD) PACK_OUT_DIR=/tmp/out bash deploy/aws/pack-release.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${ROOT}"

RELEASE_SHA="${RELEASE_SHA:?RELEASE_SHA is required}"
PACK_OUT_DIR="${PACK_OUT_DIR:-${ROOT}/.release-out}"
STAGING="$(mktemp -d "${TMPDIR:-/tmp}/dbz-pack.XXXXXX")"
cleanup() { rm -rf "${STAGING}"; }
trap cleanup EXIT

mkdir -p "${STAGING}/apps/bot" "${STAGING}/packages/db" "${STAGING}/docs" "${PACK_OUT_DIR}"

if [[ ! -f apps/bot/dist/index.js ]]; then
  echo "apps/bot/dist/index.js missing — run pnpm --filter @dbz/bot build first" >&2
  exit 1
fi

cp -a apps/bot/dist "${STAGING}/apps/bot/"
cp apps/bot/package.json "${STAGING}/apps/bot/"

cp -a packages/db/prisma "${STAGING}/packages/db/"
cp packages/db/package.json packages/db/index.js packages/db/prisma.config.ts "${STAGING}/packages/db/"
if [[ -f packages/db/index.d.ts ]]; then
  cp packages/db/index.d.ts "${STAGING}/packages/db/"
fi

cp -a deploy "${STAGING}/"
cp CHANGELOG.md pnpm-workspace.yaml "${STAGING}/"
cp -a docs/discord "${STAGING}/docs/"

# Portable production dependency tree for @dbz/bot (includes workspace @dbz/db + prisma CLI).
pnpm --filter @dbz/bot deploy --prod "${STAGING}/.pnpm-deploy"
cp -a "${STAGING}/.pnpm-deploy/node_modules" "${STAGING}/"
rm -rf "${STAGING}/.pnpm-deploy"

# If deploy nested @dbz/db without prisma schema, keep our copied packages/db and link it.
mkdir -p "${STAGING}/node_modules/@dbz"
rm -rf "${STAGING}/node_modules/@dbz/db"
ln -s ../../packages/db "${STAGING}/node_modules/@dbz/db"

# pnpm deploy leaves the prisma CLI under the transitive .pnpm store, not always at
# node_modules/.bin/prisma. Relocating the store also breaks absolute NODE_PATH in
# pnpm bin shims — vendor a portable top-level CLI for host migrate + tests.
if [[ ! -e "${STAGING}/node_modules/.bin/prisma" ]]; then
  PRISMA_PKG=""
  for candidate in "${STAGING}/node_modules/.pnpm"/prisma@*/node_modules/prisma; do
    if [[ -f "${candidate}/build/index.js" ]]; then
      PRISMA_PKG="${candidate}"
      break
    fi
  done
  if [[ -z "${PRISMA_PKG}" ]]; then
    echo "prisma package missing from packed node_modules" >&2
    exit 1
  fi
  REL_PRISMA="$(realpath --relative-to="${STAGING}/node_modules" "${PRISMA_PKG}")"
  ln -sfn "${REL_PRISMA}" "${STAGING}/node_modules/prisma"
  mkdir -p "${STAGING}/node_modules/.bin"
  printf '%s\n' '#!/bin/sh' 'exec node "$(dirname "$0")/../prisma/build/index.js" "$@"' >"${STAGING}/node_modules/.bin/prisma"
  chmod +x "${STAGING}/node_modules/.bin/prisma"
fi

if [[ ! -e "${STAGING}/node_modules/.bin/prisma" ]]; then
  echo "prisma CLI missing from packed node_modules" >&2
  exit 1
fi

printf '%s\n' "{\"sha\":\"${RELEASE_SHA}\",\"builtAt\":\"$(date -u +"%Y-%m-%dT%H:%M:%SZ")\"}" >"${STAGING}/RELEASE.json"

TAR="${PACK_OUT_DIR}/bot-${RELEASE_SHA}.tar.gz"
tar -czf "${TAR}" -C "${STAGING}" .
echo "Wrote ${TAR}"
