# Player Companion Stats Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add top-3 teammate lists to `/rank` (played / win / lose with) and a league side win-rate line (season + last 20) on every `/match list` page.

**Architecture:** On-read aggregates only. `/rank` loads completed WIN/LOSS matches for one player (rank-reset cutoff), then same-team partners. `/match list` keeps the existing page query and adds a season/last-N winner aggregate inside `loadMatchListPage` so slash and Prev/Next share one path. No schema, env, or SSM changes.

**Tech Stack:** TypeScript ESM, Prisma, discord.js v14, Vitest

**Spec:** `docs/superpowers/specs/2026-08-22-player-companion-stats-design.md`

## Global Constraints

- Scope: `general` (league-scoped; team labels from `GameProfile.teamNames`)
- English-only user-facing strings
- Teammate lists: same-team only; viewed player must have WIN/LOSS; partner quit still counts; viewed quit ignored
- Rank reset applies to teammate lists only (same cutoff as `/rank` W/L); side WR is league-wide
- Sort: primary desc → `winRatePercent` desc (`null` last) → nick A–Z; max 3
- Omit empty `/rank` teammate fields; show 1–2 if that is all
- Side WR on every `/match list` page; omit when `season.windowSize === 0`
- Last N label uses window size (`Last 20` or `Last 12`); skip matches with no WIN for W–L counts
- Reuse `winRatePercent`, `isMatchCountedAfterRankReset`, `loadLatestRankResetAtByPlayer`
- ESM imports use `.js` extension; named exports
- No Prisma / env / SSM changes; no new slash commands or button custom IDs
- Work in `/home/lesk/www/bot/.worktrees/feat-player-companion-stats` on `feat/player-companion-stats`

## File map

| File | Role |
| ---- | ---- |
| `src/services/player/teammate-stats.ts` | Pair aggregate, `pickTopTeammates`, `formatTeammateTable`, `loadTeammateStats` |
| `src/services/player/teammate-stats.test.ts` | Sort/ties, aggregation, table, loader |
| `src/services/player/rank-embed.ts` | 0–3 fields after Heroes |
| `src/services/player/rank-embed.test.ts` | Field presence/order |
| `src/services/player/index.ts` | Re-export load + types |
| `src/commands/player/rank.ts` | Load teammates; pass into embed |
| `src/services/match/side-win-rate.ts` | Season + last-N aggregate + description line |
| `src/services/match/side-win-rate.test.ts` | Leader/tie/`Last N`; skip no-WIN |
| `src/services/match/match-list.ts` | Side WR on page DTO; prepend description |
| `src/services/match/match-list.test.ts` | Description; empty league |
| `src/services/match/index.ts` | Re-export side WR types if needed |
| `docs/discord/public/06-rank-and-boards.md` | One English line |
| `docs/discord/public/07-cheat-sheet.md` | `/match list` mentions side WR |

---

### Task 1: [general] Teammate pure helpers (sort + table + pair aggregate)

**Files:**

- Create: `src/services/player/teammate-stats.ts`
- Create: `src/services/player/teammate-stats.test.ts`

**Interfaces:**

- Consumes: `winRatePercent` from `../rating/rank-reset-display.js`; `isMatchCountedAfterRankReset` from same
- Produces:
  - `TeammatePairStats = { playerId; username; games; wins; losses; winRatePercent }`
  - `TeammateStats = { playedWith; winWith; loseWith }` (each `TeammatePairStats[]`, 0–3)
  - `TeammateMatchRow = { matchId; completedAt; viewedPlayerId; viewedTeam; viewedResult: 'WIN' \| 'LOSS'; partners: Array<{ playerId; username }> }`
  - `aggregateTeammatePairs(rows: TeammateMatchRow[]): TeammatePairStats[]`
  - `pickTopTeammates(pairs, primary: 'games' \| 'wins' \| 'losses', limit?: number): TeammatePairStats[]`
  - `formatTeammateTable(pairs: TeammatePairStats[]): string`
  - `buildTeammateStatsFromPairs(pairs: TeammatePairStats[]): TeammateStats`

- [ ] **Step 1: Write the failing tests**

