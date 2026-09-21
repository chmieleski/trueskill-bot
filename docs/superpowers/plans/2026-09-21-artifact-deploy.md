# Artifact Deploy (S3 Tarball) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** CI builds a portable Discord bot release tarball, uploads it to S3 (`bot/<sha>.tar.gz` + `bot/latest`), and the EC2 host downloads/unpacks that artifact and promotes it — no git pull, no on-host `pnpm install` / `tsc`.

**Architecture:** Pack script assembles a release tree matching today’s `/home/ubuntu/bot` layout. Terraform adds a private S3 bucket and IAM. `update-bot.sh` downloads + unpacks to `bot.next`; `host-update.sh` only refreshes env, deploy-commands, stop, Prisma migrate, directory swap, start. CI gains Turbo `.turbo` cache and replaces the SSM git pull body with the S3 bootstrap.

**Tech Stack:** pnpm 9.15.9, Turborepo, GitHub Actions (`actions/cache`), AWS S3 + SSM + existing OIDC role, Prisma migrate on host, systemd `dbz-bot`.

**Spec:** `docs/superpowers/specs/2026-09-21-artifact-deploy-design.md`

## Global Constraints

- Scope: `general` (deploy / CI only)
- User-facing strings remain English
- Keep systemd `WorkingDirectory=/home/ubuntu/bot` and `ExecStart=/usr/bin/node apps/bot/dist/index.js`
- Prisma migrate runs on the host after stop, never from GitHub Actions against prod DB
- No Docker; no GitHub Release assets as runtime delivery
- Conventional Commits for every commit in this plan
- Run `pnpm run format:check` (or format touched files) before claiming a task done when it touches Prettier-covered files

---

## File map

| File                                                                 | Responsibility                                                                                                                                            |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `infra/aws/s3-release.tf` (new)                                      | Private release bucket + public access block                                                                                                              |
| `infra/aws/iam.tf`                                                   | EC2 `s3:GetObject` on `bot/*`                                                                                                                             |
| `infra/aws/github-oidc.tf`                                           | GHA `s3:PutObject` (and list/get as needed) on `bot/*`                                                                                                    |
| `infra/aws/variables.tf` / `outputs.tf` / `terraform.tfvars.example` | Bucket name wiring / output for GitHub var                                                                                                                |
| `packages/db/package.json`                                           | Move `prisma` CLI to `dependencies` so production packs include migrate                                                                                   |
| `deploy/aws/pack-release.sh` (new)                                   | Build inputs assumed present; assemble tree + tar                                                                                                         |
| `deploy/aws/update-bot.sh`                                           | S3 download → unpack `bot.next` → exec `host-update.sh`                                                                                                   |
| `deploy/aws/host-update.sh`                                          | Artifact-mode promote only (no git / no install / no tsc)                                                                                                 |
| `deploy/aws/host-update-lib.sh`                                      | Keep stage/prev helpers; drop git-remote helpers only if unused after rewrite (prefer leave unused helpers until a follow-up cleanup to shrink this plan) |
| `apps/bot/package.json`                                              | `deploy-commands` runs compiled `node dist/deploy-commands.js`                                                                                            |
| `apps/bot/src/deploy/host-update-lib.test.ts`                        | Rewrite contract tests for artifact deploy                                                                                                                |
| `apps/bot/src/deploy/pack-release.test.ts` (new)                     | Assert pack script contents / RELEASE.json                                                                                                                |
| `.github/workflows/ci-cd.yml`                                        | Turbo cache; pack+upload; SSM bootstrap                                                                                                                   |
| `infra/aws/README.md`                                                | Document artifact deploy                                                                                                                                  |
| `docs/superpowers/specs/2026-08-22-zero-downtime-deploy-design.md`   | One-line pointer: tarball follow-up done by 2026-09-21 artifact spec                                                                                      |

---

### Task 1: Include Prisma CLI in production dependency graph

**Files:**

- Modify: `packages/db/package.json`
- Test: verify with `pnpm install` + `ls node_modules/.bin/prisma` after prod-like install (manual step below)

**Interfaces:**

- Consumes: none
- Produces: `prisma` available under package dependencies so `pnpm deploy` / production `node_modules` include the CLI

- [ ] **Step 1: Move `prisma` from `devDependencies` to `dependencies` in `@dbz/db`**

In `packages/db/package.json`, move the `"prisma": "^7.9.1"` entry from `devDependencies` into `dependencies` (keep `@prisma/client` where it is). Leave `dotenv` / `typescript` as devDependencies.

- [ ] **Step 2: Refresh the lockfile**

Run:

```bash
export PATH="$HOME/.local/share/fnm/aliases/default/bin:$HOME/.local/bin:$PATH"
pnpm install
```

Expected: lockfile updates; no peer dependency errors.

- [ ] **Step 3: Confirm CLI resolves**

Run:

```bash
pnpm --filter @dbz/db exec prisma -v
```

Expected: prints Prisma version (7.x).

- [ ] **Step 4: Commit**

```bash
git add packages/db/package.json pnpm-lock.yaml
git commit -m "$(cat <<'EOF'
fix(db): ship prisma CLI in production dependencies

EOF
)"
```

---

### Task 2: Pack release script + tests

**Files:**

- Create: `deploy/aws/pack-release.sh`
- Create: `apps/bot/src/deploy/pack-release.test.ts`
- Modify: root or bot `package.json` only if adding a convenience script (optional: `"pack:bot": "bash deploy/aws/pack-release.sh"` on root — include it)

**Interfaces:**

- Consumes: already-built `apps/bot/dist`, generated Prisma client, installed `node_modules` (CI runs build before pack)
- Produces: `$OUT_DIR/bot-<sha>.tar.gz` whose extract root contains the paths listed in the spec; writes `RELEASE.json`

- [ ] **Step 1: Write the failing pack contract test**

Create `apps/bot/src/deploy/pack-release.test.ts`:

```typescript
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
const packScript = join(repoRoot, 'deploy/aws/pack-release.sh');

describe('pack-release.sh', () => {
  it('exists and is executable documentation for CI', () => {
    expect(existsSync(packScript)).toBe(true);
  });

  it('packs required release paths when dist already exists', () => {
    const distEntry = join(repoRoot, 'apps/bot/dist/index.js');
    if (!existsSync(distEntry)) {
      execFileSync(
        'bash',
        [
          '-lc',
          'export PATH="$HOME/.local/share/fnm/aliases/default/bin:$HOME/.local/bin:$PATH"; pnpm --filter @dbz/db generate && pnpm --filter @dbz/bot build',
        ],
        { cwd: repoRoot, stdio: 'inherit' },
      );
    }

    const out = mkdtempSync(join(tmpdir(), 'pack-release-'));
    const sha = 'deadbeefcafebabe';
    execFileSync('bash', [packScript], {
      cwd: repoRoot,
      env: {
        ...process.env,
        RELEASE_SHA: sha,
        PACK_OUT_DIR: out,
      },
      stdio: 'inherit',
    });

    const tar = join(out, `bot-${sha}.tar.gz`);
    expect(existsSync(tar)).toBe(true);

    const extract = mkdtempSync(join(tmpdir(), 'pack-extract-'));
    execFileSync('tar', ['-xzf', tar, '-C', extract]);
    const root = extract; // tarball entries are relative to release root

    expect(existsSync(join(root, 'apps/bot/dist/index.js'))).toBe(true);
    expect(existsSync(join(root, 'apps/bot/package.json'))).toBe(true);
    expect(existsSync(join(root, 'packages/db/prisma/schema.prisma'))).toBe(true);
    expect(existsSync(join(root, 'packages/db/prisma/migrations'))).toBe(true);
    expect(existsSync(join(root, 'deploy/aws/host-update.sh'))).toBe(true);
    expect(existsSync(join(root, 'CHANGELOG.md'))).toBe(true);
    expect(existsSync(join(root, 'docs/discord/public'))).toBe(true);
    expect(existsSync(join(root, 'node_modules/.bin/prisma'))).toBe(true);
    expect(existsSync(join(root, 'node_modules/@dbz/db'))).toBe(true);

    const release = JSON.parse(readFileSync(join(root, 'RELEASE.json'), 'utf8')) as {
      sha: string;
      builtAt: string;
    };
    expect(release.sha).toBe(sha);
    expect(typeof release.builtAt).toBe('string');
    expect(release.builtAt.length).toBeGreaterThan(0);

    rmSync(out, { recursive: true, force: true });
    rmSync(extract, { recursive: true, force: true });
  }, 600_000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
export PATH="$HOME/.local/share/fnm/aliases/default/bin:$HOME/.local/bin:$PATH"
pnpm --filter @dbz/bot test -- src/deploy/pack-release.test.ts
```

Expected: FAIL (missing `pack-release.sh` or pack contents).

- [ ] **Step 3: Implement `deploy/aws/pack-release.sh`**

Create `deploy/aws/pack-release.sh`:

```bash
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
cp packages/db/package.json packages/db/index.js "${STAGING}/packages/db/"
if [[ -f packages/db/index.d.ts ]]; then
  cp packages/db/index.d.ts "${STAGING}/packages/db/"
fi

cp -a deploy "${STAGING}/"
cp CHANGELOG.md "${STAGING}/"
cp -a docs/discord "${STAGING}/docs/"

# Portable production dependency tree for @dbz/bot (includes workspace @dbz/db + prisma CLI).
pnpm --filter @dbz/bot deploy --prod "${STAGING}/.pnpm-deploy"
cp -a "${STAGING}/.pnpm-deploy/node_modules" "${STAGING}/"
# Ensure apps/bot can resolve the same tree layout systemd expects.
rm -rf "${STAGING}/.pnpm-deploy"

# If deploy nested @dbz/db without prisma schema, keep our copied packages/db and link it.
mkdir -p "${STAGING}/node_modules/@dbz"
rm -rf "${STAGING}/node_modules/@dbz/db"
ln -s ../../packages/db "${STAGING}/node_modules/@dbz/db"

if [[ ! -e "${STAGING}/node_modules/.bin/prisma" ]]; then
  echo "prisma CLI missing from packed node_modules" >&2
  exit 1
fi

printf '%s\n' "{\"sha\":\"${RELEASE_SHA}\",\"builtAt\":\"$(date -u +"%Y-%m-%dT%H:%M:%SZ")\"}" >"${STAGING}/RELEASE.json"

TAR="${PACK_OUT_DIR}/bot-${RELEASE_SHA}.tar.gz"
tar -czf "${TAR}" -C "${STAGING}" .
echo "Wrote ${TAR}"
```

Make executable: `chmod +x deploy/aws/pack-release.sh`.

Add root script in `package.json`:

```json
"pack:bot": "bash deploy/aws/pack-release.sh"
```

- [ ] **Step 4: Run pack test to verify it passes**

Run:

```bash
pnpm --filter @dbz/bot test -- src/deploy/pack-release.test.ts
```

Expected: PASS. If `pnpm deploy` layout differs (prisma bin path, symlink), adjust the script until the test’s required paths exist — do not weaken the assertions.

- [ ] **Step 5: Commit**

```bash
git add deploy/aws/pack-release.sh apps/bot/src/deploy/pack-release.test.ts package.json
git commit -m "$(cat <<'EOF'
feat(deploy): add bot release pack script

EOF
)"
```

---

### Task 3: Terraform S3 release bucket + IAM

**Files:**

- Create: `infra/aws/s3-release.tf`
- Modify: `infra/aws/iam.tf`
- Modify: `infra/aws/github-oidc.tf`
- Modify: `infra/aws/variables.tf`
- Modify: `infra/aws/outputs.tf`
- Modify: `infra/aws/terraform.tfvars.example`

**Interfaces:**

- Consumes: `local.name_prefix`, `local.common_tags`, existing EC2 + GHA roles
- Produces: bucket name output `release_bucket_name`; objects under `bot/*`

- [ ] **Step 1: Add bucket resource**

Create `infra/aws/s3-release.tf`:

```hcl
resource "aws_s3_bucket" "release" {
  bucket = "${local.name_prefix}-release"
  tags   = local.common_tags
}

resource "aws_s3_bucket_public_access_block" "release" {
  bucket = aws_s3_bucket.release.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "release" {
  bucket = aws_s3_bucket.release.id
  versioning_configuration {
    status = "Enabled"
  }
}
```

- [ ] **Step 2: EC2 GetObject**

Append to `data.aws_iam_policy_document.bot_ssm` in `infra/aws/iam.tf` (or add a sibling policy document attached to the bot role):

```hcl
statement {
  sid = "ReadReleaseArtifacts"
  actions = [
    "s3:GetObject",
    "s3:ListBucket",
  ]
  resources = [
    aws_s3_bucket.release.arn,
    "${aws_s3_bucket.release.arn}/bot/*",
  ]
}
```

If `ListBucket` must target the bucket ARN only and `GetObject` the object ARN, split into two statements (AWS standard).

- [ ] **Step 3: GHA PutObject**

Append to `data.aws_iam_policy_document.gha_deploy` in `infra/aws/github-oidc.tf`:

```hcl
statement {
  sid = "UploadReleaseArtifacts"
  actions = [
    "s3:PutObject",
    "s3:AbortMultipartUpload",
    "s3:ListBucket",
  ]
  resources = [
    aws_s3_bucket.release.arn,
    "${aws_s3_bucket.release.arn}/bot/*",
  ]
}
```

- [ ] **Step 4: Output + example tfvars comment**

In `outputs.tf`:

```hcl
output "release_bucket_name" {
  description = "S3 bucket for bot release tarballs (set GitHub Actions var RELEASE_BUCKET)"
  value       = aws_s3_bucket.release.bucket
}
```

