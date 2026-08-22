# Zero-downtime-prepare deploy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the live Discord bot running through `git pull`, `npm ci`, and `tsc`; restart only after a sibling stage tree is built and migrate can run with the old process stopped.

**Architecture:** CI no longer `systemctl stop`s before `host-update.sh`. That script clones `/home/ubuntu/bot` → `/home/ubuntu/bot.next`, installs/builds there, then stop → migrate → `mv` live aside / stage into place → start. Failed prepare leaves the current unit running.

**Tech Stack:** bash, systemd, Git, npm 11, Prisma migrate, GitHub Actions SSM `AWS-RunShellScript`, Vitest

**Spec:** [docs/superpowers/specs/2026-08-22-zero-downtime-deploy-design.md](../specs/2026-08-22-zero-downtime-deploy-design.md)

## Global Constraints

- Scope: `general` (host deploy / CI; no game-specific code)
- English-only logs and operator errors
- Do not `npm ci`, `prisma generate`, or `tsc` in the live `APP_DIR` while preparing
- Do not `prisma migrate deploy` until after `systemctl stop`
- `git clone --local` **without** `--shared` (hardlinks OK; alternates would break when `bot.prev` is deleted)
- systemd `WorkingDirectory=/home/ubuntu/bot` unchanged
- No automatic swap-back if `systemctl start` fails; leave `${APP_DIR}.prev`
- Existing flock `/var/lock/dbz-bot-update.lock` and ready file `/var/lib/dbz-bot/ready`
- Conventional Commits; skip commit steps unless the user asked to commit
- User-facing / operator strings in English

## File map

| File                                                              | Role                                                                                                              |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `deploy/aws/host-update-lib.sh`                                   | Sourceable helpers: stage/prev paths, leftover-`.prev` policy                                                     |
| `src/deploy/host-update-lib.test.ts`                              | Vitest: prev abort/delete, path names, CI has no early stop, `npm ci` before `systemctl stop` in `host-update.sh` |
| `deploy/aws/host-update.sh`                                       | Root orchestrator: pull live source, stage build, cut-over                                                        |
| `.github/workflows/ci-cd.yml`                                     | Remove `systemctl stop` from the SSM command list                                                                 |
| `infra/aws/README.md`                                             | Deploy stays up through `npm ci`; restart is cut-over only                                                        |
| `docs/superpowers/specs/2026-08-14-github-actions-cicd-design.md` | Restart bullet: stop only after stage build                                                                       |

---

### Task 1: Stage/prev helpers and leftover-`.prev` policy

**Files:**

- Create: `deploy/aws/host-update-lib.sh`
- Create: `src/deploy/host-update-lib.test.ts`

**Interfaces:**

- Consumes: nothing (pure bash + temp dirs)
- Produces:
  - `host_update_stage_dir(app_dir)` → prints `${app_dir}.next`
  - `host_update_prev_dir(app_dir)` → prints `${app_dir}.prev`
  - `host_update_handle_leftover_prev(app_dir, unit_active)` → `unit_active` is `yes` or `no`. Missing prev → 0. Prev + `yes` → `rm -rf` prev, 0. Prev + `no` → English refuse message on stderr, 1

- [ ] **Step 1: Write the failing tests**

Create `src/deploy/host-update-lib.test.ts`:

```typescript
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const lib = join(repoRoot, 'deploy/aws/host-update-lib.sh');

function bash(script: string): { stdout: string; stderr: string; status: number } {
  try {
    const stdout = execFileSync('bash', ['-lc', script], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { stdout, stderr: '', status: 0 };
  } catch (error) {
    const err = error as { status?: number; stdout?: string; stderr?: string };
    return {
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? '',
      status: typeof err.status === 'number' ? err.status : 1,
    };
  }
}

describe('host-update-lib', () => {
  it('names stage and prev as sibling suffixes', () => {
    const result = bash(
      `source '${lib}'; host_update_stage_dir /home/ubuntu/bot; host_update_prev_dir /home/ubuntu/bot`,
    );
    expect(result.status).toBe(0);
    expect(result.stdout.trim().split('\n')).toEqual([
      '/home/ubuntu/bot.next',
      '/home/ubuntu/bot.prev',
    ]);
  });

  it('deletes leftover prev when the unit is active', () => {
    const root = mkdtempSync(join(tmpdir(), 'host-update-'));
    const app = join(root, 'bot');
    const prev = `${app}.prev`;
    mkdirSync(prev);
    const result = bash(`source '${lib}'; host_update_handle_leftover_prev '${app}' yes`);
    expect(result.status).toBe(0);
    expect(existsSync(prev)).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it('aborts when leftover prev exists and the unit is inactive', () => {
    const root = mkdtempSync(join(tmpdir(), 'host-update-'));
    const app = join(root, 'bot');
    const prev = `${app}.prev`;
    mkdirSync(prev);
    const result = bash(`source '${lib}'; host_update_handle_leftover_prev '${app}' no`);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Refusing to deploy');
    expect(result.stderr).toContain(prev);
    expect(existsSync(prev)).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it('is a no-op when prev is absent', () => {
    const result = bash(`source '${lib}'; host_update_handle_leftover_prev '/no/such/bot' no`);
    expect(result.status).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/deploy/host-update-lib.test.ts`