Create `src/services/player/teammate-stats.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import {
  aggregateTeammatePairs,
  buildTeammateStatsFromPairs,
  formatTeammateTable,
  pickTopTeammates,
  type TeammatePairStats,
} from './teammate-stats.js';

function pair(
  partial: Partial<TeammatePairStats> & Pick<TeammatePairStats, 'playerId' | 'username'>,
): TeammatePairStats {
  const wins = partial.wins ?? 0;
  const losses = partial.losses ?? 0;
  const games = partial.games ?? wins + losses;
  return {
    playerId: partial.playerId,
    username: partial.username,
    games,
    wins,
    losses,
    winRatePercent:
      partial.winRatePercent !== undefined
        ? partial.winRatePercent
        : games === 0
          ? null
          : Math.round((wins / games) * 1000) / 10,
  };
}

describe('pickTopTeammates', () => {
  it('sorts by primary desc then WR% then nick A–Z and caps at 3', () => {
    const pairs = [
      pair({ playerId: 'a', username: 'Zed', games: 10, wins: 5, losses: 5 }),
      pair({ playerId: 'b', username: 'Ann', games: 10, wins: 8, losses: 2 }),
      pair({ playerId: 'c', username: 'Bob', games: 10, wins: 8, losses: 2 }),
      pair({ playerId: 'd', username: 'Cy', games: 9, wins: 9, losses: 0 }),
    ];
    expect(pickTopTeammates(pairs, 'games').map((p) => p.username)).toEqual([
      'Ann',
      'Bob',
      'Zed',
    ]);
  });

  it('sorts winWith by wins and loseWith by losses', () => {
    const pairs = [
      pair({ playerId: 'a', username: 'Low', games: 10, wins: 2, losses: 8 }),
      pair({ playerId: 'b', username: 'High', games: 5, wins: 5, losses: 0 }),
      pair({ playerId: 'c', username: 'Mid', games: 6, wins: 3, losses: 3 }),
    ];
    expect(pickTopTeammates(pairs, 'wins').map((p) => p.username)).toEqual([
      'High',
      'Mid',
      'Low',
    ]);
    expect(pickTopTeammates(pairs, 'losses').map((p) => p.username)).toEqual([
      'Low',
      'Mid',
      'High',
    ]);
  });

  it('sorts null WR% after numeric WR%', () => {
    const pairs = [
      pair({
        playerId: 'a',
        username: 'Null',
        games: 5,
        wins: 0,
        losses: 0,
        winRatePercent: null,
      }),
      pair({ playerId: 'b', username: 'Zero', games: 5, wins: 0, losses: 5 }),
    ];
    expect(pickTopTeammates(pairs, 'games').map((p) => p.username)).toEqual([
      'Zero',
      'Null',
    ]);
  });
});

describe('aggregateTeammatePairs', () => {
  it('counts same-team partners and ignores the viewed player', () => {
    const pairs = aggregateTeammatePairs([
      {
        matchId: 'm1',
        completedAt: new Date('2026-08-01'),
        viewedPlayerId: 'p1',
        viewedTeam: 1,
        viewedResult: 'WIN',
        partners: [
          { playerId: 'p2', username: 'Ghost' },
          { playerId: 'p3', username: 'Krillin' },
        ],
      },
      {
        matchId: 'm2',
        completedAt: new Date('2026-08-02'),
        viewedPlayerId: 'p1',
        viewedTeam: 1,
        viewedResult: 'LOSS',
        partners: [{ playerId: 'p2', username: 'Ghost' }],
      },
    ]);
    const byId = new Map(pairs.map((p) => [p.playerId, p]));
    expect(byId.get('p2')).toMatchObject({
      username: 'Ghost',
      games: 2,
      wins: 1,
      losses: 1,
      winRatePercent: 50,
    });
    expect(byId.get('p3')).toMatchObject({
      username: 'Krillin',
      games: 1,
      wins: 1,
      losses: 0,
      winRatePercent: 100,
    });
    expect(byId.has('p1')).toBe(false);
  });

  it('skips rows before the caller's rank-reset cutoff when filtered upstream', () => {
    // aggregateTeammatePairs only sees already-eligible rows; empty in → empty out
    expect(aggregateTeammatePairs([])).toEqual([]);
  });
});

describe('formatTeammateTable', () => {
  it('pads nick and games and shows W/L · WR%', () => {
    const table = formatTeammateTable([
      pair({ playerId: 'a', username: 'Ghost', games: 14, wins: 9, losses: 5 }),
      pair({ playerId: 'b', username: 'Piccolo', games: 8, wins: 5, losses: 3 }),
    ]);
    expect(table).toContain('```');
    expect(table).toContain('Ghost');
    expect(table).toContain('14G');
    expect(table).toContain('9W 5L · 64.3%');
    expect(table).toContain('Piccolo');
    expect(table).toContain('8G');
  });

  it('omits percent when winRatePercent is null', () => {
    const table = formatTeammateTable([
      pair({
        playerId: 'a',
        username: 'Ghost',
        games: 0,
        wins: 0,
        losses: 0,
        winRatePercent: null,
      }),
    ]);
    expect(table).toContain('0G · 0W 0L');
    expect(table).not.toContain('%');
  });
});

