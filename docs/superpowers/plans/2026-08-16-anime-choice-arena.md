# Anime Choice Arena IHL Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a second IHL (`warcraft3_anime_choice_arena`) where lobby slots are 5v5 team seats only, Discord-only fill, and OpenSkill updates league-global ratings with `heroId` null.

**Architecture:** A code `GameProfile` keyed by `gameId` replaces hardcoded 12-slot / `heroId = slot` / Z Fighters / `ki` assumptions at runtime. Flavor (`ratingLabel`, `teamNames`) is per-game and editable in the catalog. UDBR keeps `slot_bound` + wc3stats + `ki` / Z Fighters / Evil. ACA v1 uses `ki` / Team A / Team B. Prisma only seeds the `Game` row and makes `MatchPlayer.heroId` nullable. Dual-entity `rate()` runs only when `heroId` is non-null.

**Tech Stack:** TypeScript ESM, Prisma, discord.js v14, Vitest, OpenSkill (existing `rating-update`)

**Spec:** `docs/superpowers/specs/2026-08-16-anime-choice-arena-design.md`

## Global Constraints

- Scope labels: `general` unless a task title says `game:warcraft3_anime_choice_arena`
- English-only user-facing strings and errors (copy locked in the spec)
- `gameId` `warcraft3_anime_choice_arena` is stable; never rename
- UDBR behavior stays: 12 slots, `heroId = slot`, dual-entity OpenSkill, wc3stats, `ratingLabel: ki`, Z Fighters / Evil **at runtime**
- ACA v1 flavor preset: `ratingLabel: ki`, Team A / Team B (change later by editing the ACA profile only)
- Global slash metadata unchanged: slot min/max 1–12; winner choice **names** stay Z Fighters / Evil
- No `GameHero` table; do not migrate global `Hero` / `PlayerHeroRating` FKs
- Do not land or depend on `feature/game-scoped-heroes`
- No new production env / SSM keys
- ESM imports use `.js` extension; named exports
- ACA v1 never writes `PlayerHeroRating`
- Unknown `gameId` throws; never fall back to UDBR

## File map

| File | Role |
|------|------|
| `src/domain/games.ts` | Add `WARCRAFT3_ANIME_CHOICE_ARENA_GAME_ID`; extend `KnownGameId` |
| `src/domain/game-profile.ts` | `GameProfile`, `getGameProfile`, `teamForSlot`, `rosterHeroId`, `isSlotInProfile`, `invalidSlotMessage` |
| `src/domain/game-profile.test.ts` | Profile + slot/team/heroId unit tests |
| `src/services/league/league-profile.ts` | `getGameProfileForLeague(leagueId)` |
| `prisma/schema.prisma` | `MatchPlayer.heroId Int?` |
| `prisma/migrations/20260816120000_anime_choice_arena/` | Seed Game + drop NOT NULL on `heroId` |
| `src/services/rating/rating-math.ts` | `splitRosterByTeam` uses `team` |
| `src/services/rating/rating-update.ts` | Global-only entities when `heroId` is null |
| `src/services/rating/rating-preview.ts` | Skip hero ensure/preview/balance hero when `heroId` is null |
| `src/services/match/match-service.ts` | Profile-based slots, team, heroId, catalog assert |
| `src/services/match/match-correction.ts` | GLOBAL-only snapshots when `heroId` is null |
| `src/services/lobby/roster.ts` | Slot range from profile |
| `src/services/lobby/lobby-balance.ts` | Profile slotCount; no hero entity / no `heroId = slot` on ACA |
| `src/services/lobby/lobby-preview.ts` | `slotCount`, team names, `ratingLabel`, hide hero column, claim labels |
| `src/services/guild/team-names.ts` | Optional profile → ACA Team A / Team B |
| `src/services/player/rank-embed.ts` (and similar) | User-facing unit from `profile.ratingLabel` when league/profile is in scope |
| `src/services/lobby/register-lobby-source.ts` | Refuse screenshot/wc3stats when `import: none` |
| `src/commands/league/league.ts` | Create choice + allow ACA `gameId` |
| `src/commands/config/config.ts` | Refuse wc3stats writes on `import: none` |
| `src/commands/player/leaderboard.ts` | Refuse hero boards on `optional_in_game` |
| `src/discord/interactions/lobby-interactions.ts` | Buttons/selects use `profile.slotCount` |
| `docs/dev/adding-a-new-game.md` | Known games row |

---

### Task 1: Game id + profile module (`general` + `game:warcraft3_anime_choice_arena`)

**Files:**
- Modify: `src/domain/games.ts`
- Create: `src/domain/game-profile.ts`
- Create: `src/domain/game-profile.test.ts`

