# DBZ WC3 Bot — Antigravity Workspace Guide

This repo is a **pnpm + Turborepo monorepo** for a custom Dragon Ball Z Warcraft III ranked Discord bot and web platform.

## Monorepo Architecture

| Path          | Package    | Target / Platform                                           |
| ------------- | ---------- | ----------------------------------------------------------- |
| `apps/bot`    | `@dbz/bot` | Discord bot (Node.js ESM, discord.js v14, AWS EC2)          |
| `apps/web`    | `@dbz/web` | Next.js web shell (Vercel)                                  |
| `packages/db` | `@dbz/db`  | Prisma schema + client (Supabase PostgreSQL / local Docker) |

## Stack & Conventions

- **Runtime & Language**: Node.js + TypeScript (ESM, `"type": "module"`). Use `.js` extension in TS source imports.
- **Discord**: `discord.js` v14 with Slash Commands and button/modal interaction components.
- **Database**: Prisma ORM with Supabase PostgreSQL (or local Postgres via Docker Compose on port `5433`).
- **Prisma Client**: Import from `@dbz/db`. Always use the singleton in `apps/bot/src/lib/prisma.ts` — never `new PrismaClient()` elsewhere.
- **Language Policy**: All user-facing strings, logs, command names/descriptions, and errors must be in **English**.

## Antigravity IDE Customizations

- **Workspace Root**: `.agents/`
- **MCP Servers**: `.agents/mcp_config.json`
- **Custom Skills**: `.agents/skills/` (with `.agents/skills.json` indexing)
- **Workspace Rules**: `.agents/rules/`

### Rules Catalog (`.agents/rules/`)

| Rule                                                                                 | Summary & Scope                                                                             |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| [`coding-standards.md`](.agents/rules/coding-standards.md)                           | Context first, clean code, no fluff, review before execute                                  |
| [`project-overview.md`](.agents/rules/project-overview.md)                           | Product context, 6v6 ranked matches, OpenSkill ratings, English-only                        |
| [`project-structure.md`](.agents/rules/project-structure.md)                         | Monorepo layout, bot service directories and interaction adapters                           |
| [`conventions.md`](.agents/rules/conventions.md)                                     | TypeScript ESM, named exports, `.js` imports, Prisma singleton, graceful shutdown           |
| [`database-domain.md`](.agents/rules/database-domain.md)                             | Multi-league tenancy (`leagueId`), Player identity, Hero, Match, Event containers           |
| [`openskill-rating.md`](.agents/rules/openskill-rating.md)                           | Dual μ/σ (global + hero), balance hints, lobby scaling, quitter/griefer/DC penalties, decay |
| [`scripts-and-env.md`](.agents/rules/scripts-and-env.md)                             | pnpm scripts reference, required and optional environment variables                         |
| [`shared-domain-logic.md`](.agents/rules/shared-domain-logic.md)                     | DRY: buttons, modals, and slash commands must share domain use-cases in `src/services/`     |
| [`slash-commands.md`](.agents/rules/slash-commands.md)                               | Registering slash commands with `SlashCommandBuilder` and deferring replies                 |
| [`feature-scope-game-vs-general.md`](.agents/rules/feature-scope-game-vs-general.md) | Strict separation between `general` bot core and `game:<gameId>` (IHL) logic                |
| [`conventional-commits.md`](.agents/rules/conventional-commits.md)                   | Conventional Commits requirement for commit messages and squash PR titles                   |
| [`format-before-pr.md`](.agents/rules/format-before-pr.md)                           | Prettier formatting gate (`npm run format:check`) before creating PRs                       |
| [`env-aws-sync.md`](.agents/rules/env-aws-sync.md)                                   | Production env synchronization across AWS SSM, Terraform, and `refresh-env.sh`              |
| [`clickup-api-fallback.md`](.agents/rules/clickup-api-fallback.md)                   | Fallback from ClickUp MCP to REST API when rate-limited                                     |
| [`model-selection.md`](.agents/rules/model-selection.md)                             | Model preference guidance                                                                   |

## Essential Development Workflows

```bash
# Development
pnpm dev:bot                  # Run bot with tsx watch
pnpm dev:web                  # Run web shell
pnpm typecheck                # Monorepo typecheck

# Database (local)
pnpm db:up                    # Start local Postgres (port 5433)
pnpm db:migrate               # Run Prisma migrations
pnpm db:studio                # Launch Prisma Studio

# Quality Gates
npm run format:check          # Prettier gate (must pass before PR)
npm run format                # Auto-fix formatting
```

## Multi-League & Architectural References

- Adding a new game / league: `docs/dev/adding-a-new-game.md`
- Multi-league IHL design: `docs/superpowers/specs/2026-08-15-multi-league-ihl-design.md`
- Per-game player identity: `docs/superpowers/specs/2026-08-17-per-game-player-identity-design.md`
- Web base design: `docs/superpowers/specs/2026-09-21-monorepo-web-base-design.md`
