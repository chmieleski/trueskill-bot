# Win Rate Display Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show per-hero W/L + WR on `/rank`, and a WR column on existing overall and single-hero leaderboards (including live overall), still ranked by ki.

**Architecture:** Compute WR at read time from completed `MatchPlayer` WIN/LOSS rows after each player’s rank-reset cutoff. Overall WR reuses the existing per-player buckets. Character WR is the same rows grouped by `(playerId, heroId)`. No schema, no new commands, no write-path changes.

**Tech Stack:** TypeScript ESM, Prisma, discord.js v14, Vitest

**Spec:** `docs/superpowers/specs/2026-08-19-win-rate-display-design.md`

## Global Constraints

- Scope: `general` (per-league completed-match stats; not game-specific)
- English-only user-facing strings
- Formula: `wins / (wins + losses)`; `Math.round((wins / games) * 1000) / 10`; `null` when `games === 0`
- Stringify WR as `` `${n}%` `` — do not force a trailing `.0`
- Same rank-reset cutoff as overall W/L; quitters are not W or L; skip `heroId == null`
- Ranking stays ki desc; keep `G` meaning (overall = W+L; hero boards = `matchesPlayed`)
- All-heroes compact stays ki-only (still populate `winRatePercent` on the DTO)
- ESM imports use `.js` extension; named exports
- No Prisma / env / SSM changes; no new slash commands or button custom IDs
- Work in `/home/lesk/www/bot/.worktrees/feat-win-rate-display` on `feat/win-rate-display`

## File map

| File                                                 | Role                                                                                |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `src/services/rating/rank-reset-display.ts`          | `winRatePercent()`, `heroId` on rows, hero aggregate, `heroStatsFor`, bundle loader |
| `src/services/rating/rank-reset-display.test.ts`     | Formula + hero aggregation + lookup                                                 |
| `src/services/player/player-profile.ts`              | Join hero W/L onto `PlayerProfileHero`; use shared `winRatePercent()`               |
| `src/services/player/rank-embed.ts`                  | Hero table `NW NL · WR%`                                                            |
| `src/services/player/rank-embed.test.ts`             | Hero table + fixture fields                                                         |
| `src/services/leaderboard/leaderboard.ts`            | `winRatePercent` on overall + hero entries; overall from W/L; hero from buckets     |
| `src/services/leaderboard/leaderboard.test.ts`       | Extra field on pagination fixtures                                                  |
| `src/services/leaderboard/leaderboard-embed.ts`      | `WR` column on `formatOverallTable`; compact unchanged                              |
| `src/services/leaderboard/leaderboard-embed.test.ts` | WR column + compact has no WR                                                       |

---

### Task 1: [general] Display-stat helpers (formula + hero aggregate)

**Files:**

- Modify: `src/services/rating/rank-reset-display.ts`
- Modify: `src/services/rating/rank-reset-display.test.ts`

**Interfaces:**

- Consumes: existing `aggregateMatchDisplayStats`, `loadMatchDisplayStatsByPlayer`, rank-reset cutoff
- Produces:
  - `winRatePercent(wins: number, losses: number): number | null`
  - `PlayerHeroMatchDisplayStats = { wins: number; losses: number }`
  - `MatchDisplayStatRow.heroId?: number | null` (optional so existing overall tests keep compiling)
  - `aggregateHeroMatchDisplayStats(rows, resetAtByPlayer): Map<string, Map<number, PlayerHeroMatchDisplayStats>>`
  - `heroStatsFor(byHero, playerId, heroId): PlayerHeroMatchDisplayStats` (missing → `{ wins: 0, losses: 0 }`)
  - `MatchDisplayStatsBundle = { byPlayer; byHero }`
  - `loadMatchDisplayStats(leagueId, playerIds?, db?): Promise<MatchDisplayStatsBundle>`
  - `loadMatchDisplayStatsByPlayer` keeps the same signature and still returns only `byPlayer`

- [ ] **Step 1: Write the failing tests**

Append to `src/services/rating/rank-reset-display.test.ts`. Add imports:

```typescript
import {
  aggregateHeroMatchDisplayStats,
  aggregateMatchDisplayStats,
  countCompletedGamesThrough,
  gamesByPlayerFromStats,
  heroStatsFor,
  isMatchCountedAfterRankReset,
  winRatePercent,
} from './rank-reset-display.js';
```

Append describes:

```typescript
describe('winRatePercent', () => {
  it('returns null when there are no games', () => {
    expect(winRatePercent(0, 0)).toBeNull();
  });

  it('rounds to one decimal', () => {
    expect(winRatePercent(5, 3)).toBe(62.5);
    expect(winRatePercent(1, 0)).toBe(100);
    expect(winRatePercent(2, 1)).toBe(66.7);
    expect(winRatePercent(0, 1)).toBe(0);
  });
});

describe('aggregateHeroMatchDisplayStats', () => {
  it('groups W/L by player and hero and skips null heroId', () => {
    const stats = aggregateHeroMatchDisplayStats(
      [
        {
          playerId: 'p1',
          heroId: 1,
          result: MatchResult.WIN,
          isQuitter: false,
          completedAt: AFTER,
        },
        {
          playerId: 'p1',
          heroId: 1,
          result: MatchResult.LOSS,
          isQuitter: false,
          completedAt: AFTER,
        },
        {
          playerId: 'p1',
          heroId: 2,
          result: MatchResult.WIN,
          isQuitter: false,
          completedAt: AFTER,
        },
        {
          playerId: 'p1',
          heroId: null,
          result: MatchResult.WIN,
          isQuitter: false,
          completedAt: AFTER,
        },
      ],
      new Map(),
    );

    expect(stats.get('p1')?.get(1)).toEqual({ wins: 1, losses: 1 });
    expect(stats.get('p1')?.get(2)).toEqual({ wins: 1, losses: 0 });
    expect(stats.get('p1')?.has(0)).toBe(false);
  });

  it('ignores pre-reset games and quitters without WIN/LOSS', () => {
    const stats = aggregateHeroMatchDisplayStats(
      [
        {
          playerId: 'p1',
          heroId: 1,
          result: MatchResult.WIN,
          isQuitter: false,
          completedAt: BEFORE,
        },
        {
          playerId: 'p1',
          heroId: 1,
          result: MatchResult.LOSS,
          isQuitter: true,
          completedAt: AFTER,
        },
        {
          playerId: 'p1',
          heroId: 1,
          result: null,
          isQuitter: true,
          completedAt: AFTER,
        },
      ],
      new Map([['p1', RESET]]),
    );

    expect(stats.get('p1')?.get(1)).toEqual({ wins: 0, losses: 1 });
  });
});

describe('heroStatsFor', () => {
  it('returns zeros when the bucket is missing', () => {
    expect(heroStatsFor(new Map(), 'p1', 1)).toEqual({ wins: 0, losses: 0 });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/services/rating/rank-reset-display.test.ts`

Expected: FAIL — `winRatePercent` / `aggregateHeroMatchDisplayStats` / `heroStatsFor` are not exported.

- [ ] **Step 3: Write minimal implementation**

In `src/services/rating/rank-reset-display.ts`:

1. Extend the row type:

```typescript
export type MatchDisplayStatRow = {
  playerId: string;
  result: MatchResult | null;
  isQuitter: boolean;
  completedAt: Date | null;
  heroId?: number | null;
};

export type PlayerHeroMatchDisplayStats = {
  wins: number;
  losses: number;
};

export type MatchDisplayStatsBundle = {
  byPlayer: Map<string, PlayerMatchDisplayStats>;
  byHero: Map<string, Map<number, PlayerHeroMatchDisplayStats>>;
};
```

2. Add helpers (place near `gamesByPlayerFromStats`):

