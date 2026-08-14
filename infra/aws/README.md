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

## Update the bot later

On the instance:

```bash
sudo dbz-bot-update
```

After changing secrets in `terraform.tfvars`, run `tofu apply` (updates SSM), then on the host:

```bash
sudo dbz-bot-refresh-env
sudo systemctl restart dbz-bot
```

## Destroy

```bash
tofu destroy
```

## Notes

- Keep `terraform.tfvars` and `*.tfstate` out of git (see `.gitignore`).
- Sensitive values live in SSM **and** in Terraform state.
- Private GitHub repo: put a fine-scoped PAT in `repo_url` (`https://TOKEN@github.com/...`).