describe('buildTeammateStatsFromPairs', () => {
  it('builds three top-3 lists from the same pool', () => {
    const pairs = [
      pair({ playerId: 'a', username: 'Ghost', games: 14, wins: 9, losses: 5 }),
      pair({ playerId: 'b', username: 'Krillin', games: 11, wins: 6, losses: 5 }),
      pair({ playerId: 'c', username: 'Piccolo', games: 8, wins: 5, losses: 3 }),
      pair({ playerId: 'd', username: 'Gohan', games: 5, wins: 4, losses: 1 }),
      pair({ playerId: 'e', username: 'Yamcha', games: 4, wins: 1, losses: 3 }),
    ];
    const stats = buildTeammateStatsFromPairs(pairs);
    expect(stats.playedWith.map((p) => p.username)).toEqual(['Ghost', 'Krillin', 'Piccolo']);
    expect(stats.winWith.map((p) => p.username)).toEqual(['Ghost', 'Krillin', 'Piccolo']);
    expect(stats.loseWith.map((p) => p.username)).toEqual(['Ghost', 'Krillin', 'Yamcha']);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/services/player/teammate-stats.test.ts`

Expected: FAIL — cannot find module `./teammate-stats.js`

- [ ] **Step 3: Implement pure helpers**

Create `src/services/player/teammate-stats.ts`:

```typescript
import { winRatePercent } from '../rating/rank-reset-display.js';

export type TeammatePairStats = {
  playerId: string;
  username: string;
  games: number;
  wins: number;
  losses: number;
  winRatePercent: number | null;
};

export type TeammateStats = {
  playedWith: TeammatePairStats[];
  winWith: TeammatePairStats[];
  loseWith: TeammatePairStats[];
};

export type TeammateMatchRow = {
  matchId: string;
  completedAt: Date | null;
  viewedPlayerId: string;
  viewedTeam: number;
  viewedResult: 'WIN' | 'LOSS';
  partners: Array<{ playerId: string; username: string }>;
};

const DEFAULT_TOP = 3;

/** Rank pairs by primary metric, then WR%, then nick A–Z. Cap at `limit` (default 3). */
export function pickTopTeammates(
  pairs: TeammatePairStats[],
  primary: 'games' | 'wins' | 'losses',
  limit: number = DEFAULT_TOP,
): TeammatePairStats[] {
  return [...pairs]
    .sort((a, b) => {
      const primaryDiff = b[primary] - a[primary];
      if (primaryDiff !== 0) return primaryDiff;
      const aWr = a.winRatePercent;
      const bWr = b.winRatePercent;
      if (aWr === null && bWr === null) {
        // fall through
      } else if (aWr === null) {
        return 1;
      } else if (bWr === null) {
        return -1;
      } else if (bWr !== aWr) {
        return bWr - aWr;
      }
      return a.username.localeCompare(b.username);
    })
    .slice(0, limit);
}

/** Aggregate same-team partner W/L from already-eligible match rows. */
export function aggregateTeammatePairs(rows: TeammateMatchRow[]): TeammatePairStats[] {
  const buckets = new Map<string, { username: string; wins: number; losses: number }>();

  for (const row of rows) {
    for (const partner of row.partners) {
      if (partner.playerId === row.viewedPlayerId) continue;
      let bucket = buckets.get(partner.playerId);
      if (!bucket) {
        bucket = { username: partner.username, wins: 0, losses: 0 };
        buckets.set(partner.playerId, bucket);
      } else {
        bucket.username = partner.username;
      }
      if (row.viewedResult === 'WIN') bucket.wins += 1;
      else bucket.losses += 1;
    }
  }

  return [...buckets.entries()].map(([playerId, bucket]) => {
    const games = bucket.wins + bucket.losses;
    return {
      playerId,
      username: bucket.username,
      games,
      wins: bucket.wins,
      losses: bucket.losses,
      winRatePercent: winRatePercent(bucket.wins, bucket.losses),
    };
  });
}

/** Monospace table: `Nick  14G · 9W 5L · 64.3%`. */
export function formatTeammateTable(pairs: TeammatePairStats[]): string {
  if (pairs.length === 0) {
    return '';
  }
  const cells = pairs.map((pair) => {
    const games = `${pair.games}G`;
    const record = `${pair.wins}W ${pair.losses}L`;
    const recordWithWr =
      pair.winRatePercent === null ? record : `${record} · ${pair.winRatePercent}%`;
    return { name: pair.username, games, record: recordWithWr };
  });
  const nameWidth = Math.max(...cells.map((c) => c.name.length));
  const gamesWidth = Math.max(...cells.map((c) => c.games.length));
  const lines = cells.map((cell) => {
    const name = cell.name.padEnd(nameWidth, ' ');
    const games = cell.games.padStart(gamesWidth, ' ');
    return `${name}  ${games} · ${cell.record}`;
  });
  return `\`\`\`\n${lines.join('\n')}\n\`\`\``;
}

/** Build the three top-3 lists from a shared pair pool. */
export function buildTeammateStatsFromPairs(pairs: TeammatePairStats[]): TeammateStats {
  return {
    playedWith: pickTopTeammates(pairs, 'games'),
    winWith: pickTopTeammates(pairs, 'wins'),
    loseWith: pickTopTeammates(pairs, 'losses'),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/services/player/teammate-stats.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/player/teammate-stats.ts src/services/player/teammate-stats.test.ts
git commit -m "$(cat <<'EOF'
feat(player): add teammate pair sort and table helpers

EOF
)"
```

---

### Task 2: [general] Load teammate stats from Prisma

**Files:**

- Modify: `src/services/player/teammate-stats.ts`
- Modify: `src/services/player/teammate-stats.test.ts`

**Interfaces:**

- Consumes: `prisma` (or injectable db), `loadLatestRankResetAtByPlayer`, `isMatchCountedAfterRankReset`, Task 1 helpers
- Produces: `loadTeammateStats(leagueId: string, playerId: string): Promise<TeammateStats>`

- [ ] **Step 1: Write the failing loader tests**

Append to `src/services/player/teammate-stats.test.ts` (add hoisted mocks at top of file before imports of the module under test — follow `match-list.test.ts` pattern). Restructure the test file so mocks are declared first:

Add at the very top (before the existing imports of `./teammate-stats.js`):

```typescript
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { matchPlayerFindMany, loadLatestRankResetAtByPlayer } = vi.hoisted(() => ({
  matchPlayerFindMany: vi.fn(),
  loadLatestRankResetAtByPlayer: vi.fn(),
}));

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    matchPlayer: {
      findMany: matchPlayerFindMany,
    },
  },
}));

vi.mock('../rating/rank-reset-display.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../rating/rank-reset-display.js')>();
  return {
    ...actual,
    loadLatestRankResetAtByPlayer,
  };
});
```

Keep the existing `import { … } from './teammate-stats.js'` and add `loadTeammateStats` to it.

Append:

```typescript
describe('loadTeammateStats', () => {
  beforeEach(() => {
    matchPlayerFindMany.mockReset();
    loadLatestRankResetAtByPlayer.mockReset();
    loadLatestRankResetAtByPlayer.mockResolvedValue(new Map());
  });

  it('aggregates same-team partners after rank reset and ignores viewed quit matches', async () => {
    const resetAt = new Date('2026-08-10T00:00:00.000Z');
    loadLatestRankResetAtByPlayer.mockResolvedValue(new Map([['p1', resetAt]]));
    matchPlayerFindMany.mockResolvedValue([
      {
        matchId: 'old',
        team: 1,
        result: 'WIN',
        match: {
          id: 'old',
          completedAt: new Date('2026-08-01T00:00:00.000Z'),
          players: [
            { playerId: 'p1', team: 1, result: 'WIN', player: { username: 'Me' } },
            { playerId: 'p2', team: 1, result: 'WIN', player: { username: 'Ghost' } },
          ],
        },
      },
      {
        matchId: 'm1',
        team: 1,
        result: 'WIN',
        match: {
          id: 'm1',
          completedAt: new Date('2026-08-11T00:00:00.000Z'),
          players: [
            { playerId: 'p1', team: 1, result: 'WIN', player: { username: 'Me' } },
            { playerId: 'p2', team: 1, result: 'WIN', player: { username: 'Ghost' } },
            { playerId: 'p3', team: 2, result: 'LOSS', player: { username: 'EvilGuy' } },
          ],
        },
      },
      {
        matchId: 'm2',
        team: 1,
        result: 'LOSS',
        match: {
          id: 'm2',
          completedAt: new Date('2026-08-12T00:00:00.000Z'),
          players: [
            { playerId: 'p1', team: 1, result: 'LOSS', player: { username: 'Me' } },
            {
              playerId: 'p2',
              team: 1,
              result: null,
              player: { username: 'Ghost' },
            },
          ],
        },
      },
    ]);

    const { loadTeammateStats } = await import('./teammate-stats.js');
    const stats = await loadTeammateStats('L1', 'p1');
    expect(stats.playedWith).toHaveLength(1);
    expect(stats.playedWith[0]).toMatchObject({
      playerId: 'p2',
      username: 'Ghost',
      games: 2,
      wins: 1,
      losses: 1,
      winRatePercent: 50,
    });
    expect(stats.playedWith.some((p) => p.username === 'EvilGuy')).toBe(false);
  });

  it('returns empty lists when the player has no counted teammates', async () => {
    matchPlayerFindMany.mockResolvedValue([]);
    const { loadTeammateStats } = await import('./teammate-stats.js');
    const stats = await loadTeammateStats('L1', 'p1');
    expect(stats).toEqual({ playedWith: [], winWith: [], loseWith: [] });
  });
});
```

Note: Prefer a single static import of `loadTeammateStats` with the other helpers (vitest hoists mocks). The dynamic import above is only if the static import is already at the top — use static:

```typescript
import {
  aggregateTeammatePairs,
  buildTeammateStatsFromPairs,
  formatTeammateTable,
  loadTeammateStats,
  pickTopTeammates,
  type TeammatePairStats,
} from './teammate-stats.js';
```

And call `loadTeammateStats` directly in the tests (no dynamic import).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/services/player/teammate-stats.test.ts`

