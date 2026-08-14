variable "aws_region" {
  description = "AWS region for Free Tier resources"
  type        = string
  default     = "us-east-1"
}

variable "project_name" {
  description = "Name prefix for tags and resources"
  type        = string
  default     = "dbz-bot"
}

variable "environment" {
  description = "Environment segment for SSM paths and tags"
  type        = string
  default     = "prod"
}

variable "instance_type" {
  description = "EC2 type (Free Tier: t3.micro or t2.micro)"
  type        = string
  default     = "t3.micro"
}

variable "enable_ssh" {
  description = "Open TCP/22. Prefer false with dynamic ISP IPs — use Session Manager instead."
  type        = bool
  default     = false
}

variable "ssh_cidr" {
  description = "CIDR allowed to SSH when enable_ssh=true (e.g. YOUR_IP/32). Ignored when SSH is disabled."
  type        = string
  default     = null
  nullable    = true
}

variable "ssh_public_key" {
  description = "SSH public key (creates an EC2 key pair). Optional if enable_ssh=false (Session Manager only)."
  type        = string
  default     = null
  nullable    = true
}

variable "key_pair_name" {
  description = "Name for the AWS key pair resource (only used when ssh_public_key is set)"
  type        = string
  default     = "dbz-bot"
}

check "ssh_requires_cidr_and_key" {
  assert {
    condition = !var.enable_ssh || (
      try(length(var.ssh_cidr) > 0, false) && try(length(var.ssh_public_key) > 0, false)
    )
    error_message = "When enable_ssh=true you must set ssh_cidr (e.g. x.x.x.x/32) and ssh_public_key."
  }
}

variable "repo_url" {
  description = "Git clone URL (HTTPS). For private repos, include a PAT in the URL or use a deploy key later."
  type        = string
}

variable "repo_branch" {
  description = "Git branch to check out"
  type        = string
  default     = "main"
}

variable "app_dir" {
  description = "Absolute path on the instance where the bot is cloned"
  type        = string
  default     = "/home/ubuntu/bot"
}

variable "deploy_commands_on_boot" {
  description = "Run npm run deploy-commands once during first boot"
  type        = bool
  default     = true
}

variable "allocate_eip" {
  description = "Attach an Elastic IP (stable address; free while associated to a running instance)"
  type        = bool
  default     = true
}

# --- Bot secrets (stored in SSM SecureString; also in Terraform state) ---

variable "discord_token" {
  type      = string
  sensitive = true
}

variable "client_id" {
  type = string
}

variable "guild_id" {
  type = string
}

variable "database_url" {
  type      = string
  sensitive = true
}

variable "direct_url" {
  type      = string
  sensitive = true
}

variable "gemini_api_key" {
  type      = string
  sensitive = true
}

variable "match_create_role_id" {
  type    = string
  default = ""
}

variable "match_mod_role_id" {
  type    = string
  default = ""
}

variable "log_level" {
  type    = string
  default = "info"
}
