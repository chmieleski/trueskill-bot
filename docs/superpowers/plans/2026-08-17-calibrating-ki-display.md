# Calibrating Ki Display Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hide public ki and Rank # for players with fewer than 5 completed league games, show **Calibrating**, and park those names at the bottom of leaderboards.

**Architecture:** Display-only helpers `isCalibrating` / `formatPublicKi` next to `KI_Z_BLEND_GAMES`. Leaderboards two-tier sort (calibrated by ki, then calibrating by games then name with `rank: null`). Embeds and roster formatters print the word instead of the number. OpenSkill `rate()` and the ki formula do not change.

**Tech Stack:** TypeScript ESM, discord.js v14, Vitest

**Spec:** `docs/superpowers/specs/2026-08-17-calibrating-ki-display-design.md`

## Global Constraints

- Scope: `general` (all leagues; display only)
- English-only user-facing strings
- Public string is **`Calibrating`** (no `2/5`)
- Gate: completed WIN/LOSS in that league since latest `PlayerRankReset` (same count as soft-z)
- Threshold: `games < KI_Z_BLEND_GAMES` (5); player-level (hides global **and** hero ki)
- Rank glyph for unranked rows: `—`
- Calibrating sort: **games desc, then username** — never hidden ki
- Win-chance / balance hints stay numeric
- ESM imports use `.js` extension; named exports
- No new production env / SSM keys
- Do not persist a calibrating flag

## File map

| File                                                 | Role                                                                      |
| ---------------------------------------------------- | ------------------------------------------------------------------------- |
| `src/services/rating/rating-math.ts`                 | `CALIBRATING_LABEL`, `isCalibrating`, `formatPublicKi`                    |
| `src/services/rating/rating-math.test.ts`            | Helper unit tests                                                         |
| `src/services/leaderboard/leaderboard.ts`            | `rank: number \| null`, `leagueGames` on hero rows, `rankLeaderboardRows` |
| `src/services/leaderboard/leaderboard.test.ts`       | Two-tier sort / null ranks                                                |
| `src/services/leaderboard/leaderboard-embed.ts`      | Print `Calibrating` and `—`                                               |
| `src/services/leaderboard/leaderboard-embed.test.ts` | Table / prefix tests                                                      |
| `src/services/player/player-profile.ts`              | `rankPosition: number \| null`; rank among calibrated only                |
| `src/services/player/rank-embed.ts`                  | Calibrating title + hero cells                                            |
| `src/services/player/rank-embed.test.ts`             | Title / hero table                                                        |
| `src/services/rating/rating-preview.ts`              | `leagueGames` on lobby lines; pass into completed preview                 |
| `src/services/lobby/lobby-preview.ts`                | Hide ki + deltas while calibrating                                        |
| `src/services/lobby/lobby-preview.test.ts`           | Roster line tests                                                         |
| `src/services/match/match-report.ts`                 | Pass after-match games into completed preview                             |
| `src/services/match/match-correction.ts`             | Same                                                                      |
| `src/services/match/match-history-preview.ts`        | Attach `leagueGames` on stored/rebuild preview                            |
| `src/services/match/match-history.ts`                | Hide history-list ki delta while calibrating                              |
| `src/services/match/match-history.test.ts`           | History field copy                                                        |
| `.cursor/rules/openskill-rating.mdc`                 | Document the display gate                                                 |

---

### Task 1: Display helpers

**Files:**

- Modify: `src/services/rating/rating-math.ts`
- Modify: `src/services/rating/rating-math.test.ts`

**Interfaces:**

- Consumes: existing `KI_Z_BLEND_GAMES`
- Produces:
  - `CALIBRATING_LABEL = 'Calibrating'`
  - `isCalibrating(matchesPlayed: number): boolean`
  - `formatPublicKi(ki: number, matchesPlayed: number): string`

- [ ] **Step 1: Write the failing tests**

Add to `src/services/rating/rating-math.test.ts` (keep existing imports; add the new names):

```typescript
import {
  CALIBRATING_LABEL,
  displayConservatismZ,
  displayOrdinal,
  formatPublicKi,
  isCalibrating,
  KI_Z_BLEND_GAMES,
  KI_Z_END,
  KI_Z_START,
  roundWinPercents,
  splitRosterByTeam,
  toOpenSkillRatings,
} from './rating-math.js';

describe('isCalibrating', () => {
  it('is true below the blend window and false at/after 5', () => {
    expect(isCalibrating(0)).toBe(true);
    expect(isCalibrating(4)).toBe(true);
    expect(isCalibrating(KI_Z_BLEND_GAMES)).toBe(false);
    expect(isCalibrating(20)).toBe(false);
  });
});

describe('formatPublicKi', () => {
  it('returns Calibrating below 5 games', () => {
    expect(formatPublicKi(1450, 0)).toBe(CALIBRATING_LABEL);
    expect(formatPublicKi(1450, 4)).toBe(CALIBRATING_LABEL);
  });

  it('returns the ki number at 5+ games', () => {
    expect(formatPublicKi(1450, 5)).toBe('1450');
    expect(formatPublicKi(0, 5)).toBe('0');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/services/rating/rating-math.test.ts`

