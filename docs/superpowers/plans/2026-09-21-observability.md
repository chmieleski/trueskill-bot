# Process Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Discord ops alerts + always-on agent HTTP `/health` and `/status`, independent of the WOS API, with full AWS/tofu env sync.

**Architecture:** In-process metrics registry + health sampler + Discord alerter + dedicated obs HTTP listener under `src/services/observability/`. Guild ops channel via `GuildConfig.opsAlertChannelId` plus env fallback.

**Tech Stack:** Node.js ESM, discord.js, Prisma, pino, vitest, OpenTofu SSM.

**Spec:** `docs/superpowers/specs/2026-09-21-observability-design.md`  
**Tech debt:** https://github.com/chmieleski/trueskill-bot/issues/179

## Global Constraints

- Scope: `general` only
- English-only user-facing strings
- Do not gate obs on `API_ENABLED`
- Do not mirror application `log.error` to Discord
- Env-aws-sync checklist for every new bot-read key
- Conventional Commits

---

### Task 1: Env + AWS sync scaffolding

**Files:**

- Modify: `src/config/env.ts`
- Modify: `.env.example`
- Modify: `.cursor/rules/scripts-and-env.mdc`
- Modify: `infra/aws/variables.tf`, `ssm.tf`, `terraform.tfvars.example`
- Modify: `deploy/aws/refresh-env.sh`

- [ ] Add `obsEnabled`, `obsBind`, `obsPort`, `obsToken`, `opsAlertChannelId`, `obsRssMbWarn`, `obsEventLoopMsWarn`, `obsSampleIntervalMs` to `env.ts` with defaults from the spec
- [ ] Document in `.env.example` and scripts-and-env rule
- [ ] Add tofu variables + SSM params (`OBS_TOKEN` SecureString; empties → `__EMPTY__`)
- [ ] Explicit `echo` lines in `refresh-env.sh` + update `known` list
- [ ] Commit: `chore(obs): add observability env and SSM keys`

### Task 2: Prisma ops channel

**Files:**

- Modify: `prisma/schema.prisma` (`GuildConfig.opsAlertChannelId`)
- Create: migration via `npm run db:migrate` name `guild_ops_alert_channel`
- Modify: `src/services/guild/guild-config.ts` (+ tests + index exports)

- [ ] Add field + setters/clearers mirroring `completedMatchLogChannelId`
- [ ] Extend `ResolvedGuildConfig`
- [ ] Commit: `feat(obs): add GuildConfig opsAlertChannelId`

### Task 3: Core observability module (TDD)

**Files:**

- Create: `src/services/observability/registry.ts`
- Create: `src/services/observability/thresholds.ts`
- Create: `src/services/observability/channel-resolver.ts`
- Create: `src/services/observability/auth.ts`
- Create: matching `*.test.ts` files
- Create: `src/services/observability/index.ts`

- [ ] Write tests for threshold helpers, channel resolve (env/guild/dedupe), auth (loopback vs not)
- [ ] Implement until green
- [ ] Commit: `feat(obs): add metrics registry and helpers`

### Task 4: Sampler + alerter + HTTP

**Files:**

- Create: `src/services/observability/sampler.ts`
- Create: `src/services/observability/alerter.ts`
- Create: `src/services/observability/http-server.ts`
- Create: `src/services/observability/snapshot.ts`
- Create: tests for cooldown + HTTP handlers

- [ ] Sampler updates registry; fires alerter on threshold / DB recovery
- [ ] Alerter posts embeds with cooldown; resolves channels via prisma + env
- [ ] HTTP: `GET /health`, `GET /status`; auth via Task 3
- [ ] Commit: `feat(obs): add sampler, Discord alerter, and obs HTTP`

### Task 5: Bootstrap + Discord lifecycle hooks

**Files:**

- Modify: `src/events/ready.ts`
- Modify: `src/index.ts`
- Create: `src/events/shard-disconnect.ts` or hook in ready via `client.on`

- [ ] Start obs on ready when `OBS_ENABLED`; stop on shutdown
- [ ] Ready / disconnect / shutdown / uncaught / unhandledRejection → alerter
- [ ] Increment interaction counter somewhere cheap (interactionCreate) if easy; else leave at 0
- [ ] Commit: `feat(obs): wire observability into bootstrap`

### Task 6: `/config set ops_channel`

**Files:**

- Modify: `src/commands/config/config.ts`
- Modify: `src/commands/config/config-shared.ts`

- [ ] Add set/clear ops_channel (staff-only, like changelog)
- [ ] Show line in config view
- [ ] Commit: `feat(config): add ops_channel setting`

### Task 7: Verify

- [ ] `npm test`
- [ ] `npm run typecheck`
- [ ] `npm run format:check` (fix with `npm run format` if needed)
