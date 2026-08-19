# Match Report Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let host/mods report in-progress match outcomes — mark quitters, complete with a winner (OpenSkill `rate()`), or cancel (void or quit-penalties).

**Architecture:** Shared use-cases in `match-report.ts` orchestrate persistence; `rating-update.ts` owns OpenSkill `rate()` and N=3 quitter synthetic losses. Discord buttons drive an ephemeral wizard; `/match` slash subcommands call the same use-cases. Auth = host or `MATCH_MOD_ROLE_ID`.

**Tech Stack:** Node.js + TypeScript ESM, discord.js v14, Prisma, `openskill`, Vitest

**Spec:** [docs/superpowers/specs/2026-08-13-match-report-design.md](../specs/2026-08-13-match-report-design.md)

## Global Constraints

- User-facing strings in **English**
- Public ordinal = `μ − 3σ` (never show raw μ on embeds)
- Dual-entity teams: `[global, hero, …]`; `heroId = slot`
- Quitters: N=3 synthetic losses vs strong dummy; excluded from match Bayesian `rate()`
- `MatchResult.DRAW` unused
- Prefer Prisma singleton (`src/lib/prisma.ts`) and `createLogger`
- ESM imports use `.js` extensions
- Buttons and slash share the same use-cases (`shared-domain-logic.mdc`)
- Commits only when the user asks (skip commit steps unless requested)

## File structure

| File                                                                         | Responsibility                                                                |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `src/config/env.ts`                                                          | Optional `MATCH_MOD_ROLE_ID`                                                  |
| `.cursor/rules/scripts-and-env.mdc`                                          | Document new env var                                                          |
| `src/services/match-auth.ts`                                                 | `canManageMatch` / `assertCanManageMatch`                                     |
| `src/services/rating-update.ts`                                              | Pure helpers + DB: quitter penalties, match `rate()`, persist μ/σ             |
| `src/services/rating-update.test.ts`                                         | Unit tests for rating math helpers                                            |
| `src/services/match-report.ts`                                               | `setQuitters`, `completeMatch`, `cancelInProgressMatch`                       |
| `src/services/lobby-preview.ts`                                              | In-progress buttons, completed embed, 🚪 on quitters                          |
| `src/services/lobby-actions.ts`                                              | Sync modes `started` (with buttons), `completed`; resolve IN_PROGRESS matches |
| `src/handlers/lobby-interactions.ts` or `src/handlers/match-interactions.ts` | Button/select/modal wizard routing                                            |
| `src/commands/match/match.ts`                                                | `/match quitters                                                              | complete | cancel` |
| `src/events/interaction-create.ts`                                           | Route `match:` customIds if split handler                                     |

---

### Task 1: Env + match auth helper

**Files:**

- Modify: `src/config/env.ts`
- Modify: `.cursor/rules/scripts-and-env.mdc`
- Create: `src/services/match-auth.ts`

**Interfaces:**

- Produces:
  - `env.matchModRoleId: string | undefined`
  - `canManageMatch(input: { hostDiscordId: string; actorDiscordId: string; memberRoleIds: string[] }): boolean`
  - `assertCanManageMatch(...): void` throws `MatchServiceError` with English message

- [ ] **Step 1: Extend env**

In `src/config/env.ts`, add to `EnvConfig` and `env`:

```ts
/** Discord role ID allowed to report/cancel matches like the host. Empty = host-only. */
matchModRoleId: string | undefined;
```

```ts
matchModRoleId: (() => {
  const value = process.env.MATCH_MOD_ROLE_ID?.trim();
  return value && value.length > 0 ? value : undefined;
})(),
```

- [ ] **Step 2: Document env var**

In `.cursor/rules/scripts-and-env.mdc`, add under Env vars:

```md
- `MATCH_MOD_ROLE_ID` — optional Discord role that may report/cancel in-progress matches (host always can)
```

- [ ] **Step 3: Create `match-auth.ts`**

