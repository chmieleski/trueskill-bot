# SSM Parameter Store keys under /{project}/{env}/ENV_VAR_NAME.
# Secrets: SecureString. Non-secrets: String.
# Empty optional strings use sentinel __EMPTY__ (SSM disallows blank values);
# deploy/aws/refresh-env.sh maps __EMPTY__ → "".

locals {
  # Sentinel for optional empty env values (SSM Parameter Store rejects "").
  ssm_empty = "__EMPTY__"
}

resource "aws_ssm_parameter" "discord_token" {
  name        = "${local.ssm_prefix}/DISCORD_TOKEN"
  description = "Discord bot token"
  type        = "SecureString"
  value       = var.discord_token
  tags        = local.common_tags
}

resource "aws_ssm_parameter" "client_id" {
  name        = "${local.ssm_prefix}/CLIENT_ID"
  description = "Discord application client ID"
  type        = "String"
  value       = var.client_id
  tags        = local.common_tags
}

resource "aws_ssm_parameter" "guild_id" {
  name        = "${local.ssm_prefix}/GUILD_ID"
  description = "Discord guild ID for command deploy"
  type        = "String"
  value       = var.guild_id
  tags        = local.common_tags
}

resource "aws_ssm_parameter" "database_url" {
  name        = "${local.ssm_prefix}/DATABASE_URL"
  description = "Supabase pooled DATABASE_URL"
  type        = "SecureString"
  value       = var.database_url
  tags        = local.common_tags
}

resource "aws_ssm_parameter" "direct_url" {
  name        = "${local.ssm_prefix}/DIRECT_URL"
  description = "Supabase DIRECT_URL"
  type        = "SecureString"
  value       = var.direct_url
  tags        = local.common_tags
}

resource "aws_ssm_parameter" "gemini_api_key" {
  name        = "${local.ssm_prefix}/GEMINI_API_KEY"
  description = "Google Gemini API key"
  type        = "SecureString"
  value       = var.gemini_api_key
  tags        = local.common_tags
}

resource "aws_ssm_parameter" "log_level" {
  name        = "${local.ssm_prefix}/LOG_LEVEL"
  description = "Application LOG_LEVEL"
  type        = "String"
  value       = var.log_level
  tags        = local.common_tags
}

resource "aws_ssm_parameter" "match_create_role_id" {
  name        = "${local.ssm_prefix}/MATCH_CREATE_ROLE_ID"
  description = "Fallback Discord role required to create lobbies"
  type        = "String"
  value       = var.match_create_role_id == "" ? local.ssm_empty : var.match_create_role_id
  tags        = local.common_tags
}

resource "aws_ssm_parameter" "match_mod_role_id" {
  name        = "${local.ssm_prefix}/MATCH_MOD_ROLE_ID"
  description = "Fallback Discord role allowed to report/cancel like the host"
  type        = "String"
  value       = var.match_mod_role_id == "" ? local.ssm_empty : var.match_mod_role_id
  tags        = local.common_tags
}

resource "aws_ssm_parameter" "wc3stats_timeout_ms" {
  name        = "${local.ssm_prefix}/WC3STATS_TIMEOUT_MS"
  description = "wc3stats HTTP timeout in milliseconds"
  type        = "String"
  value       = var.wc3stats_timeout_ms
  tags        = local.common_tags
}