```typescript
/** Public win rate: one decimal, null when no completed WIN/LOSS. */
export function winRatePercent(wins: number, losses: number): number | null {
  const games = wins + losses;
  if (games === 0) {
    return null;
  }
  return Math.round((wins / games) * 1000) / 10;
}

export function heroStatsFor(
  byHero: Map<string, Map<number, PlayerHeroMatchDisplayStats>>,
  playerId: string,
  heroId: number,
): PlayerHeroMatchDisplayStats {
  return byHero.get(playerId)?.get(heroId) ?? { wins: 0, losses: 0 };
}

/** Aggregate per-hero W/L, applying each player's latest rank-reset cutoff. */
export function aggregateHeroMatchDisplayStats(
  rows: MatchDisplayStatRow[],
  resetAtByPlayer: Map<string, Date>,
): Map<string, Map<number, PlayerHeroMatchDisplayStats>> {
  const stats = new Map<string, Map<number, PlayerHeroMatchDisplayStats>>();

  for (const row of rows) {
    if (row.heroId == null) {
      continue;
    }
    if (row.result !== MatchResult.WIN && row.result !== MatchResult.LOSS) {
      continue;
    }
    const resetAt = resetAtByPlayer.get(row.playerId);
    if (!isMatchCountedAfterRankReset(row.completedAt, resetAt)) {
      continue;
    }

    let byHero = stats.get(row.playerId);
    if (!byHero) {
      byHero = new Map();
      stats.set(row.playerId, byHero);
    }
    let bucket = byHero.get(row.heroId);
    if (!bucket) {
      bucket = { wins: 0, losses: 0 };
      byHero.set(row.heroId, bucket);
    }
    if (row.result === MatchResult.WIN) {
      bucket.wins += 1;
    } else {
      bucket.losses += 1;
    }
  }

  return stats;
}
```

3. Extract a shared fetch used by both loaders. Replace `loadMatchDisplayStatsByPlayer` with:

```typescript
async function loadMatchDisplayRows(
  leagueId: string,
  playerIds: string[] | undefined,
  db: Db,
): Promise<{
  resetAtByPlayer: Map<string, Date>;
  rows: MatchDisplayStatRow[];
}> {
  const [resetAtByPlayer, matchRows] = await Promise.all([
    loadLatestRankResetAtByPlayer(leagueId, playerIds, db),
    db.matchPlayer.findMany({
      where: {
        ...(playerIds ? { playerId: { in: playerIds } } : {}),
        OR: [
          {
            match: { leagueId, status: MatchStatus.COMPLETED },
            result: { in: [MatchResult.WIN, MatchResult.LOSS] },
          },
          {
            isQuitter: true,
            match: {
              leagueId,
              status: { in: [MatchStatus.COMPLETED, MatchStatus.CANCELLED] },
            },
          },
        ],
      },
      select: {
        playerId: true,
        heroId: true,
        result: true,
        isQuitter: true,
        match: { select: { completedAt: true } },
      },
    }),
  ]);

  const rows: MatchDisplayStatRow[] = matchRows.map((row) => ({
    playerId: row.playerId,
    heroId: row.heroId,
    result: row.result,
    isQuitter: row.isQuitter,
    completedAt: row.match.completedAt,
  }));

  return { resetAtByPlayer, rows };
}

export async function loadMatchDisplayStats(
  leagueId: string,
  playerIds?: string[],
  db: Db = defaultPrisma,
): Promise<MatchDisplayStatsBundle> {
  const { resetAtByPlayer, rows } = await loadMatchDisplayRows(leagueId, playerIds, db);
  return {
    byPlayer: aggregateMatchDisplayStats(rows, resetAtByPlayer),
    byHero: aggregateHeroMatchDisplayStats(rows, resetAtByPlayer),
  };
}

export async function loadMatchDisplayStatsByPlayer(
  leagueId: string,
  playerIds?: string[],
  db: Db = defaultPrisma,
): Promise<Map<string, PlayerMatchDisplayStats>> {
  const { resetAtByPlayer, rows } = await loadMatchDisplayRows(leagueId, playerIds, db);
  return aggregateMatchDisplayStats(rows, resetAtByPlayer);
}
```

Do **not** run hero aggregation inside `loadMatchDisplayStatsByPlayer` (overall/live boards do not need it).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/services/rating/rank-reset-display.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/rating/rank-reset-display.ts src/services/rating/rank-reset-display.test.ts
git commit -m "$(cat <<'EOF'
feat(rating): aggregate per-hero display W/L