```ts
import { MatchServiceError } from './match-service.js';
import { env } from '../config/env.js';

const FORBIDDEN = 'Only the match host or a match moderator can do that.';

export function canManageMatch(input: {
  hostDiscordId: string;
  actorDiscordId: string;
  memberRoleIds: string[];
}): boolean {
  if (input.actorDiscordId === input.hostDiscordId) {
    return true;
  }

  const modRoleId = env.matchModRoleId;
  if (!modRoleId) {
    return false;
  }

  return input.memberRoleIds.includes(modRoleId);
}

export function assertCanManageMatch(input: {
  hostDiscordId: string;
  actorDiscordId: string;
  memberRoleIds: string[];
}): void {
  if (!canManageMatch(input)) {
    throw new MatchServiceError(FORBIDDEN);
  }
}
```

- [ ] **Step 4: Sanity-check TypeScript**

Run: `npx tsc --noEmit`
Expected: PASS (or only pre-existing unrelated errors)

---

### Task 2: Pure rating-update helpers + unit tests (TDD)

**Files:**

- Create: `src/services/rating-update.test.ts`
- Create: `src/services/rating-update.ts` (helpers only first; DB functions in Task 3)

**Interfaces:**

- Produces:
  - `QUITTER_SYNTHETIC_LOSSES = 3`
  - `buildDummyOpponentTeam(): Rating[]` — fixed strong dual/triple entities
  - `applySyntheticLosses(playerTeam: Rating[], losses?: number): Rating[]` — runs `rate` vs dummy N times; returns updated player team
  - `partitionRosterForRating<T extends { slot: number; isQuitter: boolean }>(entries: T[]): { quitters: T[]; active: T[] }`
  - `assertBothTeamsHaveActivePlayers(active: { slot: number }[]): void` — throws `MatchServiceError` if Team A or B empty after filter

- [ ] **Step 1: Write failing tests**

Create `src/services/rating-update.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { rating } from 'openskill';
import {
  QUITTER_SYNTHETIC_LOSSES,
  applySyntheticLosses,
  assertBothTeamsHaveActivePlayers,
  buildDummyOpponentTeam,
  partitionRosterForRating,
} from './rating-update.js';
import { MatchServiceError } from './match-service.js';

describe('applySyntheticLosses', () => {
  it('lowers mu over N synthetic losses', () => {
    const before = [rating({ mu: 25, sigma: 8.333 }), rating({ mu: 25, sigma: 8.333 })];
    const after = applySyntheticLosses(before, QUITTER_SYNTHETIC_LOSSES);
    expect(after).toHaveLength(2);
    expect(after[0]!.mu).toBeLessThan(before[0]!.mu);
    expect(after[1]!.mu).toBeLessThan(before[1]!.mu);
  });

  it('uses default N=3', () => {
    expect(QUITTER_SYNTHETIC_LOSSES).toBe(3);
  });
});

describe('buildDummyOpponentTeam', () => {
  it('returns a non-empty strong team', () => {
    const dummy = buildDummyOpponentTeam();
    expect(dummy.length).toBeGreaterThanOrEqual(2);
    expect(dummy[0]!.mu).toBeGreaterThan(25);
  });
});

describe('partitionRosterForRating', () => {
  it('splits quitters from active', () => {
    const { quitters, active } = partitionRosterForRating([
      { slot: 1, isQuitter: true },
      { slot: 7, isQuitter: false },
    ]);
    expect(quitters.map((e) => e.slot)).toEqual([1]);
    expect(active.map((e) => e.slot)).toEqual([7]);
  });
});

describe('assertBothTeamsHaveActivePlayers', () => {
  it('throws when a team has zero active players', () => {
    expect(() => assertBothTeamsHaveActivePlayers([{ slot: 1 }, { slot: 2 }])).toThrow(
      MatchServiceError,
    );
  });

  it('passes when both teams have at least one', () => {
    expect(() => assertBothTeamsHaveActivePlayers([{ slot: 1 }, { slot: 7 }])).not.toThrow();
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL**

Run: `npm test -- src/services/rating-update.test.ts`
Expected: FAIL (module / exports missing)

- [ ] **Step 3: Implement helpers in `rating-update.ts`**

```ts
import { rate, rating, type Rating } from 'openskill';
import { MatchServiceError } from './match-service.js';
import { splitRosterByTeam } from './rating-math.js';

