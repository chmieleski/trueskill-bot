resource "aws_s3_bucket" "release" {
  bucket = "${local.name_prefix}-release"
  tags   = local.common_tags
}

resource "aws_s3_bucket_public_access_block" "release" {
  bucket = aws_s3_bucket.release.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "release" {
  bucket = aws_s3_bucket.release.id
  versioning_configuration {
    status = "Enabled"
  }
}
