# Winstreak Leaderboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-league winstreak leaderboard (current and/or best consecutive wins) with moderator-configurable display/sort, live channel message, and paginated `/leaderboard winstreaks`.

**Architecture:** Store live-board settings on `League` (same tenancy as overall live board). Aggregate `MatchPlayer.result` on `COMPLETED` matches for that league on read; compute current/best streaks in memory. Reuse overall live packing (size 10–100, chunk 25) and slash pagination (10/page). Refresh winstreak boards from the same scheduler and match-outcome hooks as overall boards.

**Tech Stack:** TypeScript ESM, Prisma, discord.js v14, Vitest

**Spec:** `docs/superpowers/specs/2026-08-16-winstreak-leaderboard-design.md`

## Global Constraints

- Scope: `general` (per-league; not game-specific)
- English-only user-facing strings and errors
- Live size min **10**, max **100**, default **10**, chunk **25**
- Slash page size **10** (`LEADERBOARD_PAGE_SIZE`)
- Only `COMPLETED` matches; ignore `CANCELLED` / `IN_PROGRESS` / `PENDING`
- Non-win (`LOSS`, including quit-as-loss) breaks streak; order by `completedAt` then `match.id`
- Defaults: display **`both`**, sort **`current`**
- Sort may use a metric not shown in columns
- ESM imports use `.js` extension; named exports
- No new production env / SSM keys

## File map

| File                                                             | Role                                                                  |
| ---------------------------------------------------------------- | --------------------------------------------------------------------- |
| `prisma/schema.prisma`                                           | Enums + `League` winstreak leaderboard fields                         |
| `prisma/migrations/…_add_winstreak_leaderboard/`                 | Migration SQL                                                         |
| `src/services/league/league-wc3stats.ts`                         | Resolve + set/clear winstreak board settings                          |
| `src/services/league/index.ts`                                   | Re-exports                                                            |
| `src/services/leaderboard/winstreak-leaderboard.ts`              | Streak compute, sort, page, size assert                               |
| `src/services/leaderboard/winstreak-leaderboard.test.ts`         | Streak/sort/rank/page/isolation tests                                 |
| `src/services/leaderboard/winstreak-leaderboard-embed.ts`        | Table + slash/live embeds + page buttons                              |
| `src/services/leaderboard/winstreak-leaderboard-embed.test.ts`   | Column filtering / empty copy / chunk stamp                           |
| `src/services/leaderboard/winstreak-leaderboard-channel.ts`      | Setup / clear / refresh league live message                           |
| `src/services/leaderboard/winstreak-leaderboard-channel.test.ts` | Skip when unbound; edit embeds                                        |
| `src/services/leaderboard/leaderboard-channel.ts`                | Call winstreak refresh from `refreshLeagueLeaderboard` + `refreshAll` |
| `src/services/leaderboard/index.ts`                              | Re-export winstreak symbols                                           |
| `src/commands/config/config.ts`                                  | set/clear/view winstreak keys (**with** `league`)                     |
| `src/commands/player/leaderboard.ts`                             | `winstreaks` + `setup_winstreaks`                                     |
| `src/discord/interactions/leaderboard-interactions.ts`           | Handle `lb:winstreaks:…` buttons                                      |
| `src/discord/interactions/match-correction-interactions.ts`      | Ensure winstreak refresh (via league refresh hook)                    |
| `docs/discord/staff/a1-roles-and-setup.md`                       | Document setup                                                        |
| `docs/discord/staff/a5-admin-cheat-sheet.md`                     | Cheat lines                                                           |

---

### Task 1: Schema + League config setters

**Files:**

- Modify: `prisma/schema.prisma`
- Create: migration via `npm run db:migrate`
- Modify: `src/services/league/league-wc3stats.ts`
- Modify: `src/services/league/index.ts`
- Create: `src/services/league/league-winstreak-config.test.ts`

**Interfaces:**

