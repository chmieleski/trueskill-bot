# DBZ WC3 Bot

Project guidance for AI agents lives in **Claude rules** (single source of truth):

`.claude/rules/`

This repo is a **pnpm + Turborepo monorepo**:

| Path          | Package                             |
| ------------- | ----------------------------------- |
| `apps/bot`    | `@dbz/bot` — Discord bot (AWS)      |
| `apps/web`    | `@dbz/web` — Next.js shell (Vercel) |
| `packages/db` | `@dbz/db` — Prisma schema + client  |

| Rule                               | When it applies                                                              |
| ---------------------------------- | ---------------------------------------------------------------------------- |
| `project-overview.md`              | Always — product, stack, English-only UI                                     |
| `model-selection.md`               | Always — Cursor Auto for impl; Grok 4.6 for architecture reviews             |
| `feature-scope-game-vs-general.md` | Always — declare `general` vs `game:<id>` before coding                      |
| `scripts-and-env.md`               | Always — pnpm scripts and env vars                                           |
| `clickup-api-fallback.md`          | Always — ClickUp REST API when MCP is rate-limited                           |
| `env-aws-sync.md`                  | Env / infra / deploy — new production env vars must update SSM + refresh-env |
| `project-structure.md`             | `apps/bot/src/**/*.ts`                                                       |
| `database-domain.md`               | Prisma / domain TypeScript                                                   |
| `openskill-rating.md`              | Bot + Prisma — OpenSkill μ/σ, dual ratings, ordinal, quitters                |
| `slash-commands.md`                | Commands, handlers, command types                                            |
| `conventions.md`                   | Bot ESM, Prisma singleton, shutdown                                          |
| `shared-domain-logic.md`           | DRY: buttons & commands share use-cases                                      |

Multi-league / new-game guide: `docs/dev/adding-a-new-game.md` (design: `docs/superpowers/specs/2026-08-15-multi-league-ihl-design.md`, plan: `docs/superpowers/plans/2026-08-15-multi-league-ihl.md`).

Web base design: `docs/superpowers/specs/2026-09-21-monorepo-web-base-design.md`.

Do not duplicate this content here; edit the `.md` files instead.
