# GitHub Actions CI/CD Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run Vitest on every pull request and on push to `main`; after tests pass on `main`, deploy to the existing EC2 host via SSM (pull, migrate, build, register slash commands, restart).

**Architecture:** GitHub-hosted Actions assume an IAM role through GitHub OIDC (no access keys). The deploy job finds the instance by tag `Name=dbz-bot-prod`, `git pull`s, then runs `deploy/aws/host-update.sh` on the box. Bot secrets stay in SSM on the instance.

**Tech Stack:** GitHub Actions, AWS IAM OIDC, SSM SendCommand, OpenTofu/Terraform AWS provider ~> 5.0, bash, Node 22, Vitest

**Spec:** [docs/superpowers/specs/2026-08-14-github-actions-cicd-design.md](../specs/2026-08-14-github-actions-cicd-design.md)

## Global Constraints

- User-facing strings, logs, command names, and errors in **English**
- CI runner: GitHub-hosted `ubuntu-latest`, Node **22**
- Test command: `npm ci` then `npm test` (no `DATABASE_URL`)
- Deploy only when `github.event_name == 'push'` and `github.ref == 'refs/heads/main'`
- AWS auth: GitHub OIDC only — no long-lived access keys
- IAM trust: only `repo:chmieleski/trueskill-bot:ref:refs/heads/main`
- Instance lookup: tag `Name` = `${project_name}-${environment}` (default `dbz-bot-prod`)
- Update source of truth: `deploy/aws/host-update.sh` in git
- Slash commands: `npm run deploy-commands` on every successful host update
- Restart only after pull, env refresh, `npm ci`, migrate, build, and command deploy succeed
- Deploy concurrency group `deploy-prod`; `cancel-in-progress: false`
- SSM timeout: 600 seconds
- Do not apply Terraform from CI
- Do not put Discord / Supabase / Gemini secrets in GitHub
- Do not open SSH or inbound HTTP
- Commits only when the user asks (skip commit steps unless requested)

## File structure

| File | Responsibility |
|------|----------------|
| `deploy/aws/host-update.sh` | Canonical root updater: pull, refresh `.env`, ci/migrate/build/deploy-commands, restart |
| `deploy/aws/update-bot.sh` | Thin helper that execs `host-update.sh` from repo root |
| `infra/aws/user-data.sh.tftpl` | Cloud-init `dbz-bot-update` becomes `exec bash $APP_DIR/deploy/aws/host-update.sh` |
| `infra/aws/github-oidc.tf` | GitHub OIDC provider, GHA IAM role, least-privilege SSM policy |
| `infra/aws/variables.tf` | `github_repository` |
| `infra/aws/outputs.tf` | `github_actions_role_arn` |
| `infra/aws/terraform.tfvars.example` | Document `github_repository` |
| `.github/workflows/ci-cd.yml` | `test` job always; `deploy` job on `main` push via SSM |
| `infra/aws/README.md` | Operator: apply OIDC, set `AWS_ROLE_ARN`, what push to `main` does |
| `docs/superpowers/specs/2026-08-14-aws-free-tier-deploy-design.md` | CI/CD no longer a non-goal; pointer to CI/CD spec |

---

### Task 1: Host update script (source of truth)

**Files:**
- Create: `deploy/aws/host-update.sh`
- Modify: `deploy/aws/update-bot.sh`
- Modify: `infra/aws/user-data.sh.tftpl` (only the `dbz-bot-update` heredoc)

**Interfaces:**
- Consumes: `/usr/local/bin/dbz-bot-refresh-env` (already installed by cloud-init); systemd unit `dbz-bot`; git clone at `APP_DIR`
- Produces: `deploy/aws/host-update.sh` runnable as root; `sudo ./deploy/aws/update-bot.sh` execs it; new instances' `/usr/local/bin/dbz-bot-update` execs it

- [ ] **Step 1: Create `deploy/aws/host-update.sh`**