export const QUITTER_SYNTHETIC_LOSSES = 3;

/** Strong fixed opponent for quitter penalties (not persisted). */
export function buildDummyOpponentTeam(): Rating[] {
  return [rating({ mu: 40, sigma: 4 }), rating({ mu: 40, sigma: 4 })];
}

/**
 * Run OpenSkill rate() N times: playerTeam loses to dummy each iteration.
 * Returns the updated playerTeam ratings (same length/order).
 */
export function applySyntheticLosses(
  playerTeam: Rating[],
  losses: number = QUITTER_SYNTHETIC_LOSSES,
): Rating[] {
  let current = playerTeam;
  const dummy = buildDummyOpponentTeam();

  for (let i = 0; i < losses; i += 1) {
    const [[nextPlayerTeam]] = rate([current, dummy], { rank: [2, 1] });
    current = nextPlayerTeam!;
  }

  return current;
}

export function partitionRosterForRating<T extends { isQuitter: boolean }>(
  entries: T[],
): { quitters: T[]; active: T[] } {
  return {
    quitters: entries.filter((e) => e.isQuitter),
    active: entries.filter((e) => !e.isQuitter),
  };
}

export function assertBothTeamsHaveActivePlayers(active: { slot: number }[]): void {
  const { teamA, teamB } = splitRosterByTeam(active);
  if (teamA.length === 0 || teamB.length === 0) {
    throw new MatchServiceError(
      'Cannot complete: after quitters, a team has no remaining players. Cancel the match instead.',
    );
  }
}
```

- [ ] **Step 4: Run tests — expect PASS**

Run: `npm test -- src/services/rating-update.test.ts`
Expected: PASS

---

### Task 3: Persist rating updates (DB layer)

**Files:**

- Modify: `src/services/rating-update.ts`
- Reuse: `ensurePlayerRatings`, `ensureHeroesExist` from `rating-preview.ts`
- Reuse: `toOpenSkillRatings`, `splitRosterByTeam` from `rating-math.ts`

**Interfaces:**

- Consumes: helpers from Task 2; Prisma; `ensurePlayerRatings` / `ensureHeroesExist`
- Produces:
  - `export type RatingRosterEntry = { playerId: string; slot: number; heroId: number; isQuitter: boolean }`
  - `applyQuitterPenalties(entries: RatingRosterEntry[]): Promise<void>` — only entries with `isQuitter`; updates global + hero μ/σ
  - `applyMatchRatings(entries: RatingRosterEntry[], winningTeam: 1 | 2): Promise<void>` — non-quitters only; winner team 1 = slots 1–6, team 2 = 7–12; increments `matchesPlayed` for non-quitter heroes

Implementation notes:

1. `ensureHeroesExist()` + `ensurePlayerRatings(activeOrQuitters mapped without isQuitter)`
2. Load current `PlayerRating` / `PlayerHeroRating` rows
3. For each quitter: `applySyntheticLosses([global, hero])` → write both rows
4. For match: build dual-entity arrays for teamA/teamB active players; `rate([winners, losers], { rank: [1, 2] })`; map updated ratings back to playerId/heroId; `update` rows; `matchesPlayed: { increment: 1 }` on hero ratings for active players

These functions should be callable inside an outer Prisma `$transaction` later — prefer accepting an optional `tx` client **or** keep them as standalone writes that `match-report` wraps carefully. **v1 choice:** implement as standalone Prisma calls; `match-report` runs status/result writes then rating functions in one `prisma.$transaction` by refactoring rating functions to accept `Prisma.TransactionClient` if needed for atomicity.

Recommended signature for atomicity:

```ts
import type { Prisma } from '@prisma/client';

type Db = Prisma.TransactionClient | typeof prisma;

export async function applyQuitterPenalties(
  entries: RatingRosterEntry[],
  db: Db = prisma,
): Promise<void>;

