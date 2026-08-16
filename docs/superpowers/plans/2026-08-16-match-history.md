# Match History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Players can paginate completed match history (self or optional `@user`) and open a read-only completed match detail via `/match history` and `/match show`.

**Architecture:** Thin Discord adapters in `match.ts`; list/query/embed/pagination helpers in `src/services/match/match-history.ts`. Detail reuses `getMatchById` + `buildMatchCompletedEmbed` (roster + winner only). Page buttons mirror leaderboard (invoker-only).

**Tech Stack:** TypeScript ESM, Prisma, discord.js v14, Vitest

**Spec:** `docs/superpowers/specs/2026-08-16-match-history-design.md`

## Global Constraints

- Scope: `general` (league-scoped; not game-specific)
- English-only user-facing strings and errors
- History: `COMPLETED` only; newest first (`completedAt` desc)
- Page size: **10**
- Optional `@user`; default invoker
- Summary rows: id, date, W/L, team, hero (`—` if none), ` Q` when quitter
- `/match history` + `/match show` only (no nick lookup, no cancelled/pending)
- **Show ki:** do **not** attach `ratingPreview` — `MatchRatingSnapshot` stores **pre-match** μ/σ for corrections, not post-match display (supersedes design wording about snapshot ki)
- Wrong guild/league on show → “Match not found.”
- Visible non-completed match in guild → “This match is not completed.”
- History/show replies are **public** (not ephemeral); manage subcommands stay ephemeral
- ESM `.js` imports; named exports
- No schema migration; no new env/SSM keys
- Branch: `feature/match-history` (create worktree at execution time if using worktrees skill)

## File map

| File | Role |
|------|------|
| `src/services/match/match-history.ts` | Page load, row format, history embed, button ids, show loader |
| `src/services/match/match-history.test.ts` | Unit tests |
| `src/services/match/index.ts` | Re-exports |
| `src/commands/match/match.ts` | Subcommands + public/ephemeral defer split + autocomplete |
| `src/discord/interactions/match-history-interactions.ts` | Prev/Next buttons |
| `src/events/interaction-create.ts` | Route history buttons |
| `docs/discord/public/07-cheat-sheet.md` | Public cheat lines |

---

### Task 1: Pure helpers — format, pagination ids, winning team

**Files:**
- Create: `src/services/match/match-history.ts`
- Create: `src/services/match/match-history.test.ts`

**Interfaces:**
- Produces:
  - `export const MATCH_HISTORY_PAGE_SIZE = 10`
  - `export type MatchHistoryRow = { matchId: string; completedAt: Date; result: 'WIN' | 'LOSS'; team: 1 \| 2; heroName: string \| null; isQuitter: boolean }`
  - `export function formatMatchHistoryRow(row: MatchHistoryRow, teamLabel: string): string`
  - `export function clampMatchHistoryPage(page: number, totalPages: number): number`
  - `export function winningTeamFromPlayers(players: Array<{ team: number; result: string \| null }>): 1 \| 2`
  - `export function buildMatchHistoryPageCustomId(invokerId: string, playerId: string, leagueId: string, direction: 'prev' \| 'next', currentPage: number): string`
  - `export function parseMatchHistoryPageCustomId(customId: string): { invokerId: string; playerId: string; leagueId: string; page: number } \| null`

- [ ] **Step 1: Write failing tests**

