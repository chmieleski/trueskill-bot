# New-player rating isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let host/mod mark true first-timers as New so they are excluded from team OpenSkill `rate()` (μ/σ freeze) until 5 completed games, while quit synthetics still apply and veterans keep rating among themselves.

**Architecture:** League-scoped `PlayerRating.isNewPlayer` plus per-match `MatchPlayer.wasNewPlayer` snapshot. `partitionRosterForRating` gains a third bucket (`activeRateable`); `applyMatchRatings` / `simulatePostMatchRatings` skip team `rate()` when either side has zero rateable humans. Lobby claim/add returns optional suggest payloads; Discord buttons confirm via `canManageMatch`.

**Tech Stack:** TypeScript ESM, Prisma, OpenSkill, discord.js v14, Vitest

**Spec:** `docs/superpowers/specs/2026-08-22-new-player-rating-isolation-design.md`

**Worktree:** `/home/lesk/www/bot/.worktrees/feat-new-player-rating` on branch `feat/new-player-rating`

## Global Constraints

- Scope: `general` (keyed by `leagueId`; no WC3-only imports in rating core)
- English-only user-facing strings
- Public score is **ki**; never raw μ on embeds
- Unmarked calibrating players rate normally
- New non-quit: freeze μ/σ; games still count toward 5
- New quitters: synthetic quit penalty still applies
- Degenerate rateable roster: **skip** team `rate()` (do not throw); quit synthetics still run
- Completing a match still requires both teams have ≥1 **non-quitter** (`assertBothTeamsHaveActivePlayers` on non-quitters unchanged)
- Correction / flip re-apply uses `MatchPlayer.wasNewPlayer`, not live `isNewPlayer`
- No new production env / SSM keys
- ESM imports use `.js` extension; named exports
- Conventional Commits on this branch

## File map

| File | Role |
| ---- | ---- |
| `prisma/schema.prisma` | `PlayerRating.isNewPlayer`, `MatchPlayer.wasNewPlayer` |
| `prisma/migrations/<ts>_new_player_rating_isolation/` | SQL migration |
| `src/services/rating/new-player.ts` | Flag mark/clear, suggest eligibility, button custom ids, label |
| `src/services/rating/new-player.test.ts` | Unit tests for pure helpers |
| `src/services/rating/rating-update.ts` | Partition + skip/freeze in apply + simulate |
| `src/services/rating/rating-update.test.ts` | Partition / skip / freeze tests |
| `src/services/rating/rating-update.simulate.test.ts` | Simulate freeze regression |
| `src/services/rating/index.ts` | Re-exports |
| `src/services/match/match-report.ts` | Snapshot `wasNewPlayer`; pass into entries; clear flags after count |
| `src/services/match/match-correction.ts` | Pass `wasNewPlayer` from stored rows into entries |
| `src/services/match/match-history-preview.ts` | Pass `wasNewPlayer` into simulate entries |
| `src/services/lobby/discord-sync.ts` | Optional `newPlayerSuggestions` on `LobbyActionResult` |
| `src/services/lobby/actions.ts` / claim paths | Populate suggestions after roster sync |
| `src/services/lobby/lobby-preview.ts` | **New** roster marker |
| `src/services/rating/rating-preview.ts` | Carry `isNewPlayer` / `wasNewPlayer` on preview lines |
| `src/discord/interactions/new-player-interactions.ts` | Confirm / decline buttons |
| `src/discord/interactions/lobby-interactions.ts` | Emit suggest after claim/add; route buttons |
| `.cursor/rules/openskill-rating.mdc` | Document New isolation |

---

### Task 1: Schema — `isNewPlayer` / `wasNewPlayer`

**Files:**

- Modify: `prisma/schema.prisma` (`PlayerRating`, `MatchPlayer`)
- Create: `prisma/migrations/20260822190000_new_player_rating_isolation/migration.sql`

**Interfaces:**

