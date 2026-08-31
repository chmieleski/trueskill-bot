# Hero Recent Games & `/hero_players` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend `/hero` with a configurable recent-games section and add `/hero_players` for sortable top-player leaderboards on a WOS hero.

**Architecture:** Pure helpers (`pickRecentHeroGames`, `rankHeroPlayers`) in `hero-stats.ts` shared by both commands. `/hero` embed gains a Recent games field; new `hero-players-embed.ts` + `hero-players.ts` command for deeper rankings. On-read aggregation from existing `MatchPlayerStats` rows — no schema changes.

**Tech Stack:** Node.js ESM, TypeScript, discord.js v14, Prisma, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-31-hero-recent-games-and-players-design.md`

## Global Constraints

- Scope: `general` only.
- All user-facing strings in **English**.
- ESM imports use `.js` extension in TypeScript source.
- Named exports; Prisma singleton from `src/lib/prisma.ts`.
- Gate on `profile.postMatchStats === 'wos2_bot_v1'`.
- League-scoped only (`leagueId` on all match queries).
- Reuse `winRatePercent`, `isMatchCountedAfterRankReset`, `loadLatestRankResetAtByPlayer` from `rank-reset-display.ts`.
- Reuse `formatCompactStatNumber` from `match-stats-upload.ts`.
- Reuse `listWosHeroNamesForLeague`, `parseStatsWindows`, `parseRankOptions`, `findPlayerForRankLookup`.
- Run `npm run format:check` before PR.
- Conventional Commits for any commits.
- No env / AWS SSM changes.

---

## File map

| File                                             | Action | Responsibility                                                                                        |
| ------------------------------------------------ | ------ | ----------------------------------------------------------------------------------------------------- |
| `src/services/player/hero-stats.ts`              | Modify | Types, `pickRecentHeroGames`, `rankHeroPlayers`, extend `loadHeroStats`, add `loadHeroPlayerRankings` |
| `src/services/player/hero-stats.test.ts`         | Modify | Unit tests for new pure functions                                                                     |
| `src/services/player/hero-stats-embed.ts`        | Modify | Recent games field                                                                                    |
| `src/services/player/hero-stats-embed.test.ts`   | Modify | Embed tests                                                                                           |
| `src/services/player/hero-players-embed.ts`      | Create | `buildHeroPlayersEmbed`                                                                               |
| `src/services/player/hero-players-embed.test.ts` | Create | Embed tests                                                                                           |
| `src/commands/player/hero.ts`                    | Modify | `recent` option                                                                                       |
| `src/commands/player/hero-players.ts`            | Create | New slash command                                                                                     |
| `src/services/player/index.ts`                   | Modify | Re-export new APIs                                                                                    |
| `CHANGELOG.md`                                   | Modify | Unreleased entry                                                                                      |

---

### Task 1: Pure helpers — recent games + player ranking

**Files:**

- Modify: `src/services/player/hero-stats.ts`
- Modify: `src/services/player/hero-stats.test.ts`

**Interfaces:**

- Produces:
  - `export type HeroRecentGame = { matchId: string; username: string; result: MatchResult.WIN | MatchResult.LOSS; completedAt: Date | null }`
  - `export type HeroPlayerSort = 'win_rate' | 'games' | 'damage' | 'kda'`
  - `export type HeroRankedPlayer = HeroTopPlayer & { avgDamage: number; kda: string }`
  - `export function pickRecentHeroGames(rows: HeroStatsRow[], limit: number): HeroRecentGame[]`
  - `export function rankHeroPlayers(rows: HeroStatsRow[], sort: HeroPlayerSort, limit: number): HeroRankedPlayer[]`

- [ ] **Step 1: Write failing tests**

Add to `src/services/player/hero-stats.test.ts`:

```typescript
import {
  pickRecentHeroGames,
  rankHeroPlayers,
  // …existing imports
} from './hero-stats.js';

describe('pickRecentHeroGames', () => {
  it('returns newest rows up to limit', () => {
    const rows = [
      row({ matchId: 'm1', completedAt: new Date('2026-01-01T00:00:00Z'), username: 'A' }),
      row({ matchId: 'm2', completedAt: new Date('2026-01-03T00:00:00Z'), username: 'B' }),
      row({ matchId: 'm3', completedAt: new Date('2026-01-02T00:00:00Z'), username: 'C' }),
    ];
    const recent = pickRecentHeroGames(rows, 2);
    expect(recent.map((entry) => entry.matchId)).toEqual(['m2', 'm3']);
  });
});

