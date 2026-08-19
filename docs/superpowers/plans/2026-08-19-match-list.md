# Match List Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Anyone in a guild can paginate all completed matches for the resolved league via `/match list`, then open a row with existing `/match show`.

**Architecture:** Dedicated `match-list.ts` for the COMPLETED league query, compact embed, and `ml:` pagination ids. Thin `/match list` adapter in `match.ts`. Player history stays in `match-history.ts`. Buttons are invoker-only. `/match show` is unchanged.

**Tech Stack:** TypeScript ESM, Prisma, discord.js v14, Vitest

**Spec:** `docs/superpowers/specs/2026-08-19-match-list-design.md`

## Global Constraints

- Scope: `general` (league-scoped completed matches; not game-specific)
- English-only user-facing strings and errors
- `/match list` only; do **not** change `/match history` **command behavior**
- Status: **`COMPLETED` only**; newest first (`completedAt` desc, nulls last)
- Page size: **10**
- Rows: date, winner (`teamDisplayName`), format `4v6` (team-1 vs team-2 `MatchPlayer` counts), copyable match id
- Format is **team 1 vs team 2**, not winner-first; ignore any other `team` value
- Anyone may run it; **public** reply; **no `/link` required**
- Optional `page` + existing `league` option
- Prev/Next **invoker-only**; Discord `customId` max **100**; prefix `ml:p:`; compact UUID league ids
- Lobby channel: **denied** (`list` is not on the in-progress allowlist)
- ESM `.js` imports; named exports
- No schema migration; no new env/SSM keys
- Reuse `winningTeamFromPlayers` and `clampMatchHistoryPage` only — do not import history query, ki preview, or rank-reset
- Extract UUID compact/expand into `src/services/match/compact-custom-id.ts`; `match-history.ts` and `match-list.ts` both import it (do **not** duplicate the helpers)
- Branch: `feature/match-list` (create worktree at execution time if using worktrees skill)

## File map

| File | Role |
|------|------|
| `src/services/match/compact-custom-id.ts` | Shared UUID compact/expand for Discord `customId` |
| `src/services/match/compact-custom-id.test.ts` | Unit tests for compact/expand |
| `src/services/match/match-history.ts` | Import shared compact/expand (no behavior change) |
| `src/services/match/match-list.ts` | Format, customIds, page load, embed, buttons |
| `src/services/match/match-list.test.ts` | Unit tests |
| `src/services/match/index.ts` | Re-exports |
| `src/commands/match/match.ts` | `list` subcommand + public execute branch |
| `src/commands/match/match.test.ts` | Subcommand registration |
| `src/discord/interactions/match-list-interactions.ts` | Prev/Next handler |
| `src/events/interaction-create.ts` | Route `ml:p:` buttons |
| `src/services/league/league-lobby-channel.test.ts` | Assert `list` is denied |
| `docs/discord/public/07-cheat-sheet.md` | Public cheat line |

---

### Task 1: Pure helpers — shared customId compact, format, team sizes, pagination ids

**Files:**
- Create: `src/services/match/compact-custom-id.ts`
- Create: `src/services/match/compact-custom-id.test.ts`
- Modify: `src/services/match/match-history.ts` (replace private `compactHistoryId` / `expandHistoryId` with imports)
- Create: `src/services/match/match-list.ts`
- Create: `src/services/match/match-list.test.ts`

**Interfaces:**
- Consumes: nothing from later tasks
- Produces:
  - `export function compactUuidForCustomId(id: string): string`
  - `export function expandUuidFromCustomId(id: string): string`
  - `export const MATCH_LIST_PAGE_SIZE = 10`
  - `export type MatchListRow = { matchId: string; completedAt: Date; winningTeam: 1 | 2; format: string }`
  - `export function formatMatchListFormat(team1Count: number, team2Count: number): string`
  - `export function countMatchListTeamSizes(players: Array<{ team: number }>): { team1: number; team2: number }`
  - `export function formatMatchListField(row: MatchListRow, winnerLabel: string): { name: string; value: string; inline: boolean }`
  - `export function buildMatchListPageCustomId(invokerId: string, leagueId: string, direction: 'prev' | 'next', currentPage: number): string`
  - `export function parseMatchListPageCustomId(customId: string): { invokerId: string; leagueId: string; page: number } | null`

