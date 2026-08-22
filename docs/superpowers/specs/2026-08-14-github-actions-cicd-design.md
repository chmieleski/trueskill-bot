# GitHub Actions CI/CD (test on PR, deploy on `main`)

**Date:** 2026-08-14  
**Status:** Approved for implementation planning  
**Extends:** `docs/superpowers/specs/2026-08-14-aws-free-tier-deploy-design.md` (CI/CD was previously a non-goal)

## Goal

Every **push or merge to `main`** runs unit tests, then updates the existing AWS Free Tier EC2 host (git pull, migrate, build, register slash commands, restart). Pull requests run the same tests and **do not** deploy.

## Non-goals

- Applying OpenTofu/Terraform from CI
- Storing Discord, Supabase, or Gemini secrets in GitHub
- Opening SSH or inbound HTTP on the instance
- GitHub Environments / required reviewers / deploy windows
- Multi-environment (staging) pipelines
- Replacing Supabase or changing how `.env` is written (`dbz-bot-refresh-env` stays)

## Decisions (locked)

| Topic                         | Choice                                                                                                                                                                             |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Trigger                       | `pull_request` → tests only; `push` to `main` → tests then deploy                                                                                                                  |
| CI runner                     | GitHub-hosted `ubuntu-latest`, Node **22** (matches EC2)                                                                                                                           |
| Test command                  | `npm ci` then `npm test` (Vitest). No `DATABASE_URL` — Prisma is mocked in tests                                                                                                   |
| Deploy mechanism              | AWS SSM `SendCommand` (`AWS-RunShellScript`) to the tagged EC2 instance                                                                                                            |
| AWS auth                      | GitHub Actions **OIDC** → IAM role. No long-lived access keys                                                                                                                      |
| IAM trust                     | Only `repo:chmieleski/trueskill-bot:ref:refs/heads/main`                                                                                                                           |
| Instance lookup               | SSM target `tag:Name` = `${project_name}-${environment}` (default `dbz-bot-prod`)                                                                                                  |
| Update script source of truth | `deploy/aws/host-update.sh` in git (not the cloud-init-baked copy)                                                                                                                 |
| Slash commands                | `npm run deploy-commands` runs on every successful host update                                                                                                                     |
| Restart                       | Stop only after stage `npm ci` / build / `deploy-commands` succeed; then migrate, swap `bot.next` into `/home/ubuntu/bot`, start. See `2026-08-22-zero-downtime-deploy-design.md`. |
| Concurrency                   | Deploy group `deploy-prod`; in-progress deploys are **not** cancelled                                                                                                              |
| SSM timeout                   | 600 seconds                                                                                                                                                                        |
| Infra apply                   | Operator runs `tofu apply` locally once to create the OIDC role                                                                                                                    |

## Architecture

```text
PR opened/updated
  → GitHub Actions: npm ci + npm test
  → stop (no AWS)

push / merge to main
  → GitHub Actions: npm ci + npm test
  → if pass: assume IAM role via OIDC
  → SSM SendCommand on EC2 (tag Name=dbz-bot-prod)
       1. git fetch/checkout/pull --ff-only origin main (as ubuntu)
       2. sudo bash deploy/aws/host-update.sh
  → wait for invocation; fail the job if the command fails
```

GitHub never receives bot secrets. The instance already reads SSM Parameter Store.

### Why SSM, not SSH

The security group has no inbound ports by default. Session Manager is already enabled (`AmazonSSMManagedInstanceCore`). SendCommand uses the same path.

### Why the update script lives in git

`/usr/local/bin/dbz-bot-update` is written once at first boot. Changing the procedure would leave an existing instance on the old script until recreate. The repo script is pulled **before** it runs, so the first successful CD after this lands already uses the new steps (including `deploy-commands`).

## Components

### 1. `deploy/aws/host-update.sh`

Must be run as **root**. Responsibilities, in order, `set -euo pipefail`:

1. `cd` to app dir (`/home/ubuntu/bot` unless overridden).
2. As `ubuntu`: `git fetch --all`, `git checkout "$BRANCH"`, `git pull --ff-only origin "$BRANCH"` (`BRANCH` default `main`).
3. `/usr/local/bin/dbz-bot-refresh-env`
4. As `ubuntu`: `npm ci && npx prisma migrate deploy && npm run build && npm run deploy-commands`
5. `systemctl restart dbz-bot`
6. `systemctl --no-pager --full status dbz-bot` (informational; restart already happened)

If any step before restart fails, systemd keeps serving the previous `dist/` (migrate may already have applied — same risk as today’s manual updater; no automatic rollback).

As of the zero-downtime deploy, the live unit is not stopped until after stage `npm ci` / build / `deploy-commands`; see `2026-08-22-zero-downtime-deploy-design.md` for the stop → migrate → swap → start sequence (this numbered list is the pre-cut-over shape).

`deploy/aws/update-bot.sh` becomes a thin local helper that execs `host-update.sh` (path relative to repo root).

Cloud-init `/usr/local/bin/dbz-bot-update` becomes:

```bash
exec bash /home/ubuntu/bot/deploy/aws/host-update.sh
```

Existing instances keep the **old** baked binary until recreate. That is acceptable: GitHub Actions does **not** call that binary; it always `git pull` then runs `host-update.sh` from the tree.