export async function applyMatchRatings(
  entries: RatingRosterEntry[],
  winningTeam: 1 | 2,
  db: Db = prisma,
): Promise<void>;
```

- [ ] **Step 1: Implement `applyQuitterPenalties` and `applyMatchRatings`** as above (full code in the service file; follow existing `rating-preview.ts` load patterns).

- [ ] **Step 2: Manual smoke via a small script optional** — prefer extending unit tests with mocked pure path only. DB integration not required.

- [ ] **Step 3: `npx tsc --noEmit`** — Expected: PASS

---

### Task 4: `match-report` use-cases

**Files:**

- Create: `src/services/match-report.ts`
- Modify: `src/services/match-service.ts` — add `findInProgressMatchesByHost` if missing (mirror `findPendingMatchesByHost`)

**Interfaces:**

- Consumes: `getMatchById`, `MatchWithPlayers`, `MatchServiceError`, rating-update functions, `assertBothTeamsHaveActivePlayers`
- Produces:
  - `setQuitters(matchId: string, quitterSlots: number[]): Promise<MatchWithPlayers>`
  - `completeMatch(matchId: string, winningTeam: 1 | 2, quitterSlots: number[]): Promise<MatchWithPlayers>`
  - `cancelInProgressMatch(matchId: string): Promise<MatchWithPlayers>`

- [ ] **Step 1: Add host IN_PROGRESS lookup** in `match-service.ts`:

```ts
export async function findInProgressMatchesByHost(
  hostDiscordId: string,
): Promise<MatchWithPlayers[]> {
  return prisma.match.findMany({
    where: { hostDiscordId, status: 'IN_PROGRESS' },
    include: {
      players: {
        include: { player: true },
        orderBy: { slot: 'asc' },
      },
    },
    orderBy: { createdAt: 'desc' },
  });
}
```

- [ ] **Step 2: Implement `match-report.ts`**

```ts
import { prisma } from '../lib/prisma.js';
import { createLogger } from '../lib/logger.js';
import { getMatchById, MatchServiceError, type MatchWithPlayers } from './match-service.js';
import {
  applyMatchRatings,
  applyQuitterPenalties,
  assertBothTeamsHaveActivePlayers,
  type RatingRosterEntry,
} from './rating-update.js';

const log = createLogger('match-report');

function requireInProgress(match: MatchWithPlayers | null): MatchWithPlayers {
  if (!match) {
    throw new MatchServiceError('This match was not found.');
  }
  if (match.status !== 'IN_PROGRESS') {
    throw new MatchServiceError('This match is not in progress.');
  }
  return match;
}

function toRatingEntries(match: MatchWithPlayers, quitterSlots: Set<number>): RatingRosterEntry[] {
  return match.players.map((p) => ({
    playerId: p.playerId,
    slot: p.slot,
    heroId: p.heroId,
    isQuitter: quitterSlots.has(p.slot),
  }));
}

export async function setQuitters(
  matchId: string,
  quitterSlots: number[],
): Promise<MatchWithPlayers> {
  const match = requireInProgress(await getMatchById(matchId));
  const quitterSet = new Set(quitterSlots);

  for (const slot of quitterSlots) {
    if (!match.players.some((p) => p.slot === slot)) {
      throw new MatchServiceError(`No player in slot ${slot}.`);
    }
  }

  await prisma.$transaction(
    match.players.map((p) =>
      prisma.matchPlayer.update({
        where: { matchId_playerId: { matchId, playerId: p.playerId } },
        data: { isQuitter: quitterSet.has(p.slot) },
      }),
    ),
  );

  const updated = await getMatchById(matchId);
  log.info({ matchId, quitterSlots }, 'Quitters updated');
  return updated!;
}