- [ ] **Step 1: Write failing tests for the shared compact helper**

Create `src/services/match/compact-custom-id.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { compactUuidForCustomId, expandUuidFromCustomId } from './compact-custom-id.js';

describe('compactUuidForCustomId / expandUuidFromCustomId', () => {
  const hyphenated = 'e5863052-d453-48db-b67a-14d1175c298b';
  const compact = 'e5863052d45348dbb67a14d1175c298b';

  it('strips hyphens from a UUID and restores them', () => {
    expect(compactUuidForCustomId(hyphenated)).toBe(compact);
    expect(expandUuidFromCustomId(compact)).toBe(hyphenated);
  });

  it('leaves cuid and other non-UUID ids unchanged', () => {
    expect(compactUuidForCustomId('clleagueidxxxxxxxxxxxx')).toBe('clleagueidxxxxxxxxxxxx');
    expect(expandUuidFromCustomId('clleagueidxxxxxxxxxxxx')).toBe('clleagueidxxxxxxxxxxxx');
  });
});
```

- [ ] **Step 2: Run compact tests to verify they fail**

Run: `npx vitest run src/services/match/compact-custom-id.test.ts`

Expected: FAIL — cannot find module `./compact-custom-id.js`

- [ ] **Step 3: Implement the shared helper and switch history to it**

Create `src/services/match/compact-custom-id.ts`:

```typescript
const UUID_HYPHENATED =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_COMPACT = /^[0-9a-f]{32}$/i;

/** Strip UUID hyphens so ids + snowflake fit Discord's 100-char customId. */
export function compactUuidForCustomId(id: string): string {
  return UUID_HYPHENATED.test(id) ? id.replace(/-/g, '') : id;
}

/** Restore hyphenated UUID form for Prisma lookups. */
export function expandUuidFromCustomId(id: string): string {
  if (!UUID_COMPACT.test(id)) {
    return id;
  }
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}
```

In `src/services/match/match-history.ts`, delete the private `UUID_HYPHENATED`, `UUID_COMPACT`, `compactHistoryId`, and `expandHistoryId` block. Import and use the shared functions:

```typescript
import { compactUuidForCustomId, expandUuidFromCustomId } from './compact-custom-id.js';
```

Replace `compactHistoryId(...)` with `compactUuidForCustomId(...)` and `expandHistoryId(...)` with `expandUuidFromCustomId(...)`.

Run: `npx vitest run src/services/match/compact-custom-id.test.ts src/services/match/match-history.test.ts`

Expected: PASS (history customId tests still round-trip)

- [ ] **Step 4: Write failing tests for list format and pagination ids**