```bash
#!/bin/bash
# Canonical production updater. Must run as root on the EC2 host.
# Usage: sudo bash /home/ubuntu/bot/deploy/aws/host-update.sh
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run as root: sudo bash $0" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${APP_DIR:-$(cd "${SCRIPT_DIR}/../.." && pwd)}"
BRANCH="${BRANCH:-main}"
APP_USER="${APP_USER:-ubuntu}"

cd "${APP_DIR}"

echo "==> Updating ${APP_DIR} from origin/${BRANCH}"
sudo -u "${APP_USER}" git fetch --all
sudo -u "${APP_USER}" git checkout "${BRANCH}"
sudo -u "${APP_USER}" git pull --ff-only origin "${BRANCH}"

echo "==> Refreshing .env from SSM"
/usr/local/bin/dbz-bot-refresh-env

echo "==> Installing, migrating, building, registering commands"
sudo -u "${APP_USER}" bash -lc "cd '${APP_DIR}' && npm ci && npx prisma migrate deploy && npm run build && npm run deploy-commands"

echo "==> Restarting dbz-bot"
systemctl restart dbz-bot
systemctl --no-pager --full status dbz-bot || true

echo "==> Update complete ($(sudo -u "${APP_USER}" git -C "${APP_DIR}" rev-parse --short HEAD))"
```

Then:

```bash
chmod +x deploy/aws/host-update.sh
```

- [ ] **Step 2: Point `deploy/aws/update-bot.sh` at the repo script**

Replace the file with:

```bash
#!/bin/bash
# Usage (on the instance): sudo ./deploy/aws/update-bot.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST_UPDATE="${SCRIPT_DIR}/host-update.sh"

if [[ ! -f "${HOST_UPDATE}" ]]; then
  echo "host-update.sh not found at ${HOST_UPDATE}" >&2
  exit 1
fi

exec bash "${HOST_UPDATE}"
```

- [ ] **Step 3: Slim the cloud-init `dbz-bot-update` wrapper**

In `infra/aws/user-data.sh.tftpl`, replace the `cat > /usr/local/bin/dbz-bot-update <<EOF` block (the full updater) with:

```bash
  cat > /usr/local/bin/dbz-bot-update <<EOF
#!/bin/bash
set -euo pipefail
exec bash "$APP_DIR/deploy/aws/host-update.sh"
EOF
  chmod 755 /usr/local/bin/dbz-bot-update
```

Do **not** change first-boot clone / `npm ci` / migrate / optional `deploy-commands` / systemd enable. Only this wrapper.

- [ ] **Step 4: Syntax-check the scripts**

Run:

```bash
bash -n deploy/aws/host-update.sh
bash -n deploy/aws/update-bot.sh
```

Expected: no output, exit 0.

- [ ] **Step 5: Commit** (only if user asked)

```bash
git add deploy/aws/host-update.sh deploy/aws/update-bot.sh infra/aws/user-data.sh.tftpl
git commit -m "$(cat <<'EOF'
Add repo-owned EC2 host update script for CI/CD.

EOF
)"
```

---

### Task 2: GitHub OIDC IAM in Terraform

**Files:**
- Create: `infra/aws/github-oidc.tf`
- Modify: `infra/aws/variables.tf` (append `github_repository`)
- Modify: `infra/aws/outputs.tf` (append `github_actions_role_arn`)
- Modify: `infra/aws/terraform.tfvars.example` (document the variable)

**Interfaces:**
- Consumes: `var.project_name`, `var.environment`, `var.aws_region`, `data.aws_caller_identity.current` (already in `iam.tf`)
- Produces: role ARN output `github_actions_role_arn`; trust `repo:${var.github_repository}:ref:refs/heads/main`

- [ ] **Step 1: Add variable**

Append to `infra/aws/variables.tf`:

```hcl
variable "github_repository" {
  description = "GitHub org/repo allowed to assume the Actions deploy role (OIDC sub on main only)"
  type        = string
  default     = "chmieleski/trueskill-bot"
}
```

- [ ] **Step 2: Create `infra/aws/github-oidc.tf`**

