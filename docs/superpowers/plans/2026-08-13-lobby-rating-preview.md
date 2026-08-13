# Lobby Rating Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show per-player global/hero ordinals and Team A/B win % (OpenSkill `predictWin`) on Match Lobby and Match In Progress embeds — read-only, no `rate()`.

**Architecture:** New `src/services/rating-preview.ts` loads/ensures dual ratings, builds team arrays, returns a DTO. `lobby-preview.ts` formats embeds. `syncLobbyDiscordMessage` and `register_lobby` load the DTO before building embeds.

**Tech Stack:** Node.js + TypeScript ESM, discord.js v14, Prisma, `openskill`, Vitest

**Spec:** [docs/superpowers/specs/2026-08-13-lobby-rating-preview-design.md](../specs/2026-08-13-lobby-rating-preview-design.md)

## Global Constraints

- User-facing strings in **English**
- Public ordinal = `μ − 3σ` (use `openskill`’s `ordinal()`)
- Dual-entity teams: `[global, hero, global, hero, …]`; `heroId = slot`
- Never call `rate()` in this feature
- Prefer existing Prisma singleton and `createLogger`
- ESM imports use `.js` extensions
- Commits only when the user asks (skip commit steps unless requested)

## File structure

| File | Responsibility |
|------|----------------|
| `src/services/rating-math.ts` | Pure helpers: ordinal display, dual-entity team build, win % rounding (unit-tested) |
| `src/services/rating-preview.ts` | DB ensure + load + `predictWin` → `LobbyRatingPreview` DTO |
| `src/services/rating-math.test.ts` | Unit tests for pure math |
| `src/services/lobby-preview.ts` | Embed formatting using DTO |
| `src/services/lobby-actions.ts` | Load preview in `syncLobbyDiscordMessage` |
| `src/commands/lobby/register-lobby.ts` | Load match + preview after create |
| `package.json` / `vitest.config.ts` / `tsconfig.json` | `openskill` + Vitest; exclude tests from `tsc` |

---

### Task 1: Add `openskill` + Vitest

**Files:**
- Modify: `package.json`
- Create: `vitest.config.ts`
- Modify: `tsconfig.json`
- Modify: `.gitignore` (add `.superpowers/`)

**Interfaces:**
- Produces: `npm test` runs Vitest; `openskill` importable

- [ ] **Step 1: Install dependencies**

```bash
npm install openskill
npm install -D vitest
```

- [ ] **Step 2: Add Vitest config**

Create `vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
  },
});
```

- [ ] **Step 3: Update `package.json` scripts**

Add:

```json
"test": "vitest run",
"test:watch": "vitest"
```

- [ ] **Step 4: Exclude tests from `tsc`**

In `tsconfig.json` `exclude`, add `"src/**/*.test.ts"`.

- [ ] **Step 5: Ignore brainstorm artifacts**

Append to `.gitignore`:

```
.superpowers/
```

- [ ] **Step 6: Verify**

```bash
npm test
```

Expected: Vitest runs with 0 tests (or pass with no files). `npx tsc --noEmit` still succeeds.

---

### Task 2: Pure rating math helpers (TDD)

**Files:**
- Create: `src/services/rating-math.ts`
- Create: `src/services/rating-math.test.ts`

**Interfaces:**
- Consumes: `openskill` (`rating`, `ordinal`, types)
- Produces:
  - `displayOrdinal(mu: number, sigma: number): number`
  - `buildDualEntityTeam(ratings: { mu: number; sigma: number }[]): ReturnType<typeof rating>[]`  
    (each pair of consecutive entries is already flattened: caller passes `[g1,h1,g2,h2]` as Rating-like objects)
  - `toOpenSkillRatings(entities: { mu: number; sigma: number }[]): Rating[]`
  - `roundWinPercents(pA: number, pB: number): { teamAPercent: number; teamBPercent: number }`
  - `splitRosterByTeam<T extends { slot: number }>(entries: T[]): { teamA: T[]; teamB: T[] }`

- [ ] **Step 1: Write failing tests**