EOF
)"
```

---

### Task 2: [general] `/rank` character W/L + WR

**Files:**

- Modify: `src/services/player/player-profile.ts`
- Modify: `src/services/player/rank-embed.ts`
- Modify: `src/services/player/rank-embed.test.ts`

**Interfaces:**

- Consumes: `loadMatchDisplayStats`, `heroStatsFor`, `winRatePercent` from Task 1
- Produces: `PlayerProfileHero` with `wins`, `losses`, `winRatePercent`; hero table `Name  ki · 5W 3L · 62.5%`

- [ ] **Step 1: Write the failing tests**

Update `src/services/player/rank-embed.test.ts` fixtures and `formatHeroTable` cases.

`baseProfile.heroes` must include the new fields (TypeScript will fail until the type exists — write the fixture first, then the type in Step 3 if the test file does not compile; prefer adding type + fixture together in this task’s implement step if `tsc` blocks the test run). Use:

```typescript
heroes: [
  {
    heroId: 1,
    name: 'Goku',
    ki: 4200,
    matchesPlayed: 8,
    wins: 5,
    losses: 3,
    winRatePercent: 62.5,
  },
  {
    heroId: 2,
    name: 'Vegeta',
    ki: 3900,
    matchesPlayed: 4,
    wins: 2,
    losses: 2,
    winRatePercent: 50,
  },
],
```

Replace the `formatHeroTable` describe:

```typescript
describe('formatHeroTable', () => {
  it('aligns names and shows ki · W-L · WR', () => {
    const table = formatHeroTable(baseProfile.heroes, 17);
    expect(table).toContain('Goku');
    expect(table).toContain('4200');
    expect(table).toContain('5W 3L · 62.5%');
    expect(table).not.toContain('· 8');
  });

  it('omits percent when the hero has no counted games', () => {
    const table = formatHeroTable(
      [
        {
          heroId: 1,
          name: 'Goku',
          ki: 4200,
          matchesPlayed: 8,
          wins: 0,
          losses: 0,
          winRatePercent: null,
        },
      ],
      17,
    );
    expect(table).toContain('0W 0L');
    expect(table).not.toContain('%');
  });

  it('returns italic empty copy when no heroes', () => {
    expect(formatHeroTable([], 17)).toBe('_No hero games yet_');
  });
});
```

Update the calibrating case hero object to include `wins: 0, losses: 2, winRatePercent: 0` (or `wins: 2, losses: 0, winRatePercent: 100` — must be consistent). Keep expecting `Calibrating` and `· 2` **removed**: that test currently asserts `· 2` for matchesPlayed. Change it to assert W-L instead:

```typescript
heroes: [
  {
    heroId: 1,
    name: 'Goku',
    ki: 4200,
    matchesPlayed: 2,
    wins: 2,
    losses: 1,
    winRatePercent: 66.7,
  },
],
```

and:

```typescript
expect(data.fields?.[0]?.value).toContain('Calibrating');
expect(data.fields?.[0]?.value).not.toContain('4200');
expect(data.fields?.[0]?.value).toContain('2W 1L · 66.7%');
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/services/player/rank-embed.test.ts`

Expected: FAIL — table still prints `· 8` / missing new fields on the type.

- [ ] **Step 3: Write minimal implementation**

`src/services/player/player-profile.ts`:

```typescript
import {
  gamesByPlayerFromStats,
  heroStatsFor,
  loadMatchDisplayStats,
  winRatePercent,
} from '../rating/rank-reset-display.js';

export type PlayerProfileHero = {
  heroId: number;
  name: string;
  ki: number;
  matchesPlayed: number;
  wins: number;
  losses: number;
  winRatePercent: number | null;
};
```

In `loadPlayerProfile`, replace `loadMatchDisplayStatsByPlayer(leagueId)` with `loadMatchDisplayStats(leagueId)` in the `Promise.all`. Destructure:

```typescript
const [rating, allRatings, heroRatings, displayStats] = await Promise.all([
  // rating / allRatings / heroRatings unchanged
  loadMatchDisplayStats(leagueId),
]);

