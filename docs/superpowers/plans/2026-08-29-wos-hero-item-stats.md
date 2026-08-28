# WOS Hero & Item Stats Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `/hero` and `/items` slash commands for WOS leagues — hero combat averages, top players by WR, and item buy/WR meta from persisted `MatchPlayerStats`, with item names cataloged from `ITEM_RATE` report lines.

**Architecture:** Extend the WOS2 parser to collect `itemRates[]`; upsert `GameItem` on report persist. Pure aggregation functions in `src/services/player/` query completed match rows on-read (same pattern as companion stats). Thin command adapters gate on `postMatchStats === 'wos2_bot_v1'`.

**Tech Stack:** Node.js ESM, TypeScript, discord.js v14, Prisma, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-29-wos-hero-item-stats-design.md`

## Global Constraints

- Scope: `general` for commands/aggregates/embeds; `game:warcraft3_wos` for `ITEM_RATE` parsing only.
- All user-facing strings in **English**.
- ESM imports use `.js` extension in TypeScript source.
- Named exports; Prisma singleton from `src/lib/prisma.ts`.
- Gate on `profile.postMatchStats === 'wos2_bot_v1'`.
- League-scoped only (`leagueId` on all match queries); no event matches.
- Reuse `winRatePercent`, `isMatchCountedAfterRankReset`, `loadLatestRankResetAtByPlayer` from `rank-reset-display.ts`.
- Reuse `formatCompactStatNumber` from `match-stats-upload.ts` for dmg/heal/taken display.
- Reuse `parseRankOptions` / `findPlayerForRankLookup` patterns from `/rank`.
- Run `npm run format:check` before PR; fix with `npm run format` if needed.
- Conventional Commits for any commits.
- No env / AWS SSM changes.

---

## File map

| File                                                     | Action | Responsibility                                    |
| -------------------------------------------------------- | ------ | ------------------------------------------------- |
| `prisma/schema.prisma`                                   | Modify | Add `GameItem` model + `Game.items` relation      |
| `prisma/migrations/…_game_item/migration.sql`            | Create | Migration                                         |
| `src/games/warcraft3_wos/wos2-bot-report-parser.ts`      | Modify | Parse `ITEM_RATE` → `itemRates[]`                 |
| `src/games/warcraft3_wos/wos2-bot-report-parser.test.ts` | Modify | Assert `itemRates` from sample fixture            |
| `src/games/warcraft3_wos/index.ts`                       | Modify | Export `Wos2BotReportItemRate` type if needed     |
| `src/services/game/game-item-catalog.ts`                 | Create | `upsertGameItems`, `resolveItemNames`             |
| `src/services/game/game-item-catalog.test.ts`            | Create | Upsert + name resolve tests                       |
| `src/services/match/match-stats-upload.ts`               | Modify | Call catalog upsert after persist                 |
| `src/services/match/match-stats-upload.test.ts`          | Modify | Assert upsert called (mock prisma or integration) |
| `src/services/player/hero-stats.ts`                      | Create | Row loading + window aggregation + top players    |
| `src/services/player/hero-stats.test.ts`                 | Create | Pure aggregation unit tests                       |
| `src/services/player/item-stats.ts`                      | Create | Item buy rate + WR aggregation                    |
| `src/services/player/item-stats.test.ts`                 | Create | Pure aggregation unit tests                       |
| `src/services/player/hero-stats-embed.ts`                | Create | `buildHeroStatsEmbed`                             |
| `src/services/player/hero-stats-embed.test.ts`           | Create | Embed field snapshots                             |
| `src/services/player/item-stats-embed.ts`                | Create | `buildItemStatsEmbed`                             |
| `src/services/player/item-stats-embed.test.ts`           | Create | Embed field snapshots                             |
| `src/services/player/wos-hero-names.ts`                  | Create | `listWosHeroNamesForLeague` for autocomplete      |
| `src/services/player/index.ts`                           | Modify | Re-export new public APIs                         |
| `src/commands/player/hero.ts`                            | Create | `/hero` slash command                             |
| `src/commands/player/items.ts`                           | Create | `/items` slash command                            |
| `CHANGELOG.md`                                           | Modify | Unreleased entry for new commands                 |

Commands auto-load via `src/handlers/load-commands.ts` (no handler change needed).

---

### Task 1: `GameItem` schema

**Files:**

- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260829120000_game_item/migration.sql`