- Produces: Prisma fields `PlayerRating.isNewPlayer Boolean @default(false)`, `MatchPlayer.wasNewPlayer Boolean @default(false)`

- [ ] **Step 1: Add fields to schema**

On `PlayerRating`, after `sigma`:

```prisma
  isNewPlayer Boolean  @default(false)
```

On `MatchPlayer`, after `isGriffer`:

```prisma
  wasNewPlayer Boolean @default(false) // Snapshot of PlayerRating.isNewPlayer at rating apply
```

- [ ] **Step 2: Add migration SQL**

```sql
-- AlterTable
ALTER TABLE "PlayerRating" ADD COLUMN "isNewPlayer" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "MatchPlayer" ADD COLUMN "wasNewPlayer" BOOLEAN NOT NULL DEFAULT false;
```

- [ ] **Step 3: Generate client**

Run: `npx prisma generate`  
Expected: client includes both fields

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260822190000_new_player_rating_isolation
git commit -m "$(cat <<'EOF'
feat(rating): add isNewPlayer and wasNewPlayer columns

EOF
)"
```

---

### Task 2: Pure new-player helpers

**Files:**

- Create: `src/services/rating/new-player.ts`
- Create: `src/services/rating/new-player.test.ts`
- Modify: `src/services/rating/index.ts` (export new symbols)

**Interfaces:**

- Produces:
  - `NEW_PLAYER_LABEL = 'New'` (roster suffix rendered as ` · New`)
  - `NEW_PLAYER_PROMPT_PREFIX = 'np:'`
  - `shouldSuggestNewPlayer(completedGames: number, isAlreadyNew: boolean): boolean` — `completedGames === 0 && !isAlreadyNew`
  - `shouldClearNewPlayer(completedGamesAfterMatch: number): boolean` — `completedGamesAfterMatch >= 5` (use `KI_Z_BLEND_GAMES` from `rating-math.ts`)
  - `buildNewPlayerConfirmCustomId(matchId, leagueId, playerId, actorDiscordId): string`
  - `buildNewPlayerDeclineCustomId(matchId, leagueId, playerId, actorDiscordId): string`
  - `parseNewPlayerButtonCustomId(customId: string): { action: 'confirm' | 'decline'; matchId: string; leagueId: string; playerId: string; actorDiscordId: string } | null`
  - Custom id format: `np:confirm:<matchId>:<leagueId>:<playerId>:<actorDiscordId>` / `np:decline:...` (same shape as rank-reset buttons)

- [ ] **Step 1: Write failing tests**

```typescript
import { describe, expect, it } from 'vitest';
import { KI_Z_BLEND_GAMES } from './rating-math.js';
import {
  parseNewPlayerButtonCustomId,
  buildNewPlayerConfirmCustomId,
  shouldClearNewPlayer,
  shouldSuggestNewPlayer,
} from './new-player.js';

describe('shouldSuggestNewPlayer', () => {
  it('suggests only at 0 games when not already new', () => {
    expect(shouldSuggestNewPlayer(0, false)).toBe(true);
    expect(shouldSuggestNewPlayer(0, true)).toBe(false);
    expect(shouldSuggestNewPlayer(1, false)).toBe(false);
  });
});

describe('shouldClearNewPlayer', () => {
  it('clears at the calibrating threshold', () => {
    expect(shouldClearNewPlayer(KI_Z_BLEND_GAMES - 1)).toBe(false);
    expect(shouldClearNewPlayer(KI_Z_BLEND_GAMES)).toBe(true);
  });
});