const displayStatsByPlayer = displayStats.byPlayer;
```

Keep using `displayStatsByPlayer` for overall W/L / games / quits / calibrating.

Replace overall WR and hero mapping:

```typescript
const winRatePercentValue = winRatePercent(wins, losses);
const heroes: PlayerProfileHero[] = heroRatings
  .map((row) => {
    const heroWl = heroStatsFor(displayStats.byHero, player.id, row.heroId);
    return {
      heroId: row.heroId,
      name: row.hero.name,
      ki: displayOrdinal(row.mu, row.sigma, row.matchesPlayed),
      matchesPlayed: row.matchesPlayed,
      wins: heroWl.wins,
      losses: heroWl.losses,
      winRatePercent: winRatePercent(heroWl.wins, heroWl.losses),
    };
  })
  .sort((a, b) => b.ki - a.ki || a.name.localeCompare(b.name));
```

Return `winRatePercent: winRatePercentValue` (do not shadow the imported function with a local `const winRatePercent`).

`src/services/player/rank-embed.ts` — replace `formatHeroTable` cell mapping:

```typescript
const cells = heroes.map((hero) => {
  const record = `${hero.wins}W ${hero.losses}L`;
  const recordWithWr =
    hero.winRatePercent === null ? record : `${record} · ${hero.winRatePercent}%`;
  return {
    name: hero.name,
    ki: formatPublicKi(hero.ki, leagueGames),
    record: recordWithWr,
  };
});
const nameWidth = Math.max(...cells.map((cell) => cell.name.length));
const kiWidth = Math.max(...cells.map((cell) => cell.ki.length));

const lines = cells.map((cell) => {
  const name = cell.name.padEnd(nameWidth, ' ');
  const ki = cell.ki.padStart(kiWidth, ' ');
  return `${name}  ${ki} · ${cell.record}`;
});
```

Leave the overall record line (`12W · 5L · 2Q · 70.6% WR`) unchanged.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/services/player/rank-embed.test.ts src/services/rating/rank-reset-display.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/player/player-profile.ts src/services/player/rank-embed.ts src/services/player/rank-embed.test.ts
git commit -m "$(cat <<'EOF'
feat(rank): show per-hero W/L and win rate

EOF
)"
```

---

### Task 3: [general] WR column on overall, live, and single-hero boards

**Files:**

- Modify: `src/services/leaderboard/leaderboard.ts`
- Modify: `src/services/leaderboard/leaderboard.test.ts`
- Modify: `src/services/leaderboard/leaderboard-embed.ts`
- Modify: `src/services/leaderboard/leaderboard-embed.test.ts`

**Interfaces:**

- Consumes: `winRatePercent`, `heroStatsFor`, `loadMatchDisplayStats` from Task 1
- Produces: `OverallLeaderboardEntry.winRatePercent`, `HeroLeaderboardEntry.winRatePercent`; `formatOverallTable` header `WR`; compact table still `# name ki`

- [ ] **Step 1: Write the failing tests**

In `src/services/leaderboard/leaderboard-embed.test.ts`, add `winRatePercent` to `fakeEntry` and every inline entry object (use `50` unless the test cares). Example:

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
    winRatePercent: 50,
  };
}
```

Add to `formatOverallTable`:

```typescript
it('adds a WR column', () => {
  const table = formatOverallTable([
    {
      rank: 1,
      playerId: 'p1',
      username: 'Tinys',
      ki: 4200,
      games: 17,
      leagueGames: 17,
      discordId: null,
      winRatePercent: 70.6,
    },
  ]);
  expect(table).toContain('WR');
  expect(table).toContain('70.6%');
});

it('prints an em dash when winRatePercent is null', () => {
  const table = formatOverallTable([
    {
      rank: 1,
      playerId: 'p1',
      username: 'Tinys',
      ki: 4200,
      games: 8,
      leagueGames: 8,
      discordId: null,
      winRatePercent: null,
    },
  ]);
  expect(table).toMatch(/WR/);
  expect(table).toContain('—');
});
```

Add to `buildAllHeroLeaderboardsEmbed` (compact must **not** show WR even if the DTO has it):

```typescript
          {
            rank: 1,
            playerId: 'p1',
            username: 'Tinys',
            ki: 4200,
            matchesPlayed: 8,
            leagueGames: 8,
            winRatePercent: 62.5,
          },
