#!/usr/bin/env bash
# Resolve Turbo-affected workspace packages for CI (NX-style).
# Emits key=value lines for GitHub Actions GITHUB_OUTPUT:
#   bot, web, force_all, base
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${ROOT}"

emit() {
  local bot="$1" web="$2" force_all="$3" base="${4:-}"
  echo "bot=${bot}"
  echo "web=${web}"
  echo "force_all=${force_all}"
  echo "base=${base}"
}

if [[ "${GITHUB_EVENT_NAME:-}" == "workflow_dispatch" ]]; then
  emit true true true "workflow_dispatch"
  exit 0
fi

ZERO_SHA="0000000000000000000000000000000000000000"
BASE="${AFFECTED_BASE:-}"

if [[ -z "${BASE}" ]]; then
  if [[ "${GITHUB_EVENT_NAME:-}" == "pull_request" ]]; then
    if [[ -z "${GITHUB_BASE_REF:-}" ]]; then
      echo "GITHUB_BASE_REF is required for pull_request" >&2
      exit 1
    fi
    BASE="origin/${GITHUB_BASE_REF}"
  else
    BEFORE="${GITHUB_EVENT_BEFORE:-}"
    if [[ "${BEFORE}" =~ ^[0-9a-f]{40}$ && "${BEFORE}" != "${ZERO_SHA}" ]]; then
      BASE="${BEFORE}"
    else
      BASE="$(git rev-parse 'HEAD^')"
    fi
  fi
fi

if ! git rev-parse --verify "${BASE}^{commit}" >/dev/null 2>&1; then
  echo "Cannot resolve affected base commit: ${BASE}" >&2
  exit 1
fi

FORCE_PATHS=(
  pnpm-lock.yaml
  package.json
  turbo.json
  .github/workflows
  deploy/aws
)

force_all=false
# Triple-dot = branch changes vs base (CI). Also include dirty/staged paths for local runs.
while IFS= read -r path; do
  [[ -z "${path}" ]] && continue
  for prefix in "${FORCE_PATHS[@]}"; do
    if [[ "${path}" == "${prefix}" || "${path}" == "${prefix}/"* ]]; then
      force_all=true
      break 2
    fi
  done
done < <(
  {
    git diff --name-only "${BASE}...HEAD"
    git diff --name-only HEAD
    git diff --name-only --cached
  } | sort -u
)

if [[ "${force_all}" == true ]]; then
  emit true true true "${BASE}"
  exit 0
fi

# turbo may print a banner before the JSON object
JSON_BODY="$(
  pnpm exec turbo ls --filter="...[${BASE}]" --output=json 2>/dev/null \
    | sed -n '/^{/,$p'
)"

if [[ -z "${JSON_BODY}" ]]; then
  echo "turbo ls produced no JSON for filter ...[${BASE}]" >&2
  exit 1
fi

mapfile -t AFFECTED_NAMES < <(
  printf '%s' "${JSON_BODY}" | node --input-type=module -e '
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    const j = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    for (const p of j.packages?.items ?? []) {
      if (typeof p.name === "string") console.log(p.name);
    }
  '
)

bot=false
web=false
for name in "${AFFECTED_NAMES[@]+"${AFFECTED_NAMES[@]}"}"; do
  case "${name}" in
    @dbz/bot) bot=true ;;
    @dbz/web) web=true ;;
    @dbz/db) bot=true ;; # defensive: dependents should already include bot via ...[base]
  esac
done

emit "${bot}" "${web}" false "${BASE}"
