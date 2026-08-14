# AWS Free Tier deploy (EC2 + OpenTofu/Terraform)

**Status:** Implemented under `infra/aws/` + `deploy/aws/`

## Goal

Automate hosting the Discord bot on **AWS Free Tier** with repeatable infra: one long-running Node process, DB stays on **Supabase**.

## Approach

**OpenTofu / Terraform** (HCL compatible with both) under `infra/aws/`:

| Resource | Choice | Why |
|----------|--------|-----|
| Compute | `t3.micro` (or `t2.micro`) Ubuntu 24.04 | Free Tier eligible, enough for this bot |
| Network | Default VPC + security group | Minimal cost/complexity |
| Inbound | None by default (Session Manager); optional SSH | Dynamic home IPs don't need a fixed CIDR |
| Outbound | All | Discord, Supabase, Gemini |
| Public IP | Elastic IP | Stable SSH / ops after stop-start |
| Secrets | SSM Parameter Store `SecureString` | Free-tier friendly; not baked into AMI |
| Boot | `user-data` cloud-init | Node 22, clone, `.env` from SSM, migrate, build, systemd |
| Process | systemd unit `dbz-bot.service` | Restart on crash/reboot |

Out of scope: RDS, ALB, ECS/Fargate, multi-region.

CI/CD (test on PR, SSM deploy on `main`): [2026-08-14-github-actions-cicd-design.md](./2026-08-14-github-actions-cicd-design.md)

## Secrets

Terraform creates (or updates) SSM parameters under a prefix (e.g. `/dbz-bot/prod/...`). EC2 instance profile may `ssm:GetParameters` + `kms:Decrypt` for those paths. `user-data` writes `/home/ubuntu/bot/.env` with mode `600`, then starts the service.

Sensitive values also exist in Terraform state — use remote state with encryption later; for solo Free Tier, local state + never commit `*.tfvars` / `terraform.tfstate`.

## App layout on the instance

```
/home/ubuntu/bot/          # git clone
/home/ubuntu/bot/.env      # from SSM
/etc/systemd/system/dbz-bot.service
```

Production: `NODE_ENV=production`, `AUTO_DEPLOY_COMMANDS=false`. Slash commands: run `npm run deploy-commands` from the instance (or a one-shot in user-data when `deploy_commands_on_boot=true`).

## Operator flow

1. Configure AWS credentials (`aws configure` or env).
2. Copy `terraform.tfvars.example` → `terraform.tfvars` (gitignored).
3. `tofu init && tofu apply` (or `terraform`).
4. SSH with the key; `journalctl -u dbz-bot -f`.
5. Updates: push to `main` (GitHub Actions) or `sudo dbz-bot-update` on the instance.

## Non-goals

- Replacing Supabase with AWS RDS
- Serverless (Lambda) Discord gateway