```typescript
import { describe, expect, it } from 'vitest';
import {
  buildMatchListPageCustomId,
  countMatchListTeamSizes,
  formatMatchListField,
  formatMatchListFormat,
  parseMatchListPageCustomId,
} from './match-list.js';

describe('formatMatchListFormat', () => {
  it('prints team-1 vs team-2 counts', () => {
    expect(formatMatchListFormat(4, 6)).toBe('4v6');
    expect(formatMatchListFormat(6, 6)).toBe('6v6');
  });
});

describe('countMatchListTeamSizes', () => {
  it('counts team 1 and 2 and ignores other teams', () => {
    expect(
      countMatchListTeamSizes([
        { team: 1 },
        { team: 1 },
        { team: 1 },
        { team: 1 },
        { team: 2 },
        { team: 2 },
        { team: 2 },
        { team: 2 },
        { team: 2 },
        { team: 2 },
        { team: 3 },
      ]),
    ).toEqual({ team1: 4, team2: 6 });
  });
});

describe('formatMatchListField', () => {
  it('puts winner and format in the name; date and id in the value', () => {
    const field = formatMatchListField(
      {
        matchId: 'clxxxxxxxxxxxxxxxxxxxx',
        completedAt: new Date('2026-08-16T12:00:00.000Z'),
        winningTeam: 1,
        format: '4v6',
      },
      'Z Fighters',
    );

    expect(field.inline).toBe(false);
    expect(field.name).toBe('Z Fighters · 4v6');
    expect(field.value).toBe('<t:1786881600:D>\n`clxxxxxxxxxxxxxxxxxxxx`');
  });
});

describe('match list page custom ids', () => {
  it('round-trips prev/next and stays under 100 chars', () => {
    const invokerId = '123456789012345678';
    const leagueId = 'clleagueidxxxxxxxxxxxx';
    const next = buildMatchListPageCustomId(invokerId, leagueId, 'next', 2);
    expect(next.length).toBeLessThanOrEqual(100);
    expect(next.startsWith('ml:p:')).toBe(true);
    expect(parseMatchListPageCustomId(next)).toEqual({
      invokerId,
      leagueId,
      page: 3,
    });
    const prev = buildMatchListPageCustomId(invokerId, leagueId, 'prev', 2);
    expect(parseMatchListPageCustomId(prev)).toEqual({
      invokerId,
      leagueId,
      page: 1,
    });
  });

  it('stays under 100 chars for 19-digit snowflake + UUID league + large page', () => {
    const invokerId = '1234567890123456789';
    const leagueId = 'e5863052-d453-48db-b67a-14d1175c298b';
    const next = buildMatchListPageCustomId(invokerId, leagueId, 'next', 999999);
    const prev = buildMatchListPageCustomId(invokerId, leagueId, 'prev', 999999);
    expect(next.length).toBeLessThanOrEqual(100);
    expect(prev.length).toBeLessThanOrEqual(100);
    expect(parseMatchListPageCustomId(next)).toEqual({
      invokerId,
      leagueId,
      page: 1000000,
    });
    expect(parseMatchListPageCustomId(prev)).toEqual({
      invokerId,
      leagueId,
      page: 999998,
    });
  });

  it('does not collide with history prefix', () => {
    const id = buildMatchListPageCustomId('1', 'L1', 'next', 1);
    expect(id.startsWith('mh:')).toBe(false);
    expect(parseMatchListPageCustomId('mh:p:1:L1:n:1')).toBeNull();
  });

  it('returns null for garbage', () => {
    expect(parseMatchListPageCustomId('leaderboard:page:x')).toBeNull();
  });
});
```

- [ ] **Step 5: Run list tests to verify they fail**

Run: `npx vitest run src/services/match/match-list.test.ts`

Expected: FAIL — cannot find module `./match-list.js` (or named exports missing)

- [ ] **Step 6: Write minimal list implementation using the shared helper**

Create `src/services/match/match-list.ts`:

```typescript
import { compactUuidForCustomId, expandUuidFromCustomId } from './compact-custom-id.js';

export const MATCH_LIST_PAGE_SIZE = 10;

export type MatchListRow = {
  matchId: string;
  completedAt: Date;
  winningTeam: 1 | 2;
  format: string;
};

/** Team-1 vs team-2 human counts, e.g. `4v6`. */
export function formatMatchListFormat(team1Count: number, team2Count: number): string {
  return `${team1Count}v${team2Count}`;
}

/** Count MatchPlayer rows on team 1 and 2. Ignore any other team value. */
export function countMatchListTeamSizes(
  players: Array<{ team: number }>,
): { team1: number; team2: number } {
  let team1 = 0;
  let team2 = 0;
  for (const player of players) {
    if (player.team === 1) team1 += 1;
    else if (player.team === 2) team2 += 1;
  }
  return { team1, team2 };
}

/** One Discord embed field per match: winner + format / date + copyable id. */
export function formatMatchListField(
  row: MatchListRow,
  winnerLabel: string,
): { name: string; value: string; inline: boolean } {
  const unix = Math.floor(row.completedAt.getTime() / 1000);
  return {
    name: `${winnerLabel} · ${row.format}`,
    value: `<t:${unix}:D>\n\`${row.matchId}\``,
    inline: false,
  };
}

export function buildMatchListPageCustomId(
  invokerId: string,
  leagueId: string,
  direction: 'prev' | 'next',
  currentPage: number,
): string {
  const dirToken = direction === 'prev' ? 'p' : 'n';
  return `ml:p:${invokerId}:${compactUuidForCustomId(leagueId)}:${dirToken}:${currentPage}`;
}