describe('new player button custom ids', () => {
  it('round-trips confirm', () => {
    const id = buildNewPlayerConfirmCustomId('m1', 'l1', 'p1', 'd1');
    expect(parseNewPlayerButtonCustomId(id)).toEqual({
      action: 'confirm',
      matchId: 'm1',
      leagueId: 'l1',
      playerId: 'p1',
      actorDiscordId: 'd1',
    });
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL**

Run: `npx vitest run src/services/rating/new-player.test.ts`  
Expected: FAIL (module missing)

- [ ] **Step 3: Implement `new-player.ts`**

Implement the helpers above. Reject malformed custom ids with `null`. Do not put Discord.js imports in this file.

- [ ] **Step 4: Run tests — expect PASS**

Run: `npx vitest run src/services/rating/new-player.test.ts`  
Expected: PASS

- [ ] **Step 5: Export from `src/services/rating/index.ts`**

- [ ] **Step 6: Commit**

```bash
git add src/services/rating/new-player.ts src/services/rating/new-player.test.ts src/services/rating/index.ts
git commit -m "$(cat <<'EOF'
feat(rating): add new-player suggest and clear helpers

EOF
)"
```

---

### Task 3: Partition + simulate/apply exclude New

**Files:**

- Modify: `src/services/rating/rating-update.ts`
- Modify: `src/services/rating/rating-update.test.ts`
- Modify: `src/services/rating/rating-update.simulate.test.ts`

**Interfaces:**

- Consumes: `wasNewPlayer` on roster entries
- Produces:
  - Extend `RatingRosterEntry` with `wasNewPlayer?: boolean` (default treat missing as `false`)
  - `partitionRosterForRating` returns `{ quitters, newNonQuit, activeRateable }`  
    - `quitters = isQuitter`  
    - `newNonQuit = !isQuitter && wasNewPlayer`  
    - `activeRateable = !isQuitter && !wasNewPlayer`
  - Keep deprecated alias: `active` = `[...newNonQuit, ...activeRateable]` **only if** existing callers need non-quitters; prefer updating callers. Spec: team `rate()` uses `activeRateable` only.
  - `canRunTeamRate(activeRateable: { team: 1|2 }[]): boolean` — both teams have length ≥ 1
  - `applyMatchRatings` / `simulatePostMatchRatings`: if `!canRunTeamRate(activeRateable)` → skip team `rate()` and lobby scale (no throw); still do not update `newNonQuit` μ/σ

**Important:** Do **not** change `assertBothTeamsHaveActivePlayers` semantics for match completion (still: both teams need ≥1 non-quitter). Only the **rateable** empty case skips inside apply/simulate.

- [ ] **Step 1: Write failing partition / simulate tests**

```typescript
describe('partitionRosterForRating', () => {
  it('puts non-quit New into newNonQuit and veterans into activeRateable', () => {
    const { quitters, newNonQuit, activeRateable } = partitionRosterForRating([
      { slot: 1, isQuitter: false, wasNewPlayer: true },
      { slot: 2, isQuitter: false, wasNewPlayer: false },
      { slot: 7, isQuitter: true, wasNewPlayer: true },
    ]);
    expect(newNonQuit.map((e) => e.slot)).toEqual([1]);
    expect(activeRateable.map((e) => e.slot)).toEqual([2]);
    expect(quitters.map((e) => e.slot)).toEqual([7]);
  });
});

describe('simulatePostMatchRatings with New', () => {
  it('freezes New non-quit μ and still rates veterans', () => {
    // 1 New + 1 vet each side; New start μ 25; vet high μ
    // after simulate: New global μ unchanged; vet μ moved
  });

  it('skips team rate when both sides are only New (quitters optional)', () => {
    // all wasNewPlayer non-quit → starting maps unchanged for everyone on team path
  });
});
```

Fill the simulate cases with concrete maps like existing `rating-update.simulate.test.ts`.

- [ ] **Step 2: Run tests — expect FAIL**

Run: `npx vitest run src/services/rating/rating-update.test.ts src/services/rating/rating-update.simulate.test.ts`  
Expected: FAIL on new assertions / missing return fields

- [ ] **Step 3: Implement partition + wire apply/simulate**

Update `partitionRosterForRating`:

```typescript
export function partitionRosterForRating<
  T extends { isQuitter: boolean; wasNewPlayer?: boolean },
>(entries: T[]): { quitters: T[]; newNonQuit: T[]; activeRateable: T[] } {
  const quitters = entries.filter((e) => e.isQuitter);
  const nonQuit = entries.filter((e) => !e.isQuitter);
  return {
    quitters,
    newNonQuit: nonQuit.filter((e) => e.wasNewPlayer === true),
    activeRateable: nonQuit.filter((e) => e.wasNewPlayer !== true),
  };
}
```

In `applyMatchRatings` and `simulatePostMatchRatings`:

1. `const { activeRateable } = partitionRosterForRating(sorted)`
2. If `!canRunTeamRate(activeRateable)` → return early from the team-rate section (simulate: leave non-quit New untouched; quitters already handled earlier in simulate)
3. Else existing `rate()` + lobby scale on `activeRateable` only
4. Update existing tests that destructure `{ active }` to use `activeRateable` or `newNonQuit` as appropriate

Update `applyMatchRatings` so it does **not** call `assertBothTeamsHaveActivePlayers(activeRateable)` — match-report already asserted on non-quitters. Empty rateable → skip.

- [ ] **Step 4: Run tests — expect PASS**

Run: `npx vitest run src/services/rating/rating-update.test.ts src/services/rating/rating-update.simulate.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/rating/rating-update.ts src/services/rating/rating-update.test.ts src/services/rating/rating-update.simulate.test.ts
git commit -m "$(cat <<'EOF'
feat(rating): exclude New players from team OpenSkill rate

EOF
)"
```

---

### Task 4: Snapshot `wasNewPlayer` + clear flag on complete/correct

**Files:**

- Modify: `src/services/match/match-report.ts`
- Modify: `src/services/match/match-correction.ts`
- Modify: `src/services/match/match-history-preview.ts`
- Create or extend: `src/services/rating/new-player.ts` with DB helpers:
  - `loadIsNewPlayerByPlayerId(leagueId, playerIds, db): Promise<Map<string, boolean>>`
  - `clearNewPlayerFlagsIfEligible(leagueId, playerIds, db): Promise<void>` — after match W/L rows exist, load `gamesByPlayerFromStats`, for each id with `shouldClearNewPlayer(games)` set `isNewPlayer: false`

**Interfaces:**

- Consumes: `PlayerRating.isNewPlayer`, partition from Task 3
- Produces: `MatchPlayer.wasNewPlayer` written before/at apply; `RatingRosterEntry.wasNewPlayer` set from DB flag (report) or stored snapshot (correction / history)

- [ ] **Step 1: Write failing unit test for clear helper**

In `new-player.test.ts` (pure) already covered `shouldClearNewPlayer`. Add a focused test file or extend match-report tests with mocked `db.playerRating.updateMany` if the project already mocks Prisma that way; otherwise test `clearNewPlayerFlagsIfEligible` with a small in-memory fake:

```typescript
it('clears isNewPlayer when after-match games >= 5', async () => {
  // fake db + stub loadMatchDisplayStatsByPlayer via dependency injection
  // OR keep clear logic inline in match-report and cover via shouldClearNewPlayer only
});
```

Prefer implementing `clearNewPlayerFlagsIfEligible` in `new-player.ts` taking `gamesByPlayer: Map<string, number>` to stay pure:

```typescript
export function playerIdsToClearNewFlag(
  playerIds: string[],
  gamesByPlayer: Map<string, number>,
): string[] {
  return playerIds.filter((id) => shouldClearNewPlayer(gamesByPlayer.get(id) ?? 0));
}
```

- [ ] **Step 2: Implement pure `playerIdsToClearNewFlag` + tests PASS**

- [ ] **Step 3: Wire `match-report.ts` complete path**

Inside the complete transaction, after players are known:

1. `ensurePlayerRatings` (already)
2. `loadIsNewPlayerByPlayerId` for all `match.players`
3. When updating each `matchPlayer`, set `wasNewPlayer: isNewMap.get(player.playerId) === true`
4. Build `entries` with `wasNewPlayer` from that map (update `toRatingEntries` signature)
5. After `applyMatchRatings` + match status COMPLETED, reload display stats (already done), then:

```typescript
const clearIds = playerIdsToClearNewFlag(
  match.players.map((p) => p.playerId),
  gamesByPlayerFromStats(displayStats),
);
if (clearIds.length > 0) {
  await tx.playerRating.updateMany({
    where: { leagueId: match.leagueId, playerId: { in: clearIds }, isNewPlayer: true },
    data: { isNewPlayer: false },
  });
}
```

Note: `displayStats` after completion must include the match just written (same as calibrating reveal).

- [ ] **Step 4: Wire correction + history preview**

- `match-correction.ts` `toRatingEntries`: `wasNewPlayer: player.wasNewPlayer`
- `match-history-preview.ts`: pass `wasNewPlayer: player.wasNewPlayer` into simulate entries
- On correction re-apply, do **not** re-snapshot from live `isNewPlayer`; keep stored `wasNewPlayer`. Still run clear-flag using **current** after-match games if desired — only clear live flag; do not rewrite historical `wasNewPlayer`.

- [ ] **Step 5: Run related tests**

Run: `npx vitest run src/services/match/match-report.test.ts src/services/match/match-correction.test.ts src/services/match/match-history-preview.test.ts src/services/rating/new-player.test.ts`  
Expected: PASS (update any entry factories to include `wasNewPlayer: false`)

- [ ] **Step 6: Commit**

```bash
git add src/services/match/match-report.ts src/services/match/match-correction.ts src/services/match/match-history-preview.ts src/services/rating/new-player.ts src/services/rating/new-player.test.ts
git commit -m "$(cat <<'EOF'
feat(match): snapshot wasNewPlayer and clear New after five games

EOF
)"
```

---

### Task 5: Suggest eligibility after roster sync

**Files:**

- Modify: `src/services/lobby/discord-sync.ts`
- Modify: `src/services/lobby/actions.ts` (and any other path that calls `applyRosterAndSync` for PENDING adds — claim, host add Discord, host add nick)
- Create tests: `src/services/lobby/new-player-suggest.test.ts` (or extend `lobby-claim.test.ts`)

**Interfaces:**

- Produces on `LobbyActionResult`:

```typescript
newPlayerSuggestions?: Array<{
  playerId: string;
  username: string;
  leagueId: string;
  matchId: string;
}>;
```

- Helper (in `new-player.ts` or lobby module):

```typescript
export async function collectNewPlayerSuggestions(input: {
  leagueId: string;
  matchId: string;
  previousPlayerIds: Set<string>;
  nextPlayers: Array<{ playerId: string; username: string }>;
  db?: Db;
}): Promise<LobbyActionResult['newPlayerSuggestions']>
```

Logic: for each `next` playerId not in `previousPlayerIds` (newly seated), load completed games via `loadMatchDisplayStatsByPlayer` + `gamesByPlayerFromStats`, load `isNewPlayer`, if `shouldSuggestNewPlayer(games, isNew)` include them. Cap: one entry per playerId.

- [ ] **Step 1: Write failing test for collect helper**

Mock/stub games=0 → suggestion; games=1 → none; already new → none.

- [ ] **Step 2: Implement collect helper**

- [ ] **Step 3: Thread through `applyRosterAndSync`**

`applyRosterAndSync` today replaces roster then rebuilds embed. Extend signature to accept optional `previousPlayerIds` **or** compute suggestions in each action after sync by diffing:

Prefer actions:

```typescript
const beforeIds = new Set(match.players.map((p) => p.playerId));
const result = await applyRosterAndSync(...);
const suggestions = await collectNewPlayerSuggestions({
  leagueId: result.match.leagueId,
  matchId: result.match.id,
  previousPlayerIds: beforeIds,
  nextPlayers: result.match.players.map((p) => ({
    playerId: p.playerId,
    username: p.player.username,
  })),
});
return { ...result, newPlayerSuggestions: suggestions };
```

Apply on: `claimLobbySlot`, `addLobbyPlayer`, `addLobbyPlayerFromDiscord`.  
Skip on remove/move/swap/leave (no new seat).  
OCR/wc3stats bulk replace: if it goes through `applyRosterAndSync` / `replaceMatchRoster`, add the same diff there in a follow-up step inside this task (search callers of `replaceMatchRoster` / `applyRosterAndSync`).

- [ ] **Step 4: Tests PASS + commit**

```bash
git commit -m "$(cat <<'EOF'
feat(lobby): detect first-timers for New-player suggest

EOF
)"
```

---

### Task 6: Discord confirm/decline + emit suggest

**Files:**

- Create: `src/discord/interactions/new-player-interactions.ts`
- Create: `src/discord/interactions/new-player-interactions.test.ts` (custom id / auth unit tests where possible)
- Modify: interaction router (find where `handleLobbyInteraction` / `rank-reset` buttons are registered — typically `src/index.ts` or `src/discord/interactions/*.ts` entry) to call `handleNewPlayerButton`
- Modify: `src/discord/interactions/lobby-interactions.ts` after successful claim/add: if `newPlayerSuggestions?.length`, `replyEphemeral` (or followUp) to the **actor** is wrong for claim — spec says host/mod. Prefer: post ephemeral to the interaction only when actor `canManageMatch`; otherwise `followUp` in channel mentioning host is noisy. **v1 rule:** send the button prompt as an **ephemeral reply/followUp only if** `canManageMatch(actor)`; if a player claims themselves, **DM is out** — instead edit nothing and `channel.send` a short host-facing message with buttons bound to `match.hostDiscordId` as `actorDiscordId` in the custom id… Spec: “Audience: host and match-mod”. Simplest v1:

  - Custom id stores `hostDiscordId` as the allowed actor **or** allow any `canManageMatch` at click time (better).
  - Prefer **authorize on click** with `assertCanManageMatch` using current host + mod role (ignore actorDiscordId in id except for “not your prompt” spam control). Match rank-reset pattern: bind `actorDiscordId` of who received the prompt; for claim-by-player, set `actorDiscordId` to `match.hostDiscordId` and send the components via `channel.send` pinging the host once.

**Practical v1 (lock this):**

1. Build components with `actorDiscordId = match.hostDiscordId` (host must click; mods: allow click if `canManageMatch` even when actor id is host — on click, if `canManageMatch`, accept; if custom id actor is host, mods still OK via `canManageMatch`).
2. After claim/add with suggestions, if interaction is host/mod → ephemeral with buttons; else → `interaction.followUp` public short message: `Mark **username** as New? (host/mod)` + buttons.

- [ ] **Step 1: Implement `buildNewPlayerSuggestComponents` + handlers**

Confirm handler:

```typescript
await assertCanManageMatch({ hostDiscordId: match.hostDiscordId, actorDiscordId: interaction.user.id, memberRoleIds, matchModRoleId });
await prisma.playerRating.upsert / update { isNewPlayer: true } // ensure row exists via ensurePlayerRatings first
await interaction.editReply / update — "Marked username as New. They will not affect team ratings until 5 games."
```

Decline: update message to “Kept normal rating for username.”

- [ ] **Step 2: Wire lobby-interactions to show prompt when suggestions non-empty**

- [ ] **Step 3: Register button handler in the global interaction switch** (`customId.startsWith('np:')`)

- [ ] **Step 4: Manual sanity + unit tests for parse/auth; commit**

```bash
git commit -m "$(cat <<'EOF'
feat(discord): New-player confirm buttons for first-timers

EOF
)"
```

---

### Task 7: Roster / preview **New** marker

**Files:**

- Modify: `src/services/rating/rating-preview.ts` — add `isNewPlayer?: boolean` on lobby lines; load from `PlayerRating`
- Modify: `src/services/lobby/lobby-preview.ts` — append ` NEW_PLAYER_MARKER` (or ` · New`) beside quit/griffer marks when `player.isNewPlayer || player.wasNewPlayer`
- Modify: completed embed path to pass `wasNewPlayer` from `MatchPlayer`
- Tests: `lobby-preview.test.ts`

- [ ] **Step 1: Failing test — roster line contains New marker**

```typescript
it('appends New marker when isNewPlayer', () => {
  const line = /* format team lines with isNewPlayer: true */;
  expect(line).toContain('New'); // or the chosen marker constant
});
```

- [ ] **Step 2: Implement display wiring**

Use a text marker ` New` (English word) after the code fence / beside 🚪 to avoid emoji-only UX if `NEW_PLAYER_MARKER` feels wrong — **lock:** roster suffix ` · New` (plain English), constant `NEW_PLAYER_LABEL = 'New'` in `new-player.ts`; deprecate emoji if added earlier.

- [ ] **Step 3: Tests PASS + commit**

```bash
git commit -m "$(cat <<'EOF'
feat(lobby): show New marker on isolated first-timers

EOF
)"
```

---

### Task 8: Docs — OpenSkill rule + spec status

**Files:**

- Modify: `.cursor/rules/openskill-rating.mdc` — add edge-case row for **New player isolation** summarizing freeze / skip / quit / clear@5
- Modify: `docs/superpowers/specs/2026-08-22-new-player-rating-isolation-design.md` — set **Status:** Implemented (when code lands; during plan execution set at end)

- [ ] **Step 1: Update openskill-rating.mdc edge cases table**

- [ ] **Step 2: Commit**

```bash
git commit -m "$(cat <<'EOF'
docs: document New-player rating isolation rules

EOF
)"
```

---

### Task 9: Full regression gate

- [ ] **Step 1: Copy `.env` into worktree if missing** (local only; never commit) so vitest can import `env.ts`

- [ ] **Step 2: Run**

```bash
npx vitest run src/services/rating src/services/match/match-report.test.ts src/services/match/match-correction.test.ts src/services/lobby/lobby-preview.test.ts src/discord/interactions/new-player-interactions.test.ts
```

Expected: PASS

- [ ] **Step 3: `npx tsc --noEmit`** (or `npm run build`)  
Expected: PASS

---

## Spec coverage checklist

| Spec requirement | Task |
| ---------------- | ---- |
| `PlayerRating.isNewPlayer` | 1 |
| `MatchPlayer.wasNewPlayer` snapshot | 1, 4 |
| Always exclude New from team `rate()` | 3 |
| Freeze New non-quit μ/σ | 3 |
| New quitters still synthetic | 3 (quitters bucket unchanged) |
| Skip team `rate()` if either rateable side empty | 3 |
| Keep complete assert on non-quitters | 3 note + existing match-report |
| Clear New at games ≥ 5 | 2, 4 |
| Unmarked calibrating rates normally | 3 (`wasNewPlayer` false) |
| Auto-suggest at 0 games | 5, 6 |
| Host/mod confirm only | 6 |
| Decline → no flag | 6 |
| Roster New marker | 7 |
| Correction uses snapshot | 4 |
| openskill rule doc | 8 |

## Placeholder / consistency review

- Custom id prefix `np:` consistent across Tasks 2 and 6
- `wasNewPlayer` optional on `RatingRosterEntry`; missing ⇒ not New
- Display label locked to plain ` · New` in Task 7 (update Task 2 constant to `NEW_PLAYER_LABEL = 'New'` if emoji was drafted)
- No soft-dampen / balance-hint changes (spec non-goals)