**Interfaces:**

- Produces: Prisma model `GameItem` with `@@id([gameId, objectId])`

- [ ] **Step 1: Add model to schema**

In `prisma/schema.prisma`, add `items GameItem[]` on `Game` and:

```prisma
model GameItem {
  gameId    String
  objectId  Int
  name      String
  updatedAt DateTime @updatedAt

  game Game @relation(fields: [gameId], references: [id], onDelete: Cascade)

  @@id([gameId, objectId])
  @@index([gameId])
}
```

- [ ] **Step 2: Create migration**

Run:

```bash
npm run db:migrate -- --name game_item
```

Expected: migration SQL creates `"GameItem"` table with composite PK.

- [ ] **Step 3: Regenerate client**

Run: `npm run db:generate`

Expected: `@prisma/client` exports `GameItem`.

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/
git commit -m "feat(wos): add GameItem catalog table"
```

---

### Task 2: Parse `ITEM_RATE` in WOS2 report parser

**Files:**

- Modify: `src/games/warcraft3_wos/wos2-bot-report-parser.ts`
- Modify: `src/games/warcraft3_wos/wos2-bot-report-parser.test.ts`
- Modify: `src/games/warcraft3_wos/index.ts`

**Interfaces:**

- Produces:

```typescript
export type Wos2BotReportItemRate = {
  objectId: number;
  name: string;
};