Document in `terraform.tfvars.example` a comment that after apply, set repo variable `RELEASE_BUCKET` to this output. No new required tfvars key unless you parameterize the bucket name — default `${local.name_prefix}-release` is enough.

- [ ] **Step 5: Validate**

Run:

```bash
cd infra/aws && tofu validate
```

Expected: success (or `terraform validate` if that is what the repo uses — match existing README). Do **not** `tofu apply` from the agent unless the user asks; note apply is an ops step.

- [ ] **Step 6: Commit**

```bash
git add infra/aws/s3-release.tf infra/aws/iam.tf infra/aws/github-oidc.tf infra/aws/outputs.tf infra/aws/terraform.tfvars.example
git commit -m "$(cat <<'EOF'
feat(infra): add private S3 bucket for bot release artifacts

EOF
)"
```

---

### Task 4: `deploy-commands` via compiled JS

**Files:**

- Modify: `apps/bot/package.json`
- Modify: any docs that say `tsx src/deploy-commands.ts` for production (only if present)

**Interfaces:**

- Consumes: `apps/bot/dist/deploy-commands.js` from `tsc`
- Produces: `pnpm --filter @dbz/bot deploy-commands` works without `tsx` in production node_modules

- [ ] **Step 1: Change the script**

In `apps/bot/package.json`:

```json
"deploy-commands": "node dist/deploy-commands.js"
```

Keep local/dev ability via `pnpm --filter @dbz/bot build` first, or add:

```json
"deploy-commands:watch": "tsx src/deploy-commands.ts"
```

only if you still want a no-build path — optional; YAGNI unless someone uses it daily.

- [ ] **Step 2: Smoke the compiled entry**

Run:

```bash
pnpm --filter @dbz/bot build
node -e "import('fs').then(fs=>fs.accessSync('apps/bot/dist/deploy-commands.js'))"
```

Expected: file exists (registerCommands still needs Discord env if executed fully — do not require a live Discord call in this task).

- [ ] **Step 3: Commit**

```bash
git add apps/bot/package.json
git commit -m "$(cat <<'EOF'
fix(bot): run deploy-commands from compiled dist

EOF
)"
```

---

### Task 5: Rewrite `host-update.sh` for artifact mode

**Files:**

- Modify: `deploy/aws/host-update.sh`
- Modify: `apps/bot/src/deploy/host-update-lib.test.ts` (cut-over + CI contract tests)

**Interfaces:**

- Consumes: `${APP_DIR}.next` already populated as a full release tree; `/etc/dbz-bot/ssm.env` for `refresh-env.sh`
- Produces: promote to `APP_DIR`; migrate via vendored Prisma CLI; no git / pnpm install / tsc

- [ ] **Step 1: Rewrite failing contract tests first**

Replace the `describe('host-update.sh cut-over order')` and git-centric CI expectations in `apps/bot/src/deploy/host-update-lib.test.ts` with:

```typescript
describe('host-update.sh artifact cut-over', () => {
  it('does not git pull or pnpm install on the host', () => {
    const sh = readFileSync(join(repoRoot, 'deploy/aws/host-update.sh'), 'utf8');
    expect(sh).not.toMatch(/git clone/);
    expect(sh).not.toMatch(/pnpm install/);
    expect(sh).not.toMatch(/pnpm --filter @dbz\/bot build/);
    expect(sh).not.toMatch(/git -C "\$\{APP_DIR\}" pull/);
  });

  it('requires stage dir and migrates after stop', () => {
    const sh = readFileSync(join(repoRoot, 'deploy/aws/host-update.sh'), 'utf8');
    expect(sh).toContain('host_update_stage_dir');
    expect(sh).toContain('systemctl stop dbz-bot');
    expect(sh).toMatch(/prisma migrate deploy/);
    expect(sh.indexOf('prisma migrate deploy')).toBeGreaterThan(
      sh.indexOf('systemctl stop dbz-bot'),
    );
  });

  it('runs deploy-commands from stage before stop', () => {
    const sh = readFileSync(join(repoRoot, 'deploy/aws/host-update.sh'), 'utf8');
    const deployIdx = sh.indexOf('apps/bot/dist/deploy-commands.js');
    const stopIdx = sh.indexOf('systemctl stop dbz-bot');
    expect(deployIdx).toBeGreaterThan(-1);
    expect(stopIdx).toBeGreaterThan(deployIdx);
  });
});

describe('CI deploy SSM command', () => {
  it('does not stop dbz-bot before host-update.sh', () => {
    const yml = readFileSync(join(repoRoot, '.github/workflows/ci-cd.yml'), 'utf8');
    const from = yml.indexOf('Deploy via SSM');
    expect(from).toBeGreaterThan(-1);
    const chunk = yml.slice(from);
    expect(chunk).not.toMatch(/systemctl stop dbz-bot/);
  });

  it('bootstraps from S3 instead of git pull', () => {
    const yml = readFileSync(join(repoRoot, '.github/workflows/ci-cd.yml'), 'utf8');
    expect(yml).toMatch(/aws s3 cp/);
    expect(yml).toContain('update-bot.sh');
    expect(yml).not.toContain('pull --ff-only origin main');
    expect(yml).not.toContain('Repairing local origin from /etc/dbz-bot/git-remote.url');
  });

  it('does not pre-check the deploy lock from CI (host-update blocks on flock)', () => {
    const yml = readFileSync(join(repoRoot, '.github/workflows/ci-cd.yml'), 'utf8');
    expect(yml).not.toContain('lock-check');
  });

  it('waits up to 30 minutes for the deploy lock on the host', () => {
    const sh = readFileSync(join(repoRoot, 'deploy/aws/host-update.sh'), 'utf8');
    expect(sh).toContain('flock -w 1800 9');
    expect(sh).not.toContain('flock -n 9');
  });
});
```