```

and:

```typescript
    expect(embed.data.fields?.[0]?.value).toContain('Tinys');
    expect(embed.data.fields?.[0]?.value).toContain('4200');
    expect(embed.data.fields?.[0]?.value).not.toContain('WR');
    expect(embed.data.fields?.[0]?.value).not.toContain('62.5%');
  });
```

Add `winRatePercent: 0` (or `50`) to the calibrating `buildHeroLeaderboardEmbed` entry.

In `src/services/leaderboard/leaderboard.test.ts`, add `winRatePercent: 50` to the `paginateOverall` `base` objects.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/services/leaderboard/leaderboard-embed.test.ts src/services/leaderboard/leaderboard.test.ts`

Expected: FAIL — missing `winRatePercent` on types and/or no `WR` header.

- [ ] **Step 3: Write minimal implementation**

`src/services/leaderboard/leaderboard.ts` — imports and types:

```typescript
import {
  gamesByPlayerFromStats,
  heroStatsFor,
  loadMatchDisplayStats,
  loadMatchDisplayStatsByPlayer,
  winRatePercent,
} from '../rating/rank-reset-display.js';

export type OverallLeaderboardEntry = {
  rank: number | null;
  playerId: string;
  username: string;
  ki: number;
  games: number;
  leagueGames: number;
  discordId: string | null;
  winRatePercent: number | null;
};

export type HeroLeaderboardEntry = {
  rank: number | null;
  playerId: string;
  username: string;
  ki: number;
  matchesPlayed: number;
  leagueGames: number;
  winRatePercent: number | null;
};
```

Overall mapping: keep `loadMatchDisplayStatsByPlayer`. After `const games = ...`:

```typescript
const stats = displayStatsByPlayer.get(row.playerId);
return {
  playerId: row.playerId,
  username: row.player.username,
  discordId: row.player.discordId,
  ki: displayOrdinal(row.mu, row.sigma, games),
  games,
  leagueGames: games,
  winRatePercent: winRatePercent(stats?.wins ?? 0, stats?.losses ?? 0),
};
```

Include `winRatePercent: row.winRatePercent` in the `rankLeaderboardRows(...).map` return.

`mapHeroRatings` — add `byHero` and `heroId` parameters:

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
  byHero: Map<string, Map<number, { wins: number; losses: number }>>,
  heroId: number,
  limit: number,
): HeroLeaderboardEntry[] {
  const mapped = rows
    .filter((row) => row.matchesPlayed > 0)
    .map((row) => {
      const heroWl = heroStatsFor(byHero, row.playerId, heroId);
      return {
        playerId: row.playerId,
        username: row.player.username,
        ki: displayOrdinal(row.mu, row.sigma, row.matchesPlayed),
        matchesPlayed: row.matchesPlayed,
        leagueGames: leagueGamesByPlayer.get(row.playerId) ?? 0,
        winRatePercent: winRatePercent(heroWl.wins, heroWl.losses),
      };
    });

  return rankLeaderboardRows(mapped, (row) => row.leagueGames)
    .slice(0, limit)
    .map((row) => ({
      rank: row.rank,
      playerId: row.playerId,
      username: row.username,
      ki: row.ki,
      matchesPlayed: row.matchesPlayed,
      leagueGames: row.leagueGames,
      winRatePercent: row.winRatePercent,
    }));
}
```

`loadHeroLeaderboard`:

```typescript
const [rows, displayStats] = await Promise.all([
  prisma.playerHeroRating.findMany({
    where: { leagueId, heroId, matchesPlayed: { gt: 0 } },
    include: { player: { select: { username: true } } },
  }),
  loadMatchDisplayStats(leagueId),
]);
const leagueGamesByPlayer = gamesByPlayerFromStats(displayStats.byPlayer);
return {
  heroName: hero.name,
  entries: mapHeroRatings(rows, leagueGamesByPlayer, displayStats.byHero, heroId, limit),
};
```

`loadAllHeroLeaderboards`: load the bundle **once**, then pass `displayStats.byHero` and `hero.id` into `mapHeroRatings`.

`src/services/leaderboard/leaderboard-embed.ts` — `formatOverallTable`:

```typescript
function formatWinRateCell(percent: number | null): string {
  return percent === null ? '—' : `${percent}%`;
}