```typescript
import { describe, expect, it } from 'vitest';
import {
  buildMatchHistoryPageCustomId,
  clampMatchHistoryPage,
  formatMatchHistoryRow,
  parseMatchHistoryPageCustomId,
  winningTeamFromPlayers,
} from './match-history.js';

describe('formatMatchHistoryRow', () => {
  it('formats summary with hero and quitter marker', () => {
    const line = formatMatchHistoryRow(
      {
        matchId: 'clxxxxxxxxxxxxxxxxxxxx',
        completedAt: new Date('2026-08-16T12:00:00.000Z'),
        result: 'WIN',
        team: 1,
        heroName: 'Goku',
        isQuitter: true,
      },
      'Z Fighters',
    );
    expect(line).toBe(
      '`clxxxxxxxxxxxxxxxxxxxx` · 2026-08-16 · W · Z Fighters · Goku Q',
    );
  });

  it('uses em dash when hero missing and omits Q when not quitter', () => {
    const line = formatMatchHistoryRow(
      {
        matchId: 'm1',
        completedAt: new Date('2026-01-02T00:00:00.000Z'),
        result: 'LOSS',
        team: 2,
        heroName: null,
        isQuitter: false,
      },
      'Evil',
    );
    expect(line).toBe('`m1` · 2026-01-02 · L · Evil · —');
  });
});

describe('clampMatchHistoryPage', () => {
  it('clamps high pages and floors below 1', () => {
    expect(clampMatchHistoryPage(99, 3)).toBe(3);
    expect(clampMatchHistoryPage(0, 3)).toBe(1);
    expect(clampMatchHistoryPage(2, 3)).toBe(2);
  });
});

describe('winningTeamFromPlayers', () => {
  it('returns team with WIN', () => {
    expect(
      winningTeamFromPlayers([
        { team: 1, result: 'LOSS' },
        { team: 2, result: 'WIN' },
      ]),
    ).toBe(2);
  });
});

describe('match history page custom ids', () => {
  it('round-trips prev/next and stays under 100 chars', () => {
    const invokerId = '123456789012345678';
    const playerId = 'clplayeridxxxxxxxxxxxx';
    const leagueId = 'clleagueidxxxxxxxxxxxx';
    const id = buildMatchHistoryPageCustomId(invokerId, playerId, leagueId, 'next', 2);
    expect(id.length).toBeLessThanOrEqual(100);
    expect(parseMatchHistoryPageCustomId(id)).toEqual({
      invokerId,
      playerId,
      leagueId,
      page: 3,
    });
    const prev = buildMatchHistoryPageCustomId(invokerId, playerId, leagueId, 'prev', 2);
    expect(parseMatchHistoryPageCustomId(prev)).toEqual({
      invokerId,
      playerId,
      leagueId,
      page: 1,
    });
  });

  it('returns null for garbage', () => {
    expect(parseMatchHistoryPageCustomId('leaderboard:page:x')).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL**

Run: `npm test -- src/services/match/match-history.test.ts`

Expected: FAIL (module / exports missing)

- [ ] **Step 3: Implement helpers**

In `match-history.ts`:

```typescript
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from 'discord.js';
import { prisma } from '../../lib/prisma.js';
import { loadHeroCatalog } from '../guild/hero-catalog.js';
import { teamDisplayName } from '../guild/team-names.js';
import { getGameProfileForLeague } from '../league/league-profile.js';
import { listLeaguesForGuild } from '../league/league.js';
import { buildMatchCompletedEmbed } from '../lobby/lobby-preview.js';
import { MatchServiceError, getMatchById, matchToLobbyPlayers, type MatchWithPlayers } from './match-service.js';

export const MATCH_HISTORY_PAGE_SIZE = 10;

export type MatchHistoryRow = {
  matchId: string;
  completedAt: Date;
  result: 'WIN' | 'LOSS';
  team: 1 | 2;
  heroName: string | null;
  isQuitter: boolean;
};

export type MatchHistoryPage = {
  targetPlayerId: string;
  targetUsername: string;
  page: number;
  totalPages: number;
  totalMatches: number;
  rows: MatchHistoryRow[];
};

/** UTC calendar date YYYY-MM-DD for history rows. */
function formatHistoryDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function formatMatchHistoryRow(row: MatchHistoryRow, teamLabel: string): string {
  const wl = row.result === 'WIN' ? 'W' : 'L';
  const hero = row.heroName ?? '—';
  const quit = row.isQuitter ? ' Q' : '';
  return `\`${row.matchId}\` · ${formatHistoryDate(row.completedAt)} · ${wl} · ${teamLabel} · ${hero}${quit}`;
}

export function clampMatchHistoryPage(page: number, totalPages: number): number {
  const safeTotal = Math.max(1, totalPages);
  if (!Number.isFinite(page) || page < 1) return 1;
  if (page > safeTotal) return safeTotal;
  return page;
}

export function winningTeamFromPlayers(
  players: Array<{ team: number; result: string | null }>,
): 1 | 2 {
  return players.some((player) => player.result === 'WIN' && player.team === 1) ? 1 : 2;
}