- Produces:
  - Prisma enums `WinstreakLeaderboardDisplay` (`current` \| `best` \| `both`), `WinstreakLeaderboardSort` (`current` \| `best`)
  - `League` fields: `winstreakLeaderboardChannelId`, `winstreakLeaderboardMessageId`, `winstreakLeaderboardSize` (default 10), `winstreakLeaderboardDisplay` (default `both`), `winstreakLeaderboardSort` (default `current`)
  - `ResolvedLeagueConfig` extended with those five fields (channel/message optional strings; size number; display/sort string unions)
  - `setLeagueWinstreakLeaderboardChannel(leagueId, channelId, messageId): Promise<void>`
  - `clearLeagueWinstreakLeaderboardChannel(leagueId): Promise<void>`
  - `setLeagueWinstreakLeaderboardSize(leagueId, size: number): Promise<void>` — uses `assertWinstreakLeaderboardSize` from Task 2 once available; for this task call `assertLiveLeaderboardSize` temporarily **or** defer size setter until Task 2 — prefer validating with a local throw matching the error string, then switch import in Task 2
  - `clearLeagueWinstreakLeaderboardSize(leagueId): Promise<void>` → size 10
  - `setLeagueWinstreakLeaderboardDisplay(leagueId, display): Promise<void>`
  - `clearLeagueWinstreakLeaderboardDisplay(leagueId): Promise<void>` → `both`
  - `setLeagueWinstreakLeaderboardSort(leagueId, sort): Promise<void>`
  - `clearLeagueWinstreakLeaderboardSort(leagueId): Promise<void>` → `current`

- [ ] **Step 1: Write failing resolve/setter tests**

Create `src/services/league/league-winstreak-config.test.ts`:

```typescript
import { beforeEach, describe, expect, it, vi } from 'vitest';

const findUnique = vi.fn();
const update = vi.fn();

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    league: {
      findUnique: (...args: unknown[]) => findUnique(...args),
      update: (...args: unknown[]) => update(...args),
    },
  },
}));

vi.mock('../wc3stats/wc3stats-slot-map.js', () => ({
  clearAllLeagueWc3statsSlotMaps: vi.fn(),
  parseWc3statsMapSha1: () => [],
  replaceLeagueWc3statsSlotMaps: vi.fn(),
  UDBR_MAP_PATTERN: '',
  UDBR_MAP_SHA1: '',
  UDBR_WC3STATS_SLOT_MAP: [],
}));

vi.mock('../lobby/register-lobby-source.js', () => ({
  assertLeagueAllowsWc3stats: vi.fn(),
  WC3STATS_CONFIG_UNSUPPORTED_MESSAGE: 'unsupported',
}));

vi.mock('../rating/rank-reset.js', () => ({
  assertRankResetCooldownDays: (n: number) => n,
}));

vi.mock('../leaderboard/leaderboard.js', () => ({
  LIVE_LEADERBOARD_DEFAULT_SIZE: 10,
  assertLiveLeaderboardSize: (n: number) => n,
}));

import {
  clearLeagueWinstreakLeaderboardDisplay,
  clearLeagueWinstreakLeaderboardSize,
  clearLeagueWinstreakLeaderboardSort,
  resolveLeagueConfig,
  setLeagueWinstreakLeaderboardDisplay,
  setLeagueWinstreakLeaderboardSize,
  setLeagueWinstreakLeaderboardSort,
} from './league-wc3stats.js';

describe('winstreak leaderboard league config', () => {
  beforeEach(() => {
    findUnique.mockReset();
    update.mockReset();
  });

  it('resolves winstreak board defaults when row missing', async () => {
    findUnique.mockResolvedValue(null);
    const resolved = await resolveLeagueConfig('league-1');
    expect(resolved.winstreakLeaderboardChannelId).toBeUndefined();
    expect(resolved.winstreakLeaderboardMessageId).toBeUndefined();
    expect(resolved.winstreakLeaderboardSize).toBe(10);
    expect(resolved.winstreakLeaderboardDisplay).toBe('both');
    expect(resolved.winstreakLeaderboardSort).toBe('current');
  });

  it('setLeagueWinstreakLeaderboardSize updates size', async () => {
    update.mockResolvedValue({});
    await setLeagueWinstreakLeaderboardSize('league-1', 50);
    expect(update).toHaveBeenCalledWith({
      where: { id: 'league-1' },
      data: { winstreakLeaderboardSize: 50 },
    });
  });

  it('clear helpers reset display/sort/size defaults', async () => {
    update.mockResolvedValue({});
    await clearLeagueWinstreakLeaderboardSize('league-1');
    await clearLeagueWinstreakLeaderboardDisplay('league-1');
    await clearLeagueWinstreakLeaderboardSort('league-1');
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { winstreakLeaderboardSize: 10 } }),
    );
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { winstreakLeaderboardDisplay: 'both' } }),
    );
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { winstreakLeaderboardSort: 'current' } }),
    );
  });

  it('set display and sort update enums', async () => {
    update.mockResolvedValue({});
    await setLeagueWinstreakLeaderboardDisplay('league-1', 'best');
    await setLeagueWinstreakLeaderboardSort('league-1', 'best');
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { winstreakLeaderboardDisplay: 'best' } }),
    );
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { winstreakLeaderboardSort: 'best' } }),
    );
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

Run: `npm test -- src/services/league/league-winstreak-config.test.ts`

Expected: FAIL — missing exports / fields.

- [ ] **Step 3: Update Prisma schema**

On `League` and new enums in `prisma/schema.prisma`:

```prisma
enum WinstreakLeaderboardDisplay {
  current
  best
  both
}