Expected: FAIL — `loadTeammateStats` is not exported

- [ ] **Step 3: Implement `loadTeammateStats`**

Append to `src/services/player/teammate-stats.ts`:

```typescript
import { MatchResult, MatchStatus } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import {
  isMatchCountedAfterRankReset,
  loadLatestRankResetAtByPlayer,
  winRatePercent,
} from '../rating/rank-reset-display.js';
```

(Move the existing `winRatePercent` import into this combined import; remove the duplicate.)

```typescript
/** Load top-3 teammate lists for a player in a league (post–rank-reset WIN/LOSS only). */
export async function loadTeammateStats(
  leagueId: string,
  playerId: string,
): Promise<TeammateStats> {
  const [resetAtByPlayer, myRows] = await Promise.all([
    loadLatestRankResetAtByPlayer(leagueId, [playerId]),
    prisma.matchPlayer.findMany({
      where: {
        playerId,
        result: { in: [MatchResult.WIN, MatchResult.LOSS] },
        match: { leagueId, status: MatchStatus.COMPLETED },
      },
      select: {
        matchId: true,
        team: true,
        result: true,
        match: {
          select: {
            id: true,
            completedAt: true,
            players: {
              select: {
                playerId: true,
                team: true,
                result: true,
                player: { select: { username: true } },
              },
            },
          },
        },
      },
    }),
  ]);

  const resetAt = resetAtByPlayer.get(playerId);
  const rows: TeammateMatchRow[] = [];

  for (const row of myRows) {
    if (row.result !== MatchResult.WIN && row.result !== MatchResult.LOSS) continue;
    if (!isMatchCountedAfterRankReset(row.match.completedAt, resetAt)) continue;

    const partners = row.match.players
      .filter((p) => p.playerId !== playerId && p.team === row.team)
      .map((p) => ({ playerId: p.playerId, username: p.player.username }));

    rows.push({
      matchId: row.match.id,
      completedAt: row.match.completedAt,
      viewedPlayerId: playerId,
      viewedTeam: row.team,
      viewedResult: row.result,
      partners,
    });
  }

  return buildTeammateStatsFromPairs(aggregateTeammatePairs(rows));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/services/player/teammate-stats.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/player/teammate-stats.ts src/services/player/teammate-stats.test.ts
git commit -m "$(cat <<'EOF'
feat(player): load teammate stats from completed matches

EOF
)"
```

