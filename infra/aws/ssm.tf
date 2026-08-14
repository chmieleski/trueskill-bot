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