enum WinstreakLeaderboardSort {
  current
  best
}

model League {
  // …existing fields…
  winstreakLeaderboardChannelId  String?
  winstreakLeaderboardMessageId  String?
  winstreakLeaderboardSize       Int                          @default(10)
  winstreakLeaderboardDisplay    WinstreakLeaderboardDisplay  @default(both)
  winstreakLeaderboardSort       WinstreakLeaderboardSort     @default(current)
}
```

Run: `npm run db:migrate -- --name add_winstreak_leaderboard`

- [ ] **Step 4: Implement resolve + setters in `league-wc3stats.ts`**

Extend `ResolvedLeagueConfig` and `resolveLeagueConfig` mapping (trim channel/message; default size 10; display `both`; sort `current`).

Add setters mirroring `setLeagueLeaderboardChannel` / `clearLeagueLeaderboardSize` pattern (`prisma.league.update`). For size, use `assertLiveLeaderboardSize` until Task 2 exports `assertWinstreakLeaderboardSize`, then switch the size setter to that assert (error message must be `Winstreak leaderboard size must be between 10 and 100.`).

Re-export new functions from `src/services/league/index.ts`.

- [ ] **Step 5: Run tests — expect PASS**

Run: `npm test -- src/services/league/league-winstreak-config.test.ts`

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma prisma/migrations src/services/league/league-wc3stats.ts src/services/league/index.ts src/services/league/league-winstreak-config.test.ts
git commit -m "feat: add league winstreak leaderboard config fields"
```

---

### Task 2: Streak query service

**Files:**

- Create: `src/services/leaderboard/winstreak-leaderboard.ts`
- Create: `src/services/leaderboard/winstreak-leaderboard.test.ts`
- Modify: `src/services/league/league-wc3stats.ts` (size assert → `assertWinstreakLeaderboardSize`)
- Modify: `src/services/leaderboard/index.ts`

**Interfaces:**

- Produces:
  - `WinstreakLeaderboardDisplayMode = 'current' | 'best' | 'both'`
  - `WinstreakLeaderboardSortMode = 'current' | 'best'`
  - `WinstreakLeaderboardEntry = { rank, playerId, username, discordId, current, best }`
  - `WinstreakLeaderboardPage = { entries, page, totalPages, totalPlayers, display, sort }`
  - `assertWinstreakLeaderboardSize(size: number): number`
  - `computeWinStreaks(results: Array<'WIN' | 'LOSS'>): { current: number; best: number }` — pure helper
  - `filterEligibleWinstreakRows`, `sortWinstreakRows`, `paginateWinstreakEntries`
  - `loadWinstreakLeaderboard(leagueId, { display, sort }): Promise<WinstreakLeaderboardEntry[]>`
  - `loadWinstreakLeaderboardPage(leagueId, page, display?, sort?): Promise<WinstreakLeaderboardPage>`
  - `loadWinstreakLeaderboardTop(leagueId, size, display?, sort?): Promise<WinstreakLeaderboardEntry[]>`
- Consumes: `assignCompetitionRanks` from `./quitter-leaderboard.js`; `LEADERBOARD_PAGE_SIZE`, `clampPage`, `LeaderboardServiceError`, size min/max from `./leaderboard.js`

- [ ] **Step 1: Write failing pure + service tests**

