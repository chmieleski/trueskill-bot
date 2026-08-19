# Services Organization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reorganize `src/services/` into domain folders, split `lobby-actions.ts` into focused modules with the same public API, and move Discord interaction handlers under `src/discord/interactions/` — without changing bot behavior.

**Architecture:** Keep commands/events auto-load as-is. Domain logic lives in `src/services/<domain>/` with barrels for external consumers. Inside a domain and across domains, prefer **concrete module imports** (avoid barrel→barrel cycles). Interaction adapters move to `discord/interactions/`; `handlers/` keeps only bootstrap loaders.

**Tech Stack:** Node.js ESM TypeScript, discord.js v14, Prisma, Vitest (`npm test`), existing Cursor rules under `.cursor/rules/`.

## Global Constraints

- All user-facing strings remain **English**.
- **No behavior changes** (ratings, OCR, Discord UX, messages, auth rules).
- ESM imports keep the **`.js` extension**; no new path aliases.
- Public use-case **function names stay identical** (`addLobbyPlayer`, `syncLobbyDiscordMessage`, …).
- Keep **existing basenames** inside folders (`lobby-preview.ts` stays `lobby-preview.ts`).
- Prefer concrete imports **inside** `services/` and **across** domains; barrels are for **commands / events / discord / handlers** consumers.
- Spec: [docs/superpowers/specs/2026-08-15-services-organization-design.md](../specs/2026-08-15-services-organization-design.md)

## File map (end state)

| Path                                    | Role                                                                  |
| --------------------------------------- | --------------------------------------------------------------------- |
| `src/services/lobby/*`                  | Lobby OCR, preview, balance, identity, register source, actions split |
| `src/services/match/*`                  | Match Prisma service, report, auth, cleanup                           |
| `src/services/rating/*`                 | Math, preview, update                                                 |
| `src/services/player/*`                 | Link, nick, profile, rank embed                                       |
| `src/services/leaderboard/*`            | Queries, embeds, live channel                                         |
| `src/services/wc3stats/*`               | Client, map, resolve, roster, slot-map, match helpers                 |
| `src/services/guild/*`                  | Guild config, hero catalog, team names                                |
| `src/services/*/index.ts`               | Domain barrels (public re-exports)                                    |
| `src/discord/interactions/*`            | Lobby / match / leaderboard interaction adapters                      |
| `src/handlers/{load,register}-*.ts`     | Bootstrap only                                                        |
| `.cursor/rules/project-structure.mdc`   | Document new tree                                                     |
| `.cursor/rules/shared-domain-logic.mdc` | Point at `services/<domain>/` + `discord/interactions/`               |

**Removed:** `src/domain/` (empty), `src/services/lobby-actions.ts` (after Phase 2), interaction files under `src/handlers/`.

---

### Task 1: Phase 1 — Create domain folders and move files

**Files:**

- Create dirs: `src/services/{lobby,match,rating,player,leaderboard,wc3stats,guild}/`
- Move (git mv) every file currently in `src/services/*.ts` into the domain from the mapping below
- Delete: `src/domain/` (empty directory)

**Domain mapping (basename → folder):**

