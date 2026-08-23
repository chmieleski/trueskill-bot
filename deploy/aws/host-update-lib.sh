# Helpers for deploy/aws/host-update.sh. Source only; do not execute.
# Usage: source "$(dirname "$0")/host-update-lib.sh"

host_update_stage_dir() {
  printf '%s.next\n' "$1"
}

host_update_prev_dir() {
  printf '%s.prev\n' "$1"
}

# HTTPS clone URL when origin was corrupted by git clone --local (filesystem path).
host_update_default_github_remote() {
  printf '%s\n' "${GIT_REMOTE_URL:-https://github.com/chmieleski/trueskill-bot.git}"
}

# True when `git remote get-url origin` is a local path, not GitHub.
host_update_is_local_git_remote() {
  local url="$1"
  [[ "${url}" == /* || "${url}" == file://* || "${url}" == ./* ]]
}

# Resolve the GitHub remote: GIT_REMOTE_URL, else non-local origin, else default.
host_update_resolve_github_remote() {
  local repo_dir="$1"
  local app_user="$2"
  local url

  if [[ -n "${GIT_REMOTE_URL:-}" ]]; then
    printf '%s\n' "${GIT_REMOTE_URL}"
    return 0
  fi

  url="$(sudo -u "${app_user}" git -C "${repo_dir}" remote get-url origin 2>/dev/null || true)"
  if [[ -n "${url}" ]] && ! host_update_is_local_git_remote "${url}"; then
    printf '%s\n' "${url}"
    return 0
  fi

  host_update_default_github_remote
}

# Point origin at GitHub when it is missing or a local clone path.
host_update_ensure_github_origin() {
  local repo_dir="$1"
  local github_url="$2"
  local app_user="$3"
  local current

  current="$(sudo -u "${app_user}" git -C "${repo_dir}" remote get-url origin 2>/dev/null || true)"
  if [[ "${current}" == "${github_url}" ]]; then
    return 0
  fi
  if [[ -n "${current}" ]] && ! host_update_is_local_git_remote "${current}"; then
    return 0
  fi

  echo "==> Pointing ${repo_dir} origin at GitHub"
  if [[ -n "${current}" ]]; then
    sudo -u "${app_user}" git -C "${repo_dir}" remote set-url origin "${github_url}"
  else
    sudo -u "${app_user}" git -C "${repo_dir}" remote add origin "${github_url}"
  fi
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
