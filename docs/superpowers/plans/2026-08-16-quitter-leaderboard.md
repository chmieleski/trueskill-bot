# Quitter Leaderboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Guild-wide quitter leaderboard (quit count and/or rate) with moderator-configurable display/sort, live channel message, and paginated `/leaderboard quitters`.

**Architecture:** Store live-board settings on `GuildConfig`. Aggregate `MatchPlayer.isQuitter` / completed appearances across all leagues in the guild on read. Reuse overall live packing (size 10–100, chunk 25) and slash pagination (10/page). Refresh guild quitter boards from the same scheduler and match-outcome hooks as overall boards.

**Tech Stack:** TypeScript ESM, Prisma, discord.js v14, Vitest

**Spec:** `docs/superpowers/specs/2026-08-16-quitter-leaderboard-design.md`

## Global Constraints

- Scope: `general` (guild-wide; not game-specific)
- English-only user-facing strings and errors
- Live size min **10**, max **100**, default **10**, chunk **25** (reuse `assertLiveLeaderboardSize` / `chunkLeaderboardEntries`)
- Slash page size **10** (`LEADERBOARD_PAGE_SIZE`)
- Quit count: `isQuitter` on matches with status `COMPLETED` or `CANCELLED` only
- Completed denominator: roster rows on `COMPLETED` only
- Rate eligible when completed ≥ **1**; no extra floor
- Sort may use a metric not shown in columns
- ESM imports use `.js` extension; named exports
- No new production env / SSM keys
- Work in worktree: `/home/lesk/www/bot/.worktrees/quitter-leaderboard` on branch `feature/quitter-leaderboard`

## File map

| File | Role |
|------|------|
| `prisma/schema.prisma` | Enums + `GuildConfig` quitter leaderboard fields |
| `prisma/migrations/…_add_quitter_leaderboard/` | Migration SQL |
| `src/services/guild/guild-config.ts` | Resolve + set/clear quitter board settings |
| `src/services/guild/guild-config.test.ts` | Defaults / clear tests (extend or create) |
| `src/services/guild/index.ts` | Re-exports |
| `src/services/leaderboard/quitter-leaderboard.ts` | Aggregate, sort, page, size assert message wrapper |
| `src/services/leaderboard/quitter-leaderboard.test.ts` | Aggregation/sort/rank/page tests |
| `src/services/leaderboard/quitter-leaderboard-embed.ts` | Table + slash/live embeds + page buttons |
| `src/services/leaderboard/quitter-leaderboard-embed.test.ts` | Column filtering / empty copy / chunk stamp |
| `src/services/leaderboard/quitter-leaderboard-channel.ts` | Setup / clear / refresh guild live message |
| `src/services/leaderboard/quitter-leaderboard-channel.test.ts` | Skip when unbound; edit embeds |
| `src/services/leaderboard/leaderboard-channel.ts` | Call guild quitter refresh from `refreshAllLeaderboardChannels` |
| `src/services/leaderboard/index.ts` | Re-export quitter symbols |
| `src/commands/config/config.ts` | set/clear/view quitter keys (no league option) |
| `src/commands/player/leaderboard.ts` | `quitters` + `setup_quitters` subcommands |
| `src/discord/interactions/leaderboard-interactions.ts` | Handle `lb:quitters:…` buttons |
| `src/discord/interactions/match-correction-interactions.ts` | Also refresh guild quitter board |
| `docs/discord/staff/a1-roles-and-setup.md` | Document setup |
| `docs/discord/staff/a5-admin-cheat-sheet.md` | Cheat lines |
| `docs/discord/staff/a3-quitters-and-ratings.md` | Brief pointer if natural |

---

### Task 1: Schema + GuildConfig setters

**Files:**
- Modify: `prisma/schema.prisma`
- Create: migration via `npm run db:migrate`
- Modify: `src/services/guild/guild-config.ts`
- Modify: `src/services/guild/guild-config.test.ts` (create if missing patterns need it)
- Modify: `src/services/guild/index.ts`

**Interfaces:**
- Produces:
  - Prisma enums `QuitterLeaderboardDisplay` (`count` \| `rate` \| `both`), `QuitterLeaderboardSort` (`count` \| `rate`)
  - `GuildConfig` fields: `quitterLeaderboardChannelId`, `quitterLeaderboardMessageId`, `quitterLeaderboardSize` (default 10), `quitterLeaderboardDisplay` (default `both`), `quitterLeaderboardSort` (default `count`)
  - `ResolvedGuildConfig` extended with:
    - `quitterLeaderboardChannelId: string | undefined`
    - `quitterLeaderboardMessageId: string | undefined`
    - `quitterLeaderboardSize: number`
    - `quitterLeaderboardDisplay: 'count' | 'rate' | 'both'`
    - `quitterLeaderboardSort: 'count' | 'rate'`
  - `setQuitterLeaderboardChannel(guildId, channelId, messageId): Promise<void>`
  - `clearQuitterLeaderboardChannel(guildId): Promise<void>`
  - `setQuitterLeaderboardSize(guildId, size: number): Promise<void>` — caller validates size first
  - `clearQuitterLeaderboardSize(guildId): Promise<void>` — sets size to 10
  - `setQuitterLeaderboardDisplay(guildId, display): Promise<void>`
  - `clearQuitterLeaderboardDisplay(guildId): Promise<void>` — `both`
  - `setQuitterLeaderboardSort(guildId, sort): Promise<void>`
  - `clearQuitterLeaderboardSort(guildId): Promise<void>` — `count`

- [ ] **Step 1: Write failing tests for resolve defaults**