### 2. `.github/workflows/ci-cd.yml`

Single workflow:

- `on.pull_request` (all branches) and `on.push.branches: [main]`
- Job `test`: checkout, setup-node 22 with npm cache, `npm ci`, `npm test`
- Job `deploy`: `needs: test`, `if: github.event_name == 'push' && github.ref == 'refs/heads/main'`
  - `permissions: id-token: write`, `contents: read`
  - `configure-aws-credentials` with `role-to-assume: ${{ secrets.AWS_ROLE_ARN }}`, region `us-east-1` (or `vars.AWS_REGION` if set, default `us-east-1`)
  - `aws ssm send-command` with targets `Key=tag:Name,Values=dbz-bot-prod` (or `vars.EC2_NAME_TAG`, default `dbz-bot-prod`)
  - Commands:
    1. `sudo -u ubuntu git -C /home/ubuntu/bot fetch --all`
    2. `sudo -u ubuntu git -C /home/ubuntu/bot checkout main`
    3. `sudo -u ubuntu git -C /home/ubuntu/bot pull --ff-only origin main`
    4. `sudo bash /home/ubuntu/bot/deploy/aws/host-update.sh`
  - Poll `ssm get-command-invocation` until Success/Failed/TimedOut/Cancelled; non-Success fails the job
  - Print stdout/stderr of the invocation on failure

`concurrency` on the deploy job: `group: deploy-prod`, `cancel-in-progress: false`.

### 3. Terraform — GitHub OIDC (`infra/aws/github-oidc.tf`)

Create:

- `aws_iam_openid_connect_provider.github` for `https://token.actions.githubusercontent.com`, audience `sts.amazonaws.com`, GitHub Actions thumbprints `6938fd4d98bab03faadb97b34396831e3780aea1` and `1c58a3a8518e8759bf075b76b750d4f2df264fcd`
- `aws_iam_role` named `${project_name}-${environment}-gha` (e.g. `dbz-bot-prod-gha`)
- Trust policy: `sts:AssumeRoleWithWebIdentity` from that OIDC provider, with
  - `token.actions.githubusercontent.com:aud` = `sts.amazonaws.com`
  - `token.actions.githubusercontent.com:sub` = `repo:${var.github_repository}:ref:refs/heads/main`
- Inline policy, least privilege, **two** `ssm:SendCommand` statements (tag condition cannot apply to the document ARN):
  1. `ssm:SendCommand` on `arn:aws:ssm:${region}::document/AWS-RunShellScript` (no tag condition)
  2. `ssm:SendCommand` on `arn:aws:ec2:${region}:${account}:instance/*` with `StringEquals` `ssm:resourceTag/Name` = `${project_name}-${environment}`
  3. `ssm:GetCommandInvocation` on `*`
  4. `ec2:DescribeInstances` on `*` (SSM target resolution by tag)

Variable `github_repository` type string, default `"chmieleski/trueskill-bot"`.

Output `github_actions_role_arn`.

No change to EC2 user-data **behavior** except the `dbz-bot-update` wrapper body described above (new instances only).

## GitHub configuration (operator, once)

After `tofu apply`:

1. Repo **Settings → Secrets and variables → Actions**
2. Secret `AWS_ROLE_ARN` = Terraform output `github_actions_role_arn`
3. Optional variable `AWS_REGION` (default in workflow: `us-east-1`)
4. Optional variable `EC2_NAME_TAG` (default: `dbz-bot-prod`)

Do **not** add `DISCORD_TOKEN`, `DATABASE_URL`, or `GEMINI_API_KEY`.

Until the secret exists, `test` on PRs still works; `deploy` on `main` fails at `configure-aws-credentials`. That is expected for the first merge if apply/secret lag behind.

## Error handling

| Failure                                             | Result                                                                                    |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Vitest fails                                        | `deploy` does not run; EC2 unchanged                                                      |
| OIDC / missing `AWS_ROLE_ARN`                       | Deploy job fails; EC2 unchanged                                                           |
| No instance with the Name tag                       | `send-command` fails; EC2 unchanged                                                       |
| `git pull --ff-only` rejects (diverged history)     | Job fails; no restart                                                                     |
| `npm ci` / build / migrate / `deploy-commands` fail | Job fails; no `systemctl restart`                                                         |
| SSM timeout (600s)                                  | Job fails; inspect instance logs (`journalctl -u dbz-bot`, command output)                |
| Overlapping pushes                                  | Second deploy waits; it pulls whatever `main` is at its start (may include later commits) |

## Docs to update

- `infra/aws/README.md` — CI/CD section: apply OIDC, set `AWS_ROLE_ARN`, what happens on push to `main`
- `docs/superpowers/specs/2026-08-14-aws-free-tier-deploy-design.md` — remove CI/CD from out-of-scope; point here

## Testing the design (implementation acceptance)

1. Open a PR that only touches tests or docs: Actions runs `test`, no deploy job (or deploy skipped).
2. Merge to `main` with `AWS_ROLE_ARN` set: Actions test green, SSM command Success, `systemctl status dbz-bot` active, new commit SHA on the instance (`git -C /home/ubuntu/bot rev-parse HEAD`).
3. Slash command added in the same merge appears in Discord without a manual `deploy-commands` on the box.
4. A failing test on `main` (or a PR) must not restart the service.
