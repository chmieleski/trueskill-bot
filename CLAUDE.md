# DBZ WC3 Bot

Project guidance for AI agents lives in **Cursor rules** (single source of truth):

`.cursor/rules/`

| Rule | When it applies |
|------|-----------------|
| `project-overview.mdc` | Always — product, stack, English-only UI |
| `scripts-and-env.mdc` | Always — npm scripts and env vars |
| `project-structure.mdc` | `src/**/*.ts` |
| `database-domain.mdc` | Prisma / domain TypeScript |
| `slash-commands.mdc` | Commands, handlers, command types |
| `conventions.mdc` | `src/**/*.ts` — ESM, Prisma singleton, shutdown |
| `shared-domain-logic.mdc` | `src/**/*.ts` — DRY: buttons & commands share use-cases |

Do not duplicate this content here; edit the `.mdc` files instead.