Expected: FAIL (`deploy/aws/host-update-lib.sh` missing / functions not found)

- [ ] **Step 3: Write `deploy/aws/host-update-lib.sh`**

```bash
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
```

- [ ] **Step 4: Re-run tests**

Run: `npm test -- src/deploy/host-update-lib.test.ts`

Expected: PASS (4 tests)

- [ ] **Step 5: Commit** (if the user asked)

```bash
git add deploy/aws/host-update-lib.sh src/deploy/host-update-lib.test.ts
git commit -m "feat(deploy): add stage/prev path helpers for host-update"
```

---

### Task 2: Stage clone + late stop in `host-update.sh`

**Files:**

- Modify: `deploy/aws/host-update.sh` (replace body after flock)
- Modify: `src/deploy/host-update-lib.test.ts` (add file-order assertions)

**Interfaces:**

- Consumes: `host_update_stage_dir`, `host_update_prev_dir`, `host_update_handle_leftover_prev` from `deploy/aws/host-update-lib.sh`; `ensure-swap.sh`; `refresh-env.sh`; systemd `dbz-bot`
- Produces: live bot stays up through stage `npm ci` / `build` / `deploy-commands`; cut-over is stop → migrate → swap → start

- [ ] **Step 1: Add failing order tests** to `src/deploy/host-update-lib.test.ts`

```typescript
describe('host-update.sh cut-over order', () => {
  it('runs npm ci before systemctl stop', () => {
    const sh = readFileSync(join(repoRoot, 'deploy/aws/host-update.sh'), 'utf8');
    const ciIdx = sh.indexOf('npm ci');
    const stopIdx = sh.indexOf('systemctl stop dbz-bot');
    expect(ciIdx).toBeGreaterThan(-1);
    expect(stopIdx).toBeGreaterThan(ciIdx);
  });

  it('builds in a .next stage, not only in APP_DIR', () => {
    const sh = readFileSync(join(repoRoot, 'deploy/aws/host-update.sh'), 'utf8');
    expect(sh).toContain('host_update_stage_dir');
    expect(sh).toContain('npx prisma migrate deploy');
    expect(sh.indexOf('npm run build')).toBeGreaterThan(-1);
    expect(sh.indexOf('npx prisma migrate deploy')).toBeGreaterThan(
      sh.indexOf('systemctl stop dbz-bot'),
    );
  });
});
```

- [ ] **Step 2: Run the new tests — expect FAIL**

Run: `npm test -- src/deploy/host-update-lib.test.ts`

Expected: FAIL (`npm ci` currently after `systemctl stop`)

- [ ] **Step 3: Replace `deploy/aws/host-update.sh`**

Keep the shebang, root check, `SCRIPT_DIR` / `APP_DIR` / `BRANCH` / `APP_USER` / `LOCK_FILE` / `READY_FILE`, and flock block. After flock, source the lib and use this body (absolute paths after swap; do not rely on `cd APP_DIR` once `mv` happens):