describe('rankHeroPlayers', () => {
  const mk = (playerId: string, username: string, wins: number, losses: number, damage = 1000) =>
    Array.from({ length: wins + losses }, (_, index) =>
      row({
        matchId: `${playerId}-${index}`,
        playerId,
        username,
        result: index < wins ? MatchResult.WIN : MatchResult.LOSS,
        damageTotal: damage,
        kills: 3,
        deaths: 1,
      }),
    );

  it('sorts by games desc', () => {
    const rows = [...mk('a', 'Ace', 2, 1), ...mk('b', 'Bob', 4, 2)];
    const ranked = rankHeroPlayers(rows, 'games', 10);
    expect(ranked.map((entry) => entry.username)).toEqual(['Bob', 'Ace']);
  });

  it('sorts by damage desc', () => {
    const rows = [...mk('a', 'Ace', 3, 0, 5000), ...mk('b', 'Bob', 3, 0, 9000)];
    const ranked = rankHeroPlayers(rows, 'damage', 10);
    expect(ranked[0]!.username).toBe('Bob');
  });

  it('requires min 3 games', () => {
    const rows = [...mk('a', 'Ace', 2, 0)];
    expect(rankHeroPlayers(rows, 'win_rate', 10)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/services/player/hero-stats.test.ts`
Expected: FAIL — `pickRecentHeroGames` / `rankHeroPlayers` not defined

- [ ] **Step 3: Implement helpers in `hero-stats.ts`**

Add types and functions:

```typescript
export type HeroRecentGame = {
  matchId: string;
  username: string;
  result: typeof MatchResult.WIN | typeof MatchResult.LOSS;
  completedAt: Date | null;
};

export type HeroPlayerSort = 'win_rate' | 'games' | 'damage' | 'kda';

export type HeroRankedPlayer = HeroTopPlayer & {
  avgDamage: number;
  kda: string;
};

/** Newest player-game rows up to `limit`. */
export function pickRecentHeroGames(rows: HeroStatsRow[], limit: number): HeroRecentGame[] {
  return [...rows]
    .sort(
      (left, right) =>
        (right.completedAt?.getTime() ?? 0) - (left.completedAt?.getTime() ?? 0) ||
        right.matchId.localeCompare(left.matchId),
    )
    .slice(0, limit)
    .map((entry) => ({
      matchId: entry.matchId,
      username: entry.username,
      result: entry.result,
      completedAt: entry.completedAt,
    }));
}

function bucketPlayers(rows: HeroStatsRow[]): Map<
  string,
  {
    username: string;
    wins: number;
    losses: number;
    damageTotal: number;
    kills: number;
    deaths: number;
  }
> {
  const buckets = new Map<
    string,
    {
      username: string;
      wins: number;
      losses: number;
      damageTotal: number;
      kills: number;
      deaths: number;
    }
  >();
  for (const row of rows) {
    let bucket = buckets.get(row.playerId);
    if (!bucket) {
      bucket = { username: row.username, wins: 0, losses: 0, damageTotal: 0, kills: 0, deaths: 0 };
      buckets.set(row.playerId, bucket);
    }
    if (row.result === MatchResult.WIN) bucket.wins += 1;
    else bucket.losses += 1;
    bucket.damageTotal += row.damageTotal;
    bucket.kills += row.kills;
    bucket.deaths += row.deaths;
  }
  return buckets;
}

/** Rank players on a hero for one stats window. */
export function rankHeroPlayers(
  rows: HeroStatsRow[],
  sort: HeroPlayerSort,
  limit: number,
): HeroRankedPlayer[] {
  const players = [...bucketPlayers(rows).entries()]
    .map(([, bucket]) => {
      const games = bucket.wins + bucket.losses;
      return {
        username: bucket.username,
        games,
        wins: bucket.wins,
        losses: bucket.losses,
        winRatePercent: winRatePercent(bucket.wins, bucket.losses) ?? 0,
        avgDamage: Math.round(bucket.damageTotal / games),
        kda: formatKda(bucket.kills, bucket.deaths),
      };
    })
    .filter((entry) => entry.games >= TOP_PLAYERS_MIN_GAMES);

  const tieNick = (left: HeroRankedPlayer, right: HeroRankedPlayer) =>
    left.username.localeCompare(right.username);

  players.sort((left, right) => {
    switch (sort) {
      case 'games':
        return (
          right.games - left.games ||
          right.winRatePercent - left.winRatePercent ||
          tieNick(left, right)
        );
      case 'damage':
        return right.avgDamage - left.avgDamage || right.games - left.games || tieNick(left, right);
      case 'kda': {
        const leftKda = left.kda === '—' ? -1 : Number(left.kda);
        const rightKda = right.kda === '—' ? -1 : Number(right.kda);
        return rightKda - leftKda || right.games - left.games || tieNick(left, right);
      }
      case 'win_rate':
      default:
        return (
          right.winRatePercent - left.winRatePercent ||
          right.games - left.games ||
          tieNick(left, right)
        );
    }
  });

  return players.slice(0, limit);
}
```

Refactor `aggregateHeroWindowStats` to call `rankHeroPlayers(rows, 'win_rate', TOP_PLAYERS_LIMIT)` when `includeTopPlayers` is true (map to `HeroTopPlayer` by omitting `avgDamage`/`kda` or keep separate — DRY via shared bucket).

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/services/player/hero-stats.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/player/hero-stats.ts src/services/player/hero-stats.test.ts
git commit -m "feat(hero): add recent games and player ranking helpers"
```

---

### Task 2: Extend `loadHeroStats` + add `loadHeroPlayerRankings`

**Files:**

- Modify: `src/services/player/hero-stats.ts`
- Modify: `src/services/player/hero-stats.test.ts` (optional integration-style test with mocked rows if needed)

**Interfaces:**

- Consumes: `pickRecentHeroGames`, `rankHeroPlayers` from Task 1
- Produces:
  - `HeroStatsResult` extended with `recentGames: HeroRecentGame[]`
  - `export type HeroPlayersResult = { heroDisplayName: string; sort: HeroPlayerSort; windows: Partial<Record<StatsWindow, HeroRankedPlayer[]>> }`
  - `export async function loadHeroPlayerRankings(input: { leagueId: string; gameId: string; heroName: string; sort: HeroPlayerSort; limit: number; windows: StatsWindow[] }): Promise<HeroPlayersResult | null>`

- [ ] **Step 1: Extend `loadHeroStats` signature**

Add `recentLimit: number` to input. After building `allRows`, set:

```typescript
recentGames: pickRecentHeroGames(allRows, input.recentLimit),
```

on the returned `HeroStatsResult`.

- [ ] **Step 2: Implement `loadHeroPlayerRankings`**

Reuse the same Prisma query + `mapPrismaRows` path as `loadHeroStats` (extract shared `loadHeroStatsRows` private helper if it reduces duplication). No `playerId` filter. No rank reset. Per window:

```typescript
if (input.windows.includes('overall')) {
  windows.overall = rankHeroPlayers(allRows, input.sort, input.limit);
}
if (input.windows.includes('last10')) {
  windows.last10 = rankHeroPlayers(filterRowsToLast10Matches(allRows), input.sort, input.limit);
}
```

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: PASS (update callers in next tasks if needed)

- [ ] **Step 4: Commit**

```bash
git add src/services/player/hero-stats.ts
git commit -m "feat(hero): load recent games and hero player rankings"
```

---

### Task 3: `/hero` embed — recent games field

**Files:**

- Modify: `src/services/player/hero-stats-embed.ts`
- Modify: `src/services/player/hero-stats-embed.test.ts`

**Interfaces:**

- Consumes: `HeroStatsResult.recentGames`
- Produces: `buildHeroStatsEmbed` adds **Recent games** field when `recentGames.length > 0`

- [ ] **Step 1: Write failing embed test**

```typescript
it('includes recent games for league view', () => {
  const embed = buildHeroStatsEmbed({
    heroDisplayName: 'Goku',
    windows: {
      overall: { games: 1, avgDamage: 1, avgTaken: 1, avgHeal: 1, kda: '1', topPlayers: [] },
    },
    recentGames: [
      {
        matchId: 'match-1',
        username: 'Tiny',
        result: MatchResult.WIN,
        completedAt: new Date('2026-01-15T12:00:00Z'),
      },
    ],
  });
  const recentField = embed.data.fields?.find((field) => field.name === 'Recent games');
  expect(recentField?.value).toContain('Tiny');
  expect(recentField?.value).toContain('match-1');
});
```

- [ ] **Step 2: Implement `formatRecentGames` in embed**

League rows: `{username} · {Win|Loss} · <t:unix:D>\n\`{matchId}\`` 
Player rows (when`result.playerUsername`set):`{emoji} {Win|Loss} · <t:unix:D>\n\`{matchId}\``

Append field after window fields.

- [ ] **Step 3: Run tests**

Run: `npx vitest run src/services/player/hero-stats-embed.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/services/player/hero-stats-embed.ts src/services/player/hero-stats-embed.test.ts
git commit -m "feat(hero): show recent games on hero stats embed"
```

---

### Task 4: `/hero` command — `recent` option

**Files:**

- Modify: `src/commands/player/hero.ts`

**Interfaces:**

- Consumes: `loadHeroStats({ …, recentLimit })`
- Produces: slash option `recent` with choices 5 (default) and 10

- [ ] **Step 1: Add option to `data`**

```typescript
.addStringOption((option) =>
  option
    .setName('recent')
    .setDescription('Recent games to show')
    .setRequired(false)
    .addChoices(
      { name: '5', value: '5' },
      { name: '10', value: '10' },
    ),
)
```

- [ ] **Step 2: Parse and pass to loader**

```typescript
const recentRaw = interaction.options.getString('recent');
const recentLimit = recentRaw === '10' ? 10 : 5;
// …
const stats = await loadHeroStats({
  // …existing fields
  recentLimit,
});
```

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/commands/player/hero.ts
git commit -m "feat(hero): add recent games count option"
```

---

### Task 5: `/hero_players` embed + command

**Files:**

- Create: `src/services/player/hero-players-embed.ts`
- Create: `src/services/player/hero-players-embed.test.ts`
- Create: `src/commands/player/hero-players.ts`
- Modify: `src/services/player/index.ts`

**Interfaces:**

- Consumes: `HeroPlayersResult`, `HeroPlayerSort`
- Produces: `buildHeroPlayersEmbed(result, options?: { leagueName?: string })`

- [ ] **Step 1: Write failing embed test**

```typescript
import { buildHeroPlayersEmbed } from './hero-players-embed.js';

it('formats ranked players with sort label', () => {
  const embed = buildHeroPlayersEmbed(
    {
      heroDisplayName: 'Goku',
      sort: 'damage',
      windows: {
        overall: [
          {
            username: 'Tiny',
            games: 5,
            wins: 4,
            losses: 1,
            winRatePercent: 80,
            avgDamage: 42000,
            kda: '3',
          },
        ],
      },
    },
    { leagueName: 'Test League' },
  );
  expect(embed.data.title).toContain('Avg damage');
  expect(embed.data.description).toBe('Test League');
});
```

- [ ] **Step 2: Implement `hero-players-embed.ts`**

Sort label map:

```typescript
const SORT_LABELS: Record<HeroPlayerSort, string> = {
  win_rate: 'Win rate',
  games: 'Games played',
  damage: 'Avg damage',
  kda: 'KDA',
};
```

Row format: `{rank}. {username} · {games}G · {wins}W {losses}L · {wr}% · avg {dmg} dmg · KDA {kda}`

- [ ] **Step 3: Create `hero-players.ts` command**

Mirror `hero.ts` structure:

- WOS gate, league resolve, hero autocomplete (copy from `hero.ts`)
- Options: `hero`, `sort`, `limit`, `window`, `league`
- `deferReply` always
- Call `loadHeroPlayerRankings`
- Reply with `buildHeroPlayersEmbed`

Default parse:

```typescript
const sort = (interaction.options.getString('sort') ?? 'win_rate') as HeroPlayerSort;
const limitRaw = interaction.options.getString('limit');
const limit = limitRaw === '5' ? 5 : limitRaw === '25' ? 25 : 10;
```

- [ ] **Step 4: Export from `src/services/player/index.ts`**

- [ ] **Step 5: Run tests + typecheck**

Run:

```bash
npx vitest run src/services/player/hero-players-embed.test.ts
npm run typecheck
```

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/services/player/hero-players-embed.ts src/services/player/hero-players-embed.test.ts src/commands/player/hero-players.ts src/services/player/index.ts
git commit -m "feat(hero): add hero_players command for sortable rankings"
```

---

### Task 6: Changelog + format

**Files:**

- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add Unreleased entry**

```markdown
### Added

- `/hero` recent games section (`recent` option: 5 or 10, default 5) for league and player views.
- `/hero_players` — sortable top-player list by win rate, games, avg damage, or KDA (limit 5/10/25).
```

- [ ] **Step 2: Format check**

Run: `npm run format:check`
If fail: `npm run format`

- [ ] **Step 3: Run full relevant tests**

Run: `npx vitest run src/services/player/hero-stats.test.ts src/services/player/hero-stats-embed.test.ts src/services/player/hero-players-embed.test.ts`

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs: changelog for hero recent games and hero_players"
```

---

## Manual test checklist

- [ ] `/hero hero:<name>` — league view shows Recent games + existing stats
- [ ] `/hero hero:<name> user:@self recent:10` — player recent games, rank reset respected
- [ ] `/hero_players hero:<name> sort:games limit:25` — 25 rows max, correct sort
- [ ] Non-WOS league — both commands return WOS-only message
- [ ] Restart dev bot (`npm run dev`) so slash commands redeploy

---

## Plan self-review

| Spec requirement         | Task                                  |
| ------------------------ | ------------------------------------- |
| Recent games both views  | Task 3–4                              |
| `recent` 5/10 default 5  | Task 4                                |
| `/hero_players` command  | Task 5                                |
| Four sort modes          | Task 1, 5                             |
| Limit 5/10/25 default 10 | Task 5                                |
| Min 3 games              | Task 1                                |
| Rank reset player only   | Task 2 (loadHeroStats path unchanged) |
| WOS gate                 | Task 4–5                              |
| No pagination v1         | N/A (by design)                       |

No placeholders remain. Types consistent across tasks.
