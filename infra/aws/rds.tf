# PostgreSQL RDS Database configuration (optimized for lowest cost / Free Tier)
# Single-AZ db.t4g.micro with 20 GB gp3 storage in default VPC.

resource "random_password" "db_password" {
  count   = var.enable_rds && (var.db_password == null || var.db_password == "") ? 1 : 0
  length  = 24
  special = false
}

locals {
  db_master_password = (
    var.db_password != null && var.db_password != ""
    ? var.db_password
    : (length(random_password.db_password) > 0 ? random_password.db_password[0].result : "")
  )
}

resource "aws_db_subnet_group" "db" {
  count       = var.enable_rds ? 1 : 0
  name        = "${local.name_prefix}-db-subnets"
  description = "Database subnet group for ${local.name_prefix}"
  subnet_ids  = data.aws_subnets.default.ids

  tags = merge(local.common_tags, {
    Name = "${local.name_prefix}-db-subnets"
  })
}

resource "aws_security_group" "db" {
  count       = var.enable_rds ? 1 : 0
  name        = "${local.name_prefix}-db-sg"
  description = "Security group for ${local.name_prefix} RDS database"
  vpc_id      = data.aws_vpc.default.id

  # Allow inbound 5432 from bot EC2 instance security group
  ingress {
    description     = "PostgreSQL from bot EC2 instance"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.bot.id]
  }

  # Optional ingress for operator access (if db_allowed_cidr is specified)
  dynamic "ingress" {
    for_each = var.db_allowed_cidr != null && var.db_allowed_cidr != "" ? [1] : []
    content {
      description = "PostgreSQL from operator allowed CIDR"
      from_port   = 5432
      to_port     = 5432
      protocol    = "tcp"
      cidr_blocks = [var.db_allowed_cidr]
    }
  }

  egress {
    description = "Allow all outbound traffic"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(local.common_tags, {
    Name = "${local.name_prefix}-db-sg"
  })
}

resource "aws_db_instance" "db" {
  count                  = var.enable_rds ? 1 : 0
  identifier             = "${local.name_prefix}-db"
  engine                 = "postgres"
  engine_version         = var.db_engine_version
  instance_class         = var.db_instance_class
  allocated_storage      = var.db_allocated_storage
  max_allocated_storage  = var.db_max_allocated_storage
  storage_type           = "gp3"
  db_name                = var.db_name
  username               = var.db_username
  password               = local.db_master_password
  db_subnet_group_name   = aws_db_subnet_group.db[0].name
  vpc_security_group_ids = [aws_security_group.db[0].id]
  publicly_accessible    = var.db_publicly_accessible
  multi_az               = false

  backup_retention_period   = var.db_backup_retention_period
  skip_final_snapshot       = var.db_skip_final_snapshot
  final_snapshot_identifier = var.db_skip_final_snapshot ? null : "${local.name_prefix}-db-final-snapshot"
  deletion_protection       = var.db_deletion_protection

  auto_minor_version_upgrade = true
  copy_tags_to_snapshot      = true
  apply_immediately          = true

  tags = merge(local.common_tags, {
    Name = "${local.name_prefix}-db"
  })
}