**Interfaces:**
- Produces:
  - `WARCRAFT3_ANIME_CHOICE_ARENA_GAME_ID = 'warcraft3_anime_choice_arena'`
  - `KnownGameId` union includes both game ids
  - `export type HeroBinding = 'slot_bound' | 'optional_in_game'`
  - `export type GameImportKind = 'none' | 'wc3stats'`
  - `export type GameProfile = { gameId: string; displayName: string; slotCount: number; teamAMaxSlot: number; heroBinding: HeroBinding; import: GameImportKind; ratingLabel: string; teamNames: { 1: string; 2: string } }`
  - `export class UnknownGameIdError extends Error`
  - `export function getGameProfile(gameId: string): GameProfile`
  - `export function isSlotInProfile(profile: GameProfile, slot: number): boolean`
  - `export function teamForSlot(profile: GameProfile, slot: number): 1 | 2`
  - `export function rosterHeroId(profile: GameProfile, slot: number): number | null`
  - `export function invalidSlotMessage(profile: GameProfile): string` → ``Invalid slot. This game uses slots 1–${profile.slotCount}.``

- [ ] **Step 1: Write the failing tests**

Create `src/domain/game-profile.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  WARCRAFT3_ANIME_CHOICE_ARENA_GAME_ID,
  WARCRAFT3_UDBR_GAME_ID,
} from './games.js';
import {
  getGameProfile,
  invalidSlotMessage,
  isSlotInProfile,
  rosterHeroId,
  teamForSlot,
  UnknownGameIdError,
} from './game-profile.js';

describe('getGameProfile', () => {
  it('returns UDBR 12-slot slot_bound wc3stats profile', () => {
    const profile = getGameProfile(WARCRAFT3_UDBR_GAME_ID);
    expect(profile.slotCount).toBe(12);
    expect(profile.teamAMaxSlot).toBe(6);
    expect(profile.heroBinding).toBe('slot_bound');
    expect(profile.import).toBe('wc3stats');
    expect(profile.ratingLabel).toBe('ki');
    expect(profile.teamNames).toEqual({ 1: 'Z Fighters', 2: 'Evil' });
  });

  it('returns ACA 10-slot optional_in_game none profile', () => {
    const profile = getGameProfile(WARCRAFT3_ANIME_CHOICE_ARENA_GAME_ID);
    expect(profile.gameId).toBe('warcraft3_anime_choice_arena');
    expect(profile.displayName).toBe('Anime Choice Arena');
    expect(profile.slotCount).toBe(10);
    expect(profile.teamAMaxSlot).toBe(5);
    expect(profile.heroBinding).toBe('optional_in_game');
    expect(profile.import).toBe('none');
    expect(profile.ratingLabel).toBe('ki');
    expect(profile.teamNames).toEqual({ 1: 'Team A', 2: 'Team B' });
  });

  it('throws UnknownGameIdError for unknown ids', () => {
    expect(() => getGameProfile('valorant_custom')).toThrow(UnknownGameIdError);
  });
});

describe('teamForSlot / rosterHeroId', () => {
  const udbr = getGameProfile(WARCRAFT3_UDBR_GAME_ID);
  const aca = getGameProfile(WARCRAFT3_ANIME_CHOICE_ARENA_GAME_ID);

  it('splits UDBR 1-6 / 7-12 and ACA 1-5 / 6-10', () => {
    expect(teamForSlot(udbr, 6)).toBe(1);
    expect(teamForSlot(udbr, 7)).toBe(2);
    expect(teamForSlot(aca, 5)).toBe(1);
    expect(teamForSlot(aca, 6)).toBe(2);
  });

  it('returns slot as heroId only when slot_bound', () => {
    expect(rosterHeroId(udbr, 3)).toBe(3);
    expect(rosterHeroId(aca, 3)).toBeNull();
  });

  it('rejects slot 11 on ACA and accepts slot 12 on UDBR', () => {
    expect(isSlotInProfile(aca, 11)).toBe(false);
    expect(isSlotInProfile(udbr, 12)).toBe(true);
    expect(invalidSlotMessage(aca)).toBe('Invalid slot. This game uses slots 1–10.');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/domain/game-profile.test.ts`

Expected: FAIL (module not found / `WARCRAFT3_ANIME_CHOICE_ARENA_GAME_ID` missing)

- [ ] **Step 3: Implement**

`src/domain/games.ts`:

```ts
/** Catalog id for Ultimate Dragon Ball Reborn (Warcraft III). */
export const WARCRAFT3_UDBR_GAME_ID = 'warcraft3_udbr' as const;

/** Catalog id for Anime Choice Arena (Warcraft III 1.26). */
export const WARCRAFT3_ANIME_CHOICE_ARENA_GAME_ID = 'warcraft3_anime_choice_arena' as const;

export type KnownGameId =
  | typeof WARCRAFT3_UDBR_GAME_ID
  | typeof WARCRAFT3_ANIME_CHOICE_ARENA_GAME_ID;
```

