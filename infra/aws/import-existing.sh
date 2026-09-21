#!/usr/bin/env bash
# Import the live punch-machine-prod AWS stack into local OpenTofu state.
# Run from infra/aws on a branch that has the full config (obs SSM included).
#
# Prerequisites (fish example):
#   aws login
#   set -gx AWS_DEFAULT_REGION eu-central-1
#   eval (aws configure export-credentials --format env-no-export | while read -l line
#       set -l kv (string split -m 1 = -- $line)
#       set -gx $kv[1] $kv[2]
#   end)
#   cd /home/leski/www/bot/.worktrees/feat-observability-discord-http/infra/aws
#   bash ./import-existing.sh
#
# After imports succeed:
#   tofu plan   # should be nearly empty (user_data / tags churn is normal)
#   tofu apply  # only if plan looks intentional
set -euo pipefail

export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-eu-central-1}"
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
REGION="$AWS_DEFAULT_REGION"
PREFIX="/punch-machine/prod"
NAME_PREFIX="punch-machine-prod"

echo "==> Account=$ACCOUNT_ID region=$REGION"

import_one() {
  local addr="$1"
  local id="$2"
  if tofu state list 2>/dev/null | grep -qxF "$addr"; then
    echo "skip (already in state): $addr"
    return 0
  fi
  echo "import $addr <- $id"
  tofu import -input=false "$addr" "$id"
}

# Discover live IDs
INSTANCE_ID="$(aws ec2 describe-instances \
  --filters "Name=tag:Name,Values=${NAME_PREFIX}" "Name=instance-state-name,Values=running,stopped" \
  --query 'Reservations[0].Instances[0].InstanceId' --output text)"
if [[ -z "$INSTANCE_ID" || "$INSTANCE_ID" == "None" ]]; then
  echo "ERROR: could not find instance tagged Name=${NAME_PREFIX}" >&2
  exit 1
fi

SG_ID="$(aws ec2 describe-security-groups \
  --filters "Name=group-name,Values=${NAME_PREFIX}-sg" \
  --query 'SecurityGroups[0].GroupId' --output text)"

# Prefer EIP currently associated with the instance
EIP_ALLOC="$(aws ec2 describe-addresses \
  --filters "Name=instance-id,Values=${INSTANCE_ID}" \
  --query 'Addresses[0].AllocationId' --output text)"
if [[ -z "$EIP_ALLOC" || "$EIP_ALLOC" == "None" ]]; then
  EIP_ALLOC="$(aws ec2 describe-addresses \
    --filters "Name=tag:Name,Values=${NAME_PREFIX}-eip" \
    --query 'Addresses[0].AllocationId' --output text)"
fi

ASSOC_ID="$(aws ec2 describe-addresses \
  --allocation-ids "$EIP_ALLOC" \
  --query 'Addresses[0].AssociationId' --output text)"

OIDC_ARN="arn:aws:iam::${ACCOUNT_ID}:oidc-provider/token.actions.githubusercontent.com"
ROLE_BOT="${NAME_PREFIX}-ec2"
ROLE_GHA="${NAME_PREFIX}-gha"
PROFILE="${NAME_PREFIX}-ec2"

# Inline policy IDs for import: ROLE_NAME:POLICY_NAME
POLICY_BOT_SSM="${ROLE_BOT}:${NAME_PREFIX}-ssm-read"
POLICY_GHA_DEPLOY="${ROLE_GHA}:${NAME_PREFIX}-gha-deploy"
ATTACH_SSM_CORE="${ROLE_BOT}/arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"

echo "==> INSTANCE_ID=$INSTANCE_ID"
echo "==> SG_ID=$SG_ID"
echo "==> EIP_ALLOC=$EIP_ALLOC ASSOC_ID=$ASSOC_ID"

tofu init -input=false >/dev/null

# IAM / OIDC
import_one aws_iam_openid_connect_provider.github "$OIDC_ARN"
import_one aws_iam_role.bot "$ROLE_BOT"
import_one aws_iam_role_policy.bot_ssm "$POLICY_BOT_SSM"
import_one aws_iam_role_policy_attachment.bot_ssm_core "$ATTACH_SSM_CORE"
import_one aws_iam_instance_profile.bot "$PROFILE"
import_one aws_iam_role.gha "$ROLE_GHA"
import_one aws_iam_role_policy.gha_deploy "$POLICY_GHA_DEPLOY"

# Network / compute
import_one aws_security_group.bot "$SG_ID"
import_one aws_instance.bot "$INSTANCE_ID"
import_one 'aws_eip.bot[0]' "$EIP_ALLOC"
if [[ -n "$ASSOC_ID" && "$ASSOC_ID" != "None" ]]; then
  import_one 'aws_eip_association.bot[0]' "$ASSOC_ID"
fi

# SSM — all known keys
for pair in \
  "aws_ssm_parameter.discord_token:DISCORD_TOKEN" \
  "aws_ssm_parameter.client_id:CLIENT_ID" \
  "aws_ssm_parameter.guild_id:GUILD_ID" \
  "aws_ssm_parameter.database_url:DATABASE_URL" \
  "aws_ssm_parameter.direct_url:DIRECT_URL" \
  "aws_ssm_parameter.gemini_api_key:GEMINI_API_KEY" \
  "aws_ssm_parameter.log_level:LOG_LEVEL" \
  "aws_ssm_parameter.match_create_role_id:MATCH_CREATE_ROLE_ID" \
  "aws_ssm_parameter.match_mod_role_id:MATCH_MOD_ROLE_ID" \
  "aws_ssm_parameter.wc3stats_timeout_ms:WC3STATS_TIMEOUT_MS" \
  "aws_ssm_parameter.api_enabled:API_ENABLED" \
  "aws_ssm_parameter.api_port:API_PORT" \
  "aws_ssm_parameter.api_bind:API_BIND" \
  "aws_ssm_parameter.obs_enabled:OBS_ENABLED" \
  "aws_ssm_parameter.obs_bind:OBS_BIND" \
  "aws_ssm_parameter.obs_port:OBS_PORT" \
  "aws_ssm_parameter.obs_token:OBS_TOKEN" \
  "aws_ssm_parameter.ops_alert_channel_id:OPS_ALERT_CHANNEL_ID" \
  "aws_ssm_parameter.obs_rss_mb_warn:OBS_RSS_MB_WARN" \
  "aws_ssm_parameter.obs_event_loop_ms_warn:OBS_EVENT_LOOP_MS_WARN" \
  "aws_ssm_parameter.obs_sample_interval_ms:OBS_SAMPLE_INTERVAL_MS"
do
  addr="${pair%%:*}"
  key="${pair##*:}"
  import_one "$addr" "${PREFIX}/${key}"
done

echo
echo "==> Import finished. Next:"
echo "    tofu plan"
echo "Inspect carefully before tofu apply (user_data churn is common)."
