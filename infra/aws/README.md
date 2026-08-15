# AWS Free Tier — OpenTofu / Terraform

Provisions an Ubuntu 24.04 `t3.micro` EC2 host, Elastic IP, SSM secrets, IAM instance profile, and cloud-init that installs Node 22, clones this repo, builds the bot, and enables `dbz-bot.service`.

Database stays on **Supabase**. Compatible with **OpenTofu** (`tofu`) and **Terraform** (`terraform`).

## Access without a fixed IP (recommended)

Default is **`enable_ssh = false`**. The security group has **no inbound ports**. You open a shell with **AWS Systems Manager Session Manager** (uses your AWS credentials, works from any network):

```bash
# once: AWS CLI + Session Manager plugin
# https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html

aws ssm start-session --target <instance_id> --region us-east-1
```

`tofu apply` prints `session_manager_command` with the instance id filled in.

Optional SSH (`enable_ssh = true`) only if you have a stable IP (`ssh_cidr = "x.x.x.x/32"`) plus `ssh_public_key`. Do **not** use `0.0.0.0/0` unless you accept the risk.

## Prerequisites

1. AWS account on Free Tier (or willing to pay on-demand micro rates after 12 months).
2. IAM user/role that can manage EC2, EIP, IAM roles, and SSM (including `ssm:StartSession`).
3. AWS CLI configured (`aws configure`) for the target account/region.
4. OpenTofu ≥ 1.6 or Terraform ≥ 1.6.
5. Session Manager plugin on your laptop (for shell access without SSH).

## Apply

```bash
cd infra/aws
cp terraform.tfvars.example terraform.tfvars
# edit terraform.tfvars — secrets, repo_url; leave enable_ssh=false if IP is dynamic

tofu init    # or: terraform init
tofu plan
tofu apply
```

## First boot / logs

```bash
aws ssm start-session --target <instance_id>
sudo tail -f /var/log/dbz-bot-bootstrap.log
sudo journalctl -u dbz-bot -f
```

First boot takes several minutes (apt, Node, `npm ci`, migrate, build).

`t3.micro` has ~1 GiB RAM. **First boot** (`user-data.sh.tftpl`) creates a **2 GiB** `/swapfile` before `npm ci`, then runs `deploy/aws/ensure-swap.sh` again after the repo clone. `host-update.sh` also ensures swap on every deploy. Persist the user-data change with `tofu apply` so a **new** instance launch includes it (updating user-data in place does not re-run cloud-init on the current box).

CI waits for SSM `Online` (or a send-command probe) and `/var/lib/dbz-bot/ready` before deploying (avoids racing first-boot).

## Update the bot later

Preferred: merge to `main` (see **CI/CD** below).

On the instance (break-glass):

```bash
sudo dbz-bot-update
```

After changing secrets **or non-secret config** in `terraform.tfvars`, run `tofu apply` (updates SSM), then on the host:

```bash
sudo dbz-bot-refresh-env   # or: sudo bash deploy/aws/host-update.sh
sudo systemctl restart dbz-bot
```

`deploy/aws/refresh-env.sh` pulls **all** parameters under the SSM prefix (plus fixed `NODE_ENV` / `AUTO_DEPLOY_COMMANDS`). New keys only need a Terraform SSM parameter + a line in that script (see `.cursor/rules/env-aws-sync.mdc`).

### Existing hosts (before re-create)

Cloud-init writes `/etc/dbz-bot/ssm.env`. If the instance was created before that file existed, create it once (values from `tofu output ssm_prefix` / your tfvars):

```bash
sudo mkdir -p /etc/dbz-bot
sudo tee /etc/dbz-bot/ssm.env <<'EOF'
export APP_DIR="/home/ubuntu/bot"
export SSM_PREFIX="/punch-machine/prod"
export AWS_DEFAULT_REGION="eu-central-1"
export AWS_REGION="eu-central-1"
export APP_USER="ubuntu"
EOF
# Adjust SSM_PREFIX / region to match your stack
sudo chmod 644 /etc/dbz-bot/ssm.env
sudo dbz-bot-refresh-env
sudo systemctl restart dbz-bot
```

Also replace the legacy helper so it calls the repo script:

```bash
sudo tee /usr/local/bin/dbz-bot-refresh-env <<'EOF'
#!/bin/bash
set -euo pipefail
source /etc/dbz-bot/ssm.env
exec bash "$APP_DIR/deploy/aws/refresh-env.sh"
EOF
sudo chmod 755 /usr/local/bin/dbz-bot-refresh-env
```

## CI/CD (push to `main`)

Pull requests run `npm test`. A push to `main` runs the same tests, then AWS SSM runs `deploy/aws/host-update.sh` on the EC2 host (pull, migrate, build, register slash commands, restart).

### One-time setup

1. Apply this stack so the GitHub OIDC role exists:

   ```bash
   cd infra/aws
   tofu apply
   ```

   **Note:** Only one GitHub OIDC provider (`token.actions.githubusercontent.com`) can exist per AWS account. If `tofu apply` fails with `EntityAlreadyExists`, import the existing provider instead of creating a second one:

   ```bash
   tofu import aws_iam_openid_connect_provider.github \
     arn:aws:iam::<account-id>:oidc-provider/token.actions.githubusercontent.com
   ```

2. Copy the `github_actions_role_arn` output.

3. In the GitHub repo: **Settings → Secrets and variables → Actions**
   - Secret `AWS_ROLE_ARN` = that ARN
   - Optional variable `AWS_REGION` (default in workflow: `eu-central-1`)
   - Optional variable `EC2_NAME_TAG` (default: `punch-machine-prod`)

Do **not** put `DISCORD_TOKEN`, `DATABASE_URL`, or `GEMINI_API_KEY` in GitHub. The instance already reads those from SSM.

Until `AWS_ROLE_ARN` is set, the Test job still runs; Deploy fails at OIDC.

### Manual update (unchanged)

```bash
sudo dbz-bot-update
```

New instances use the repo script via that wrapper. The existing host keeps the old baked wrapper until recreate; GitHub Actions does not call it — it `git pull`s and runs `deploy/aws/host-update.sh` directly.

### After guild wc3stats config release

wc3stats lobby import is **per Discord server** (`GuildConfig`), not process env. After merging/deploying that release:

1. **Deploy app + run migration** — CI `host-update.sh` runs migrate on push to `main`; break-glass: `sudo dbz-bot-update`.
2. **Enable import per guild** — in each server that needs wc3stats: `/config set wc3stats_map_preset preset:UDBR` (staff with Manage Guild). Default after deploy is **off** until this runs.
3. **Drop legacy SSM keys** — remove `wc3stats_enabled`, `wc3stats_map_pattern`, and `wc3stats_map_sha1` from `terraform.tfvars` (if still present), then `tofu apply` so the three parameters leave state/SSM. Keep `wc3stats_timeout_ms`.
4. **Refresh host env** — `sudo dbz-bot-refresh-env` (or the next deploy); `refresh-env.sh` no longer writes the removed keys. `WC3STATS_TIMEOUT_MS` stays.

**Deferred (Part 2):** fat map presets (team names, hero catalogs, extra presets beyond UDBR) are out of scope for this slice — see `docs/superpowers/specs/2026-08-15-guild-wc3stats-config-design.md` (**Deferred — Part 2**).

## Destroy

```bash
tofu destroy
```

## Notes

- Keep `terraform.tfvars` and `*.tfstate` out of git (see `.gitignore`).
- Sensitive values live in SSM **and** in Terraform state.
- Private GitHub repo: put a fine-scoped PAT in `repo_url` (`https://TOKEN@github.com/...`).