export async function completeMatch(
  matchId: string,
  winningTeam: 1 | 2,
  quitterSlots: number[],
): Promise<MatchWithPlayers> {
  const match = requireInProgress(await getMatchById(matchId));
  const quitterSet = new Set(quitterSlots);
  const entries = toRatingEntries(match, quitterSet);
  const active = entries.filter((e) => !e.isQuitter);
  assertBothTeamsHaveActivePlayers(active);

  await prisma.$transaction(async (tx) => {
    for (const p of match.players) {
      const isQuitter = quitterSet.has(p.slot);
      const won =
        !isQuitter && ((winningTeam === 1 && p.slot <= 6) || (winningTeam === 2 && p.slot > 6));
      await tx.matchPlayer.update({
        where: { matchId_playerId: { matchId, playerId: p.playerId } },
        data: {
          isQuitter,
          result: won ? 'WIN' : 'LOSS',
        },
      });
    }

    await applyQuitterPenalties(entries, tx);
    await applyMatchRatings(entries, winningTeam, tx);

    await tx.match.update({
      where: { id: matchId },
      data: { status: 'COMPLETED' },
    });
  });

  const updated = await getMatchById(matchId);
  log.info({ matchId, winningTeam, quitterSlots }, 'Match completed');
  return updated!;
}

export async function cancelInProgressMatch(matchId: string): Promise<MatchWithPlayers> {
  const match = requireInProgress(await getMatchById(matchId));
  const quitterSlots = match.players.filter((p) => p.isQuitter).map((p) => p.slot);
  const entries = toRatingEntries(match, new Set(quitterSlots));

  await prisma.$transaction(async (tx) => {
    if (quitterSlots.length > 0) {
      await applyQuitterPenalties(entries, tx);
    }
    await tx.match.update({
      where: { id: matchId },
      data: { status: 'CANCELLED' },
    });
  });

  const updated = await getMatchById(matchId);
  log.info({ matchId, quitterSlots }, 'In-progress match cancelled');
  return updated!;
}
```

- [ ] **Step 3: `npx tsc --noEmit`** — Expected: PASS

---

### Task 5: Embeds + in-progress buttons

**Files:**

- Modify: `src/services/lobby-preview.ts`
- Modify: `src/services/rating-preview.ts` — pass `isQuitter` onto `LobbyRatingPlayerLine` when available
- Modify: `src/services/lobby-actions.ts` — sync modes

**Interfaces:**

- Produces:
  - `LOBBY_CUSTOM_IDS.reportWinner = 'match:report'`
  - `LOBBY_CUSTOM_IDS.quitters = 'match:quitters'`
  - `LOBBY_CUSTOM_IDS.cancelInProgress = 'match:cancel'`
  - `buildMatchReportButtons(): ActionRowBuilder<ButtonBuilder>[]`
  - `buildMatchCompletedEmbed(matchId, players, options): EmbedBuilder`
  - `LobbySyncMode` includes `'completed'`
  - `formatTeamLinesFromPreview` appends ` 🚪` when `player.isQuitter`

- [ ] **Step 1: Extend `LobbyRatingPlayerLine`**

```ts
export interface LobbyRatingPlayerLine {
  slot: number;
  nick: string;
  globalOrdinal: number;
  heroOrdinal: number;
  isQuitter?: boolean;
}
```

In `loadLobbyRatingPreview` / a small mapper used by sync: set `isQuitter` from `MatchPlayer.isQuitter` when building display lines (either extend `matchPlayersToRatingEntries` + preview load, or merge flags after preview returns).

- [ ] **Step 2: Format quitters + completed embed + report buttons**

In `lobby-preview.ts`:

```ts
// In formatTeamLinesFromPreview map:
const quitterMark = player.isQuitter ? ' 🚪' : '';
return `\`${nick}   ${global} / ${hero}\`${quitterMark}`;

export const LOBBY_CUSTOM_IDS = {
  // ...existing
  reportWinner: 'match:report',
  quitters: 'match:quitters',
  cancelInProgress: 'match:cancel',
} as const;

export function buildMatchReportButtons(): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(LOBBY_CUSTOM_IDS.reportWinner)
        .setLabel('Report Winner')
        .setEmoji('🏆')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(LOBBY_CUSTOM_IDS.quitters)
        .setLabel('Quitters')
        .setEmoji('🚪')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(LOBBY_CUSTOM_IDS.cancelInProgress)
        .setLabel('Cancel')
        .setStyle(ButtonStyle.Secondary),
    ),
  ];
}