Keep the existing `host-update-lib` unit tests for stage/prev leftover handling.

- [ ] **Step 2: Run tests — expect host-update assertions to fail**

Run:

```bash
pnpm --filter @dbz/bot test -- src/deploy/host-update-lib.test.ts
```

Expected: FAIL on new artifact assertions (old script still has git/pnpm).

- [ ] **Step 3: Rewrite `host-update.sh`**

Replace the body after flock/source with artifact mode (keep root check, `APP_DIR`, lock, `host_update_*_dir`, leftover prev, ensure-swap optional):

```bash
#!/bin/bash
# Canonical production updater. Must run as root on the EC2 host.
# Prerequisite: ${APP_DIR}.next is a full release tree (see update-bot.sh).
# Usage: sudo bash /home/ubuntu/bot/deploy/aws/host-update.sh
#    or: sudo bash /home/ubuntu/bot.next/deploy/aws/host-update.sh
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run as root: sudo bash $0" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# When invoked from bot.next/deploy/aws, APP_DIR should still be the live path.
APP_DIR="${APP_DIR:-/home/ubuntu/bot}"
APP_USER="${APP_USER:-ubuntu}"
LOCK_FILE="${LOCK_FILE:-/var/lock/dbz-bot-update.lock}"
READY_FILE="${READY_FILE:-/var/lib/dbz-bot/ready}"

exec 9>"${LOCK_FILE}"
if ! flock -w 1800 9; then
  echo "Timed out waiting for deploy lock ${LOCK_FILE}" >&2
  exit 1
fi

# shellcheck source=host-update-lib.sh
source "${SCRIPT_DIR}/host-update-lib.sh"

STAGE_DIR="$(host_update_stage_dir "${APP_DIR}")"
PREV_DIR="$(host_update_prev_dir "${APP_DIR}")"

if [[ ! -d "${STAGE_DIR}" ]]; then
  echo "Missing stage ${STAGE_DIR} — run update-bot.sh (S3 unpack) first" >&2
  exit 1
fi
if [[ ! -f "${STAGE_DIR}/apps/bot/dist/index.js" ]]; then
  echo "Stage missing apps/bot/dist/index.js" >&2
  exit 1
fi
if [[ ! -f "${STAGE_DIR}/RELEASE.json" ]]; then
  echo "Stage missing RELEASE.json" >&2
  exit 1
fi

if [[ -f "${STAGE_DIR}/deploy/aws/ensure-swap.sh" ]]; then
  bash "${STAGE_DIR}/deploy/aws/ensure-swap.sh" || true
fi

UNIT_ACTIVE="no"
if systemctl is-active --quiet dbz-bot; then
  UNIT_ACTIVE="yes"
fi
host_update_handle_leftover_prev "${APP_DIR}" "${UNIT_ACTIVE}"

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
  APP_DIR="${STAGE_DIR}" /usr/local/bin/dbz-bot-refresh-env
else
  echo "No refresh-env.sh (with SSM_PREFIX) and no /usr/local/bin/dbz-bot-refresh-env" >&2
  rm -rf "${STAGE_DIR}"
  exit 1
fi

echo "==> Deploying slash commands from stage"
if ! sudo -u "${APP_USER}" bash -lc "cd '${STAGE_DIR}' && node apps/bot/dist/deploy-commands.js"; then
  echo "deploy-commands failed; leaving live bot running" >&2
  rm -rf "${STAGE_DIR}"
  exit 1
fi

echo "==> Stopping dbz-bot for migrate and swap"
systemctl stop dbz-bot || true

echo "==> Migrating database from stage"
set -a
# shellcheck disable=SC1091
source "${STAGE_DIR}/.env"
set +a
if ! sudo -u "${APP_USER}" bash -lc "cd '${STAGE_DIR}' && ./node_modules/.bin/prisma migrate deploy --schema packages/db/prisma/schema.prisma"; then
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

echo "==> Update complete ($(cat "${APP_DIR}/RELEASE.json"))"
```