/** Prefix short enough for Discord customId max 100 with two cuids + snowflake. */
export function buildMatchHistoryPageCustomId(
  invokerId: string,
  playerId: string,
  leagueId: string,
  direction: 'prev' | 'next',
  currentPage: number,
): string {
  return `mh:p:${invokerId}:${playerId}:${leagueId}:${direction}:${currentPage}`;
}

export function parseMatchHistoryPageCustomId(
  customId: string,
): { invokerId: string; playerId: string; leagueId: string; page: number } | null {
  const parts = customId.split(':');
  // mh:p:invoker:player:league:dir:page → 7 parts
  if (parts.length !== 7 || parts[0] !== 'mh' || parts[1] !== 'p') {
    return null;
  }
  const direction = parts[5];
  const currentPage = Number.parseInt(parts[6]!, 10);
  if (!Number.isFinite(currentPage) || currentPage < 1) {
    return null;
  }
  const invokerId = parts[2]!;
  const playerId = parts[3]!;
  const leagueId = parts[4]!;
  if (!invokerId || !playerId || !leagueId) {
    return null;
  }
  if (direction === 'prev') {
    return { invokerId, playerId, leagueId, page: currentPage - 1 };
  }
  if (direction === 'next') {
    return { invokerId, playerId, leagueId, page: currentPage + 1 };
  }
  return null;
}
```

Keep further exports for later tasks in the same file (stubs can wait until Task 2–3).

- [ ] **Step 4: Run tests — expect PASS**

Run: `npm test -- src/services/match/match-history.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/services/match/match-history.ts src/services/match/match-history.test.ts
git commit -m "$(cat <<'EOF'
feat: add match history format and pagination helpers

EOF
)"
```

---

### Task 2: Load history page + embed + buttons

**Files:**
- Modify: `src/services/match/match-history.ts`
- Modify: `src/services/match/match-history.test.ts`
- Modify: `src/services/match/index.ts`

**Interfaces:**
- Consumes: Task 1 helpers; `prisma`; `loadHeroCatalog`; `teamDisplayName`; `getGameProfileForLeague`
- Produces:
  - `export async function resolveHistoryPlayer(discordId: string, kind: 'self' | 'user'): Promise<{ id: string; username: string }>`
  - `export async function loadMatchHistoryPage(input: { leagueId: string; playerId: string; page: number }): Promise<MatchHistoryPage>`
  - `export function buildMatchHistoryEmbed(page: MatchHistoryPage, leagueId: string, teamLabelFor: (team: 1 \| 2) => string): EmbedBuilder`
  - `export function buildMatchHistoryPageButtons(input: { invokerId: string; playerId: string; leagueId: string; page: number; totalPages: number }): ActionRowBuilder<ButtonBuilder>[]`

- [ ] **Step 1: Write failing tests for resolve + clamp page load (mock prisma)**

```typescript
import { beforeEach, describe, expect, it, vi } from 'vitest';

const playerFindUnique = vi.fn();
const matchFindMany = vi.fn();
const matchCount = vi.fn();

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    player: { findUnique: (...a: unknown[]) => playerFindUnique(...a) },
    match: {
      findMany: (...a: unknown[]) => matchFindMany(...a),
      count: (...a: unknown[]) => matchCount(...a),
    },
  },
}));

vi.mock('../guild/hero-catalog.js', () => ({
  loadHeroCatalog: vi.fn(async () => [{ id: 1, name: 'Goku', color: null }]),
}));

vi.mock('../league/league-profile.js', () => ({
  getGameProfileForLeague: vi.fn(async () => ({
    // minimal: only needed if load path calls it — prefer not calling in loadMatchHistoryPage
  })),
}));

import {
  buildMatchHistoryEmbed,
  buildMatchHistoryPageButtons,
  loadMatchHistoryPage,
  resolveHistoryPlayer,
} from './match-history.js';