export function buildMatchCompletedEmbed(
  matchId: string,
  players: LobbyPlayer[],
  options: {
    ratingPreview?: LobbyRatingPreview;
    winningTeam: 1 | 2;
  },
): EmbedBuilder {
  // Title Match Completed; description which team won; team fields + ordinals; color gold/green; no buttons via sync
}
```

- [ ] **Step 3: Update `syncLobbyDiscordMessage`**

```ts
export type LobbySyncMode = 'pending' | 'started' | 'cancelled' | 'completed';

// mode === 'started':
components: buildMatchReportButtons(),

// mode === 'completed':
embeds: [buildMatchCompletedEmbed(...)],
components: [],
```

For `completed`, derive `winningTeam` from `MatchPlayer.result` / slots (any WIN on slots 1–6 ⇒ team 1).

- [ ] **Step 4: Verify `startLobbyMatch` still syncs `started`** — buttons should now appear. Manually or via code review.

---

### Task 6: Discord interaction wizard

**Files:**

- Create: `src/handlers/match-interactions.ts` (prefer new file — `lobby-interactions.ts` is already large)
- Modify: `src/events/interaction-create.ts` to route `match:` customIds
- Modify: `src/services/lobby-actions.ts` — helpers to resolve IN_PROGRESS match by message id + auth

**Interfaces:**

- Consumes: `assertCanManageMatch`, `setQuitters`, `completeMatch`, `cancelInProgressMatch`, `syncLobbyDiscordMessage`
- CustomId conventions (≤100 chars):
  - Entry: `match:report` | `match:quitters` | `match:cancel` (message = lobby message)
  - Report wizard select: `match:rw:q:{matchId}`
  - Report skip quitters: `match:rw:skip:{matchId}`
  - Winner buttons: `match:rw:win:{matchId}:{team}:{slotsCsv}` where `team` is `1`|`2`, `slotsCsv` e.g. `1-3-7` or empty `-`
  - Confirm: `match:rw:ok:{matchId}:{team}:{slotsCsv}`
  - Cancel confirm: `match:cancel:ok:{matchId}` / `match:cancel:no:{matchId}`
  - Quitters-only select: `match:qset:{matchId}`

**Helper to collect member role IDs:**

```ts
function memberRoleIds(interaction: { member: unknown }): string[] {
  const member = interaction.member;
  if (member && typeof member === 'object' && 'roles' in member) {
    const roles = (member as { roles: { cache?: Map<string, unknown>; valueOf?: unknown } }).roles;
    if (roles && 'cache' in roles && roles.cache instanceof Map) {
      return [...roles.cache.keys()];
    }
    if (Array.isArray(roles)) {
      return roles as string[];
    }
  }
  return [];
}
```

(Use discord.js `GuildMember.roles.cache` when `member` is a GuildMember.)

- [ ] **Step 1: Resolve IN_PROGRESS by message + auth** in `lobby-actions.ts`:

```ts
export async function resolveInProgressMatchByMessageId(input: {
  messageId: string;
  actorDiscordId: string;
  memberRoleIds: string[];
}): Promise<MatchWithPlayers> {
  const match = await getMatchByDiscordMessageId(input.messageId);
  if (!match) throw new MatchServiceError('This match was not found.');
  if (match.status !== 'IN_PROGRESS') {
    throw new MatchServiceError('This match is not in progress.');
  }
  assertCanManageMatch({
    hostDiscordId: match.hostDiscordId,
    actorDiscordId: input.actorDiscordId,
    memberRoleIds: input.memberRoleIds,
  });
  return match;
}
```

- [ ] **Step 2: Implement wizard handlers** in `match-interactions.ts`

Flow for **Report Winner**:

1. Button `match:report` → ephemeral: StringSelect (min 0 / max roster size) of players + Skip button; pre-set default values from `isQuitter` if Discord allows (Discord select `setDefault` on options)
2. Select submit → ephemeral update: Team A / Team B buttons with slots encoded
3. Winner click → confirm summary + Confirm button
4. Confirm → `completeMatch` → `syncLobbyDiscordMessage(..., 'completed')` → ephemeral success

Flow for **Quitters**:

1. Select → `setQuitters` → `syncLobbyDiscordMessage(..., 'started')` → ephemeral “Quitters updated.”

Flow for **Cancel**:

1. Confirm buttons → `cancelInProgressMatch` → sync `cancelled`

All errors: ephemeral English via `MatchServiceError.message`.

- [ ] **Step 3: Wire router** in `interaction-create.ts`:

```ts
if (interaction.customId.startsWith('match:')) {
  await handleMatchInteraction(interaction);
  return;
}
```

- [ ] **Step 4: Manual check list** (dev bot): start match → three buttons visible → quitters flag → report winner path → completed embed.

---

### Task 7: Slash `/match` mirrors

**Files:**

- Create: `src/commands/match/match.ts`

**Interfaces:**

- Consumes: same use-cases + `findInProgressMatchesByHost` / `getMatchById` + auth
- Subcommands:
  - `quitters` — options: `slots` (string `"1,3,7"`) or repeated integer options; `match_id` optional
  - `complete` — `winner` (`A`|`B`), `quitters` optional string, `match_id` optional
  - `cancel` — `match_id` optional

Resolve match: explicit `match_id`, else sole IN_PROGRESS for host **or** if actor is mod, require `match_id`. Simpler v1 rule:

- Always resolve by `match_id` if provided
- Else if actor is host: sole IN_PROGRESS for that host (error if 0 or >1)
- Else (mod only): require `match_id`

- [ ] **Step 1: Implement command** following `src/commands/lobby/lobby.ts` patterns (`deferReply` ephemeral, catch `MatchServiceError`).

- [ ] **Step 2: After mutations, call `syncLobbyDiscordMessage`** with client from `interaction.client`.

- [ ] **Step 3: Restart / auto-deploy** — confirm `/match` appears in guild.

---

### Task 8: Docs polish + final verification

**Files:**

- Modify: `.cursor/rules/openskill-rating.mdc` — one line pointing quitter N=3 synthetic `rate()` vs dummy (keep in sync with implementation)
- Optionally note match-report modules in `project-structure.mdc` if that rule lists services

- [ ] **Step 1: Update openskill-rating rule** quitters row to:

```md
| **Quitters** | `MatchPlayer.isQuitter` → N=3 OpenSkill synthetic losses (`rate` vs strong dummy) on global **and** hero; excluded from match Bayesian `rate()`. Host/mod may still complete remaining players or cancel (cancel applies quit penalties if flagged). |
```

- [ ] **Step 2: Run full tests**

Run: `npm test`
Expected: PASS (existing + new)

- [ ] **Step 3: Run typecheck**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 4: Manual E2E checklist**

1. Register lobby → Start Match
2. Quitters button → flags show 🚪; match still In Progress
3. Report Winner → pre-selected quitters → pick winner → confirm → Completed embed
4. New match → Cancel with no quitters → Cancelled, ratings unchanged
5. New match → flag quitter → Cancel → quitter μ drops, status Cancelled
6. Mod with `MATCH_MOD_ROLE_ID` can report; random user cannot
7. `/match complete` mirrors button path

---

## Spec coverage (self-review)

| Spec requirement                                             | Task    |
| ------------------------------------------------------------ | ------- |
| Host + `MATCH_MOD_ROLE_ID`                                   | 1, 6, 7 |
| Three in-progress buttons                                    | 5, 6    |
| Report Winner: quitters → winner → confirm; pre-select flags | 6       |
| Quitters button flags only                                   | 4, 6    |
| Complete + `rate()` exclude quitters; N=3 synthetic          | 2, 3, 4 |
| Cancel void vs cancel+penalties                              | 4, 6    |
| Empty team after quitters rejects complete                   | 2, 4    |
| Completed embed, no buttons, no deltas                       | 5       |
| Slash mirrors                                                | 7       |
| Vitest for rating helpers / guards                           | 2       |
| Single transaction complete/cancel                           | 4       |
| Env docs                                                     | 1, 8    |

No TBD placeholders; interface names consistent across tasks (`completeMatch`, `setQuitters`, `cancelInProgressMatch`, `applyQuitterPenalties`, `applyMatchRatings`).
