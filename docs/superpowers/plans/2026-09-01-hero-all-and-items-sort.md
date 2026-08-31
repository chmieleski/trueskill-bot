# `/hero_all` & `/items` Sort Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `/hero_all` for sortable, paginated league-wide hero rankings (last 20 + overall windows) and extend `/items` with a `sort` option (buy / WR / picks).

**Architecture:** Pure helpers in `hero-stats.ts` (`filterRowsToLastNMatches`, `rankAllHeroes`, `loadAllHeroRankings`) and `item-stats.ts` (`ItemSort` on `aggregateItemWindowStats`). New `hero-all-embed.ts` + `hero-all.ts` command. On-read aggregation — no schema changes.

**Tech Stack:** Node.js ESM, TypeScript, discord.js v14, Prisma, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-01-hero-all-and-items-sort-design.md`

## Global Constraints

- Scope: `general` only.
- All user-facing strings in **English**.
- ESM imports use `.js` extension in TypeScript source.
- Named exports; Prisma singleton from `src/lib/prisma.ts`.
- Gate on `profile.postMatchStats === 'wos2_bot_v1'`.
- League-scoped only (`leagueId` on all match queries).
- Reuse `winRatePercent` from `rank-reset-display.ts`.
- Reuse `formatMonospaceTable`, `truncateDiscordFieldValue` from `discord-embed-table.ts`.
- Reuse `formatCompactStatNumber` from `match-stats-upload.ts`.
- Reuse `clampMatchHistoryPage` from `match-history.ts`.
- Reuse `withOptionalLeagueOption`, `resolveLeagueIdFromInteraction`, `getLeagueOption`.
- Do **not** change existing `/hero` / `/hero_players` / `/items` last-10 window behavior.
- Run `npm run format:check` before PR.
- Conventional Commits for any commits.
- No env / AWS SSM changes.

---

## File map

| File                                         | Action | Responsibility                                                                                                 |
| -------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------- |
| `src/services/player/hero-stats.ts`          | Modify | `filterRowsToLastNMatches`, hero-all types, `rankAllHeroes`, `loadAllHeroRankings`, `parseHeroAllStatsWindows` |
| `src/services/player/hero-stats.test.ts`     | Modify | Unit tests for new pure functions                                                                              |
| `src/services/player/hero-all-embed.ts`      | Create | `buildHeroAllEmbed`                                                                                            |
| `src/services/player/hero-all-embed.test.ts` | Create | Embed snapshot tests                                                                                           |
| `src/commands/player/hero-all.ts`            | Create | `/hero_all` slash command                                                                                      |
| `src/services/player/item-stats.ts`          | Modify | `ItemSort`, sort on `aggregateItemWindowStats`, `loadItemStats`                                                |
| `src/services/player/item-stats.test.ts`     | Modify | Sort unit tests                                                                                                |
| `src/services/player/item-stats-embed.ts`    | Modify | Pass sort label in title (optional)                                                                            |
| `src/commands/player/items.ts`               | Modify | `sort` option                                                                                                  |
| `src/services/player/index.ts`               | Modify | Re-export new APIs                                                                                             |
| `CHANGELOG.md`                               | Modify | Unreleased entry                                                                                               |

---

### Task 1: `filterRowsToLastNMatches` refactor

**Files:**

- Modify: `src/services/player/hero-stats.ts`
- Modify: `src/services/player/hero-stats.test.ts`

**Interfaces:**

- Produces:
  - `export function filterRowsToLastNMatches(rows: HeroStatsRow[], matchCount: number): HeroStatsRow[]`
  - `filterRowsToLast10Matches` becomes a thin wrapper calling `filterRowsToLastNMatches(rows, 10)` (behavior unchanged)

- [ ] **Step 1: Write failing test for N=20**

Add to `src/services/player/hero-stats.test.ts`:

```typescript
import { filterRowsToLastNMatches } from './hero-stats.js';

