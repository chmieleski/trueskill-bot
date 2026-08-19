# Leaderboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `/leaderboard show` (overall paginated + hero modes), `/leaderboard setup`, `/config` leaderboard channel management, and auto-refreshing live overall top-10 messages per guild.

**Architecture:** Domain logic in `leaderboard.ts` (queries + pagination), `leaderboard-embed.ts` (Discord layout), `leaderboard-channel.ts` (persisted live message setup/refresh/scheduler). Slash commands and button handlers are thin adapters. Refresh runs fire-and-forget after match completion, on bot ready, and every 15 minutes.

**Tech Stack:** Node.js ESM TypeScript, discord.js v14, Prisma/PostgreSQL, Vitest, existing `displayOrdinal` and `competitionRank` patterns from `rating-math.ts` / `player-profile.ts`.

## Global Constraints

- All user-facing strings in **English** (exact messages from the design error table).
- Never display raw OpenSkill μ/σ; public rating is **ki** via `displayOrdinal`.
- Overall eligibility: **≥1 completed match** (WIN/LOSS on COMPLETED match).
- Hero eligibility: `PlayerHeroRating.matchesPlayed > 0`.
- Embed gold accent **`0xf0b232`**; monospace aligned tables (match `/rank`).
- Live channel shows **overall top 10 only** (hero live channel = tech debt).
- Pagination buttons: **only the invoker** may press them.
- Ladder is **global** (not per-guild).
- ESM imports use `.js` extension; Prisma singleton from `src/lib/prisma.ts`.

**Spec:** [docs/superpowers/specs/2026-08-14-leaderboard-design.md](../specs/2026-08-14-leaderboard-design.md)

## File map

| File                                       | Role                                                                |
| ------------------------------------------ | ------------------------------------------------------------------- |
| `prisma/schema.prisma`                     | Add `leaderboardChannelId`, `leaderboardMessageId` to `GuildConfig` |
| `prisma/migrations/...`                    | Migration SQL                                                       |
| `src/services/guild-config.ts`             | Extend resolve + set/clear leaderboard fields                       |
| `src/services/guild-config.test.ts`        | Tests for new fields                                                |
| `src/services/leaderboard.ts`              | Queries, DTOs, pagination, hero resolution                          |
| `src/services/leaderboard.test.ts`         | Unit tests                                                          |
| `src/services/leaderboard-embed.ts`        | Embed + button row builders                                         |
| `src/services/leaderboard-embed.test.ts`   | Embed shape tests                                                   |
| `src/services/leaderboard-channel.ts`      | Setup, clear, refresh one/all, scheduler                            |
| `src/services/leaderboard-channel.test.ts` | Light unit tests (custom ID parse, skip logic)                      |
| `src/commands/player/leaderboard.ts`       | `/leaderboard show` + `/leaderboard setup`                          |
| `src/commands/config/config.ts`            | `set/clear leaderboard_channel`, extend `view`                      |
| `src/handlers/leaderboard-interactions.ts` | Page button handler                                                 |
| `src/events/interaction-create.ts`         | Route `leaderboard:*` before slash commands                         |
| `src/handlers/match-interactions.ts`       | Fire refresh after `completeMatch`                                  |
| `src/commands/match/match.ts`              | Fire refresh after slash `completeMatch`                            |
| `src/events/ready.ts`                      | Initial refresh + start scheduler                                   |

---

### Task 1: Prisma schema + guild-config extensions

**Files:**

- Modify: `prisma/schema.prisma`
- Create: migration via `npm run db:migrate`
- Modify: `src/services/guild-config.ts`
- Modify: `src/services/guild-config.test.ts`

**Interfaces:**

- Produces:
  - `ResolvedGuildConfig` adds `leaderboardChannelId?: string`, `leaderboardMessageId?: string`
  - `setLeaderboardChannel(guildId, channelId, messageId): Promise<void>`
  - `clearLeaderboardChannel(guildId): Promise<void>`

- [ ] **Step 1: Update Prisma schema**

In `prisma/schema.prisma`, extend `GuildConfig`:

```prisma
model GuildConfig {
  guildId                String   @id
  matchCreateRoleId      String?
  matchModRoleId         String?
  leaderboardChannelId   String?
  leaderboardMessageId   String?
  createdAt              DateTime @default(now())
  updatedAt              DateTime @updatedAt
}
```

- [ ] **Step 2: Create migration**

Run: `npm run db:migrate -- --name add_leaderboard_channel`

Expected: migration folder created; `npm run db:generate` succeeds.

- [ ] **Step 3: Write failing guild-config tests**

Append to `src/services/guild-config.test.ts` (extend mock if needed — `findUnique` already mocked):