Expected: FAIL — `isCalibrating` / `formatPublicKi` / `CALIBRATING_LABEL` are not exported.

- [ ] **Step 3: Write minimal implementation**

Add to `src/services/rating/rating-math.ts` after `KI_Z_BLEND_GAMES`:

```typescript
/** Public stand-in for ki while `isCalibrating` is true. */
export const CALIBRATING_LABEL = 'Calibrating';

/**
 * True while the player has fewer than {@link KI_Z_BLEND_GAMES} completed
 * league games. Display-only; does not affect OpenSkill rate().
 */
export function isCalibrating(matchesPlayed: number): boolean {
  return Math.max(0, matchesPlayed) < KI_Z_BLEND_GAMES;
}

/**
 * Public ki cell: the word Calibrating until 5 league games, then the number.
 */
export function formatPublicKi(ki: number, matchesPlayed: number): string {
  if (isCalibrating(matchesPlayed)) {
    return CALIBRATING_LABEL;
  }
  return String(ki);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/services/rating/rating-math.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/rating/rating-math.ts src/services/rating/rating-math.test.ts
git commit -m "Add Calibrating public-ki helpers."
```

---

### Task 2: Two-tier leaderboard ranks

**Files:**

- Modify: `src/services/leaderboard/leaderboard.ts`
- Modify: `src/services/leaderboard/leaderboard.test.ts`

**Interfaces:**

- Consumes: `isCalibrating` from `../rating/rating-math.js`; existing `assignSortedRanks`
- Produces:
  - `OverallLeaderboardEntry.rank: number | null`
  - `OverallLeaderboardEntry.leagueGames: number` (same value as `games` on overall rows)
  - `HeroLeaderboardEntry.rank: number | null`
  - `HeroLeaderboardEntry.leagueGames: number` (player’s league completed games; G column stays `matchesPlayed`)
  - `rankLeaderboardRows<T extends { ki: number; username: string }>(rows: T[], getLeagueGames: (row: T) => number): (T & { rank: number | null })[]`
- `assignSortedRanks` stays; only the calibrated subset is passed into it
- Hero loaders: load `loadMatchDisplayStatsByPlayer`, rank the **full** eligible list, **then** `slice(0, limit)`

- [ ] **Step 1: Write the failing tests**

Add to `src/services/leaderboard/leaderboard.test.ts`:

```typescript
import {
  LeaderboardServiceError,
  LIVE_LEADERBOARD_CHUNK_SIZE,
  assertLiveLeaderboardSize,
  assignSortedRanks,
  chunkLeaderboardEntries,
  clampPage,
  paginateOverall,
  rankLeaderboardRows,
  type OverallLeaderboardEntry,
} from './leaderboard.js';

describe('rankLeaderboardRows', () => {
  it('ranks calibrated players then appends calibrating with null rank', () => {
    const rows = rankLeaderboardRows(
      [
        { username: 'vetB', ki: 3000, games: 10 },
        { username: 'newHighKi', ki: 9000, games: 2 },
        { username: 'vetA', ki: 5000, games: 20 },
        { username: 'newLowKi', ki: 800, games: 4 },
        { username: 'newTiedGamesA', ki: 100, games: 3 },
        { username: 'newTiedGamesB', ki: 9999, games: 3 },
      ],
      (row) => row.games,
    );

    expect(rows.map((row) => row.username)).toEqual([
      'vetA',
      'vetB',
      'newLowKi',
      'newTiedGamesA',
      'newTiedGamesB',
      'newHighKi',
    ]);
    expect(rows.map((row) => row.rank)).toEqual([1, 2, null, null, null, null]);
  });

  it('uses competition ranks among calibrated only', () => {
    const rows = rankLeaderboardRows(
      [
        { username: 'a', ki: 4000, games: 5 },
        { username: 'b', ki: 4000, games: 8 },
        { username: 'c', ki: 3000, games: 6 },
        { username: 'd', ki: 9999, games: 1 },
      ],
      (row) => row.games,
    );
    expect(rows.map((row) => row.rank)).toEqual([1, 1, 3, null]);
  });
});
```

Update the existing `paginateOverall` fixture so each row includes `leagueGames` matching `games` (TypeScript will require it after Step 3):

