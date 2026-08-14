# Services organization — Design

**Date:** 2026-08-15  
**Status:** Approved for implementation planning  
**Scope:** Reorganize `src/services/` by domain, split oversized modules (especially `lobby-actions`), lightly clarify Discord adapter vs use-case layers

## Goal

Make the codebase easier to navigate without changing bot behavior:

- Find lobby / match / wc3stats / rating / player / leaderboard code in under a few seconds
- Eliminate the flat `src/services/` dump (~40 files at one level)
- Split `lobby-actions.ts` (~870 lines) into focused modules with stable public exports
- Separate Discord interaction adapters from bootstrap loaders (handlers)

## Non-goals

- Full clean architecture (`domain/` / `application/` / `infrastructure` redesign)
- Vertical feature folders that break command auto-load (`commands/**`, `events/**`)
- Renaming public use-case function names (`addLobbyPlayer`, etc.)
- New path aliases (unless already present — keep relative `.js` ESM imports)
- Splitting `match-service.ts` / `lobby-preview.ts` beyond a folder move (optional follow-up)
- Cleaning repo root clutter (`prod-data.sql`, `ruvector.db`) or `docs/superpowers` history
- Behavior, rating math, OCR, or Discord UX changes

## Locked decisions

| Topic | Choice |
|-------|--------|
| Aggressiveness | **Medium (B)** — domain folders + split giants + light layer clarity |
| Approach | **Domain folders under `services/`** + surgical split of `lobby-actions` |
| Commands / events layout | **Unchanged** (already grouped) |
| Empty `src/domain/` | **Delete** |
| Public API | **Barrel `index.ts` per domain**; same export names as today |
| Interaction handlers | Move to `src/discord/interactions/`; `handlers/` = bootstrap only |
| `hero-catalog` / `team-names` | Live under `services/guild/` (shared guild/catalog helpers) |
| Phasing | Three phases (move → split lobby-actions → move interactions) |
| Language | All user-facing strings remain **English** |

## Target tree

```
src/
├── commands/                 # unchanged
├── events/                   # unchanged
├── handlers/                 # bootstrap only
│   ├── load-commands.ts
│   ├── load-events.ts
│   └── register-commands.ts
├── discord/
│   └── interactions/
│       ├── lobby-interactions.ts
│       ├── match-interactions.ts
│       └── leaderboard-interactions.ts
├── services/
│   ├── lobby/
│   ├── match/
│   ├── rating/
│   ├── player/
│   ├── leaderboard/
│   ├── wc3stats/
│   └── guild/
├── config/ lib/ client/ types/
└── index.ts / deploy-commands.ts
```

### File → domain mapping

| Domain | Current files |
|--------|----------------|
| `lobby/` | `lobby-actions`, `lobby-preview`, `lobby-balance`, `lobby-ocr`, `lobby-claim` (tests), `lobby-identity`, `register-lobby-source`, related `lobby-*-wc3stats` tests |
| `match/` | `match-service`, `match-report`, `match-auth`, `match-cleanup` |
| `rating/` | `rating-math`, `rating-preview`, `rating-update` |
| `player/` | `player-link`, `player-nick`, `player-profile`, `rank-embed` |
| `leaderboard/` | `leaderboard`, `leaderboard-embed`, `leaderboard-channel` |
| `wc3stats/` | `wc3stats-client`, `wc3stats-map`, `wc3stats-match`, `wc3stats-resolve`, `wc3stats-roster`, `wc3stats-slot-map` |
| `guild/` | `guild-config`, `hero-catalog`, `team-names` |

Co-locate `*.test.ts` next to the module they cover (same domain folder).

## Layer rules (light)

| Layer | Responsibility |
|-------|----------------|
| `commands/*`, `discord/interactions/*` | Parse Discord I/O → call use-case → map result to reply/update |
| `services/<domain>/*` | Use-cases, persistence orchestration, embed builders used by multiple entry points |
| Pure helpers (e.g. roster transforms) | No Discord.js Client / message edit; prefer no Prisma when possible |

Does **not** introduce a formal `domain/` package. Existing Cursor rule `shared-domain-logic.mdc` still applies: buttons and slash commands share the same use-cases.

## Split: `lobby-actions.ts`

Replace the monolith with:

| Module | Contents |
|--------|----------|
| `roster.ts` | Pure roster transforms: `addPlayer`, `removePlayer`, `movePlayer`, `swapPlayers`, `editPlayerNick`, `rosterAfterClaim`, `rosterAfterLeave`, slot asserts |
| `resolve.ts` | `resolveHostPendingMatch*`, `resolve*ByMessageId`, ownership/status asserts used by resolve |
| `lifecycle.ts` | `startLobbyMatch*`, `cancelLobbyMatch*` |
| `discord-sync.ts` | `syncLobbyDiscordMessage`, `applyRosterAndSync` |
| `wc3stats-refresh.ts` | `refreshLobbyFromWc3stats` and import/link helpers currently private in lobby-actions |
| `actions.ts` | Thin orchestrators: `addLobbyPlayer`, `claimLobbySlot`, `removeLobbyPlayer`, … |
| `index.ts` | Re-export public API with **identical names** to today’s `lobby-actions.js` |

Target: no new file in this split over ~400 lines. Keep user-facing English message constants next to the module that throws/returns them (or a small `messages.ts` if duplication appears).

## Phases

### Phase 1 — Mechanical move

1. Create domain folders + barrels.
2. `git mv` files (and tests) into domain folders. **Keep existing basenames** (e.g. `services/lobby/lobby-preview.ts`) to minimize rename churn; barrels provide the clean import surface.
3. Update all imports.
4. Delete empty `src/domain/`.
5. Run tests; smoke bot startup.

**No behavior changes.**

### Phase 2 — Split lobby-actions

1. Extract modules listed above inside `services/lobby/`.
2. Point barrel at new modules; delete `lobby-actions.ts`.
3. Move/adjust tests (`lobby-claim.test.ts`, etc.) to import from barrel or specific modules.
4. Run tests.

**No intentional behavior changes**; public function signatures stay the same.

### Phase 3 — Discord interactions move

1. Move `lobby-interactions.ts`, `match-interactions.ts`, `leaderboard-interactions.ts` → `src/discord/interactions/`.
2. Update `events/interaction-create.ts` (and any other imports).
3. Leave `handlers/` with only load/register helpers.
4. Update Cursor rules: `project-structure.mdc`, `shared-domain-logic.mdc`.

## Success criteria

- `src/services/` has domain subfolders, not a flat file list
- `lobby-actions.ts` no longer exists; public exports remain available via `services/lobby`
- Interaction handlers live under `discord/interactions/`; `handlers/` is bootstrap-only
- Existing test suite passes; no product/feature diffs expected
- `project-structure.mdc` reflects the new layout

## Risks & mitigations

| Risk | Mitigation |
|------|------------|
| Large import churn / merge conflicts | Phase 1 alone as one PR; Phase 2–3 as follow-ups if needed |
| Accidental behavior change in split | Keep function bodies intact on first extract; refactor internals only if tests already cover |
| Circular imports via barrels | Prefer importing concrete modules inside the same domain; barrels for **external** consumers |
| Missed import after move | `tsc` / `npm test` as gate |

## Follow-ups (explicitly out of this design)

1. Split `match-service.ts` / `lobby-preview.ts` if they remain painful.
2. Optional `services/shared/` if `guild/` feels wrong for catalog/team helpers.
3. Repo hygiene (sql dumps, local db files) via `.gitignore` / docs only.