export function parseMatchListPageCustomId(
  customId: string,
): { invokerId: string; leagueId: string; page: number } | null {
  const parts = customId.split(':');
  // ml:p:invoker:league:dir:page → 6 parts
  if (parts.length !== 6 || parts[0] !== 'ml' || parts[1] !== 'p') {
    return null;
  }
  const direction = parts[4];
  const currentPage = Number.parseInt(parts[5]!, 10);
  if (!Number.isFinite(currentPage) || currentPage < 1) {
    return null;
  }
  const invokerId = parts[2]!;
  const leagueId = expandUuidFromCustomId(parts[3]!);
  if (!invokerId || !leagueId) {
    return null;
  }
  if (direction === 'prev' || direction === 'p') {
    return { invokerId, leagueId, page: currentPage - 1 };
  }
  if (direction === 'next' || direction === 'n') {
    return { invokerId, leagueId, page: currentPage + 1 };
  }
  return null;
}
```

Do **not** copy the UUID regex or compact/expand functions into `match-list.ts`.

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run src/services/match/compact-custom-id.test.ts src/services/match/match-list.test.ts src/services/match/match-history.test.ts`

Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/services/match/compact-custom-id.ts src/services/match/compact-custom-id.test.ts src/services/match/match-history.ts src/services/match/match-list.ts src/services/match/match-list.test.ts
git commit -m "$(cat <<'EOF'
feat(match): add match list format and shared customId helpers

Share UUID compact/expand so history and league-list pagination ids stay under Discord's 100-char button limit.
EOF
)"
```

---

### Task 2: Load page, embed, and buttons

**Files:**
- Modify: `src/services/match/match-list.ts`
- Modify: `src/services/match/match-list.test.ts`
- Modify: `src/services/match/index.ts`

**Interfaces:**
- Consumes: Task 1 helpers; `clampMatchHistoryPage` and `winningTeamFromPlayers` from `./match-history.js`; `getLeagueById` from `../league/league.js`; `MatchServiceError` from `./match-service.js`
- Produces:
  - `export type MatchListPage = { leagueName: string; page: number; totalPages: number; totalMatches: number; rows: MatchListRow[] }`
  - `export async function loadMatchListPage(input: { leagueId: string; page: number }): Promise<MatchListPage>`
  - `export function buildMatchListEmbed(page: MatchListPage, teamLabelFor: (team: 1 | 2) => string): EmbedBuilder`
  - `export function buildMatchListPageButtons(input: { invokerId: string; leagueId: string; page: number; totalPages: number }): ActionRowBuilder<ButtonBuilder>[]`

- [ ] **Step 1: Write failing tests**

Add mocks and cases to `src/services/match/match-list.test.ts`. Put the hoisted mocks **above** the existing imports (Vitest hoists `vi.mock`; keep one import of the module under test):

Replace the top of the test file with:

```typescript
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { matchFindMany, matchCount, getLeagueById } = vi.hoisted(() => ({
  matchFindMany: vi.fn(),
  matchCount: vi.fn(),
  getLeagueById: vi.fn(),
}));

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    match: {
      findMany: matchFindMany,
      count: matchCount,
    },
  },
}));

vi.mock('../league/league.js', () => ({
  getLeagueById,
}));

vi.mock('./match-service.js', () => {
  class MatchServiceError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'MatchServiceError';
    }
  }
  return { MatchServiceError };
});

