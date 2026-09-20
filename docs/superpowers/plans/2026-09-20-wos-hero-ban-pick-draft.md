# WOS Hero Ban/Pick Draft Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `/hero_draft` for WOS: public-thread hero ban/pick with snapshotted `GameHero` pool, captain timers, paginated selects + application emojis, summary-only completion.

**Architecture:** New Prisma `HeroDraft` + `src/services/hero-draft/` pure turn logic and Discord adapters, mirroring captain-draft patterns without sharing its state machine. Timers use persisted `actionDeadlineAt` with in-process scheduling and boot rehydrate.

**Tech Stack:** TypeScript ESM, discord.js v14, Prisma/Postgres, Vitest.

## Global Constraints

- Scope: `game:warcraft3_wos` for pool; new domain under `src/services/hero-draft/`
- English-only user-facing strings
- Do not extend `/captain_draft` internals for turns
- No lobby prefill button in v1 (tech debt in design spec only)
- Application emoji name: `wos_{objectId}`
- Minimum pool size: 16
- Conventional commits on this branch

---

### Task 1: Prisma `HeroDraft` + types + pure turn logic (TDD)

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/*/migration.sql` (via migrate)
- Create: `src/services/hero-draft/draft-types.ts`
- Create: `src/services/hero-draft/draft-logic.ts`
- Create: `src/services/hero-draft/draft-logic.test.ts`
- Create: `src/services/hero-draft/draft-state.ts`
- Create: `src/services/hero-draft/index.ts`

- [ ] Add `HeroDraft` model per design spec; migrate
- [ ] Define turn sequence constant and state types
- [ ] Tests: full sequence team ownership, skip ban, timeout ban/pick, availability, completion
- [ ] Implement logic until green
- [ ] Commit `feat(hero-draft): add turn logic and HeroDraft model`

### Task 2: Team resolution + start/cancel actions + timer

**Files:**
- Create: `src/services/hero-draft/draft-teams.ts`
- Create: `src/services/hero-draft/draft-teams.test.ts`
- Create: `src/services/hero-draft/draft-actions.ts`
- Create: `src/services/hero-draft/draft-timer.ts`
- Create: `src/services/hero-draft/draft-auth.ts`

- [ ] Import team from COMPLETE captain-draft JSON; parse manual captain+roster
- [ ] Snapshot `GameHero`; refuse &lt;16; create public thread; pings
- [ ] Persist ACTIVE; set deadline; schedule timeout handler
- [ ] Boot rehydrate helper exported for `index.ts`
- [ ] Commit `feat(hero-draft): start cancel timer and team sources`

### Task 3: Live UI (embed, pagination, emoji, skip)

**Files:**
- Create: `src/services/hero-draft/draft-ui.ts`
- Create: `src/services/hero-draft/draft-ui.test.ts`
- Create: `src/discord/interactions/hero-draft-interactions.ts`
- Modify: `src/events/interaction-create.ts`

- [ ] Build embed + paginated select + skip ban; emoji map `wos_{objectId}`
- [ ] Handle select/page/skip/ban/pick; sync message after actions
- [ ] Wire interaction router
- [ ] Commit `feat(hero-draft): live thread UI and interactions`

### Task 4: Slash command + boot rehydrate

**Files:**
- Create: `src/commands/hero-draft/hero-draft.ts`
- Modify: `src/index.ts` (rehydrate timers after login)
- Tests as needed for command option shape

- [ ] `/hero_draft start|cancel` with league option, timer, team sources
- [ ] Call rehydrate after client ready/login path
- [ ] Commit `feat(hero-draft): slash command and timer rehydrate`
- [ ] `npm run format:check` / typecheck / targeted vitest

---

## Reference: turn sequence

```text
ban T1, ban T2, ban T1, ban T2,
pick T1, pick T2, pick T2, pick T1, pick T1, pick T2,
ban T1, ban T2,
pick T2, pick T1, pick T1, pick T2
```