```typescript
const base: OverallLeaderboardEntry[] = Array.from({ length: 25 }, (_, i) => ({
  rank: i + 1,
  playerId: `p${i}`,
  username: `user${i}`,
  ki: 5000 - i * 10,
  games: 5,
  leagueGames: 5,
  discordId: null,
}));
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/services/leaderboard/leaderboard.test.ts`

Expected: FAIL — `rankLeaderboardRows` is not exported.

- [ ] **Step 3: Implement ranking + loaders**

In `src/services/leaderboard/leaderboard.ts`:

1. Import `isCalibrating` next to `displayOrdinal`.
2. Change entry types:

```typescript
export type OverallLeaderboardEntry = {
  rank: number | null;
  playerId: string;
  username: string;
  ki: number;
  games: number;
  leagueGames: number;
  discordId: string | null;
};

export type HeroLeaderboardEntry = {
  rank: number | null;
  playerId: string;
  username: string;
  ki: number;
  matchesPlayed: number;
  leagueGames: number;
};
```

3. Add:

```typescript
/**
 * Calibrated rows first (ki desc, competition rank), then calibrating
 * (league games desc, username; rank null). Slice/paginate after this order.
 */
export function rankLeaderboardRows<T extends { ki: number; username: string }>(
  rows: T[],
  getLeagueGames: (row: T) => number,
): (T & { rank: number | null })[] {
  const calibrated = rows
    .filter((row) => !isCalibrating(getLeagueGames(row)))
    .sort((a, b) => b.ki - a.ki || a.username.localeCompare(b.username));
  const calibrating = rows
    .filter((row) => isCalibrating(getLeagueGames(row)))
    .sort((a, b) => getLeagueGames(b) - getLeagueGames(a) || a.username.localeCompare(b.username));

  return [...assignSortedRanks(calibrated), ...calibrating.map((row) => ({ ...row, rank: null }))];
}
```

4. Replace the overall loader’s sort + `assignSortedRanks` with:

```typescript
const mapped = ratings
  .map((row) => {
    const games = gamesByPlayer.get(row.playerId) ?? 0;
    return {
      playerId: row.playerId,
      username: row.player.username,
      discordId: row.player.discordId,
      ki: displayOrdinal(row.mu, row.sigma, games),
      games,
      leagueGames: games,
    };
  })
  .filter((row) => row.games >= 1);

return rankLeaderboardRows(mapped, (row) => row.leagueGames).map((row) => ({
  rank: row.rank,
  playerId: row.playerId,
  username: row.username,
  ki: row.ki,
  games: row.games,
  leagueGames: row.leagueGames,
  discordId: row.discordId,
}));
```

5. Change `mapHeroRatings` to take league games and rank **before** slicing:

```typescript
function mapHeroRatings(
  rows: {
    playerId: string;
    mu: number;
    sigma: number;
    matchesPlayed: number;
    player: { username: string };
  }[],
  leagueGamesByPlayer: Map<string, number>,
  limit: number,
): HeroLeaderboardEntry[] {
  const mapped = rows
    .filter((row) => row.matchesPlayed > 0)
    .map((row) => ({
      playerId: row.playerId,
      username: row.player.username,
      ki: displayOrdinal(row.mu, row.sigma, row.matchesPlayed),
      matchesPlayed: row.matchesPlayed,
      leagueGames: leagueGamesByPlayer.get(row.playerId) ?? 0,
    }));

  return rankLeaderboardRows(mapped, (row) => row.leagueGames)
    .slice(0, limit)
    .map((row) => ({
      rank: row.rank,
      playerId: row.playerId,
      username: row.username,
      ki: row.ki,
      matchesPlayed: row.matchesPlayed,
      leagueGames: row.leagueGames,
    }));
}
```

6. In `loadHeroLeaderboard` and `loadAllHeroLeaderboards`, load stats once and pass the map:

```typescript
const [rows, displayStatsByPlayer] = await Promise.all([
  prisma.playerHeroRating.findMany({
    where: { leagueId, heroId, matchesPlayed: { gt: 0 } },
    include: { player: { select: { username: true } } },
  }),
  loadMatchDisplayStatsByPlayer(leagueId),
]);
const leagueGamesByPlayer = gamesByPlayerFromStats(displayStatsByPlayer);
return { heroName: hero.name, entries: mapHeroRatings(rows, leagueGamesByPlayer, limit) };
```

For `loadAllHeroLeaderboards`, call `loadMatchDisplayStatsByPlayer(leagueId)` **once** before the hero loop.