---

### Task 3: [general] `/rank` embed fields + command wiring

**Files:**

- Modify: `src/services/player/rank-embed.ts`
- Modify: `src/services/player/rank-embed.test.ts`
- Modify: `src/services/player/index.ts`
- Modify: `src/commands/player/rank.ts`

**Interfaces:**

- Consumes: `TeammateStats`, `formatTeammateTable` from Task 1–2
- Produces: `buildRankEmbed(profile, { teammates?, … })` adds 0–3 fields after Heroes

- [ ] **Step 1: Write the failing embed tests**

Append to `src/services/player/rank-embed.test.ts`:

```typescript
import type { TeammateStats } from './teammate-stats.js';

const sampleTeammates: TeammateStats = {
  playedWith: [
    {
      playerId: 'p2',
      username: 'Ghost',
      games: 14,
      wins: 9,
      losses: 5,
      winRatePercent: 64.3,
    },
  ],
  winWith: [
    {
      playerId: 'p2',
      username: 'Ghost',
      games: 14,
      wins: 9,
      losses: 5,
      winRatePercent: 64.3,
    },
  ],
  loseWith: [],
};

// inside describe('buildRankEmbed'):
  it('adds teammate fields after Heroes and omits empty lists', () => {
    const data = buildRankEmbed(baseProfile, { teammates: sampleTeammates }).toJSON();
    const names = (data.fields ?? []).map((f) => f.name);
    expect(names).toEqual(['Heroes', 'Played with', 'Win with']);
    expect(data.fields?.[1]?.value).toContain('Ghost');
    expect(data.fields?.[1]?.value).toContain('14G');
    expect(names).not.toContain('Lose with');
  });

  it('still shows teammate fields when Heroes are hidden', () => {
    const data = buildRankEmbed(baseProfile, {
      showHeroes: false,
      teammates: sampleTeammates,
    }).toJSON();
    const names = (data.fields ?? []).map((f) => f.name);
    expect(names).toEqual(['Played with', 'Win with']);
  });

  it('omits all teammate fields when every list is empty', () => {
    const data = buildRankEmbed(baseProfile, {
      teammates: { playedWith: [], winWith: [], loseWith: [] },
    }).toJSON();
    expect((data.fields ?? []).map((f) => f.name)).toEqual(['Heroes']);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/services/player/rank-embed.test.ts`

Expected: FAIL — `teammates` option ignored / fields missing

- [ ] **Step 3: Implement embed + command wiring**

In `rank-embed.ts`:

```typescript
import type { TeammateStats } from './teammate-stats.js';
import { formatTeammateTable } from './teammate-stats.js';
```

Extend options:

```typescript
    teammates?: TeammateStats;
```

After the Heroes field block, add:

```typescript
  if (options?.teammates) {
    const { playedWith, winWith, loseWith } = options.teammates;
    if (playedWith.length > 0) {
      embed.addFields({ name: 'Played with', value: formatTeammateTable(playedWith) });
    }
    if (winWith.length > 0) {
      embed.addFields({ name: 'Win with', value: formatTeammateTable(winWith) });
    }
    if (loseWith.length > 0) {
      embed.addFields({ name: 'Lose with', value: formatTeammateTable(loseWith) });
    }
  }
```

In `src/services/player/index.ts` add:

```typescript
export {
  loadTeammateStats,
  type TeammatePairStats,
  type TeammateStats,
} from './teammate-stats.js';
```

In `src/commands/player/rank.ts`, import `loadTeammateStats` from the player index and after `loadPlayerProfile`:

```typescript
    const [profile, gameProfile, teammates] = await Promise.all([
      // keep existing profile load if already awaited — prefer:
    ]);
```

