locals {
  name_prefix = "${var.project_name}-${var.environment}"
  ssm_prefix  = "/${var.project_name}/${var.environment}"

  common_tags = {
    Project     = var.project_name
    Environment = var.environment
    ManagedBy   = "terraform"
  }
}

data "aws_ssm_parameter" "ubuntu_ami" {
  name = "/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id"
}

data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
}

resource "aws_key_pair" "bot" {
  key_name   = var.key_pair_name
  public_key = var.ssh_public_key

  tags = local.common_tags
}

resource "aws_security_group" "bot" {
  name        = "${local.name_prefix}-sg"
  description = "SSH in; all egress for Discord / Supabase / Gemini"
  vpc_id      = data.aws_vpc.default.id

  ingress {
    description = "SSH"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = [var.ssh_cidr]
  }

  egress {
    description = "All egress"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(local.common_tags, {
    Name = "${local.name_prefix}-sg"
  })
}

resource "aws_instance" "bot" {
  ami                    = data.aws_ssm_parameter.ubuntu_ami.value
  instance_type          = var.instance_type
  key_name               = aws_key_pair.bot.key_name
  subnet_id              = data.aws_subnets.default.ids[0]
  vpc_security_group_ids = [aws_security_group.bot.id]
  iam_instance_profile   = aws_iam_instance_profile.bot.name

  user_data = templatefile("${path.module}/user-data.sh.tftpl", {
    app_dir                 = var.app_dir
    repo_url                = var.repo_url
    repo_branch             = var.repo_branch
    ssm_prefix              = local.ssm_prefix
    aws_region              = var.aws_region
    deploy_commands_on_boot = var.deploy_commands_on_boot
    log_level               = var.log_level
    match_create_role_id    = var.match_create_role_id
    match_mod_role_id       = var.match_mod_role_id
  })

  root_block_device {
    volume_size = 20
    volume_type = "gp3"
    encrypted   = true
  }

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  tags = merge(local.common_tags, {
    Name = local.name_prefix
  })

  depends_on = [
    aws_ssm_parameter.discord_token,
    aws_ssm_parameter.database_url,
    aws_ssm_parameter.direct_url,
    aws_ssm_parameter.gemini_api_key,
    aws_ssm_parameter.client_id,
    aws_ssm_parameter.guild_id,
  ]
}

resource "aws_eip" "bot" {
  count  = var.allocate_eip ? 1 : 0
  domain = "vpc"

  tags = merge(local.common_tags, {
    Name = "${local.name_prefix}-eip"
  })
}

resource "aws_eip_association" "bot" {
  count         = var.allocate_eip ? 1 : 0
  instance_id   = aws_instance.bot.id
  allocation_id = aws_eip.bot[0].id
}