Export `rankLeaderboardRows` from `src/services/leaderboard/index.ts` if other modules import from the barrel; tests import `./leaderboard.js` directly.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/services/leaderboard/leaderboard.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/leaderboard/leaderboard.ts src/services/leaderboard/leaderboard.test.ts src/services/leaderboard/index.ts
git commit -m "Park calibrating players below ranked leaderboard rows."
```

---

### Task 3: Leaderboard embed copy

**Files:**

- Modify: `src/services/leaderboard/leaderboard-embed.ts`
- Modify: `src/services/leaderboard/leaderboard-embed.test.ts`

**Interfaces:**

- Consumes: `formatPublicKi` from `../rating/rating-math.js`; `rank: number | null`; `leagueGames` on entries
- Produces: `formatRankPrefix(rank: number | null): string` — `null` → `—`; tables use `formatPublicKi(ki, leagueGames)` for the ki cell and `games` / `matchesPlayed` for G

- [ ] **Step 1: Write the failing tests**

In `src/services/leaderboard/leaderboard-embed.test.ts`:

1. Change `fakeEntry` so existing numeric tests stay calibrated (`games`/`leagueGames` ≥ 5):

```typescript
function fakeEntry(rank: number): OverallLeaderboardEntry {
  return {
    rank,
    playerId: `p${rank}`,
    username: `Player${rank}`,
    ki: 1000 + rank,
    games: 10,
    leagueGames: 10,
    discordId: null,
  };
}
```

2. Add:

```typescript
describe('formatRankPrefix', () => {
  it('uses medals for top 3', () => {
    expect(formatRankPrefix(1)).toBe('🥇');
    expect(formatRankPrefix(2)).toBe('🥈');
    expect(formatRankPrefix(3)).toBe('🥉');
    expect(formatRankPrefix(4)).toBe('#4');
  });

  it('uses an em dash when unranked', () => {
    expect(formatRankPrefix(null)).toBe('—');
  });
});

describe('formatOverallTable', () => {
  it('prints Calibrating instead of ki when leagueGames < 5', () => {
    const table = formatOverallTable([
      {
        rank: 1,
        playerId: 'p1',
        username: 'Vet',
        ki: 4820,
        games: 20,
        leagueGames: 20,
        discordId: null,
      },
      {
        rank: null,
        playerId: 'p2',
        username: 'Rookie',
        ki: 9000,
        games: 2,
        leagueGames: 2,
        discordId: null,
      },
    ]);
    expect(table).toContain('4820');
    expect(table).toContain('Calibrating');
    expect(table).not.toContain('9000');
    expect(table).toContain('—');
  });
});
```

3. Update the `buildOverallLeaderboardEmbed` Tinys fixture and the all-hero slice fixture with `leagueGames: 42` / `leagueGames: 8` (calibrated). Add `leagueGames` to every `OverallLeaderboardEntry` / `HeroLeaderboardEntry` literal in this file.

4. Add:

```typescript
describe('buildHeroLeaderboardEmbed', () => {
  it('shows empty copy when no entries', () => {
    const embed = buildHeroLeaderboardEmbed('Goku', []);
    expect(embed.data.description).toBe('_No games yet for Goku._');
  });

  it('prints Calibrating using leagueGames, not hero matchesPlayed', () => {
    const embed = buildHeroLeaderboardEmbed('Goku', [
      {
        rank: null,
        playerId: 'p1',
        username: 'Rookie',
        ki: 4200,
        matchesPlayed: 3,
        leagueGames: 2,
      },
    ]);
    expect(embed.data.description).toContain('Calibrating');
    expect(embed.data.description).not.toContain('4200');
  });
});
```

(Replace the existing empty-copy `buildHeroLeaderboardEmbed` describe rather than duplicating it.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/services/leaderboard/leaderboard-embed.test.ts`

Expected: FAIL — `formatRankPrefix(null)` does not return `—`; table still prints `9000`.

- [ ] **Step 3: Update formatters**

In `src/services/leaderboard/leaderboard-embed.ts`:

```typescript
import { formatPublicKi } from '../rating/rating-math.js';

export function formatRankPrefix(rank: number | null): string {
  if (rank == null) {
    return '—';
  }
  if (rank === 1) {
    return '🥇';
  }
  if (rank === 2) {
    return '🥈';
  }
  if (rank === 3) {
    return '🥉';
  }
  return `#${rank}`;
}
```

In `formatOverallTable`, compute the ki cell with `formatPublicKi(entry.ki, entry.leagueGames)` (not `String(entry.ki)`). Use that string for column width.

In `formatHeroCompactTable`, same: `formatPublicKi(entry.ki, entry.leagueGames)`.

In `buildHeroLeaderboardEmbed`, when mapping to overall rows, set `games: entry.matchesPlayed` and `leagueGames: entry.leagueGames`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/services/leaderboard/leaderboard-embed.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/leaderboard/leaderboard-embed.ts src/services/leaderboard/leaderboard-embed.test.ts
git commit -m "Show Calibrating on leaderboard ki cells."
```

---

### Task 4: `/rank` profile and embed

**Files:**

- Modify: `src/services/player/player-profile.ts`
- Modify: `src/services/player/rank-embed.ts`
- Modify: `src/services/player/rank-embed.test.ts`