```bash
# shellcheck source=host-update-lib.sh
source "${SCRIPT_DIR}/host-update-lib.sh"

STAGE_DIR="$(host_update_stage_dir "${APP_DIR}")"
PREV_DIR="$(host_update_prev_dir "${APP_DIR}")"

echo "==> Ensuring swap (t3.micro has 1GiB RAM; npm ci needs headroom)"
if [[ -f "${APP_DIR}/deploy/aws/ensure-swap.sh" ]]; then
  bash "${APP_DIR}/deploy/aws/ensure-swap.sh"
else
  echo "WARN: ensure-swap.sh missing; continuing without swap setup" >&2
fi

UNIT_ACTIVE="no"
if systemctl is-active --quiet dbz-bot; then
  UNIT_ACTIVE="yes"
fi
host_update_handle_leftover_prev "${APP_DIR}" "${UNIT_ACTIVE}"

echo "==> Updating ${APP_DIR} from origin/${BRANCH}"
sudo -u "${APP_USER}" git fetch --all
sudo -u "${APP_USER}" git checkout "${BRANCH}"
sudo -u "${APP_USER}" git pull --ff-only origin "${BRANCH}"

if [[ -f "${APP_DIR}/deploy/aws/ensure-swap.sh" ]]; then
  bash "${APP_DIR}/deploy/aws/ensure-swap.sh"
fi

echo "==> Preparing stage ${STAGE_DIR}"
rm -rf "${STAGE_DIR}"
sudo -u "${APP_USER}" git clone --local "${APP_DIR}" "${STAGE_DIR}"
sudo -u "${APP_USER}" git -C "${STAGE_DIR}" fetch origin
sudo -u "${APP_USER}" git -C "${STAGE_DIR}" checkout "${BRANCH}"
sudo -u "${APP_USER}" git -C "${STAGE_DIR}" reset --hard "origin/${BRANCH}"

echo "==> Refreshing stage .env from SSM"
if [[ -f /etc/dbz-bot/ssm.env ]]; then
  # shellcheck disable=SC1091
  source /etc/dbz-bot/ssm.env
fi
export APP_USER="${APP_USER:-ubuntu}"

if [[ -f "${STAGE_DIR}/deploy/aws/refresh-env.sh" && -n "${SSM_PREFIX:-}" ]]; then
  export SSM_PREFIX AWS_DEFAULT_REGION AWS_REGION APP_USER
  APP_DIR="${STAGE_DIR}" bash "${STAGE_DIR}/deploy/aws/refresh-env.sh"
elif [[ -x /usr/local/bin/dbz-bot-refresh-env ]]; then
  echo "WARN: SSM_PREFIX unset or no /etc/dbz-bot/ssm.env — using legacy dbz-bot-refresh-env into stage." >&2
  APP_DIR="${STAGE_DIR}" /usr/local/bin/dbz-bot-refresh-env
else
  echo "No refresh-env.sh (with SSM_PREFIX) and no /usr/local/bin/dbz-bot-refresh-env" >&2
  rm -rf "${STAGE_DIR}"
  exit 1
fi

echo "==> Configuring git for HTTPS GitHub deps (openskill, etc.)"
sudo -u "${APP_USER}" git config --global url."https://github.com/".insteadOf ssh://git@github.com/
sudo -u "${APP_USER}" git config --global url."https://github.com/".insteadOf git@github.com:
sudo -u "${APP_USER}" git config --global url."https://github.com/".insteadOf git+ssh://git@github.com/

echo "==> Upgrading npm to 11 (Node 22 ships npm 10; openskill git dep fails on npm 10)"
npm install -g npm@11

echo "==> Installing and building in stage (live bot stays up)"
if ! sudo -u "${APP_USER}" bash -lc "cd '${STAGE_DIR}' && HUSKY=0 npm ci && npm run build && npm run deploy-commands"; then
  echo "Stage prepare failed; leaving live bot running" >&2
  rm -rf "${STAGE_DIR}"
  exit 1
fi

echo "==> Stopping dbz-bot for migrate and swap"
systemctl stop dbz-bot || true

echo "==> Migrating database from stage"
if ! sudo -u "${APP_USER}" bash -lc "cd '${STAGE_DIR}' && npx prisma migrate deploy"; then
  echo "Migrate failed; restarting previous bot" >&2
  rm -rf "${STAGE_DIR}"
  systemctl start dbz-bot || true
  exit 1
fi

echo "==> Promoting stage to ${APP_DIR}"
mv "${APP_DIR}" "${PREV_DIR}"
if ! mv "${STAGE_DIR}" "${APP_DIR}"; then
  echo "Stage promote failed; restoring ${PREV_DIR}" >&2
  mv "${PREV_DIR}" "${APP_DIR}" || true
  systemctl start dbz-bot || true
  exit 1
fi

echo "==> Starting dbz-bot"
if ! systemctl start dbz-bot; then
  echo "Start failed; previous tree is at ${PREV_DIR}" >&2
  echo "Manual restore: systemctl stop dbz-bot; mv ${APP_DIR} ${APP_DIR}.bad; mv ${PREV_DIR} ${APP_DIR}; systemctl start dbz-bot" >&2
  systemctl --no-pager --full status dbz-bot || true
  exit 1
fi
systemctl --no-pager --full status dbz-bot || true
rm -rf "${PREV_DIR}"

mkdir -p "$(dirname "${READY_FILE}")"
touch "${READY_FILE}"

echo "==> Update complete ($(sudo -u "${APP_USER}" git -C "${APP_DIR}" rev-parse --short HEAD))"
```