Note: sourcing `.env` as root then migrating as `ubuntu` — prefer passing env explicitly:

```bash
sudo -u "${APP_USER}" bash -lc "set -a; source '${STAGE_DIR}/.env'; set +a; cd '${STAGE_DIR}' && ./node_modules/.bin/prisma migrate deploy --schema packages/db/prisma/schema.prisma"
```

Use that form so secrets are not exported into the root shell unnecessarily.

- [ ] **Step 4: Run host-update contract tests**

Run:

```bash
pnpm --filter @dbz/bot test -- src/deploy/host-update-lib.test.ts
```

Expected: host-update describe PASS; CI describe may still FAIL until Task 7 — if so, temporarily skip only the CI S3 assertions with `it.skip` **or** land Task 6–7 in the same sitting. Prefer not skipping: implement Task 6 next before re-running CI assertions.

- [ ] **Step 5: Commit**

```bash
git add deploy/aws/host-update.sh apps/bot/src/deploy/host-update-lib.test.ts
git commit -m "$(cat <<'EOF'
feat(deploy): promote S3 release stage without git build

EOF
)"
```

---

### Task 6: `update-bot.sh` S3 bootstrap

**Files:**

- Modify: `deploy/aws/update-bot.sh`

**Interfaces:**

- Consumes: `RELEASE_BUCKET`, optional `RELEASE_SHA` (default: download `bot/latest`), `APP_DIR` (default `/home/ubuntu/bot`), AWS credentials via instance role
- Produces: populated `${APP_DIR}.next`, then exec `host-update.sh` from the stage copy of the script

- [ ] **Step 1: Implement bootstrap**

Replace `deploy/aws/update-bot.sh` with:

```bash
#!/bin/bash
# Download release tarball from S3, unpack to APP_DIR.next, run host-update.sh.
# Usage (on the instance): sudo RELEASE_BUCKET=... ./deploy/aws/update-bot.sh
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run as root: sudo $0" >&2
  exit 1
fi

APP_DIR="${APP_DIR:-/home/ubuntu/bot}"
APP_USER="${APP_USER:-ubuntu}"
RELEASE_BUCKET="${RELEASE_BUCKET:?RELEASE_BUCKET is required}"
RELEASE_SHA="${RELEASE_SHA:-}"
AWS_REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-eu-central-1}}"

STAGE_DIR="${APP_DIR}.next"
TMP_TAR="$(mktemp /tmp/dbz-bot-release.XXXXXX.tar.gz)"
TMP_EXTRACT="$(mktemp -d /tmp/dbz-bot-extract.XXXXXX)"

cleanup() {
  rm -f "${TMP_TAR}"
  rm -rf "${TMP_EXTRACT}"
}
trap cleanup EXIT

if [[ -n "${RELEASE_SHA}" ]]; then
  KEY="bot/${RELEASE_SHA}.tar.gz"
else
  KEY="bot/latest"
fi

echo "==> Downloading s3://${RELEASE_BUCKET}/${KEY}"
aws s3 cp "s3://${RELEASE_BUCKET}/${KEY}" "${TMP_TAR}" --region "${AWS_REGION}"

echo "==> Unpacking to ${STAGE_DIR}"
rm -rf "${STAGE_DIR}"
mkdir -p "${TMP_EXTRACT}"
tar -xzf "${TMP_TAR}" -C "${TMP_EXTRACT}"
# Support tarballs with or without a single top-level folder
if [[ -f "${TMP_EXTRACT}/apps/bot/dist/index.js" ]]; then
  mv "${TMP_EXTRACT}" "${STAGE_DIR}"
  TMP_EXTRACT=""  # moved; skip rm in trap for extract — reset trap carefully
else
  echo "Tarball missing apps/bot/dist/index.js" >&2
  exit 1
fi

chown -R "${APP_USER}:${APP_USER}" "${STAGE_DIR}"

HOST_UPDATE="${STAGE_DIR}/deploy/aws/host-update.sh"
if [[ ! -f "${HOST_UPDATE}" ]]; then
  echo "host-update.sh missing in stage" >&2
  exit 1
fi

export APP_DIR APP_USER
exec bash "${HOST_UPDATE}"
```