`src/domain/game-profile.ts` — implement the types and functions from **Interfaces**. Store profiles in a `Record<string, GameProfile>`. `getGameProfile` looks up the map and throws `UnknownGameIdError` (`message`: `Unknown game id: ${gameId}`). `teamForSlot` throws `RangeError` if `!isSlotInProfile`. `rosterHeroId` returns `slot` when `heroBinding === 'slot_bound'`, else `null`. `isSlotInProfile`: integer, `1 <= slot <= profile.slotCount`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/domain/game-profile.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/domain/games.ts src/domain/game-profile.ts src/domain/game-profile.test.ts
git commit -m "feat: add game profile catalog for UDBR and Anime Choice Arena"
```

---

### Task 2: Schema — nullable `heroId` + Game seed (`general` + `game:warcraft3_anime_choice_arena`)

**Files:**
- Modify: `prisma/schema.prisma` (`MatchPlayer.heroId`)
- Create: `prisma/migrations/20260816120000_anime_choice_arena/migration.sql`

**Interfaces:**
- Consumes: `warcraft3_anime_choice_arena` id from Task 1
- Produces: `MatchPlayer.heroId Int?`; `Game` row `(warcraft3_anime_choice_arena, Anime Choice Arena)`

- [ ] **Step 1: Change Prisma schema**

On `MatchPlayer`, replace `heroId Int // 1-12 ...` with:

```prisma
  heroId    Int? // slot-bound games: slot id; optional_in_game: null until pick (phase 2)
```

Do **not** add an FK to `Hero`. Do **not** change `PlayerHeroRating` or `Hero`.

- [ ] **Step 2: Add migration SQL**

`prisma/migrations/20260816120000_anime_choice_arena/migration.sql`:

```sql
-- AlterTable
ALTER TABLE "MatchPlayer" ALTER COLUMN "heroId" DROP NOT NULL;

-- Seed Anime Choice Arena game catalog
INSERT INTO "Game" ("id", "displayName")
VALUES ('warcraft3_anime_choice_arena', 'Anime Choice Arena')
ON CONFLICT ("id") DO NOTHING;
```

- [ ] **Step 3: Generate client**

Run: `npx prisma generate`

Expected: client accepts `heroId: number | null`

- [ ] **Step 4: Apply locally if Docker Postgres is up**

Run: `npx prisma migrate deploy`