```typescript
import {
  // ...existing imports...
  setLeaderboardChannel,
  clearLeaderboardChannel,
} from './guild-config.js';

describe('leaderboard channel config', () => {
  beforeEach(() => {
    upsert.mockReset();
    upsert.mockResolvedValue({});
  });

  it('upserts leaderboard channel and message ids', async () => {
    await setLeaderboardChannel('guild-1', 'chan-1', 'msg-1');

    expect(upsert).toHaveBeenCalledWith({
      where: { guildId: 'guild-1' },
      create: {
        guildId: 'guild-1',
        leaderboardChannelId: 'chan-1',
        leaderboardMessageId: 'msg-1',
      },
      update: {
        leaderboardChannelId: 'chan-1',
        leaderboardMessageId: 'msg-1',
      },
    });
  });

  it('clears leaderboard ids', async () => {
    await clearLeaderboardChannel('guild-1');

    expect(upsert).toHaveBeenCalledWith({
      where: { guildId: 'guild-1' },
      create: {
        guildId: 'guild-1',
        leaderboardChannelId: null,
        leaderboardMessageId: null,
      },
      update: {
        leaderboardChannelId: null,
        leaderboardMessageId: null,
      },
    });
  });
});
```

Also extend the `uses database when fields are set` test row to include leaderboard fields and assert they appear on `resolveGuildConfig`.

- [ ] **Step 4: Run tests to verify they fail**

Run: `npm test -- src/services/guild-config.test.ts`

Expected: FAIL — `setLeaderboardChannel` / `clearLeaderboardChannel` not exported.

- [ ] **Step 5: Implement guild-config extensions**

Update `ResolvedGuildConfig`:

```typescript
export interface ResolvedGuildConfig {
  matchCreateRoleId: string | undefined;
  matchModRoleId: string | undefined;
  matchCreateRoleSource: RoleConfigSource;
  matchModRoleSource: RoleConfigSource;
  leaderboardChannelId: string | undefined;
  leaderboardMessageId: string | undefined;
}
```

In `resolveGuildConfig`, map from row:

```typescript
leaderboardChannelId: row?.leaderboardChannelId?.trim() || undefined,
leaderboardMessageId: row?.leaderboardMessageId?.trim() || undefined,
```

Add:

```typescript
export async function setLeaderboardChannel(
  guildId: string,
  channelId: string,
  messageId: string,
): Promise<void> {
  await prisma.guildConfig.upsert({
    where: { guildId },
    create: { guildId, leaderboardChannelId: channelId, leaderboardMessageId: messageId },
    update: { leaderboardChannelId: channelId, leaderboardMessageId: messageId },
  });
}

export async function clearLeaderboardChannel(guildId: string): Promise<void> {
  await prisma.guildConfig.upsert({
    where: { guildId },
    create: { guildId, leaderboardChannelId: null, leaderboardMessageId: null },
    update: { leaderboardChannelId: null, leaderboardMessageId: null },
  });
}
```

- [ ] **Step 6: Run tests**

Run: `npm test -- src/services/guild-config.test.ts`

Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add prisma/schema.prisma prisma/migrations src/services/guild-config.ts src/services/guild-config.test.ts
git commit -m "feat: add guild leaderboard channel config fields"
```

---

### Task 2: Leaderboard service (queries + pagination)

**Files:**

- Create: `src/services/leaderboard.ts`
- Create: `src/services/leaderboard.test.ts`

**Interfaces:**

- Consumes: `displayOrdinal` from `rating-math.ts`, `competitionRank` from `player-profile.ts`, `ensureHeroesExist` from `rating-preview.ts`, Prisma
- Produces:

```typescript
export const LEADERBOARD_PAGE_SIZE = 10;
export const LIVE_LEADERBOARD_SIZE = 10;
export const HERO_COMPACT_TOP = 3;
export const HERO_SINGLE_TOP = 10;

export type OverallLeaderboardEntry = {
  rank: number;
  playerId: string;
  username: string;
  ki: number;
  games: number;
  discordId: string | null;
};

export type HeroLeaderboardEntry = {
  rank: number;
  playerId: string;
  username: string;
  ki: number;
  matchesPlayed: number;
};

export type OverallLeaderboardPage = {
  entries: OverallLeaderboardEntry[];
  page: number;
  totalPages: number;
  totalPlayers: number;
};

export type HeroBoardSlice = {
  heroId: number;
  heroName: string;
  entries: HeroLeaderboardEntry[];
};

export class LeaderboardServiceError extends Error {}

export function clampPage(page: number, totalPages: number): number;
export function assignSortedRanks<T extends { ki: number }>(rows: T[]): (T & { rank: number })[];
export function paginateOverall(
  rows: OverallLeaderboardEntry[],
  page: number,
): OverallLeaderboardPage;

export async function loadOverallLeaderboardPage(page: number): Promise<OverallLeaderboardPage>;
export async function loadOverallLeaderboardTop(limit: number): Promise<OverallLeaderboardEntry[]>;
export async function loadHeroLeaderboard(
  heroId: number,
  limit: number,
): Promise<{ heroName: string; entries: HeroLeaderboardEntry[] }>;
export async function loadAllHeroLeaderboards(): Promise<HeroBoardSlice[]>;
export async function resolveHeroByName(
  name: string,
): Promise<{ heroId: number; heroName: string } | null>;
export async function listHeroNames(): Promise<{ id: number; name: string }[]>;
```

- [ ] **Step 1: Write failing unit tests for pure helpers**

Create `src/services/leaderboard.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import {
  assignSortedRanks,
  clampPage,
  paginateOverall,
  type OverallLeaderboardEntry,
} from './leaderboard.js';

describe('clampPage', () => {
  it('clamps below 1 and above totalPages', () => {
    expect(clampPage(0, 5)).toBe(1);
    expect(clampPage(99, 5)).toBe(5);
    expect(clampPage(3, 5)).toBe(3);
  });

  it('returns 1 when totalPages is 0', () => {
    expect(clampPage(5, 0)).toBe(1);
  });
});