Extend `src/services/guild/guild-config.test.ts`:

```typescript
import { beforeEach, describe, expect, it, vi } from 'vitest';

const findUnique = vi.fn();
const upsert = vi.fn();

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    guildConfig: {
      findUnique: (...args: unknown[]) => findUnique(...args),
      upsert: (...args: unknown[]) => upsert(...args),
    },
  },
}));

vi.mock('../../config/env.js', () => ({
  env: { matchCreateRoleId: undefined, matchModRoleId: undefined },
}));

import {
  clearQuitterLeaderboardDisplay,
  clearQuitterLeaderboardSize,
  clearQuitterLeaderboardSort,
  resolveGuildConfig,
  setQuitterLeaderboardDisplay,
  setQuitterLeaderboardSize,
  setQuitterLeaderboardSort,
} from './guild-config.js';

describe('quitter leaderboard guild config', () => {
  beforeEach(() => {
    findUnique.mockReset();
    upsert.mockReset();
  });

  it('resolves quitter board defaults when row missing', async () => {
    findUnique.mockResolvedValue(null);
    const resolved = await resolveGuildConfig('g1');
    expect(resolved.quitterLeaderboardChannelId).toBeUndefined();
    expect(resolved.quitterLeaderboardMessageId).toBeUndefined();
    expect(resolved.quitterLeaderboardSize).toBe(10);
    expect(resolved.quitterLeaderboardDisplay).toBe('both');
    expect(resolved.quitterLeaderboardSort).toBe('count');
  });

  it('setQuitterLeaderboardSize upserts size', async () => {
    upsert.mockResolvedValue({});
    await setQuitterLeaderboardSize('g1', 50);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { guildId: 'g1' },
        create: expect.objectContaining({ guildId: 'g1', quitterLeaderboardSize: 50 }),
        update: { quitterLeaderboardSize: 50 },
      }),
    );
  });

  it('clear helpers reset display/sort/size defaults', async () => {
    upsert.mockResolvedValue({});
    await clearQuitterLeaderboardSize('g1');
    await clearQuitterLeaderboardDisplay('g1');
    await clearQuitterLeaderboardSort('g1');
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: { quitterLeaderboardSize: 10 } }),
    );
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: { quitterLeaderboardDisplay: 'both' } }),
    );
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: { quitterLeaderboardSort: 'count' } }),
    );
  });

  it('setQuitterLeaderboardDisplay and sort upsert enums', async () => {
    upsert.mockResolvedValue({});
    await setQuitterLeaderboardDisplay('g1', 'rate');
    await setQuitterLeaderboardSort('g1', 'rate');
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: { quitterLeaderboardDisplay: 'rate' } }),
    );
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: { quitterLeaderboardSort: 'rate' } }),
    );
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

Run: `npm test -- src/services/guild/guild-config.test.ts`

Expected: FAIL — missing exports / fields.

- [ ] **Step 3: Update Prisma schema**

In `prisma/schema.prisma`, add enums and fields on `GuildConfig`:

```prisma
enum QuitterLeaderboardDisplay {
  count
  rate
  both
}

enum QuitterLeaderboardSort {
  count
  rate
}

model GuildConfig {
  guildId                      String                     @id
  matchCreateRoleId            String?
  matchModRoleId               String?
  quitterLeaderboardChannelId  String?
  quitterLeaderboardMessageId  String?
  quitterLeaderboardSize       Int                        @default(10)
  quitterLeaderboardDisplay    QuitterLeaderboardDisplay  @default(both)
  quitterLeaderboardSort       QuitterLeaderboardSort     @default(count)
  createdAt                    DateTime                   @default(now())
  updatedAt                    DateTime                   @updatedAt
}
```

- [ ] **Step 4: Create migration**

Run: `npm run db:migrate -- --name add_quitter_leaderboard`

If local DB is unavailable, create the migration SQL manually under `prisma/migrations/<timestamp>_add_quitter_leaderboard/migration.sql` matching the schema, then run `npx prisma generate`.

Expected SQL shape:

```sql
CREATE TYPE "QuitterLeaderboardDisplay" AS ENUM ('count', 'rate', 'both');
CREATE TYPE "QuitterLeaderboardSort" AS ENUM ('count', 'rate');
ALTER TABLE "GuildConfig" ADD COLUMN "quitterLeaderboardChannelId" TEXT,
ADD COLUMN "quitterLeaderboardMessageId" TEXT,
ADD COLUMN "quitterLeaderboardSize" INTEGER NOT NULL DEFAULT 10,
ADD COLUMN "quitterLeaderboardDisplay" "QuitterLeaderboardDisplay" NOT NULL DEFAULT 'both',
ADD COLUMN "quitterLeaderboardSort" "QuitterLeaderboardSort" NOT NULL DEFAULT 'count';
```

- [ ] **Step 5: Implement guild-config helpers**

Extend `ResolvedGuildConfig` and `resolveGuildConfig` to map the five fields (size default 10; display default `both`; sort default `count`; channel/message trim empty → undefined).

Add upsert helpers listed in Interfaces. Use Prisma enum string values `'count' | 'rate' | 'both'` as TypeScript unions matching Prisma client enums after generate.

Re-export new functions from `src/services/guild/index.ts`.

- [ ] **Step 6: Run tests — expect PASS**

Run: `npm test -- src/services/guild/guild-config.test.ts`

Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add prisma/schema.prisma prisma/migrations src/services/guild/guild-config.ts src/services/guild/guild-config.test.ts src/services/guild/index.ts
git commit -m "feat: add GuildConfig fields for quitter leaderboard"
```