Fix the trap/`mv` interaction so cleanup does not delete the stage: clear `TMP_EXTRACT` after successful `mv`, and only `rm -rf` if still a temp path under `/tmp`.

- [ ] **Step 2: Shellcheck mentally / dry syntax**

Run:

```bash
bash -n deploy/aws/update-bot.sh
bash -n deploy/aws/host-update.sh
```

Expected: no output, exit 0.

- [ ] **Step 3: Commit**

```bash
git add deploy/aws/update-bot.sh
git commit -m "$(cat <<'EOF'
feat(deploy): bootstrap host update from S3 tarball

EOF
)"
```

---

### Task 7: CI Turbo cache + pack + S3 + SSM

**Files:**

- Modify: `.github/workflows/ci-cd.yml`

**Interfaces:**

- Consumes: `secrets.AWS_ROLE_ARN`, new repo variable `RELEASE_BUCKET`, `GITHUB_SHA`
- Produces: uploaded `bot/$GITHUB_SHA.tar.gz` and `bot/latest`; SSM runs `update-bot.sh`

- [ ] **Step 1: Add Turbo cache to `test` (and reuse on deploy pack)**

In the `test` job, after `pnpm install`:

```yaml
- name: Cache Turbo
  uses: actions/cache@v4
  with:
    path: .turbo
    key: turbo-${{ runner.os }}-${{ hashFiles('pnpm-lock.yaml') }}-${{ github.ref_name }}-${{ github.sha }}
    restore-keys: |
      turbo-${{ runner.os }}-${{ hashFiles('pnpm-lock.yaml') }}-${{ github.ref_name }}-
      turbo-${{ runner.os }}-${{ hashFiles('pnpm-lock.yaml') }}-
      turbo-${{ runner.os }}-
```

Change build/typecheck/test steps to go through Turbo where possible:

```yaml
- run: pnpm --filter @dbz/db generate
- run: pnpm exec turbo run typecheck test --filter=@dbz/bot
- run: pnpm exec turbo run build --filter=@dbz/web
```

(Keep format job as-is.)

- [ ] **Step 2: Extend `deploy` job to pack and upload**

After AWS credentials, before SSM:

```yaml
- uses: actions/checkout@v4
- uses: pnpm/action-setup@v4
  with:
    version: 9.15.9
- uses: actions/setup-node@v4
  with:
    node-version: '22'
    cache: pnpm
- name: Cache Turbo
  uses: actions/cache@v4
  with:
    path: .turbo
    key: turbo-${{ runner.os }}-${{ hashFiles('pnpm-lock.yaml') }}-${{ github.ref_name }}-${{ github.sha }}
    restore-keys: |
      turbo-${{ runner.os }}-${{ hashFiles('pnpm-lock.yaml') }}-${{ github.ref_name }}-
      turbo-${{ runner.os }}-${{ hashFiles('pnpm-lock.yaml') }}-
      turbo-${{ runner.os }}-
- run: git config --global url."https://github.com/".insteadOf ssh://git@github.com/
- run: 'git config --global url."https://github.com/".insteadOf git@github.com:'
- run: git config --global url."https://github.com/".insteadOf git+ssh://git@github.com/
- run: pnpm install --frozen-lockfile
- run: pnpm --filter @dbz/db generate
- run: pnpm exec turbo run build --filter=@dbz/bot
- name: Pack release
  env:
    RELEASE_SHA: ${{ github.sha }}
    PACK_OUT_DIR: ${{ runner.temp }}/release
  run: bash deploy/aws/pack-release.sh
- name: Upload release to S3
  env:
    RELEASE_BUCKET: ${{ vars.RELEASE_BUCKET }}
    RELEASE_SHA: ${{ github.sha }}
  run: |
    set -euo pipefail
    if [[ -z "${RELEASE_BUCKET}" ]]; then
      echo "::error::Set repository variable RELEASE_BUCKET to the Terraform release_bucket_name output" >&2
      exit 1
    fi
    TAR="${RUNNER_TEMP}/release/bot-${RELEASE_SHA}.tar.gz"
    aws s3 cp "${TAR}" "s3://${RELEASE_BUCKET}/bot/${RELEASE_SHA}.tar.gz"
    aws s3 cp "${TAR}" "s3://${RELEASE_BUCKET}/bot/latest"
```

- [ ] **Step 3: Replace SSM command body**

Remove git fetch/pull/origin repair. Use:

