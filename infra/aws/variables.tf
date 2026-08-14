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
  description = "Fallback MATCH_CREATE_ROLE_ID (empty = creation disabled until /config set)"
  type        = string
  default     = ""
}

variable "match_mod_role_id" {
  description = "Fallback MATCH_MOD_ROLE_ID (empty = host-only manage until /config set)"
  type        = string
  default     = ""
}

variable "log_level" {
  description = "LOG_LEVEL written to production .env"
  type        = string
  default     = "info"
}

# --- Non-secret bot config (SSM String; refreshed onto the host .env) ---

variable "wc3stats_enabled" {
  description = "WC3STATS_ENABLED — true to import live UDBR lobbies from wc3stats"
  type        = string
  default     = "false"
}

variable "wc3stats_map_pattern" {
  description = "WC3STATS_MAP_PATTERN regex vs map filename / path / normalizedName"
  type        = string
  default     = "ultimate.?dragon.?ball.?reborn|udbr"
}

variable "wc3stats_map_sha1" {
  description = "WC3STATS_MAP_SHA1 comma-separated map.sha1 allowlist (not list hash). UDBR 2.4f default."
  type        = string
  default     = "19783c6259e86253a8c940ede63a87e18204bd94"
}

variable "wc3stats_timeout_ms" {
  description = "WC3STATS_TIMEOUT_MS HTTP timeout for wc3stats API"
  type        = string
  default     = "4000"
}

variable "github_repository" {
  description = "GitHub org/repo allowed to assume the Actions deploy role (OIDC sub on main only)"
  type        = string
  default     = "chmieleski/trueskill-bot"
}