Create `src/services/rating-math.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  displayOrdinal,
  roundWinPercents,
  splitRosterByTeam,
  toOpenSkillRatings,
} from './rating-math.js';

describe('displayOrdinal', () => {
  it('returns mu - 3*sigma rounded to nearest int', () => {
    // default OpenSkill: 25 - 3*8.333 ≈ 0
    expect(displayOrdinal(25, 8.333)).toBe(0);
    expect(displayOrdinal(30, 2)).toBe(24);
  });
});

describe('roundWinPercents', () => {
  it('rounds so percents sum to 100', () => {
    expect(roundWinPercents(0.5, 0.5)).toEqual({ teamAPercent: 50, teamBPercent: 50 });
    const skewed = roundWinPercents(0.666, 0.334);
    expect(skewed.teamAPercent + skewed.teamBPercent).toBe(100);
  });
});

describe('splitRosterByTeam', () => {
  it('puts slots 1-6 in A and 7-12 in B', () => {
    const { teamA, teamB } = splitRosterByTeam([
      { slot: 7 },
      { slot: 1 },
      { slot: 12 },
    ]);
    expect(teamA.map((e) => e.slot)).toEqual([1]);
    expect(teamB.map((e) => e.slot)).toEqual([7, 12]);
  });
});

describe('toOpenSkillRatings', () => {
  it('preserves mu/sigma order for dual-entity arrays', () => {
    const ratings = toOpenSkillRatings([
      { mu: 25, sigma: 8.333 },
      { mu: 28, sigma: 7 },
    ]);
    expect(ratings).toHaveLength(2);
    expect(ratings[0].mu).toBe(25);
    expect(ratings[1].mu).toBe(28);
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL**

```bash
npm test
```

Expected: FAIL (module not found / exports missing)

- [ ] **Step 3: Implement `rating-math.ts`**

```ts
import { ordinal, rating, type Rating } from 'openskill';

const TEAM_A_MAX_SLOT = 6;

/** Public display ordinal (μ − 3σ), nearest integer. */
export function displayOrdinal(mu: number, sigma: number): number {
  return Math.round(ordinal({ mu, sigma }));
}

export function toOpenSkillRatings(
  entities: { mu: number; sigma: number }[],
): Rating[] {
  return entities.map((entity) => rating({ mu: entity.mu, sigma: entity.sigma }));
}

/**
 * Round two win probabilities in [0,1] to integer percents that sum to 100.
 * Largest-remainder style: round A, assign B the residual.
 */
export function roundWinPercents(
  pA: number,
  pB: number,
): { teamAPercent: number; teamBPercent: number } {
  const teamAPercent = Math.round(pA * 100);
  return { teamAPercent, teamBPercent: 100 - teamAPercent };
}

export function splitRosterByTeam<T extends { slot: number }>(
  entries: T[],
): { teamA: T[]; teamB: T[] } {
  const sorted = [...entries].sort((a, b) => a.slot - b.slot);
  return {
    teamA: sorted.filter((entry) => entry.slot <= TEAM_A_MAX_SLOT),
    teamB: sorted.filter((entry) => entry.slot > TEAM_A_MAX_SLOT),
  };
}
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
npm test
```

Expected: all tests PASS

---

### Task 3: `loadLobbyRatingPreview` service

**Files:**
- Create: `src/services/rating-preview.ts`
- Modify: `src/services/rating-math.test.ts` (optional extra cases for empty-team winChance omission — covered via pure checks in preview tests if you add a pure `computeWinChance` export)

**Interfaces:**
- Consumes: `prisma`, `predictWin`/`rating` from openskill, helpers from `rating-math.ts`
- Produces:

```ts
export interface LobbyRatingPlayerLine {
  slot: number;
  nick: string;
  globalOrdinal: number;
  heroOrdinal: number;
}

export interface LobbyRatingPreview {
  players: LobbyRatingPlayerLine[];
  winChance?: { teamAPercent: number; teamBPercent: number };
}

export type RatingPreviewRosterEntry = {
  playerId: string;
  slot: number;
  heroId: number;
  nick: string;
};

export async function loadLobbyRatingPreview(
  entries: RatingPreviewRosterEntry[],
): Promise<LobbyRatingPreview>;
```

- [ ] **Step 1: Implement ensure helpers + loader**

Create `src/services/rating-preview.ts`:

```ts
import { predictWin } from 'openskill';
import { prisma } from '../lib/prisma.js';
import { createLogger } from '../lib/logger.js';
import {
  displayOrdinal,
  roundWinPercents,
  splitRosterByTeam,
  toOpenSkillRatings,
} from './rating-math.js';

const log = createLogger('rating-preview');

export interface LobbyRatingPlayerLine {
  slot: number;
  nick: string;
  globalOrdinal: number;
  heroOrdinal: number;
}

export interface LobbyRatingPreview {
  players: LobbyRatingPlayerLine[];
  winChance?: { teamAPercent: number; teamBPercent: number };
}

export type RatingPreviewRosterEntry = {
  playerId: string;
  slot: number;
  heroId: number;
  nick: string;
};

/** Ensure Hero rows 1–12 exist (FK for PlayerHeroRating). */
export async function ensureHeroesExist(): Promise<void> {
  await prisma.hero.createMany({
    data: Array.from({ length: 12 }, (_, index) => ({
      id: index + 1,
      name: `Hero ${index + 1}`,
    })),
    skipDuplicates: true,
  });
}