Do **not** `git clone --shared`. Keep the existing root/flock header unchanged.

Legacy `dbz-bot-refresh-env` always writes `APP_DIR` from `/etc/dbz-bot/ssm.env` (usually live). The `APP_DIR="${STAGE_DIR}"` prefix only works if that wrapper exports/overrides. If the wrapper hardcodes `source /etc/dbz-bot/ssm.env` then `exec refresh-env.sh`, `ssm.env` may set `APP_DIR=/home/ubuntu/bot` and win. Locked fallback: the **primary** path is repo `refresh-env.sh` with `APP_DIR="${STAGE_DIR}"` **on the command line after** sourcing `ssm.env`, which is what production uses. Do not change the baked wrapper (non-goal).

- [ ] **Step 4: Re-run tests**

Run: `npm test -- src/deploy/host-update-lib.test.ts`

Expected: PASS

Also: `bash -n deploy/aws/host-update.sh` Expected: exit 0

- [ ] **Step 5: Commit** (if the user asked)

```bash
git add deploy/aws/host-update.sh src/deploy/host-update-lib.test.ts
git commit -m "feat(deploy): build in bot.next and restart only at cut-over"
```

---

### Task 3: Stop CI from killing the bot before host-update

**Files:**

- Modify: `.github/workflows/ci-cd.yml` (SSM `commands` array only)
- Modify: `src/deploy/host-update-lib.test.ts`

**Interfaces:**

- Consumes: SSM still `git pull`s live then `sudo bash host-update.sh`
- Produces: no `systemctl stop` in that jq command list

- [ ] **Step 1: Add a failing test**

```typescript
describe('CI deploy SSM command', () => {
  it('does not stop dbz-bot before host-update.sh', () => {
    const yml = readFileSync(join(repoRoot, '.github/workflows/ci-cd.yml'), 'utf8');
    const start = yml.indexOf('# Stop the bot before pull/update');
    const jqBlock = start === -1 ? yml : yml.slice(start, yml.indexOf('echo "SSM command:"'));
    expect(jqBlock).not.toMatch(/systemctl stop dbz-bot/);
    expect(yml).toContain('sudo bash \\($app)/deploy/aws/host-update.sh');
  });
});
```

(If the comment is already gone, assert on the `jq -cn` array: the joined commands must include `host-update.sh` and must not include `systemctl stop`.)

Prefer this robust version:

```typescript
it('does not stop dbz-bot before host-update.sh', () => {
  const yml = readFileSync(join(repoRoot, '.github/workflows/ci-cd.yml'), 'utf8');
  const marker = '"echo ==> deploy \\($sha)"';
  const from = yml.indexOf(marker);
  expect(from).toBeGreaterThan(-1);
  const chunk = yml.slice(from, yml.indexOf('echo "SSM command:"', from));
  expect(chunk).toContain('host-update.sh');
  expect(chunk).not.toMatch(/systemctl stop dbz-bot/);
});
```

- [ ] **Step 2: Run test — expect FAIL**

Run: `npm test -- src/deploy/host-update-lib.test.ts`

Expected: FAIL (chunk still has `systemctl stop dbz-bot`)

- [ ] **Step 3: Edit `.github/workflows/ci-cd.yml`**

Replace the comment and the commands array:

```yaml
# Single bash -lc so pipefail works under SSM (default shell is dash).
# git pull loads the new host-update.sh; that script stops the bot only
# after the stage build succeeds.
COMMAND_ID="$(aws ssm send-command \
--instance-ids "${INSTANCE_ID}" \
--document-name AWS-RunShellScript \
--comment "dbz-bot deploy ${GITHUB_SHA}" \
--timeout-seconds 900 \
--parameters commands="$(jq -cn \
--arg app "$APP_DIR" \
--arg sha "$GITHUB_SHA" \
'
[
(
[
"set -euo pipefail",
"echo ==> deploy \($sha)",
"sudo -u ubuntu git -C \($app) fetch --all",
"sudo -u ubuntu git -C \($app) checkout main",
"sudo -u ubuntu git -C \($app) pull --ff-only origin main",
"if [[ -f \($app)/deploy/aws/ensure-swap.sh ]]; then sudo bash \($app)/deploy/aws/ensure-swap.sh; fi",
"sudo bash \($app)/deploy/aws/host-update.sh"
] | join("; ")
) as $body
| "bash -lc " + ($body | @sh)
]
')" \
--query 'Command.CommandId' \
--output text)"
```

Delete the line `"systemctl stop dbz-bot || true",` only. Keep fetch/checkout/pull/`ensure-swap`/`host-update`.

- [ ] **Step 4: Re-run tests**

Run: `npm test -- src/deploy/host-update-lib.test.ts`

Expected: PASS

- [ ] **Step 5: Commit** (if the user asked)

```bash
git add .github/workflows/ci-cd.yml src/deploy/host-update-lib.test.ts
git commit -m "fix(deploy): do not stop the bot before host-update in CI"
```

---

### Task 4: Operator docs

**Files:**

- Modify: `infra/aws/README.md` (CI/CD section ~line 108)
- Modify: `docs/superpowers/specs/2026-08-14-github-actions-cicd-design.md` (Restart row + architecture step list)

**Interfaces:** none (docs only)

- [ ] **Step 1: Update `infra/aws/README.md`**

Replace:

```markdown
Pull requests run `npm test`. A push to `main` runs the same tests, then AWS SSM runs `deploy/aws/host-update.sh` on the EC2 host (pull, migrate, build, register slash commands, restart).
```

with:

```markdown
Pull requests run `npm test`. A push to `main` runs the same tests, then AWS SSM `git pull`s and runs `deploy/aws/host-update.sh`. The live bot stays up through `npm ci` / `tsc` in `/home/ubuntu/bot.next`. Restart is only the cut-over (stop → migrate → swap → start). A failed prepare leaves the current process running.
```

- [ ] **Step 2: Update the CI/CD spec Restart bullet**

In `docs/superpowers/specs/2026-08-14-github-actions-cicd-design.md` Decisions table, set Restart to:

```text
Stop only after stage `npm ci` / build / `deploy-commands` succeed; then migrate, swap `bot.next` into `/home/ubuntu/bot`, start. See `2026-08-22-zero-downtime-deploy-design.md`.
```

In Architecture, keep SSM steps as pull then `host-update.sh` (no `systemctl stop` in the GHA command list). If the older `host-update.sh` numbered list still says stop-then-npm-ci, add one sentence pointing at the 2026-08-22 spec rather than rewriting the whole 2026-08-14 component section.

- [ ] **Step 3: Commit** (if the user asked)

```bash
git add infra/aws/README.md docs/superpowers/specs/2026-08-14-github-actions-cicd-design.md
git commit -m "docs(deploy): describe stage cut-over instead of long stop"
```

---

## Manual acceptance (after merge to `main`)

1. Next successful deploy: SSM stdout shows `Installing and building in stage` **before** `Stopping dbz-bot`; unit is active; `git -C /home/ubuntu/bot rev-parse --short HEAD` matches `main`.
2. Confirm Discord reconnect is seconds, not the length of `npm ci`.
3. Do **not** inject a broken `package.json` on `main` in production; the Vitest order tests cover the “stop after ci” invariant.

## Self-review

| Spec requirement                                | Task                               |
| ----------------------------------------------- | ---------------------------------- |
| No CI early stop                                | Task 3                             |
| Stage `.next`, no live `npm ci`                 | Task 2                             |
| `refresh-env` into stage                        | Task 2                             |
| Migrate after stop, before swap                 | Task 2                             |
| Failed prepare leaves live up                   | Task 2 (`rm -rf` stage, no stop)   |
| Failed migrate restarts old tree                | Task 2                             |
| Failed start keeps `.prev`                      | Task 2                             |
| Leftover `.prev` active delete / inactive abort | Task 1 + Task 2                    |
| First boot / already stopped                    | Task 2 (`stop \|\| true`; no prev) |
| README + CI/CD spec pointer                     | Task 4                             |
| Clone without `--shared`                        | Task 2                             |