Expected: migration applied (or skip if no local DB; CI/deploy will apply)

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260816120000_anime_choice_arena/migration.sql
git commit -m "feat: allow null MatchPlayer.heroId and seed Anime Choice Arena game"
```

---

### Task 3: Split roster by persisted `team` (`general`)

**Files:**
- Modify: `src/services/rating/rating-math.ts`
- Modify: `src/services/rating/rating-math.test.ts`
- Modify: `src/services/rating/rating-update.ts` (`assertBothTeamsHaveActivePlayers`)
- Modify: `src/services/rating/rating-update.test.ts`
- Modify: `src/services/lobby/lobby-balance.ts` (stop using `slot <= 6` for team lists; still pass `team` on entries in Task 4/6)

**Interfaces:**
- Consumes: entries with `team: 1 | 2`
- Produces: `splitRosterByTeam<T extends { team: 1 | 2; slot: number }>(entries: T[]): { teamA: T[]; teamB: T[] }` — sort by slot, filter `team === 1` / `team === 2`

- [ ] **Step 1: Rewrite the failing `splitRosterByTeam` test**

Replace the existing test in `src/services/rating/rating-math.test.ts`:

```ts
describe('splitRosterByTeam', () => {
  it('groups by persisted team, not slot <= 6', () => {
    const { teamA, teamB } = splitRosterByTeam([
      { slot: 6, team: 2 as const },
      { slot: 1, team: 1 as const },
      { slot: 10, team: 2 as const },
    ]);
    expect(teamA.map((e) => e.slot)).toEqual([1]);
    expect(teamB.map((e) => e.slot)).toEqual([6, 10]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/services/rating/rating-math.test.ts`

Expected: FAIL (ACA slot 6 currently treated as team A)

- [ ] **Step 3: Implement `splitRosterByTeam`**

```ts
export function splitRosterByTeam<T extends { slot: number; team: 1 | 2 }>(
  entries: T[],
): { teamA: T[]; teamB: T[] } {
  const sorted = [...entries].sort((a, b) => a.slot - b.slot);
  return {
    teamA: sorted.filter((entry) => entry.team === 1),
    teamB: sorted.filter((entry) => entry.team === 2),
  };
}
```

Update `assertBothTeamsHaveActivePlayers` to require `{ slot: number; team: 1 | 2 }[]`.

Update `rating-update.test.ts`:

```ts
expect(() =>
  assertBothTeamsHaveActivePlayers([
    { slot: 1, team: 1 },
    { slot: 6, team: 2 },
  ]),
).not.toThrow();

expect(() => assertBothTeamsHaveActivePlayers([{ slot: 1, team: 1 }])).toThrow(
  MatchServiceError,
);
```

Fix **compile** errors in `rating-preview.ts`, `rating-update.ts`, `lobby-balance.ts` by adding `team` on in-memory entries. For UDBR call sites that still infer from slot, use `team: entry.slot <= 6 ? 1 : 2` **only as a temporary** until Task 5 persists profile `teamForSlot` — prefer adding `team` from `MatchPlayer.team` wherever the row exists (`matchPlayersToRatingEntries`).

In `matchPlayersToRatingEntries` add `team: entry.team as 1 | 2` (MatchPlayer already has `team`).

In `lobby-balance.ts` `suggestBalanceMove`, replace `roster.filter((e) => e.slot <= TEAM_A_MAX)` with `splitRosterByTeam(roster)` (requires `team` on `BalanceRosterEntry` — add it in this task).

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/services/rating/rating-math.test.ts src/services/rating/rating-update.test.ts src/services/lobby/lobby-balance.test.ts`

Expected: PASS (update balance test fixtures to include `team`)

- [ ] **Step 5: Commit**

```bash
git add src/services/rating/rating-math.ts src/services/rating/rating-math.test.ts src/services/rating/rating-update.ts src/services/rating/rating-update.test.ts src/services/rating/rating-preview.ts src/services/lobby/lobby-balance.ts src/services/lobby/lobby-balance.test.ts
git commit -m "fix: split rating teams by persisted team instead of slot cutoff"
```

---

### Task 4: OpenSkill + preview skip hero when `heroId` is null (`general`)

**Files:**
- Modify: `src/services/rating/rating-update.ts`
- Modify: `src/services/rating/rating-preview.ts`
- Modify: `src/services/match/match-correction.ts` (`writeMatchRatingSnapshots`)
- Create: `src/services/rating/rating-entities.ts` (pure helper, easy to test)
- Create: `src/services/rating/rating-entities.test.ts`

**Interfaces:**
- Consumes: `RatingRosterEntry.heroId: number | null` and `team: 1 | 2`
- Produces:
  - `export function ratingEntitiesForPlayer(global: MuSigma, hero: MuSigma, heroId: number | null): MuSigma[]` — `[global]` if `heroId == null`, else `[global, hero]`
  - `ensurePlayerRatings` creates `PlayerHeroRating` **only** for entries with non-null `heroId`
  - `applyMatchRatings` / `applyQuitterPenalties` skip hero find/update when all (or that entry’s) `heroId` is null
  - `loadLobbyRatingPreview` must **not** `createMany` catalog heroes when every entry has `heroId == null` (today this writes UDBR 1–12 into any league)
  - Snapshots: if `player.heroId == null`, write GLOBAL only; do not require a hero rating row

- [ ] **Step 1: Write failing tests for the pure helper**

`src/services/rating/rating-entities.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ratingEntitiesForPlayer } from './rating-entities.js';

const G = { mu: 25, sigma: 8.333 };
const H = { mu: 28, sigma: 7 };

describe('ratingEntitiesForPlayer', () => {
  it('returns global + hero when heroId is set', () => {
    expect(ratingEntitiesForPlayer(G, H, 3)).toEqual([G, H]);
  });

  it('returns global only when heroId is null', () => {
    expect(ratingEntitiesForPlayer(G, H, null)).toEqual([G]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/services/rating/rating-entities.test.ts`

Expected: FAIL (module not found)

- [ ] **Step 3: Implement helper and wire apply/ensure/preview/snapshots**

`rating-entities.ts`:

```ts
export type MuSigma = { mu: number; sigma: number };

export function ratingEntitiesForPlayer(
  global: MuSigma,
  hero: MuSigma,
  heroId: number | null,
): MuSigma[] {
  if (heroId == null) {
    return [global];
  }
  return [global, hero];
}
```

In `buildTeamEntities` / quitter loop / preview `teamEntities`, `flatMap` via `ratingEntitiesForPlayer`.

`registerTeam` in `applyMatchRatings`: stride = `entry.heroId == null ? 1 : 2`. If stride 1, update **only** `playerRating`. If stride 2, keep current global+hero updates.

`ensurePlayerRatings`:

```ts
await db.playerRating.createMany({
  data: entries.map((entry) => ({ leagueId, playerId: entry.playerId })),
  skipDuplicates: true,
});

const withHero = entries.filter(
  (entry): entry is typeof entry & { heroId: number } => entry.heroId != null,
);
if (withHero.length > 0) {
  await db.playerHeroRating.createMany({
    data: withHero.map((entry) => ({
      leagueId,
      playerId: entry.playerId,
      heroId: entry.heroId,
    })),
    skipDuplicates: true,
  });
}
```

Hero `findMany` `OR`: only include entries with non-null `heroId`. If none, skip the query (`[]`).

`loadLobbyRatingPreview`: wrap the `listCatalogHeroIds` + `createMany` block in `if (sorted.some((e) => e.heroId != null))`. Win% entities use `ratingEntitiesForPlayer`. When `heroId == null`, set `heroOrdinal` to the same as `globalOrdinal` (DTO stays stable) — lobby embed hides it in Task 6.

`writeMatchRatingSnapshots`: if `player.heroId == null`, push only the GLOBAL row; do not throw on missing hero rating.

Update types:

```ts
export type RatingRosterEntry = {
  playerId: string;
  slot: number;
  team: 1 | 2;
  heroId: number | null;
  isQuitter: boolean;
};
```

Same for `RatingPreviewRosterEntry` and `SnapshotPlayer.heroId: number | null`.

Fix `match-report.ts` / `match-correction.ts` entry mappers to pass `team` and nullable `heroId`.

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/services/rating/rating-entities.test.ts src/services/rating/rating-update.test.ts src/services/match/match-correction.test.ts src/services/match/match-report.test.ts src/services/lobby/lobby-preview.test.ts`

Expected: PASS (update fixtures that pass `heroId: number` where needed)

- [ ] **Step 5: Commit**

```bash
git add src/services/rating src/services/match/match-correction.ts src/services/match/match-report.ts
git commit -m "feat: apply OpenSkill with global-only entities when heroId is null"
```

---

### Task 5: Match create/replace uses profile (`general`)

**Files:**
- Create: `src/services/league/league-profile.ts`
- Modify: `src/services/league/index.ts` (re-export)
- Modify: `src/services/match/match-service.ts`
- Modify: `src/services/lobby/roster.ts`
- Create: `src/services/lobby/roster.test.ts`

**Interfaces:**
- Consumes: `getGameProfile` (Task 1), `MatchPlayer.heroId Int?` (Task 2)
- Produces:
  - `export async function getGameProfileForLeague(leagueId: string): Promise<GameProfile>` — `findUnique` league `gameId`, then `getGameProfile`. Missing league → `MatchServiceError('This match lobby was not found.')` (or `League not found.`)
  - `createPendingMatch` and `replaceMatchRoster` in `match-service.ts`: load profile; `assertValidSlots` uses `profile.slotCount` + `invalidSlotMessage(profile)`; `team: teamForSlot(profile, slot)`; `heroId: rosterHeroId(profile, slot)`; `assertHeroCatalogReady` / `assertHeroExists` **only** when `profile.heroBinding === 'slot_bound'`; `playerHeroRating.createMany` **only** when `rosterHeroId` is non-null

- [ ] **Step 1: Write roster slot tests**

`src/services/lobby/roster.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { getGameProfile } from '../../domain/game-profile.js';
import { WARCRAFT3_ANIME_CHOICE_ARENA_GAME_ID, WARCRAFT3_UDBR_GAME_ID } from '../../domain/games.js';
import { addPlayer } from './roster.js';
import { MatchServiceError } from '../match/match-service.js';

const aca = getGameProfile(WARCRAFT3_ANIME_CHOICE_ARENA_GAME_ID);
const udbr = getGameProfile(WARCRAFT3_UDBR_GAME_ID);

describe('addPlayer slot range', () => {
  it('rejects slot 11 on ACA with locked copy', () => {
    expect(() => addPlayer([], 'n', 11, aca)).toThrow(MatchServiceError);
    expect(() => addPlayer([], 'n', 11, aca)).toThrow(
      'Invalid slot. This game uses slots 1–10.',
    );
  });

  it('accepts slot 12 on UDBR', () => {
    expect(addPlayer([], 'n', 12, udbr)).toEqual([{ slot: 12, nick: 'n' }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/services/lobby/roster.test.ts`

Expected: FAIL (`addPlayer` arity / still 1–12 copy)

- [ ] **Step 3: Implement**

`league-profile.ts`:

```ts
import { prisma } from '../../lib/prisma.js';
import { getGameProfile, type GameProfile } from '../../domain/game-profile.js';
import { MatchServiceError } from '../match/match-service.js';

export async function getGameProfileForLeague(leagueId: string): Promise<GameProfile> {
  const league = await prisma.league.findUnique({
    where: { id: leagueId },
    select: { gameId: true },
  });
  if (!league) {
    throw new MatchServiceError('League not found.');
  }
  return getGameProfile(league.gameId);
}
```

Re-export from `src/services/league/index.ts`.

Change `addPlayer` / `removePlayer` / `movePlayer` / `swapPlayers` / `editPlayerNick` / `rosterAfterClaim` to take `profile: GameProfile` and call `isSlotInProfile`; on failure throw `new MatchServiceError(invalidSlotMessage(profile))`.

Update every caller (lobby commands, lobby-interactions, lobby-actions) to `await getGameProfileForLeague(match.leagueId)` and pass `profile`.

In `match-service.ts` `createPendingMatch` / roster replace:

```ts
const profile = await getGameProfileForLeague(input.leagueId);

if (profile.heroBinding === 'slot_bound') {
  await assertHeroCatalogReady();
  for (const player of players) {
    await assertHeroExists(player.slot);
  }
}

// assertValidSlots(players, profile)
// team: teamForSlot(profile, entry.slot)
// heroId: rosterHeroId(profile, entry.slot)
// playerHeroRating.createMany only for non-null heroIds
```

`teamCounts`: count `teamForSlot(profile, slot) === 1` instead of `slot <= 6`.

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/services/lobby/roster.test.ts src/services/lobby/lobby-claim.test.ts src/commands/lobby/lobby.test.ts`

Expected: PASS (fix call sites that break)

- [ ] **Step 5: Commit**

```bash
git add src/services/league src/services/match/match-service.ts src/services/lobby src/commands/lobby src/discord/interactions/lobby-interactions.ts
git commit -m "feat: drive match roster slots and heroId from the league game profile"
```

---

### Task 6: Runtime UX — flavor (team names + ratingLabel), slot controls, hide hero column (`general`)

**Files:**
- Modify: `src/services/guild/team-names.ts`
- Modify: `src/services/guild/team-names.test.ts`
- Modify: `src/services/lobby/lobby-preview.ts`
- Modify: `src/services/lobby/lobby-preview.test.ts`
- Modify: `src/services/lobby/lobby-balance.ts`
- Modify: `src/discord/interactions/lobby-interactions.ts`
- Modify: `src/services/lobby/lobby-ocr.ts` — keep `teamDisplayName(1)` no-profile (UDBR OCR only)

**Interfaces:**
- Consumes: `GameProfile.teamNames`, `ratingLabel`, `slotCount`, `heroBinding`
- Produces:
  - `teamDisplayName(team: 1 | 2, profile?: GameProfile): string` — omit profile → UDBR names (slash registration + OCR)
  - `teamDisplayNameForSlot(slot: number, profile: GameProfile): string` — `teamForSlot` + profile names
  - Lobby buttons/selects/claim options iterate `1..profile.slotCount`
  - Claim label: if `heroBinding === 'slot_bound'` keep `Slot N · ${heroName}`; else `Slot N · ${teamDisplayNameForSlot(slot, profile)}`
  - User-facing rating unit: prefer `profile.ratingLabel` in lobby/rank/leaderboard copy when profile is available (both presets are `ki` today; do not hardcode `"ki"` in new match-scoped strings)
  - Embed footer: if any preview line has no hero, use ``Per player: slot  nick  global (${profile.ratingLabel})`` instead of `global / hero`
  - Format roster lines: omit `/ heroKi` when `heroId` was null (pass a flag on `LobbyRatingPlayerLine`, e.g. `showHero?: boolean` default true; set `showHero: entry.heroId != null` in preview)
  - `suggestBalanceMove(roster, lookup, winChance, profile)`: empty slots `1..profile.slotCount`; `applySwap`/`applyMove` set `heroId: rosterHeroId(profile, destSlot)`; `winChanceForRoster` uses `ratingEntitiesForPlayer`

Do **not** change slash `setMinValue`/`setMaxValue` or winner choice **names**.

- [ ] **Step 1: Extend team-names tests**

```ts
it('uses profile teamNames when provided', () => {
  const aca = getGameProfile(WARCRAFT3_ANIME_CHOICE_ARENA_GAME_ID);
  expect(teamDisplayName(1, aca)).toBe('Team A');
  expect(teamDisplayName(2, aca)).toBe('Team B');
  expect(teamDisplayNameForSlot(6, aca)).toBe('Team B');
});

it('keeps Z Fighters / Evil without a profile (slash + UDBR OCR)', () => {
  expect(teamDisplayName(1)).toBe('Z Fighters');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/services/guild/team-names.test.ts`

Expected: FAIL (arity / ACA names)

- [ ] **Step 3: Implement team names + preview + buttons + balance**

`teamDisplayName`: `return (profile?.teamNames ?? getGameProfile(WARCRAFT3_UDBR_GAME_ID).teamNames)[team];`

`teamDisplayNameForSlot(slot, profile)`: `return teamDisplayName(teamForSlot(profile, slot), profile);`

`lobby-preview.ts`: `buildMatchLobbyEmbed` / button builders take `profile: GameProfile`. Replace `MAX_SLOT = 12` loops with `profile.slotCount`. Pass `profile` into `teamDisplayName(1, profile)`.

`lobby-interactions.ts`: load profile from `match.leagueId` before building slot buttons/modals. Slot parse: if `!isSlotInProfile(profile, slot)` reply `invalidSlotMessage(profile)`.

`canStartLobby` / `validateLobbyPlayers` still require both teams ≥1; for ACA, team from `teamForSlot(profile, slot)` not `slot <= 6`. If `validateLobbyPlayers` is OCR-only (12 slots), do **not** reuse it for ACA start — start path should use profile-aware occupancy (match-service already counts teams).

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/services/guild/team-names.test.ts src/services/lobby/lobby-preview.test.ts src/services/lobby/lobby-balance.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/guild/team-names.ts src/services/guild/team-names.test.ts src/services/lobby/lobby-preview.ts src/services/lobby/lobby-preview.test.ts src/services/lobby/lobby-balance.ts src/services/lobby/lobby-balance.test.ts src/discord/interactions/lobby-interactions.ts
git commit -m "feat: render lobby slots and team names from the game profile"
```

---

### Task 7: Refuse screenshot, wc3stats, and wc3stats config on `import: none` (`general` + `game:warcraft3_anime_choice_arena`)

**Files:**
- Modify: `src/services/lobby/register-lobby-source.ts`
- Modify: `src/services/lobby/register-lobby-source.test.ts`
- Modify: `src/commands/lobby/register-lobby.ts`
- Modify: `src/services/lobby/wc3stats-refresh.ts` / `create-from-wc3stats.ts` / `discord-sync.ts` as needed
- Modify: `src/services/league/league-wc3stats.ts` (`applyUdbrWc3statsPreset` and host-prompt setters)
- Modify: `src/commands/config/config.ts`
- Modify: `src/services/wc3stats/wc3stats-host-prompt-poller.ts` (`listHostPromptReadyLeagues`)

**Interfaces:**
- Produces:
  - `export const SCREENSHOT_UNSUPPORTED_MESSAGE = 'Lobby screenshots are not supported for this game yet.'`
  - `export const WC3STATS_UNSUPPORTED_MESSAGE = 'Warcraft lobby import is not supported for this game.'`
  - `export const WC3STATS_CONFIG_UNSUPPORTED_MESSAGE = "This league's game does not use wc3stats import."`
  - `export function assertRegisterLobbyAllowedForProfile(profile: GameProfile, input: { hasScreenshot: boolean; hasWc3statsId: boolean }): void`
  - `export async function assertLeagueAllowsWc3stats(leagueId: string): Promise<void>` — `getGameProfileForLeague`; if `import !== 'wc3stats'` throw `WC3STATS_CONFIG_UNSUPPORTED_MESSAGE` as `MatchServiceError`

- [ ] **Step 1: Write failing tests**

Add to `register-lobby-source.test.ts`:

```ts
import { getGameProfile } from '../../domain/game-profile.js';
import { WARCRAFT3_ANIME_CHOICE_ARENA_GAME_ID, WARCRAFT3_UDBR_GAME_ID } from '../../domain/games.js';
import {
  assertRegisterLobbyAllowedForProfile,
  SCREENSHOT_UNSUPPORTED_MESSAGE,
  WC3STATS_UNSUPPORTED_MESSAGE,
} from './register-lobby-source.js';

const aca = getGameProfile(WARCRAFT3_ANIME_CHOICE_ARENA_GAME_ID);
const udbr = getGameProfile(WARCRAFT3_UDBR_GAME_ID);

it('refuses screenshot and wc3stats id on import none', () => {
  expect(() =>
    assertRegisterLobbyAllowedForProfile(aca, { hasScreenshot: true, hasWc3statsId: false }),
  ).toThrow(SCREENSHOT_UNSUPPORTED_MESSAGE);
  expect(() =>
    assertRegisterLobbyAllowedForProfile(aca, { hasScreenshot: false, hasWc3statsId: true }),
  ).toThrow(WC3STATS_UNSUPPORTED_MESSAGE);
});

it('allows screenshot on UDBR', () => {
  expect(() =>
    assertRegisterLobbyAllowedForProfile(udbr, { hasScreenshot: true, hasWc3statsId: false }),
  ).not.toThrow();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/services/lobby/register-lobby-source.test.ts`

Expected: FAIL

- [ ] **Step 3: Implement guards**

`assertRegisterLobbyAllowedForProfile`: if `profile.import !== 'none'` return; if `hasScreenshot` throw screenshot message; if `hasWc3statsId` throw wc3stats message.

In `register-lobby.ts` after resolving `leagueId`, `const profile = await getGameProfileForLeague(leagueId)` then assert with `Boolean(attachment)` and `wc3statsId != null`. Do this **before** OCR/import. Empty `/register_lobby` still creates PENDING.

Call `assertLeagueAllowsWc3stats(leagueId)` at the start of `applyUdbrWc3statsPreset`, `clearLeagueWc3statsPackage`, slot-map config handlers, `setLeagueWc3statsHostPrompt`, `createMatchFromWc3statsLobby`, and `refreshLobbyFromWc3stats`.

`listHostPromptReadyLeagues`: after loading rows, drop any whose `getGameProfile(row.gameId).import !== 'wc3stats'` (select `gameId` on the query).

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/services/lobby/register-lobby-source.test.ts src/services/wc3stats/wc3stats-host-prompt-poller.test.ts src/services/lobby/lobby-actions-wc3stats.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/lobby/register-lobby-source.ts src/services/lobby/register-lobby-source.test.ts src/commands/lobby/register-lobby.ts src/services/league/league-wc3stats.ts src/commands/config/config.ts src/services/wc3stats src/services/lobby/wc3stats-refresh.ts src/services/lobby/create-from-wc3stats.ts
git commit -m "feat: refuse wc3stats and screenshots for games with import none"
```

---

### Task 8: `/league create` + hero leaderboard refuse (`game:warcraft3_anime_choice_arena` + `general`)

**Files:**
- Modify: `src/commands/league/league.ts`
- Modify: `src/commands/league/league.test.ts`
- Modify: `src/commands/player/leaderboard.ts`

**Interfaces:**
- Consumes: `WARCRAFT3_ANIME_CHOICE_ARENA_GAME_ID`, `getGameProfile`, `getGameProfileForLeague`
- Produces: create choice `{ name: 'Anime Choice Arena', value: 'warcraft3_anime_choice_arena' }`; `create` accepts that id via `getGameProfile(gameId)` instead of `!== UDBR`; `/leaderboard heroes` and `/leaderboard hero` reply `Hero rankings are not available for this game.` when `profile.heroBinding === 'optional_in_game'`

- [ ] **Step 1: Update league command test**

In `league.test.ts` replace the single-choice assertion:

```ts
expect(game?.choices).toEqual([
  { name: 'UDBR (Warcraft III)', value: WARCRAFT3_UDBR_GAME_ID },
  { name: 'Anime Choice Arena', value: WARCRAFT3_ANIME_CHOICE_ARENA_GAME_ID },
]);
```

Import `WARCRAFT3_ANIME_CHOICE_ARENA_GAME_ID`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/commands/league/league.test.ts`

Expected: FAIL (only UDBR choice)

- [ ] **Step 3: Implement**

`league.ts` `addChoices`:

```ts
.addChoices(
  { name: 'UDBR (Warcraft III)', value: WARCRAFT3_UDBR_GAME_ID },
  { name: 'Anime Choice Arena', value: WARCRAFT3_ANIME_CHOICE_ARENA_GAME_ID },
)
```

Replace `if (gameId !== WARCRAFT3_UDBR_GAME_ID)` with:

```ts
try {
  getGameProfile(gameId);
} catch (error) {
  if (error instanceof UnknownGameIdError) {
    await interaction.reply({ content: 'Unknown game.', flags: MessageFlags.Ephemeral });
    return;
  }
  throw error;
}
```

`leaderboard.ts` in `handleShowAllHeroes` and `handleShowSingleHero`, after resolving `leagueId`:

```ts
const profile = await getGameProfileForLeague(leagueId);
if (profile.heroBinding === 'optional_in_game') {
  await interaction.editReply({
    content: 'Hero rankings are not available for this game.',
  });
  return;
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/commands/league/league.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/commands/league/league.ts src/commands/league/league.test.ts src/commands/player/leaderboard.ts
git commit -m "feat: offer Anime Choice Arena leagues and hide hero leaderboards"
```

---

### Task 9: Docs (`general` + `game:warcraft3_anime_choice_arena`)

**Files:**
- Modify: `docs/dev/adding-a-new-game.md`
- Modify: `docs/superpowers/specs/2026-08-16-anime-choice-arena-design.md` (status + plan link)

**Interfaces:**
- Consumes: `src/domain/game-profile.ts`, `warcraft3_anime_choice_arena`

- [ ] **Step 1: Update Known games table**

In `docs/dev/adding-a-new-game.md` **Known games**:

```md
| `gameId` | Status | Module (current) |
|----------|--------|------------------|
| `warcraft3_udbr` | First game | `src/services/league/league-wc3stats.ts` + `src/services/wc3stats/**` |
| `warcraft3_anime_choice_arena` | Second game (v1: Discord-only, global rating, no in-game pick) | `src/domain/game-profile.ts` |
```

In **When to invest in “full” generalization**, replace “wait until a second game forces shared patterns” with: the shared pattern is `GameProfile` in `src/domain/game-profile.ts` (`slotCount`, `heroBinding`, `import`, `ratingLabel`, `teamNames`). Full `src/games/<id>/` adapters still wait. `optional_in_game` is the second hero pattern; do not reuse UDBR `Hero` ids 1–12. Flavor (rating unit + team names) is per-game preset, not hardcoded Dragon Ball copy in core.

Do not add ACA map SHA-1 or 1.26 notes to `.env.example`.

- [ ] **Step 2: Point the spec at this plan**

Spec header:

```md
**Status:** Approved — implementation plan written  
**Plan:** [docs/superpowers/plans/2026-08-16-anime-choice-arena.md](../plans/2026-08-16-anime-choice-arena.md)
```

- [ ] **Step 3: Run the full unit suite**

Run: `npm test`

Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add docs/dev/adding-a-new-game.md docs/superpowers/specs/2026-08-16-anime-choice-arena-design.md
git commit -m "docs: register Anime Choice Arena as a known game profile"
```

---

## Spec coverage (self-review)

| Spec requirement | Task |
|------------------|------|
| Game profile API + unknown id throws | 1 |
| Seed `Game` + nullable `heroId` | 2 |
| Split by `team`, ACA 5v5 / slot 6 is team B | 3 |
| Global-only OpenSkill; no `PlayerHeroRating` writes; GLOBAL-only snapshots | 4 |
| Skip hero catalog; `heroId` null; slot 1–10 | 5 |
| Team A/B + `ratingLabel` runtime; 10 slot controls; hide hero column; balance without slot=hero | 6 |
| Refuse screenshot / wc3stats / preset / poller | 7 |
| `/league create` choice; hero leaderboard copy | 8 |
| adding-a-new-game Known games | 9 |
| Slash min/max 1–12 and Z Fighters choice **names** unchanged | 6 (explicit non-change) |
| Isolation same `Player` two leagues | 4+5 (leagueId already on writes; add a unit/integration assert in Task 4 if a test harness exists — otherwise covered by existing league-scoped updates) |
| Phase 2 GameHero | out of scope (spec) |
