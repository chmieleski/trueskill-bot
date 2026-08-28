#!/bin/bash
# Pull production bot env from AWS SSM Parameter Store to a local file.
#
# Requires AWS credentials with ssm:GetParametersByPath on the prefix
# (same permission the EC2 instance uses via refresh-env.sh).
#
# Usage:
#   SSM_PREFIX=/punch-machine/prod AWS_DEFAULT_REGION=eu-central-1 ./scripts/pull-prod-env.sh
#   ./scripts/pull-prod-env.sh --out .env
#   ./scripts/pull-prod-env.sh --out .env.production
#
# Defaults (override via env):
#   SSM_PREFIX=/punch-machine/prod
#   AWS_DEFAULT_REGION=eu-central-1
#   OUT_FILE=.env.production
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_FILE="${ROOT}/.env.production"
SSM_PREFIX="${SSM_PREFIX:-/punch-machine/prod}"
AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-${AWS_REGION:-eu-central-1}}"
SSM_EMPTY_SENTINEL="__EMPTY__"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --out)
      OUT_FILE="$2"
      shift 2
      ;;
    --prefix)
      SSM_PREFIX="$2"
      shift 2
      ;;
    --region)
      AWS_DEFAULT_REGION="$2"
      shift 2
      ;;
    -h | --help)
      sed -n '2,20p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

export AWS_DEFAULT_REGION

declare -A PARAMS=()
next_token=""
while true; do
  if [[ -n "$next_token" ]]; then
    page="$(aws ssm get-parameters-by-path \
      --path "$SSM_PREFIX" \
      --recursive \
      --with-decryption \
      --next-token "$next_token" \
      --output json)"
  else
    page="$(aws ssm get-parameters-by-path \
      --path "$SSM_PREFIX" \
      --recursive \
      --with-decryption \
      --output json)"
  fi

  while IFS=$'\t' read -r name value; do
    [[ -z "$name" ]] && continue
    key="${name##*/}"
    if [[ "$value" == "$SSM_EMPTY_SENTINEL" ]]; then
      value=""
    fi
    PARAMS["$key"]="$value"
  done < <(echo "$page" | python3 -c '
import json, sys
data = json.load(sys.stdin)
for p in data.get("Parameters") or []:
    name = p.get("Name") or ""
    value = p.get("Value")
    if value is None:
        value = ""
    print(name + "\t" + value.replace("\n", "\\n"))
')

  next_token="$(echo "$page" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("NextToken") or "")')"
  [[ -z "$next_token" ]] && break
done

if [[ ${#PARAMS[@]} -eq 0 ]]; then
  echo "No parameters found at SSM path: $SSM_PREFIX (region: $AWS_DEFAULT_REGION)" >&2
  echo "Check AWS credentials (aws login / aws configure) and SSM_PREFIX." >&2
  exit 1
fi

required=(DISCORD_TOKEN CLIENT_ID DATABASE_URL DIRECT_URL GEMINI_API_KEY)
for key in "${required[@]}"; do
  if [[ -z "${PARAMS[$key]:-}" ]]; then
    echo "Missing required SSM parameter: $SSM_PREFIX/$key" >&2
    exit 1
  fi
done

umask 077
tmp="$(mktemp)"
{
  echo "DISCORD_TOKEN=${PARAMS[DISCORD_TOKEN]}"
  echo "CLIENT_ID=${PARAMS[CLIENT_ID]}"
  echo "GUILD_ID=${PARAMS[GUILD_ID]:-}"
  echo "DATABASE_URL=${PARAMS[DATABASE_URL]}"
  echo "DIRECT_URL=${PARAMS[DIRECT_URL]}"
  echo "GEMINI_API_KEY=${PARAMS[GEMINI_API_KEY]}"
  echo "NODE_ENV=production"
  echo "AUTO_DEPLOY_COMMANDS=false"
  echo "LOG_LEVEL=${PARAMS[LOG_LEVEL]:-info}"
  echo "MATCH_CREATE_ROLE_ID=${PARAMS[MATCH_CREATE_ROLE_ID]:-}"
  echo "MATCH_MOD_ROLE_ID=${PARAMS[MATCH_MOD_ROLE_ID]:-}"
  echo "WC3STATS_TIMEOUT_MS=${PARAMS[WC3STATS_TIMEOUT_MS]:-4000}"
} > "$tmp"

known=' DISCORD_TOKEN CLIENT_ID GUILD_ID DATABASE_URL DIRECT_URL GEMINI_API_KEY LOG_LEVEL MATCH_CREATE_ROLE_ID MATCH_MOD_ROLE_ID WC3STATS_TIMEOUT_MS '
deprecated=' WC3STATS_ENABLED WC3STATS_MAP_PATTERN WC3STATS_MAP_SHA1 '
for key in "${!PARAMS[@]}"; do
  if [[ "$known" != *" $key "* ]] && [[ "$deprecated" != *" $key "* ]]; then
    echo "${key}=${PARAMS[$key]}" >> "$tmp"
  fi
done

mv "$tmp" "$OUT_FILE"
echo "Wrote $OUT_FILE from SSM path $SSM_PREFIX (region: $AWS_DEFAULT_REGION)"