Prefer clear sequential/parallel:

```typescript
    const profile = await loadPlayerProfile(resolved.leagueId, lookup);
    const [gameProfile, teammates] = await Promise.all([
      getGameProfileForLeague(resolved.leagueId),
      loadTeammateStats(resolved.leagueId, profile.playerId),
    ]);
```

Pass into embed:

```typescript
        buildRankEmbed(profile, {
          avatarUrl,
          ratingLabel: gameProfile.ratingLabel,
          showHeroes: gameProfile.heroBinding === 'slot_bound',
          teammates,
        }),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/services/player/rank-embed.test.ts src/services/player/teammate-stats.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/player/rank-embed.ts src/services/player/rank-embed.test.ts src/services/player/index.ts src/commands/player/rank.ts
git commit -m "$(cat <<'EOF'
feat(rank): show top teammates on player profiles

EOF
)"
```

---

### Task 4: [general] Side win-rate pure helpers

**Files:**

- Create: `src/services/match/side-win-rate.ts`
- Create: `src/services/match/side-win-rate.test.ts`

**Interfaces:**

- Consumes: `winRatePercent` from `../rating/rank-reset-display.js`
- Produces:
  - `SIDE_WR_LAST_N = 20`
  - `LeagueSideWindow = { team1Wins; team2Wins; windowSize }`
  - `LeagueSideWinRate = { season; lastN }`
  - `winningTeamIfPresent(players): 1 \| 2 \| null` — null when no WIN on either team
  - `aggregateLeagueSideWindows(matches: Array<{ players }>, lastN?: number): LeagueSideWinRate`
    - `matches` must already be newest-first (same order as `/match list`)
    - `season.windowSize = matches.length`
    - `lastN` window = first `min(lastN, matches.length)` matches
  - `formatLeagueSideWinRateLine(stats, teamLabelFor): string | null`

- [ ] **Step 1: Write the failing tests**

Create `src/services/match/side-win-rate.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import {
  aggregateLeagueSideWindows,
  formatLeagueSideWinRateLine,
  winningTeamIfPresent,
} from './side-win-rate.js';

const labels = (team: 1 | 2) => (team === 1 ? 'Z Fighters' : 'Evil');

describe('winningTeamIfPresent', () => {
  it('returns the team with a WIN and null when none', () => {
    expect(
      winningTeamIfPresent([
        { team: 1, result: 'LOSS' },
        { team: 2, result: 'WIN' },
      ]),
    ).toBe(2);
    expect(
      winningTeamIfPresent([
        { team: 1, result: null },
        { team: 2, result: null },
      ]),
    ).toBeNull();
  });
});

describe('aggregateLeagueSideWindows', () => {
  it('counts season and last-N winners and skips no-WIN rows in W–L', () => {
    const matches = [
      { players: [{ team: 1, result: 'WIN' as const }, { team: 2, result: 'LOSS' as const }] },
      { players: [{ team: 1, result: 'LOSS' as const }, { team: 2, result: 'WIN' as const }] },
      { players: [{ team: 1, result: null }, { team: 2, result: null }] },
    ];
    const stats = aggregateLeagueSideWindows(matches, 20);
    expect(stats.season).toEqual({ team1Wins: 1, team2Wins: 1, windowSize: 3 });
    expect(stats.lastN).toEqual({ team1Wins: 1, team2Wins: 1, windowSize: 3 });
  });

  it('limits lastN windowSize to the cap', () => {
    const matches = Array.from({ length: 25 }, (_, i) => ({
      players: [
        { team: 1 as const, result: (i % 2 === 0 ? 'WIN' : 'LOSS') as 'WIN' | 'LOSS' },
        { team: 2 as const, result: (i % 2 === 0 ? 'LOSS' : 'WIN') as 'WIN' | 'LOSS' },
      ],
    }));
    const stats = aggregateLeagueSideWindows(matches, 20);
    expect(stats.season.windowSize).toBe(25);
    expect(stats.lastN.windowSize).toBe(20);
    expect(stats.lastN.team1Wins + stats.lastN.team2Wins).toBe(20);
  });
});

describe('formatLeagueSideWinRateLine', () => {
  it('returns null when season is empty', () => {
    expect(
      formatLeagueSideWinRateLine(
        {
          season: { team1Wins: 0, team2Wins: 0, windowSize: 0 },
          lastN: { team1Wins: 0, team2Wins: 0, windowSize: 0 },
        },
        labels,
      ),
    ).toBeNull();
  });

  it('shows season leader and Last N with en dashes', () => {
    const line = formatLeagueSideWinRateLine(
      {
        season: { team1Wins: 34, team2Wins: 25, windowSize: 59 },
        lastN: { team1Wins: 9, team2Wins: 11, windowSize: 20 },
      },
      labels,
    );
    expect(line).toBe('Z Fighters 34–25 (57.6%) · Last 20: Evil 11–9 (55%)');
  });

  it('uses Tied and Last N when under 20 matches', () => {
    const line = formatLeagueSideWinRateLine(
      {
        season: { team1Wins: 6, team2Wins: 6, windowSize: 12 },
        lastN: { team1Wins: 6, team2Wins: 6, windowSize: 12 },
      },
      labels,
    );
    expect(line).toBe('Tied 6–6 (50%) · Last 12: Tied 6–6 (50%)');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/services/match/side-win-rate.test.ts`