---

### Task 2: Aggregate, sort, paginate

**Files:**
- Create: `src/services/leaderboard/quitter-leaderboard.ts`
- Create: `src/services/leaderboard/quitter-leaderboard.test.ts`
- Modify: `src/services/leaderboard/index.ts`

**Interfaces:**
- Consumes: `prisma`, `MatchStatus`, `LEADERBOARD_PAGE_SIZE`, `assertLiveLeaderboardSize`, `LeaderboardServiceError`, `clampPage`
- Produces:
  - `QuitterLeaderboardDisplayMode = 'count' | 'rate' | 'both'`
  - `QuitterLeaderboardSortMode = 'count' | 'rate'`
  - `QuitterLeaderboardEntry = { rank: number; playerId: string; username: string; discordId: string | null; quitCount: number; completedCount: number; rate: number }`
  - `QuitterLeaderboardPage = { entries: QuitterLeaderboardEntry[]; page: number; totalPages: number; totalPlayers: number; display: QuitterLeaderboardDisplayMode; sort: QuitterLeaderboardSortMode }`
  - `assertQuitterLeaderboardSize(size: number): number` — same bounds as live overall; message `Quitter leaderboard size must be between 10 and 100.`
  - `assignCompetitionRanks<T>(rows: T[], isSameRank: (a: T, b: T) => boolean): (T & { rank: number })[]`
  - `sortQuitterRows(rows: Omit<QuitterLeaderboardEntry, 'rank'>[], sort: QuitterLeaderboardSortMode): Omit<QuitterLeaderboardEntry, 'rank'>[]`
  - `filterEligibleQuitterRows(rows: Omit<QuitterLeaderboardEntry, 'rank'>[], sort: QuitterLeaderboardSortMode): …`
  - `paginateQuitterEntries(rows: QuitterLeaderboardEntry[], page: number, display, sort): QuitterLeaderboardPage`
  - `loadQuitterLeaderboard(guildId: string, options: { display; sort }): Promise<QuitterLeaderboardEntry[]>` — full ranked list
  - `loadQuitterLeaderboardPage(guildId, page, display?, sort?): Promise<QuitterLeaderboardPage>` — loads config defaults from GuildConfig when display/sort omitted
  - `loadQuitterLeaderboardTop(guildId, size, display?, sort?): Promise<QuitterLeaderboardEntry[]>`

- [ ] **Step 1: Write failing unit tests (pure helpers + mocked load)**

```typescript
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MatchStatus } from '@prisma/client';

const matchPlayerFindMany = vi.fn();
const guildFindUnique = vi.fn();

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    matchPlayer: { findMany: (...a: unknown[]) => matchPlayerFindMany(...a) },
    guildConfig: { findUnique: (...a: unknown[]) => guildFindUnique(...a) },
  },
}));

import {
  LeaderboardServiceError,
  assertQuitterLeaderboardSize,
  assignCompetitionRanks,
  filterEligibleQuitterRows,
  loadQuitterLeaderboard,
  paginateQuitterEntries,
  sortQuitterRows,
} from './quitter-leaderboard.js';

describe('assertQuitterLeaderboardSize', () => {
  it('rejects out of range with quitter message', () => {
    expect(() => assertQuitterLeaderboardSize(9)).toThrow(LeaderboardServiceError);
    expect(() => assertQuitterLeaderboardSize(9)).toThrow(
      /Quitter leaderboard size must be between 10 and 100/,
    );
    expect(assertQuitterLeaderboardSize(25)).toBe(25);
  });
});

describe('sort + ranks', () => {
  const base = [
    { playerId: 'a', username: 'Ann', discordId: null, quitCount: 5, completedCount: 10, rate: 0.5 },
    { playerId: 'b', username: 'Bob', discordId: null, quitCount: 5, completedCount: 20, rate: 0.25 },
    { playerId: 'c', username: 'Cat', discordId: null, quitCount: 2, completedCount: 2, rate: 1 },
  ];

  it('sorts by count then rate then name', () => {
    const sorted = sortQuitterRows(base, 'count');
    expect(sorted.map((r) => r.playerId)).toEqual(['a', 'b', 'c']);
  });

  it('sorts by rate then count then name', () => {
    const sorted = sortQuitterRows(base, 'rate');
    expect(sorted.map((r) => r.playerId)).toEqual(['c', 'a', 'b']);
  });

  it('assigns competition ranks on tied primary metric', () => {
    const ranked = assignCompetitionRanks(sortQuitterRows(base, 'count'), (x, y) =>
      x.quitCount === y.quitCount,
    );
    expect(ranked.map((r) => r.rank)).toEqual([1, 1, 3]);
  });
});

describe('filterEligibleQuitterRows', () => {
  it('keeps quitters for count sort and completed>=1 for rate sort', () => {
    const rows = [
      { playerId: 'a', username: 'A', discordId: null, quitCount: 1, completedCount: 0, rate: 0 },
      { playerId: 'b', username: 'B', discordId: null, quitCount: 0, completedCount: 5, rate: 0 },
    ];
    expect(filterEligibleQuitterRows(rows, 'count').map((r) => r.playerId)).toEqual(['a']);
    expect(filterEligibleQuitterRows(rows, 'rate').map((r) => r.playerId)).toEqual(['b']);
  });
});

describe('paginateQuitterEntries', () => {
  it('pages by 10', () => {
    const entries = Array.from({ length: 12 }, (_, i) => ({
      rank: i + 1,
      playerId: `p${i}`,
      username: `u${i}`,
      discordId: null,
      quitCount: 12 - i,
      completedCount: 20,
      rate: (12 - i) / 20,
    }));
    const page2 = paginateQuitterEntries(entries, 2, 'both', 'count');
    expect(page2.page).toBe(2);
    expect(page2.totalPages).toBe(2);
    expect(page2.entries).toHaveLength(2);
  });
});

describe('loadQuitterLeaderboard', () => {
  beforeEach(() => {
    matchPlayerFindMany.mockReset();
  });

  it('aggregates across guild leagues and excludes other guilds', async () => {
    matchPlayerFindMany.mockResolvedValue([
      {
        playerId: 'p1',
        isQuitter: true,
        match: { status: MatchStatus.COMPLETED },
        player: { username: 'Goku', discordId: 'd1' },
      },
      {
        playerId: 'p1',
        isQuitter: false,
        match: { status: MatchStatus.COMPLETED },
        player: { username: 'Goku', discordId: 'd1' },
      },
      {
        playerId: 'p1',
        isQuitter: true,
        match: { status: MatchStatus.CANCELLED },
        player: { username: 'Goku', discordId: 'd1' },
      },
    ]);

    const rows = await loadQuitterLeaderboard('guild-1', {
      display: 'both',
      sort: 'count',
    });

    expect(matchPlayerFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          match: expect.objectContaining({
            league: { guildId: 'guild-1' },
            status: { in: [MatchStatus.COMPLETED, MatchStatus.CANCELLED] },
          }),
        }),
      }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      username: 'Goku',
      quitCount: 2,
      completedCount: 2,
      rate: 1,
      rank: 1,
    });
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL**

Run: `npm test -- src/services/leaderboard/quitter-leaderboard.test.ts`

Expected: FAIL — module missing.

- [ ] **Step 3: Implement `quitter-leaderboard.ts`**

```typescript
import { MatchStatus } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import {
  LeaderboardServiceError,
  LEADERBOARD_PAGE_SIZE,
  LIVE_LEADERBOARD_MAX_SIZE,
  LIVE_LEADERBOARD_MIN_SIZE,
  clampPage,
} from './leaderboard.js';