**Interfaces:**

- Consumes: `isCalibrating`, `formatPublicKi`, `CALIBRATING_LABEL`
- Produces:
  - `PlayerProfile.rankPosition: number | null` (`null` while calibrating)
  - Competition rank uses **only** kis of players with `leagueGames >= 5`
  - `buildRankEmbed` title is `Calibrating` when `isCalibrating(wins + losses)`; otherwise unchanged `Rank #N · {ki} {ratingLabel}`
  - `formatHeroTable(heroes, leagueGames)` uses `formatPublicKi` for the ki cell

- [ ] **Step 1: Write the failing tests**

Add to `src/services/player/rank-embed.test.ts`:

```typescript
it('uses Calibrating title and hero cells when under 5 games', () => {
  const embed = buildRankEmbed({
    ...baseProfile,
    globalKi: 1450,
    rankPosition: null,
    wins: 2,
    losses: 1,
    quits: 0,
    winRatePercent: 66.7,
    heroes: [{ heroId: 1, name: 'Goku', ki: 4200, matchesPlayed: 2 }],
  });
  const data = embed.toJSON();
  expect(data.title).toBe('Calibrating');
  expect(data.title).not.toContain('1450');
  expect(data.fields?.[0]?.value).toContain('Calibrating');
  expect(data.fields?.[0]?.value).not.toContain('4200');
  expect(data.fields?.[0]?.value).toContain('· 2');
});
```

Keep the existing `Rank #3 · 4000 ki` test (baseProfile is already 12W/5L).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/services/player/rank-embed.test.ts`

Expected: FAIL — title is still `Rank #null · 1450 ki` or similar; hero cell still shows `4200`.

- [ ] **Step 3: Implement profile rank filter + embed**

In `loadPlayerProfile` (`src/services/player/player-profile.ts`):

```typescript
const rankPosition = isCalibrating(games)
  ? null
  : competitionRank(
      globalKi,
      allRatings
        .filter((row) => !isCalibrating(gamesByPlayer.get(row.playerId) ?? 0))
        .map((row) => displayOrdinal(row.mu, row.sigma, gamesByPlayer.get(row.playerId) ?? 0)),
    );
```

Do **not** push a cold-start ki into `allKis` for unranked/missing rows. Import `isCalibrating`. Change `rankPosition` on `PlayerProfile` to `number | null`.

Remove the old `allKis` / `if (!rating) { allKis.push(globalKi); }` block; calibrated rank only needs other calibrated ratings (include self via `competitionRank(globalKi, calibratedKis)` where `calibratedKis` is built from `allRatings` filtered by games ≥ 5 — self is in `allRatings` when they have a row). If they are calibrated but missing from `allRatings` (should not happen), `competitionRank(globalKi, [...calibratedKis, globalKi])` is unnecessary if `allRatings` always includes the player’s row when `rating` exists. When `rating` is missing and `games >= 5` (odd), fall back to `competitionRank(globalKi, calibratedKis.concat(globalKi))`. Keep it simple: if `isCalibrating(games)` → `null`; else build kis from every `allRatings` row with `!isCalibrating(gamesByPlayer.get(id) ?? 0)`, and if `rating` is missing append `globalKi`.

In `src/services/player/rank-embed.ts`:

```typescript
import { CALIBRATING_LABEL, formatPublicKi, isCalibrating } from '../rating/rating-math.js';

export function formatHeroTable(heroes: PlayerProfileHero[], leagueGames: number): string {
  if (heroes.length === 0) {
    return '_No hero games yet_';
  }

  const cells = heroes.map((hero) => ({
    name: hero.name,
    ki: formatPublicKi(hero.ki, leagueGames),
    matchesPlayed: hero.matchesPlayed,
  }));
  const nameWidth = Math.max(...cells.map((cell) => cell.name.length));
  const kiWidth = Math.max(...cells.map((cell) => cell.ki.length));

  const lines = cells.map((cell) => {
    const name = cell.name.padEnd(nameWidth, ' ');
    const ki = cell.ki.padStart(kiWidth, ' ');
    return `${name}  ${ki} · ${cell.matchesPlayed}`;
  });

  return `\`\`\`\n${lines.join('\n')}\n\`\`\``;
}
```

In `buildRankEmbed`:

```typescript
const leagueGames = profile.wins + profile.losses;
const title = isCalibrating(leagueGames)
  ? CALIBRATING_LABEL
  : `Rank #${profile.rankPosition} · ${profile.globalKi} ${ratingLabel}`;
```

Pass `leagueGames` into `formatHeroTable(profile.heroes, leagueGames)`.

Update the existing `formatHeroTable(baseProfile.heroes)` call in tests to `formatHeroTable(baseProfile.heroes, 17)` (12+5).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/services/player/rank-embed.test.ts src/services/player/player-profile.test.ts`