| Folder         | Basenames                                                                                                                                                                                                                                                     |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lobby/`       | `lobby-actions`, `lobby-actions-wc3stats.test`, `lobby-balance`, `lobby-balance.test`, `lobby-claim.test`, `lobby-identity`, `lobby-identity.test`, `lobby-ocr`, `lobby-preview`, `lobby-preview.test`, `register-lobby-source`, `register-lobby-source.test` |
| `match/`       | `match-service`, `match-report`, `match-report.test`, `match-auth`, `match-auth.test`, `match-cleanup`                                                                                                                                                        |
| `rating/`      | `rating-math`, `rating-math.test`, `rating-preview`, `rating-update`, `rating-update.test`                                                                                                                                                                    |
| `player/`      | `player-link`, `player-link.test`, `player-nick`, `player-nick.test`, `player-profile`, `player-profile.test`, `rank-embed`, `rank-embed.test`                                                                                                                |
| `leaderboard/` | `leaderboard`, `leaderboard.test`, `leaderboard-embed`, `leaderboard-embed.test`, `leaderboard-channel`, `leaderboard-channel.test`                                                                                                                           |
| `wc3stats/`    | `wc3stats-client`, `wc3stats-client.test`, `wc3stats-map`, `wc3stats-map.test`, `wc3stats-match.test`, `wc3stats-resolve`, `wc3stats-resolve.test`, `wc3stats-roster`, `wc3stats-roster.test`, `wc3stats-slot-map`, `wc3stats-slot-map.test`                  |
| `guild/`       | `guild-config`, `guild-config.test`, `hero-catalog`, `team-names`, `team-names.test`                                                                                                                                                                          |

**Interfaces:**

- Produces: files at new paths; no new exports yet (barrels in Task 2)

- [ ] **Step 1: Create directories**

```bash
mkdir -p src/services/{lobby,match,rating,player,leaderboard,wc3stats,guild}
```

- [ ] **Step 2: git mv lobby files**

```bash
git mv src/services/lobby-actions.ts src/services/lobby/
git mv src/services/lobby-actions-wc3stats.test.ts src/services/lobby/
git mv src/services/lobby-balance.ts src/services/lobby/
git mv src/services/lobby-balance.test.ts src/services/lobby/
git mv src/services/lobby-claim.test.ts src/services/lobby/
git mv src/services/lobby-identity.ts src/services/lobby/
git mv src/services/lobby-identity.test.ts src/services/lobby/
git mv src/services/lobby-ocr.ts src/services/lobby/
git mv src/services/lobby-preview.ts src/services/lobby/
git mv src/services/lobby-preview.test.ts src/services/lobby/
git mv src/services/register-lobby-source.ts src/services/lobby/
git mv src/services/register-lobby-source.test.ts src/services/lobby/
```

- [ ] **Step 3: git mv match, rating, player, leaderboard, wc3stats, guild**

```bash
git mv src/services/match-service.ts src/services/match/
git mv src/services/match-report.ts src/services/match/
git mv src/services/match-report.test.ts src/services/match/
git mv src/services/match-auth.ts src/services/match/
git mv src/services/match-auth.test.ts src/services/match/
git mv src/services/match-cleanup.ts src/services/match/

git mv src/services/rating-math.ts src/services/rating/
git mv src/services/rating-math.test.ts src/services/rating/
git mv src/services/rating-preview.ts src/services/rating/
git mv src/services/rating-update.ts src/services/rating/
git mv src/services/rating-update.test.ts src/services/rating/

git mv src/services/player-link.ts src/services/player/
git mv src/services/player-link.test.ts src/services/player/
git mv src/services/player-nick.ts src/services/player/
git mv src/services/player-nick.test.ts src/services/player/
git mv src/services/player-profile.ts src/services/player/
git mv src/services/player-profile.test.ts src/services/player/
git mv src/services/rank-embed.ts src/services/player/
git mv src/services/rank-embed.test.ts src/services/player/

git mv src/services/leaderboard.ts src/services/leaderboard/
git mv src/services/leaderboard.test.ts src/services/leaderboard/
git mv src/services/leaderboard-embed.ts src/services/leaderboard/
git mv src/services/leaderboard-embed.test.ts src/services/leaderboard/
git mv src/services/leaderboard-channel.ts src/services/leaderboard/
git mv src/services/leaderboard-channel.test.ts src/services/leaderboard/

git mv src/services/wc3stats-client.ts src/services/wc3stats/
git mv src/services/wc3stats-client.test.ts src/services/wc3stats/
git mv src/services/wc3stats-map.ts src/services/wc3stats/
git mv src/services/wc3stats-map.test.ts src/services/wc3stats/
git mv src/services/wc3stats-match.test.ts src/services/wc3stats/
git mv src/services/wc3stats-resolve.ts src/services/wc3stats/
git mv src/services/wc3stats-resolve.test.ts src/services/wc3stats/
git mv src/services/wc3stats-roster.ts src/services/wc3stats/
git mv src/services/wc3stats-roster.test.ts src/services/wc3stats/
git mv src/services/wc3stats-slot-map.ts src/services/wc3stats/
git mv src/services/wc3stats-slot-map.test.ts src/services/wc3stats/