export type Wos2BotReport = {
  // existing fields…
  itemRates: Wos2BotReportItemRate[];
};
```

- [ ] **Step 1: Write failing test**

Add to `wos2-bot-report-parser.test.ts`:

```typescript
it('parses ITEM_RATE lines into itemRates', () => {
  const report = parseWos2BotReport(sampleRaw);
  expect(report.itemRates).toEqual(
    expect.arrayContaining([
      { objectId: 1227894850, name: 'Oken' },
      { objectId: 1227894873, name: "Angel's Blessing" },
    ]),
  );
  expect(report.itemRates).toHaveLength(8);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/games/warcraft3_wos/wos2-bot-report-parser.test.ts`

Expected: FAIL — `itemRates` undefined or missing.

- [ ] **Step 3: Implement parser changes**

In `wos2-bot-report-parser.ts`:

1. Add `Wos2BotReportItemRate` type.
2. Add `itemRates: Wos2BotReportItemRate[]` to `Wos2BotReport`.
3. In `parseWos2BotReport`, create `const itemRates: Wos2BotReportItemRate[] = []`.
4. Replace `case 'ITEM_RATE': break` with:

```typescript
case 'ITEM_RATE': {
  const objectId = requireInt(fields, 'item_id', 'ITEM_RATE');
  const name = fields.get('item_name')?.trim();
  if (!name) {
    break;
  }
  itemRates.push({ objectId, name });
  break;
}
```

5. Return `itemRates` in the report object (dedupe not required — catalog upsert handles it).

- [ ] **Step 4: Export type from `index.ts`**

```typescript
export type { Wos2BotReportItemRate } from './wos2-bot-report-parser.js';
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run src/games/warcraft3_wos/wos2-bot-report-parser.test.ts`

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/games/warcraft3_wos/
git commit -m "feat(wos): parse ITEM_RATE lines from bot reports"
```

---

### Task 3: Game item catalog service

**Files:**

- Create: `src/services/game/game-item-catalog.ts`
- Create: `src/services/game/game-item-catalog.test.ts`

**Interfaces:**

- Consumes: `Wos2BotReportItemRate` from `games/warcraft3_wos`
- Produces:

```typescript
export async function upsertGameItems(
  gameId: string,
  itemRates: Wos2BotReportItemRate[],
): Promise<void>;

export async function resolveItemNames(
  gameId: string,
  objectIds: number[],
): Promise<Map<number, string>>;
```

- [ ] **Step 1: Write failing tests**

```typescript
// src/services/game/game-item-catalog.test.ts
import { describe, expect, it, vi, beforeEach } from 'vitest';

const upsertMock = vi.fn();
const findManyMock = vi.fn();

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    gameItem: {
      upsert: (...args: unknown[]) => upsertMock(...args),
      findMany: (...args: unknown[]) => findManyMock(...args),
    },
  },
}));

import { resolveItemNames, upsertGameItems } from './game-item-catalog.js';

describe('upsertGameItems', () => {
  beforeEach(() => {
    upsertMock.mockReset();
  });

  it('upserts each item rate for the game', async () => {
    await upsertGameItems('warcraft3_wos', [
      { objectId: 1, name: 'Oken' },
      { objectId: 2, name: 'Zangetsu' },
    ]);
    expect(upsertMock).toHaveBeenCalledTimes(2);
    expect(upsertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { gameId_objectId: { gameId: 'warcraft3_wos', objectId: 1 } },
        create: { gameId: 'warcraft3_wos', objectId: 1, name: 'Oken' },
        update: { name: 'Oken' },
      }),
    );
  });

  it('skips empty itemRates array', async () => {
    await upsertGameItems('warcraft3_wos', []);
    expect(upsertMock).not.toHaveBeenCalled();
  });
});

describe('resolveItemNames', () => {
  beforeEach(() => {
    findManyMock.mockReset();
  });

  it('returns map of objectId to name', async () => {
    findManyMock.mockResolvedValue([
      { objectId: 1, name: 'Oken' },
      { objectId: 2, name: 'Zangetsu' },
    ]);
    const map = await resolveItemNames('warcraft3_wos', [1, 2, 99]);
    expect(map.get(1)).toBe('Oken');
    expect(map.get(99)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL**

Run: `npx vitest run src/services/game/game-item-catalog.test.ts`

- [ ] **Step 3: Implement**

```typescript
// src/services/game/game-item-catalog.ts
import type { Wos2BotReportItemRate } from '../../games/warcraft3_wos/index.js';
import { prisma } from '../../lib/prisma.js';

export async function upsertGameItems(
  gameId: string,
  itemRates: Wos2BotReportItemRate[],
): Promise<void> {
  if (itemRates.length === 0) {
    return;
  }
  await Promise.all(
    itemRates.map((item) =>
      prisma.gameItem.upsert({
        where: { gameId_objectId: { gameId, objectId: item.objectId } },
        create: { gameId, objectId: item.objectId, name: item.name },
        update: { name: item.name },
      }),
    ),
  );
}

export async function resolveItemNames(
  gameId: string,
  objectIds: number[],
): Promise<Map<number, string>> {
  const unique = [...new Set(objectIds.filter((id) => id !== 0))];
  if (unique.length === 0) {
    return new Map();
  }
  const rows = await prisma.gameItem.findMany({
    where: { gameId, objectId: { in: unique } },
    select: { objectId: true, name: true },
  });
  return new Map(rows.map((row) => [row.objectId, row.name]));
}

export function formatItemDisplayName(objectId: number, names: Map<number, string>): string {
  return names.get(objectId) ?? `Item #${objectId}`;
}
```

- [ ] **Step 4: Run tests — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add src/services/game/
git commit -m "feat(wos): add GameItem catalog upsert and name resolve"
```

---

### Task 4: Wire catalog upsert into report persist

**Files:**

- Modify: `src/services/match/match-stats-upload.ts`
- Modify: `src/services/match/match-stats-upload.test.ts` (if exists — extend with mock)

**Interfaces:**

- Consumes: `upsertGameItems`, `report.itemRates`
- Modifies: `persistWos2MatchStats` to upsert after transaction

- [ ] **Step 1: Load `gameId` and call upsert**

At end of `persistWos2MatchStats`, after the transaction succeeds:

```typescript
import { upsertGameItems } from '../game/game-item-catalog.js';

// inside persistWos2MatchStats, after transaction:
const match = await prisma.match.findUnique({
  where: { id: input.matchId },
  select: { league: { select: { gameId: true } } },
});
if (match?.league?.gameId && input.report.itemRates.length > 0) {
  await upsertGameItems(match.league.gameId, input.report.itemRates);
}
```

Pass `report` through — already available as `input.report`.

- [ ] **Step 2: Extend parser test fixture usage in upload test**

In `match-stats-upload.test.ts`, if `persistWos2MatchStats` is tested, mock `prisma.match.findUnique` and assert `upsertGameItems` is invoked when `itemRates` present. Minimal test:

```typescript
it('upserts game items after persisting stats', async () => {
  // use existing test helpers / mocks from file
  // assert prisma.gameItem.upsert called or spy upsertGameItems
});
```

If upload tests are heavy, a focused unit test mocking `upsertGameItems` via `vi.mock` is acceptable.

- [ ] **Step 3: Run affected tests**

Run: `npx vitest run src/services/match/match-stats-upload.test.ts src/games/warcraft3_wos/wos2-bot-report-parser.test.ts`

- [ ] **Step 4: Commit**

```bash
git add src/services/match/match-stats-upload.ts src/services/match/match-stats-upload.test.ts
git commit -m "feat(wos): upsert GameItem catalog on report persist"
```

---

### Task 5: Hero stats aggregation (pure + loader)

**Files:**

- Create: `src/services/player/hero-stats.ts`
- Create: `src/services/player/hero-stats.test.ts`

**Interfaces:**

- Produces:

```typescript
export type StatsWindow = 'last10' | 'overall';

export type HeroStatsRow = {
  matchId: string;
  playerId: string;
  username: string;
  result: MatchResult.WIN | MatchResult.LOSS;
  completedAt: Date | null;
  damageTotal: number;
  takenTotal: number;
  heal: number;
  kills: number;
  deaths: number;
};

export type HeroWindowStats = {
  games: number;
  avgDamage: number;
  avgTaken: number;
  avgHeal: number;
  kda: string; // "2.4" or "—"
  topPlayers: Array<{
    username: string;
    games: number;
    wins: number;
    losses: number;
    winRatePercent: number;
  }>;
};

export type HeroStatsResult = {
  heroDisplayName: string;
  windows: Partial<Record<StatsWindow, HeroWindowStats>>;
  playerUsername?: string;
  rankResetAt?: Date;
};

export function normalizeHeroNameKey(name: string): string;
export function aggregateHeroWindowStats(
  rows: HeroStatsRow[],
  options: { includeTopPlayers: boolean },
): HeroWindowStats;
export function filterRowsToLast10Matches(rows: HeroStatsRow[]): HeroStatsRow[];
export async function loadHeroStats(input: {
  leagueId: string;
  heroName: string;
  playerId?: string;
  windows: StatsWindow[];
}): Promise<HeroStatsResult | null>;
```

- [ ] **Step 1: Write failing pure-function tests**

```typescript
// src/services/player/hero-stats.test.ts
import { MatchResult } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import {
  aggregateHeroWindowStats,
  filterRowsToLast10Matches,
  normalizeHeroNameKey,
} from './hero-stats.js';

function row(overrides: Partial<HeroStatsRow> & { matchId: string }): HeroStatsRow {
  return {
    playerId: 'p1',
    username: 'Alice',
    result: MatchResult.WIN,
    completedAt: new Date('2026-01-10T12:00:00Z'),
    damageTotal: 1000,
    takenTotal: 500,
    heal: 100,
    kills: 2,
    deaths: 1,
    ...overrides,
  };
}

describe('normalizeHeroNameKey', () => {
  it('lowercases and trims', () => {
    expect(normalizeHeroNameKey('  Raiden Ei ')).toBe('raiden ei');
  });
});

describe('filterRowsToLast10Matches', () => {
  it('keeps only rows from the 10 newest match ids', () => {
    const rows = Array.from({ length: 12 }, (_, i) =>
      row({
        matchId: `m${i}`,
        completedAt: new Date(`2026-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`),
      }),
    );
    const filtered = filterRowsToLast10Matches(rows);
    const matchIds = new Set(filtered.map((r) => r.matchId));
    expect(matchIds.size).toBe(10);
    expect(matchIds.has('m11')).toBe(true);
    expect(matchIds.has('m0')).toBe(false);
  });
});

describe('aggregateHeroWindowStats', () => {
  it('computes averages and KDA as sum(kills)/sum(deaths)', () => {
    const stats = aggregateHeroWindowStats(
      [
        row({ matchId: 'm1', kills: 4, deaths: 2, damageTotal: 1000 }),
        row({ matchId: 'm2', kills: 2, deaths: 2, damageTotal: 2000 }),
      ],
      { includeTopPlayers: false },
    );
    expect(stats.games).toBe(2);
    expect(stats.avgDamage).toBe(1500);
    expect(stats.kda).toBe('3'); // 6/2
  });

  it('returns top 5 players with min 3 games sorted by WR', () => {
    const mk = (playerId: string, username: string, wins: number, losses: number) =>
      Array.from({ length: wins + losses }, (_, i) =>
        row({
          matchId: `${playerId}-${i}`,
          playerId,
          username,
          result: i < wins ? MatchResult.WIN : MatchResult.LOSS,
        }),
      );
    const rows = [...mk('a', 'Ace', 2, 1), ...mk('b', 'Bob', 4, 2), ...mk('c', 'Cara', 1, 2)];
    const stats = aggregateHeroWindowStats(rows, { includeTopPlayers: true });
    expect(stats.topPlayers.map((p) => p.username)).toEqual(['Bob', 'Ace']);
    expect(stats.topPlayers.find((p) => p.username === 'Cara')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL**

- [ ] **Step 3: Implement pure functions + loader**

Key implementation notes:

- `aggregateHeroWindowStats`: mean for dmg/taken/heal; `kda = sum(deaths) === 0 ? '—' : String(Math.round((sum(kills)/sum(deaths)) * 10) / 10)` or one-decimal formatting.
- Top players: bucket by `playerId`, min 3 games, sort WR desc → games desc → username asc, take 5.
- `loadHeroStats`: Prisma query:

```typescript
prisma.matchPlayer.findMany({
  where: {
    ...(playerId ? { playerId } : {}),
    result: { in: [MatchResult.WIN, MatchResult.LOSS] },
    match: { leagueId, status: MatchStatus.COMPLETED },
    stats: { heroName: { not: null } },
  },
  select: {
    playerId: true,
    result: true,
    matchId: true,
    player: { select: { username: true } },
    match: { select: { completedAt: true } },
    stats: {
      select: {
        heroName: true,
        damageTotal: true,
        takenTotal: true,
        heal: true,
        kills: true,
        deaths: true,
      },
    },
  },
});
```

Filter rows where `normalizeHeroNameKey(stats.heroName) === normalizeHeroNameKey(input.heroName)`.

If `playerId` set, load rank reset and filter overall rows with `isMatchCountedAfterRankReset`.

Return `null` when zero rows match.

- [ ] **Step 4: Run tests — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add src/services/player/hero-stats.ts src/services/player/hero-stats.test.ts
git commit -m "feat(wos): add hero stats aggregation service"
```

---

### Task 6: Item stats aggregation

**Files:**

- Create: `src/services/player/item-stats.ts`
- Create: `src/services/player/item-stats.test.ts`

**Interfaces:**

- Consumes: `resolveItemNames`, `formatItemDisplayName` from `game-item-catalog.ts`
- Produces:

```typescript
export type ItemStatsRow = {
  matchId: string;
  result: MatchResult.WIN | MatchResult.LOSS;
  completedAt: Date | null;
  heroName: string | null;
  itemSlots: [number, number, number, number, number, number];
};

export type ItemWindowEntry = {
  objectId: number;
  displayName: string;
  buyRatePercent: number;
  winRatePercent: number | null;
  gamesWithItem: number;
};

export type ItemStatsResult = {
  heroDisplayName?: string;
  windows: Partial<Record<StatsWindow, ItemWindowEntry[]>>;
};

export function aggregateItemWindowStats(
  rows: ItemStatsRow[],
  names: Map<number, string>,
): ItemWindowEntry[];
export async function loadItemStats(input: {
  leagueId: string;
  gameId: string;
  heroName?: string;
  windows: StatsWindow[];
}): Promise<ItemStatsResult>;
```

- [ ] **Step 1: Write failing tests**

```typescript
describe('aggregateItemWindowStats', () => {
  it('computes buy rate and WR per item', () => {
    const names = new Map([[10, 'Oken']]);
    const rows: ItemStatsRow[] = [
      {
        matchId: 'm1',
        result: MatchResult.WIN,
        completedAt: null,
        heroName: 'X',
        itemSlots: [10, 0, 0, 0, 0, 0],
      },
      {
        matchId: 'm2',
        result: MatchResult.LOSS,
        completedAt: null,
        heroName: 'X',
        itemSlots: [0, 0, 0, 0, 0, 0],
      },
      {
        matchId: 'm3',
        result: MatchResult.WIN,
        completedAt: null,
        heroName: 'X',
        itemSlots: [10, 0, 0, 0, 0, 0],
      },
    ];
    const entries = aggregateItemWindowStats(rows, names);
    expect(entries[0]).toMatchObject({
      objectId: 10,
      displayName: 'Oken',
      gamesWithItem: 2,
      buyRatePercent: 66.7,
      winRatePercent: 100,
    });
  });

  it('ignores slot value 0', () => {
    const entries = aggregateItemWindowStats(
      [
        {
          matchId: 'm1',
          result: MatchResult.WIN,
          completedAt: null,
          heroName: null,
          itemSlots: [0, 0, 0, 0, 0, 0],
        },
      ],
      new Map(),
    );
    expect(entries).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Implement**

- Collect all object IDs from slots across rows.
- Per objectId: `gamesWithItem`, wins when item present and result WIN.
- `buyRatePercent = winRatePercent(gamesWithItem, totalGames - gamesWithItem)` — **no**, buy rate is `gamesWithItem / totalGames * 100`.
- Sort by buyRate desc → gamesWithItem desc → name asc; take 10.
- `loadItemStats`: similar Prisma query including `itemSlot1..6`; optional hero name filter; resolve names via `resolveItemNames`.

- [ ] **Step 4: Run — PASS**

- [ ] **Step 5: Commit**

```bash
git add src/services/player/item-stats.ts src/services/player/item-stats.test.ts
git commit -m "feat(wos): add item stats aggregation service"
```

---

### Task 7: Embed builders

**Files:**

- Create: `src/services/player/hero-stats-embed.ts`
- Create: `src/services/player/hero-stats-embed.test.ts`
- Create: `src/services/player/item-stats-embed.ts`
- Create: `src/services/player/item-stats-embed.test.ts`
- Modify: `src/services/player/index.ts`

**Interfaces:**

- Consumes: `HeroStatsResult`, `ItemStatsResult`, `formatCompactStatNumber`
- Produces: `buildHeroStatsEmbed(result, options)`, `buildItemStatsEmbed(result, options)`

- [ ] **Step 1: Hero embed test**

```typescript
import { describe, expect, it } from 'vitest';
import { buildHeroStatsEmbed } from './hero-stats-embed.js';

describe('buildHeroStatsEmbed', () => {
  it('includes Last 10 and Overall fields', () => {
    const embed = buildHeroStatsEmbed({
      heroDisplayName: 'Frieren',
      windows: {
        last10: {
          games: 10,
          avgDamage: 5000,
          avgTaken: 3000,
          avgHeal: 200,
          kda: '2.5',
          topPlayers: [{ username: 'Tiny', games: 5, wins: 4, losses: 1, winRatePercent: 80 }],
        },
        overall: {
          games: 50,
          avgDamage: 4800,
          avgTaken: 2900,
          avgHeal: 180,
          kda: '2.3',
          topPlayers: [],
        },
      },
    });
    const fields = embed.toJSON().fields ?? [];
    expect(fields.some((f) => f.name === 'Last 10 games')).toBe(true);
    expect(fields.some((f) => f.name === 'Overall')).toBe(true);
    expect(embed.toJSON().title).toContain('Frieren');
  });
});
```

- [ ] **Step 2: Implement `buildHeroStatsEmbed`**

Format stat line:

```text
{games}G · Avg {dmg} dmg · {taken} taken · {heal} heal · KDA {kda}
```

Top players sub-block or second line in field value. Player view title: `{username} on {hero}`.

- [ ] **Step 3: Item embed test + implement**

Title: `Item stats` + optional `on {hero}`. Each item row:

```text
{name} · {buy}% buy · {wr}% WR · {games}G
```

- [ ] **Step 4: Export from `index.ts`**

- [ ] **Step 5: Run embed tests**

Run: `npx vitest run src/services/player/hero-stats-embed.test.ts src/services/player/item-stats-embed.test.ts`

- [ ] **Step 6: Commit**

```bash
git add src/services/player/
git commit -m "feat(wos): add hero and item stats embed builders"
```

---

### Task 8: WOS hero name autocomplete helper

**Files:**

- Create: `src/services/player/wos-hero-names.ts`

**Interfaces:**

- Produces: `listWosHeroNamesForLeague(leagueId: string): Promise<string[]>`

- [ ] **Step 1: Implement**

```typescript
export async function listWosHeroNamesForLeague(leagueId: string): Promise<string[]> {
  const rows = await prisma.matchPlayerStats.findMany({
    where: {
      heroName: { not: null },
      matchPlayer: {
        match: { leagueId, status: MatchStatus.COMPLETED },
      },
    },
    select: { heroName: true },
    distinct: ['heroName'],
  });
  return rows
    .map((r) => r.heroName!.trim())
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
}
```

Use raw query or group in memory if Prisma distinct on relation is awkward — adjust to working Prisma syntax (may need `findMany` + Set dedupe by normalized key, keep first display casing).

- [ ] **Step 2: Commit**

```bash
git add src/services/player/wos-hero-names.ts
git commit -m "feat(wos): list distinct hero names for league autocomplete"
```

---

### Task 9: `/hero` slash command

**Files:**

- Create: `src/commands/player/hero.ts`

**Interfaces:**

- Consumes: `loadHeroStats`, `buildHeroStatsEmbed`, `listWosHeroNamesForLeague`, league resolve, `getGameProfileForLeague`, `parseRankOptions`, `findPlayerForRankLookup`

- [ ] **Step 1: Define slash command**

```typescript
export const data = withOptionalLeagueOption(
  new SlashCommandBuilder()
    .setName('hero')
    .setDescription('WOS hero stats — league averages and top players')
    .addStringOption((o) =>
      o.setName('hero').setDescription('Hero name').setRequired(true).setAutocomplete(true),
    )
    .addUserOption((o) => o.setName('user').setDescription('Player to look up').setRequired(false))
    .addStringOption((o) => o.setName('nick').setDescription('In-game nick').setRequired(false))
    .addStringOption((o) =>
      o
        .setName('window')
        .setDescription('Stats window')
        .setRequired(false)
        .addChoices(
          { name: 'Both', value: 'both' },
          { name: 'Last 10', value: 'last10' },
          { name: 'Overall', value: 'overall' },
        ),
    ),
);
```

- [ ] **Step 2: Implement `execute`**

1. Parse `window` → `StatsWindow[]` (`both` → `['last10','overall']`).
2. Resolve league.
3. `getGameProfileForLeague` — if `postMatchStats !== 'wos2_bot_v1'`, reply: `Hero/item stats are only available for WOS leagues.`
4. If `user`/`nick`, `deferReply` + `findPlayerForRankLookup`; else can reply inline if fast.
5. `loadHeroStats({ leagueId, heroName, playerId?, windows })`.
6. If null → `No completed matches found for **{hero}** in this league.` (or player-specific message).
7. `buildHeroStatsEmbed` + `editReply`.

- [ ] **Step 3: Implement `autocomplete`**

League autocomplete first; then filter `listWosHeroNamesForLeague` by focused `hero` string (max 25).

- [ ] **Step 4: Manual smoke test**

Run `npm run dev`, invoke `/hero` in dev guild (requires WOS league with stats data).

- [ ] **Step 5: Commit**

```bash
git add src/commands/player/hero.ts
git commit -m "feat(wos): add /hero slash command"
```

---

### Task 10: `/items` slash command

**Files:**

- Create: `src/commands/player/items.ts`

- [ ] **Step 1: Define command**

```typescript
export const data = withOptionalLeagueOption(
  new SlashCommandBuilder()
    .setName('items')
    .setDescription('WOS item buy rate and win rate')
    .addStringOption((o) =>
      o
        .setName('hero')
        .setDescription('Filter to one hero')
        .setRequired(false)
        .setAutocomplete(true),
    )
    .addStringOption((o) =>
      o
        .setName('window')
        .setDescription('Stats window')
        .setRequired(false)
        .addChoices(
          { name: 'Both', value: 'both' },
          { name: 'Last 10', value: 'last10' },
          { name: 'Overall', value: 'overall' },
        ),
    ),
);
```

- [ ] **Step 2: Implement `execute`**

Same WOS gate. Load `gameId` from league. `loadItemStats`. Empty → `_No item data yet — stats appear after matches with uploaded reports._`

- [ ] **Step 3: Autocomplete** — reuse hero name list when `hero` focused.

- [ ] **Step 4: Commit**

```bash
git add src/commands/player/items.ts
git commit -m "feat(wos): add /items slash command"
```

---

### Task 11: Changelog + verification gate

**Files:**

- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add Unreleased entry**

```markdown
### Added

- `/hero` — WOS league hero averages (last 10 + overall), top players by WR, optional player lookup
- `/items` — WOS item buy rate and win rate (optional hero filter)
```

- [ ] **Step 2: Run full verification**

```bash
npm run typecheck
npm run format:check
npx vitest run src/games/warcraft3_wos/ src/services/game/ src/services/player/hero-stats src/services/player/item-stats src/services/player/hero-stats-embed src/services/player/item-stats-embed
```

Expected: all pass.

- [ ] **Step 3: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs: changelog for WOS hero and item stats commands"
```

---

## Spec coverage checklist

| Spec requirement                      | Task          |
| ------------------------------------- | ------------- |
| `GameItem` schema                     | Task 1        |
| `ITEM_RATE` parse                     | Task 2        |
| Catalog upsert on upload              | Tasks 3–4     |
| `/hero` options + both windows        | Task 9        |
| `/hero` league + player views         | Tasks 5, 7, 9 |
| Top 5 / min 3 games                   | Task 5        |
| Rank reset on user overall            | Task 5        |
| `/items` optional hero + both windows | Tasks 6, 10   |
| Top 10 items, buy % + WR %            | Task 6        |
| WOS-only gate                         | Tasks 9–10    |
| Hero autocomplete from league data    | Task 8        |
| English strings                       | All tasks     |
| No env/SSM                            | —             |

## Optional follow-up (not in v1 plan)

- Backfill script: re-parse `MatchStatsReport.rawText` to seed `GameItem` for historical reports.
- Discord docs template sync if project maintains player guides for new commands.
