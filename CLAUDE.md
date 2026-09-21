# DBZ WC3 Bot

Project guidance for AI agents lives in **Cursor rules** (single source of truth):

`.cursor/rules/`

This repo is a **pnpm + Turborepo monorepo**:

| Path          | Package                             |
| ------------- | ----------------------------------- |
| `apps/bot`    | `@dbz/bot` — Discord bot (AWS)      |
| `apps/web`    | `@dbz/web` — Next.js shell (Vercel) |
| `packages/db` | `@dbz/db` — Prisma schema + client  |

| Rule                                | When it applies                                                              |
| ----------------------------------- | ---------------------------------------------------------------------------- |
| `project-overview.mdc`              | Always — product, stack, English-only UI                                     |
| `model-selection.mdc`               | Always — Cursor Auto for impl; Grok 4.6 for architecture reviews             |
| `feature-scope-game-vs-general.mdc` | Always — declare `general` vs `game:<id>` before coding                      |
| `scripts-and-env.mdc`               | Always — pnpm scripts and env vars                                           |
| `clickup-api-fallback.mdc`          | Always — ClickUp REST API when MCP is rate-limited                           |
| `env-aws-sync.mdc`                  | Env / infra / deploy — new production env vars must update SSM + refresh-env |
| `project-structure.mdc`             | `apps/bot/src/**/*.ts`                                                       |
| `database-domain.mdc`               | Prisma / domain TypeScript                                                   |
| `openskill-rating.mdc`              | Bot + Prisma — OpenSkill μ/σ, dual ratings, ordinal, quitters                |
| `slash-commands.mdc`                | Commands, handlers, command types                                            |
| `conventions.mdc`                   | Bot ESM, Prisma singleton, shutdown                                          |
| `shared-domain-logic.mdc`           | DRY: buttons & commands share use-cases                                      |

Multi-league / new-game guide: `docs/dev/adding-a-new-game.md` (design: `docs/superpowers/specs/2026-08-15-multi-league-ihl-design.md`, plan: `docs/superpowers/plans/2026-08-15-multi-league-ihl.md`).

Web base design: `docs/superpowers/specs/2026-09-21-monorepo-web-base-design.md`.

Do not duplicate this content here; edit the `.mdc` files instead.
