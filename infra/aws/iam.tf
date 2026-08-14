data "aws_caller_identity" "current" {}

data "aws_iam_policy_document" "ec2_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "bot" {
  name               = "${local.name_prefix}-ec2"
  assume_role_policy = data.aws_iam_policy_document.ec2_assume.json
  tags               = local.common_tags
}

data "aws_iam_policy_document" "bot_ssm" {
  statement {
    sid = "ReadBotParameters"
    actions = [
      "ssm:GetParameter",
      "ssm:GetParameters",
      "ssm:GetParametersByPath",
    ]
    # GetParametersByPath authorizes the path ARN itself (/prod), not only /prod/*.
    resources = [
      "arn:aws:ssm:${var.aws_region}:${data.aws_caller_identity.current.account_id}:parameter${local.ssm_prefix}",
      "arn:aws:ssm:${var.aws_region}:${data.aws_caller_identity.current.account_id}:parameter${local.ssm_prefix}/*",
    ]
  }

  statement {
    sid       = "DecryptSecureStrings"
    actions   = ["kms:Decrypt"]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["ssm.${var.aws_region}.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "bot_ssm" {
  name   = "${local.name_prefix}-ssm-read"
  role   = aws_iam_role.bot.id
  policy = data.aws_iam_policy_document.bot_ssm.json
}

# Session Manager shell without inbound SSH (works with dynamic home IPs)
resource "aws_iam_role_policy_attachment" "bot_ssm_core" {
  role       = aws_iam_role.bot.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_instance_profile" "bot" {
  name = "${local.name_prefix}-ec2"
  role = aws_iam_role.bot.name
}