describe('resolveHistoryPlayer', () => {
  beforeEach(() => {
    playerFindUnique.mockReset();
  });

  it('throws self link message when missing', async () => {
    playerFindUnique.mockResolvedValue(null);
    await expect(resolveHistoryPlayer('d1', 'self')).rejects.toThrow(
      /not linked/i,
    );
  });

  it('throws player not found for other user', async () => {
    playerFindUnique.mockResolvedValue(null);
    await expect(resolveHistoryPlayer('d2', 'user')).rejects.toThrow(
      'Player not found.',
    );
  });
});

describe('loadMatchHistoryPage', () => {
  beforeEach(() => {
    matchFindMany.mockReset();
    matchCount.mockReset();
  });

  it('returns empty page 1 when no matches', async () => {
    matchCount.mockResolvedValue(0);
    matchFindMany.mockResolvedValue([]);
    const page = await loadMatchHistoryPage({
      leagueId: 'L1',
      playerId: 'P1',
      page: 1,
    });
    expect(page.totalMatches).toBe(0);
    expect(page.totalPages).toBe(1);
    expect(page.rows).toEqual([]);
    expect(page.page).toBe(1);
  });

  it('clamps page and maps rows', async () => {
    matchCount.mockResolvedValue(11);
    matchFindMany.mockResolvedValue([
      {
        id: 'm2',
        completedAt: new Date('2026-08-10T00:00:00.000Z'),
        players: [
          {
            playerId: 'P1',
            team: 1,
            result: 'WIN',
            heroId: 1,
            isQuitter: false,
          },
        ],
      },
    ]);
    const page = await loadMatchHistoryPage({
      leagueId: 'L1',
      playerId: 'P1',
      page: 99,
    });
    expect(page.page).toBe(2);
    expect(page.totalPages).toBe(2);
    expect(page.rows[0]).toMatchObject({
      matchId: 'm2',
      result: 'WIN',
      heroName: 'Goku',
    });
  });
});

describe('buildMatchHistoryEmbed', () => {
  it('shows empty copy', () => {
    const embed = buildMatchHistoryEmbed(
      {
        targetPlayerId: 'P1',
        targetUsername: 'alice',
        page: 1,
        totalPages: 1,
        totalMatches: 0,
        rows: [],
      },
      'L1',
      (t) => (t === 1 ? 'Z Fighters' : 'Evil'),
    );
    expect(embed.data.description).toMatch(/No completed matches yet/i);
  });
});

describe('buildMatchHistoryPageButtons', () => {
  it('returns no row when single page', () => {
    expect(
      buildMatchHistoryPageButtons({
        invokerId: '1',
        playerId: 'P',
        leagueId: 'L',
        page: 1,
        totalPages: 1,
      }),
    ).toEqual([]);
  });
});
```

Note: `loadMatchHistoryPage` must set `targetUsername` — either accept it as input or look up player. Prefer input:

```typescript
export async function loadMatchHistoryPage(input: {
  leagueId: string;
  playerId: string;
  username: string;
  page: number;
}): Promise<MatchHistoryPage>
```

Update tests to pass `username: 'alice'`.

- [ ] **Step 2: Run tests — expect FAIL**

Run: `npm test -- src/services/match/match-history.test.ts`

- [ ] **Step 3: Implement resolve + load + embed + buttons**

```typescript
export async function resolveHistoryPlayer(
  discordId: string,
  kind: 'self' | 'user',
): Promise<{ id: string; username: string }> {
  const player = await prisma.player.findUnique({ where: { discordId } });
  if (!player) {
    if (kind === 'self') {
      throw new MatchServiceError(
        'Your Discord is not linked to an in-game nick. Use /link to bind it.',
      );
    }
    throw new MatchServiceError('Player not found.');
  }
  return { id: player.id, username: player.username };
}

