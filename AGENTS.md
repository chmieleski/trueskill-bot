# Repository Agent Guide

These instructions apply to Codex and other coding agents working in this repository. Cursor configuration remains available under `.cursor/`.

## Start here

- Read [GEMINI.md](./GEMINI.md) for the stack, architecture, commands, and full rule catalog.
- Before changing code, read the relevant rules in [`.agents/rules/`](./.agents/rules/). These Markdown files are the shared source of truth; do not rely on Cursor `.mdc` rules being loaded by another agent.
- For reusable workflows, discover and follow skills under [`.agents/skills/`](./.agents/skills/). The `drafting-player-changelog` skill is the repository's current skill.
- The project currently has no shared MCP servers configured; see [`.agents/mcp_config.json`](./.agents/mcp_config.json).

## Core project facts

- This is a pnpm + Turborepo monorepo: `apps/bot` (Discord bot), `apps/web` (Next.js), and `packages/db` (Prisma).
- TypeScript uses Node.js ESM; source imports use `.js` extensions.
- Import Prisma through `@dbz/db` and use the singleton in `apps/bot/src/lib/prisma.ts`.
- User-facing strings, logs, command names/descriptions, and errors must be in English.
- Rating and match data is league-scoped. Read the database and OpenSkill rules before touching those areas.

## Useful commands

- `pnpm dev:bot` — run the bot
- `pnpm dev:web` — run the web app
- `pnpm typecheck` — typecheck the monorepo
- `pnpm db:up` — start local PostgreSQL
- `pnpm db:migrate` — apply local Prisma migrations
- `npm run format:check` — check formatting

See [`.agents/rules/scripts-and-env.md`](./.agents/rules/scripts-and-env.md) for the full scripts and environment variable reference.