async function ensurePlayerRatings(
  entries: RatingPreviewRosterEntry[],
): Promise<void> {
  for (const entry of entries) {
    await prisma.playerRating.upsert({
      where: { playerId: entry.playerId },
      create: { playerId: entry.playerId },
      update: {},
    });
    await prisma.playerHeroRating.upsert({
      where: {
        playerId_heroId: { playerId: entry.playerId, heroId: entry.heroId },
      },
      create: { playerId: entry.playerId, heroId: entry.heroId },
      update: {},
    });
  }
}

/**
 * Load ordinals + win chance for the current lobby roster.
 * Read-only prediction: never calls rate().
 * On failure, returns nick-only lines with ordinals 0 and no winChance.
 */
export async function loadLobbyRatingPreview(
  entries: RatingPreviewRosterEntry[],
): Promise<LobbyRatingPreview> {
  const sorted = [...entries].sort((a, b) => a.slot - b.slot);

  if (sorted.length === 0) {
    return { players: [] };
  }

  try {
    await ensureHeroesExist();
    await ensurePlayerRatings(sorted);

    const playerIds = sorted.map((entry) => entry.playerId);
    const globals = await prisma.playerRating.findMany({
      where: { playerId: { in: playerIds } },
    });
    const heroes = await prisma.playerHeroRating.findMany({
      where: {
        OR: sorted.map((entry) => ({
          playerId: entry.playerId,
          heroId: entry.heroId,
        })),
      },
    });

    const globalByPlayer = new Map(globals.map((row) => [row.playerId, row]));
    const heroKey = (playerId: string, heroId: number) => `${playerId}:${heroId}`;
    const heroByKey = new Map(
      heroes.map((row) => [heroKey(row.playerId, row.heroId), row]),
    );

    const players: LobbyRatingPlayerLine[] = sorted.map((entry) => {
      const global = globalByPlayer.get(entry.playerId) ?? { mu: 25, sigma: 8.333 };
      const hero =
        heroByKey.get(heroKey(entry.playerId, entry.heroId)) ?? {
          mu: 25,
          sigma: 8.333,
        };
      return {
        slot: entry.slot,
        nick: entry.nick,
        globalOrdinal: displayOrdinal(global.mu, global.sigma),
        heroOrdinal: displayOrdinal(hero.mu, hero.sigma),
      };
    });

    const { teamA, teamB } = splitRosterByTeam(sorted);
    if (teamA.length === 0 || teamB.length === 0) {
      return { players };
    }

    const teamEntities = (team: RatingPreviewRosterEntry[]) => {
      const entities: { mu: number; sigma: number }[] = [];
      for (const entry of team) {
        const global = globalByPlayer.get(entry.playerId) ?? { mu: 25, sigma: 8.333 };
        const hero =
          heroByKey.get(heroKey(entry.playerId, entry.heroId)) ?? {
            mu: 25,
            sigma: 8.333,
          };
        entities.push(
          { mu: global.mu, sigma: global.sigma },
          { mu: hero.mu, sigma: hero.sigma },
        );
      }
      return toOpenSkillRatings(entities);
    };

    const [pA, pB] = predictWin([teamEntities(teamA), teamEntities(teamB)]);
    return {
      players,
      winChance: roundWinPercents(pA, pB),
    };
  } catch (error) {
    log.error({ err: error }, 'Failed to load lobby rating preview');
    return {
      players: sorted.map((entry) => ({
        slot: entry.slot,
        nick: entry.nick,
        globalOrdinal: displayOrdinal(25, 8.333),
        heroOrdinal: displayOrdinal(25, 8.333),
      })),
    };
  }
}

/** Map MatchWithPlayers rows into preview roster entries. */
export function matchPlayersToRatingEntries(
  matchPlayers: {
    playerId: string;
    slot: number;
    heroId: number;
    player: { username: string };
  }[],
): RatingPreviewRosterEntry[] {
  return matchPlayers.map((entry) => ({
    playerId: entry.playerId,
    slot: entry.slot,
    heroId: entry.heroId,
    nick: entry.player.username,
  }));
}
```

- [ ] **Step 2: Sanity-check TypeScript**

```bash
npx tsc --noEmit
```

Expected: no errors (or fix import types for `openskill` if needed; `skipLibCheck` is on).

---

### Task 4: Wire embeds in `lobby-preview.ts`

**Files:**
- Modify: `src/services/lobby-preview.ts`

**Interfaces:**
- Consumes: `LobbyRatingPreview` from `rating-preview.ts`
- Produces: updated `buildMatchLobbyEmbed` / `buildMatchInProgressEmbed` signatures accepting optional `ratingPreview?: LobbyRatingPreview`

- [ ] **Step 1: Update formatters and embed builders**

Replace `formatTeamLines` usage for rated lobbies:

```ts
import type { LobbyRatingPreview } from './rating-preview.js';

