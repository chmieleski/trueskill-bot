#!/bin/bash
# Canonical production .env writer. Pulls every parameter under SSM_PREFIX
# (secrets + non-secrets) and writes APP_DIR/.env.
# Invoked by host-update / dbz-bot-refresh-env. Must run as root or ubuntu
# with IAM permission to read the parameter path.
#
# Env (required):
#   SSM_PREFIX   e.g. /punch-machine/prod
#   APP_DIR      e.g. /home/ubuntu/bot
# Optional:
#   AWS_DEFAULT_REGION / AWS_REGION
#   APP_USER     owner of .env (default ubuntu)
set -euo pipefail

APP_DIR="${APP_DIR:-/home/ubuntu/bot}"
APP_USER="${APP_USER:-ubuntu}"
SSM_PREFIX="${SSM_PREFIX:-}"
AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-${AWS_REGION:-}}"

# SSM cannot store ""; Terraform writes this sentinel for optional empty values.
SSM_EMPTY_SENTINEL="__EMPTY__"

if [[ -z "$SSM_PREFIX" ]]; then
  echo "SSM_PREFIX is required (e.g. /project/prod)" >&2
  exit 1
fi

if [[ -z "$AWS_DEFAULT_REGION" ]]; then
  echo "AWS_DEFAULT_REGION or AWS_REGION is required" >&2
  exit 1
fi

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

required=(DISCORD_TOKEN CLIENT_ID GUILD_ID DATABASE_URL DIRECT_URL GEMINI_API_KEY)
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
  echo "GUILD_ID=${PARAMS[GUILD_ID]}"
  echo "DATABASE_URL=${PARAMS[DATABASE_URL]}"
  echo "DIRECT_URL=${PARAMS[DIRECT_URL]}"
  echo "GEMINI_API_KEY=${PARAMS[GEMINI_API_KEY]}"
  echo "NODE_ENV=production"
  echo "AUTO_DEPLOY_COMMANDS=false"
  echo "LOG_LEVEL=${PARAMS[LOG_LEVEL]:-info}"
  echo "MATCH_CREATE_ROLE_ID=${PARAMS[MATCH_CREATE_ROLE_ID]:-}"
  echo "MATCH_MOD_ROLE_ID=${PARAMS[MATCH_MOD_ROLE_ID]:-}"
  echo "WC3STATS_ENABLED=${PARAMS[WC3STATS_ENABLED]:-false}"
  echo "WC3STATS_MAP_PATTERN=${PARAMS[WC3STATS_MAP_PATTERN]:-ultimate.?dragon.?ball.?reborn|udbr}"
  echo "WC3STATS_MAP_SHA1=${PARAMS[WC3STATS_MAP_SHA1]:-}"
  echo "WC3STATS_TIMEOUT_MS=${PARAMS[WC3STATS_TIMEOUT_MS]:-4000}"
} > "$tmp"

# Append any extra SSM keys not already written (forward-compat for new params).
known=' DISCORD_TOKEN CLIENT_ID GUILD_ID DATABASE_URL DIRECT_URL GEMINI_API_KEY LOG_LEVEL MATCH_CREATE_ROLE_ID MATCH_MOD_ROLE_ID WC3STATS_ENABLED WC3STATS_MAP_PATTERN WC3STATS_MAP_SHA1 WC3STATS_TIMEOUT_MS '
for key in "${!PARAMS[@]}"; do
  if [[ "$known" != *" $key "* ]]; then
    echo "${key}=${PARAMS[$key]}" >> "$tmp"
  fi
done

install -o "$APP_USER" -g "$APP_USER" -m 600 "$tmp" "$APP_DIR/.env"
rm -f "$tmp"
echo "Wrote $APP_DIR/.env from SSM path $SSM_PREFIX"