import {
  buildMatchListEmbed,
  buildMatchListPageButtons,
  buildMatchListPageCustomId,
  countMatchListTeamSizes,
  formatMatchListField,
  formatMatchListFormat,
  loadMatchListPage,
  parseMatchListPageCustomId,
} from './match-list.js';
import { MatchServiceError } from './match-service.js';
```

Keep the Task 1 `describe` blocks. Append:

```typescript
describe('loadMatchListPage', () => {
  beforeEach(() => {
    matchFindMany.mockReset();
    matchCount.mockReset();
    getLeagueById.mockReset();
    getLeagueById.mockResolvedValue({ id: 'L1', name: 'UDBR' });
  });

  it('returns empty page 1 when no matches', async () => {
    matchCount.mockResolvedValue(0);
    matchFindMany.mockResolvedValue([]);
    const page = await loadMatchListPage({ leagueId: 'L1', page: 1 });
    expect(page.totalMatches).toBe(0);
    expect(page.totalPages).toBe(1);
    expect(page.rows).toEqual([]);
    expect(page.page).toBe(1);
    expect(page.leagueName).toBe('UDBR');
  });

  it('clamps page and maps winner plus 4v6 format', async () => {
    matchCount.mockResolvedValue(11);
    matchFindMany.mockResolvedValue([
      {
        id: 'm2',
        leagueId: 'L1',
        completedAt: new Date('2026-08-10T00:00:00.000Z'),
        createdAt: new Date('2026-08-09T00:00:00.000Z'),
        players: [
          { team: 1, result: 'LOSS' },
          { team: 1, result: 'LOSS' },
          { team: 1, result: 'LOSS' },
          { team: 1, result: 'LOSS' },
          { team: 2, result: 'WIN' },
          { team: 2, result: 'WIN' },
          { team: 2, result: 'WIN' },
          { team: 2, result: 'WIN' },
          { team: 2, result: 'WIN' },
          { team: 2, result: 'WIN' },
        ],
      },
    ]);
    const page = await loadMatchListPage({ leagueId: 'L1', page: 99 });
    expect(page.page).toBe(2);
    expect(page.totalPages).toBe(2);
    expect(page.rows).toEqual([
      {
        matchId: 'm2',
        completedAt: new Date('2026-08-10T00:00:00.000Z'),
        winningTeam: 2,
        format: '4v6',
      },
    ]);
    expect(matchFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { leagueId: 'L1', status: 'COMPLETED' },
        skip: 10,
        take: 10,
      }),
    );
  });

  it('throws when the league is missing', async () => {
    getLeagueById.mockResolvedValue(null);
    matchCount.mockResolvedValue(0);
    matchFindMany.mockResolvedValue([]);
    await expect(loadMatchListPage({ leagueId: 'missing', page: 1 })).rejects.toThrow(
      MatchServiceError,
    );
  });
});

describe('buildMatchListEmbed', () => {
  it('shows empty copy as a field', () => {
    const embed = buildMatchListEmbed(
      {
        leagueName: 'UDBR',
        page: 1,
        totalPages: 1,
        totalMatches: 0,
        rows: [],
      },
      (team) => (team === 1 ? 'Z Fighters' : 'Evil'),
    );
    expect(embed.data.author?.name).toBe('UDBR');
    expect(embed.data.title).toBe('Match list');
    expect(embed.data.description).toContain('Page **1** of **1**');
    expect(embed.data.fields?.[0]?.value).toMatch(/No completed matches yet/i);
  });

  it('adds one embed field per match', () => {
    const embed = buildMatchListEmbed(
      {
        leagueName: 'UDBR',
        page: 1,
        totalPages: 1,
        totalMatches: 1,
        rows: [
          {
            matchId: 'mid1',
            completedAt: new Date('2026-08-16T12:00:00.000Z'),
            winningTeam: 1,
            format: '6v6',
          },
        ],
      },
      (team) => (team === 1 ? 'Z Fighters' : 'Evil'),
    );
    expect(embed.data.fields).toHaveLength(1);
    expect(embed.data.fields?.[0]?.name).toBe('Z Fighters · 6v6');
    expect(embed.data.fields?.[0]?.value).toContain('`mid1`');
    expect(embed.data.footer?.text).toMatch(/match show/i);
  });
});

describe('buildMatchListPageButtons', () => {
  it('returns no row when single page', () => {
    expect(
      buildMatchListPageButtons({
        invokerId: '1',
        leagueId: 'L',
        page: 1,
        totalPages: 1,
      }),
    ).toEqual([]);
  });

  it('encodes ml:p custom ids when there are multiple pages', () => {
    const rows = buildMatchListPageButtons({
      invokerId: '123',
      leagueId: 'L1',
      page: 2,
      totalPages: 3,
    });
    expect(rows).toHaveLength(1);
    const ids = rows[0]!.toJSON().components.map((button) => button.custom_id);
    expect(ids[0]).toBe(buildMatchListPageCustomId('123', 'L1', 'prev', 2));
    expect(ids[1]).toBe(buildMatchListPageCustomId('123', 'L1', 'next', 2));
  });
});
```

- [ ] **Step 2: Run tests to verify new cases fail**

Run: `npx vitest run src/services/match/match-list.test.ts`

Expected: FAIL — `loadMatchListPage` / `buildMatchListEmbed` / `buildMatchListPageButtons` are not exported

- [ ] **Step 3: Append load/embed/button implementation**

Add these imports at the top of `src/services/match/match-list.ts`:

```typescript
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from 'discord.js';
import { prisma } from '../../lib/prisma.js';
import { getLeagueById } from '../league/league.js';
import { clampMatchHistoryPage, winningTeamFromPlayers } from './match-history.js';
import { MatchServiceError } from './match-service.js';
```

Append after the parse helper:

```typescript
export type MatchListPage = {
  leagueName: string;
  page: number;
  totalPages: number;
  totalMatches: number;
  rows: MatchListRow[];
};