export function formatTeamLinesFromPreview(
  players: { slot: number; nick: string; globalOrdinal: number; heroOrdinal: number }[],
): string {
  if (players.length === 0) {
    return '_Empty_';
  }
  return players
    .map(
      (player) =>
        `[Slot ${player.slot}] - ${player.nick} · ${player.globalOrdinal} / ${player.heroOrdinal}`,
    )
    .join('\n');
}

function ratingPreviewFields(preview: LobbyRatingPreview | undefined) {
  if (!preview?.winChance) {
    return [];
  }
  const { teamAPercent, teamBPercent } = preview.winChance;
  return [
    {
      name: 'Rating preview',
      value: [
        `Team A · ${teamAPercent}% · Team B · ${teamBPercent}%`,
        'Per player: global / hero (ordinal)',
      ].join('\n'),
      inline: false,
    },
  ];
}
```

Update `buildMatchLobbyEmbed` and `buildMatchInProgressEmbed` to accept `ratingPreview?: LobbyRatingPreview`. When present, split `preview.players` via existing `splitLobbyPlayers`-equivalent on slot, use `formatTeamLinesFromPreview`. When absent, keep current nick-only `formatTeamLines(players)` behavior for safety.

Signature sketch:

```ts
export function buildMatchLobbyEmbed(
  matchId: string,
  players: LobbyPlayer[],
  options: {
    canStart?: boolean;
    createdAt?: Date;
    ratingPreview?: LobbyRatingPreview;
  } = {},
): EmbedBuilder
```

Same pattern for `buildMatchInProgressEmbed(matchId, players, options?: { ratingPreview?: LobbyRatingPreview })`.

- [ ] **Step 2: `npx tsc --noEmit`**

Expected: PASS (call sites still compile with optional preview).

---

### Task 5: Wire `syncLobbyDiscordMessage` + register

**Files:**
- Modify: `src/services/lobby-actions.ts`
- Modify: `src/commands/lobby/register-lobby.ts`

**Interfaces:**
- Consumes: `loadLobbyRatingPreview`, `matchPlayersToRatingEntries`, `getMatchById`
- Produces: embeds always built with preview when match has players

- [ ] **Step 1: Update `syncLobbyDiscordMessage`**

In `lobby-actions.ts`, before building embeds for `pending` / `started`:

```ts
import {
  loadLobbyRatingPreview,
  matchPlayersToRatingEntries,
} from './rating-preview.js';

// inside syncLobbyDiscordMessage, after matchToLobbyPlayers:
const ratingPreview = await loadLobbyRatingPreview(
  matchPlayersToRatingEntries(match.players),
);

// pass ratingPreview into buildMatchLobbyEmbed / buildMatchInProgressEmbed
```

Cancelled mode: no preview needed.

- [ ] **Step 2: Update `register-lobby.ts`**

After `createPendingMatch`:

```ts
import { getMatchById } from '../../services/match-service.js';
import {
  loadLobbyRatingPreview,
  matchPlayersToRatingEntries,
} from '../../services/rating-preview.js';

const created = await createPendingMatch({ ... });
const match = await getMatchById(created.matchId);
const ratingPreview = match
  ? await loadLobbyRatingPreview(matchPlayersToRatingEntries(match.players))
  : undefined;

await interaction.editReply({
  embeds: [
    buildMatchLobbyEmbed(created.matchId, players, {
      canStart,
      createdAt: created.createdAt,
      ratingPreview,
    }),
  ],
  components: buildLobbyButtons({ canStart }),
});
```

- [ ] **Step 3: Typecheck**

```bash
npx tsc --noEmit && npm test
```

Expected: PASS

- [ ] **Step 4: Manual smoke (dev bot)**

1. `/register_lobby` with a screenshot that yields players on both teams  
2. Confirm roster lines show `· N / M` and Rating preview field with % + footnote  
3. Fix Reading / `/lobby` add-remove → preview refreshes  
4. Start Match → In Progress embed keeps ordinals + win %  
5. One-sided lobby → ordinals present, no Rating preview field  

---

### Task 6: Spec / rule touch-up (optional, small)

**Files:**
- Modify: `.cursor/rules/openskill-rating.mdc` — note lobby preview uses `predictWin` + per-player ordinals; team aggregate ordinal not shown on embeds

Only if you want rules to match shipped UI; skip if preferring docs-only.

---

## Self-review vs spec

| Spec requirement | Task |
|------------------|------|
| `openskill` + `predictWin` | 1, 3 |
| Dual-entity arrays | 3 |
| Cold-start upserts + Hero ensure | 3 |
| Per-player global / hero ordinals | 3, 4 |
| Dedicated win-% field + footnote | 4 |
| Omit preview if empty team | 3 |
| Fail soft on errors | 3 |
| Wire sync + register | 5 |
| Vitest for pure math | 1, 2 |
| No `rate()` | 3 (explicit) |
