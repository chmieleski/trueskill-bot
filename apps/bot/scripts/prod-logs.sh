#!/bin/bash
# Stream production bot logs (journald → pino JSON) through local pino-pretty.
#
# Resolves the EC2 instance + region from `tofu output` (infra/aws), opens an
# SSM session running journalctl, and pretty-prints locally. No SSH needed.
#
# Usage:
#   pnpm logs:prod                       # last 200 lines, then follow
#   pnpm logs:prod -n 500 --no-follow    # snapshot
#   pnpm logs:prod --since "1 hour ago" --level warn
#   pnpm logs:prod --grep wc3stats       # journalctl --grep (regex)
#   pnpm logs:prod --raw                 # raw JSON lines (pipe to jq, etc.)
#
# Requires: tofu, aws CLI v2, session-manager-plugin, pnpm install done.
# Expired AWS session → runs `aws login` once, then retries.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
INFRA_DIR="${ROOT}/infra/aws"
PINO_PRETTY="${ROOT}/apps/bot/node_modules/.bin/pino-pretty"

lines=200
follow=true
since=""
grep_re=""
level=""
raw=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    -n | --lines)
      lines="$2"
      shift 2
      ;;
    --since)
      since="$2"
      shift 2
      ;;
    --grep)
      grep_re="$2"
      shift 2
      ;;
    --level)
      level="$2"
      shift 2
      ;;
    --no-follow)
      follow=false
      shift
      ;;
    --raw)
      raw=true
      shift
      ;;
    -h | --help)
      sed -n '2,16p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown argument: $1 (see --help)" >&2
      exit 1
      ;;
  esac
done

# --level warn → "warn|error|fatal" (validated before opening a session).
level_re=""
if [[ -n "$level" ]]; then
  for l in trace debug verbose info warn error fatal; do
    [[ "$l" == "$level" || -n "$level_re" ]] && level_re+="${level_re:+|}$l"
  done
  if [[ -z "$level_re" ]]; then
    echo "Unknown --level: $level (trace|debug|verbose|info|warn|error|fatal)" >&2
    exit 1
  fi
fi

for bin in tofu aws session-manager-plugin python3; do
  command -v "$bin" > /dev/null || {
    echo "Missing required tool: $bin" >&2
    exit 1
  }
done
if [[ "$raw" == false && ! -x "$PINO_PRETTY" ]]; then
  echo "pino-pretty not found at $PINO_PRETTY — run pnpm install (or use --raw)" >&2
  exit 1
fi

# Instance + region straight from tofu state (session_manager_command carries --region).
instance_id="$(tofu -chdir="$INFRA_DIR" output -raw instance_id)"
region="$(tofu -chdir="$INFRA_DIR" output -raw session_manager_command | sed -E 's/.*--region ([^ ]+).*/\1/')"
export AWS_DEFAULT_REGION="$region"

if ! aws sts get-caller-identity > /dev/null 2>&1; then
  echo "AWS session missing or expired — running aws login..." >&2
  aws login
  aws sts get-caller-identity > /dev/null
fi

# Build the remote journalctl command. -o cat = bare pino JSON lines.
journal_args=(sudo journalctl -u dbz-bot -o cat --no-pager -a -n "$lines")
[[ "$follow" == true ]] && journal_args+=(-f)
[[ -n "$since" ]] && journal_args+=(--since "$since")
[[ -n "$grep_re" ]] && journal_args+=(--grep "$grep_re")
# Quote every arg for the remote shell, then wrap as SSM document parameters JSON.
params="$(python3 -c '
import json, shlex, sys
print(json.dumps({"command": [shlex.join(sys.argv[1:])]}))
' "${journal_args[@]}")"

echo "▶ dbz-bot logs · ${instance_id} (${region})$([[ "$follow" == true ]] && echo ' · following, Ctrl-C to stop')" >&2

# The session allocates a PTY: strip CRs and the plugin's session banner lines.
stream() {
  aws ssm start-session \
    --target "$instance_id" \
    --document-name AWS-StartInteractiveCommand \
    --parameters "$params" |
    tr -d '\r' |
    grep --line-buffered -vE '^(Starting session with SessionId|Exiting session with sessionId|$)'
}

# Prod logs use string level labels, so pino-pretty's --minimumLevel cannot compare them.
# Keep JSON lines at or above --level (non-JSON lines such as crashes always pass).
level_filter() {
  if [[ -z "$level_re" ]]; then
    cat
  else
    grep --line-buffered -E "\"level\":\"(${level_re})\"|^[^{]"
  fi
}

if [[ "$raw" == true ]]; then
  stream | level_filter
else
  pretty_args=(
    --colorize
    --translateTime 'SYS:yyyy-mm-dd HH:MM:ss.l'
    --ignore 'pid,hostname,env,name,module'
    --customLevels 'trace:10,debug:20,verbose:25,info:30,warn:40,error:50,fatal:60'
    --customColors 'trace:gray,debug:blue,verbose:cyan,info:green,warn:yellow,error:red,fatal:bgRed'
    --messageFormat '{if module}[{module}]{end} {msg}'
  )
  stream | level_filter | "$PINO_PRETTY" "${pretty_args[@]}"
fi