export async function loadMatchListPage(input: {
  leagueId: string;
  page: number;
}): Promise<MatchListPage> {
  const league = await getLeagueById(input.leagueId);
  if (!league) {
    throw new MatchServiceError('This league was not found.');
  }

  const where = {
    leagueId: input.leagueId,
    status: 'COMPLETED' as const,
  };

  const totalMatches = await prisma.match.count({ where });
  const totalPages = Math.max(1, Math.ceil(totalMatches / MATCH_LIST_PAGE_SIZE));
  const page = clampMatchHistoryPage(input.page, totalPages);
  const skip = (page - 1) * MATCH_LIST_PAGE_SIZE;

  const matches = await prisma.match.findMany({
    where,
    orderBy: [{ completedAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
    skip,
    take: MATCH_LIST_PAGE_SIZE,
    include: {
      players: {
        select: { team: true, result: true },
      },
    },
  });

  const rows: MatchListRow[] = matches.map((match) => {
    const sizes = countMatchListTeamSizes(match.players);
    return {
      matchId: match.id,
      completedAt: match.completedAt ?? match.createdAt,
      winningTeam: winningTeamFromPlayers(match.players),
      format: formatMatchListFormat(sizes.team1, sizes.team2),
    };
  });

  return {
    leagueName: league.name,
    page,
    totalPages,
    totalMatches,
    rows,
  };
}

export function buildMatchListEmbed(
  page: MatchListPage,
  teamLabelFor: (team: 1 | 2) => string,
): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(0xf0b232)
    .setAuthor({ name: page.leagueName })
    .setTitle('Match list')
    .setDescription(`Page **${page.page}** of **${page.totalPages}** · ${page.totalMatches} matches`);

  if (page.rows.length === 0) {
    embed.addFields({
      name: 'Matches',
      value: '_No completed matches yet._',
    });
  } else {
    embed.addFields(
      ...page.rows.map((row) => formatMatchListField(row, teamLabelFor(row.winningTeam))),
    );
  }

  if (page.totalPages > 1) {
    embed.setFooter({
      text: 'Tap an id → /match show · Only you can use the buttons',
    });
  } else if (page.totalMatches > 0) {
    embed.setFooter({ text: 'Copy an id → /match show match_id:…' });
  }

  return embed;
}

export function buildMatchListPageButtons(input: {
  invokerId: string;
  leagueId: string;
  page: number;
  totalPages: number;
}): ActionRowBuilder<ButtonBuilder>[] {
  if (input.totalPages <= 1) {
    return [];
  }
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(
        buildMatchListPageCustomId(input.invokerId, input.leagueId, 'prev', input.page),
      )
      .setLabel('Previous')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(input.page <= 1),
    new ButtonBuilder()
      .setCustomId(
        buildMatchListPageCustomId(input.invokerId, input.leagueId, 'next', input.page),
      )
      .setLabel('Next')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(input.page >= input.totalPages),
  );
  return [row];
}
```

Add re-exports to `src/services/match/index.ts` after the match-history block:

```typescript
export {
  buildMatchListEmbed,
  buildMatchListPageButtons,
  buildMatchListPageCustomId,
  countMatchListTeamSizes,
  formatMatchListField,
  formatMatchListFormat,
  loadMatchListPage,
  MATCH_LIST_PAGE_SIZE,
  parseMatchListPageCustomId,
  type MatchListPage,
  type MatchListRow,
} from './match-list.js';
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/services/match/match-list.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/match/match-list.ts src/services/match/match-list.test.ts src/services/match/index.ts
git commit -m "$(cat <<'EOF'
feat(match): load paginated league match lists