```typescript
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MatchResult, MatchStatus } from '@prisma/client';

const findMany = vi.fn();
const findUnique = vi.fn();

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    matchPlayer: { findMany: (...args: unknown[]) => findMany(...args) },
    league: { findUnique: (...args: unknown[]) => findUnique(...args) },
  },
}));

import {
  assertWinstreakLeaderboardSize,
  computeWinStreaks,
  filterEligibleWinstreakRows,
  loadWinstreakLeaderboard,
  paginateWinstreakEntries,
  sortWinstreakRows,
} from './winstreak-leaderboard.js';
import { LeaderboardServiceError } from './leaderboard.js';

describe('computeWinStreaks', () => {
  it('empty → 0/0', () => {
    expect(computeWinStreaks([])).toEqual({ current: 0, best: 0 });
  });

  it('trailing wins set current; best tracks max run', () => {
    expect(computeWinStreaks(['WIN', 'WIN', 'LOSS', 'WIN', 'WIN', 'WIN'])).toEqual({
      current: 3,
      best: 3,
    });
  });

  it('loss at end zeros current but keeps best', () => {
    expect(computeWinStreaks(['WIN', 'WIN', 'LOSS'])).toEqual({ current: 0, best: 2 });
  });

  it('best can exceed current mid-history', () => {
    expect(computeWinStreaks(['WIN', 'WIN', 'WIN', 'LOSS', 'WIN'])).toEqual({
      current: 1,
      best: 3,
    });
  });
});

describe('filter/sort/page', () => {
  const rows = [
    { playerId: 'a', username: 'A', discordId: null, current: 2, best: 5 },
    { playerId: 'b', username: 'B', discordId: null, current: 0, best: 4 },
    { playerId: 'c', username: 'C', discordId: null, current: 3, best: 3 },
  ];

  it('current sort keeps current≥1 only', () => {
    expect(filterEligibleWinstreakRows(rows, 'current').map((r) => r.playerId)).toEqual(['a', 'c']);
  });

  it('best sort keeps best≥1', () => {
    expect(filterEligibleWinstreakRows(rows, 'best')).toHaveLength(3);
  });

  it('sorts by current then best then name', () => {
    const sorted = sortWinstreakRows(
      rows.filter((r) => r.current >= 1),
      'current',
    );
    expect(sorted.map((r) => r.playerId)).toEqual(['c', 'a']);
  });

  it('paginates', () => {
    const ranked = [
      { rank: 1, playerId: 'c', username: 'C', discordId: null, current: 3, best: 3 },
    ];
    const page = paginateWinstreakEntries(ranked, 1, 'both', 'current');
    expect(page.totalPlayers).toBe(1);
    expect(page.entries).toHaveLength(1);
  });
});

describe('assertWinstreakLeaderboardSize', () => {
  it('rejects 9 and 101', () => {
    expect(() => assertWinstreakLeaderboardSize(9)).toThrow(LeaderboardServiceError);
    expect(() => assertWinstreakLeaderboardSize(101)).toThrow(
      /Winstreak leaderboard size must be between 10 and 100/,
    );
  });
  it('accepts 10 and 100', () => {
    expect(assertWinstreakLeaderboardSize(10)).toBe(10);
    expect(assertWinstreakLeaderboardSize(100)).toBe(100);
  });
});

describe('loadWinstreakLeaderboard', () => {
  beforeEach(() => {
    findMany.mockReset();
    findUnique.mockReset();
  });

  it('aggregates only COMPLETED matches for the league and ranks', async () => {
    findMany.mockResolvedValue([
      {
        playerId: 'p1',
        result: MatchResult.WIN,
        match: { id: 'm1', completedAt: new Date('2026-01-01'), status: MatchStatus.COMPLETED },
        player: { username: 'Goku', discordId: 'd1' },
      },
      {
        playerId: 'p1',
        result: MatchResult.WIN,
        match: { id: 'm2', completedAt: new Date('2026-01-02'), status: MatchStatus.COMPLETED },
        player: { username: 'Goku', discordId: 'd1' },
      },
      {
        playerId: 'p1',
        result: MatchResult.LOSS,
        match: { id: 'm3', completedAt: new Date('2026-01-03'), status: MatchStatus.COMPLETED },
        player: { username: 'Goku', discordId: 'd1' },
      },
    ]);

    const rows = await loadWinstreakLeaderboard('league-1', {
      display: 'both',
      sort: 'best',
    });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          match: {
            leagueId: 'league-1',
            status: MatchStatus.COMPLETED,
            completedAt: { not: null },
          },
          result: { not: null },
        },
      }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      username: 'Goku',
      current: 0,
      best: 2,
      rank: 1,
    });
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL**

Run: `npm test -- src/services/leaderboard/winstreak-leaderboard.test.ts`

Expected: FAIL — module missing.

- [ ] **Step 3: Implement `winstreak-leaderboard.ts`**

```typescript
import { MatchResult, MatchStatus } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import {
  LeaderboardServiceError,
  LEADERBOARD_PAGE_SIZE,
  LIVE_LEADERBOARD_MAX_SIZE,
  LIVE_LEADERBOARD_MIN_SIZE,
  clampPage,
} from './leaderboard.js';
import { assignCompetitionRanks } from './quitter-leaderboard.js';

export type WinstreakLeaderboardDisplayMode = 'current' | 'best' | 'both';
export type WinstreakLeaderboardSortMode = 'current' | 'best';

export type WinstreakLeaderboardEntry = {
  rank: number;
  playerId: string;
  username: string;
  discordId: string | null;
  current: number;
  best: number;
};

export type WinstreakLeaderboardPage = {
  entries: WinstreakLeaderboardEntry[];
  page: number;
  totalPages: number;
  totalPlayers: number;
  display: WinstreakLeaderboardDisplayMode;
  sort: WinstreakLeaderboardSortMode;
};

