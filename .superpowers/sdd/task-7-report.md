# Task 7: Remove process env + AWS SSM keys — report

**Status:** DONE

## Summary

Removed process-wide `WC3STATS_ENABLED`, `WC3STATS_MAP_PATTERN`, and `WC3STATS_MAP_SHA1` from runtime env parsing, local env examples/docs, AWS host env writing, and Terraform SSM wiring. Kept `WC3STATS_TIMEOUT_MS` in every place it already existed.

## Files changed

- `src/config/env.ts`
- `.env.example`
- `.cursor/rules/scripts-and-env.mdc`
- `deploy/aws/refresh-env.sh`
- `infra/aws/variables.tf`
- `infra/aws/ssm.tf`
- `infra/aws/main.tf`
- `infra/aws/terraform.tfvars.example`
- `src/services/guild/guild-config.ts`
- `src/services/guild/guild-config.test.ts`
- `src/services/wc3stats/index.ts`
- `src/services/wc3stats/wc3stats-map.ts`
- `src/services/wc3stats/wc3stats-map.test.ts`
- `src/services/wc3stats/wc3stats-slot-map.ts`
- `src/services/wc3stats/wc3stats-slot-map.test.ts`

`infra/aws/README.md` did not document the removed keys, so no README edit was needed.

## Verification

- `rg 'env\.wc3stats(Enabled|MapPattern|MapSha1)|WC3STATS_ENABLED|WC3STATS_MAP_' src/` — no matches
- Scoped config/infra grep for removed env and Terraform names — no matches
- IDE diagnostics for edited TypeScript files — no linter errors
- `npx vitest run` — 28 files passed, 196 tests passed
- `npm run build` — Prisma generate and `tsc` completed successfully

## Self-review

Diff is scoped to deleting process-wide wc3stats env/SSM configuration and updating docs to point at the guild preset command. Local UDBR map constants were renamed from `UDBR_WC3STATS_MAP_*` to `UDBR_MAP_*` only because the task's required source grep forbids `WC3STATS_MAP_` anywhere in `src/`; values and preset behavior are unchanged.

## Ops note

After Terraform apply, the removed SSM parameters may need manual cleanup if Terraform state no longer manages them. If still in state, `tofu apply` should destroy the removed `aws_ssm_parameter` resources.