Query completed matches for a league and render compact winner/format rows for /match list.
EOF
)"
```

---

### Task 3: Wire `/match list`, lobby deny test, cheat sheet

**Files:**
- Modify: `src/commands/match/match.ts`
- Modify: `src/commands/match/match.test.ts`
- Modify: `src/services/league/league-lobby-channel.test.ts`
- Modify: `docs/discord/public/07-cheat-sheet.md`

**Interfaces:**
- Consumes: `loadMatchListPage`, `buildMatchListEmbed`, `buildMatchListPageButtons` from `../../services/match/index.js`
- Produces: `list` slash subcommand (optional `page`, optional `league`); public execute path

- [ ] **Step 1: Write failing tests**

In `src/commands/match/match.test.ts`, change the registered subcommands expectation to include `list` immediately after `history`:

```typescript
    expect(json.options?.map((option) => option.name)).toEqual([
      'history',
      'list',
      'show',
      'quitters',
      'complete',
      'cancel',
      'flip',
      'void',
    ]);
```

In `src/services/league/league-lobby-channel.test.ts`, inside `it('allows only match complete, cancel, and quitters'`, add:

```typescript
    expect(isLobbyChannelAllowedCommand('match', 'list')).toBe(false);
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/commands/match/match.test.ts src/services/league/league-lobby-channel.test.ts`

Expected: `match.test.ts` FAIL (received array missing `list`). Lobby test PASS already (`list` is default-deny) — keep the assertion so a future allowlist change cannot silently permit it.

- [ ] **Step 3: Add the subcommand and execute branch**

In `src/commands/match/match.ts` imports from `../../services/match/index.js`, add:

```typescript
  buildMatchListEmbed,
  buildMatchListPageButtons,
  loadMatchListPage,
```

Change `publicReadErrorMessage`:

```typescript
function publicReadErrorMessage(subcommand: string): string {
  if (subcommand === 'show') {
    return 'Something went wrong loading that match.';
  }
  if (subcommand === 'list') {
    return 'Something went wrong loading the match list.';
  }
  return 'Something went wrong loading match history.';
}
```

After the `history` subcommand builder (before `show`), add:

```typescript
  .addSubcommand((subcommand) =>
    withSubcommandLeagueOption(
      subcommand
        .setName('list')
        .setDescription('List completed matches in this league (newest first)')
        .addIntegerOption((option) =>
          option.setName('page').setDescription('Page number').setRequired(false).setMinValue(1),
        ),
    ),
  )
```

In `execute`, treat `list` as a public read and defer it publicly like `show`:

```typescript
  const isPublicRead =
    subcommand === 'history' || subcommand === 'show' || subcommand === 'list';
```

```typescript
  if (subcommand === 'history' && historyKind === 'user') {
    await interaction.deferReply();
  } else if (subcommand === 'show' || subcommand === 'list') {
    await interaction.deferReply();
  } else if (subcommand !== 'history') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  }
```

After the `history` branch `return;` and before `if (subcommand === 'show')`, insert:

```typescript
    if (subcommand === 'list') {
      if (!interaction.guildId) {
        throw new MatchServiceError('This command can only be used in a server.');
      }
      const resolved = await resolveLeagueIdFromInteraction(
        interaction,
        getLeagueOption(interaction),
      );
      if (!resolved.ok) {
        await replyMatchRead(interaction, { content: resolved.message });
        return;
      }

      const gameProfile = await getGameProfileForLeague(resolved.leagueId);
      const pageNum = interaction.options.getInteger('page') ?? 1;
      const pageData = await loadMatchListPage({
        leagueId: resolved.leagueId,
        page: pageNum,
      });
      const embed = buildMatchListEmbed(pageData, (team) =>
        teamDisplayName(team, gameProfile),
      );
      const components = buildMatchListPageButtons({
        invokerId: interaction.user.id,
        leagueId: resolved.leagueId,
        page: pageData.page,
        totalPages: pageData.totalPages,
      });
      await replyMatchRead(interaction, { embeds: [embed], components });
      return;
    }
```

In `docs/discord/public/07-cheat-sheet.md`, under **Match (anyone)**, add the list line above show:

```markdown
**Match (anyone)**
• `/match history` — your completed matches (optional user/page)
• `/match list` — completed matches in this league (optional page)
• `/match show` — open a completed match by id
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/commands/match/match.test.ts src/services/league/league-lobby-channel.test.ts src/services/match/match-list.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/commands/match/match.ts src/commands/match/match.test.ts src/services/league/league-lobby-channel.test.ts docs/discord/public/07-cheat-sheet.md
git commit -m "$(cat <<'EOF'
feat(match): add /match list command