```hcl
resource "aws_iam_openid_connect_provider" "github" {
  url             = "https://token.actions.githubusercontent.com"
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = [
    "6938fd4d98bab03faadb97b34396831e3780aea1",
    "1c58a3a8518e8759bf075b76b750d4f2df264fcd",
  ]

  tags = local.common_tags
}

data "aws_iam_policy_document" "gha_assume" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.github_repository}:ref:refs/heads/main"]
    }
  }
}

resource "aws_iam_role" "gha" {
  name               = "${local.name_prefix}-gha"
  assume_role_policy = data.aws_iam_policy_document.gha_assume.json
  tags               = local.common_tags
}

data "aws_iam_policy_document" "gha_deploy" {
  statement {
    sid       = "SendCommandDocument"
    actions   = ["ssm:SendCommand"]
    resources = ["arn:aws:ssm:${var.aws_region}::document/AWS-RunShellScript"]
  }

  statement {
    sid     = "SendCommandTaggedInstance"
    actions = ["ssm:SendCommand"]
    resources = [
      "arn:aws:ec2:${var.aws_region}:${data.aws_caller_identity.current.account_id}:instance/*",
    ]

    condition {
      test     = "StringEquals"
      variable = "ssm:resourceTag/Name"
      values   = ["${local.name_prefix}"]
    }
  }

  statement {
    sid       = "GetCommandInvocation"
    actions   = ["ssm:GetCommandInvocation"]
    resources = ["*"]
  }

  statement {
    sid       = "DescribeInstancesForTagTarget"
    actions   = ["ec2:DescribeInstances"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "gha_deploy" {
  name   = "${local.name_prefix}-gha-deploy"
  role   = aws_iam_role.gha.id
  policy = data.aws_iam_policy_document.gha_deploy.json
}
```

- [ ] **Step 3: Add output**

Append to `infra/aws/outputs.tf`:

```hcl
output "github_actions_role_arn" {
  description = "IAM role ARN for GitHub Actions OIDC (set as repo secret AWS_ROLE_ARN)"
  value       = aws_iam_role.gha.arn
}
```

- [ ] **Step 4: Document the variable in `terraform.tfvars.example`**

After `repo_branch = "main"`, add:

```hcl
# GitHub repo allowed to assume the deploy IAM role via OIDC (push to main only)
github_repository = "chmieleski/trueskill-bot"
```

- [ ] **Step 5: Validate Terraform**

Run:

```bash
cd infra/aws
tofu init -backend=false
tofu validate
```

If `tofu` is missing, use `terraform init -backend=false && terraform validate`.

Expected: `Success! The configuration is valid.`

`tofu plan` is optional here (needs AWS credentials + `terraform.tfvars`). Do **not** `apply` from this task unless the user asks; apply is an operator step in the README.

- [ ] **Step 6: Commit** (only if user asked)

```bash
git add infra/aws/github-oidc.tf infra/aws/variables.tf infra/aws/outputs.tf infra/aws/terraform.tfvars.example
git commit -m "$(cat <<'EOF'
Add GitHub Actions OIDC role for SSM deploys.

EOF
)"
```

---

### Task 3: GitHub Actions workflow

**Files:**
- Create: `.github/workflows/ci-cd.yml`

**Interfaces:**
- Consumes: `secrets.AWS_ROLE_ARN`; optional `vars.AWS_REGION` (default `us-east-1`); optional `vars.EC2_NAME_TAG` (default `dbz-bot-prod`); `deploy/aws/host-update.sh` on the instance after pull
- Produces: PR/push `test` job; `main` push `deploy` job that SSM-runs the host updater

- [ ] **Step 1: Create `.github/workflows/ci-cd.yml`**