export function assertWinstreakLeaderboardSize(size: number): number {
  if (
    !Number.isInteger(size) ||
    size < LIVE_LEADERBOARD_MIN_SIZE ||
    size > LIVE_LEADERBOARD_MAX_SIZE
  ) {
    throw new LeaderboardServiceError('Winstreak leaderboard size must be between 10 and 100.');
  }
  return size;
}

/** Walk chronological WIN/LOSS results; non-WIN resets the run. */
export function computeWinStreaks(results: Array<'WIN' | 'LOSS'>): {
  current: number;
  best: number;
} {
  let run = 0;
  let best = 0;
  for (const result of results) {
    if (result === 'WIN') {
      run += 1;
      if (run > best) best = run;
    } else {
      run = 0;
    }
  }
  return { current: run, best };
}

export function filterEligibleWinstreakRows(
  rows: Omit<WinstreakLeaderboardEntry, 'rank'>[],
  sort: WinstreakLeaderboardSortMode,
): Omit<WinstreakLeaderboardEntry, 'rank'>[] {
  if (sort === 'current') {
    return rows.filter((row) => row.current >= 1);
  }
  return rows.filter((row) => row.best >= 1);
}

export function sortWinstreakRows(
  rows: Omit<WinstreakLeaderboardEntry, 'rank'>[],
  sort: WinstreakLeaderboardSortMode,
): Omit<WinstreakLeaderboardEntry, 'rank'>[] {
  const copy = [...rows];
  copy.sort((a, b) => {
    if (sort === 'current') {
      if (b.current !== a.current) return b.current - a.current;
      if (b.best !== a.best) return b.best - a.best;
      return a.username.localeCompare(b.username);
    }
    if (b.best !== a.best) return b.best - a.best;
    if (b.current !== a.current) return b.current - a.current;
    return a.username.localeCompare(b.username);
  });
  return copy;
}

export function paginateWinstreakEntries(
  rows: WinstreakLeaderboardEntry[],
  page: number,
  display: WinstreakLeaderboardDisplayMode,
  sort: WinstreakLeaderboardSortMode,
): WinstreakLeaderboardPage {
  const totalPlayers = rows.length;
  const totalPages = Math.max(1, Math.ceil(totalPlayers / LEADERBOARD_PAGE_SIZE) || 1);
  const safePage = clampPage(page, totalPages);
  const start = (safePage - 1) * LEADERBOARD_PAGE_SIZE;
  return {
    entries: rows.slice(start, start + LEADERBOARD_PAGE_SIZE),
    page: safePage,
    totalPages: totalPlayers === 0 ? 1 : totalPages,
    totalPlayers,
    display,
    sort,
  };
}

type RawRow = {
  playerId: string;
  result: MatchResult | null;
  match: { id: string; completedAt: Date | null };
  player: { username: string; discordId: string | null };
};

function aggregateRows(raw: RawRow[]): Omit<WinstreakLeaderboardEntry, 'rank'>[] {
  const byPlayer = new Map<
    string,
    {
      username: string;
      discordId: string | null;
      results: Array<{ at: Date; matchId: string; result: 'WIN' | 'LOSS' }>;
    }
  >();

  for (const row of raw) {
    if (row.result !== MatchResult.WIN && row.result !== MatchResult.LOSS) continue;
    if (!row.match.completedAt) continue;
    let agg = byPlayer.get(row.playerId);
    if (!agg) {
      agg = {
        username: row.player.username,
        discordId: row.player.discordId,
        results: [],
      };
      byPlayer.set(row.playerId, agg);
    }
    agg.results.push({
      at: row.match.completedAt,
      matchId: row.match.id,
      result: row.result === MatchResult.WIN ? 'WIN' : 'LOSS',
    });
  }

  return [...byPlayer.entries()].map(([playerId, agg]) => {
    agg.results.sort((a, b) => {
      const t = a.at.getTime() - b.at.getTime();
      if (t !== 0) return t;
      return a.matchId.localeCompare(b.matchId);
    });
    const streaks = computeWinStreaks(agg.results.map((r) => r.result));
    return {
      playerId,
      username: agg.username,
      discordId: agg.discordId,
      current: streaks.current,
      best: streaks.best,
    };
  });
}