export type QuitterLeaderboardDisplayMode = 'count' | 'rate' | 'both';
export type QuitterLeaderboardSortMode = 'count' | 'rate';

export type QuitterLeaderboardEntry = {
  rank: number;
  playerId: string;
  username: string;
  discordId: string | null;
  quitCount: number;
  completedCount: number;
  rate: number;
};

export type QuitterLeaderboardPage = {
  entries: QuitterLeaderboardEntry[];
  page: number;
  totalPages: number;
  totalPlayers: number;
  display: QuitterLeaderboardDisplayMode;
  sort: QuitterLeaderboardSortMode;
};

export function assertQuitterLeaderboardSize(size: number): number {
  if (
    !Number.isInteger(size) ||
    size < LIVE_LEADERBOARD_MIN_SIZE ||
    size > LIVE_LEADERBOARD_MAX_SIZE
  ) {
    throw new LeaderboardServiceError(
      'Quitter leaderboard size must be between 10 and 100.',
    );
  }
  return size;
}

export function assignCompetitionRanks<T>(
  rows: T[],
  isSameRank: (a: T, b: T) => boolean,
): (T & { rank: number })[] {
  const result: (T & { rank: number })[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    if (i === 0 || !isSameRank(row, rows[i - 1]!)) {
      result.push({ ...row, rank: i + 1 });
    } else {
      result.push({ ...row, rank: result[i - 1]!.rank });
    }
  }
  return result;
}

export function filterEligibleQuitterRows(
  rows: Omit<QuitterLeaderboardEntry, 'rank'>[],
  sort: QuitterLeaderboardSortMode,
): Omit<QuitterLeaderboardEntry, 'rank'>[] {
  if (sort === 'count') {
    return rows.filter((row) => row.quitCount >= 1);
  }
  return rows.filter((row) => row.completedCount >= 1);
}

export function sortQuitterRows(
  rows: Omit<QuitterLeaderboardEntry, 'rank'>[],
  sort: QuitterLeaderboardSortMode,
): Omit<QuitterLeaderboardEntry, 'rank'>[] {
  const copy = [...rows];
  copy.sort((a, b) => {
    if (sort === 'count') {
      if (b.quitCount !== a.quitCount) return b.quitCount - a.quitCount;
      if (b.rate !== a.rate) return b.rate - a.rate;
      return a.username.localeCompare(b.username);
    }
    if (b.rate !== a.rate) return b.rate - a.rate;
    if (b.quitCount !== a.quitCount) return b.quitCount - a.quitCount;
    return a.username.localeCompare(b.username);
  });
  return copy;
}

