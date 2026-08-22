# Helpers for deploy/aws/host-update.sh. Source only; do not execute.
# Usage: source "$(dirname "$0")/host-update-lib.sh"

host_update_stage_dir() {
  printf '%s.next\n' "$1"
}

host_update_prev_dir() {
  printf '%s.prev\n' "$1"
}

# unit_active: "yes" if systemctl is-active dbz-bot, otherwise "no".
host_update_handle_leftover_prev() {
  local app_dir="$1"
  local unit_active="$2"
  local prev
  prev="$(host_update_prev_dir "${app_dir}")"
  if [[ ! -e "${prev}" ]]; then
    return 0
  fi
  if [[ "${unit_active}" == "yes" ]]; then
    rm -rf "${prev}"
    return 0
  fi
  echo "Refusing to deploy: ${prev} exists and dbz-bot is not active." >&2
  echo "Restore the previous tree, then retry:" >&2
  echo "  mv ${app_dir} ${app_dir}.bad" >&2
  echo "  mv ${prev} ${app_dir}" >&2
  echo "  systemctl start dbz-bot" >&2
  echo "Or remove ${prev} if you intend to keep the current tree." >&2
  return 1
}