export async function loadWinstreakLeaderboard(
  leagueId: string,
  options: { display: WinstreakLeaderboardDisplayMode; sort: WinstreakLeaderboardSortMode },
): Promise<WinstreakLeaderboardEntry[]> {
  const raw = await prisma.matchPlayer.findMany({
    where: {
      match: {
        leagueId,
        status: MatchStatus.COMPLETED,
        completedAt: { not: null },
      },
      result: { not: null },
    },
    select: {
      playerId: true,
      result: true,
      match: { select: { id: true, completedAt: true } },
      player: { select: { username: true, discordId: true } },
    },
  });

  const aggregated = aggregateRows(raw);
  const eligible = filterEligibleWinstreakRows(aggregated, options.sort);
  const sorted = sortWinstreakRows(eligible, options.sort);
  return assignCompetitionRanks(sorted, (a, b) =>
    options.sort === 'current' ? a.current === b.current : a.best === b.best,
  );
}

export async function loadWinstreakLeaderboardPage(
  leagueId: string,
  page: number,
  display?: WinstreakLeaderboardDisplayMode,
  sort?: WinstreakLeaderboardSortMode,
): Promise<WinstreakLeaderboardPage> {
  const cfg = await prisma.league.findUnique({
    where: { id: leagueId },
    select: {
      winstreakLeaderboardDisplay: true,
      winstreakLeaderboardSort: true,
    },
  });
  const resolvedDisplay = display ?? cfg?.winstreakLeaderboardDisplay ?? 'both';
  const resolvedSort = sort ?? cfg?.winstreakLeaderboardSort ?? 'current';
  const rows = await loadWinstreakLeaderboard(leagueId, {
    display: resolvedDisplay,
    sort: resolvedSort,
  });
  return paginateWinstreakEntries(rows, page, resolvedDisplay, resolvedSort);
}

