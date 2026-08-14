# AWS Free Tier — OpenTofu / Terraform

Provisions an Ubuntu 24.04 `t3.micro` EC2 host, Elastic IP, SSM secrets, IAM instance profile, and cloud-init that installs Node 22, clones this repo, builds the bot, and enables `dbz-bot.service`.

Database stays on **Supabase**. Compatible with **OpenTofu** (`tofu`) and **Terraform** (`terraform`).

## Prerequisites

1. AWS account on Free Tier (or willing to pay on-demand micro rates after 12 months).
2. IAM user/role that can manage EC2, EIP, IAM roles, and SSM parameters.
3. AWS CLI configured (`aws configure`) for the target account/region.
4. OpenTofu ≥ 1.6 or Terraform ≥ 1.6.
5. An SSH key pair on your machine (`ssh-keygen -t ed25519`).

## Apply

```bash
cd infra/aws
cp terraform.tfvars.example terraform.tfvars
# edit terraform.tfvars — set ssh_cidr to YOUR_IP/32, secrets, repo_url

tofu init    # or: terraform init
tofu plan
tofu apply
```

Outputs include `public_ip` and `ssh_command`.

First boot takes several minutes (apt, Node, `npm ci`, migrate, build). Watch:

```bash
ssh -i ~/.ssh/your_key ubuntu@<public_ip>
sudo tail -f /var/log/dbz-bot-bootstrap.log
sudo journalctl -u dbz-bot -f
```

## Update the bot later

On the instance:

```bash
sudo dbz-bot-update
# or: sudo /path/to/repo/deploy/aws/update-bot.sh
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
- Restrict `ssh_cidr` to your IP; do not use `0.0.0.0/0` unless you accept the risk.
