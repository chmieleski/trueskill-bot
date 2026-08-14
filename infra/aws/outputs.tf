output "instance_id" {
  value = aws_instance.bot.id
}

output "public_ip" {
  description = "SSH target (Elastic IP when allocate_eip=true)"
  value       = var.allocate_eip ? aws_eip.bot[0].public_ip : aws_instance.bot.public_ip
}

output "ssh_command" {
  value = "ssh -i <your-private-key.pem> ubuntu@${var.allocate_eip ? aws_eip.bot[0].public_ip : aws_instance.bot.public_ip}"
}

output "ssm_prefix" {
  value = local.ssm_prefix
}

output "journal_follow" {
  value = "sudo journalctl -u dbz-bot -f"
}