Expected: FAIL — cannot find module

- [ ] **Step 3: Implement side-win-rate helpers**

Create `src/services/match/side-win-rate.ts`:

```typescript
import { winRatePercent } from '../rating/rank-reset-display.js';

export const SIDE_WR_LAST_N = 20;

export type LeagueSideWindow = {
  team1Wins: number;
  team2Wins: number;
  windowSize: number;
};

export type LeagueSideWinRate = {
  season: LeagueSideWindow;
  lastN: LeagueSideWindow;
};

/** Winner team when at least one WIN exists; otherwise null (do not dump onto team 2). */
export function winningTeamIfPresent(
  players: Array<{ team: number; result: string | null }>,
): 1 | 2 | null {
  if (players.some((p) => p.result === 'WIN' && p.team === 1)) return 1;
  if (players.some((p) => p.result === 'WIN' && p.team === 2)) return 2;
  return null;
}

function countWindow(
  matches: Array<{ players: Array<{ team: number; result: string | null }> }>,
): LeagueSideWindow {
  let team1Wins = 0;
  let team2Wins = 0;
  for (const match of matches) {
    const winner = winningTeamIfPresent(match.players);
    if (winner === 1) team1Wins += 1;
    else if (winner === 2) team2Wins += 1;
  }
  return { team1Wins, team2Wins, windowSize: matches.length };
}

/**
 * Aggregate season + last-N side wins.
 * `matches` must be newest-first (same order as `/match list`).
 */
export function aggregateLeagueSideWindows(
  matches: Array<{ players: Array<{ team: number; result: string | null }> }>,
  lastN: number = SIDE_WR_LAST_N,
): LeagueSideWinRate {
  const season = countWindow(matches);
  const lastSlice = matches.slice(0, Math.min(lastN, matches.length));
  return { season, lastN: countWindow(lastSlice) };
}

function formatSideWindow(
  window: LeagueSideWindow,
  teamLabelFor: (team: 1 | 2) => string,
): string {
  const { team1Wins, team2Wins } = window;
  if (team1Wins === team2Wins) {
    const wr = winRatePercent(team1Wins, team2Wins);
    const wrText = wr === null ? '' : ` (${wr}%)`;
    return `Tied ${team1Wins}–${team2Wins}${wrText}`;
  }
  if (team1Wins > team2Wins) {
    const wr = winRatePercent(team1Wins, team2Wins);
    return `${teamLabelFor(1)} ${team1Wins}–${team2Wins} (${wr}%)`;
  }
  const wr = winRatePercent(team2Wins, team1Wins);
  return `${teamLabelFor(2)} ${team2Wins}–${team1Wins} (${wr}%)`;
}

/** Description line for `/match list`, or null when the league has no completed matches. */
export function formatLeagueSideWinRateLine(
  stats: LeagueSideWinRate,
  teamLabelFor: (team: 1 | 2) => string,
): string | null {
  if (stats.season.windowSize === 0) return null;
  const season = formatSideWindow(stats.season, teamLabelFor);
  const last = formatSideWindow(stats.lastN, teamLabelFor);
  return `${season} · Last ${stats.lastN.windowSize}: ${last}`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/services/match/side-win-rate.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/match/side-win-rate.ts src/services/match/side-win-rate.test.ts
git commit -m "$(cat <<'EOF'
feat(match): add league side win-rate helpers

EOF
)"
```

---

### Task 5: [general] Wire side WR into `/match list`

**Files:**

- Modify: `src/services/match/match-list.ts`
- Modify: `src/services/match/match-list.test.ts`
- Modify: `src/services/match/index.ts` (optional re-exports)

**Interfaces:**

- Consumes: `aggregateLeagueSideWindows`, `formatLeagueSideWinRateLine`, `SIDE_WR_LAST_N` from Task 4
- Produces: `MatchListPage.sideWinRate: LeagueSideWinRate`; description prepends the side line

Do **not** change `match-list-interactions.ts` — it already calls `loadMatchListPage` + `buildMatchListEmbed`.

- [ ] **Step 1: Write the failing tests**

Update empty-page / embed fixtures in `match-list.test.ts` to include `sideWinRate`, and add:

```typescript
import type { LeagueSideWinRate } from './side-win-rate.js';

const emptySide: LeagueSideWinRate = {
  season: { team1Wins: 0, team2Wins: 0, windowSize: 0 },
  lastN: { team1Wins: 0, team2Wins: 0, windowSize: 0 },
};

const sampleSide: LeagueSideWinRate = {
  season: { team1Wins: 34, team2Wins: 25, windowSize: 59 },
  lastN: { team1Wins: 9, team2Wins: 11, windowSize: 20 },
};
```

In `returns empty page 1 when no matches`, assert:

```typescript
    expect(page.sideWinRate).toEqual(emptySide);
```