```yaml
name: CI/CD

on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read

jobs:
  test:
    name: Test
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "22"
          cache: npm
      - run: npm ci
      - run: npm test

  deploy:
    name: Deploy
    needs: test
    if: github.event_name == 'push' && github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    permissions:
      id-token: write
      contents: read
    concurrency:
      group: deploy-prod
      cancel-in-progress: false
    env:
      AWS_REGION: ${{ vars.AWS_REGION || 'us-east-1' }}
      EC2_NAME_TAG: ${{ vars.EC2_NAME_TAG || 'dbz-bot-prod' }}
      APP_DIR: /home/ubuntu/bot
    steps:
      - name: Configure AWS credentials (OIDC)
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ secrets.AWS_ROLE_ARN }}
          aws-region: ${{ env.AWS_REGION }}

      - name: Deploy via SSM
        run: |
          set -euo pipefail

          INSTANCE_IDS="$(aws ec2 describe-instances \
            --filters "Name=tag:Name,Values=${EC2_NAME_TAG}" "Name=instance-state-name,Values=running" \
            --query 'Reservations[].Instances[].InstanceId' \
            --output text)"

          INSTANCE_COUNT="$(printf '%s\n' ${INSTANCE_IDS} | grep -c . || true)"
          if [[ "${INSTANCE_COUNT}" -ne 1 ]]; then
            echo "Expected exactly 1 running instance tagged Name=${EC2_NAME_TAG}, found ${INSTANCE_COUNT}: ${INSTANCE_IDS}" >&2
            exit 1
          fi
          INSTANCE_ID="${INSTANCE_IDS}"
          echo "Target instance: ${INSTANCE_ID}"

          COMMAND_ID="$(aws ssm send-command \
            --instance-ids "${INSTANCE_ID}" \
            --document-name AWS-RunShellScript \
            --comment "dbz-bot deploy ${GITHUB_SHA}" \
            --timeout-seconds 600 \
            --parameters commands="$(jq -cn \
              --arg app "$APP_DIR" \
              '[
                "sudo -u ubuntu git -C \($app) fetch --all",
                "sudo -u ubuntu git -C \($app) checkout main",
                "sudo -u ubuntu git -C \($app) pull --ff-only origin main",
                "sudo bash \($app)/deploy/aws/host-update.sh"
              ]')" \
            --query 'Command.CommandId' \
            --output text)"

          echo "SSM command: ${COMMAND_ID}"

          for _ in $(seq 1 90); do
            STATUS="$(aws ssm get-command-invocation \
              --command-id "${COMMAND_ID}" \
              --instance-id "${INSTANCE_ID}" \
              --query 'Status' \
              --output text 2>/dev/null || echo Pending)"

            case "${STATUS}" in
              Success)
                aws ssm get-command-invocation \
                  --command-id "${COMMAND_ID}" \
                  --instance-id "${INSTANCE_ID}" \
                  --query 'StandardOutputContent' \
                  --output text
                exit 0
                ;;
              Failed|Cancelled|TimedOut|Undeliverable)
                echo "SSM command ${STATUS}" >&2
                aws ssm get-command-invocation \
                  --command-id "${COMMAND_ID}" \
                  --instance-id "${INSTANCE_ID}" \
                  --query '{stdout:StandardOutputContent,stderr:StandardErrorContent,status:Status}' \
                  --output json >&2
                exit 1
                ;;
              *)
                sleep 10
                ;;
            esac
          done

          echo "Timed out waiting for SSM command ${COMMAND_ID}" >&2
          exit 1
```

`jq` is preinstalled on `ubuntu-latest`. `aws-actions/configure-aws-credentials` installs the AWS CLI.

- [ ] **Step 2: Confirm tests still pass locally**

Run:

```bash
npm test
```

Expected: Vitest pass (unchanged app code).

- [ ] **Step 3: Commit** (only if user asked)

```bash
git add .github/workflows/ci-cd.yml
git commit -m "$(cat <<'EOF'
Add GitHub Actions workflow to test and SSM-deploy main.

EOF
)"
```

---

### Task 4: Docs

**Files:**
- Modify: `infra/aws/README.md`
- Modify: `docs/superpowers/specs/2026-08-14-aws-free-tier-deploy-design.md`

**Interfaces:**
- Consumes: output name `github_actions_role_arn`; secret name `AWS_ROLE_ARN`
- Produces: operator can apply OIDC and wire GitHub without reading the spec

- [ ] **Step 1: Replace the "Out of scope: … CI/CD pipeline …" line in the AWS deploy spec**