export function paginateQuitterEntries(
  rows: QuitterLeaderboardEntry[],
  page: number,
  display: QuitterLeaderboardDisplayMode,
  sort: QuitterLeaderboardSortMode,
): QuitterLeaderboardPage {
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

function aggregateRows(
  raw: Array<{
    playerId: string;
    isQuitter: boolean;
    match: { status: MatchStatus };
    player: { username: string; discordId: string | null };
  }>,
): Omit<QuitterLeaderboardEntry, 'rank'>[] {
  const byPlayer = new Map<
    string,
    { username: string; discordId: string | null; quitCount: number; completedCount: number }
  >();

  for (const row of raw) {
    let agg = byPlayer.get(row.playerId);
    if (!agg) {
      agg = {
        username: row.player.username,
        discordId: row.player.discordId,
        quitCount: 0,
        completedCount: 0,
      };
      byPlayer.set(row.playerId, agg);
    }
    if (row.isQuitter) {
      agg.quitCount += 1;
    }
    if (row.match.status === MatchStatus.COMPLETED) {
      agg.completedCount += 1;
    }
  }

  return [...byPlayer.entries()].map(([playerId, agg]) => ({
    playerId,
    username: agg.username,
    discordId: agg.discordId,
    quitCount: agg.quitCount,
    completedCount: agg.completedCount,
    rate: agg.completedCount > 0 ? agg.quitCount / agg.completedCount : 0,
  }));
}

export async function loadQuitterLeaderboard(
  guildId: string,
  options: { display: QuitterLeaderboardDisplayMode; sort: QuitterLeaderboardSortMode },
): Promise<QuitterLeaderboardEntry[]> {
  const raw = await prisma.matchPlayer.findMany({
    where: {
      match: {
        league: { guildId },
        status: { in: [MatchStatus.COMPLETED, MatchStatus.CANCELLED] },
      },
    },
    select: {
      playerId: true,
      isQuitter: true,
      match: { select: { status: true } },
      player: { select: { username: true, discordId: true } },
    },
  });

  const aggregated = aggregateRows(raw);
  const eligible = filterEligibleQuitterRows(aggregated, options.sort);
  const sorted = sortQuitterRows(eligible, options.sort);
  return assignCompetitionRanks(sorted, (a, b) =>
    options.sort === 'count' ? a.quitCount === b.quitCount : a.rate === b.rate,
  );
}

export async function loadQuitterLeaderboardPage(
  guildId: string,
  page: number,
  display?: QuitterLeaderboardDisplayMode,
  sort?: QuitterLeaderboardSortMode,
): Promise<QuitterLeaderboardPage> {
  const cfg = await prisma.guildConfig.findUnique({
    where: { guildId },
    select: {
      quitterLeaderboardDisplay: true,
      quitterLeaderboardSort: true,
    },
  });
  const resolvedDisplay = display ?? cfg?.quitterLeaderboardDisplay ?? 'both';
  const resolvedSort = sort ?? cfg?.quitterLeaderboardSort ?? 'count';
  const rows = await loadQuitterLeaderboard(guildId, {
    display: resolvedDisplay,
    sort: resolvedSort,
  });
  return paginateQuitterEntries(rows, page, resolvedDisplay, resolvedSort);
}

export async function loadQuitterLeaderboardTop(
  guildId: string,
  size: number,
  display?: QuitterLeaderboardDisplayMode,
  sort?: QuitterLeaderboardSortMode,
): Promise<QuitterLeaderboardEntry[]> {
  const cfg = await prisma.guildConfig.findUnique({
    where: { guildId },
    select: { quitterLeaderboardDisplay: true, quitterLeaderboardSort: true },
  });
  const resolvedDisplay = display ?? cfg?.quitterLeaderboardDisplay ?? 'both';
  const resolvedSort = sort ?? cfg?.quitterLeaderboardSort ?? 'count';
  const rows = await loadQuitterLeaderboard(guildId, {
    display: resolvedDisplay,
    sort: resolvedSort,
  });
  return rows.slice(0, size);
}
```

Export new symbols from `src/services/leaderboard/index.ts`.

- [ ] **Step 4: Run tests — expect PASS**

Run: `npm test -- src/services/leaderboard/quitter-leaderboard.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/leaderboard/quitter-leaderboard.ts src/services/leaderboard/quitter-leaderboard.test.ts src/services/leaderboard/index.ts
git commit -m "feat: aggregate and rank guild quitter leaderboard"
```

---

### Task 3: Embeds + pagination buttons

**Files:**
- Create: `src/services/leaderboard/quitter-leaderboard-embed.ts`
- Create: `src/services/leaderboard/quitter-leaderboard-embed.test.ts`
- Modify: `src/services/leaderboard/index.ts`

**Interfaces:**
- Consumes: `QuitterLeaderboardEntry`, `QuitterLeaderboardPage`, `QuitterLeaderboardDisplayMode`, `chunkLeaderboardEntries`
- Produces:
  - `formatQuitRate(rate: number): string` — e.g. `50.0%` (one decimal)
  - `formatQuitterTable(entries, display): string`
  - `buildQuitterLeaderboardEmbed(page): EmbedBuilder`
  - `buildQuitterLiveLeaderboardEmbeds(entries, display, sort, updatedAt): EmbedBuilder[]`
  - `buildQuitterPageCustomId(invokerId, direction, currentPage): string` → `lb:quitters:page:<invokerId>:<prev|next>:<page>`
  - `parseQuitterPageCustomId(customId): { invokerId; page } | null`
  - `buildQuitterPageButtons({ invokerId, page, totalPages })`

- [ ] **Step 1: Write failing embed tests**

```typescript
import { describe, expect, it } from 'vitest';
import {
  buildQuitterLiveLeaderboardEmbeds,
  buildQuitterLeaderboardEmbed,
  formatQuitRate,
  formatQuitterTable,
  parseQuitterPageCustomId,
} from './quitter-leaderboard-embed.js';
import type { QuitterLeaderboardEntry } from './quitter-leaderboard.js';

function entry(partial: Partial<QuitterLeaderboardEntry> & Pick<QuitterLeaderboardEntry, 'rank' | 'username'>): QuitterLeaderboardEntry {
  return {
    playerId: partial.playerId ?? 'p',
    discordId: null,
    quitCount: partial.quitCount ?? 1,
    completedCount: partial.completedCount ?? 4,
    rate: partial.rate ?? 0.25,
    ...partial,
  };
}

describe('formatQuitRate', () => {
  it('formats one decimal percent', () => {
    expect(formatQuitRate(0.125)).toBe('12.5%');
    expect(formatQuitRate(1)).toBe('100.0%');
  });
});

describe('formatQuitterTable', () => {
  it('omits columns by display mode', () => {
    const rows = [entry({ rank: 1, username: 'Goku', quitCount: 3, completedCount: 10, rate: 0.3 })];
    expect(formatQuitterTable(rows, 'count')).toContain('Quits');
    expect(formatQuitterTable(rows, 'count')).not.toContain('Rate');
    expect(formatQuitterTable(rows, 'rate')).toContain('Rate');
    expect(formatQuitterTable(rows, 'rate')).not.toContain('Quits');
    expect(formatQuitterTable(rows, 'both')).toContain('Quits');
    expect(formatQuitterTable(rows, 'both')).toContain('Rate');
  });

  it('empty copy depends on sort via caller empty strings', () => {
    expect(formatQuitterTable([], 'both')).toBe('_No quitters recorded yet._');
  });
});

describe('buildQuitterLeaderboardEmbed', () => {
  it('includes page header and sort footer', () => {
    const embed = buildQuitterLeaderboardEmbed({
      entries: [entry({ rank: 1, username: 'Goku' })],
      page: 1,
      totalPages: 1,
      totalPlayers: 1,
      display: 'both',
      sort: 'rate',
    });
    expect(embed.data.title).toBe('Quitter Leaderboard');
    expect(embed.data.footer?.text).toMatch(/Sorted by rate/i);
  });
});

describe('buildQuitterLiveLeaderboardEmbeds', () => {
  it('chunks and stamps last embed', () => {
    const entries = Array.from({ length: 26 }, (_, i) =>
      entry({ rank: i + 1, username: `u${i}`, quitCount: 26 - i }),
    );
    const embeds = buildQuitterLiveLeaderboardEmbeds(
      entries,
      'count',
      'count',
      new Date('2026-08-16T00:00:00Z'),
    );
    expect(embeds).toHaveLength(2);
    expect(embeds[0]!.data.title).toBe('Quitter Leaderboard');
    expect(embeds[1]!.data.title).toBe('Quitter Leaderboard (continued)');
    expect(embeds[1]!.data.description).toMatch(/Updated <t:/);
    expect(embeds[0]!.data.description).not.toMatch(/Updated <t:/);
  });
});

describe('parseQuitterPageCustomId', () => {
  it('parses prev/next', () => {
    expect(parseQuitterPageCustomId('lb:quitters:page:9:next:2')).toEqual({
      invokerId: '9',
      page: 3,
    });
    expect(parseQuitterPageCustomId('leaderboard:page:9:next:2:league')).toBeNull();
  });
});
```

For empty live/slash: when `entries.length === 0` and `sort === 'rate'`, description `_No completed matches yet._`; otherwise `_No quitters recorded yet._`. Put empty-string selection in embed builders (not only in `formatQuitterTable`). Update the empty `formatQuitterTable` test accordingly — `formatQuitterTable([], display)` can return `_No quitters recorded yet._` as a generic empty table; builders override for rate-sort empty.

- [ ] **Step 2: Run tests — expect FAIL**

Run: `npm test -- src/services/leaderboard/quitter-leaderboard-embed.test.ts`

Expected: FAIL

- [ ] **Step 3: Implement embeds**

Mirror overall gold `0xf0b232`. Monospace table columns: `#`, `Player`, optional `Quits`, optional `Rate`, `G`.

Custom id format exactly: `lb:quitters:page:<invokerId>:<prev|next>:<currentPage>` (5 parts after split → length 6).

Footer slash: `Sorted by quits` or `Sorted by rate` plus button hint when paginated.

Re-export from index.

- [ ] **Step 4: Run tests — expect PASS**

Run: `npm test -- src/services/leaderboard/quitter-leaderboard-embed.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/leaderboard/quitter-leaderboard-embed.ts src/services/leaderboard/quitter-leaderboard-embed.test.ts src/services/leaderboard/index.ts
git commit -m "feat: add quitter leaderboard embeds and page buttons"
```

---

### Task 4: Live channel setup / refresh

**Files:**
- Create: `src/services/leaderboard/quitter-leaderboard-channel.ts`
- Create: `src/services/leaderboard/quitter-leaderboard-channel.test.ts`
- Modify: `src/services/leaderboard/leaderboard-channel.ts` (`refreshAllLeaderboardChannels`)
- Modify: `src/services/leaderboard/index.ts`
- Modify: `src/discord/interactions/match-correction-interactions.ts` (guild refresh after league refresh)

**Interfaces:**
- Produces:
  - `setupQuitterLiveLeaderboard(client, guildId, channelId): Promise<{ messageId: string }>`
  - `clearQuitterLiveLeaderboard(client, guildId): Promise<void>`
  - `refreshGuildQuitterLeaderboard(client, guildId): Promise<void>`
  - `refreshAllQuitterLeaderboardChannels(client): Promise<void>`
- Modifies: `refreshAllLeaderboardChannels` to also call `refreshAllQuitterLeaderboardChannels`

- [ ] **Step 1: Write failing channel tests**

```typescript
import { beforeEach, describe, expect, it, vi } from 'vitest';

const findUnique = vi.fn();
const findMany = vi.fn();
const setChannel = vi.fn();
const clearChannel = vi.fn();
const loadTop = vi.fn();
const buildEmbeds = vi.fn();

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    guildConfig: {
      findUnique: (...a: unknown[]) => findUnique(...a),
      findMany: (...a: unknown[]) => findMany(...a),
    },
  },
}));

vi.mock('../guild/guild-config.js', () => ({
  setQuitterLeaderboardChannel: (...a: unknown[]) => setChannel(...a),
  clearQuitterLeaderboardChannel: (...a: unknown[]) => clearChannel(...a),
}));

vi.mock('./quitter-leaderboard.js', () => ({
  loadQuitterLeaderboardTop: (...a: unknown[]) => loadTop(...a),
  LIVE_LEADERBOARD_DEFAULT_SIZE: 10,
}));

vi.mock('./quitter-leaderboard-embed.js', () => ({
  buildQuitterLiveLeaderboardEmbeds: (...a: unknown[]) => buildEmbeds(...a),
}));

import { refreshGuildQuitterLeaderboard } from './quitter-leaderboard-channel.js';

describe('refreshGuildQuitterLeaderboard', () => {
  beforeEach(() => {
    findUnique.mockReset();
    loadTop.mockReset();
    buildEmbeds.mockReset();
  });

  it('skips when unbound', async () => {
    findUnique.mockResolvedValue({
      quitterLeaderboardChannelId: null,
      quitterLeaderboardMessageId: null,
    });
    await refreshGuildQuitterLeaderboard({} as never, 'g1');
    expect(loadTop).not.toHaveBeenCalled();
  });

  it('loads top with size and edits message', async () => {
    findUnique.mockResolvedValue({
      quitterLeaderboardChannelId: 'c1',
      quitterLeaderboardMessageId: 'm1',
      quitterLeaderboardSize: 50,
      quitterLeaderboardDisplay: 'both',
      quitterLeaderboardSort: 'count',
    });
    loadTop.mockResolvedValue([]);
    buildEmbeds.mockReturnValue([{ fake: true }]);
    const edit = vi.fn();
    const client = {
      channels: {
        fetch: vi.fn().mockResolvedValue({
          isTextBased: () => true,
          isDMBased: () => false,
          messages: { edit },
        }),
      },
    };
    await refreshGuildQuitterLeaderboard(client as never, 'g1');
    expect(loadTop).toHaveBeenCalledWith('g1', 50, 'both', 'count');
    expect(edit).toHaveBeenCalledWith('m1', { embeds: [{ fake: true }] });
  });
});
```

Mirror overall channel helpers for fetch/delete/repost-on-edit-failure. Fix the mock: `LIVE_LEADERBOARD_DEFAULT_SIZE` lives in `leaderboard.js` — import default size from there inside the channel module.

- [ ] **Step 2: Run tests — expect FAIL**

Run: `npm test -- src/services/leaderboard/quitter-leaderboard-channel.test.ts`

Expected: FAIL

- [ ] **Step 3: Implement channel module + wire refreshAll**

In `refreshAllLeaderboardChannels`, after league loop:

```typescript
await refreshAllQuitterLeaderboardChannels(client);
```

In `match-correction-interactions.ts`, after `refreshLeagueLeaderboard(...)`, also:

```typescript
if (interaction.guildId) {
  await refreshGuildQuitterLeaderboard(interaction.client, interaction.guildId);
}
```

(Use fire-and-forget `.catch` only if overall path already does; prefer same style as nearby code — correction currently awaits league refresh, so await guild quitter refresh too.)

`match-interactions` / `match.ts` already call `refreshAllLeaderboardChannels` — no change once `refreshAll` includes quitters.

- [ ] **Step 4: Run tests — expect PASS**

Run: `npm test -- src/services/leaderboard/quitter-leaderboard-channel.test.ts src/services/leaderboard/leaderboard-channel.test.ts`

Expected: PASS (update `leaderboard-channel.test.ts` if it mocks `refreshAll` internals — only if tests break).

- [ ] **Step 5: Commit**

```bash
git add src/services/leaderboard/quitter-leaderboard-channel.ts src/services/leaderboard/quitter-leaderboard-channel.test.ts src/services/leaderboard/leaderboard-channel.ts src/services/leaderboard/index.ts src/discord/interactions/match-correction-interactions.ts
git commit -m "feat: live quitter leaderboard channel refresh"
```

---

### Task 5: `/config` set|clear|view

**Files:**
- Modify: `src/commands/config/config.ts`

**Interfaces:**
- Consumes: guild setters, `assertQuitterLeaderboardSize`, `setupQuitterLiveLeaderboard`, `clearQuitterLiveLeaderboard`, `refreshGuildQuitterLeaderboard`

- [ ] **Step 1: Add slash subcommands (no league option)**

Under `set` group (guild-scoped like `create_role`):

- `quitter_leaderboard_channel` + channel option
- `quitter_leaderboard_size` + integer 10–100
- `quitter_leaderboard_display` + string choices `count` / `rate` / `both`
- `quitter_leaderboard_sort` + string choices `count` / `rate`

Under `clear` group: same four names without value options.

- [ ] **Step 2: Implement handlers**

For each set/clear: `assertCanConfigureBot`, require `interaction.guildId`, persist, refresh live message when channel+message bound (size/display/sort), ephemeral English confirmation.

Channel set: call `setupQuitterLiveLeaderboard(client, guildId, channel.id)` (validates text channel; error: `Choose a server text channel for the quitter leaderboard.`).

Size set: `assertQuitterLeaderboardSize(size)` then `setQuitterLeaderboardSize` then `refreshGuildQuitterLeaderboard`.

- [ ] **Step 3: Extend `view`**

Add helper:

```typescript
function formatQuitterLeaderboardLine(
  channelId: string | undefined,
  messageId: string | undefined,
  size: number,
  display: string,
  sort: string,
): string {
  if (!channelId || !messageId) {
    return `**Quitter leaderboard:** \`unset\` · size \`${size}\` · display \`${display}\` · sort \`${sort}\``;
  }
  return `**Quitter leaderboard:** <#${channelId}> · message \`${messageId}\` · size \`${size}\` · display \`${display}\` · sort \`${sort}\``;
}
```

Include in the guild section of `view` (roles block), not only inside league sections.

- [ ] **Step 4: Manual smoke (optional in CI)**

Run: `npm test`

Expected: PASS (no dedicated config command unit test required unless one already exists — do not add brittle Discord.js builder tests).

- [ ] **Step 5: Commit**

```bash
git add src/commands/config/config.ts
git commit -m "feat: configure guild quitter leaderboard via /config"
```

---

### Task 6: `/leaderboard quitters` + `setup_quitters` + buttons

**Files:**
- Modify: `src/commands/player/leaderboard.ts`
- Modify: `src/discord/interactions/leaderboard-interactions.ts`

**Interfaces:**
- Consumes: load/page/embed/button helpers + `setupQuitterLiveLeaderboard` + `assertCanConfigureBot`

- [ ] **Step 1: Add subcommands**

```typescript
.addSubcommand((subcommand) =>
  subcommand
    .setName('quitters')
    .setDescription('Guild quitter leaderboard (top 10 per page)')
    .addIntegerOption((option) =>
      option.setName('page').setDescription('Page number').setRequired(false).setMinValue(1),
    ),
)
.addSubcommand((subcommand) =>
  subcommand
    .setName('setup_quitters')
    .setDescription('Post a live quitter leaderboard message in this channel'),
)
```

Do **not** wrap these with `withSubcommandLeagueOption`.

- [ ] **Step 2: Implement execute branches**

`setup_quitters`: same auth pattern as `setup`; require guild; `setupQuitterLiveLeaderboard(client, guildId, interaction.channelId)`; ephemeral confirm: `Live quitter leaderboard set in this channel. Keep only this message here.`

`quitters`: `deferReply`; require `guildId`; `loadQuitterLeaderboardPage(guildId, page)`; reply with embed + buttons.

- [ ] **Step 3: Extend `handleLeaderboardInteraction`**

```typescript
if (interaction.customId.startsWith('lb:quitters:')) {
  const parsed = parseQuitterPageCustomId(interaction.customId);
  if (!parsed) return true;
  if (interaction.user.id !== parsed.invokerId) {
    await interaction.reply({ content: NOT_YOUR_PAGE, flags: MessageFlags.Ephemeral });
    return true;
  }
  if (!interaction.guildId) return true;
  const pageData = await loadQuitterLeaderboardPage(interaction.guildId, parsed.page);
  await interaction.update({
    embeds: [buildQuitterLeaderboardEmbed(pageData)],
    components: buildQuitterPageButtons({
      invokerId: parsed.invokerId,
      page: pageData.page,
      totalPages: pageData.totalPages,
    }),
  });
  return true;
}