export function formatOverallTable(entries: OverallLeaderboardEntry[], ratingLabel = 'ki'): string {
  if (entries.length === 0) {
    return '_No ranked players yet._';
  }

  const labelHeader =
    ratingLabel.length === 0 ? 'Ki' : ratingLabel.charAt(0).toUpperCase() + ratingLabel.slice(1);
  const nameWidth = Math.max(...entries.map((entry) => entry.username.length), 'Player'.length);
  const kiWidth = Math.max(
    ...entries.map((entry) => formatPublicKi(entry.ki, entry.leagueGames).length),
    labelHeader.length,
  );
  const wrWidth = Math.max(
    ...entries.map((entry) => formatWinRateCell(entry.winRatePercent).length),
    'WR'.length,
  );
  const header = `${'#'.padEnd(3)} ${'Player'.padEnd(nameWidth)}  ${labelHeader.padStart(kiWidth)}  G  ${'WR'.padStart(wrWidth)}`;
  const lines = entries.map((entry) => {
    const prefix = formatRankPrefix(entry.rank).padEnd(3);
    const name = entry.username.padEnd(nameWidth, ' ');
    const ki = formatPublicKi(entry.ki, entry.leagueGames).padStart(kiWidth, ' ');
    const wr = formatWinRateCell(entry.winRatePercent).padStart(wrWidth, ' ');
    return `${prefix} ${name}  ${ki}  ${entry.games}  ${wr}`;
  });
  return `\`\`\`\n${header}\n${lines.join('\n')}\n\`\`\``;
}
```

Leave `formatHeroCompactTable` as `# name ki` only.

`buildHeroLeaderboardEmbed` mapped object must include `winRatePercent: entry.winRatePercent`.

Live overall already calls `formatOverallTable` — no channel/command adapter changes.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/services/leaderboard src/services/player/rank-embed.test.ts src/services/rating/rank-reset-display.test.ts`

Expected: PASS

Then: `npm test`

Expected: all files PASS (fix any other `OverallLeaderboardEntry` / `HeroLeaderboardEntry` / `PlayerProfileHero` literals the compiler reports — search the repo for `matchesPlayed:` object literals in tests if Vitest/tsc fails).

- [ ] **Step 5: Commit**

```bash
git add src/services/leaderboard/leaderboard.ts src/services/leaderboard/leaderboard.test.ts src/services/leaderboard/leaderboard-embed.ts src/services/leaderboard/leaderboard-embed.test.ts
git commit -m "$(cat <<'EOF'
feat(leaderboard): add WR column to overall and hero boards

EOF
)"
```

---

## Plan self-review

**Spec coverage**

| Spec requirement                                                 | Task                                      |
| ---------------------------------------------------------------- | ----------------------------------------- |
| Shared `winRatePercent()` formula                                | 1                                         |
| Hero aggregate + skip null `heroId` + rank reset + no per-hero Q | 1                                         |
| Bundle loader; by-player loader unchanged for overall            | 1                                         |
| `/rank` overall line unchanged                                   | 2 (do not touch record string)            |
| `/rank` hero `5W 3L · 62.5%`; omit `%` on 0 games                | 2                                         |
| Overall + live `G` + `WR`                                        | 3 (`formatOverallTable` shared with live) |
| Single-hero same table; `G` = `matchesPlayed`                    | 3                                         |
| Compact ki-only; DTO still has `winRatePercent`                  | 3                                         |
| Sort still ki                                                    | unchanged                                 |
| No schema / commands / customIds                                 | none added                                |

**Placeholder scan:** none.

**Type consistency:** `winRatePercent`, `heroStatsFor`, `loadMatchDisplayStats`, `PlayerHeroMatchDisplayStats`, `PlayerProfileHero.{wins,losses,winRatePercent}`, `OverallLeaderboardEntry.winRatePercent`, `HeroLeaderboardEntry.winRatePercent` match across tasks.