export async function loadMatchHistoryPage(input: {
  leagueId: string;
  playerId: string;
  username: string;
  page: number;
}): Promise<MatchHistoryPage> {
  const where = {
    leagueId: input.leagueId,
    status: 'COMPLETED' as const,
    players: { some: { playerId: input.playerId } },
  };

  const totalMatches = await prisma.match.count({ where });
  const totalPages = Math.max(1, Math.ceil(totalMatches / MATCH_HISTORY_PAGE_SIZE));
  const page = clampMatchHistoryPage(input.page, totalPages);
  const skip = (page - 1) * MATCH_HISTORY_PAGE_SIZE;

  const matches = await prisma.match.findMany({
    where,
    orderBy: [{ completedAt: 'desc' }, { createdAt: 'desc' }],
    skip,
    take: MATCH_HISTORY_PAGE_SIZE,
    select: {
      id: true,
      completedAt: true,
      createdAt: true,
      players: {
        where: { playerId: input.playerId },
        select: {
          team: true,
          result: true,
          heroId: true,
          isQuitter: true,
        },
      },
    },
  });

  const catalog = await loadHeroCatalog();
  const heroNameById = new Map(catalog.map((h) => [h.id, h.name]));

  const rows: MatchHistoryRow[] = [];
  for (const match of matches) {
    const mp = match.players[0];
    if (!mp || (mp.result !== 'WIN' && mp.result !== 'LOSS')) {
      continue;
    }
    if (mp.team !== 1 && mp.team !== 2) {
      continue;
    }
    rows.push({
      matchId: match.id,
      completedAt: match.completedAt ?? match.createdAt,
      result: mp.result,
      team: mp.team,
      heroName: mp.heroId != null ? (heroNameById.get(mp.heroId) ?? null) : null,
      isQuitter: mp.isQuitter,
    });
  }

  return {
    targetPlayerId: input.playerId,
    targetUsername: input.username,
    page,
    totalPages,
    totalMatches,
    rows,
  };
}

export function buildMatchHistoryEmbed(
  page: MatchHistoryPage,
  _leagueId: string,
  teamLabelFor: (team: 1 | 2) => string,
): EmbedBuilder {
  const body =
    page.rows.length === 0
      ? 'No completed matches yet.'
      : page.rows.map((row) => formatMatchHistoryRow(row, teamLabelFor(row.team))).join('\n');

  const embed = new EmbedBuilder()
    .setTitle(`Match history — ${page.targetUsername}`)
    .setDescription(
      `Page ${page.page} of ${page.totalPages} · ${page.totalMatches} matches\n\n${body}`,
    )
    .setColor(0xf0b232);

  if (page.totalPages > 1) {
    embed.setFooter({
      text: 'Use /match show match_id:… · Only you can use the buttons',
    });
  } else if (page.totalMatches > 0) {
    embed.setFooter({ text: 'Use /match show match_id:… to open a match' });
  }

  return embed;
}

export function buildMatchHistoryPageButtons(input: {
  invokerId: string;
  playerId: string;
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
        buildMatchHistoryPageCustomId(
          input.invokerId,
          input.playerId,
          input.leagueId,
          'prev',
          input.page,
        ),
      )
      .setLabel('Previous')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(input.page <= 1),
    new ButtonBuilder()
      .setCustomId(
        buildMatchHistoryPageCustomId(
          input.invokerId,
          input.playerId,
          input.leagueId,
          'next',
          input.page,
        ),
      )
      .setLabel('Next')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(input.page >= input.totalPages),
  );
  return [row];
}
```

Export new symbols from `src/services/match/index.ts`.

- [ ] **Step 4: Run tests — expect PASS**

Run: `npm test -- src/services/match/match-history.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/services/match/match-history.ts src/services/match/match-history.test.ts src/services/match/index.ts
git commit -m "$(cat <<'EOF'
feat: load paginated completed match history

EOF
)"
```

---

### Task 3: Show completed match (tenancy + embed)

**Files:**
- Modify: `src/services/match/match-history.ts`
- Modify: `src/services/match/match-history.test.ts`
- Modify: `src/services/match/index.ts`

**Interfaces:**
- Produces:
  - `export async function loadCompletedMatchShow(input: { matchId: string; guildId: string; leagueId?: string \| null }): Promise<{ match: MatchWithPlayers; embed: EmbedBuilder }>`

- [ ] **Step 1: Write failing tenancy tests (mock getMatchById + listLeaguesForGuild)**

```typescript
const getMatchById = vi.fn();
const listLeaguesForGuild = vi.fn();

vi.mock('./match-service.js', async () => {
  const actual = await vi.importActual<typeof import('./match-service.js')>('./match-service.js');
  return {
    ...actual,
    getMatchById: (...a: unknown[]) => getMatchById(...a),
    MatchServiceError: actual.MatchServiceError,
    matchToLobbyPlayers: actual.matchToLobbyPlayers,
  };
});