In `clamps page and maps winner…`, mock a second `matchFindMany` call for the side-WR query (or one call that returns all matches if the implementation loads winners separately). Prefer **two** `findMany` calls: page rows (skip/take) then side WR (take 20 is not enough for season — season needs all winners). Spec: season = all completed; last N = newest 20.

Implementation should:

1. Keep existing count + page `findMany`
2. Add `findMany` for side WR: same where/order, select `players: { team, result }` only (no skip; no take — or take nothing limited). For large leagues this is on-read; acceptable for v1 per spec.

Mock both calls in the clamp test:

```typescript
    matchFindMany
      .mockResolvedValueOnce([/* page row as today */])
      .mockResolvedValueOnce([
        {
          players: [
            { team: 2, result: 'WIN' },
            { team: 1, result: 'LOSS' },
          ],
        },
      ]);
```

And assert `page.sideWinRate.season.team2Wins === 1`.

Update `buildMatchListEmbed` empty fixture to include `sideWinRate: emptySide` and assert description does **not** contain `Tied` / `Z Fighters` / `Last`.

Add:

```typescript
  it('prepends the side win-rate line above the page line', () => {
    const embed = buildMatchListEmbed(
      {
        leagueName: 'UDBR',
        page: 1,
        totalPages: 4,
        totalMatches: 39,
        rows: [],
        sideWinRate: sampleSide,
      },
      (team) => (team === 1 ? 'Z Fighters' : 'Evil'),
    );
    expect(embed.data.description).toBe(
      'Z Fighters 34–25 (57.6%) · Last 20: Evil 11–9 (55%)\nPage **1** of **4** · 39 matches',
    );
  });
```

Update the other embed fixtures to pass `sideWinRate: emptySide` or `sampleSide` so TypeScript compiles.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/services/match/match-list.test.ts`

Expected: FAIL — `sideWinRate` missing / description unchanged

- [ ] **Step 3: Implement match-list wiring**

In `match-list.ts`:

```typescript
import {
  aggregateLeagueSideWindows,
  formatLeagueSideWinRateLine,
  type LeagueSideWinRate,
} from './side-win-rate.js';
```

Extend `MatchListPage`:

```typescript
  sideWinRate: LeagueSideWinRate;
```

In `loadMatchListPage`, after building `rows`, load side WR:

```typescript
  const sideMatches = await prisma.match.findMany({
    where,
    orderBy: [{ completedAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
    select: {
      players: { select: { team: true, result: true } },
    },
  });
  const sideWinRate = aggregateLeagueSideWindows(sideMatches);
```

Include `sideWinRate` in the return object. When `totalMatches === 0`, still set `sideWinRate` from `aggregateLeagueSideWindows([])`.

In `buildMatchListEmbed`:

```typescript
  const pageLine = `Page **${page.page}** of **${page.totalPages}** · ${page.totalMatches} matches`;
  const sideLine = formatLeagueSideWinRateLine(page.sideWinRate, teamLabelFor);
  const description = sideLine ? `${sideLine}\n${pageLine}` : pageLine;
```

Use `description` in `.setDescription(description)`.

Optionally re-export from `match/index.ts`:

```typescript
export {
  formatLeagueSideWinRateLine,
  type LeagueSideWinRate,
} from './side-win-rate.js';
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/services/match/match-list.test.ts src/services/match/side-win-rate.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/match/match-list.ts src/services/match/match-list.test.ts src/services/match/index.ts src/services/match/side-win-rate.ts
git commit -m "$(cat <<'EOF'
feat(match): show side win rate on match list pages

EOF
)"
```

---

### Task 6: [general] Player docs + full verification

**Files:**

- Modify: `docs/discord/public/06-rank-and-boards.md`
- Modify: `docs/discord/public/07-cheat-sheet.md`

**Interfaces:**

- Consumes: none
- Produces: one English line each documenting the new surfaces

- [ ] **Step 1: Update public docs**

In `06-rank-and-boards.md`, after the `/rank` code block, add:

```markdown
Profiles also show your **top teammates** (most games / wins / losses together) when you have shared completed matches.
```

In `07-cheat-sheet.md`, change the match list bullet to:

```markdown
• `/match list` — completed matches in this league + side win rate (optional page)
```

- [ ] **Step 2: Run the full unit suite**

Run: `npm test`

Expected: all suites PASS (symlink `.env` from the main checkout if `DISCORD_TOKEN` is missing in the worktree)

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`

Expected: exit 0

- [ ] **Step 4: Commit**

```bash
git add docs/discord/public/06-rank-and-boards.md docs/discord/public/07-cheat-sheet.md
git commit -m "$(cat <<'EOF'
docs: mention teammate and side win-rate stats

EOF
)"
```

---

## Self-review

1. **Spec coverage:** Teammate three lists + sorts + rank reset + quit rules → Tasks 1–3. Side WR season/last 20 + every page + labels → Tasks 4–5. Docs → Task 6. No schema/env.
2. **Placeholders:** None — concrete file paths, signatures, and test code in each task.
3. **Type consistency:** `TeammateStats` / `LeagueSideWinRate` / `windowSize` match the spec DTOs; embed option is `teammates?: TeammateStats`; `MatchListPage.sideWinRate` is required on the DTO.
