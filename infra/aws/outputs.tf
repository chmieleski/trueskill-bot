output "instance_id" {
  value = aws_instance.bot.id
}

output "public_ip" {
  description = "Public IP (Elastic IP when allocate_eip=true)"
  value       = var.allocate_eip ? aws_eip.bot[0].public_ip : aws_instance.bot.public_ip
}

output "ssh_command" {
  description = "Only useful when enable_ssh=true and a key pair was created"
  value = var.enable_ssh && length(aws_key_pair.bot) > 0 ? (
    "ssh -i <your-private-key> ubuntu@${var.allocate_eip ? aws_eip.bot[0].public_ip : aws_instance.bot.public_ip}"
  ) : "SSH disabled — use session_manager_command"
}

output "session_manager_command" {
  description = "Shell without inbound SSH (works with dynamic home ISP IPs)"
  value       = "aws ssm start-session --target ${aws_instance.bot.id} --region ${var.aws_region}"
}

output "ssm_prefix" {
  value = local.ssm_prefix
}

output "journal_follow" {
  value = "sudo journalctl -u dbz-bot -f"
}

output "github_actions_role_arn" {
  description = "IAM role ARN for GitHub Actions OIDC (set as repo secret AWS_ROLE_ARN)"
  value       = aws_iam_role.gha.arn
}

output "release_bucket_name" {
  description = "S3 bucket for bot release tarballs (set GitHub Actions var RELEASE_BUCKET)"
  value       = aws_s3_bucket.release.bucket
}

output "rds_endpoint" {
  description = "RDS PostgreSQL endpoint (host:port)"
  value       = length(aws_db_instance.db) > 0 ? aws_db_instance.db[0].endpoint : null
}

output "rds_address" {
  description = "RDS PostgreSQL hostname"
  value       = length(aws_db_instance.db) > 0 ? aws_db_instance.db[0].address : null
}

output "rds_port" {
  description = "RDS PostgreSQL port"
  value       = length(aws_db_instance.db) > 0 ? aws_db_instance.db[0].port : null
}

output "rds_database_name" {
  description = "RDS PostgreSQL database name"
  value       = length(aws_db_instance.db) > 0 ? aws_db_instance.db[0].db_name : null
}

output "rds_username" {
  description = "RDS PostgreSQL master username"
  value       = length(aws_db_instance.db) > 0 ? aws_db_instance.db[0].username : null
}

output "rds_database_url" {
  description = "Full PostgreSQL connection URL for RDS"
  value       = local.rds_database_url
  sensitive   = true
}

output "rds_ssm_port_forward_command" {
  description = "Command to forward RDS port 5432 to local machine port 54332 via SSM tunnel"
  value       = length(aws_db_instance.db) > 0 ? "aws ssm start-session --target ${aws_instance.bot.id} --document-name AWS-StartPortForwardingSessionToRemoteHost --parameters host=\"${aws_db_instance.db[0].address}\",portNumber=\"5432\",localPortNumber=\"54332\" --region ${var.aws_region}" : null
}