git mv src/services/guild-config.ts src/services/guild/
git mv src/services/guild-config.test.ts src/services/guild/
git mv src/services/hero-catalog.ts src/services/guild/
git mv src/services/team-names.ts src/services/guild/
git mv src/services/team-names.test.ts src/services/guild/
```

- [ ] **Step 4: Remove empty `src/domain/`**

```bash
rmdir src/domain
```

- [ ] **Step 5: Commit moves only (imports still broken — acceptable if you prefer wait; otherwise skip commit until Task 2)**

Prefer **one commit after Task 2** so `main` never has a broken tree. Do **not** commit a red tree unless using a WIP branch.

---

### Task 2: Phase 1 — Fix imports + add domain barrels

**Files:**

- Modify: every moved `src/services/**/*.ts` that imports another former sibling now in a different domain
- Modify: external consumers under `src/commands/`, `src/handlers/`, `src/events/`
- Create: `src/services/{lobby,match,rating,player,leaderboard,wc3stats,guild}/index.ts`

**Cross-domain import rewrite rule**

Same domain: keep `./basename.js`.  
Other domain: `../<domain>/<basename>.js`.

Known cross-domain edges (non-exhaustive — run `rg` after moves):

| From                                    | Old                   | New                           |
| --------------------------------------- | --------------------- | ----------------------------- |
| `lobby/lobby-actions.ts`                | `./match-service.js`  | `../match/match-service.js`   |
| `lobby/lobby-actions.ts`                | `./rating-preview.js` | `../rating/rating-preview.js` |
| `lobby/lobby-actions.ts`                | `./match-auth.js`     | `../match/match-auth.js`      |
| `lobby/lobby-actions.ts`                | `./player-nick.js`    | `../player/player-nick.js`    |
| `lobby/lobby-actions.ts`                | `./guild-config.js`   | `../guild/guild-config.js`    |
| `lobby/lobby-actions.ts`                | `./wc3stats-*.js`     | `../wc3stats/wc3stats-*.js`   |
| `lobby/lobby-ocr.ts`                    | `./player-nick.js`    | `../player/player-nick.js`    |
| `lobby/lobby-ocr.ts`                    | `./team-names.js`     | `../guild/team-names.js`      |
| `lobby/lobby-identity.ts`               | `./match-service.js`  | `../match/match-service.js`   |
| `lobby/lobby-balance.ts`                | `./rating-math.js`    | `../rating/rating-math.js`    |
| `match/match-cleanup.ts`                | `./lobby-preview.js`  | `../lobby/lobby-preview.js`   |
| `match/match-report.ts`                 | `./rating-*.js`       | `../rating/rating-*.js`       |
| `match/guild` — `guild/guild-config.ts` | `./match-service.js`  | `../match/match-service.js`   |
| `rating/rating-preview.ts`              | `./hero-catalog.js`   | `../guild/hero-catalog.js`    |
| `rating/rating-preview.ts`              | `./lobby-balance.js`  | `../lobby/lobby-balance.js`   |
| `leaderboard/leaderboard.ts`            | `./hero-catalog.js`   | `../guild/hero-catalog.js`    |
| `leaderboard/leaderboard.ts`            | `./rating-math.js`    | `../rating/rating-math.js`    |
| `leaderboard/leaderboard-channel.ts`    | `./guild-config.js`   | `../guild/guild-config.js`    |
| `wc3stats/*`                            | `./match-service.js`  | `../match/match-service.js`   |
| `wc3stats/wc3stats-roster.ts`           | `./lobby-ocr.js`      | `../lobby/lobby-ocr.js`       |
| `wc3stats/wc3stats-roster.ts`           | `./player-nick.js`    | `../player/player-nick.js`    |
| `player/player-profile.ts`              | `./rating-math.js`    | `../rating/rating-math.js`    |
| `player/*.test.ts`                      | same pattern          | same pattern                  |

Also fix `../config/`, `../lib/` depth: files that used `../config/env.js` must become `../../config/env.js` (one extra `../`).

**External consumers** (update to domain barrels or concrete paths):

| Consumer                         | Change example                                                                                                |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `src/commands/lobby/*.ts`        | `../services/lobby-actions.js` → `../../services/lobby/index.js` (or `../../services/lobby/lobby-actions.js`) |
| `src/commands/match/match.ts`    | same depth + domain                                                                                           |
| `src/commands/player/*.ts`       | `../../services/player/index.js` etc.                                                                         |
| `src/commands/config/config.ts`  | `../../services/guild/index.js`                                                                               |
| `src/handlers/*-interactions.ts` | `../services/...` → `../services/<domain>/...`                                                                |
| `src/events/ready.ts`            | update service imports                                                                                        |

Prefer barrels for external imports once barrels exist.

- [ ] **Step 1: Fix depth for config/lib/client imports inside moved services**

```bash
# Example check — every services/** file that still has ../config or ../lib is wrong
rg "from ['\"]\.\./(config|lib)/" src/services -g '*.ts'
```

Replace with `../../config/` or `../../lib/` as needed.

- [ ] **Step 2: Fix cross-domain `./` imports inside services**

```bash
rg "from ['\"]\./" src/services -g '*.ts'
```

For each hit whose target file is not in the same folder, rewrite to `../<domain>/<file>.js`.

- [ ] **Step 3: Create barrels**

`src/services/lobby/index.ts` (Phase 1 — re-export from still-monolithic actions + other lobby modules as needed by external callers):

```typescript
export type { LobbyPlayer, ValidatedLobby } from './lobby-ocr.js';
export {} from // re-export whatever commands/handlers import from lobby-* today
'./lobby-actions.js';
export {
  buildLobbyButtons,
  buildMatchCancelledEmbed,
  buildMatchCompletedEmbed,
  buildMatchInProgressEmbed,
  buildMatchLobbyEmbed,
  buildMatchReportButtons,
  canStartLobby,
  claimSlotSelectOptions,
  LOBBY_CUSTOM_IDS,
} from './lobby-preview.js';
export { loadHeroCatalog } from '../guild/hero-catalog.js'; // DO NOT — keep hero on guild barrel only
```

**Do not** re-export other domains from `lobby/index.ts`. Only lobby-owned symbols.

Build each barrel by listing current external imports:

```bash
rg "from ['\"].*services/(lobby-|match-|rating-|player-|leaderboard|guild-|hero-|team-|wc3stats-|register-lobby)" src -g '*.ts'
```

Then for each domain `index.ts`, export the symbols that external code needs. Example lobby barrel after inventory (adjust to exact symbols found):

```typescript
export type { LobbyPlayer } from './lobby-ocr.js';
export {
  type LobbySyncMode,
  type LobbyActionResult,
  type ResolveHostPendingMatchInput,
  type RefreshLobbyResult,
  resolveHostPendingMatch,
  resolvePendingMatchByMessageId,
  resolveInProgressMatchByMessageId,
  resolveHostPendingMatchByMessageId,
  addPlayer,
  removePlayer,
  movePlayer,
  swapPlayers,
  editPlayerNick,
  assertLobbyPlayerClaimEnabled,
  rosterAfterClaim,
  rosterAfterLeave,
  syncLobbyDiscordMessage,
  addLobbyPlayer,
  addLobbyPlayerFromDiscord,
  claimLobbySlot,
  leaveLobbySlot,
  removeLobbyPlayer,
  moveLobbyPlayer,
  swapLobbyPlayers,
  editLobbyPlayerNick,
  applyRosterUpdateForMessage,
  startLobbyMatch,
  startLobbyMatchByMessageId,
  cancelLobbyMatch,
  refreshLobbyFromWc3stats,
} from './lobby-actions.js';
export {
  buildLobbyButtons,
  buildMatchCancelledEmbed,
  buildMatchCompletedEmbed,
  buildMatchInProgressEmbed,
  buildMatchLobbyEmbed,
  buildMatchReportButtons,
  canStartLobby,
  claimSlotSelectOptions,
  LOBBY_CUSTOM_IDS,
} from './lobby-preview.js';
export { nickForDiscordId } from './lobby-identity.js';
export {} from // register-lobby-source public API used by register-lobby command
'./register-lobby-source.js';
export {} from // lobby-balance / ocr exports used externally
'./lobby-balance.js';
```

Fill `register-lobby-source` / `lobby-ocr` / `lobby-balance` exports by grepping command imports. Same pattern for `match/index.ts`, `rating/index.ts`, `player/index.ts`, `leaderboard/index.ts`, `wc3stats/index.ts`, `guild/index.ts`.

- [ ] **Step 4: Update external consumers to barrel paths**

Example for `src/events/interaction-create.ts` — leave handlers paths until Task 5.

Example for a command:

```typescript
// before
import { addLobbyPlayer } from '../../services/lobby-actions.js';
// after
import { addLobbyPlayer } from '../../services/lobby/index.js';
```

- [ ] **Step 5: Verify compile + tests**

```bash
npx tsc --noEmit
npm test
```

Expected: TypeScript OK; Vitest all pass (same counts as before the move).

- [ ] **Step 6: Commit**

```bash
git add -A src/services src/commands src/handlers src/events
git status # ensure no leftover src/services/*.ts at top level
git commit -m "$(cat <<'EOF'
refactor: group services into domain folders

EOF
)"
```

---

### Task 3: Phase 2 — Extract `roster.ts` from `lobby-actions`

**Files:**

- Create: `src/services/lobby/roster.ts`
- Modify: `src/services/lobby/lobby-actions.ts` (import from roster; delete moved bodies)
- Modify: `src/services/lobby/index.ts` (re-export roster symbols from `./roster.js` instead of actions if desired)
- Test: existing `src/services/lobby/lobby-claim.test.ts` and any tests importing roster helpers

**Interfaces:**

- Produces (move **unchanged** bodies from lobby-actions):
  - `addPlayer(players, nickRaw, slot): LobbyPlayer[]`
  - `removePlayer(...)`
  - `movePlayer(...)`
  - `swapPlayers(...)`
  - `editPlayerNick(...)`
  - `rosterAfterClaim(...)`
  - `rosterAfterLeave(...)`
  - internal `assertSlotInRange` stays private in `roster.ts`

- [ ] **Step 1: Create `roster.ts` by cutting pure functions from `lobby-actions.ts`**

Move these exports and their local helpers/constants (`MIN_SLOT`, `MAX_SLOT`, messages used only by them) into `roster.ts`. Import `LobbyPlayer` from `./lobby-ocr.js` and `normalizeNick` from `../player/player-nick.js` as lobby-actions already does.

- [ ] **Step 2: Update `lobby-actions.ts` to import from `./roster.js`**

```typescript
import {
  addPlayer,
  removePlayer,
  movePlayer,
  swapPlayers,
  editPlayerNick,
  rosterAfterClaim,
  rosterAfterLeave,
} from './roster.js';

export {
  addPlayer,
  removePlayer,
  movePlayer,
  swapPlayers,
  editPlayerNick,
  rosterAfterClaim,
  rosterAfterLeave,
} from './roster.js';
```

(Or stop re-exporting from actions and point the barrel at `roster.js` directly — prefer barrel + actions importing roster only.)

- [ ] **Step 3: Point lobby barrel roster exports at `./roster.js`**

- [ ] **Step 4: Run tests**

```bash
npm test -- src/services/lobby
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/lobby/roster.ts src/services/lobby/lobby-actions.ts src/services/lobby/index.ts
git commit -m "$(cat <<'EOF'
refactor: extract lobby roster helpers from lobby-actions

EOF
)"
```

---

### Task 4: Phase 2 — Extract resolve, lifecycle, discord-sync, wc3stats-refresh, actions

**Files:**

- Create: `src/services/lobby/resolve.ts`
- Create: `src/services/lobby/lifecycle.ts`
- Create: `src/services/lobby/discord-sync.ts`
- Create: `src/services/lobby/wc3stats-refresh.ts`
- Create: `src/services/lobby/actions.ts`
- Delete: `src/services/lobby/lobby-actions.ts`
- Modify: `src/services/lobby/index.ts`
- Modify tests that import from `./lobby-actions.js` → `./index.js` or concrete modules

**Interfaces (preserve signatures exactly):**

From **resolve.ts**:

- `resolveHostPendingMatch(input: ResolveHostPendingMatchInput): Promise<MatchWithPlayers>`
- `resolvePendingMatchByMessageId(...)`
- `resolveInProgressMatchByMessageId(...)`
- `resolveHostPendingMatchByMessageId(...)`
- types: `ResolveHostPendingMatchInput`, ownership helpers as needed

From **lifecycle.ts**:

- `startLobbyMatch`, `startLobbyMatchByMessageId`, `cancelLobbyMatch`

From **discord-sync.ts**:

- `LobbySyncMode`, `syncLobbyDiscordMessage`, `applyRosterAndSync` (export apply if tests need it; else keep package-private by not exporting)

From **wc3stats-refresh.ts**:

- `RefreshLobbyResult`, `refreshLobbyFromWc3stats`, private `importAndMaybeLinkWc3stats`, `refreshResultMessage`

From **actions.ts**:

- `LobbyActionResult`
- `assertLobbyPlayerClaimEnabled`
- `addLobbyPlayer`, `addLobbyPlayerFromDiscord`, `claimLobbySlot`, `leaveLobbySlot`
- `removeLobbyPlayer`, `moveLobbyPlayer`, `swapLobbyPlayers`, `editLobbyPlayerNick`
- `applyRosterUpdateForMessage`

**Import graph (avoid cycles):**

```
roster ← actions
resolve ← actions, lifecycle, wc3stats-refresh
discord-sync ← actions, lifecycle, wc3stats-refresh
match/*, rating/*, guild/*, player/*, wc3stats/*, lobby-preview ← as today
```

`discord-sync` must **not** import `actions.ts`. `actions` may import `discord-sync` + `roster` + `resolve`.

- [ ] **Step 1: Extract `resolve.ts`** (cut+paste bodies; fix imports)

- [ ] **Step 2: Extract `discord-sync.ts`**

- [ ] **Step 3: Extract `lifecycle.ts`**

- [ ] **Step 4: Extract `wc3stats-refresh.ts`**

- [ ] **Step 5: Move remaining orchestrators into `actions.ts`; delete `lobby-actions.ts`**

- [ ] **Step 6: Rewrite `src/services/lobby/index.ts`**

```typescript
export type { LobbyPlayer } from './lobby-ocr.js';
export type {
  LobbyActionResult,
  RefreshLobbyResult,
  LobbySyncMode,
  ResolveHostPendingMatchInput,
} from './actions.js'; // or from the files that own the types
export {
  addPlayer,
  removePlayer,
  movePlayer,
  swapPlayers,
  editPlayerNick,
  rosterAfterClaim,
  rosterAfterLeave,
} from './roster.js';
export {
  resolveHostPendingMatch,
  resolvePendingMatchByMessageId,
  resolveInProgressMatchByMessageId,
  resolveHostPendingMatchByMessageId,
} from './resolve.js';
export { syncLobbyDiscordMessage } from './discord-sync.js';
export { startLobbyMatch, startLobbyMatchByMessageId, cancelLobbyMatch } from './lifecycle.js';
export { refreshLobbyFromWc3stats } from './wc3stats-refresh.js';
export {
  assertLobbyPlayerClaimEnabled,
  addLobbyPlayer,
  addLobbyPlayerFromDiscord,
  claimLobbySlot,
  leaveLobbySlot,
  removeLobbyPlayer,
  moveLobbyPlayer,
  swapLobbyPlayers,
  editLobbyPlayerNick,
  applyRosterUpdateForMessage,
} from './actions.js';
// plus preview / identity / register-lobby-source / balance / ocr as in Task 2
```

Place each type export next to its defining module (`LobbySyncMode` from `discord-sync.ts`, `RefreshLobbyResult` from `wc3stats-refresh.ts`, etc.).

- [ ] **Step 7: Update tests**

```typescript
// lobby-claim.test.ts — before
import { ... } from './lobby-actions.js';
// after
import { ... } from './index.js';
```

- [ ] **Step 8: Verify line counts and tests**

```bash
wc -l src/services/lobby/{roster,resolve,lifecycle,discord-sync,wc3stats-refresh,actions}.ts
# each should be well under ~400 lines (target from spec)
npx tsc --noEmit
npm test
```

Expected: PASS; no `lobby-actions.ts` left.

- [ ] **Step 9: Commit**

```bash
git add src/services/lobby
git commit -m "$(cat <<'EOF'
refactor: split lobby-actions into focused lobby modules

EOF
)"
```

---

### Task 5: Phase 3 — Move interaction handlers + update Cursor rules

**Files:**

- Create dir: `src/discord/interactions/`
- Move: `src/handlers/lobby-interactions.ts` → `src/discord/interactions/lobby-interactions.ts`
- Move: `src/handlers/match-interactions.ts` → `src/discord/interactions/match-interactions.ts`
- Move: `src/handlers/leaderboard-interactions.ts` → `src/discord/interactions/leaderboard-interactions.ts`
- Modify: `src/events/interaction-create.ts`
- Modify: imports inside the three interaction files (`../services` → `../../services/...`)
- Modify: `.cursor/rules/project-structure.mdc`
- Modify: `.cursor/rules/shared-domain-logic.mdc`

**Interfaces:**

- Produces (unchanged signatures):
  - `handleLobbyInteraction(interaction): Promise<boolean>`
  - `handleMatchInteraction(interaction): Promise<boolean>`
  - `handleLeaderboardInteraction(interaction): Promise<boolean>`

- [ ] **Step 1: Create directory and git mv**

```bash
mkdir -p src/discord/interactions
git mv src/handlers/lobby-interactions.ts src/discord/interactions/
git mv src/handlers/match-interactions.ts src/discord/interactions/
git mv src/handlers/leaderboard-interactions.ts src/discord/interactions/
```

- [ ] **Step 2: Fix imports inside moved interaction files**

- `../services/...` → `../../services/<domain>/index.js` (or concrete)
- `../lib/...` → `../../lib/...`
- `../config/...` → `../../config/...`

- [ ] **Step 3: Update `src/events/interaction-create.ts`**

```typescript
import { handleLeaderboardInteraction } from '../discord/interactions/leaderboard-interactions.js';
import { handleLobbyInteraction } from '../discord/interactions/lobby-interactions.js';
import { handleMatchInteraction } from '../discord/interactions/match-interactions.js';
```

- [ ] **Step 4: Confirm `handlers/` only has bootstrap**

```bash
ls src/handlers
# expect: load-commands.ts load-events.ts register-commands.ts
```

- [ ] **Step 5: Update `.cursor/rules/project-structure.mdc`**

Replace the tree with:

```
src/
├── index.ts
├── deploy-commands.ts
├── config/env.ts
├── lib/prisma.ts
├── client/create-client.ts
├── types/command.ts
├── handlers/                 # load-commands, load-events, register-commands
├── discord/interactions/     # lobby, match, leaderboard button/modal adapters
├── commands/                 # slash commands by domain
├── events/
└── services/                 # domain folders: lobby, match, rating, player, leaderboard, wc3stats, guild
```

- [ ] **Step 6: Update `.cursor/rules/shared-domain-logic.mdc`**

- Rule 1: extract use-cases into `src/services/<domain>/`
- Rule 5 / closing: mention `discord/interactions/` instead of only `lobby-interactions.ts` under handlers
- Example imports may use `services/lobby`

- [ ] **Step 7: Verify**

```bash
npx tsc --noEmit
npm test
```

Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/discord src/handlers src/events .cursor/rules/project-structure.mdc .cursor/rules/shared-domain-logic.mdc
git commit -m "$(cat <<'EOF'
refactor: move Discord interactions under discord/interactions

EOF
)"
```

---

### Task 6: Final verification against success criteria

**Files:** none new

- [ ] **Step 1: Structure checks**

```bash
# no flat service modules left at services root (only domain dirs)
ls src/services
# expect: guild leaderboard lobby match player rating wc3stats

test ! -e src/services/lobby/lobby-actions.ts
test ! -e src/domain
ls src/handlers
# bootstrap only
ls src/discord/interactions
```

- [ ] **Step 2: Full test + typecheck**

```bash
npx tsc --noEmit
npm test
```

Expected: clean

- [ ] **Step 3: Optional smoke**

If a Discord token/env is available locally: `npm run dev` and confirm ready log without import errors. Skip if no credentials.

- [ ] **Step 4: No commit required unless fixes were needed**

---

## Self-review (plan vs spec)

| Spec item                                      | Task                      |
| ---------------------------------------------- | ------------------------- |
| Domain folders under services                  | Task 1–2                  |
| Keep basenames                                 | Task 1                    |
| Barrels for public API                         | Task 2                    |
| Delete empty `src/domain/`                     | Task 1                    |
| Split lobby-actions modules                    | Task 3–4                  |
| Same export names                              | Task 3–4                  |
| Interactions → `discord/interactions/`         | Task 5                    |
| handlers = bootstrap only                      | Task 5                    |
| Update project-structure + shared-domain-logic | Task 5                    |
| No behavior change / tests pass                | Tasks 2, 4, 5, 6          |
| No match-service / lobby-preview deep split    | Out of scope (not tasked) |
| No path aliases                                | Global constraints        |

**Placeholder scan:** none intentional. Barrel export lists in Task 2 must be completed via `rg` inventory during implementation (the plan shows the method and the lobby-actions symbol list).
