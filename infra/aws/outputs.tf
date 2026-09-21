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