vi.mock('../league/league.js', () => ({
  listLeaguesForGuild: (...a: unknown[]) => listLeaguesForGuild(...a),
}));

vi.mock('../lobby/lobby-preview.js', () => ({
  buildMatchCompletedEmbed: vi.fn(() => {
    const { EmbedBuilder } = require('discord.js');
    return new EmbedBuilder().setTitle('Match Completed');
  }),
}));

import { loadCompletedMatchShow } from './match-history.js';
import { MatchServiceError } from './match-service.js';

describe('loadCompletedMatchShow', () => {
  beforeEach(() => {
    getMatchById.mockReset();
    listLeaguesForGuild.mockReset();
  });

  it('throws not found when missing', async () => {
    getMatchById.mockResolvedValue(null);
    await expect(
      loadCompletedMatchShow({ matchId: 'x', guildId: 'g1' }),
    ).rejects.toThrow('This match was not found.');
  });

  it('throws not found when league not in guild', async () => {
    getMatchById.mockResolvedValue({
      id: 'm1',
      status: 'COMPLETED',
      leagueId: 'other',
      players: [{ team: 1, result: 'WIN' }],
    });
    listLeaguesForGuild.mockResolvedValue([{ id: 'L1' }]);
    await expect(
      loadCompletedMatchShow({ matchId: 'm1', guildId: 'g1' }),
    ).rejects.toThrow('This match was not found.');
  });

  it('throws not completed when status wrong but league ok', async () => {
    getMatchById.mockResolvedValue({
      id: 'm1',
      status: 'IN_PROGRESS',
      leagueId: 'L1',
      players: [],
    });
    listLeaguesForGuild.mockResolvedValue([{ id: 'L1' }]);
    await expect(
      loadCompletedMatchShow({ matchId: 'm1', guildId: 'g1' }),
    ).rejects.toThrow('This match is not completed.');
  });
});
```

(Adjust mocks to match project ESM/vitest style used in nearby tests — prefer `vi.hoisted` if that is the local pattern.)

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement `loadCompletedMatchShow`**

```typescript
export async function loadCompletedMatchShow(input: {
  matchId: string;
  guildId: string;
  leagueId?: string | null;
}): Promise<{ match: MatchWithPlayers; embed: EmbedBuilder }> {
  const match = await getMatchById(input.matchId);
  if (!match) {
    throw new MatchServiceError('This match was not found.');
  }

  const leagues = await listLeaguesForGuild(input.guildId);
  const allowed = new Set(leagues.map((l) => l.id));
  if (!allowed.has(match.leagueId)) {
    throw new MatchServiceError('This match was not found.');
  }

  if (input.leagueId && match.leagueId !== input.leagueId) {
    throw new MatchServiceError('This match was not found.');
  }

  if (match.status !== 'COMPLETED') {
    throw new MatchServiceError('This match is not completed.');
  }

  const profile = await getGameProfileForLeague(match.leagueId);
  const winningTeam = winningTeamFromPlayers(match.players);
  const embed = buildMatchCompletedEmbed(match.id, matchToLobbyPlayers(match), {
    winningTeam,
    profile,
    // no ratingPreview — snapshots are pre-match only
  });

  return { match, embed };
}
```

Export from index.

- [ ] **Step 4: Run tests — PASS**

- [ ] **Step 5: Commit**

```bash
git add src/services/match/match-history.ts src/services/match/match-history.test.ts src/services/match/index.ts
git commit -m "$(cat <<'EOF'
feat: add completed match show loader with league tenancy