```bash
set -euo pipefail
echo "==> deploy ${GITHUB_SHA}"
export RELEASE_BUCKET=...   # inject via jq --arg
export RELEASE_SHA=...      # same sha uploaded
export APP_DIR=/home/ubuntu/bot
export AWS_REGION=...
# Prefer updater from live tree if present; else require aws+unpack inline.
if [[ -f /home/ubuntu/bot/deploy/aws/update-bot.sh ]]; then
  sudo RELEASE_BUCKET="$RELEASE_BUCKET" RELEASE_SHA="$RELEASE_SHA" APP_DIR="$APP_DIR" AWS_REGION="$AWS_REGION" \
    bash /home/ubuntu/bot/deploy/aws/update-bot.sh
else
  # First artifact cutover: download with aws cli, unpack bot.next, run stage host-update
  ...
fi
```

For **first** cutover from git-based hosts, the live `update-bot.sh` is still the old thin wrapper. Bake the download+unpack **inline in the SSM script** (duplicate of update-bot.sh logic) so the first deploy does not depend on an already-updated live script; subsequent deploys use the stage’s `host-update.sh` via that inline bootstrap. Concretely: **always** inline the S3 cp + tar + `exec bash bot.next/deploy/aws/host-update.sh` in SSM (same as update-bot.sh). Keep `update-bot.sh` for manual ops.

- [ ] **Step 4: Run contract tests**

Run:

```bash
pnpm --filter @dbz/bot test -- src/deploy/host-update-lib.test.ts src/deploy/pack-release.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/ci-cd.yml
git commit -m "$(cat <<'EOF'
feat(ci): ship bot release tarball to S3 with Turbo cache

EOF
)"
```

---

### Task 8: Docs + prior-spec pointer

**Files:**

- Modify: `infra/aws/README.md`
- Modify: `docs/superpowers/specs/2026-08-22-zero-downtime-deploy-design.md` (follow-ups bullet)

- [ ] **Step 1: Update README deploy section**

Replace the “git pull / npm ci in bot.next” narrative with: CI packs → S3 → SSM download → stage promote; migrate still on host after stop. Document `RELEASE_BUCKET` GitHub variable and manual:

```bash
sudo RELEASE_BUCKET=... RELEASE_SHA=... bash /home/ubuntu/bot/deploy/aws/update-bot.sh
```

- [ ] **Step 2: Point zero-downtime follow-up**

In `2026-08-22-zero-downtime-deploy-design.md` Open follow-ups, change the “Build artifacts in GitHub Actions…” bullet to note it is superseded by `2026-09-21-artifact-deploy-design.md`.

- [ ] **Step 3: Commit**

```bash
git add infra/aws/README.md docs/superpowers/specs/2026-08-22-zero-downtime-deploy-design.md
git commit -m "$(cat <<'EOF'
docs: document S3 artifact deploy path

EOF
)"
```

---

### Task 9: Ops checklist (human / agent with approval)

Not a code commit — verify before calling the feature done in production:

- [ ] **Step 1:** `tofu apply` (or equivalent) so the bucket + IAM exist
- [ ] **Step 2:** Set GitHub Actions variable `RELEASE_BUCKET` to `release_bucket_name`
- [ ] **Step 3:** Merge/deploy once; confirm SSM log shows S3 download, no `git pull` / `pnpm install`
- [ ] **Step 4:** Confirm `RELEASE.json` on host matches the GitHub SHA
- [ ] **Step 5:** Confirm Prisma migrate ran from stage after stop
- [ ] **Step 6:** Second CI run on an unchanged bot build path shows Turbo cache restore (Actions cache hit)

---

## Self-review (plan vs spec)

| Spec requirement                                        | Task                       |
| ------------------------------------------------------- | -------------------------- |
| Portable tarball layout                                 | Task 2                     |
| S3 `bot/<sha>` + `bot/latest`                           | Tasks 3, 7                 |
| Updater scripts inside tarball                          | Task 2 (copies `deploy/`)  |
| SSM bootstrap download/unpack; host-update promote only | Tasks 5–7                  |
| No git on hot path                                      | Tasks 5, 7                 |
| Prisma migrate on host after stop                       | Task 5                     |
| Prisma CLI in artifact                                  | Tasks 1–2                  |
| Turbo cache in CI                                       | Task 7                     |
| systemd paths unchanged                                 | Tasks 2, 5 (layout)        |
| Error handling tables                                   | Task 5 (same control flow) |
| Docs                                                    | Task 8                     |
| Ops apply + RELEASE_BUCKET                              | Task 9                     |

No intentional TBD placeholders remain. First-cutover bootstrap is explicitly **inline in SSM** so live `update-bot.sh` need not already be artifact-aware.