In `docs/superpowers/specs/2026-08-14-aws-free-tier-deploy-design.md`:

Change:

```markdown
Out of scope: RDS, ALB, ECS/Fargate, CI/CD pipeline, multi-region.
```

to:

```markdown
Out of scope: RDS, ALB, ECS/Fargate, multi-region.

CI/CD (test on PR, SSM deploy on `main`): [2026-08-14-github-actions-cicd-design.md](./2026-08-14-github-actions-cicd-design.md)
```

Also change operator step 5 from manual git pull to:

```markdown
5. Updates: push to `main` (GitHub Actions) or `sudo dbz-bot-update` on the instance.
```

- [ ] **Step 2: Add a CI/CD section to `infra/aws/README.md`**

Insert **before** `## Destroy`:

```markdown
## CI/CD (push to `main`)

Pull requests run `npm test`. A push to `main` runs the same tests, then AWS SSM runs `deploy/aws/host-update.sh` on the EC2 host (pull, migrate, build, register slash commands, restart).

### One-time setup

1. Apply this stack so the GitHub OIDC role exists:

   ```bash
   cd infra/aws
   tofu apply
   ```

2. Copy the `github_actions_role_arn` output.

3. In the GitHub repo: **Settings → Secrets and variables → Actions**
   - Secret `AWS_ROLE_ARN` = that ARN
   - Optional variable `AWS_REGION` (default `us-east-1`)
   - Optional variable `EC2_NAME_TAG` (default `dbz-bot-prod`)

Do **not** put `DISCORD_TOKEN`, `DATABASE_URL`, or `GEMINI_API_KEY` in GitHub. The instance already reads those from SSM.

Until `AWS_ROLE_ARN` is set, the Test job still runs; Deploy fails at OIDC.

### Manual update (unchanged)

```bash
sudo dbz-bot-update
```

New instances use the repo script via that wrapper. The existing host keeps the old baked wrapper until recreate; GitHub Actions does not call it — it `git pull`s and runs `deploy/aws/host-update.sh` directly.
```

Keep the existing "Update the bot later" heading or fold it: after adding CI/CD, shorten "Update the bot later" to a pointer at the new section so the README does not describe two conflicting update stories. Replace that whole section with:

```markdown
## Update the bot later

Preferred: merge to `main` (see **CI/CD** below).

On the instance (break-glass):

```bash
sudo dbz-bot-update
```

After changing secrets in `terraform.tfvars`, run `tofu apply` (updates SSM), then on the host:

```bash
sudo dbz-bot-refresh-env
sudo systemctl restart dbz-bot
```
```

Place **CI/CD** after this **Update** section (so "see CI/CD below" is accurate), still before **Destroy**.

- [ ] **Step 3: Commit** (only if user asked)

```bash
git add infra/aws/README.md docs/superpowers/specs/2026-08-14-aws-free-tier-deploy-design.md docs/superpowers/specs/2026-08-14-github-actions-cicd-design.md
git commit -m "$(cat <<'EOF'
Document GitHub Actions OIDC deploy on push to main.

EOF
)"
```

---

## Operator after merge (not a code task)

These run on the operator's machine / GitHub UI. The implementation is incomplete until they happen; they are not Terraform-from-CI.

1. `cd infra/aws && tofu apply` — creates OIDC provider + `dbz-bot-prod-gha`
2. Set GitHub secret `AWS_ROLE_ARN` to `github_actions_role_arn`
3. Merge/push this work to `main`
4. Confirm Actions: Test green, Deploy Success
5. On the instance: `git -C /home/ubuntu/bot rev-parse HEAD` matches `main`

## Acceptance

1. PR: Actions runs Test; Deploy is skipped.
2. Push to `main` with `AWS_ROLE_ARN` set: Test then Deploy; SSM Success; `dbz-bot` active; instance SHA matches `main`.
3. A new/changed slash command in that merge appears in Discord without a manual `deploy-commands` on the box.
4. Failing tests on a PR or `main` do not restart the service.