if (!interaction.customId.startsWith('leaderboard:')) {
  return false;
}
```

Update `NOT_YOUR_PAGE` copy to: `Only the person who ran the leaderboard command can change pages.` (covers both).

- [ ] **Step 4: Run full test suite**

Run: `npm test`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/commands/player/leaderboard.ts src/discord/interactions/leaderboard-interactions.ts
git commit -m "feat: add /leaderboard quitters and setup_quitters"
```

---

### Task 7: Staff docs

**Files:**
- Modify: `docs/discord/staff/a1-roles-and-setup.md`
- Modify: `docs/discord/staff/a5-admin-cheat-sheet.md`
- Modify: `docs/discord/staff/a3-quitters-and-ratings.md` (one short pointer)

- [ ] **Step 1: Document setup**

In `a1-roles-and-setup.md`, add a subsection:

- `/leaderboard setup_quitters` in the target channel
- `/config set quitter_leaderboard_channel|size|display|sort`
- Guild-wide across all leagues; display `count`/`rate`/`both`; sort `count`/`rate`

In `a5-admin-cheat-sheet.md`, add one-liners for the new config keys and `/leaderboard quitters`.

In `a3-quitters-and-ratings.md`, add a sentence that the public shame board is `/leaderboard quitters` / live quitter channel.