EOF
)"
```

---

### Task 4: Wire `/match history` and `/match show`

**Files:**
- Modify: `src/commands/match/match.ts`
- Modify: `docs/discord/public/07-cheat-sheet.md`

**Interfaces:**
- Consumes: `resolveHistoryPlayer`, `loadMatchHistoryPage`, `buildMatchHistoryEmbed`, `buildMatchHistoryPageButtons`, `loadCompletedMatchShow`, `resolveLeagueIdFromInteraction`, `getLeagueOption`, `withSubcommandLeagueOption`, `respondLeagueAutocomplete`, `getGameProfileForLeague`, `teamDisplayName`

- [ ] **Step 1: Update command description and add subcommands**

Change root description to: `Manage matches or view history`.

Add before manage subcommands (or after — order is UX preference; put **history** and **show** first for discoverability):

```typescript
.addSubcommand((subcommand) =>
  withSubcommandLeagueOption(
    subcommand
      .setName('history')
      .setDescription('List your completed matches (newest first)')
      .addUserOption((option) =>
        option.setName('user').setDescription('Discord user to look up').setRequired(false),
      )
      .addIntegerOption((option) =>
        option.setName('page').setDescription('Page number').setRequired(false).setMinValue(1),
      ),
  ),
)
.addSubcommand((subcommand) =>
  withSubcommandLeagueOption(
    subcommand
      .setName('show')
      .setDescription('Show a completed match by id')
      .addStringOption((option) =>
        option.setName('match_id').setDescription('Completed match id').setRequired(true),
      ),
  ),
)
```

- [ ] **Step 2: Split defer + add autocomplete + execute branches**

At start of `execute`:

```typescript
const subcommand = interaction.options.getSubcommand(true);
const isPublicRead = subcommand === 'history' || subcommand === 'show';
await interaction.deferReply(isPublicRead ? undefined : { flags: MessageFlags.Ephemeral });
```

Add:

```typescript
export async function autocomplete(interaction: AutocompleteInteraction): Promise<void> {
  await respondLeagueAutocomplete(interaction);
}
```

History branch (after defer / logging):

```typescript
if (subcommand === 'history') {
  if (!interaction.guildId) {
    throw new MatchServiceError('This command can only be used in a server.');
  }
  const resolved = await resolveLeagueIdFromInteraction(
    interaction,
    getLeagueOption(interaction),
  );
  if (!resolved.ok) {
    await interaction.editReply({ content: resolved.message });
    return;
  }
  const user = interaction.options.getUser('user');
  const kind = user && user.id !== interaction.user.id ? 'user' : 'self';
  const discordId = user?.id ?? interaction.user.id;
  const player = await resolveHistoryPlayer(discordId, kind);
  const pageNum = interaction.options.getInteger('page') ?? 1;
  const pageData = await loadMatchHistoryPage({
    leagueId: resolved.leagueId,
    playerId: player.id,
    username: player.username,
    page: pageNum,
  });
  const profile = await getGameProfileForLeague(resolved.leagueId);
  const embed = buildMatchHistoryEmbed(pageData, resolved.leagueId, (team) =>
    teamDisplayName(team, profile),
  );
  const components = buildMatchHistoryPageButtons({
    invokerId: interaction.user.id,
    playerId: player.id,
    leagueId: resolved.leagueId,
    page: pageData.page,
    totalPages: pageData.totalPages,
  });
  await interaction.editReply({ embeds: [embed], components });
  return;
}

if (subcommand === 'show') {
  if (!interaction.guildId) {
    throw new MatchServiceError('This command can only be used in a server.');
  }
  const matchId = interaction.options.getString('match_id', true);
  const leagueOpt = getLeagueOption(interaction);
  let leagueId: string | null = null;
  if (leagueOpt) {
    const resolved = await resolveLeagueIdFromInteraction(interaction, leagueOpt);
    if (!resolved.ok) {
      await interaction.editReply({ content: resolved.message });
      return;
    }
    leagueId = resolved.leagueId;
  }
  const { embed } = await loadCompletedMatchShow({
    matchId,
    guildId: interaction.guildId,
    leagueId,
  });
  await interaction.editReply({ embeds: [embed] });
  return;
}
```

Ensure `MatchServiceError` handling already present in `execute` catch still applies for history/show.

- [ ] **Step 3: Update cheat sheet**

Under Match section add:

```markdown
• `/match history` — your completed matches (optional user/page)
• `/match show` — open a completed match by id
```

- [ ] **Step 4: Manual sanity** — `npm run build` (or `npx tsc --noEmit` if that is project norm) and `npm test -- src/services/match/match-history.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/commands/match/match.ts docs/discord/public/07-cheat-sheet.md
git commit -m "$(cat <<'EOF'
feat: add /match history and /match show commands

