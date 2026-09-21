# Monorepo + Next.js web base — Design

**Date:** 2026-09-21  
**Status:** Approved  
**Scope:** `general` (repo tooling / structure; not game-specific)  
**Plan:** Cursor plan `monorepo_web_base` (Monorepo + Next.js web base)

## Goal

Turn the single-package Discord bot repo into a **pnpm + Turborepo monorepo** with:

- `apps/bot` — existing Discord bot (AWS)
- `apps/web` — Next.js App Router shell (Vercel)
- `packages/db` — shared Prisma schema, migrations, and client export

This milestone is **structure only**. No real web product features, auth, or Vercel database access.

## Non-goals

- Queue / worker / service app
- Discord OAuth or any web auth
- Web → DB or web → bot API wiring
- Extracting domain services into packages
- Custom Vercel domain
- `create-turbo` graft (manual scaffold instead)

## Locked decisions

| Topic                            | Choice                                                  |
| -------------------------------- | ------------------------------------------------------- |
| Monorepo layout                  | Full apps layout from day one (`apps/bot` + `apps/web`) |
| Tooling                          | Turborepo + **pnpm** workspaces                         |
| Shared packages (this milestone) | **`packages/db` only** (Prisma)                         |
| Web data access (near term)      | **Shell only** — no `DATABASE_URL` on Vercel            |
| Scaffold approach                | Manual Turborepo (not `create-turbo` then graft)        |
| Package names                    | `@dbz/bot`, `@dbz/web`, `@dbz/db`                       |
| Bot hosting                      | AWS EC2 (unchanged product host)                        |
| Web hosting                      | Vercel (`Root Directory: apps/web`)                     |
| Prisma runtime singleton         | Stays in the bot (`apps/bot/src/lib/prisma.ts`)         |
| Schema ownership                 | `@dbz/db` owns schema + migrations + client export      |

## Target layout

```text
/
  package.json              # workspace root: turbo, prettier, husky, release
  pnpm-workspace.yaml       # apps/*, packages/*
  turbo.json
  apps/bot/                 # Discord bot
  apps/web/                 # Next.js App Router shell
  packages/db/              # Prisma schema, migrations, client
  deploy/, infra/, docs/    # remain at repo root
```

```text
Vercel                         AWS EC2
┌─────────────┐                ┌─────────────┐
│  apps/web   │                │  apps/bot   │──┐
└─────────────┘                └─────────────┘  │
       ⋮ (later)                                ▼
                                         packages/db
                                                │
                                         Supabase Postgres
```

## Package responsibilities

### `@dbz/db`

- Holds `prisma/schema.prisma`, `prisma/migrations/`, and `prisma.config.ts`
- Exports the generated Prisma client and types
- Does **not** own the `PrismaPg` adapter singleton
- Scripts: generate / migrate / push / studio (invoked via `pnpm --filter @dbz/db`)

### `@dbz/bot`

- Current Discord bot runtime, commands, services, HTTP API, observability
- Depends on `@dbz/db` for client/types
- Creates the Prisma client with adapter + `DATABASE_URL` in `src/lib/prisma.ts`
- Semver / semantic-release version source for the product

### `@dbz/web`

- Next.js App Router + TypeScript
- Minimal landing page (product name + coming soon)
- No Prisma dependency, no auth, no DB env in this milestone

### Workspace root

- pnpm workspaces, Turbo pipelines, Prettier, Husky, commitlint, semantic-release
- Proxies common scripts (`dev`, `build`, `test`, `typecheck`, `db:*`)
- Keeps `deploy/`, `infra/`, `docs/` at root

## Local env

Prefer a **root** `.env` so Prisma CLI and the bot share `DATABASE_URL` / `DIRECT_URL`. Document in `.env.example`. Production continues to write `APP_DIR/.env` via SSM refresh.

## Deploy

### Vercel

- Connect the GitHub repo
- Root Directory: `apps/web`
- Install from repo root with pnpm
- No database env vars required for the base shell

### AWS

- Host updater switches from `npm ci` to **pnpm**
- Build / deploy-commands / migrate use workspace filters and new paths
- systemd keeps `WorkingDirectory` at the repo root (where `.env` lives) and starts `apps/bot/dist/index.js`

## CI

- `pnpm/action-setup` + frozen lockfile (drop `package-lock.json`)
- Generate Prisma via `@dbz/db`
- Turbo typecheck/test for bot; build web
- Format check at root
- semantic-release assets bump `@dbz/bot` `package.json` (and lockfile), not a published npm package for web

## Verification (this milestone)

- `pnpm install` clean
- `@dbz/db` generate
- `@dbz/bot` typecheck + test
- `@dbz/web` build
- `pnpm format:check`

## Follow-ups (out of scope)

- Service / queue app consuming `@dbz/db`
- First real web pages and data access strategy (API vs direct Prisma vs queue)
- Shared UI / config packages as needed