Expose a public league-wide completed-match feed next to player history.
EOF
)"
```

---

### Task 4: Page buttons

**Files:**
- Create: `src/discord/interactions/match-list-interactions.ts`
- Modify: `src/events/interaction-create.ts`

**Interfaces:**
- Consumes: `parseMatchListPageCustomId`, `loadMatchListPage`, `buildMatchListEmbed`, `buildMatchListPageButtons`
- Produces: `export async function handleMatchListInteraction(interaction: Interaction): Promise<boolean>`

There is no `match-history-interactions` test file. Do not add a live Discord interaction test. Handler behavior matches history: invoker check, `deferUpdate`, `editReply`.

- [ ] **Step 1: Create the handler**

Create `src/discord/interactions/match-list-interactions.ts`:

```typescript
import { MessageFlags, type Interaction } from 'discord.js';
import { teamDisplayName } from '../../services/guild/index.js';
import { getGameProfileForLeague } from '../../services/league/index.js';
import {
  buildMatchListEmbed,
  buildMatchListPageButtons,
  loadMatchListPage,
  parseMatchListPageCustomId,
} from '../../services/match/index.js';

const NOT_YOUR_PAGE = 'Only the person who ran the command can change pages.';

export async function handleMatchListInteraction(
  interaction: Interaction,
): Promise<boolean> {
  if (!interaction.isButton()) {
    return false;
  }
  if (!interaction.customId.startsWith('ml:p:')) {
    return false;
  }

  const parsed = parseMatchListPageCustomId(interaction.customId);
  if (!parsed) {
    return true;
  }

  if (interaction.user.id !== parsed.invokerId) {
    await interaction.reply({ content: NOT_YOUR_PAGE, flags: MessageFlags.Ephemeral });
    return true;
  }

  await interaction.deferUpdate();
  const pageData = await loadMatchListPage({
    leagueId: parsed.leagueId,
    page: parsed.page,
  });
  const profile = await getGameProfileForLeague(parsed.leagueId);
  await interaction.editReply({
    embeds: [
      buildMatchListEmbed(pageData, (team) => teamDisplayName(team, profile)),
    ],
    components: buildMatchListPageButtons({
      invokerId: parsed.invokerId,
      leagueId: parsed.leagueId,
      page: pageData.page,
      totalPages: pageData.totalPages,
    }),
  });
  return true;
}
```

- [ ] **Step 2: Route the handler**

In `src/events/interaction-create.ts`, add:

```typescript
import { handleMatchListInteraction } from '../discord/interactions/match-list-interactions.js';
```

Immediately after the `handleMatchHistoryInteraction` block:

```typescript
    if (await handleMatchListInteraction(interaction)) {
      log.debug({ userId: interaction.user.id }, 'Match list interaction handled');
      return;
    }
```

- [ ] **Step 3: Run unit tests (no live Discord)**

Run: `npx vitest run src/services/match/match-list.test.ts src/commands/match/match.test.ts src/services/league/league-lobby-channel.test.ts`

Expected: PASS

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`

Expected: PASS (exit 0)

- [ ] **Step 5: Commit**

```bash
git add src/discord/interactions/match-list-interactions.ts src/events/interaction-create.ts
git commit -m "$(cat <<'EOF'
feat(match): paginate /match list with invoker-only buttons

Reuse the history button pattern with a shorter ml:p customId that only encodes invoker and league.
EOF
)"
```

---

## Spec coverage

| Spec requirement | Task |
|------------------|------|
| `/match list` public, no `/link` | 3 |
| `COMPLETED` only, newest first, page size 10, clamp | 2 |
| Row: date, winner, `4v6` team-1 vs team-2, copyable id | 1 + 2 |
| Embed author = league name, title `Match list` | 2 |
| Empty embed, not an error | 2 |
| `ml:p:` customId, compact UUID, ≤ 100 chars | 1 |
| Invoker-only Prev/Next | 4 |
| `/match show` unchanged | (no task) |
| `/match history` command behavior unchanged | (Task 1 may only import shared compact helpers) |
| Lobby deny + test | 3 |
| Cheat sheet line | 3 |
| Dedicated list module; shared `compact-custom-id.ts`; reuse clamp + winningTeam only | 1 + 2 |