describe('filterRowsToLastNMatches', () => {
  it('keeps only rows from the N newest match ids', () => {
    const rows = Array.from({ length: 25 }, (_, index) =>
      row({
        matchId: `m${index}`,
        completedAt: new Date(`2026-01-${String(index + 1).padStart(2, '0')}T00:00:00Z`),
      }),
    );
    const filtered = filterRowsToLastNMatches(rows, 20);
    const matchIds = new Set(filtered.map((entry) => entry.matchId));
    expect(matchIds.size).toBe(20);
    expect(matchIds.has('m24')).toBe(true);
    expect(matchIds.has('m0')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/services/player/hero-stats.test.ts`

Expected: FAIL — `filterRowsToLastNMatches` not exported

- [ ] **Step 3: Implement**

In `hero-stats.ts`, replace the body of `filterRowsToLast10Matches` with:

```typescript
export function filterRowsToLastNMatches(rows: HeroStatsRow[], matchCount: number): HeroStatsRow[] {
  const matchCompletedAt = new Map<string, number>();
  for (const row of rows) {
    const ms = row.completedAt?.getTime() ?? 0;
    const existing = matchCompletedAt.get(row.matchId);
    if (existing === undefined || ms > existing) {
      matchCompletedAt.set(row.matchId, ms);
    }
  }

  const lastMatchIds = new Set(
    [...matchCompletedAt.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, matchCount)
      .map(([matchId]) => matchId),
  );

  return rows.filter((row) => lastMatchIds.has(row.matchId));
}

export function filterRowsToLast10Matches(rows: HeroStatsRow[]): HeroStatsRow[] {
  return filterRowsToLastNMatches(rows, 10);
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/services/player/hero-stats.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/player/hero-stats.ts src/services/player/hero-stats.test.ts
git commit -m "refactor(wos): extract filterRowsToLastNMatches for hero stats"
```

---

### Task 2: Pure helpers — `rankAllHeroes` + window parser

**Files:**

- Modify: `src/services/player/hero-stats.ts`
- Modify: `src/services/player/hero-stats.test.ts`

**Interfaces:**

- Produces:

```typescript
export type HeroAllStatsWindow = 'last20' | 'overall';

export type HeroAllSort = 'win_rate' | 'games' | 'damage' | 'taken' | 'heal';

export type HeroAllEntry = {
  heroDisplayName: string;
  games: number;
  wins: number;
  losses: number;
  winRatePercent: number;
  avgDamage: number;
  avgTaken: number;
  avgHeal: number;
};

export function parseHeroAllStatsWindows(raw: string | null): HeroAllStatsWindow[];

export function aggregateHeroAllEntries(rows: HeroStatsRow[]): HeroAllEntry[];

export function rankAllHeroes(entries: HeroAllEntry[], sort: HeroAllSort): HeroAllEntry[];
```

- [ ] **Step 1: Write failing tests**

```typescript
describe('parseHeroAllStatsWindows', () => {
  it('defaults to both windows', () => {
    expect(parseHeroAllStatsWindows(null)).toEqual(['last20', 'overall']);
  });
  it('parses last20 only', () => {
    expect(parseHeroAllStatsWindows('last20')).toEqual(['last20']);
  });
});

describe('aggregateHeroAllEntries', () => {
  it('buckets rows by hero display name', () => {
    const rows = [
      row({ matchId: 'm1', damageTotal: 1000, takenTotal: 500, heal: 50 }),
      // simulate second hero by varying stats.heroName via a wrapper — use two load paths in integration;
      // for unit test, call aggregate on pre-grouped rows per hero in rankAllHeroes tests instead
    ];
  });
});

describe('rankAllHeroes', () => {
  const entries: HeroAllEntry[] = [
    {
      heroDisplayName: 'Alpha',
      games: 10,
      wins: 6,
      losses: 4,
      winRatePercent: 60,
      avgDamage: 5000,
      avgTaken: 2000,
      avgHeal: 100,
    },
    {
      heroDisplayName: 'Beta',
      games: 20,
      wins: 10,
      losses: 10,
      winRatePercent: 50,
      avgDamage: 9000,
      avgTaken: 3000,
      avgHeal: 200,
    },
  ];

  it('sorts by win_rate desc', () => {
    expect(rankAllHeroes(entries, 'win_rate').map((e) => e.heroDisplayName)).toEqual([
      'Alpha',
      'Beta',
    ]);
  });

  it('sorts by games desc', () => {
    expect(rankAllHeroes(entries, 'games')[0]!.heroDisplayName).toBe('Beta');
  });

  it('sorts by damage desc', () => {
    expect(rankAllHeroes(entries, 'damage')[0]!.heroDisplayName).toBe('Beta');
  });
});
```

Implement `aggregateHeroAllEntries` to accept rows **already filtered to one hero** OR implement `bucketRowsByHero(rows): Map<string, { displayName: string; rows: HeroStatsRow[] }>` and aggregate each bucket — prefer:

```typescript
export function bucketRowsByHero(
  rows: Array<HeroStatsRow & { heroDisplayName: string }>,
): Map<string, { displayName: string; rows: HeroStatsRow[] }>;
```

Loader adds `heroDisplayName` when mapping prisma rows (from `stats.heroName` + catalog).

- [ ] **Step 2: Run tests — expect FAIL**

- [ ] **Step 3: Implement `parseHeroAllStatsWindows`, `bucketRowsByHero`, `aggregateHeroAllEntries`, `rankAllHeroes`**

`aggregateHeroAllEntries` for one hero's rows:

```typescript
export function aggregateHeroAllEntries(
  heroDisplayName: string,
  rows: HeroStatsRow[],
): HeroAllEntry | null {
  if (rows.length === 0) {
    return null;
  }
  let wins = 0;
  let losses = 0;
  for (const row of rows) {
    if (row.result === MatchResult.WIN) wins += 1;
    else losses += 1;
  }
  const games = wins + losses;
  return {
    heroDisplayName,
    games,
    wins,
    losses,
    winRatePercent: winRatePercent(wins, losses) ?? 0,
    avgDamage: Math.round(mean(rows.map((r) => r.damageTotal))),
    avgTaken: Math.round(mean(rows.map((r) => r.takenTotal))),
    avgHeal: Math.round(mean(rows.map((r) => r.heal))),
  };
}
```

- [ ] **Step 4: Run tests — expect PASS**

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(wos): add rankAllHeroes and hero-all window parser"
```

---

### Task 3: Loader — `loadAllHeroRankings`

**Files:**

- Modify: `src/services/player/hero-stats.ts`
- Modify: `src/services/player/hero-stats.test.ts` (optional mocked-row test)

**Interfaces:**

- Produces:

```typescript
export const HERO_ALL_PAGE_SIZE = 15;

export type HeroAllRankingsResult = {
  sort: HeroAllSort;
  page: number;
  totalPages: number;
  totalHeroes: number;
  windows: Partial<Record<HeroAllStatsWindow, HeroAllEntry[]>>;
};

export async function loadAllHeroRankings(input: {
  leagueId: string;
  gameId: string;
  sort: HeroAllSort;
  windows: HeroAllStatsWindow[];
  page: number;
}): Promise<HeroAllRankingsResult>;
```

- [ ] **Step 1: Implement loader**

Query pattern (single fetch, no per-hero queries):

```typescript
const rows = await prisma.matchPlayer.findMany({
  where: {
    result: { in: [MatchResult.WIN, MatchResult.LOSS] },
    match: { leagueId: input.leagueId, status: MatchStatus.COMPLETED },
    stats: { heroName: { not: null } },
  },
  select: {
    result: true,
    matchId: true,
    match: { select: { completedAt: true } },
    stats: {
      select: {
        heroName: true,
        heroObjectId: true,
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

Map to `HeroStatsRow` + `heroDisplayName` using `resolveHeroDisplayNames` / `formatHeroDisplayName` (batch objectIds like `wos-hero-names.ts`).

For each window:

- `overall` → all mapped rows
- `last20` → `filterRowsToLastNMatches(allRows, 20)`
- Bucket by hero → `aggregateHeroAllEntries` → filter `games >= 1` → `rankAllHeroes` → paginate with `HERO_ALL_PAGE_SIZE` and `clampMatchHistoryPage`

**Important:** Pagination is on the **sorted hero list**; same `page` applies to each window field in the embed.

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`

- [ ] **Step 3: Commit**

```bash
git commit -m "feat(wos): add loadAllHeroRankings loader"
```

---

### Task 4: Embed — `buildHeroAllEmbed`

**Files:**

- Create: `src/services/player/hero-all-embed.ts`
- Create: `src/services/player/hero-all-embed.test.ts`

**Interfaces:**

- Consumes: `HeroAllRankingsResult`, `HeroAllSort`
- Produces: `export function buildHeroAllEmbed(result: HeroAllRankingsResult, options?: { leagueName?: string }): EmbedBuilder`

- [ ] **Step 1: Write embed test**

```typescript
import { describe, expect, it } from 'vitest';
import { buildHeroAllEmbed } from './hero-all-embed.js';

describe('buildHeroAllEmbed', () => {
  it('renders paginated table for both windows', () => {
    const embed = buildHeroAllEmbed(
      {
        sort: 'win_rate',
        page: 1,
        totalPages: 2,
        totalHeroes: 20,
        windows: {
          last20: [
            {
              heroDisplayName: 'Raiden Ei',
              games: 12,
              wins: 8,
              losses: 4,
              winRatePercent: 66.7,
              avgDamage: 18000,
              avgTaken: 9000,
              avgHeal: 500,
            },
          ],
          overall: [],
        },
      },
      { leagueName: 'WOS IHL' },
    );
    const json = embed.toJSON();
    expect(json.title).toContain('Win rate');
    expect(json.description).toContain('WOS IHL');
    expect(json.fields?.[0]?.name).toBe('Last 20 games');
    expect(json.fields?.[0]?.value).toContain('Raiden Ei');
  });
});
```

- [ ] **Step 2: Implement embed**

Table columns via `formatMonospaceTable`:

| Hero | WR | G | Dmg | Taken | Heal |

Use `formatCompactStatNumber` for dmg/taken/heal. Footer: `Page **n** of **m** · **total** heroes` in description (match `/hero_matches` style).

Sort labels map:

```typescript
const SORT_LABELS: Record<HeroAllSort, string> = {
  win_rate: 'Win rate',
  games: 'Games played',
  damage: 'Avg damage',
  taken: 'Avg damage taken',
  heal: 'Avg healing',
};
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run src/services/player/hero-all-embed.test.ts`

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(wos): add hero-all embed builder"
```

---

### Task 5: Slash command — `/hero_all`

**Files:**

- Create: `src/commands/player/hero-all.ts`
- Modify: `src/services/player/index.ts`

**Interfaces:**

- Consumes: `loadAllHeroRankings`, `parseHeroAllStatsWindows`, `buildHeroAllEmbed`

- [ ] **Step 1: Create command**

Mirror `hero-players.ts` structure (no autocomplete):

```typescript
export const data = withOptionalLeagueOption(
  new SlashCommandBuilder()
    .setName('hero_all')
    .setDescription('WOS league-wide hero rankings — sortable stats')
    .addStringOption((option) =>
      option
        .setName('sort')
        .setDescription('Sort heroes by')
        .setRequired(false)
        .addChoices(
          { name: 'Win rate', value: 'win_rate' },
          { name: 'Games played', value: 'games' },
          { name: 'Avg damage', value: 'damage' },
          { name: 'Avg damage taken', value: 'taken' },
          { name: 'Avg healing', value: 'heal' },
        ),
    )
    .addStringOption((option) =>
      option
        .setName('window')
        .setDescription('Stats window')
        .setRequired(false)
        .addChoices(
          { name: 'Both', value: 'both' },
          { name: 'Last 20', value: 'last20' },
          { name: 'Overall', value: 'overall' },
        ),
    )
    .addIntegerOption((option) =>
      option.setName('page').setDescription('Page number').setRequired(false).setMinValue(1),
    ),
);
```

`execute`: defer → WOS gate → `loadAllHeroRankings` → empty check → `editReply` with embed.

Empty when `totalHeroes === 0`:

`_No hero data yet — stats appear after matches with uploaded reports._`

- [ ] **Step 2: Export from `src/services/player/index.ts`**

```typescript
export { buildHeroAllEmbed } from './hero-all-embed.js';
export {
  loadAllHeroRankings,
  parseHeroAllStatsWindows,
  HERO_ALL_PAGE_SIZE,
  type HeroAllSort,
  type HeroAllRankingsResult,
} from './hero-stats.js';
```

- [ ] **Step 3: Restart dev / deploy commands**

Run: `npm run dev` (or `npm run deploy-commands`) so `/hero_all` registers.

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(wos): add /hero_all slash command"
```

---

### Task 6: `/items` sort

**Files:**

- Modify: `src/services/player/item-stats.ts`
- Modify: `src/services/player/item-stats.test.ts`
- Modify: `src/services/player/item-stats-embed.ts`
- Modify: `src/commands/player/items.ts`

**Interfaces:**

- Produces:

```typescript
export type ItemSort = 'buy_rate' | 'win_rate' | 'picks';

export function aggregateItemWindowStats(
  rows: ItemStatsRow[],
  names: Map<number, string>,
  sort?: ItemSort,
): ItemWindowEntry[];
```

- [ ] **Step 1: Write failing sort tests**

```typescript
describe('aggregateItemWindowStats sort', () => {
  const names = new Map([
    [1, 'Alpha'],
    [2, 'Beta'],
  ]);
  const rows: ItemStatsRow[] = [
    {
      matchId: 'm1',
      result: MatchResult.WIN,
      completedAt: null,
      heroName: 'X',
      itemSlots: [1, 2, 0, 0, 0, 0],
    },
    {
      matchId: 'm2',
      result: MatchResult.LOSS,
      completedAt: null,
      heroName: 'X',
      itemSlots: [1, 0, 0, 0, 0, 0],
    },
    {
      matchId: 'm3',
      result: MatchResult.WIN,
      completedAt: null,
      heroName: 'X',
      itemSlots: [2, 0, 0, 0, 0, 0],
    },
    {
      matchId: 'm4',
      result: MatchResult.WIN,
      completedAt: null,
      heroName: 'X',
      itemSlots: [2, 0, 0, 0, 0, 0],
    },
  ];

  it('sorts by win_rate', () => {
    const entries = aggregateItemWindowStats(rows, names, 'win_rate');
    expect(entries[0]!.displayName).toBe('Beta'); // 2/2 wins
  });

  it('sorts by picks', () => {
    const entries = aggregateItemWindowStats(rows, names, 'picks');
    expect(entries[0]!.displayName).toBe('Beta'); // 2 picks vs 1
  });
});
```

- [ ] **Step 2: Implement sort in `aggregateItemWindowStats`**

Replace hardcoded sort with switch on `sort ?? 'buy_rate'`. Null WR sorts last for `win_rate` sort.

Update `loadItemStats` to accept `sort: ItemSort` and pass through.

- [ ] **Step 3: Add `sort` option to `items.ts`**

```typescript
.addStringOption((option) =>
  option
    .setName('sort')
    .setDescription('Sort items by')
    .setRequired(false)
    .addChoices(
      { name: 'Buy rate', value: 'buy_rate' },
      { name: 'Win rate', value: 'win_rate' },
      { name: 'Picks', value: 'picks' },
    ),
)
```

- [ ] **Step 4: Update embed title** (optional clarity)

`Item stats — sorted by Buy rate` when sort ≠ default, or always show sort in title.

- [ ] **Step 5: Run tests**

Run: `npx vitest run src/services/player/item-stats.test.ts src/services/player/item-stats-embed.test.ts`

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(wos): add sort option to /items command"
```

---

### Task 7: Changelog + verification

**Files:**

- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add unreleased entry**

```markdown
- **wos:** `/hero_all` — league-wide sortable hero rankings (last 20 / overall, paginated); `/items` gains `sort` (buy / WR / picks)
```

- [ ] **Step 2: Run full verification**

```bash
npm run typecheck
npm run format:check
npx vitest run src/services/player/hero-stats.test.ts src/services/player/hero-all-embed.test.ts src/services/player/item-stats.test.ts src/services/player/item-stats-embed.test.ts
```

- [ ] **Step 3: Commit**

```bash
git commit -m "docs: changelog for hero_all and items sort"
```

---

## Manual test checklist

- [ ] `/hero_all` in WOS league — both windows, default WR sort
- [ ] `/hero_all sort:games page:2` — pagination footer correct
- [ ] `/hero_all window:last20` — single field only
- [ ] Non-WOS league — friendly error
- [ ] `/items sort:win_rate` — rows ordered by WR
- [ ] `/items` without sort — unchanged buy-rate order

---

## Spec coverage self-review

| Spec requirement                     | Task      |
| ------------------------------------ | --------- |
| `/hero_all` command shape            | Task 5    |
| last20 window (not last10 elsewhere) | Tasks 1–3 |
| Hero pool ≥1 game                    | Task 3    |
| Pagination 15/page                   | Tasks 3–4 |
| Sort options + tie-breaks            | Task 2    |
| `/items` sort                        | Task 6    |
| WOS gate                             | Tasks 5–6 |
| Changelog                            | Task 7    |