export async function loadWinstreakLeaderboardTop(
  leagueId: string,
  size: number,
  display?: WinstreakLeaderboardDisplayMode,
  sort?: WinstreakLeaderboardSortMode,
): Promise<WinstreakLeaderboardEntry[]> {
  const cfg = await prisma.league.findUnique({
    where: { id: leagueId },
    select: {
      winstreakLeaderboardDisplay: true,
      winstreakLeaderboardSort: true,
    },
  });
  const resolvedDisplay = display ?? cfg?.winstreakLeaderboardDisplay ?? 'both';
  const resolvedSort = sort ?? cfg?.winstreakLeaderboardSort ?? 'current';
  const rows = await loadWinstreakLeaderboard(leagueId, {
    display: resolvedDisplay,
    sort: resolvedSort,
  });
  return rows.slice(0, size);
}
```

Wire `setLeagueWinstreakLeaderboardSize` to `assertWinstreakLeaderboardSize`. Re-export from `leaderboard/index.ts`.

- [ ] **Step 4: Run tests — expect PASS**

Run: `npm test -- src/services/leaderboard/winstreak-leaderboard.test.ts src/services/league/league-winstreak-config.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/services/leaderboard/winstreak-leaderboard.ts src/services/leaderboard/winstreak-leaderboard.test.ts src/services/leaderboard/index.ts src/services/league/league-wc3stats.ts
git commit -m "feat: add winstreak leaderboard streak aggregation"
```

---

### Task 3: Embed builders

**Files:**

- Create: `src/services/leaderboard/winstreak-leaderboard-embed.ts`
- Create: `src/services/leaderboard/winstreak-leaderboard-embed.test.ts`
- Modify: `src/services/leaderboard/index.ts`

**Interfaces:**

- Produces:
  - `formatWinstreakTable(entries, display): string`
  - `buildWinstreakLeaderboardEmbed(page): EmbedBuilder`
  - `buildWinstreakLiveLeaderboardEmbeds(entries, display, sort, updatedAt): EmbedBuilder[]`
  - `buildWinstreakPageCustomId(invokerId, leagueId, direction, currentPage): string`
  - `parseWinstreakPageCustomId(customId): { invokerId, leagueId, page } | null`
  - `buildWinstreakPageButtons({ invokerId, leagueId, page, totalPages })`
- Custom id format: `lb:winstreaks:page:<invokerId>:<leagueId>:<prev|next>:<page>` (7 colon-parts)

- [ ] **Step 1: Write failing embed tests**

Mirror `quitter-leaderboard-embed.test.ts`: assert columns for `current` / `best` / `both`; empty `_No win streaks yet._`; live last embed has `Updated <t:`; parse round-trip includes `leagueId`.

- [ ] **Step 2: Run — expect FAIL**

Run: `npm test -- src/services/leaderboard/winstreak-leaderboard-embed.test.ts`

- [ ] **Step 3: Implement embeds**

Copy structure from `quitter-leaderboard-embed.ts`:

- Title `Winstreak Leaderboard` / `(continued)`
- Color `0xf0b232`
- Columns `#`, `Player`, optional `Current`, optional `Best`
- Footer `Sorted by current` / `Sorted by best`
- Reuse `chunkLeaderboardEntries` and `formatRankPrefix`

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add src/services/leaderboard/winstreak-leaderboard-embed.ts src/services/leaderboard/winstreak-leaderboard-embed.test.ts src/services/leaderboard/index.ts
git commit -m "feat: add winstreak leaderboard embeds"
```

---

### Task 4: Live channel + refresh hooks

**Files:**

- Create: `src/services/leaderboard/winstreak-leaderboard-channel.ts`
- Create: `src/services/leaderboard/winstreak-leaderboard-channel.test.ts`
- Modify: `src/services/leaderboard/leaderboard-channel.ts`
- Modify: `src/services/leaderboard/index.ts`

**Interfaces:**

- Produces:
  - `setupWinstreakLiveLeaderboard(client, leagueId, channelId): Promise<void>`
  - `clearWinstreakLiveLeaderboard(client, leagueId): Promise<void>`
  - `refreshLeagueWinstreakLeaderboard(client, leagueId): Promise<void>` — no-op if unbound
  - `refreshAllWinstreakLeaderboardChannels(client): Promise<void>`
- Consumes: league setters from Task 1; `loadWinstreakLeaderboardTop`; live embed builder

- [ ] **Step 1: Write failing refresh skip test**

Mirror `quitter-leaderboard-channel.test.ts`: unbound → no channel fetch; bound → `messages.edit` with embeds.

- [ ] **Step 2: Implement channel module**

Clone `quitter-leaderboard-channel.ts` but:

- Read/write `League` winstreak fields via `setLeagueWinstreakLeaderboardChannel` / `clearLeagueWinstreakLeaderboardChannel`
- `setup` best-effort deletes previous message, posts new, persists ids
- `refresh` edits or reposts like overall

- [ ] **Step 3: Hook refresh**

In `refreshLeagueLeaderboard`, after overall refresh attempt (or always at end, even if overall unbound):

```typescript
await refreshLeagueWinstreakLeaderboard(client, leagueId);
```

In `refreshAllLeaderboardChannels`, after the overall-bound loop (or expand league query), also:

```typescript
await refreshAllWinstreakLeaderboardChannels(client);
```

`refreshAllWinstreakLeaderboardChannels` finds leagues where both winstreak channel + message ids are non-null and calls `refreshLeagueWinstreakLeaderboard` each.

**Note:** Calling winstreak refresh from `refreshLeagueLeaderboard` covers match-correction / rank-reset / config paths that already pass `leagueId`. The `refreshAll` extra loop covers leagues with **only** a winstreak board bound (no overall live message).

- [ ] **Step 4: Run channel + existing leaderboard-channel tests**

Run: `npm test -- src/services/leaderboard/winstreak-leaderboard-channel.test.ts src/services/leaderboard/leaderboard-channel.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/services/leaderboard/winstreak-leaderboard-channel.ts src/services/leaderboard/winstreak-leaderboard-channel.test.ts src/services/leaderboard/leaderboard-channel.ts src/services/leaderboard/index.ts
git commit -m "feat: add live winstreak leaderboard channel refresh"
```

---

### Task 5: Slash commands `/leaderboard winstreaks` + `setup_winstreaks`

**Files:**

- Modify: `src/commands/player/leaderboard.ts`

**Interfaces:**

- Consumes: `loadWinstreakLeaderboardPage`, embed + button builders, `setupWinstreakLiveLeaderboard`, `resolveLeagueIdFromInteraction`, `withSubcommandLeagueOption`, `assertCanConfigureBot`

- [ ] **Step 1: Add subcommands to `data`**

```typescript
.addSubcommand((subcommand) =>
  withSubcommandLeagueOption(
    subcommand
      .setName('winstreaks')
      .setDescription('League winstreak leaderboard (top 10 per page)')
      .addIntegerOption((option) =>
        option.setName('page').setDescription('Page number').setRequired(false).setMinValue(1),
      ),
  ),
)
.addSubcommand((subcommand) =>
  withSubcommandLeagueOption(
    subcommand
      .setName('setup_winstreaks')
      .setDescription('Post a live winstreak leaderboard message in this channel'),
  ),
)
```

- [ ] **Step 2: Implement handlers**

`handleShowWinstreaks`: defer path like `handleShowOverall` — resolve league, load page, validate page bounds, reply with embed + `buildWinstreakPageButtons` including `leagueId`.

`handleSetupWinstreaks`: mirror `handleSetup` (configure-bot auth + league resolve) calling `setupWinstreakLiveLeaderboard(client, leagueId, channelId)`; ephemeral success: `Live winstreak leaderboard set in this channel. Keep only this message here.`

Wire both in `execute` switch.

- [ ] **Step 3: Smoke TypeScript**

Run: `npx tsc --noEmit` (or project’s usual check)

- [ ] **Step 4: Commit**

```bash
git add src/commands/player/leaderboard.ts
git commit -m "feat: add /leaderboard winstreaks and setup_winstreaks"
```

---

### Task 6: `/config` winstreak keys + view

**Files:**

- Modify: `src/commands/config/config.ts`

**Interfaces:**

- Consumes: league winstreak setters/clears; `refreshLeagueWinstreakLeaderboard`; `assertWinstreakLeaderboardSize` / `LeaderboardServiceError`; existing `resolveLeagueIdFromInteraction` for league-scoped keys (same as `leaderboard_channel` / `leaderboard_size`)

- [ ] **Step 1: Extend set/clear choice names**

Add under league-scoped config (with `league` option), parallel to overall leaderboard:

| Key                             | Behavior                                 |
| ------------------------------- | ---------------------------------------- |
| `winstreak_leaderboard_channel` | setup/clear live board in chosen channel |
| `winstreak_leaderboard_size`    | integer 10–100                           |
| `winstreak_leaderboard_display` | choices current/best/both                |
| `winstreak_leaderboard_sort`    | choices current/best                     |

On set size/display/sort: persist then `refreshLeagueWinstreakLeaderboard`.  
On set channel: call `setupWinstreakLiveLeaderboard`.  
On clear channel: `clearWinstreakLiveLeaderboard`.  
On clear size/display/sort: clear helpers + refresh if bound.

- [ ] **Step 2: Extend `view`**

Include winstreak channel · message · size · display · sort for the resolved league (same section style as overall leaderboard lines).

- [ ] **Step 3: Manual sanity** — `npx tsc --noEmit`

- [ ] **Step 4: Commit**

```bash
git add src/commands/config/config.ts
git commit -m "feat: add /config winstreak leaderboard settings"
```

---

### Task 7: Pagination interactions

**Files:**

- Modify: `src/discord/interactions/leaderboard-interactions.ts`

- [ ] **Step 1: Handle `lb:winstreaks:` before overall**

```typescript
if (interaction.customId.startsWith('lb:winstreaks:')) {
  const parsed = parseWinstreakPageCustomId(interaction.customId);
  if (!parsed) return true;
  if (interaction.user.id !== parsed.invokerId) {
    await interaction.reply({ content: NOT_YOUR_PAGE, flags: MessageFlags.Ephemeral });
    return true;
  }
  await interaction.deferUpdate();
  const pageData = await loadWinstreakLeaderboardPage(parsed.leagueId, parsed.page);
  await interaction.editReply({
    embeds: [buildWinstreakLeaderboardEmbed(pageData)],
    components: buildWinstreakPageButtons({
      invokerId: parsed.invokerId,
      leagueId: parsed.leagueId,
      page: pageData.page,
      totalPages: pageData.totalPages,
    }),
  });
  return true;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/discord/interactions/leaderboard-interactions.ts
git commit -m "feat: paginate winstreak leaderboard buttons"
```

---

### Task 8: Staff docs

**Files:**

- Modify: `docs/discord/staff/a1-roles-and-setup.md`
- Modify: `docs/discord/staff/a5-admin-cheat-sheet.md`

- [ ] **Step 1: Document setup**

In `a1-roles-and-setup.md`, after quitter live board section, add a parallel **Live winstreak leaderboard** section:

- `/config set winstreak_leaderboard_channel` (with league) **or** `/leaderboard setup_winstreaks`
- size / display / sort set+clear
- players browse with `/leaderboard winstreaks`
- clear: `/config clear winstreak_leaderboard_channel`

In `a5-admin-cheat-sheet.md`, add cheat lines mirroring quitter entries but league-scoped.

- [ ] **Step 2: Commit**

```bash
git add docs/discord/staff/a1-roles-and-setup.md docs/discord/staff/a5-admin-cheat-sheet.md
git commit -m "docs: document winstreak leaderboard setup"
```

---

## Spec coverage checklist

| Spec item                                      | Task         |
| ---------------------------------------------- | ------------ |
| League schema enums/fields                     | 1            |
| On-read streak compute + COMPLETED only        | 2            |
| Eligibility current/best                       | 2            |
| Competition ranks + secondary keys             | 2            |
| Embeds + empty copy + chunk stamp              | 3            |
| Live setup/clear/refresh + scheduler           | 4            |
| `/leaderboard winstreaks` + `setup_winstreaks` | 5            |
| `/config` set/clear/view                       | 6            |
| Invoker-only page buttons with leagueId        | 7            |
| Staff docs                                     | 8            |
| Size error copy                                | 2            |
| No denormalized columns / no guild-wide        | — (non-goal) |