- [ ] **Step 2: Commit**

```bash
git add docs/discord/staff/a1-roles-and-setup.md docs/discord/staff/a5-admin-cheat-sheet.md docs/discord/staff/a3-quitters-and-ratings.md
git commit -m "docs: document quitter leaderboard setup for staff"
```

---

## Spec coverage checklist

| Spec requirement | Task |
|------------------|------|
| GuildConfig fields + enums | 1 |
| Guild-wide aggregate COMPLETED/CANCELLED quit + COMPLETED games | 2 |
| Display + sort modes | 2, 3, 5 |
| Live size 10–100 / chunk 25 | 2 (`assertQuitterLeaderboardSize`), 3, 4 |
| `/config` set/clear/view | 5 |
| `/leaderboard quitters` paginated | 6 |
| `/leaderboard setup_quitters` | 6 |
| Refresh via refreshAll + correction | 4 |
| Staff docs | 7 |
| English errors | 2, 5 |
| No denormalized counters | (none — on-read only) |

## Plan self-review notes

- Fixed `loadQuitterLeaderboardTop` to avoid double-fetch anti-pattern called out in Task 2.
- Empty-table copy for rate sort lives in embed builders.
- Custom ids use `lb:quitters:` so overall `leaderboard:` handler stays unchanged aside from an early branch.