Expected: PASS (`competitionRank` unit tests unchanged)

- [ ] **Step 5: Commit**

```bash
git add src/services/player/player-profile.ts src/services/player/rank-embed.ts src/services/player/rank-embed.test.ts
git commit -m "Hide rank number on calibrating /rank profiles."
```

---

### Task 5: Lobby and completed-match roster lines

**Files:**

- Modify: `src/services/rating/rating-preview.ts`
- Modify: `src/services/lobby/lobby-preview.ts`
- Modify: `src/services/lobby/lobby-preview.test.ts`
- Modify: `src/services/match/match-report.ts`
- Modify: `src/services/match/match-correction.ts`
- Modify: `src/services/match/match-history-preview.ts`

**Interfaces:**

- Consumes: `formatPublicKi`, `isCalibrating`, `gamesByPlayerFromStats`, `loadMatchDisplayStatsByPlayer`
- Produces:
  - `LobbyRatingPlayerLine.leagueGames: number`
  - `buildCompletedRatingPreview(..., leagueGamesByPlayer: Map<string, number>)`
  - `formatTeamLinesFromPreview` prints `Calibrating` and omits `formatSignedDelta` when `isCalibrating(leagueGames)`
  - PENDING lobby: current completed count (this match not included)
  - Complete embed: after-match count (this match included)
  - Numeric ki still stored on `MatchPlayer` (no schema change)

- [ ] **Step 1: Write the failing lobby tests**

In `src/services/lobby/lobby-preview.test.ts`, add `leagueGames` to every `LobbyRatingPlayerLine` fixture:

- Existing numeric tests: `leagueGames: 8` (or any ≥ 5)
- New cases:

```typescript
it('prints Calibrating and omits deltas when leagueGames < 5', () => {
  const value = formatTeamLinesFromPreview([
    {
      slot: 1,
      nick: 'goku',
      globalOrdinal: 1186,
      heroOrdinal: 1200,
      globalDelta: 186,
      heroDelta: 200,
      leagueGames: 4,
    },
  ]);
  expect(value).toContain('Calibrating');
  expect(value).not.toContain('1186');
  expect(value).not.toContain('+186');
  expect(value).not.toContain('1200');
});

it('shows ki and deltas when the completing match reaches 5', () => {
  const value = formatTeamLinesFromPreview([
    {
      slot: 1,
      nick: 'goku',
      globalOrdinal: 1186,
      heroOrdinal: 1200,
      globalDelta: 186,
      heroDelta: 200,
      leagueGames: 5,
    },
  ]);
  expect(value).toContain('1186 (+186) / 1200 (+200)');
  expect(value).not.toContain('Calibrating');
});
```

Update `buildCompletedRatingPreview` test to pass a `Map` of after-match games (e.g. `p1 → 5`, `p2 → 8`) and expect `leagueGames` on the returned lines.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/services/lobby/lobby-preview.test.ts`

Expected: FAIL — missing `leagueGames`; still prints numbers at 4 games.

- [ ] **Step 3: Implement line field + formatters + preview builders**

1. Add to `LobbyRatingPlayerLine`:

```typescript
/** League completed WIN/LOSS count used for the Calibrating gate. */
leagueGames: number;
```

2. `loadLobbyRatingPreview`: set `leagueGames: globalGames` on every returned line (including the catch fallback: `leagueGames: 0`).

3. Change `buildCompletedRatingPreview`:

```typescript
export function buildCompletedRatingPreview(
  entries: RatingPreviewRosterEntry[],
  beforeBySlot: Map<number, PlayerKiPair>,
  afterBySlot: Map<number, PlayerKiPair>,
  leagueGamesByPlayer: Map<string, number>,
): LobbyRatingPreview {
  const players: LobbyRatingPlayerLine[] = [...entries]
    .sort((a, b) => a.slot - b.slot)
    .map((entry) => {
      const after = afterBySlot.get(entry.slot) ?? {
        global: displayOrdinal(DEFAULT_MU, DEFAULT_SIGMA),
        hero: displayOrdinal(DEFAULT_MU, DEFAULT_SIGMA),
      };
      const before = beforeBySlot.get(entry.slot) ?? after;
      return {
        slot: entry.slot,
        nick: entry.nick,
        globalOrdinal: after.global,
        heroOrdinal: after.hero,
        globalDelta: after.global - before.global,
        heroDelta: after.hero - before.hero,
        isQuitter: entry.isQuitter,
        showHero: entry.heroId != null,
        leagueGames: leagueGamesByPlayer.get(entry.playerId) ?? 0,
      };
    });

  return { players };
}
```

4. In `formatTeamLinesFromPreview`, replace raw ordinal strings:

```typescript
import { formatPublicKi, isCalibrating } from '../rating/rating-math.js';

