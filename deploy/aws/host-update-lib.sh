# Helpers for deploy/aws/host-update.sh. Source only; do not execute.
# Usage: source "$(dirname "$0")/host-update-lib.sh"

host_update_stage_dir() {
  printf '%s.next\n' "$1"
}

host_update_prev_dir() {
  printf '%s.prev\n' "$1"
}

# Persisted clone URL (may include a PAT). Written at first boot and when origin has userinfo.
host_update_git_remote_file() {
  printf '%s\n' "${GIT_REMOTE_FILE:-/etc/dbz-bot/git-remote.url}"
}

# HTTPS clone URL when origin was corrupted by git clone --local (filesystem path).
# Bare HTTPS is a last resort — private repos need /etc/dbz-bot/git-remote.url or a credentialed origin.
host_update_default_github_remote() {
  printf '%s\n' "${GIT_REMOTE_URL:-https://github.com/chmieleski/trueskill-bot.git}"
}

# True when `git remote get-url origin` is a local path, not GitHub.
host_update_is_local_git_remote() {
  local url="$1"
  [[ "${url}" == /* || "${url}" == file://* || "${url}" == ./* ]]
}

# True for https://user@host/... or https://user:pass@host/... (PAT in URL).
host_update_remote_has_userinfo() {
  local url="$1"
  [[ "${url}" =~ ^https?://[^/@]+@ ]]
}

host_update_read_stored_github_remote() {
  local file
  file="$(host_update_git_remote_file)"
  if [[ ! -f "${file}" ]]; then
    return 0
  fi
  # shellcheck disable=SC2162
  head -n1 "${file}" | tr -d '\r' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//'
}

# Persist credentialed remotes so git clone --local / CI repair cannot drop the PAT.
host_update_persist_github_remote() {
  local url="$1"
  local file dir
  if ! host_update_remote_has_userinfo "${url}"; then
    return 0
  fi
  file="$(host_update_git_remote_file)"
  dir="$(dirname "${file}")"
  mkdir -p "${dir}"
  printf '%s\n' "${url}" >"${file}"
  chmod 600 "${file}"
}

# Resolve the GitHub remote: stored file, else non-local origin, else credentialed GIT_REMOTE_URL, else default.
host_update_resolve_github_remote() {
  local repo_dir="$1"
  local app_user="$2"
  local url

  url="$(host_update_read_stored_github_remote)"
  if [[ -n "${url}" ]]; then
    printf '%s\n' "${url}"
    return 0
  fi

  url="$(sudo -u "${app_user}" git -C "${repo_dir}" remote get-url origin 2>/dev/null || true)"
  if [[ -n "${url}" ]] && ! host_update_is_local_git_remote "${url}"; then
    printf '%s\n' "${url}"
    return 0
  fi

  if [[ -n "${GIT_REMOTE_URL:-}" ]] && host_update_remote_has_userinfo "${GIT_REMOTE_URL}"; then
    printf '%s\n' "${GIT_REMOTE_URL}"
    return 0
  fi

  host_update_default_github_remote
}

# Point origin at GitHub when missing, local, or missing credentials that the resolved URL has.
host_update_ensure_github_origin() {
  local repo_dir="$1"
  local github_url="$2"
  local app_user="$3"
  local current

  current="$(sudo -u "${app_user}" git -C "${repo_dir}" remote get-url origin 2>/dev/null || true)"
  if [[ "${current}" == "${github_url}" ]]; then
    return 0
  fi

  if [[ -n "${current}" ]] &&
    ! host_update_is_local_git_remote "${current}" &&
    ! {
      host_update_remote_has_userinfo "${github_url}" && ! host_update_remote_has_userinfo "${current}"
    }; then
    return 0
  fi

  if host_update_is_local_git_remote "${current}"; then
    echo "==> Pointing ${repo_dir} origin at GitHub (was local path)"
  elif [[ -z "${current}" ]]; then
    echo "==> Adding ${repo_dir} origin"
  else
    echo "==> Restoring credentials on ${repo_dir} origin"
  fi

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
  local prev failed
  prev="$(host_update_prev_dir "${app_dir}")"
  if [[ ! -e "${prev}" ]]; then
    return 0
  fi
  if [[ "${unit_active}" == "yes" ]]; then
    rm -rf "${prev}"
    return 0
  fi

  echo "==> Recovering from ${prev} (dbz-bot inactive after a prior failed promote)" >&2
  systemctl stop dbz-bot || true
  failed="${app_dir}.failed"
  rm -rf "${failed}"
  if [[ -e "${app_dir}" ]]; then
    mv "${app_dir}" "${failed}"
  fi
  mv "${prev}" "${app_dir}"
  if systemctl start dbz-bot && systemctl is-active --quiet dbz-bot; then
    echo "==> Restored previous deploy from ${prev}" >&2
    return 0
  fi

  echo "WARN: restore from ${prev} failed; dbz-bot still inactive — continuing deploy to recover" >&2
  return 0
}