EOF
)"
```

---

### Task 5: History page button interactions

**Files:**
- Create: `src/discord/interactions/match-history-interactions.ts`
- Modify: `src/events/interaction-create.ts`

**Interfaces:**
- Consumes: `parseMatchHistoryPageCustomId`, `loadMatchHistoryPage`, `buildMatchHistoryEmbed`, `buildMatchHistoryPageButtons`, `getGameProfileForLeague`, `teamDisplayName`, `prisma.player.findUnique` (for username on reload)

- [ ] **Step 1: Implement handler**

```typescript
import { MessageFlags, type Interaction } from 'discord.js';
import { prisma } from '../../lib/prisma.js';
import { teamDisplayName } from '../../services/guild/index.js';
import { getGameProfileForLeague } from '../../services/league/index.js';
import {
  buildMatchHistoryEmbed,
  buildMatchHistoryPageButtons,
  loadMatchHistoryPage,
  parseMatchHistoryPageCustomId,
} from '../../services/match/index.js';

const NOT_YOUR_PAGE =
  'Only the person who ran the history command can change pages.';

export async function handleMatchHistoryInteraction(
  interaction: Interaction,
): Promise<boolean> {
  if (!interaction.isButton()) {
    return false;
  }
  if (!interaction.customId.startsWith('mh:p:')) {
    return false;
  }

  const parsed = parseMatchHistoryPageCustomId(interaction.customId);
  if (!parsed) {
    return true;
  }

  if (interaction.user.id !== parsed.invokerId) {
    await interaction.reply({ content: NOT_YOUR_PAGE, flags: MessageFlags.Ephemeral });
    return true;
  }

  const player = await prisma.player.findUnique({ where: { id: parsed.playerId } });
  if (!player) {
    await interaction.reply({
      content: 'Player not found.',
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  await interaction.deferUpdate();
  const pageData = await loadMatchHistoryPage({
    leagueId: parsed.leagueId,
    playerId: parsed.playerId,
    username: player.username,
    page: parsed.page,
  });
  const profile = await getGameProfileForLeague(parsed.leagueId);
  await interaction.editReply({
    embeds: [
      buildMatchHistoryEmbed(pageData, parsed.leagueId, (team) =>
        teamDisplayName(team, profile),
      ),
    ],
    components: buildMatchHistoryPageButtons({
      invokerId: parsed.invokerId,
      playerId: parsed.playerId,
      leagueId: parsed.leagueId,
      page: pageData.page,
      totalPages: pageData.totalPages,
    }),
  });
  return true;
}
```

- [ ] **Step 2: Register in `interaction-create.ts`**

Import and call **before** or after leaderboard handler (order only matters for prefix clash — `mh:p:` is unique):

```typescript
import { handleMatchHistoryInteraction } from '../discord/interactions/match-history-interactions.js';

// inside try, e.g. before handleLeaderboardInteraction:
if (await handleMatchHistoryInteraction(interaction)) {
  log.debug({ userId: interaction.user.id }, 'Match history interaction handled');
  return;
}
```

- [ ] **Step 3: Run full related tests**

Run: `npm test -- src/services/match/match-history.test.ts`

- [ ] **Step 4: Commit**

```bash
git add src/discord/interactions/match-history-interactions.ts src/events/interaction-create.ts
git commit -m "$(cat <<'EOF'
feat: paginate match history with invoker-only buttons

EOF
)"
```

---

## Spec coverage checklist

| Spec item | Task |
|-----------|------|
| `/match history` + optional user/page/league | 4 |
| Completed only, newest first, page size 10 | 2 |
| Summary row + Q marker | 1–2 |
| Invoker-only buttons | 1, 5 |
| `/match show` + tenancy | 3–4 |
| Reuse completed embed | 3 |
| No fabricated snapshot ki | 3 (explicit) |
| Public replies for read cmds | 4 |
| Cheat sheet | 4 |
| Empty history embed | 2 |

## Self-review notes

- Custom id uses short `mh:p:` prefix to stay ≤100 characters with two cuids.
- Design doc’s “post-match snapshot ki” is intentionally not implemented; snapshots are pre-match.
- `match.ts` currently defers ephemeral for all subcommands — Task 4 must split that or history/show will be invisible to others.