describe('assignSortedRanks', () => {
  it('uses competition ranks for tied ki', () => {
    const rows = assignSortedRanks([
      { ki: 5000, username: 'a' },
      { ki: 4000, username: 'b' },
      { ki: 4000, username: 'c' },
      { ki: 3000, username: 'd' },
    ]);
    expect(rows.map((r) => r.rank)).toEqual([1, 2, 2, 4]);
  });
});

describe('paginateOverall', () => {
  const base: OverallLeaderboardEntry[] = Array.from({ length: 25 }, (_, i) => ({
    rank: i + 1,
    playerId: `p${i}`,
    username: `user${i}`,
    ki: 5000 - i * 10,
    games: 5,
    discordId: null,
  }));

  it('returns page 2 with 10 entries', () => {
    const page = paginateOverall(base, 2);
    expect(page.page).toBe(2);
    expect(page.totalPages).toBe(3);
    expect(page.totalPlayers).toBe(25);
    expect(page.entries).toHaveLength(10);
    expect(page.entries[0]?.username).toBe('user10');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/services/leaderboard.test.ts`

Expected: FAIL — module not found.

- [ ] **Step 3: Implement pure helpers**

```typescript
export function clampPage(page: number, totalPages: number): number {
  if (totalPages <= 0) {
    return 1;
  }
  return Math.min(Math.max(1, page), totalPages);
}

export function assignSortedRanks<T extends { ki: number }>(rows: T[]): (T & { rank: number })[] {
  const result: (T & { rank: number })[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    if (i === 0 || row.ki !== rows[i - 1]!.ki) {
      result.push({ ...row, rank: i + 1 });
    } else {
      result.push({ ...row, rank: result[i - 1]!.rank });
    }
  }
  return result;
}

export function paginateOverall(
  rows: OverallLeaderboardEntry[],
  page: number,
): OverallLeaderboardPage {
  const totalPlayers = rows.length;
  const totalPages = Math.max(1, Math.ceil(totalPlayers / LEADERBOARD_PAGE_SIZE));
  const safePage = clampPage(page, totalPages);
  const start = (safePage - 1) * LEADERBOARD_PAGE_SIZE;
  return {
    entries: rows.slice(start, start + LEADERBOARD_PAGE_SIZE),
    page: safePage,
    totalPages,
    totalPlayers,
  };
}
```

- [ ] **Step 4: Run pure helper tests**

Run: `npm test -- src/services/leaderboard.test.ts`

Expected: PASS for pure tests (DB tests added next).

- [ ] **Step 5: Implement async loaders**

Query strategy for overall (avoid N+1):

```typescript
import { MatchResult, MatchStatus } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { displayOrdinal } from './rating-math.js';
import { ensureHeroesExist } from './rating-preview.js';

async function loadEligibleOverallRows(): Promise<OverallLeaderboardEntry[]> {
  const [ratings, gameCounts] = await Promise.all([
    prisma.playerRating.findMany({
      include: { player: { select: { id: true, username: true, discordId: true } } },
    }),
    prisma.matchPlayer.groupBy({
      by: ['playerId'],
      where: {
        match: { status: MatchStatus.COMPLETED },
        result: { in: [MatchResult.WIN, MatchResult.LOSS] },
      },
      _count: { _all: true },
    }),
  ]);

  const gamesByPlayer = new Map(gameCounts.map((row) => [row.playerId, row._count._all]));

  const sorted = ratings
    .map((row) => ({
      playerId: row.playerId,
      username: row.player.username,
      discordId: row.player.discordId,
      ki: displayOrdinal(row.mu, row.sigma),
      games: gamesByPlayer.get(row.playerId) ?? 0,
    }))
    .filter((row) => row.games >= 1)
    .sort((a, b) => b.ki - a.ki || a.username.localeCompare(b.username));

  return assignSortedRanks(sorted).map((row) => ({
    rank: row.rank,
    playerId: row.playerId,
    username: row.username,
    ki: row.ki,
    games: row.games,
    discordId: row.discordId,
  }));
}

export async function loadOverallLeaderboardPage(page: number): Promise<OverallLeaderboardPage> {
  const rows = await loadEligibleOverallRows();
  return paginateOverall(rows, page);
}

export async function loadOverallLeaderboardTop(limit: number): Promise<OverallLeaderboardEntry[]> {
  const rows = await loadEligibleOverallRows();
  return rows.slice(0, limit);
}
```

Hero loaders:

```typescript
async function mapHeroRatings(
  rows: {
    playerId: string;
    mu: number;
    sigma: number;
    matchesPlayed: number;
    player: { username: string };
  }[],
  limit: number,
): Promise<HeroLeaderboardEntry[]> {
  const sorted = rows
    .filter((row) => row.matchesPlayed > 0)
    .map((row) => ({
      playerId: row.playerId,
      username: row.player.username,
      ki: displayOrdinal(row.mu, row.sigma),
      matchesPlayed: row.matchesPlayed,
    }))
    .sort((a, b) => b.ki - a.ki || a.username.localeCompare(b.username))
    .slice(0, limit);

  return assignSortedRanks(sorted).map((row) => ({
    rank: row.rank,
    playerId: row.playerId,
    username: row.username,
    ki: row.ki,
    matchesPlayed: row.matchesPlayed,
  }));
}

export async function loadHeroLeaderboard(
  heroId: number,
  limit: number,
): Promise<{ heroName: string; entries: HeroLeaderboardEntry[] }> {
  await ensureHeroesExist();
  const hero = await prisma.hero.findUnique({ where: { id: heroId } });
  if (!hero) {
    throw new LeaderboardServiceError('Unknown hero.');
  }

  const rows = await prisma.playerHeroRating.findMany({
    where: { heroId, matchesPlayed: { gt: 0 } },
    include: { player: { select: { username: true } } },
  });

  return { heroName: hero.name, entries: await mapHeroRatings(rows, limit) };
}

export async function loadAllHeroLeaderboards(): Promise<HeroBoardSlice[]> {
  await ensureHeroesExist();
  const heroes = await prisma.hero.findMany({ orderBy: { id: 'asc' } });
  const slices: HeroBoardSlice[] = [];

  for (const hero of heroes) {
    const rows = await prisma.playerHeroRating.findMany({
      where: { heroId: hero.id, matchesPlayed: { gt: 0 } },
      include: { player: { select: { username: true } } },
    });
    slices.push({
      heroId: hero.id,
      heroName: hero.name,
      entries: await mapHeroRatings(rows, HERO_COMPACT_TOP),
    });
  }

  return slices;
}

export async function resolveHeroByName(
  name: string,
): Promise<{ heroId: number; heroName: string } | null> {
  await ensureHeroesExist();
  const hero = await prisma.hero.findFirst({
    where: { name: { equals: name.trim(), mode: 'insensitive' } },
  });
  return hero ? { heroId: hero.id, heroName: hero.name } : null;
}

export async function listHeroNames(): Promise<{ id: number; name: string }[]> {
  await ensureHeroesExist();
  return prisma.hero.findMany({
    orderBy: { id: 'asc' },
    select: { id: true, name: true },
  });
}
```

- [ ] **Step 6: Run all leaderboard service tests**

Run: `npm test -- src/services/leaderboard.test.ts`

Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/services/leaderboard.ts src/services/leaderboard.test.ts
git commit -m "feat: add leaderboard query service with pagination"
```

---

### Task 3: Leaderboard embed builders

**Files:**

- Create: `src/services/leaderboard-embed.ts`
- Create: `src/services/leaderboard-embed.test.ts`

**Interfaces:**

- Consumes: DTO types from `leaderboard.ts`
- Produces:

```typescript
export function formatRankPrefix(rank: number): string;
export function formatOverallTable(entries: OverallLeaderboardEntry[]): string;
export function buildOverallLeaderboardEmbed(
  page: OverallLeaderboardPage,
  options?: { live?: boolean; updatedAt?: Date },
): EmbedBuilder;
export function buildHeroLeaderboardEmbed(
  heroName: string,
  entries: HeroLeaderboardEntry[],
): EmbedBuilder;
export function buildAllHeroLeaderboardsEmbed(slices: HeroBoardSlice[]): EmbedBuilder;
export function buildLeaderboardPageButtons(input: {
  invokerId: string;
  page: number;
  totalPages: number;
}): ActionRowBuilder<ButtonBuilder>[];
export function parseLeaderboardPageCustomId(
  customId: string,
): { invokerId: string; page: number } | null;
```

- [ ] **Step 1: Write failing embed tests**

```typescript
import { describe, expect, it } from 'vitest';
import {
  buildOverallLeaderboardEmbed,
  buildHeroLeaderboardEmbed,
  buildAllHeroLeaderboardsEmbed,
  formatRankPrefix,
  parseLeaderboardPageCustomId,
} from './leaderboard-embed.js';

describe('formatRankPrefix', () => {
  it('uses medals for top 3', () => {
    expect(formatRankPrefix(1)).toBe('🥇');
    expect(formatRankPrefix(2)).toBe('🥈');
    expect(formatRankPrefix(3)).toBe('🥉');
    expect(formatRankPrefix(4)).toBe('#4');
  });
});

describe('buildOverallLeaderboardEmbed', () => {
  it('includes page line for command mode', () => {
    const embed = buildOverallLeaderboardEmbed({
      entries: [
        {
          rank: 1,
          playerId: 'p1',
          username: 'Tinys',
          ki: 4820,
          games: 42,
          discordId: null,
        },
      ],
      page: 1,
      totalPages: 1,
      totalPlayers: 1,
    });
    const data = embed.data;
    expect(data.title).toBe('Global Leaderboard');
    expect(data.color).toBe(0xf0b232);
    expect(data.description).toContain('Page 1 of 1');
    expect(data.description).toContain('Tinys');
  });

  it('omits page line for live mode', () => {
    const embed = buildOverallLeaderboardEmbed(
      { entries: [], page: 1, totalPages: 1, totalPlayers: 0 },
      { live: true, updatedAt: new Date('2026-08-14T10:00:00Z') },
    );
    expect(embed.data.description).not.toContain('Page');
    expect(embed.data.footer?.text).toContain('Updated');
  });
});

describe('parseLeaderboardPageCustomId', () => {
  it('parses valid custom id', () => {
    expect(parseLeaderboardPageCustomId('leaderboard:page:user1:2')).toEqual({
      invokerId: 'user1',
      page: 2,
    });
  });

  it('returns null for invalid id', () => {
    expect(parseLeaderboardPageCustomId('lobby:start')).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/services/leaderboard-embed.test.ts`

Expected: FAIL

- [ ] **Step 3: Implement embed builders**

Key implementation notes:

```typescript
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import type {
  HeroBoardSlice,
  HeroLeaderboardEntry,
  OverallLeaderboardEntry,
  OverallLeaderboardPage,
} from './leaderboard.js';

const RANK_GOLD = 0xf0b232;

export function formatRankPrefix(rank: number): string {
  if (rank === 1) return '🥇';
  if (rank === 2) return '🥈';
  if (rank === 3) return '🥉';
  return `#${rank}`;
}

export function formatOverallTable(entries: OverallLeaderboardEntry[]): string {
  if (entries.length === 0) {
    return '_No ranked players yet._';
  }

  const nameWidth = Math.max(...entries.map((e) => e.username.length), 'Player'.length);
  const kiWidth = Math.max(...entries.map((e) => String(e.ki).length), 'Ki'.length);
  const header = `${'#'.padEnd(3)} ${'Player'.padEnd(nameWidth)}  ${'Ki'.padStart(kiWidth)}  G`;
  const lines = entries.map((entry) => {
    const prefix = formatRankPrefix(entry.rank).padEnd(3);
    const name = entry.username.padEnd(nameWidth, ' ');
    const ki = String(entry.ki).padStart(kiWidth, ' ');
    return `${prefix} ${name}  ${ki}  ${entry.games}`;
  });
  return `\`\`\`\n${header}\n${lines.join('\n')}\n\`\`\``;
}

export function buildOverallLeaderboardEmbed(
  page: OverallLeaderboardPage,
  options?: { live?: boolean; updatedAt?: Date },
): EmbedBuilder {
  const embed = new EmbedBuilder().setColor(RANK_GOLD).setTitle('Global Leaderboard');

  if (options?.live) {
    embed.setDescription(formatOverallTable(page.entries));
    if (options.updatedAt) {
      const unix = Math.floor(options.updatedAt.getTime() / 1000);
      embed.setFooter({ text: `Updated <t:${unix}:R>` });
    }
  } else {
    embed.setDescription(
      `Page ${page.page} of ${page.totalPages} · ${page.totalPlayers} players\n\n${formatOverallTable(page.entries)}`,
    );
    if (page.totalPages > 1) {
      embed.setFooter({
        text: 'Use /leaderboard show page:N to jump · Only you can use the buttons',
      });
    }
  }

  return embed;
}

export function buildLeaderboardPageCustomId(invokerId: string, page: number): string {
  return `leaderboard:page:${invokerId}:${page}`;
}

export function parseLeaderboardPageCustomId(
  customId: string,
): { invokerId: string; page: number } | null {
  const parts = customId.split(':');
  if (parts.length !== 4 || parts[0] !== 'leaderboard' || parts[1] !== 'page') {
    return null;
  }
  const page = Number.parseInt(parts[3]!, 10);
  if (!Number.isFinite(page) || page < 1) {
    return null;
  }
  return { invokerId: parts[2]!, page };
}

export function buildLeaderboardPageButtons(input: {
  invokerId: string;
  page: number;
  totalPages: number;
}): ActionRowBuilder<ButtonBuilder>[] {
  if (input.totalPages <= 1) {
    return [];
  }

  const prevPage = Math.max(1, input.page - 1);
  const nextPage = Math.min(input.totalPages, input.page + 1);

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(buildLeaderboardPageCustomId(input.invokerId, prevPage))
      .setLabel('Previous')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(input.page <= 1),
    new ButtonBuilder()
      .setCustomId(buildLeaderboardPageCustomId(input.invokerId, nextPage))
      .setLabel('Next')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(input.page >= input.totalPages),
  );

  return [row];
}
```

Implement `buildHeroLeaderboardEmbed` and `buildAllHeroLeaderboardsEmbed` similarly — hero single uses same table style; all-heroes uses one embed field per hero (inline where possible, max 25 fields — 12 heroes fits).

- [ ] **Step 4: Run embed tests**

Run: `npm test -- src/services/leaderboard-embed.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/leaderboard-embed.ts src/services/leaderboard-embed.test.ts
git commit -m "feat: add leaderboard embed and pagination button builders"
```

---

### Task 4: Live channel service (setup, refresh, scheduler)

**Files:**

- Create: `src/services/leaderboard-channel.ts`
- Create: `src/services/leaderboard-channel.test.ts`

**Interfaces:**

- Consumes: `loadOverallLeaderboardTop`, `LIVE_LEADERBOARD_SIZE`, guild-config setters, embed builder
- Produces:

```typescript
export function scheduleLeaderboardRefresh(client: Client): void;
export function stopLeaderboardRefreshScheduler(): void;
export async function setupLiveLeaderboard(
  client: Client,
  guildId: string,
  channelId: string,
): Promise<{ messageId: string }>;
export async function clearLiveLeaderboard(client: Client, guildId: string): Promise<void>;
export async function refreshGuildLeaderboard(client: Client, guildId: string): Promise<void>;
export async function refreshAllLeaderboardChannels(client: Client): Promise<void>;
```

- [ ] **Step 1: Write failing test for refresh skip logic**

Mock prisma + discord client minimally:

```typescript
import { describe, expect, it, vi } from 'vitest';

const { findUnique, findMany, upsert } = vi.hoisted(() => ({
  findUnique: vi.fn(),
  findMany: vi.fn(),
  upsert: vi.fn(),
}));

vi.mock('../lib/prisma.js', () => ({
  prisma: { guildConfig: { findUnique, findMany, upsert } },
}));

vi.mock('./leaderboard.js', () => ({
  loadOverallLeaderboardTop: vi.fn().mockResolvedValue([]),
  LIVE_LEADERBOARD_SIZE: 10,
}));

import { refreshGuildLeaderboard } from './leaderboard-channel.js';

describe('refreshGuildLeaderboard', () => {
  it('skips when config is incomplete', async () => {
    findUnique.mockResolvedValue({ guildId: 'g1', leaderboardChannelId: null });
    const client = { channels: { fetch: vi.fn() } } as never;
    await refreshGuildLeaderboard(client, 'g1');
    expect(client.channels.fetch).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/services/leaderboard-channel.test.ts`

Expected: FAIL

- [ ] **Step 3: Implement leaderboard-channel service**

```typescript
import type { Client, TextChannel } from 'discord.js';
import { createLogger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { clearLeaderboardChannel, setLeaderboardChannel } from './guild-config.js';
import { LIVE_LEADERBOARD_SIZE, loadOverallLeaderboardTop } from './leaderboard.js';
import { buildOverallLeaderboardEmbed } from './leaderboard-embed.js';

const log = createLogger('leaderboard_channel');
const REFRESH_INTERVAL_MS = 15 * 60 * 1000;

let intervalHandle: ReturnType<typeof setInterval> | undefined;

export async function setupLiveLeaderboard(
  client: Client,
  guildId: string,
  channelId: string,
): Promise<{ messageId: string }> {
  const existing = await prisma.guildConfig.findUnique({ where: { guildId } });
  if (existing?.leaderboardMessageId && existing.leaderboardChannelId) {
    await deleteMessageBestEffort(
      client,
      existing.leaderboardChannelId,
      existing.leaderboardMessageId,
    );
  }

  const entries = await loadOverallLeaderboardTop(LIVE_LEADERBOARD_SIZE);
  const embed = buildOverallLeaderboardEmbed(
    {
      entries,
      page: 1,
      totalPages: 1,
      totalPlayers: entries.length,
    },
    { live: true, updatedAt: new Date() },
  );

  const channel = await fetchTextChannel(client, channelId);
  const message = await channel.send({ embeds: [embed] });
  await setLeaderboardChannel(guildId, channelId, message.id);
  return { messageId: message.id };
}

export async function clearLiveLeaderboard(client: Client, guildId: string): Promise<void> {
  const row = await prisma.guildConfig.findUnique({ where: { guildId } });
  if (row?.leaderboardChannelId && row.leaderboardMessageId) {
    await deleteMessageBestEffort(client, row.leaderboardChannelId, row.leaderboardMessageId);
  }
  await clearLeaderboardChannel(guildId);
}

export async function refreshGuildLeaderboard(client: Client, guildId: string): Promise<void> {
  const row = await prisma.guildConfig.findUnique({ where: { guildId } });
  if (!row?.leaderboardChannelId || !row.leaderboardMessageId) {
    return;
  }

  const entries = await loadOverallLeaderboardTop(LIVE_LEADERBOARD_SIZE);
  const embed = buildOverallLeaderboardEmbed(
    {
      entries,
      page: 1,
      totalPages: 1,
      totalPlayers: entries.length,
    },
    { live: true, updatedAt: new Date() },
  );

  try {
    const channel = await fetchTextChannel(client, row.leaderboardChannelId);
    await channel.messages.edit(row.leaderboardMessageId, { embeds: [embed] });
  } catch (error) {
    log.warn({ err: error, guildId }, 'Leaderboard edit failed; reposting');
    try {
      const channel = await fetchTextChannel(client, row.leaderboardChannelId);
      const message = await channel.send({ embeds: [embed] });
      await setLeaderboardChannel(guildId, row.leaderboardChannelId, message.id);
    } catch (repostError) {
      log.warn({ err: repostError, guildId }, 'Leaderboard repost failed');
    }
  }
}

export async function refreshAllLeaderboardChannels(client: Client): Promise<void> {
  const rows = await prisma.guildConfig.findMany({
    where: {
      leaderboardChannelId: { not: null },
      leaderboardMessageId: { not: null },
    },
    select: { guildId: true },
  });

  for (const row of rows) {
    await refreshGuildLeaderboard(client, row.guildId);
  }
}

export function scheduleLeaderboardRefresh(client: Client): void {
  if (intervalHandle) {
    return;
  }
  intervalHandle = setInterval(() => {
    void refreshAllLeaderboardChannels(client).catch((error) => {
      log.warn({ err: error }, 'Scheduled leaderboard refresh failed');
    });
  }, REFRESH_INTERVAL_MS);
}

export function stopLeaderboardRefreshScheduler(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = undefined;
  }
}
```

Add small helpers `fetchTextChannel` and `deleteMessageBestEffort` in the same file.

Wire shutdown in `src/index.ts` `shutdown()` — call `stopLeaderboardRefreshScheduler()` alongside `stopMatchCleanupScheduler()`.

- [ ] **Step 4: Run tests**

Run: `npm test -- src/services/leaderboard-channel.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/leaderboard-channel.ts src/services/leaderboard-channel.test.ts src/index.ts
git commit -m "feat: add live leaderboard channel setup and refresh"
```

---

### Task 5: Slash commands (`/leaderboard` + `/config` extensions)

**Files:**

- Create: `src/commands/player/leaderboard.ts`
- Modify: `src/commands/config/config.ts`

**Interfaces:**

- Consumes: all leaderboard + guild-config + channel services

- [ ] **Step 1: Create `/leaderboard` command**

```typescript
import {
  MessageFlags,
  SlashCommandBuilder,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { assertCanConfigureBot } from '../../services/guild-config.js';
import {
  HERO_SINGLE_TOP,
  LeaderboardServiceError,
  loadAllHeroLeaderboards,
  loadHeroLeaderboard,
  loadOverallLeaderboardPage,
  resolveHeroByName,
  listHeroNames,
} from '../../services/leaderboard.js';
import {
  buildAllHeroLeaderboardsEmbed,
  buildHeroLeaderboardEmbed,
  buildOverallLeaderboardEmbed,
  buildLeaderboardPageButtons,
} from '../../services/leaderboard-embed.js';
import { setupLiveLeaderboard } from '../../services/leaderboard-channel.js';

export const data = new SlashCommandBuilder()
  .setName('leaderboard')
  .setDescription('View global and hero leaderboards')
  .addSubcommand((sub) =>
    sub
      .setName('show')
      .setDescription('Show overall or hero leaderboards')
      .addStringOption((opt) =>
        opt
          .setName('type')
          .setDescription('Leaderboard type')
          .setRequired(false)
          .addChoices({ name: 'Overall', value: 'overall' }, { name: 'Hero', value: 'hero' }),
      )
      .addStringOption((opt) =>
        opt
          .setName('hero')
          .setDescription('Hero name (top 10); omit for all heroes')
          .setRequired(false)
          .setAutocomplete(true),
      )
      .addIntegerOption((opt) =>
        opt
          .setName('page')
          .setDescription('Page number (overall only)')
          .setRequired(false)
          .setMinValue(1),
      ),
  )
  .addSubcommand((sub) =>
    sub.setName('setup').setDescription('Post a live overall top-10 message in this channel'),
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const sub = interaction.options.getSubcommand(true);

  if (sub === 'setup') {
    await handleSetup(interaction);
    return;
  }

  await interaction.deferReply();
  await handleShow(interaction);
}

export async function autocomplete(interaction: AutocompleteInteraction) {
  const focused = interaction.options.getFocused(true);
  if (focused.name !== 'hero') {
    await interaction.respond([]);
    return;
  }

  const heroes = await listHeroNames();
  const query = focused.value.toLowerCase();
  const choices = heroes
    .filter((hero) => hero.name.toLowerCase().includes(query))
    .slice(0, 25)
    .map((hero) => ({ name: hero.name, value: hero.name }));

  await interaction.respond(choices);
}
```

Implement `handleShow`:

- `type === 'overall'` (default): `loadOverallLeaderboardPage(page ?? 1)` → embed + buttons with `invokerId: interaction.user.id`
- `type === 'hero'` + no hero: `loadAllHeroLeaderboards()` → `buildAllHeroLeaderboardsEmbed`
- `type === 'hero'` + hero: `resolveHeroByName` → if null `Unknown hero.` → else `loadHeroLeaderboard(heroId, HERO_SINGLE_TOP)`

Implement `handleSetup`:

- Require `interaction.guildId` and channel
- `assertCanConfigureBot` (reuse member permission helper from config.ts — extract shared `memberPermissions(interaction)` to a tiny util or duplicate minimally)
- `setupLiveLeaderboard(client, guildId, channelId)`
- Ephemeral: `Live overall leaderboard set in this channel. Keep only this message here.`

**Note:** If the project’s command loader does not register `autocomplete`, extend `src/types/command.ts` and `interaction-create.ts` to call `command.autocomplete` when present (mirror discord.js pattern).

- [ ] **Step 2: Extend `/config`**

Add to `config.ts`:

- `set leaderboard_channel` with channel option → calls `setupLiveLeaderboard(interaction.client, guildId, channel.id)`
- `clear leaderboard_channel` → `clearLiveLeaderboard`
- Extend `view` output:

```typescript
formatLeaderboardLine(resolved.leaderboardChannelId, resolved.leaderboardMessageId);
// **Live leaderboard:** <#channelId> · message `msgId` — or `unset`
```

- [ ] **Step 3: Manual smoke**

Run: `npm run dev`

In Discord:

1. `/leaderboard show` → overall page 1
2. `/leaderboard show type:hero` → 12 hero fields
3. `/leaderboard setup` in a test channel → message appears

- [ ] **Step 4: Commit**

```bash
git add src/commands/player/leaderboard.ts src/commands/config/config.ts src/types/command.ts src/events/interaction-create.ts
git commit -m "feat: add leaderboard slash commands and config channel management"
```

---

### Task 6: Pagination button handler

**Files:**

- Create: `src/handlers/leaderboard-interactions.ts`
- Modify: `src/events/interaction-create.ts`

- [ ] **Step 1: Implement handler**

```typescript
import { MessageFlags, type Interaction } from 'discord.js';
import { loadOverallLeaderboardPage } from '../services/leaderboard.js';
import {
  buildLeaderboardPageButtons,
  buildOverallLeaderboardEmbed,
  parseLeaderboardPageCustomId,
} from '../services/leaderboard-embed.js';

const NOT_YOUR_PAGE = 'Only the person who ran /leaderboard can change pages.';

export async function handleLeaderboardInteraction(interaction: Interaction): Promise<boolean> {
  if (!interaction.isButton()) {
    return false;
  }
  if (!interaction.customId.startsWith('leaderboard:')) {
    return false;
  }

  const parsed = parseLeaderboardPageCustomId(interaction.customId);
  if (!parsed) {
    return true;
  }

  if (interaction.user.id !== parsed.invokerId) {
    await interaction.reply({ content: NOT_YOUR_PAGE, flags: MessageFlags.Ephemeral });
    return true;
  }

  const pageData = await loadOverallLeaderboardPage(parsed.page);
  const embed = buildOverallLeaderboardEmbed(pageData);
  const components = buildLeaderboardPageButtons({
    invokerId: parsed.invokerId,
    page: pageData.page,
    totalPages: pageData.totalPages,
  });

  await interaction.update({ embeds: [embed], components });
  return true;
}
```

- [ ] **Step 2: Wire in interaction-create**

Before match/lobby handlers (or after — order only matters if prefixes collide):

```typescript
import { handleLeaderboardInteraction } from '../handlers/leaderboard-interactions.js';

// inside execute(), in the try block before match handler:
if (await handleLeaderboardInteraction(interaction)) {
  return;
}
```

- [ ] **Step 3: Commit**

```bash
git add src/handlers/leaderboard-interactions.ts src/events/interaction-create.ts
git commit -m "feat: add invoker-only leaderboard pagination buttons"
```

---

### Task 7: Refresh hooks (match complete + bot ready)

**Files:**

- Modify: `src/events/ready.ts`
- Modify: `src/handlers/match-interactions.ts`
- Modify: `src/commands/match/match.ts`

- [ ] **Step 1: Ready event**

In `src/events/ready.ts`:

```typescript
import {
  refreshAllLeaderboardChannels,
  scheduleLeaderboardRefresh,
} from '../services/leaderboard-channel.js';

export async function execute(client: Client<true>): Promise<void> {
  log.info({ tag: client.user.tag, userId: client.user.id }, 'Bot online');
  startMatchCleanupScheduler(client);

  void refreshAllLeaderboardChannels(client).catch((error) => {
    log.warn({ err: error }, 'Initial leaderboard refresh failed');
  });
  scheduleLeaderboardRefresh(client);
}
```

- [ ] **Step 2: After match completion (both paths)**

In `src/handlers/match-interactions.ts` after successful `completeMatch`:

```typescript
import { refreshAllLeaderboardChannels } from '../services/leaderboard-channel.js';

// after completeMatch resolves:
void refreshAllLeaderboardChannels(interaction.client).catch(() => undefined);
```

Same one-liner in `src/commands/match/match.ts` after slash `completeMatch`.

- [ ] **Step 3: Run full test suite**

Run: `npm test`

Expected: all PASS

- [ ] **Step 4: Commit**

```bash
git add src/events/ready.ts src/handlers/match-interactions.ts src/commands/match/match.ts
git commit -m "feat: refresh live leaderboards on match complete and on schedule"
```

---

## Spec coverage checklist

| Spec requirement                        | Task                    |
| --------------------------------------- | ----------------------- |
| `/leaderboard show` overall paginated   | Task 2, 3, 5, 6         |
| `/leaderboard show` hero all + single   | Task 2, 3, 5            |
| `/leaderboard setup`                    | Task 4, 5               |
| `/config set/clear leaderboard_channel` | Task 1, 4, 5            |
| Live overall top 10 only                | Task 4                  |
| Refresh: complete + start + 15 min      | Task 4, 7               |
| Invoker-only pagination                 | Task 6                  |
| ≥1 game overall eligibility             | Task 2                  |
| Hero matchesPlayed > 0                  | Task 2                  |
| Gold embeds + medals                    | Task 3                  |
| English error copy                      | Tasks 2, 5, 6           |
| Tech debt: live hero channel            | Documented in spec only |
| Prisma GuildConfig fields               | Task 1                  |

## Manual test plan

1. Seed veterans: `npm run seed:veterans`
2. `/leaderboard show` — page 1 with ≥1 player
3. `/leaderboard show page:2` — jumps when enough players
4. Click Next/Prev — works for invoker; second user gets ephemeral error
5. `/leaderboard show type:hero` — 12 fields
6. `/leaderboard show type:hero hero:Goku` — top 10 (or empty copy)
7. `/leaderboard setup` — posts live message; `/config view` shows IDs
8. Complete a match — live message updates within seconds
9. Restart bot — live message still refreshes on ready
10. `/config clear leaderboard_channel` — config cleared, message deleted