function formatKiCell(ki: number, leagueGames: number, delta: number | undefined): string {
  if (isCalibrating(leagueGames)) {
    return formatPublicKi(ki, leagueGames);
  }
  return `${ki}${formatSignedDelta(delta)}`;
}
```

Use `formatKiCell` for global and hero. Column width must use the formatted cell strings (so `Calibrating` can widen the column). For a calibrating player, **both** global and hero cells are `Calibrating` (player-level gate).

5. **match-report.ts** and **match-correction.ts**: after `loadPlayerKiBySlot` (after), still inside the transaction, load stats and pass the map:

```typescript
const displayStats = await loadMatchDisplayStatsByPlayer(
  match.leagueId,
  previewEntries.map((entry) => entry.playerId),
  tx,
);
const afterBySlot = await loadPlayerKiBySlot(match.leagueId, previewEntries, tx);
ratingPreview = buildCompletedRatingPreview(
  previewEntries,
  beforeBySlot,
  afterBySlot,
  gamesByPlayerFromStats(displayStats),
);
```

Import `loadMatchDisplayStatsByPlayer` and `gamesByPlayerFromStats` from `../rating/rank-reset-display.js` (or the rating barrel). Call this **after** the match is `COMPLETED` / player results are written so the count includes this match.

6. **match-history-preview.ts** `rebuildCompletedRatingPreview`: it already computes after-match `games` per player in the loop. Build `leagueGamesByPlayer` from that and pass it into `buildCompletedRatingPreview`.

7. **`ratingPreviewFromStoredMatchPlayers`**: add `leagueGames`. Prefer computing after-match count in `resolveCompletedRatingPreview` (async) rather than the sync stored mapper:

```typescript
export function ratingPreviewFromStoredMatchPlayers(
  match: MatchWithPlayers,
  leagueGamesByPlayer: Map<string, number>,
): LobbyRatingPreview | undefined {
  if (match.players.some((player) => player.globalKi == null)) {
    return undefined;
  }

  return {
    players: match.players.map((player) => ({
      slot: player.slot,
      nick: player.player.username,
      globalOrdinal: player.globalKi!,
      heroOrdinal: player.heroKi ?? player.globalKi!,
      globalDelta: player.globalKiDelta ?? undefined,
      heroDelta: player.heroKiDelta ?? undefined,
      isQuitter: player.isQuitter,
      showHero: player.heroId != null && player.heroKi != null,
      leagueGames: leagueGamesByPlayer.get(player.playerId) ?? 0,
    })),
  };
}
```

Add `loadLeagueGamesAfterMatch(match)` using the existing `loadGlobalGamesBeforeMatch` helper: after-match games = before + 1 when that player has WIN/LOSS on this match. `resolveCompletedRatingPreview` loads that map, then stored or rebuild.

Update `match-history.test.ts` fixtures that construct stored previews / `globalKi` lines with `leagueGames`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/services/lobby/lobby-preview.test.ts src/services/match/match-history.test.ts src/services/match/match-report.ts`

If match-report has no unit file, run:

`npx vitest run src/services/lobby/lobby-preview.test.ts src/services/match/match-history.test.ts src/services/rating`

Expected: PASS. Fix any TS errors from missing `leagueGames` in fixtures (search `globalOrdinal:` and `globalKi:`).

- [ ] **Step 5: Commit**

```bash
git add src/services/rating/rating-preview.ts src/services/lobby/lobby-preview.ts src/services/lobby/lobby-preview.test.ts src/services/match/match-report.ts src/services/match/match-correction.ts src/services/match/match-history-preview.ts src/services/match/match-history.test.ts
git commit -m "Hide lobby and post-match ki while calibrating."
```

---

### Task 6: Match history list deltas

**Files:**

- Modify: `src/services/match/match-history.ts`
- Modify: `src/services/match/match-history.test.ts`
- Modify: `src/services/match/match-history-preview.ts` (if `loadPlayerGlobalDeltaForMatch` should stay numeric internally)

**Interfaces:**

- Consumes: `CALIBRATING_LABEL`, `isCalibrating`
- Produces: `MatchHistoryRow.leagueGames: number` (after-match count for that row). `formatMatchHistoryField` name is `{hero} · {emoji} Calibrating` when calibrating; otherwise unchanged `{hero} · {emoji} {delta} ki`

- [ ] **Step 1: Write the failing tests**

Update the existing `formatMatchHistoryField` tests to pass `leagueGames: 8`. Add:

```typescript
it('prints Calibrating instead of a ki delta under 5 games', () => {
  const field = formatMatchHistoryField(
    {
      matchId: 'm2',
      completedAt: new Date('2026-08-16T12:00:00.000Z'),
      result: 'WIN',
      team: 1,
      heroName: 'Goku',
      isQuitter: false,
      globalDelta: 186,
      leagueGames: 3,
    },
    'Z Fighters',
  );
  expect(field.name).toBe('Goku · ✅ Calibrating');
  expect(field.name).not.toContain('186');
  expect(field.name).not.toContain(' ki');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/services/match/match-history.test.ts`

Expected: FAIL — name still `Goku · ✅ +186 ki`.

- [ ] **Step 3: Implement**

```typescript
import { CALIBRATING_LABEL, isCalibrating } from '../rating/rating-math.js';

export type MatchHistoryRow = {
  matchId: string;
  completedAt: Date;
  result: 'WIN' | 'LOSS';
  team: 1 | 2;
  heroName: string | null;
  isQuitter: boolean;
  globalDelta?: number;
  leagueGames: number;
};

export function formatMatchHistoryField(
  row: MatchHistoryRow,
  teamLabel: string,
): { name: string; value: string; inline: boolean } {
  const emoji = row.result === 'WIN' ? '✅' : '❌';
  const outcome = row.result === 'WIN' ? 'Win' : 'Loss';
  const hero = row.heroName ?? 'Unknown hero';
  const ratingBit = isCalibrating(row.leagueGames)
    ? CALIBRATING_LABEL
    : `${formatMatchHistoryDelta(row.globalDelta)} ki`;
  // ...
  return {
    name: `${hero} · ${emoji} ${ratingBit}`,
    value: `${outcome}${quit} · ${teamLabel} · <t:${unix}:D>\n\`${row.matchId}\``,
    inline: false,
  };
}
```

When loading rows, set `leagueGames` to after-match count (reuse `loadGlobalGamesBeforeMatch` + 1, or the same helper as Task 5). Export that helper from `match-history-preview.ts` if both files need it rather than duplicating the groupBy.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/services/match/match-history.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/match/match-history.ts src/services/match/match-history.test.ts src/services/match/match-history-preview.ts
git commit -m "Hide match-history ki deltas while calibrating."
```

---

### Task 7: Docs + full test run

**Files:**

- Modify: `.cursor/rules/openskill-rating.mdc`
- Modify: `docs/superpowers/specs/2026-08-17-calibrating-ki-display-design.md` (status → Implemented)

**Interfaces:**

- Consumes: behavior from Tasks 1–6
- Produces: rule + spec status in sync with code

- [ ] **Step 1: Update the OpenSkill rule**

In `.cursor/rules/openskill-rating.mdc`, after the Public ki formula / z table, add:

```markdown
**Calibrating display (games < 5):** do not print public ki or Rank #. Show `Calibrating`. Leaderboards list those players after the ranked block with `—`, sorted by league games then username (not hidden ki). Gate is player-level (hides hero ki too). Does not change `rate()` or the formula above. Spec: `docs/superpowers/specs/2026-08-17-calibrating-ki-display-design.md`.
```

In the edge-case table, add a row:

| **Calibrating label** | Public surfaces hide ki until 5 completed league games (same g as soft-z, including after rank reset) |

- [ ] **Step 2: Mark the spec implemented**

Set **Status:** Implemented in `docs/superpowers/specs/2026-08-17-calibrating-ki-display-design.md`.

- [ ] **Step 3: Run the full unit suite**

Run: `npm test`

Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add .cursor/rules/openskill-rating.mdc docs/superpowers/specs/2026-08-17-calibrating-ki-display-design.md
git commit -m "Document calibrating ki display in rating rules."
```

---

## Self-review

**Spec coverage**

| Spec item                                                                         | Task                                               |
| --------------------------------------------------------------------------------- | -------------------------------------------------- |
| `isCalibrating` / `formatPublicKi` / word `Calibrating`                           | 1                                                  |
| Two-tier board, null rank, games-then-name, slice after rank                      | 2                                                  |
| `—` glyph, Calibrating on overall/live/hero tables                                | 3                                                  |
| `/rank` title, no `#`, hero cells, rank among calibrated                          | 4                                                  |
| Lobby current count; complete after-match; hide deltas; player-level both columns | 5                                                  |
| `/match show` stored preview leagueGames                                          | 5                                                  |
| History list deltas                                                               | 6                                                  |
| openskill-rating.mdc                                                              | 7                                                  |
| Rank reset uses same g                                                            | 2/4/5 via existing `loadMatchDisplayStatsByPlayer` |
| Win% unchanged                                                                    | no task (untouched)                                |
| No persist flag                                                                   | no schema task                                     |

**Placeholder scan:** none.

**Type consistency:** `rank: number | null`; `leagueGames` on overall, hero, and lobby lines; `buildCompletedRatingPreview` 4th arg `Map<string, number>`; history row `leagueGames: number`.
