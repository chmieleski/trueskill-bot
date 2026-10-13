# Lobby Captain Draft Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A host/mod clicks **Captain draft** on a UDBR lobby; a thread runs captain vote → coin choice → snake pick → side → simultaneous hero pick, then the bot rewrites the PENDING lobby so slot = hero.

**Architecture:** New `apps/bot/src/services/lobby-draft/` module. Pure phase engine (`draft-logic.ts`, fully unit-tested) + JSON state on a new `LobbyDraft` row + use-case layer (`draft-actions.ts`) that load → mutate → optimistic-save (with retry) → post log / sync live embed / schedule timer. The lobby is frozen by one guard inside `replaceMatchRoster` (every roster write funnels through it) and `setMatchPlayersLocked`; finalize passes `completeLobbyDraftId` to bypass the guard and mark the draft COMPLETE in the same transaction.

**Tech Stack:** TypeScript ESM, discord.js v14, Prisma (`@dbz/db`), vitest.

**Spec:** `docs/superpowers/specs/2026-10-13-lobby-captain-draft-design.md`

## Global Constraints

- Scope: `game:warcraft3_udbr` — button and start gated to `profile.heroBinding === 'slot_bound'`; the engine reads sides/heroes from `GameProfile` (`teamForSlot`, `teamNames`) and the `Hero` table, never WC3 constants.
- All user-facing strings, logs, ids in **English**.
- ESM imports use `.js`; Prisma via `apps/bot/src/lib/prisma.ts`; types from `@dbz/db`.
- Every DB read/write is keyed by the draft's own `matchId`/`leagueId`; no cross-league state.
- Timers (seconds): VOTE 60, COIN_CHOICE 30, PICK 45, SIDE 30, HERO 120. Not configurable.
- Minimum to start: ≥4 lobby players and ≥2 linked. Removal that would make a final 2v2 impossible is refused with: `Need at least 2v2 — replace the player or cancel the draft.`
- Frozen-lobby message: `A captain draft is running for this lobby. Cancel the draft to edit the roster.`
- Hero menu text: `Pick up to 2 heroes you'd play. Optional — pick none and you'll get a random hero. Press **Lock in** when you're done.`
- League flag `League.lobbyCaptainDraftEnabled`, default `false`, set via `/league_config set captain_draft enabled:`; copied on rollover.
- No new env vars (no SSM changes).
- Run `pnpm format:check` (root) before claiming done; CI gates on Prettier.
- Commits: Conventional Commits, no Claude co-author/attribution lines.

## Review Focus

1. Many linked players vote / pick heroes in the same second → every valid action lands (optimistic-save conflict retries), nobody sees "no longer valid" for a valid click. Test: Task 7 `retries on save conflict`.
2. Staff replaces a **captain** with an unlinked nick → refused (captain must be able to click). Test: Task 4 `refuses unlinked captain replacement`.
3. The captain on the clock leaves and is removed → teammate becomes captain and gets a fresh deadline (not the leftover seconds). Test: Task 4 `clockChanged when on-clock captain changes`.
4. Host starts or cancels the lobby mid-draft → draft CANCELLED with a thread notice, lobby not blocked. Test: Task 9 `lifecycle cancels active draft`.
5. Odd/full lobbies (5 players → 3v2; 12 → 6v6) → every player gets a distinct hero of their side, nobody unassigned. Test: Task 3 `assigns every player a distinct side hero`.

---

## File Structure

| File                                                                             | Responsibility                                           |
| -------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `packages/db/prisma/schema.prisma`                                               | `LobbyDraft` model; `League.lobbyCaptainDraftEnabled`    |
| `packages/db/prisma/migrations/20261013120000_lobby_captain_draft/migration.sql` | DDL                                                      |
| `apps/bot/src/services/lobby-draft/draft-types.ts`                               | State types, constants, errors, `initialLobbyDraftState` |
| `apps/bot/src/services/lobby-draft/draft-logic.ts`                               | Pure phase engine                                        |
| `apps/bot/src/services/lobby-draft/hero-assign.ts`                               | Pure randomized max-matching hero assignment             |
| `apps/bot/src/services/lobby-draft/draft-state.ts`                               | Parse/serialize, load, optimistic save                   |
| `apps/bot/src/services/lobby-draft/draft-ui.ts`                                  | Custom ids, embed, components, ephemeral menus           |
| `apps/bot/src/services/lobby-draft/draft-timer.ts`                               | Deadline timers + boot rehydrate                         |
| `apps/bot/src/services/lobby-draft/draft-actions.ts`                             | Use-cases (start, vote, …, finalize, cancel)             |
| `apps/bot/src/services/lobby-draft/index.ts`                                     | Barrel                                                   |
| `apps/bot/src/services/match/match-service.ts`                                   | Freeze guard + `completeLobbyDraftId`                    |
| `apps/bot/src/services/lobby/{lobby-preview,discord-sync,lifecycle}.ts`          | Button, visibility, start/cancel hooks                   |
| `apps/bot/src/discord/interactions/lobby-draft-interactions.ts`                  | Discord adapter                                          |
| `apps/bot/src/events/interaction-create.ts`, `apps/bot/src/index.ts`             | Routing, rehydrate                                       |
| League config files (Task 1)                                                     | Flag plumbing                                            |

---

### Task 1: Schema, migration, league flag (`general` plumbing, gated by `game:warcraft3_udbr` use)

**Files:**

- Modify: `packages/db/prisma/schema.prisma` (model `League` ~line 46; add model after `HeroDraft` ~line 662)
- Create: `packages/db/prisma/migrations/20261013120000_lobby_captain_draft/migration.sql`
- Modify: `apps/bot/src/services/league/league-wc3stats.ts` (`ResolvedLeagueConfig` ~line 80, `resolveLeagueConfig` ~line 127)
- Modify: `apps/bot/src/services/league/league-balance-config.ts` (next to `setShowSideWinLoss`)
- Modify: `apps/bot/src/services/league/league-rollover.ts:483-488`
- Modify: `apps/bot/src/commands/config/league-config.ts` (subcommand after `side_win_loss` ~line 245; handler after ~line 712)
- Test: `apps/bot/src/services/league/league-balance-config.test.ts`

**Interfaces:**

- Produces: Prisma `LobbyDraft` model (`prisma.lobbyDraft`), `League.lobbyCaptainDraftEnabled: boolean`, `ResolvedLeagueConfig.lobbyCaptainDraftEnabled: boolean`, `setLobbyCaptainDraftEnabled(leagueId: string, enabled: boolean): Promise<void>`.

- [ ] **Step 1: Schema.** In `model League`, after `balanceKiStrengthEnabled`:

```prisma
  /// Lobby "Captain draft" button (vote captains → snake → side → hero pick). UDBR only.
  lobbyCaptainDraftEnabled       Boolean      @default(false)
```

After `model HeroDraft { … }`:

```prisma
/// Lobby captain draft (vote → snake → side → simultaneous hero pick); one public thread per draft.
model LobbyDraft {
  id              String   @id @default(cuid())
  guildId         String
  leagueId        String
  matchId         String
  parentChannelId String
  threadId        String
  /// Lobby host at draft start (manage/cancel auth uses host-or-mod).
  hostDiscordId   String
  /// ACTIVE | COMPLETE | CANCELLED
  status          String
  state           Json
  liveMessageId   String?
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  @@index([matchId, status])
  @@index([guildId, status])
  @@index([threadId])
}
```

- [ ] **Step 2: Migration SQL** (`migration.sql`):

```sql
-- AlterTable
ALTER TABLE "League" ADD COLUMN "lobbyCaptainDraftEnabled" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "LobbyDraft" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "leagueId" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "parentChannelId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "hostDiscordId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "state" JSONB NOT NULL,
    "liveMessageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LobbyDraft_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LobbyDraft_matchId_status_idx" ON "LobbyDraft"("matchId", "status");
CREATE INDEX "LobbyDraft_guildId_status_idx" ON "LobbyDraft"("guildId", "status");
CREATE INDEX "LobbyDraft_threadId_idx" ON "LobbyDraft"("threadId");
```

- [ ] **Step 3: Generate + verify migration matches schema**

Run: `pnpm db:up && pnpm db:migrate` (applies locally; must report no drift / no new migration generated beyond this one), then `pnpm db:generate`.
Expected: client regenerated; `prisma.lobbyDraft` exists.

- [ ] **Step 4: Failing test** — append to `league-balance-config.test.ts` (follow the file's existing `prisma.league.update` mock; if the mock is named differently, reuse it):

```ts
describe('setLobbyCaptainDraftEnabled', () => {
  it('writes the flag on the league row', async () => {
    await setLobbyCaptainDraftEnabled('league-1', true);
    expect(leagueUpdate).toHaveBeenCalledWith({
      where: { id: 'league-1' },
      data: { lobbyCaptainDraftEnabled: true },
    });
  });
});
```

Run: `pnpm --filter @dbz/bot exec vitest run src/services/league/league-balance-config.test.ts` → FAIL (not exported).

- [ ] **Step 5: Implement.** In `league-balance-config.ts`:

```ts
/** Enable or disable the lobby "Captain draft" button for this league. */
export async function setLobbyCaptainDraftEnabled(
  leagueId: string,
  enabled: boolean,
): Promise<void> {
  await prisma.league.update({
    where: { id: leagueId },
    data: { lobbyCaptainDraftEnabled: enabled },
  });
}
```

Export it from `services/league/index.ts` the same way `setShowSideWinLoss` is exported.

In `league-wc3stats.ts`: add `lobbyCaptainDraftEnabled: boolean;` to `ResolvedLeagueConfig` and `lobbyCaptainDraftEnabled: row?.lobbyCaptainDraftEnabled === true,` in `resolveLeagueConfig`.

In `league-rollover.ts` next to `balanceKiStrengthEnabled: source.balanceKiStrengthEnabled,` add `lobbyCaptainDraftEnabled: source.lobbyCaptainDraftEnabled,`.

In `league-config.ts`, subcommand (after `side_win_loss`):

```ts
      .addSubcommand((subcommand) =>
        withSubcommandLeagueOption(
          subcommand
            .setName('captain_draft')
            .setDescription('Show the lobby Captain draft button (UDBR)')
            .addBooleanOption((option) =>
              option
                .setName('enabled')
                .setDescription('On: hosts/mods can start a captain draft from the lobby.')
                .setRequired(true),
            ),
        ),
      )
```

Handler (after the `side_win_loss` block):

```ts
if (subcommand === 'captain_draft') {
  const leagueId = await requireLeagueId(interaction);
  if (!leagueId) return;

  const enabled = interaction.options.getBoolean('enabled', true);
  await setLobbyCaptainDraftEnabled(leagueId, enabled);
  log.info(
    { guildId: interaction.guildId, leagueId, enabled, userId: interaction.user.id },
    'Lobby captain draft setting updated',
  );
  await interaction.reply({
    content: enabled ? 'Lobby captain draft enabled.' : 'Lobby captain draft disabled.',
    flags: MessageFlags.Ephemeral,
  });
  return;
}
```

Fix any test fixtures that build a full `League`/`ResolvedLeagueConfig` object and now miss the field (run typecheck to find them).

- [ ] **Step 6: Verify**

Run: `pnpm --filter @dbz/bot exec vitest run src/services/league` and `pnpm typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/db/prisma apps/bot/src/services/league apps/bot/src/commands/config
git commit -m "feat(lobby-draft): add LobbyDraft table and captain_draft league flag"
```

---

### Task 2: Types + vote / coin / snake / side engine (`game:warcraft3_udbr`)

**Files:**

- Create: `apps/bot/src/services/lobby-draft/draft-types.ts`
- Create: `apps/bot/src/services/lobby-draft/draft-logic.ts`
- Create: `apps/bot/src/services/lobby-draft/test-fixtures.ts` (shared test helpers)
- Test: `apps/bot/src/services/lobby-draft/draft-logic.test.ts`

**Interfaces:**

- Consumes: `captainIndexForPick(pickIndex, captainCount)` from `../captain-draft/draft-logic.js`; `GameProfile`, `TeamId`, `teamForSlot` from `../../domain/game-profile.js`; `normalizeNick` from `../player/player-nick.js`.
- Produces (exact):
  - types `LobbyDraftPhase`, `LobbyDraftStatus`, `CoinChoice`, `TeamIndex`, `LobbyDraftParticipant`, `LobbyDraftTeam`, `HeroAssignment`, `LobbyDraftState`
  - consts `LOBBY_DRAFT_PHASE_SECONDS`, `LOBBY_DRAFT_MIN_PLAYERS`, `LOBBY_DRAFT_MIN_LINKED`, messages `NEED_2V2_MESSAGE`, `NOT_IN_DRAFT_MESSAGE`, `STALE_ACTION_MESSAGE`, `FROZEN_LOBBY_MESSAGE`, `HERO_PICK_HELP`
  - classes `LobbyDraftError`, `LobbyDraftConflictError extends LobbyDraftError`
  - `participantKey(nick): string`, `initialLobbyDraftState(participants, deadlineAt): LobbyDraftState`
  - logic: `shuffle`, `findParticipant`, `participantByDiscordId`, `nickOf`, `linkedParticipants`, `canStartLobbyDraft`, `assertCanStartLobbyDraft`, `votedCount`, `voteCounts`, `tallyVotes`, `closeVote`, `castVote`, `chooseCoin`, `pickingTeam`, `applyPick`, `applySide`, `onClockTeam`, `onClockCaptainKey`, `assertOnClock`, `teamOfKey`, `heroIdsForSide`, `clockChanged`, `closeEarlyIfDone` (HERO branch filled in Task 3)

- [ ] **Step 1: Write `draft-types.ts`**

```ts
import { normalizeNick } from '../player/player-nick.js';
import type { TeamId } from '../../domain/game-profile.js';

export type LobbyDraftPhase = 'VOTE' | 'COIN_CHOICE' | 'PICK' | 'SIDE' | 'HERO';
export type LobbyDraftStatus = 'ACTIVE' | 'COMPLETE' | 'CANCELLED';
export type CoinChoice = 'FIRST_PICK' | 'SIDE';
/** Index into `LobbyDraftState.teams`; 0 is always the coin-flip winner's team. */
export type TeamIndex = 0 | 1;

export type LobbyDraftParticipant = {
  /** Stable id inside the draft: normalized nick. */
  key: string;
  nick: string;
  /** Present only when the nick is linked to a Discord account for this game. */
  discordId?: string;
};

export type LobbyDraftTeam = {
  captainKey: string;
  /** Participant keys in draft order; captain first. */
  roster: string[];
  side: TeamId | null;
};

export type HeroAssignment = { heroId: number; how: 'wanted' | 'contested' | 'random' };

export type LobbyDraftState = {
  phase: LobbyDraftPhase;
  participants: LobbyDraftParticipant[];
  /** voter Discord id → 1–2 candidate keys. */
  votes: Record<string, string[]>;
  teams: [LobbyDraftTeam, LobbyDraftTeam] | null;
  firstPickTeam: TeamIndex | null;
  sideChooserTeam: TeamIndex | null;
  /** Global snake pick counter (0-based). */
  pickIndex: number;
  /** Participant keys not drafted yet. */
  pool: string[];
  /** participant key → 0–2 hero ids (unordered). */
  heroPrefs: Record<string, number[]>;
  heroLockedIn: string[];
  heroResult: Record<string, HeroAssignment> | null;
  deadlineAt: string | null;
  /** Human-readable history; new entries are posted to the thread. */
  log: string[];
};

export const LOBBY_DRAFT_PHASE_SECONDS: Record<LobbyDraftPhase, number> = {
  VOTE: 60,
  COIN_CHOICE: 30,
  PICK: 45,
  SIDE: 30,
  HERO: 120,
};
export const LOBBY_DRAFT_MIN_PLAYERS = 4;
export const LOBBY_DRAFT_MIN_LINKED = 2;
export const LOBBY_DRAFT_MAX_VOTES = 2;
export const LOBBY_DRAFT_MAX_HERO_PREFS = 2;

export const NEED_2V2_MESSAGE = 'Need at least 2v2 — replace the player or cancel the draft.';
export const NOT_IN_DRAFT_MESSAGE = "You're not in this draft.";
export const STALE_ACTION_MESSAGE = 'That action is no longer valid.';
export const FROZEN_LOBBY_MESSAGE =
  'A captain draft is running for this lobby. Cancel the draft to edit the roster.';
export const HERO_PICK_HELP =
  "Pick up to 2 heroes you'd play. Optional — pick none and you'll get a random hero. Press **Lock in** when you're done.";

export class LobbyDraftError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LobbyDraftError';
  }
}

/** Optimistic-save lost a race; callers reload and retry. */
export class LobbyDraftConflictError extends LobbyDraftError {
  constructor() {
    super(STALE_ACTION_MESSAGE);
    this.name = 'LobbyDraftConflictError';
  }
}

export function participantKey(nick: string): string {
  return normalizeNick(nick);
}

export function initialLobbyDraftState(
  participants: LobbyDraftParticipant[],
  deadlineAt: string | null,
): LobbyDraftState {
  return {
    phase: 'VOTE',
    participants,
    votes: {},
    teams: null,
    firstPickTeam: null,
    sideChooserTeam: null,
    pickIndex: 0,
    pool: participants.map((p) => p.key),
    heroPrefs: {},
    heroLockedIn: [],
    heroResult: null,
    deadlineAt,
    log: [],
  };
}
```

- [ ] **Step 2: Write test fixtures** (`test-fixtures.ts`)

```ts
import { getGameProfile } from '../../domain/game-profile.js';
import { WARCRAFT3_UDBR_GAME_ID } from '../../domain/games.js';
import {
  initialLobbyDraftState,
  type LobbyDraftParticipant,
  type LobbyDraftState,
} from './draft-types.js';

export const PROFILE = getGameProfile(WARCRAFT3_UDBR_GAME_ID);

export function person(nick: string, linked = true): LobbyDraftParticipant {
  return { key: nick.toLowerCase(), nick, ...(linked ? { discordId: `id-${nick}` } : {}) };
}

/** Draft past the coin flip: teams[0] = first nick, teams[1] = second, rest in pool. */
export function pickingState(nicks: string[], firstPickTeam: 0 | 1 = 0): LobbyDraftState {
  const participants = nicks.map((n) => person(n));
  const [a, b, ...rest] = participants;
  return {
    ...initialLobbyDraftState(participants, null),
    phase: 'PICK',
    teams: [
      { captainKey: a!.key, roster: [a!.key], side: null },
      { captainKey: b!.key, roster: [b!.key], side: null },
    ],
    firstPickTeam,
    sideChooserTeam: firstPickTeam === 0 ? 1 : 0,
    pool: rest.map((p) => p.key),
  };
}
```

- [ ] **Step 3: Write the failing tests** (`draft-logic.test.ts`)

```ts
import { describe, expect, it } from 'vitest';
import {
  applyPick,
  applySide,
  assertCanStartLobbyDraft,
  assertOnClock,
  castVote,
  chooseCoin,
  closeVote,
  heroIdsForSide,
  onClockTeam,
  pickingTeam,
  tallyVotes,
} from './draft-logic.js';
import { initialLobbyDraftState, LobbyDraftError, type LobbyDraftState } from './draft-types.js';
import { PROFILE, person, pickingState } from './test-fixtures.js';

describe('assertCanStartLobbyDraft', () => {
  it('needs 4 players and 2 linked', () => {
    expect(() => assertCanStartLobbyDraft([person('A'), person('B'), person('C')])).toThrow(
      LobbyDraftError,
    );
    expect(() =>
      assertCanStartLobbyDraft([
        person('A'),
        person('B', false),
        person('C', false),
        person('D', false),
      ]),
    ).toThrow(LobbyDraftError);
    expect(() =>
      assertCanStartLobbyDraft([person('A'), person('B'), person('C', false), person('D', false)]),
    ).not.toThrow();
  });
});

describe('voting', () => {
  const players = [person('A'), person('B'), person('C'), person('D', false)];

  it('rejects unlinked voters and unlinked candidates', () => {
    const state = initialLobbyDraftState(players, null);
    expect(() => castVote(state, 'id-nobody', ['a'])).toThrow("You're not in this draft.");
    expect(() => castVote(state, 'id-A', ['d'])).toThrow(
      'Only linked lobby players can be captains.',
    );
    expect(() => castVote(state, 'id-A', ['a', 'b', 'c'])).toThrow(LobbyDraftError);
  });

  it('lets a voter change their vote and allows self-votes', () => {
    let state = initialLobbyDraftState(players, null);
    state = castVote(state, 'id-A', ['a']);
    state = castVote(state, 'id-A', ['b', 'c']);
    expect(state.votes['id-A']).toEqual(['b', 'c']);
    expect(state.phase).toBe('VOTE');
  });

  it('closes early when every linked player voted', () => {
    let state = initialLobbyDraftState(players, null);
    state = castVote(state, 'id-A', ['a', 'b']);
    state = castVote(state, 'id-B', ['b']);
    state = castVote(state, 'id-C', ['a']);
    expect(state.phase).toBe('COIN_CHOICE');
    expect(new Set(state.teams!.map((t) => t.captainKey))).toEqual(new Set(['a', 'b']));
    expect(new Set(state.pool)).toEqual(new Set(['c', 'd']));
  });

  it('tallies top two and ignores votes for removed players', () => {
    const state: LobbyDraftState = {
      ...initialLobbyDraftState(players, null),
      votes: { 'id-A': ['c', 'b'], 'id-B': ['c', 'ghost'], 'id-C': ['b'] },
    };
    expect(new Set(tallyVotes(state, Math.random))).toEqual(new Set(['b', 'c']));
  });

  it('marks a random tie-break with 🎲', () => {
    const state: LobbyDraftState = {
      ...initialLobbyDraftState(players, null),
      votes: { 'id-A': ['a', 'b'], 'id-B': ['c'] },
    };
    expect(closeVote(state, Math.random).log).toContain('🎲 Tie for captain broken randomly.');
  });

  it('picks random linked captains when nobody voted', () => {
    const closed = closeVote(initialLobbyDraftState(players, null), Math.random);
    const captains = closed.teams!.map((t) => t.captainKey);
    expect(captains).toHaveLength(2);
    for (const key of captains) expect(['a', 'b', 'c']).toContain(key);
  });
});

describe('coin choice', () => {
  const base = (): LobbyDraftState => ({
    ...pickingState(['A', 'B', 'C', 'D']),
    phase: 'COIN_CHOICE',
    firstPickTeam: null,
    sideChooserTeam: null,
  });

  it('FIRST_PICK: winner picks first, loser chooses side', () => {
    const next = chooseCoin(base(), 'FIRST_PICK');
    expect(next).toMatchObject({ phase: 'PICK', firstPickTeam: 0, sideChooserTeam: 1 });
  });

  it('SIDE: winner chooses side now, loser picks first', () => {
    const next = chooseCoin(base(), 'SIDE');
    expect(next).toMatchObject({ phase: 'SIDE', firstPickTeam: 1, sideChooserTeam: 0 });
    const sided = applySide(next, 2, PROFILE.teamNames);
    expect(sided.teams![0].side).toBe(2);
    expect(sided.teams![1].side).toBe(1);
    expect(sided.phase).toBe('PICK');
  });
});

describe('snake pick', () => {
  it('follows A, B, B, A and moves to SIDE when the pool empties', () => {
    let state = pickingState(['A', 'B', 'C', 'D', 'E', 'F'], 0);
    expect([0, 1, 2, 3].map((i) => pickingTeam({ ...state, pickIndex: i }))).toEqual([0, 1, 1, 0]);
    state = applyPick(state, 'c');
    state = applyPick(state, 'd');
    state = applyPick(state, 'e');
    state = applyPick(state, 'f');
    expect(state.teams![0].roster).toEqual(['a', 'c', 'f']);
    expect(state.teams![1].roster).toEqual(['b', 'd', 'e']);
    expect(state.phase).toBe('SIDE');
  });

  it('goes straight to HERO when side was chosen before picking', () => {
    let state = pickingState(['A', 'B', 'C', 'D'], 1);
    state = {
      ...state,
      teams: [
        { ...state.teams![0], side: 1 },
        { ...state.teams![1], side: 2 },
      ],
    };
    state = applyPick(applyPick(state, 'c'), 'd');
    expect(state.phase).toBe('HERO');
  });

  it('only the on-clock captain may act', () => {
    const state = pickingState(['A', 'B', 'C', 'D'], 1);
    expect(onClockTeam(state)).toBe(1);
    expect(() => assertOnClock(state, 'id-A')).toThrow("It's not your turn.");
    expect(() => assertOnClock(state, 'id-B')).not.toThrow();
  });

  it('rejects picking someone outside the pool', () => {
    expect(() => applyPick(pickingState(['A', 'B', 'C', 'D']), 'a')).toThrow('Player not in pool.');
  });
});

describe('heroIdsForSide', () => {
  it('maps UDBR sides to slots 1–6 and 7–12', () => {
    expect(heroIdsForSide(PROFILE, 1)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(heroIdsForSide(PROFILE, 2)).toEqual([7, 8, 9, 10, 11, 12]);
  });
});
```

Run: `pnpm --filter @dbz/bot exec vitest run src/services/lobby-draft/draft-logic.test.ts` → FAIL (module missing).

- [ ] **Step 4: Implement `draft-logic.ts`**

```ts
import { captainIndexForPick } from '../captain-draft/draft-logic.js';
import { teamForSlot, type GameProfile, type TeamId } from '../../domain/game-profile.js';
import {
  LOBBY_DRAFT_MAX_VOTES,
  LOBBY_DRAFT_MIN_LINKED,
  LOBBY_DRAFT_MIN_PLAYERS,
  LobbyDraftError,
  NEED_2V2_MESSAGE,
  NOT_IN_DRAFT_MESSAGE,
  STALE_ACTION_MESSAGE,
  type CoinChoice,
  type LobbyDraftParticipant,
  type LobbyDraftState,
  type LobbyDraftTeam,
  type TeamIndex,
} from './draft-types.js';

type Rng = () => number;

/** Fisher–Yates copy. */
export function shuffle<T>(items: readonly T[], rng: Rng = Math.random): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

export function findParticipant(
  state: LobbyDraftState,
  key: string,
): LobbyDraftParticipant | undefined {
  return state.participants.find((p) => p.key === key);
}

export function participantByDiscordId(
  state: LobbyDraftState,
  discordId: string,
): LobbyDraftParticipant | undefined {
  return state.participants.find((p) => p.discordId === discordId);
}

export function nickOf(state: LobbyDraftState, key: string): string {
  return findParticipant(state, key)?.nick ?? key;
}

export function linkedParticipants(
  state: Pick<LobbyDraftState, 'participants'>,
): LobbyDraftParticipant[] {
  return state.participants.filter((p) => p.discordId);
}

/** True when a lobby roster is big enough for a captain draft (≥4 players, ≥2 linked). */
export function canStartLobbyDraft(participants: LobbyDraftParticipant[]): boolean {
  return (
    participants.length >= LOBBY_DRAFT_MIN_PLAYERS &&
    participants.filter((p) => p.discordId).length >= LOBBY_DRAFT_MIN_LINKED
  );
}

export function assertCanStartLobbyDraft(participants: LobbyDraftParticipant[]): void {
  if (!canStartLobbyDraft(participants)) {
    throw new LobbyDraftError(
      'A captain draft needs at least 4 lobby players (2v2), with at least 2 linked to Discord.',
    );
  }
}

function assertPhase(state: LobbyDraftState, phase: LobbyDraftState['phase']): void {
  if (state.phase !== phase) {
    throw new LobbyDraftError(STALE_ACTION_MESSAGE);
  }
}

function requireTeams(state: LobbyDraftState): [LobbyDraftTeam, LobbyDraftTeam] {
  if (!state.teams) {
    throw new LobbyDraftError(STALE_ACTION_MESSAGE);
  }
  return state.teams;
}

function withLog(state: LobbyDraftState, ...lines: string[]): LobbyDraftState {
  return { ...state, log: [...state.log, ...lines] };
}

/** Linked voters still in the draft who have a ballot on file. */
export function votedCount(state: LobbyDraftState): number {
  return linkedParticipants(state).filter((p) => state.votes[p.discordId!]).length;
}

/** Votes per linked candidate (ballots from people no longer in the draft are ignored). */
export function voteCounts(state: LobbyDraftState): Map<string, number> {
  const counts = new Map(linkedParticipants(state).map((p) => [p.key, 0]));
  for (const [voterId, keys] of Object.entries(state.votes)) {
    if (!participantByDiscordId(state, voterId)) continue;
    for (const key of keys) {
      if (counts.has(key)) counts.set(key, counts.get(key)! + 1);
    }
  }
  return counts;
}

/** Top two linked candidates by votes; ties broken randomly (shuffle, then stable sort). */
export function tallyVotes(state: LobbyDraftState, rng: Rng = Math.random): [string, string] {
  const counts = voteCounts(state);
  const order = shuffle([...counts.keys()], rng).sort((a, b) => counts.get(b)! - counts.get(a)!);
  if (order.length < 2) {
    throw new LobbyDraftError(NEED_2V2_MESSAGE);
  }
  return [order[0]!, order[1]!];
}

function voteSummary(state: LobbyDraftState, captains: [string, string]): string[] {
  const counts = voteCounts(state);
  const voted = [...counts.entries()].filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  if (voted.length === 0) return ['🗳️ No votes — captains chosen at random. 🎲'];
  const lines = [`🗳️ Votes: ${voted.map(([key, n]) => `${nickOf(state, key)} ${n}`).join(', ')}`];
  const cutoff = counts.get(captains[1])!;
  const tiedOut = [...counts.entries()].some(([key, n]) => n === cutoff && !captains.includes(key));
  if (tiedOut) lines.push('🎲 Tie for captain broken randomly.');
  return lines;
}

/** End voting: pick captains, flip the coin (teams[0] = winner), fill the pool. */
export function closeVote(state: LobbyDraftState, rng: Rng = Math.random): LobbyDraftState {
  assertPhase(state, 'VOTE');
  const [first, second] = tallyVotes(state, rng);
  const [winner, loser] = rng() < 0.5 ? [first, second] : [second, first];
  return withLog(
    {
      ...state,
      phase: 'COIN_CHOICE',
      teams: [
        { captainKey: winner, roster: [winner], side: null },
        { captainKey: loser, roster: [loser], side: null },
      ],
      pool: state.participants.map((p) => p.key).filter((k) => k !== winner && k !== loser),
    },
    ...voteSummary(state, [first, second]),
    `👑 Captains: ${nickOf(state, first)} and ${nickOf(state, second)}.`,
    `🪙 Coin flip won by ${nickOf(state, winner)} — choose first pick or side.`,
  );
}

export function castVote(
  state: LobbyDraftState,
  voterDiscordId: string,
  candidateKeys: string[],
  rng: Rng = Math.random,
): LobbyDraftState {
  assertPhase(state, 'VOTE');
  if (!participantByDiscordId(state, voterDiscordId)) {
    throw new LobbyDraftError(NOT_IN_DRAFT_MESSAGE);
  }
  const keys = [...new Set(candidateKeys)];
  if (keys.length < 1 || keys.length > LOBBY_DRAFT_MAX_VOTES) {
    throw new LobbyDraftError('Vote for 1 or 2 players.');
  }
  for (const key of keys) {
    if (!findParticipant(state, key)?.discordId) {
      throw new LobbyDraftError('Only linked lobby players can be captains.');
    }
  }
  const next = { ...state, votes: { ...state.votes, [voterDiscordId]: keys } };
  return closeEarlyIfDone(next, null, rng);
}

export function chooseCoin(state: LobbyDraftState, choice: CoinChoice): LobbyDraftState {
  assertPhase(state, 'COIN_CHOICE');
  const teams = requireTeams(state);
  const winner = nickOf(state, teams[0].captainKey);
  if (choice === 'FIRST_PICK') {
    return withLog(
      { ...state, phase: 'PICK', firstPickTeam: 0, sideChooserTeam: 1 },
      `${winner} takes first pick; ${nickOf(state, teams[1].captainKey)} will choose the side.`,
    );
  }
  return withLog(
    { ...state, phase: 'SIDE', firstPickTeam: 1, sideChooserTeam: 0 },
    `${winner} chooses the side; ${nickOf(state, teams[1].captainKey)} picks first.`,
  );
}

/** Team whose captain makes pick number `state.pickIndex`. */
export function pickingTeam(state: LobbyDraftState): TeamIndex {
  const first = state.firstPickTeam ?? 0;
  return captainIndexForPick(state.pickIndex, 2) === 0 ? first : first === 0 ? 1 : 0;
}

function phaseAfterPicks(state: LobbyDraftState): LobbyDraftState['phase'] {
  return requireTeams(state)[0].side ? 'HERO' : 'SIDE';
}

export function applyPick(state: LobbyDraftState, key: string): LobbyDraftState {
  assertPhase(state, 'PICK');
  const teams = requireTeams(state);
  if (!state.pool.includes(key)) {
    throw new LobbyDraftError('Player not in pool.');
  }
  const t = pickingTeam(state);
  const nextTeams = teams.map((team, i) =>
    i === t ? { ...team, roster: [...team.roster, key] } : team,
  ) as [LobbyDraftTeam, LobbyDraftTeam];
  const pool = state.pool.filter((k) => k !== key);
  const next: LobbyDraftState = {
    ...state,
    teams: nextTeams,
    pool,
    pickIndex: state.pickIndex + 1,
  };
  return withLog(
    { ...next, phase: pool.length === 0 ? phaseAfterPicks(next) : 'PICK' },
    `${nickOf(state, teams[t].captainKey)} picked ${nickOf(state, key)}.`,
  );
}

export function applySide(
  state: LobbyDraftState,
  side: TeamId,
  teamNames: { 1: string; 2: string },
): LobbyDraftState {
  assertPhase(state, 'SIDE');
  const teams = requireTeams(state);
  const chooser = state.sideChooserTeam ?? 0;
  const other: TeamId = side === 1 ? 2 : 1;
  const nextTeams = teams.map((team, i) => ({ ...team, side: i === chooser ? side : other })) as [
    LobbyDraftTeam,
    LobbyDraftTeam,
  ];
  return withLog(
    { ...state, teams: nextTeams, phase: state.pool.length > 0 ? 'PICK' : 'HERO' },
    `${nickOf(state, teams[chooser].captainKey)} chose ${teamNames[side]}.`,
  );
}

/** Team that must act now, or null in simultaneous phases. */
export function onClockTeam(state: LobbyDraftState): TeamIndex | null {
  if (state.phase === 'COIN_CHOICE') return 0;
  if (state.phase === 'PICK') return pickingTeam(state);
  if (state.phase === 'SIDE') return state.sideChooserTeam ?? 0;
  return null;
}

export function onClockCaptainKey(state: LobbyDraftState): string | null {
  const t = onClockTeam(state);
  return t === null || !state.teams ? null : state.teams[t].captainKey;
}

export function assertOnClock(state: LobbyDraftState, actorDiscordId: string): void {
  const key = onClockCaptainKey(state);
  if (!key) {
    throw new LobbyDraftError(STALE_ACTION_MESSAGE);
  }
  if (findParticipant(state, key)?.discordId !== actorDiscordId) {
    throw new LobbyDraftError("It's not your turn.");
  }
}

export function teamOfKey(state: LobbyDraftState, key: string): TeamIndex | null {
  const idx = state.teams?.findIndex((t) => t.roster.includes(key)) ?? -1;
  return idx === 0 || idx === 1 ? idx : null;
}

/** Slot-bound hero ids for one side (slot = hero). */
export function heroIdsForSide(profile: GameProfile, side: TeamId): number[] {
  return Array.from({ length: profile.slotCount }, (_, i) => i + 1).filter(
    (slot) => teamForSlot(profile, slot) === side,
  );
}

/** A new deadline is needed when the phase, the pick, or the on-clock captain changed. */
export function clockChanged(prev: LobbyDraftState, next: LobbyDraftState): boolean {
  return (
    prev.phase !== next.phase ||
    prev.pickIndex !== next.pickIndex ||
    onClockCaptainKey(prev) !== onClockCaptainKey(next)
  );
}

/**
 * Close simultaneous phases early: VOTE when every linked player voted,
 * HERO when every linked player locked in (HERO needs `profile`).
 */
export function closeEarlyIfDone(
  state: LobbyDraftState,
  profile: GameProfile | null,
  rng: Rng = Math.random,
): LobbyDraftState {
  const linked = linkedParticipants(state);
  if (state.phase === 'VOTE' && votedCount(state) === linked.length) {
    return closeVote(state, rng);
  }
  return state;
}
```

- [ ] **Step 5: Run tests** — same command → PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/bot/src/services/lobby-draft
git commit -m "feat(lobby-draft): add vote, coin, snake and side engine"
```

---

### Task 3: Hero preferences + randomized max-matching assignment (`game:warcraft3_udbr`)

**Files:**

- Create: `apps/bot/src/services/lobby-draft/hero-assign.ts`
- Modify: `apps/bot/src/services/lobby-draft/draft-logic.ts` (add hero functions; fill HERO branch of `closeEarlyIfDone`)
- Test: `apps/bot/src/services/lobby-draft/hero-assign.test.ts`, extend `draft-logic.test.ts`

**Interfaces:**

- Produces: `assignHeroes(players: Array<{ key: string; wanted: number[] }>, heroes: number[], rng?): Record<string, HeroAssignment>`; logic `setHeroPrefs(state, actorDiscordId, heroIds, profile)`, `lockInHero(state, actorDiscordId, profile, rng?)`, `resolveHeroPhase(state, profile, rng?)`, `heroLockedInCount(state)`.

- [ ] **Step 1: Failing tests** (`hero-assign.test.ts`)

```ts
import { describe, expect, it } from 'vitest';
import { assignHeroes } from './hero-assign.js';

const HEROES = [1, 2, 3, 4, 5, 6];

describe('assignHeroes', () => {
  it('gives uncontested wishes as wanted', () => {
    const r = assignHeroes(
      [
        { key: 'a', wanted: [1] },
        { key: 'b', wanted: [2, 3] },
      ],
      HEROES,
    );
    expect(r.a).toEqual({ heroId: 1, how: 'wanted' });
    expect(r.b!.how).toBe('wanted');
    expect([2, 3]).toContain(r.b!.heroId);
  });

  it('satisfies both when a flexible player can step aside (A{1,2}, B{1})', () => {
    for (let i = 0; i < 50; i += 1) {
      const r = assignHeroes(
        [
          { key: 'a', wanted: [1, 2] },
          { key: 'b', wanted: [1] },
        ],
        HEROES,
      );
      expect(r.b!.heroId).toBe(1);
      expect(r.a!.heroId).toBe(2);
    }
  });

  it('true clash: one wins (contested), loser gets a random free hero', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i += 1) {
      const r = assignHeroes(
        [
          { key: 'a', wanted: [1] },
          { key: 'b', wanted: [1] },
        ],
        HEROES,
      );
      const winner = r.a!.heroId === 1 ? 'a' : 'b';
      const loser = winner === 'a' ? 'b' : 'a';
      expect(r[winner]).toEqual({ heroId: 1, how: 'contested' });
      expect(r[loser]!.how).toBe('random');
      expect(r[loser]!.heroId).not.toBe(1);
      seen.add(winner);
    }
    expect(seen).toEqual(new Set(['a', 'b']));
  });

  it('assigns every player a distinct side hero (6 players, empty prefs)', () => {
    const players = ['a', 'b', 'c', 'd', 'e', 'f'].map((key) => ({ key, wanted: [] }));
    const r = assignHeroes(players, HEROES);
    expect(new Set(Object.values(r).map((x) => x.heroId))).toEqual(new Set(HEROES));
    expect(Object.values(r).every((x) => x.how === 'random')).toBe(true);
  });

  it('throws when the side cannot seat everyone', () => {
    const players = Array.from({ length: 7 }, (_, i) => ({ key: `p${i}`, wanted: [] }));
    expect(() => assignHeroes(players, HEROES)).toThrow();
  });
});
```

Append to `draft-logic.test.ts`:

```ts
import { lockInHero, resolveHeroPhase, setHeroPrefs } from './draft-logic.js';

function heroState(): LobbyDraftState {
  const base = pickingState(['A', 'B', 'C', 'D', 'E']);
  return {
    ...base,
    phase: 'HERO',
    participants: [...base.participants.slice(0, 4), person('E', false)],
    pool: [],
    teams: [
      { captainKey: 'a', roster: ['a', 'c', 'e'], side: 1 },
      { captainKey: 'b', roster: ['b', 'd'], side: 2 },
    ],
  };
}

describe('hero phase', () => {
  it('accepts 0–2 heroes of the player side only', () => {
    const s = heroState();
    expect(setHeroPrefs(s, 'id-A', [], PROFILE).heroPrefs.a).toEqual([]);
    expect(setHeroPrefs(s, 'id-A', [1, 2], PROFILE).heroPrefs.a).toEqual([1, 2]);
    expect(() => setHeroPrefs(s, 'id-A', [7], PROFILE)).toThrow(
      'Pick up to 2 heroes from your side.',
    );
    expect(() => setHeroPrefs(s, 'id-A', [1, 2, 3], PROFILE)).toThrow(
      'Pick up to 2 heroes from your side.',
    );
    expect(() => setHeroPrefs(s, 'id-X', [1], PROFILE)).toThrow("You're not in this draft.");
  });

  it('resolves when every linked player locked in; unlinked get random heroes', () => {
    let s = heroState();
    for (const id of ['id-A', 'id-B', 'id-C']) s = lockInHero(s, id, PROFILE);
    expect(s.heroResult).toBeNull();
    s = lockInHero(s, 'id-D', PROFILE);
    expect(s.heroResult).not.toBeNull();
    const result = s.heroResult!;
    expect(Object.keys(result).sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
    for (const key of ['a', 'c', 'e']) expect(result[key]!.heroId).toBeLessThanOrEqual(6);
    for (const key of ['b', 'd']) expect(result[key]!.heroId).toBeGreaterThanOrEqual(7);
    expect(result.e!.how).toBe('random');
  });

  it('resolveHeroPhase works on timeout with partial prefs', () => {
    const s = setHeroPrefs(heroState(), 'id-A', [3], PROFILE);
    expect(resolveHeroPhase(s, PROFILE).heroResult!.a).toEqual({ heroId: 3, how: 'wanted' });
  });
});
```

Run: `pnpm --filter @dbz/bot exec vitest run src/services/lobby-draft` → FAIL.

- [ ] **Step 2: Implement `hero-assign.ts`**

```ts
import { shuffle } from './draft-logic.js';
import { LobbyDraftError, type HeroAssignment } from './draft-types.js';

/**
 * Give as many players as possible one of their wanted heroes (maximum bipartite
 * matching, Kuhn's augmenting paths — ≤6×6 so cost is trivial). Players and wish
 * lists are shuffled first, so only real clashes are decided by chance.
 * Everyone left over gets a random free hero.
 */
export function assignHeroes(
  players: Array<{ key: string; wanted: number[] }>,
  heroes: number[],
  rng: () => number = Math.random,
): Record<string, HeroAssignment> {
  if (players.length > heroes.length) {
    throw new LobbyDraftError('Too many players for this side.');
  }
  const heroSet = new Set(heroes);
  const wanted = new Map(
    shuffle(players, rng).map((p) => [
      p.key,
      shuffle(
        p.wanted.filter((h) => heroSet.has(h)),
        rng,
      ),
    ]),
  );
  const ownerByHero = new Map<number, string>();

  const tryAssign = (key: string, seen: Set<number>): boolean => {
    for (const hero of wanted.get(key) ?? []) {
      if (seen.has(hero)) continue;
      seen.add(hero);
      const owner = ownerByHero.get(hero);
      if (owner === undefined || tryAssign(owner, seen)) {
        ownerByHero.set(hero, key);
        return true;
      }
    }
    return false;
  };
  for (const key of wanted.keys()) tryAssign(key, new Set());

  const result: Record<string, HeroAssignment> = {};
  const matchedKeys = new Set(ownerByHero.values());
  for (const [heroId, key] of ownerByHero) {
    // Contested = someone else wanted this hero and ended up with none of their wishes.
    const contested = players.some(
      (p) => p.key !== key && p.wanted.includes(heroId) && !matchedKeys.has(p.key),
    );
    result[key] = { heroId, how: contested ? 'contested' : 'wanted' };
  }
  const free = shuffle(
    heroes.filter((h) => !ownerByHero.has(h)),
    rng,
  );
  for (const key of wanted.keys()) {
    if (!result[key]) result[key] = { heroId: free.shift()!, how: 'random' };
  }
  return result;
}
```

- [ ] **Step 3: Add hero functions to `draft-logic.ts`** (add `LOBBY_DRAFT_MAX_HERO_PREFS` to the `./draft-types.js` import; import `assignHeroes` from `./hero-assign.js` — the draft-logic ↔ hero-assign cycle is safe because each side only calls the other's functions at runtime):

```ts
export function heroLockedInCount(state: LobbyDraftState): number {
  return linkedParticipants(state).filter((p) => state.heroLockedIn.includes(p.key)).length;
}

function heroActor(state: LobbyDraftState, actorDiscordId: string): { key: string; side: TeamId } {
  assertPhase(state, 'HERO');
  const actor = participantByDiscordId(state, actorDiscordId);
  const t = actor ? teamOfKey(state, actor.key) : null;
  const side = t === null ? null : requireTeams(state)[t].side;
  if (!actor || !side) {
    throw new LobbyDraftError(NOT_IN_DRAFT_MESSAGE);
  }
  return { key: actor.key, side };
}

export function setHeroPrefs(
  state: LobbyDraftState,
  actorDiscordId: string,
  heroIds: number[],
  profile: GameProfile,
): LobbyDraftState {
  const { key, side } = heroActor(state, actorDiscordId);
  const unique = [...new Set(heroIds)];
  const sideHeroes = heroIdsForSide(profile, side);
  if (unique.length > LOBBY_DRAFT_MAX_HERO_PREFS || unique.some((h) => !sideHeroes.includes(h))) {
    throw new LobbyDraftError('Pick up to 2 heroes from your side.');
  }
  return { ...state, heroPrefs: { ...state.heroPrefs, [key]: unique } };
}

export function lockInHero(
  state: LobbyDraftState,
  actorDiscordId: string,
  profile: GameProfile,
  rng: Rng = Math.random,
): LobbyDraftState {
  const { key } = heroActor(state, actorDiscordId);
  if (state.heroLockedIn.includes(key)) return state;
  return closeEarlyIfDone({ ...state, heroLockedIn: [...state.heroLockedIn, key] }, profile, rng);
}

export function resolveHeroPhase(
  state: LobbyDraftState,
  profile: GameProfile,
  rng: Rng = Math.random,
): LobbyDraftState {
  assertPhase(state, 'HERO');
  const teams = requireTeams(state);
  const heroResult = Object.assign(
    {},
    ...teams.map((team) =>
      assignHeroes(
        team.roster.map((key) => ({ key, wanted: state.heroPrefs[key] ?? [] })),
        heroIdsForSide(profile, team.side!),
        rng,
      ),
    ),
  );
  const lines = Object.entries(heroResult as Record<string, { heroId: number; how: string }>)
    .filter(([, a]) => a.how === 'contested')
    .map(([key, a]) => `🎲 ${nickOf(state, key)} won the roll for hero #${a.heroId}.`);
  return withLog({ ...state, heroResult }, '🦸 Heroes assigned.', ...lines);
}
```

(The UI replaces `hero #N` with hero names when rendering the final result; the log line is only a fallback.)

Fill the HERO branch in `closeEarlyIfDone` (before `return state;`):

```ts
if (state.phase === 'HERO' && profile && heroLockedInCount(state) === linked.length) {
  return resolveHeroPhase(state, profile, rng);
}
```

- [ ] **Step 4: Run** `pnpm --filter @dbz/bot exec vitest run src/services/lobby-draft` → PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/bot/src/services/lobby-draft
git commit -m "feat(lobby-draft): resolve hero picks with randomized max matching"
```

---

### Task 4: Replace / remove / timeout (`game:warcraft3_udbr`)

**Files:**

- Modify: `apps/bot/src/services/lobby-draft/draft-logic.ts`
- Test: extend `draft-logic.test.ts`

**Interfaces:**

- Produces: `replaceParticipant(state, outgoingKey, incoming, profile, rng?)`, `removeParticipant(state, key, profile, rng?)`, `projectedTeamSizes(state): [number, number]`, `applyTimeout(state, profile, rng?)`.

- [ ] **Step 1: Failing tests** (append)

```ts
import {
  applyTimeout,
  clockChanged,
  projectedTeamSizes,
  removeParticipant,
  replaceParticipant,
} from './draft-logic.js';

describe('replace', () => {
  it('newcomer takes the seat as-is (pool, roster, captain)', () => {
    const s = pickingState(['A', 'B', 'C', 'D', 'E']);
    const next = replaceParticipant(s, 'c', person('Z'), PROFILE);
    expect(next.pool).toContain('z');
    expect(next.pool).not.toContain('c');
    const cap = replaceParticipant(s, 'a', person('Y'), PROFILE);
    expect(cap.teams![0]).toMatchObject({ captainKey: 'y', roster: ['y'] });
    expect(cap.log.at(-1)).toContain('Y replaced A');
  });

  it('refuses unlinked captain replacement', () => {
    expect(() =>
      replaceParticipant(pickingState(['A', 'B', 'C', 'D']), 'a', person('Z', false), PROFILE),
    ).toThrow('A captain must be linked');
  });

  it('refuses someone already in the draft', () => {
    expect(() =>
      replaceParticipant(pickingState(['A', 'B', 'C', 'D']), 'c', person('D'), PROFILE),
    ).toThrow('already in this draft');
  });

  it('drops the leaver ballot and votes for them', () => {
    const players = ['A', 'B', 'C', 'D', 'E'].map((n) => person(n));
    const s: LobbyDraftState = {
      ...initialLobbyDraftState(players, null),
      votes: { 'id-C': ['a'], 'id-A': ['c', 'b'] },
    };
    const next = replaceParticipant(s, 'c', person('Z'), PROFILE);
    expect(next.votes).toEqual({ 'id-A': ['b'] });
  });
});

describe('remove', () => {
  it('refuses when the draft could not end 2v2', () => {
    expect(() => removeParticipant(pickingState(['A', 'B', 'C', 'D']), 'c', PROFILE)).toThrow(
      'Need at least 2v2',
    );
  });

  it('captain succession: earliest-drafted linked teammate, else linked pool player', () => {
    let s = pickingState(['A', 'B', 'C', 'D', 'E', 'F']);
    s = applyPick(s, 'c'); // team 0: a, c
    const next = removeParticipant(s, 'a', PROFILE);
    expect(next.teams![0]).toMatchObject({ captainKey: 'c', roster: ['c'] });

    const fresh = pickingState(['A', 'B', 'C', 'D', 'E', 'F']);
    const fromPool = removeParticipant(fresh, 'a', PROFILE, () => 0);
    expect(fromPool.teams![0].roster).toHaveLength(1);
    expect(fromPool.pool).not.toContain(fromPool.teams![0].captainKey);
  });

  it('clockChanged when on-clock captain changes', () => {
    const s = pickingState(['A', 'B', 'C', 'D', 'E', 'F'], 0);
    const next = removeParticipant(s, 'a', PROFILE, () => 0);
    expect(clockChanged(s, next)).toBe(true);
    expect(clockChanged(s, removeParticipant(s, 'f', PROFILE))).toBe(false);
  });

  it('projects final sizes from remaining snake picks', () => {
    expect(projectedTeamSizes(pickingState(['A', 'B', 'C', 'D', 'E']))).toEqual([2, 3]);
  });
});

describe('applyTimeout', () => {
  it('auto-acts per phase', () => {
    const pick = applyTimeout(pickingState(['A', 'B', 'C', 'D']), PROFILE, () => 0);
    expect(pick.pickIndex).toBe(1);
    expect(pick.log.some((l) => l.includes('⏱️'))).toBe(true);

    const vote = applyTimeout(
      initialLobbyDraftState(
        ['A', 'B', 'C', 'D'].map((n) => person(n)),
        null,
      ),
      PROFILE,
    );
    expect(vote.phase).toBe('COIN_CHOICE');
  });
});
```

Run → FAIL.

- [ ] **Step 2: Implement** (append to `draft-logic.ts`)

```ts
/** Final team sizes if the remaining pool is drafted in snake order. */
export function projectedTeamSizes(state: LobbyDraftState): [number, number] {
  const teams = requireTeams(state);
  const sizes: [number, number] = [teams[0].roster.length, teams[1].roster.length];
  for (let i = 0; i < state.pool.length; i += 1) {
    sizes[pickingTeam({ ...state, pickIndex: state.pickIndex + i })] += 1;
  }
  return sizes;
}

function withoutVotesFor(votes: LobbyDraftState['votes'], key: string, voterId?: string) {
  const next: LobbyDraftState['votes'] = {};
  for (const [voter, keys] of Object.entries(votes)) {
    if (voter === voterId) continue;
    const kept = keys.filter((k) => k !== key);
    if (kept.length > 0) next[voter] = kept;
  }
  return next;
}

export function replaceParticipant(
  state: LobbyDraftState,
  outgoingKey: string,
  incoming: LobbyDraftParticipant,
  profile: GameProfile,
  rng: Rng = Math.random,
): LobbyDraftState {
  const outgoing = findParticipant(state, outgoingKey);
  if (!outgoing) {
    throw new LobbyDraftError('Participant not found.');
  }
  if (
    findParticipant(state, incoming.key) ||
    (incoming.discordId && participantByDiscordId(state, incoming.discordId))
  ) {
    throw new LobbyDraftError('That player is already in this draft.');
  }
  const isCaptain = state.teams?.some((t) => t.captainKey === outgoingKey) ?? false;
  if (isCaptain && !incoming.discordId) {
    throw new LobbyDraftError(
      'A captain must be linked — remove the captain instead so a teammate takes over.',
    );
  }
  const swap = (k: string) => (k === outgoingKey ? incoming.key : k);
  const { [outgoingKey]: _dropped, ...heroPrefs } = state.heroPrefs;
  const next: LobbyDraftState = {
    ...state,
    participants: state.participants.map((p) => (p.key === outgoingKey ? incoming : p)),
    pool: state.pool.map(swap),
    teams: state.teams
      ? (state.teams.map((t) => ({
          ...t,
          captainKey: swap(t.captainKey),
          roster: t.roster.map(swap),
        })) as [LobbyDraftTeam, LobbyDraftTeam])
      : null,
    votes: withoutVotesFor(state.votes, outgoingKey, outgoing.discordId),
    heroPrefs,
    heroLockedIn: state.heroLockedIn.filter((k) => k !== outgoingKey),
  };
  return closeEarlyIfDone(
    withLog(next, `🔁 ${incoming.nick} replaced ${outgoing.nick}.`),
    profile,
    rng,
  );
}

export function removeParticipant(
  state: LobbyDraftState,
  key: string,
  profile: GameProfile,
  rng: Rng = Math.random,
): LobbyDraftState {
  const outgoing = findParticipant(state, key);
  if (!outgoing) {
    throw new LobbyDraftError('Participant not found.');
  }
  const participants = state.participants.filter((p) => p.key !== key);
  if (participants.length < LOBBY_DRAFT_MIN_PLAYERS) {
    throw new LobbyDraftError(NEED_2V2_MESSAGE);
  }
  const { [key]: _dropped, ...heroPrefs } = state.heroPrefs;
  let next: LobbyDraftState = {
    ...state,
    participants,
    pool: state.pool.filter((k) => k !== key),
    votes: withoutVotesFor(state.votes, key, outgoing.discordId),
    heroPrefs,
    heroLockedIn: state.heroLockedIn.filter((k) => k !== key),
  };
  const lines = [`➖ ${outgoing.nick} was removed.`];

  if (!next.teams) {
    if (linkedParticipants(next).length < LOBBY_DRAFT_MIN_LINKED) {
      throw new LobbyDraftError(NEED_2V2_MESSAGE);
    }
  } else {
    const isLinked = (k: string) => Boolean(findParticipant(next, k)?.discordId);
    const teams = next.teams.map((team) => {
      if (!team.roster.includes(key)) return team;
      const roster = team.roster.filter((k) => k !== key);
      if (team.captainKey !== key) return { ...team, roster };
      let successor = roster.find(isLinked);
      if (!successor) {
        successor = shuffle(next.pool.filter(isLinked), rng)[0];
        if (!successor) {
          throw new LobbyDraftError('No linked player can take over as captain — replace instead.');
        }
        next = { ...next, pool: next.pool.filter((k) => k !== successor) };
        roster.unshift(successor);
      }
      lines.push(`👑 ${nickOf(next, successor)} is now captain.`);
      return {
        ...team,
        captainKey: successor,
        roster: [successor, ...roster.filter((k) => k !== successor)],
      };
    }) as [LobbyDraftTeam, LobbyDraftTeam];
    next = { ...next, teams };
    if (projectedTeamSizes(next).some((n) => n < 2)) {
      throw new LobbyDraftError(NEED_2V2_MESSAGE);
    }
    if (next.phase === 'PICK' && next.pool.length === 0) {
      next = { ...next, phase: phaseAfterPicks(next) };
    }
  }
  return closeEarlyIfDone(withLog(next, ...lines), profile, rng);
}

/** Deadline passed: act at random for whoever is on the clock. */
export function applyTimeout(
  state: LobbyDraftState,
  profile: GameProfile,
  rng: Rng = Math.random,
): LobbyDraftState {
  const timedOut = withLog(state, '⏱️ Time ran out — choosing at random.');
  switch (state.phase) {
    case 'VOTE':
      return closeVote(withLog(state, '⏱️ Voting closed.'), rng);
    case 'COIN_CHOICE':
      return chooseCoin(timedOut, rng() < 0.5 ? 'FIRST_PICK' : 'SIDE');
    case 'PICK':
      return applyPick(timedOut, shuffle(state.pool, rng)[0]!);
    case 'SIDE':
      return applySide(timedOut, rng() < 0.5 ? 1 : 2, profile.teamNames);
    case 'HERO':
      return resolveHeroPhase(withLog(state, '⏱️ Hero pick closed.'), profile, rng);
  }
}
```

Update `castVote` to call `closeEarlyIfDone(next, null, rng)` (already does).

- [ ] **Step 3: Run** `pnpm --filter @dbz/bot exec vitest run src/services/lobby-draft` → PASS. Then `pnpm --filter @dbz/bot exec tsc --noEmit -p .` (or `pnpm typecheck`) → PASS (fix unused `_dropped` lint per repo ESLint config if it complains: rename to `_` pattern the repo already uses, or use `Object.fromEntries(Object.entries(...).filter(...))`).

- [ ] **Step 4: Commit**

```bash
git add apps/bot/src/services/lobby-draft
git commit -m "feat(lobby-draft): replace, remove and timeout handling"
```

---

### Task 5: State persistence (`general` pattern)

**Files:**

- Create: `apps/bot/src/services/lobby-draft/draft-state.ts`
- Test: `apps/bot/src/services/lobby-draft/draft-state.test.ts`

**Interfaces:**

- Produces: `serializeLobbyDraftState(state)`, `parseLobbyDraftState(row: LobbyDraft): LobbyDraftState`, `loadLobbyDraftById(id): Promise<LobbyDraft>`, `findActiveLobbyDraftForMatch(matchId): Promise<LobbyDraft | null>`, `listActiveLobbyDrafts(): Promise<LobbyDraft[]>`, `saveLobbyDraftState(draft: LobbyDraft, state, extra?: { liveMessageId?: string }): Promise<LobbyDraft>` (throws `LobbyDraftConflictError` when the row changed), `setLobbyDraftStatus(id, status): Promise<LobbyDraft>`.

- [ ] **Step 1: Failing test**

```ts
import type { LobbyDraft } from '@dbz/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { updateMany, findUnique } = vi.hoisted(() => ({ updateMany: vi.fn(), findUnique: vi.fn() }));
vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    lobbyDraft: { updateMany, findUnique, findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn() },
  },
}));

import { parseLobbyDraftState, saveLobbyDraftState } from './draft-state.js';
import { initialLobbyDraftState, LobbyDraftConflictError, LobbyDraftError } from './draft-types.js';

const state = initialLobbyDraftState([{ key: 'a', nick: 'A', discordId: '1' }], null);
const row = {
  id: 'd1',
  status: 'ACTIVE',
  state,
  updatedAt: new Date(1000),
} as unknown as LobbyDraft;

describe('draft-state', () => {
  beforeEach(() => vi.clearAllMocks());

  it('round-trips state and rejects garbage', () => {
    expect(parseLobbyDraftState(row)).toEqual(state);
    expect(() =>
      parseLobbyDraftState({ ...row, state: { phase: 'NOPE' } } as unknown as LobbyDraft),
    ).toThrow(LobbyDraftError);
  });

  it('saves only when updatedAt still matches', async () => {
    updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(saveLobbyDraftState(row, state)).rejects.toBeInstanceOf(LobbyDraftConflictError);
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'd1', status: 'ACTIVE', updatedAt: row.updatedAt } }),
    );

    updateMany.mockResolvedValueOnce({ count: 1 });
    findUnique.mockResolvedValueOnce(row);
    await expect(saveLobbyDraftState(row, state)).resolves.toBe(row);
  });
});
```

Run → FAIL.

- [ ] **Step 2: Implement**

```ts
import type { LobbyDraft, Prisma } from '@dbz/db';
import { prisma } from '../../lib/prisma.js';
import {
  LobbyDraftConflictError,
  LobbyDraftError,
  type LobbyDraftState,
  type LobbyDraftStatus,
} from './draft-types.js';

const PHASES = new Set(['VOTE', 'COIN_CHOICE', 'PICK', 'SIDE', 'HERO']);

export function serializeLobbyDraftState(state: LobbyDraftState): Prisma.InputJsonValue {
  return state as unknown as Prisma.InputJsonValue;
}

/** Shape check only: state is written exclusively by this module. */
export function parseLobbyDraftState(row: LobbyDraft): LobbyDraftState {
  const raw = row.state as Record<string, unknown> | null;
  if (
    !raw ||
    typeof raw !== 'object' ||
    !PHASES.has(raw.phase as string) ||
    !Array.isArray(raw.participants) ||
    !Array.isArray(raw.pool) ||
    !Array.isArray(raw.log)
  ) {
    throw new LobbyDraftError('Invalid lobby draft state in database.');
  }
  return raw as unknown as LobbyDraftState;
}

export async function loadLobbyDraftById(draftId: string): Promise<LobbyDraft> {
  const draft = await prisma.lobbyDraft.findUnique({ where: { id: draftId } });
  if (!draft) {
    throw new LobbyDraftError('Captain draft not found.');
  }
  return draft;
}

export function findActiveLobbyDraftForMatch(matchId: string): Promise<LobbyDraft | null> {
  return prisma.lobbyDraft.findFirst({ where: { matchId, status: 'ACTIVE' } });
}

export function listActiveLobbyDrafts(): Promise<LobbyDraft[]> {
  return prisma.lobbyDraft.findMany({ where: { status: 'ACTIVE' } });
}

/** Optimistic save: fails with LobbyDraftConflictError if someone saved first. */
export async function saveLobbyDraftState(
  draft: LobbyDraft,
  state: LobbyDraftState,
  extra: { liveMessageId?: string } = {},
): Promise<LobbyDraft> {
  const { count } = await prisma.lobbyDraft.updateMany({
    where: { id: draft.id, status: 'ACTIVE', updatedAt: draft.updatedAt },
    data: { state: serializeLobbyDraftState(state), ...extra },
  });
  if (count === 0) {
    throw new LobbyDraftConflictError();
  }
  return loadLobbyDraftById(draft.id);
}

export function setLobbyDraftStatus(
  draftId: string,
  status: LobbyDraftStatus,
): Promise<LobbyDraft> {
  return prisma.lobbyDraft.update({ where: { id: draftId }, data: { status } });
}
```

- [ ] **Step 3: Run** → PASS. **Step 4: Commit** `feat(lobby-draft): persist draft state with optimistic saves`.

---

### Task 6: Lobby freeze guard + atomic finalize hook (`general` — match roster funnel)

**Files:**

- Modify: `apps/bot/src/services/match/match-service.ts` (`ReplaceMatchRosterOptions` ~line 91; `replaceMatchRoster` tx ~line 715 right after the `existing.status !== 'PENDING'` check; `setMatchPlayersLocked` ~line 612)
- Modify tests whose `$transaction` tx mocks lack `lobbyDraft`: `apps/bot/src/services/match/replace-match-roster.test.ts` (tx object ~line 102) and any other failing suite
- Test: `apps/bot/src/services/match/replace-match-roster.test.ts`

**Interfaces:**

- Consumes: `FROZEN_LOBBY_MESSAGE` from `../lobby-draft/draft-types.js`.
- Produces: `ReplaceMatchRosterOptions.completeLobbyDraftId?: string` — when set, the write is allowed only if that draft is the ACTIVE one for the match, and it is marked `COMPLETE` in the same transaction.

- [ ] **Step 1: Failing tests** — in `replace-match-roster.test.ts`, add hoisted `lobbyDraftFindFirst`, `lobbyDraftUpdate`; add `lobbyDraft: { findFirst: lobbyDraftFindFirst, update: lobbyDraftUpdate }` to the tx object; in `beforeEach` default `lobbyDraftFindFirst.mockResolvedValue(null)`. New cases (reuse the file's existing happy-path arrange helpers for match/players):

```ts
describe('lobby draft freeze', () => {
  it('blocks roster writes while a draft is active', async () => {
    lobbyDraftFindFirst.mockResolvedValue({ id: 'draft-1' });
    await expect(replaceMatchRoster(MATCH_ID, [{ slot: 1, nick: 'a' }])).rejects.toThrow(
      'A captain draft is running for this lobby.',
    );
  });

  it('lets the finalizing draft write and marks it COMPLETE', async () => {
    lobbyDraftFindFirst.mockResolvedValue({ id: 'draft-1' });
    await replaceMatchRoster(MATCH_ID, [{ slot: 1, nick: 'a' }], {
      completeLobbyDraftId: 'draft-1',
    });
    expect(lobbyDraftUpdate).toHaveBeenCalledWith({
      where: { id: 'draft-1' },
      data: { status: 'COMPLETE' },
    });
  });

  it('refuses a stale finalize', async () => {
    lobbyDraftFindFirst.mockResolvedValue(null);
    await expect(
      replaceMatchRoster(MATCH_ID, [{ slot: 1, nick: 'a' }], { completeLobbyDraftId: 'draft-1' }),
    ).rejects.toThrow('This captain draft is no longer active.');
  });
});
```

(Use whatever arrange calls the existing tests use so the write path reaches the tx — e.g. `matchFindUnique`/`matchFindUniqueInTx` returning `pendingMatch()` and `getGameProfileForLeague` returning the UDBR profile.)

Run: `pnpm --filter @dbz/bot exec vitest run src/services/match/replace-match-roster.test.ts` → FAIL.

- [ ] **Step 2: Implement.** Options type:

```ts
  /** Lobby captain draft finalize: bypass the draft freeze and mark this draft COMPLETE atomically. */
  completeLobbyDraftId?: string;
```

Inside the `replaceMatchRoster` transaction, right after the PENDING check:

```ts
const activeDraft = await tx.lobbyDraft.findFirst({
  where: { matchId, status: 'ACTIVE' },
  select: { id: true },
});
if (options.completeLobbyDraftId) {
  if (activeDraft?.id !== options.completeLobbyDraftId) {
    throw new MatchServiceError('This captain draft is no longer active.');
  }
  await tx.lobbyDraft.update({ where: { id: activeDraft.id }, data: { status: 'COMPLETE' } });
} else if (activeDraft) {
  throw new MatchServiceError(FROZEN_LOBBY_MESSAGE);
}
```

In `setMatchPlayersLocked`, after the PENDING check:

```ts
const activeDraft = await prisma.lobbyDraft.findFirst({
  where: { matchId, status: 'ACTIVE' },
  select: { id: true },
});
if (activeDraft) {
  throw new MatchServiceError(FROZEN_LOBBY_MESSAGE);
}
```

- [ ] **Step 3: Run the whole bot suite** `pnpm --filter @dbz/bot test`. Any suite that mocks `prisma.$transaction` with a hand-built tx or mocks `prisma` for `setMatchPlayersLocked` and now crashes on `lobbyDraft` → add `lobbyDraft: { findFirst: vi.fn().mockResolvedValue(null), update: vi.fn() }` to that mock. Expected: all PASS.

- [ ] **Step 4: Commit** `feat(lobby-draft): freeze lobby roster while a draft runs`.

---

### Task 7: UI builders, timer, actions (`game:warcraft3_udbr`)

**Files:**

- Create: `apps/bot/src/services/lobby-draft/draft-ui.ts`, `draft-timer.ts`, `draft-actions.ts`, `index.ts`
- Test: `apps/bot/src/services/lobby-draft/draft-ui.test.ts`, `draft-actions.test.ts`

**Interfaces:**

- Consumes: everything from Tasks 2–6; `replaceMatchRoster` + `getMatchByDiscordMessageId` + `requireLeagueId` + `MatchServiceError` + `MatchWithPlayers` from `../match/match-service.js`; `assertCanManageMatch` from `../match/match-auth.js`; `syncLobbyDiscordMessage` from `../lobby/discord-sync.js`; `nickForDiscordId` from `../lobby/lobby-identity.js`; `resolveLeagueConfig` from `../league/league-wc3stats.js`; `getGameProfileForLeague` from `../league/league-profile.js`.
- Produces (used by Task 8/9):
  - UI: `LOBBY_DRAFT_START_ID = 'ldraft:start'`, `lobbyDraftCustomId(action, draftId, arg?)`, `parseLobbyDraftCustomId(customId)`, `buildLobbyDraftEmbed(draft, state, view)`, `buildLobbyDraftComponents(draftId, state, view)`, `buildVoteMenu(draftId, state)`, `buildHeroMenu(draftId, heroes, current)`, `buildManageMenus(draftId, state)`, `buildReplaceModal(draftId, key, nick)`, type `LobbyDraftView = { profile: GameProfile; heroNames: Map<number, string> }`.
  - Timer: `scheduleLobbyDraftTimeout(client, draftId, deadlineIso)`, `clearLobbyDraftTimer(draftId)`, `rehydrateLobbyDraftTimers(client)`.
  - Actions: `startLobbyDraft`, `voteCaptains`, `chooseCoinOption`, `pickPlayer`, `chooseSide`, `setHeroPreferences`, `lockInHeroes`, `manageRemove`, `manageReplace`, `cancelLobbyDraftByUser`, `cancelActiveLobbyDraftForMatch`, `applyLobbyDraftTimeout`, `syncLobbyDraftLiveMessage`, `getHeroMenuForActor`, `getVoteMenuForActor`, `getManageMenuForActor`.

- [ ] **Step 1: Failing UI test** (`draft-ui.test.ts`)

```ts
import { describe, expect, it } from 'vitest';
import {
  buildHeroMenu,
  buildLobbyDraftComponents,
  lobbyDraftCustomId,
  parseLobbyDraftCustomId,
} from './draft-ui.js';
import { HERO_PICK_HELP } from './draft-types.js';
import { PROFILE, pickingState } from './test-fixtures.js';

const view = {
  profile: PROFILE,
  heroNames: new Map([
    [1, 'Goku'],
    [2, 'Vegeta'],
  ]),
};

describe('lobby draft ui', () => {
  it('round-trips custom ids, keeping colons in the arg', () => {
    const id = lobbyDraftCustomId('mrepm', 'draft1', 'some:key');
    expect(parseLobbyDraftCustomId(id)).toEqual({
      action: 'mrepm',
      draftId: 'draft1',
      arg: 'some:key',
    });
    expect(parseLobbyDraftCustomId('lobby:start')).toBeNull();
  });

  it('PICK phase shows a pool select plus manage row', () => {
    const rows = buildLobbyDraftComponents('d1', pickingState(['A', 'B', 'C', 'D']), view).map(
      (r) => r.toJSON(),
    );
    const ids = rows.flatMap((r) => r.components.map((c) => ('custom_id' in c ? c.custom_id : '')));
    expect(ids).toContain('ldraft:pick:d1');
    expect(ids).toContain('ldraft:manage:d1');
    expect(ids).toContain('ldraft:cancel:d1');
  });

  it('hero menu allows 0–2 and explains it is optional', () => {
    const menu = buildHeroMenu(
      'd1',
      [
        { id: 1, name: 'Goku' },
        { id: 2, name: 'Vegeta' },
      ],
      [2],
    );
    const select = menu.components[0]!.toJSON().components[0] as {
      min_values: number;
      max_values: number;
    };
    expect(select.min_values).toBe(0);
    expect(select.max_values).toBe(2);
    expect(menu.content).toBe(HERO_PICK_HELP);
  });
});
```

- [ ] **Step 2: Implement `draft-ui.ts`**

```ts
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import type { LobbyDraft } from '@dbz/db';
import type { GameProfile } from '../../domain/game-profile.js';
import {
  findParticipant,
  heroIdsForSide,
  heroLockedInCount,
  linkedParticipants,
  nickOf,
  onClockCaptainKey,
  votedCount,
} from './draft-logic.js';
import { HERO_PICK_HELP, type LobbyDraftState } from './draft-types.js';

export const LOBBY_DRAFT_START_ID = 'ldraft:start';
const PREFIX = 'ldraft';

export type LobbyDraftAction =
  | 'vote'
  | 'votesel'
  | 'coin'
  | 'pick'
  | 'side'
  | 'hero'
  | 'herosel'
  | 'lockin'
  | 'manage'
  | 'mrem'
  | 'mrep'
  | 'mrepm'
  | 'cancel';

export type LobbyDraftView = { profile: GameProfile; heroNames: Map<number, string> };

export function lobbyDraftCustomId(
  action: LobbyDraftAction,
  draftId: string,
  arg?: string,
): string {
  return arg === undefined
    ? `${PREFIX}:${action}:${draftId}`
    : `${PREFIX}:${action}:${draftId}:${arg}`;
}

export function parseLobbyDraftCustomId(
  customId: string,
): { action: LobbyDraftAction; draftId: string; arg?: string } | null {
  const [prefix, action, draftId, ...rest] = customId.split(':');
  if (prefix !== PREFIX || !action || !draftId) return null;
  return {
    action: action as LobbyDraftAction,
    draftId,
    ...(rest.length ? { arg: rest.join(':') } : {}),
  };
}

const PHASE_TITLES: Record<LobbyDraftState['phase'], string> = {
  VOTE: '🗳️ Vote for captains',
  COIN_CHOICE: '🪙 Coin flip choice',
  PICK: '🧩 Captains are picking',
  SIDE: '🏳️ Choosing side',
  HERO: '🦸 Hero pick',
};

function label(state: LobbyDraftState, key: string): string {
  const p = findParticipant(state, key);
  return `${p?.nick ?? key}${p?.discordId ? ' 🔗' : ''}`;
}

function sideRange(profile: GameProfile, side: 1 | 2): string {
  const ids = heroIdsForSide(profile, side);
  return `${ids[0]}–${ids.at(-1)}`;
}

export function buildLobbyDraftEmbed(
  draft: Pick<LobbyDraft, 'status'>,
  state: LobbyDraftState,
  view: LobbyDraftView,
): EmbedBuilder {
  const title =
    draft.status === 'COMPLETE'
      ? '✅ Draft complete'
      : draft.status === 'CANCELLED'
        ? '🚫 Draft cancelled'
        : PHASE_TITLES[state.phase];
  const lines: string[] = [];
  if (draft.status === 'ACTIVE' && state.deadlineAt) {
    lines.push(`Ends <t:${Math.floor(new Date(state.deadlineAt).getTime() / 1000)}:R>`);
  }
  if (draft.status === 'ACTIVE' && state.phase === 'VOTE') {
    lines.push(`${votedCount(state)}/${linkedParticipants(state).length} voted`);
  }
  if (draft.status === 'ACTIVE' && state.phase === 'HERO') {
    lines.push(`${heroLockedInCount(state)}/${linkedParticipants(state).length} locked in`);
  }
  const clock = onClockCaptainKey(state);
  if (draft.status === 'ACTIVE' && clock) lines.push(`On the clock: **${nickOf(state, clock)}**`);

  const embed = new EmbedBuilder().setTitle(title).setDescription(lines.join('\n') || '​');
  state.teams?.forEach((team, i) => {
    const name = team.side ? view.profile.teamNames[team.side] : `Team ${i + 1}`;
    const roster = team.roster.map((key) => {
      const hero = state.heroResult?.[key];
      const heroText = hero
        ? ` — ${view.heroNames.get(hero.heroId) ?? `#${hero.heroId}`}${hero.how === 'contested' ? ' 🎲' : ''}`
        : '';
      return `${key === team.captainKey ? '👑 ' : ''}${label(state, key)}${heroText}`;
    });
    embed.addFields({
      name: `${name} (${nickOf(state, team.captainKey)})`,
      value: roster.join('\n'),
      inline: true,
    });
  });
  const pool = state.teams ? state.pool : state.participants.map((p) => p.key);
  if (pool.length > 0) {
    embed.addFields({
      name: state.teams ? 'Pool' : 'Players',
      value: pool.map((k) => label(state, k)).join('\n'),
    });
  }
  if (state.log.length > 0) {
    embed.addFields({ name: 'Recent', value: state.log.slice(-5).join('\n').slice(0, 1024) });
  }
  return embed;
}

export function buildLobbyDraftComponents(
  draftId: string,
  state: LobbyDraftState,
  view: LobbyDraftView,
): Array<ActionRowBuilder<ButtonBuilder> | ActionRowBuilder<StringSelectMenuBuilder>> {
  const rows: Array<ActionRowBuilder<ButtonBuilder> | ActionRowBuilder<StringSelectMenuBuilder>> =
    [];
  const button = (id: string, text: string, style = ButtonStyle.Primary) =>
    new ButtonBuilder().setCustomId(id).setLabel(text).setStyle(style);

  if (state.phase === 'VOTE') {
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        button(lobbyDraftCustomId('vote', draftId), 'Vote captains'),
      ),
    );
  } else if (state.phase === 'COIN_CHOICE') {
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        button(lobbyDraftCustomId('coin', draftId, 'FIRST_PICK'), 'First pick'),
        button(lobbyDraftCustomId('coin', draftId, 'SIDE'), 'Side choice'),
      ),
    );
  } else if (state.phase === 'PICK' && state.pool.length > 0) {
    rows.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(lobbyDraftCustomId('pick', draftId))
          .setPlaceholder(`${nickOf(state, onClockCaptainKey(state) ?? '')}'s pick`)
          .addOptions(
            state.pool.slice(0, 25).map((key) => ({ label: label(state, key), value: key })),
          ),
      ),
    );
  } else if (state.phase === 'SIDE') {
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        button(
          lobbyDraftCustomId('side', draftId, '1'),
          `${view.profile.teamNames[1]} (${sideRange(view.profile, 1)})`,
        ),
        button(
          lobbyDraftCustomId('side', draftId, '2'),
          `${view.profile.teamNames[2]} (${sideRange(view.profile, 2)})`,
        ),
      ),
    );
  } else if (state.phase === 'HERO') {
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        button(lobbyDraftCustomId('hero', draftId), 'Pick heroes'),
      ),
    );
  }
  rows.push(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      button(lobbyDraftCustomId('manage', draftId), 'Manage', ButtonStyle.Secondary),
      button(lobbyDraftCustomId('cancel', draftId), 'Cancel draft', ButtonStyle.Danger),
    ),
  );
  return rows;
}

export function buildVoteMenu(draftId: string, state: LobbyDraftState) {
  const linked = linkedParticipants(state);
  return {
    content:
      'Vote for up to 2 captains (you can vote for yourself). You can change your vote until time runs out.',
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(lobbyDraftCustomId('votesel', draftId))
          .setMinValues(1)
          .setMaxValues(Math.min(2, linked.length))
          .addOptions(linked.slice(0, 25).map((p) => ({ label: p.nick, value: p.key }))),
      ),
    ],
  };
}

export function buildHeroMenu(
  draftId: string,
  heroes: Array<{ id: number; name: string }>,
  current: number[],
) {
  return {
    content: HERO_PICK_HELP,
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(lobbyDraftCustomId('herosel', draftId))
          .setPlaceholder('Optional: up to 2 heroes')
          .setMinValues(0)
          .setMaxValues(2)
          .addOptions(
            heroes.map((h) => ({
              label: h.name,
              value: String(h.id),
              default: current.includes(h.id),
            })),
          ),
      ),
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(lobbyDraftCustomId('lockin', draftId))
          .setLabel('Lock in')
          .setStyle(ButtonStyle.Success),
      ),
    ],
  };
}

export function buildManageMenus(draftId: string, state: LobbyDraftState) {
  const options = state.participants
    .slice(0, 25)
    .map((p) => ({ label: `${p.nick}${p.discordId ? ' 🔗' : ''}`, value: p.key }));
  const select = (action: 'mrem' | 'mrep', placeholder: string) =>
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(lobbyDraftCustomId(action, draftId))
        .setPlaceholder(placeholder)
        .addOptions(options),
    );
  return {
    content: 'Replace a player who left (keeps their seat), or remove them.',
    components: [select('mrep', 'Replace a player…'), select('mrem', 'Remove a player…')],
  };
}

export function buildReplaceModal(draftId: string, key: string, nick: string): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(lobbyDraftCustomId('mrepm', draftId, key))
    .setTitle(`Replace ${nick}`.slice(0, 45))
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('who')
          .setLabel('Discord @mention / user ID, or in-game nick')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(64),
      ),
    );
}
```

- [ ] **Step 3: Implement `draft-timer.ts`** — copy `services/hero-draft/draft-timer.ts` verbatim, then rename: `hero_draft_timer` → `lobby_draft_timer`, `clearHeroDraftTimer` → `clearLobbyDraftTimer`, `scheduleHeroDraftTimeout` → `scheduleLobbyDraftTimeout`, `rehydrateHeroDraftTimers` → `rehydrateLobbyDraftTimers`; the timeout imports `applyLobbyDraftTimeout` from `./draft-actions.js`; rehydrate uses `listActiveLobbyDrafts` + `parseLobbyDraftState` (`state.deadlineAt`) and calls `syncLobbyDraftLiveMessage(client, draft.id)`.

- [ ] **Step 4: Failing actions test** (`draft-actions.test.ts`) — the conflict retry and the finalize path:

```ts
import type { LobbyDraft } from '@dbz/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getGameProfile } from '../../domain/game-profile.js';
import { WARCRAFT3_UDBR_GAME_ID } from '../../domain/games.js';

const m = vi.hoisted(() => ({
  load: vi.fn(),
  save: vi.fn(),
  setStatus: vi.fn(),
  replaceMatchRoster: vi.fn(),
  syncLobby: vi.fn(),
  schedule: vi.fn(),
  clear: vi.fn(),
}));
vi.mock('./draft-state.js', async (orig) => ({
  ...(await orig<typeof import('./draft-state.js')>()),
  loadLobbyDraftById: m.load,
  saveLobbyDraftState: m.save,
  setLobbyDraftStatus: m.setStatus,
}));
vi.mock('./draft-timer.js', () => ({
  scheduleLobbyDraftTimeout: m.schedule,
  clearLobbyDraftTimer: m.clear,
}));
vi.mock('../league/league-profile.js', () => ({
  getGameProfileForLeague: async () => getGameProfile(WARCRAFT3_UDBR_GAME_ID),
}));
vi.mock('../match/match-service.js', async (orig) => ({
  ...(await orig<typeof import('../match/match-service.js')>()),
  replaceMatchRoster: m.replaceMatchRoster,
}));
vi.mock('../lobby/discord-sync.js', () => ({ syncLobbyDiscordMessage: m.syncLobby }));
vi.mock('../../lib/prisma.js', () => ({
  prisma: { hero: { findMany: vi.fn().mockResolvedValue([]) } },
}));

import { lockInHeroes, voteCaptains } from './draft-actions.js';
import { LobbyDraftConflictError } from './draft-types.js';
import { initialLobbyDraftState } from './draft-types.js';
import { person, pickingState } from './test-fixtures.js';

const client = { channels: { fetch: vi.fn().mockResolvedValue(null) } } as never;
function row(state: unknown): LobbyDraft {
  return {
    id: 'd1',
    status: 'ACTIVE',
    leagueId: 'L',
    matchId: 'M',
    threadId: 'T',
    liveMessageId: null,
    hostDiscordId: 'h',
    state,
    updatedAt: new Date(),
  } as unknown as LobbyDraft;
}

describe('lobby draft actions', () => {
  beforeEach(() => vi.clearAllMocks());

  it('retries on save conflict', async () => {
    const draft = row(
      initialLobbyDraftState(
        ['A', 'B', 'C', 'D'].map((n) => person(n)),
        null,
      ),
    );
    m.load.mockResolvedValue(draft);
    m.save.mockRejectedValueOnce(new LobbyDraftConflictError()).mockResolvedValueOnce(draft);
    await voteCaptains({ client, draftId: 'd1', actorDiscordId: 'id-A', keys: ['a'] });
    expect(m.save).toHaveBeenCalledTimes(2);
  });

  it('finalizes into the lobby when the last linked player locks in', async () => {
    const base = pickingState(['A', 'B', 'C', 'D']);
    const state = {
      ...base,
      phase: 'HERO' as const,
      pool: [],
      teams: [
        { captainKey: 'a', roster: ['a', 'c'], side: 1 as const },
        { captainKey: 'b', roster: ['b', 'd'], side: 2 as const },
      ] as typeof base.teams,
      heroLockedIn: ['a', 'b', 'c'],
    };
    const draft = row(state);
    m.load.mockResolvedValue(draft);
    m.save.mockResolvedValue(draft);
    m.replaceMatchRoster.mockResolvedValue({ id: 'M' });
    await lockInHeroes({ client, draftId: 'd1', actorDiscordId: 'id-D' });
    const [matchId, players, options] = m.replaceMatchRoster.mock.calls[0]!;
    expect(matchId).toBe('M');
    expect(options).toEqual({ markLobbyRosterAuthority: true, completeLobbyDraftId: 'd1' });
    expect(players).toHaveLength(4);
    for (const p of players as Array<{ slot: number; nick: string }>) {
      expect(['A', 'C'].includes(p.nick) ? p.slot <= 6 : p.slot >= 7).toBe(true);
    }
    expect(m.syncLobby).toHaveBeenCalled();
  });
});
```

Run → FAIL.

- [ ] **Step 5: Implement `draft-actions.ts`**

```ts
import { ThreadAutoArchiveDuration, type Client } from 'discord.js';
import type { LobbyDraft } from '@dbz/db';
import type { GameProfile } from '../../domain/game-profile.js';
import { createLogger } from '../../lib/logger.js';
import { prisma } from '../../lib/prisma.js';
import { getGameProfileForLeague } from '../league/league-profile.js';
import { resolveLeagueConfig } from '../league/league-wc3stats.js';
import { syncLobbyDiscordMessage } from '../lobby/discord-sync.js';
import { nickForDiscordId } from '../lobby/lobby-identity.js';
import { assertCanManageMatch } from '../match/match-auth.js';
import {
  getMatchByDiscordMessageId,
  MatchServiceError,
  replaceMatchRoster,
  requireLeagueId,
} from '../match/match-service.js';
import {
  applyPick,
  applySide,
  applyTimeout,
  assertCanStartLobbyDraft,
  assertOnClock,
  castVote,
  chooseCoin,
  clockChanged,
  findParticipant,
  heroIdsForSide,
  linkedParticipants,
  lockInHero,
  onClockCaptainKey,
  participantByDiscordId,
  removeParticipant,
  replaceParticipant,
  setHeroPrefs,
  teamOfKey,
} from './draft-logic.js';
import {
  findActiveLobbyDraftForMatch,
  loadLobbyDraftById,
  parseLobbyDraftState,
  saveLobbyDraftState,
  serializeLobbyDraftState,
  setLobbyDraftStatus,
} from './draft-state.js';
import { clearLobbyDraftTimer, scheduleLobbyDraftTimeout } from './draft-timer.js';
import {
  initialLobbyDraftState,
  LOBBY_DRAFT_PHASE_SECONDS,
  LobbyDraftConflictError,
  LobbyDraftError,
  NOT_IN_DRAFT_MESSAGE,
  participantKey,
  type CoinChoice,
  type LobbyDraftParticipant,
  type LobbyDraftState,
} from './draft-types.js';
import {
  buildLobbyDraftComponents,
  buildLobbyDraftEmbed,
  type LobbyDraftView,
} from './draft-ui.js';

const log = createLogger('lobby_draft');
const MAX_SAVE_ATTEMPTS = 5;

type ManageAuth = { actorDiscordId: string; memberRoleIds: string[]; matchModRoleId?: string };

function deadlineFor(phase: LobbyDraftState['phase']): string {
  return new Date(Date.now() + LOBBY_DRAFT_PHASE_SECONDS[phase] * 1000).toISOString();
}

async function loadView(profile: GameProfile): Promise<LobbyDraftView> {
  const heroes = await prisma.hero.findMany({ select: { id: true, name: true } });
  return { profile, heroNames: new Map(heroes.map((h) => [h.id, h.name])) };
}

async function threadChannel(client: Client, threadId: string) {
  const channel = await client.channels.fetch(threadId).catch(() => null);
  return channel?.isThread() ? channel : null;
}

/** Post log lines added by a mutation, pinging whoever must act next. */
async function postUpdate(
  client: Client,
  draft: LobbyDraft,
  prev: LobbyDraftState,
  next: LobbyDraftState,
) {
  const lines = next.log.slice(prev.log.length);
  const mentions: string[] = [];
  if (clockChanged(prev, next)) {
    const key = onClockCaptainKey(next);
    const id = key ? findParticipant(next, key)?.discordId : undefined;
    if (id) {
      mentions.push(id);
      lines.push(`<@${id}> you're on the clock.`);
    } else if (next.phase === 'HERO' && prev.phase !== 'HERO' && !next.heroResult) {
      const ids = linkedParticipants(next).map((p) => p.discordId!);
      mentions.push(...ids);
      lines.push(
        `Hero pick is open — ${ids.map((i) => `<@${i}>`).join(' ')} press **Pick heroes**.`,
      );
    }
  }
  if (lines.length === 0) return;
  const thread = await threadChannel(client, draft.threadId);
  await thread?.send({
    content: lines.join('\n').slice(0, 2000),
    allowedMentions: { users: mentions },
  });
}

export async function syncLobbyDraftLiveMessage(client: Client, draftId: string): Promise<void> {
  const draft = await loadLobbyDraftById(draftId);
  if (!draft.liveMessageId) return;
  const state = parseLobbyDraftState(draft);
  const view = await loadView(await getGameProfileForLeague(draft.leagueId));
  try {
    const thread = await threadChannel(client, draft.threadId);
    const message = await thread?.messages.fetch(draft.liveMessageId);
    await message?.edit({
      embeds: [buildLobbyDraftEmbed(draft, state, view)],
      components: draft.status === 'ACTIVE' ? buildLobbyDraftComponents(draft.id, state, view) : [],
    });
  } catch (error) {
    log.warn({ err: error, draftId }, 'Failed to sync lobby draft live message');
  }
}

async function finalize(client: Client, draft: LobbyDraft, state: LobbyDraftState): Promise<void> {
  const players = state.participants.map((p) => ({
    slot: state.heroResult![p.key]!.heroId,
    nick: p.nick,
  }));
  try {
    const match = await replaceMatchRoster(draft.matchId, players, {
      markLobbyRosterAuthority: true,
      completeLobbyDraftId: draft.id,
    });
    clearLobbyDraftTimer(draft.id);
    await syncLobbyDiscordMessage(client, match, 'pending');
    await (
      await threadChannel(client, draft.threadId)
    )?.send('✅ Lobby updated with the drafted teams and heroes.');
  } catch (error) {
    if (!(error instanceof MatchServiceError)) throw error;
    await cancelLobbyDraft(client, draft.id, error.message);
  }
}

/**
 * Load → mutate → optimistic save (retrying on conflict) → side effects.
 * `mutate` must be pure so it can be re-run on fresh state.
 */
async function mutateDraft(
  client: Client,
  draftId: string,
  mutate: (state: LobbyDraftState, profile: GameProfile, draft: LobbyDraft) => LobbyDraftState,
): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    const draft = await loadLobbyDraftById(draftId);
    if (draft.status !== 'ACTIVE') {
      throw new LobbyDraftError('This draft is no longer active.');
    }
    const prev = parseLobbyDraftState(draft);
    const profile = await getGameProfileForLeague(draft.leagueId);
    let next = mutate(prev, profile, draft);
    if (next.heroResult) {
      next = { ...next, deadlineAt: null };
    } else if (clockChanged(prev, next)) {
      next = { ...next, deadlineAt: deadlineFor(next.phase) };
    }

    let saved: LobbyDraft;
    try {
      saved = await saveLobbyDraftState(draft, next);
    } catch (error) {
      if (error instanceof LobbyDraftConflictError && attempt < MAX_SAVE_ATTEMPTS) continue;
      throw error;
    }

    await postUpdate(client, saved, prev, next);
    if (next.heroResult) {
      await finalize(client, saved, next);
    } else {
      scheduleLobbyDraftTimeout(client, saved.id, next.deadlineAt);
    }
    await syncLobbyDraftLiveMessage(client, saved.id);
    return;
  }
}

async function assertCanManageDraft(draftId: string, auth: ManageAuth): Promise<LobbyDraft> {
  const draft = await loadLobbyDraftById(draftId);
  assertCanManageMatch({ hostDiscordId: draft.hostDiscordId, ...auth });
  return draft;
}

export async function startLobbyDraft(
  input: {
    client: Client;
    messageId: string;
  } & ManageAuth,
): Promise<LobbyDraft> {
  const match = await getMatchByDiscordMessageId(input.messageId);
  if (!match || match.status !== 'PENDING' || !match.discordMessageId) {
    throw new MatchServiceError('This match can no longer be edited.');
  }
  const leagueId = requireLeagueId(match);
  assertCanManageMatch({ hostDiscordId: match.hostDiscordId, ...input });
  if (!(await resolveLeagueConfig(leagueId)).lobbyCaptainDraftEnabled) {
    throw new LobbyDraftError('Captain draft is disabled for this league.');
  }
  const profile = await getGameProfileForLeague(leagueId);
  if (profile.heroBinding !== 'slot_bound') {
    throw new LobbyDraftError('Captain draft is not available for this game.');
  }
  if (await findActiveLobbyDraftForMatch(match.id)) {
    throw new LobbyDraftError('A captain draft is already running for this lobby.');
  }
  const participants: LobbyDraftParticipant[] = match.players.map((mp) => ({
    key: participantKey(mp.player.username),
    nick: mp.player.username,
    ...(mp.player.discordId ? { discordId: mp.player.discordId } : {}),
  }));
  assertCanStartLobbyDraft(participants);
  const state = initialLobbyDraftState(participants, deadlineFor('VOTE'));

  const channel = await input.client.channels.fetch(match.discordChannelId);
  if (!channel?.isTextBased() || channel.isDMBased()) {
    throw new LobbyDraftError('Cannot open a thread in this channel.');
  }
  const lobbyMessage = await channel.messages.fetch(match.discordMessageId);
  const thread = await lobbyMessage.startThread({
    name: `Captain draft ${match.id.slice(-6)}`,
    autoArchiveDuration: ThreadAutoArchiveDuration.OneHour,
    reason: 'Lobby captain draft',
  });

  let draft: LobbyDraft;
  try {
    // ponytail: check-then-create inside one tx; two clicks in the same ms could still race. Add a partial unique index if it ever happens.
    draft = await prisma.$transaction(async (tx) => {
      if (await tx.lobbyDraft.findFirst({ where: { matchId: match.id, status: 'ACTIVE' } })) {
        throw new LobbyDraftError('A captain draft is already running for this lobby.');
      }
      return tx.lobbyDraft.create({
        data: {
          guildId: thread.guildId,
          leagueId,
          matchId: match.id,
          parentChannelId: channel.id,
          threadId: thread.id,
          hostDiscordId: match.hostDiscordId,
          status: 'ACTIVE',
          state: serializeLobbyDraftState(state),
        },
      });
    });
  } catch (error) {
    await thread.delete().catch(() => undefined);
    throw error;
  }

  const linkedIds = linkedParticipants(state).map((p) => p.discordId!);
  const unlinked = state.participants.filter((p) => !p.discordId).map((p) => `\`${p.nick}\``);
  const view = await loadView(profile);
  const live = await thread.send({
    content: [
      `⚔️ Captain draft for this lobby. ${linkedIds.map((id) => `<@${id}>`).join(' ')}`,
      unlinked.length ? `Unlinked: ${unlinked.join(', ')}` : '',
      'The lobby is frozen until the draft ends or is cancelled.',
    ]
      .filter(Boolean)
      .join('\n'),
    embeds: [buildLobbyDraftEmbed(draft, state, view)],
    components: buildLobbyDraftComponents(draft.id, state, view),
    allowedMentions: { users: linkedIds },
  });
  draft = await prisma.lobbyDraft.update({
    where: { id: draft.id },
    data: { liveMessageId: live.id },
  });
  scheduleLobbyDraftTimeout(input.client, draft.id, state.deadlineAt);
  log.info({ draftId: draft.id, matchId: match.id }, 'Lobby captain draft started');
  return draft;
}

type ActorInput = { client: Client; draftId: string; actorDiscordId: string };

export function voteCaptains(input: ActorInput & { keys: string[] }): Promise<void> {
  return mutateDraft(input.client, input.draftId, (s) =>
    castVote(s, input.actorDiscordId, input.keys),
  );
}

export function chooseCoinOption(input: ActorInput & { choice: CoinChoice }): Promise<void> {
  return mutateDraft(input.client, input.draftId, (s) => {
    assertOnClock(s, input.actorDiscordId);
    return chooseCoin(s, input.choice);
  });
}

export function pickPlayer(input: ActorInput & { key: string }): Promise<void> {
  return mutateDraft(input.client, input.draftId, (s) => {
    assertOnClock(s, input.actorDiscordId);
    return applyPick(s, input.key);
  });
}

export function chooseSide(input: ActorInput & { side: 1 | 2 }): Promise<void> {
  return mutateDraft(input.client, input.draftId, (s, profile) => {
    assertOnClock(s, input.actorDiscordId);
    return applySide(s, input.side, profile.teamNames);
  });
}

export function setHeroPreferences(input: ActorInput & { heroIds: number[] }): Promise<void> {
  return mutateDraft(input.client, input.draftId, (s, profile) =>
    setHeroPrefs(s, input.actorDiscordId, input.heroIds, profile),
  );
}

export function lockInHeroes(input: ActorInput): Promise<void> {
  return mutateDraft(input.client, input.draftId, (s, profile) =>
    lockInHero(s, input.actorDiscordId, profile),
  );
}

export async function manageRemove(
  input: ActorInput & ManageAuth & { key: string },
): Promise<void> {
  await assertCanManageDraft(input.draftId, input);
  return mutateDraft(input.client, input.draftId, (s, profile) =>
    removeParticipant(s, input.key, profile),
  );
}

/** Resolve "@mention / user id / nick" into a draft participant for this game. */
export async function resolveIncomingParticipant(
  gameId: string,
  raw: string,
): Promise<LobbyDraftParticipant> {
  const text = raw.trim();
  const discordId =
    /^<@!?(\d{17,20})>$/.exec(text)?.[1] ?? (/^\d{17,20}$/.test(text) ? text : null);
  if (discordId) {
    const nick = await nickForDiscordId(discordId, gameId);
    return { key: participantKey(nick), nick, discordId };
  }
  if (!text) {
    throw new LobbyDraftError('Enter a Discord @mention, user ID, or in-game nick.');
  }
  const player = await prisma.player.findUnique({
    where: { gameId_username: { gameId, username: participantKey(text) } },
  });
  const nick = player?.username ?? text;
  return {
    key: participantKey(nick),
    nick,
    ...(player?.discordId ? { discordId: player.discordId } : {}),
  };
}

export async function manageReplace(
  input: ActorInput & ManageAuth & { key: string; who: string },
): Promise<void> {
  const draft = await assertCanManageDraft(input.draftId, input);
  const profile = await getGameProfileForLeague(draft.leagueId);
  const incoming = await resolveIncomingParticipant(profile.gameId, input.who);
  await mutateDraft(input.client, input.draftId, (s, p) =>
    replaceParticipant(s, input.key, incoming, p),
  );
  if (incoming.discordId) {
    await (
      await threadChannel(input.client, draft.threadId)
    )?.send({
      content: `<@${incoming.discordId}> you joined this captain draft.`,
      allowedMentions: { users: [incoming.discordId] },
    });
  }
}

/** Cancel without auth (lobby lifecycle, finalize failure). Lobby roster is untouched. */
export async function cancelLobbyDraft(
  client: Client,
  draftId: string,
  reason: string,
): Promise<void> {
  clearLobbyDraftTimer(draftId);
  const draft = await setLobbyDraftStatus(draftId, 'CANCELLED');
  await syncLobbyDraftLiveMessage(client, draftId);
  const thread = await threadChannel(client, draft.threadId);
  await thread
    ?.send(`🚫 Draft cancelled: ${reason} The lobby can be edited again.`)
    .catch(() => undefined);
  await thread
    ?.setLocked(true)
    .catch((error: unknown) => log.warn({ err: error, draftId }, 'Failed to lock draft thread'));
}

export async function cancelLobbyDraftByUser(input: ActorInput & ManageAuth): Promise<void> {
  const draft = await assertCanManageDraft(input.draftId, input);
  if (draft.status !== 'ACTIVE') {
    throw new LobbyDraftError('This draft is no longer active.');
  }
  await cancelLobbyDraft(input.client, draft.id, `cancelled by <@${input.actorDiscordId}>.`);
}

export async function cancelActiveLobbyDraftForMatch(
  client: Client,
  matchId: string,
  reason: string,
): Promise<void> {
  const draft = await findActiveLobbyDraftForMatch(matchId);
  if (draft) await cancelLobbyDraft(client, draft.id, reason);
}

/** Timer path — no auth. Ignores early fires (rescheduled deadlines). */
export async function applyLobbyDraftTimeout(input: {
  client: Client;
  draftId: string;
}): Promise<void> {
  const draft = await loadLobbyDraftById(input.draftId);
  if (draft.status !== 'ACTIVE') return;
  const { deadlineAt } = parseLobbyDraftState(draft);
  if (deadlineAt && Date.now() + 50 < new Date(deadlineAt).getTime()) {
    scheduleLobbyDraftTimeout(input.client, draft.id, deadlineAt);
    return;
  }
  await mutateDraft(input.client, input.draftId, (s, profile) =>
    s.deadlineAt === deadlineAt ? applyTimeout(s, profile) : s,
  );
}

export async function getVoteMenuForActor(
  draftId: string,
  actorDiscordId: string,
): Promise<LobbyDraftState> {
  const state = parseLobbyDraftState(await loadLobbyDraftById(draftId));
  if (state.phase !== 'VOTE') throw new LobbyDraftError('Voting is closed.');
  if (!participantByDiscordId(state, actorDiscordId))
    throw new LobbyDraftError(NOT_IN_DRAFT_MESSAGE);
  return state;
}

export async function getHeroMenuForActor(
  draftId: string,
  actorDiscordId: string,
): Promise<{ heroes: Array<{ id: number; name: string }>; current: number[] }> {
  const draft = await loadLobbyDraftById(draftId);
  const state = parseLobbyDraftState(draft);
  const actor = participantByDiscordId(state, actorDiscordId);
  const t = actor ? teamOfKey(state, actor.key) : null;
  const side = t === null ? null : state.teams![t].side;
  if (state.phase !== 'HERO' || !actor || !side) throw new LobbyDraftError(NOT_IN_DRAFT_MESSAGE);
  const ids = heroIdsForSide(await getGameProfileForLeague(draft.leagueId), side);
  const heroes = await prisma.hero.findMany({
    where: { id: { in: ids } },
    orderBy: { id: 'asc' },
    select: { id: true, name: true },
  });
  return { heroes, current: state.heroPrefs[actor.key] ?? [] };
}

export async function getManageMenuForActor(
  draftId: string,
  auth: ManageAuth,
): Promise<LobbyDraftState> {
  return parseLobbyDraftState(await assertCanManageDraft(draftId, auth));
}
```

Note: if the stale-timeout guard `s.deadlineAt === deadlineAt ? … : s` returns unchanged state, `saveLobbyDraftState` still writes (harmless) — acceptable.

`index.ts` barrel:

```ts
export * from './draft-types.js';
export * from './draft-logic.js';
export * from './draft-ui.js';
export * from './draft-actions.js';
export { rehydrateLobbyDraftTimers } from './draft-timer.js';
```

- [ ] **Step 6: Run** `pnpm --filter @dbz/bot exec vitest run src/services/lobby-draft` → PASS; `pnpm typecheck` → PASS.

- [ ] **Step 7: Commit** `feat(lobby-draft): add draft UI, timers and use-cases`.

---

### Task 8: Discord adapter + routing + boot rehydrate (`game:warcraft3_udbr`)

**Files:**

- Create: `apps/bot/src/discord/interactions/lobby-draft-interactions.ts`
- Modify: `apps/bot/src/discord/interactions/lobby-interactions.ts:71` (export `memberRoleIds`)
- Modify: `apps/bot/src/events/interaction-create.ts` (route before `handleLobbyInteraction`)
- Modify: `apps/bot/src/index.ts:48` (rehydrate next to hero draft)
- Test: `apps/bot/src/discord/interactions/lobby-draft-interactions.test.ts`

**Interfaces:**

- Consumes: Task 7 exports via `../../services/lobby-draft/index.js`.
- Produces: `handleLobbyDraftInteraction(interaction: Interaction): Promise<boolean>`.

- [ ] **Step 1: Failing test** — routing returns false for foreign ids and maps a known error to an ephemeral reply:

```ts
import { describe, expect, it, vi } from 'vitest';

const { voteCaptains } = vi.hoisted(() => ({ voteCaptains: vi.fn() }));
vi.mock('../../lib/prisma.js', () => ({ prisma: {} }));
vi.mock('./lobby-interactions.js', () => ({ memberRoleIds: () => [] }));
vi.mock('../../services/lobby-draft/index.js', async (orig) => ({
  ...(await orig<typeof import('../../services/lobby-draft/index.js')>()),
  voteCaptains,
}));
vi.mock('../../services/guild/index.js', () => ({
  resolveGuildConfig: async () => ({ matchModRoleId: undefined }),
}));

import { handleLobbyDraftInteraction } from './lobby-draft-interactions.js';
import { LobbyDraftError } from '../../services/lobby-draft/index.js';

function select(customId: string, values: string[]) {
  const interaction = {
    customId,
    values,
    user: { id: 'u1' },
    member: null,
    guildId: 'g',
    client: {},
    isButton: () => false,
    isStringSelectMenu: () => true,
    isModalSubmit: () => false,
    deferred: false,
    replied: false,
    deferUpdate: vi.fn(async () => {
      interaction.deferred = true;
    }),
    reply: vi.fn(),
    followUp: vi.fn(),
    editReply: vi.fn(),
  };
  return interaction;
}

describe('handleLobbyDraftInteraction', () => {
  it('ignores other custom ids', async () => {
    expect(await handleLobbyDraftInteraction(select('lobby:move', []) as never)).toBe(false);
  });

  it('replies ephemerally with draft errors', async () => {
    voteCaptains.mockRejectedValueOnce(new LobbyDraftError("You're not in this draft."));
    const i = select('ldraft:votesel:d1', ['a']);
    expect(await handleLobbyDraftInteraction(i as never)).toBe(true);
    expect(i.followUp).toHaveBeenCalledWith(
      expect.objectContaining({ content: "You're not in this draft." }),
    );
  });
});
```

- [ ] **Step 2: Implement**

```ts
import {
  MessageFlags,
  type ButtonInteraction,
  type Interaction,
  type InteractionReplyOptions,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from 'discord.js';
import { createLogger } from '../../lib/logger.js';
import { resolveGuildConfig } from '../../services/guild/index.js';
import { MatchServiceError } from '../../services/match/index.js';
import {
  buildHeroMenu,
  buildManageMenus,
  buildReplaceModal,
  buildVoteMenu,
  cancelLobbyDraftByUser,
  chooseCoinOption,
  chooseSide,
  getHeroMenuForActor,
  getManageMenuForActor,
  getVoteMenuForActor,
  LOBBY_DRAFT_START_ID,
  LobbyDraftError,
  lockInHeroes,
  manageRemove,
  manageReplace,
  nickOf,
  parseLobbyDraftCustomId,
  pickPlayer,
  setHeroPreferences,
  startLobbyDraft,
  voteCaptains,
} from '../../services/lobby-draft/index.js';
import { memberRoleIds } from './lobby-interactions.js';

const log = createLogger('lobby_draft');

type DraftInteraction = ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction;

async function manageAuth(interaction: DraftInteraction) {
  const config = interaction.guildId ? await resolveGuildConfig(interaction.guildId) : undefined;
  return {
    actorDiscordId: interaction.user.id,
    memberRoleIds: memberRoleIds(interaction),
    matchModRoleId: config?.matchModRoleId,
  };
}

async function ephemeral(
  interaction: DraftInteraction,
  payload: Omit<InteractionReplyOptions, 'flags'>,
): Promise<void> {
  const body: InteractionReplyOptions = { ...payload, flags: MessageFlags.Ephemeral };
  if (interaction.deferred || interaction.replied) await interaction.followUp(body);
  else await interaction.reply(body);
}

async function route(interaction: DraftInteraction): Promise<boolean> {
  const client = interaction.client;
  const actorDiscordId = interaction.user.id;

  if (interaction.isButton() && interaction.customId === LOBBY_DRAFT_START_ID) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await startLobbyDraft({
      client,
      messageId: interaction.message.id,
      ...(await manageAuth(interaction)),
    });
    await interaction.editReply({ content: 'Captain draft started — see the thread.' });
    return true;
  }

  const parsed = parseLobbyDraftCustomId(interaction.customId);
  if (!parsed) return false;
  const { action, draftId, arg } = parsed;

  if (interaction.isButton()) {
    switch (action) {
      case 'vote':
        await ephemeral(
          interaction,
          buildVoteMenu(draftId, await getVoteMenuForActor(draftId, actorDiscordId)),
        );
        return true;
      case 'hero': {
        const { heroes, current } = await getHeroMenuForActor(draftId, actorDiscordId);
        await ephemeral(interaction, buildHeroMenu(draftId, heroes, current));
        return true;
      }
      case 'manage':
        await ephemeral(
          interaction,
          buildManageMenus(
            draftId,
            await getManageMenuForActor(draftId, await manageAuth(interaction)),
          ),
        );
        return true;
      case 'coin':
        await interaction.deferUpdate();
        await chooseCoinOption({
          client,
          draftId,
          actorDiscordId,
          choice: arg === 'SIDE' ? 'SIDE' : 'FIRST_PICK',
        });
        return true;
      case 'side':
        await interaction.deferUpdate();
        await chooseSide({ client, draftId, actorDiscordId, side: arg === '2' ? 2 : 1 });
        return true;
      case 'lockin':
        await interaction.deferUpdate();
        await lockInHeroes({ client, draftId, actorDiscordId });
        await interaction.editReply({
          content: '🔒 Locked in. Waiting for the others…',
          components: [],
        });
        return true;
      case 'cancel':
        await interaction.deferUpdate();
        await cancelLobbyDraftByUser({ client, draftId, ...(await manageAuth(interaction)) });
        return true;
      default:
        return false;
    }
  }

  if (interaction.isStringSelectMenu()) {
    switch (action) {
      case 'votesel':
        await interaction.deferUpdate();
        await voteCaptains({ client, draftId, actorDiscordId, keys: interaction.values });
        await interaction.editReply({
          content: '🗳️ Vote saved. You can change it until time runs out.',
          components: [],
        });
        return true;
      case 'pick':
        await interaction.deferUpdate();
        await pickPlayer({ client, draftId, actorDiscordId, key: interaction.values[0]! });
        return true;
      case 'herosel':
        await interaction.deferUpdate();
        await setHeroPreferences({
          client,
          draftId,
          actorDiscordId,
          heroIds: interaction.values.map(Number),
        });
        return true;
      case 'mrem':
        await interaction.deferUpdate();
        await manageRemove({
          client,
          draftId,
          key: interaction.values[0]!,
          ...(await manageAuth(interaction)),
        });
        await interaction.editReply({ content: 'Player removed.', components: [] });
        return true;
      case 'mrep': {
        const key = interaction.values[0]!;
        const state = await getManageMenuForActor(draftId, await manageAuth(interaction));
        await interaction.showModal(buildReplaceModal(draftId, key, nickOf(state, key)));
        return true;
      }
      default:
        return false;
    }
  }

  if (interaction.isModalSubmit() && action === 'mrepm' && arg) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await manageReplace({
      client,
      draftId,
      key: arg,
      who: interaction.fields.getTextInputValue('who'),
      ...(await manageAuth(interaction)),
    });
    await interaction.editReply({ content: 'Player replaced.' });
    return true;
  }
  return false;
}

/** Route `ldraft:*` components and the lobby "Captain draft" button. */
export async function handleLobbyDraftInteraction(interaction: Interaction): Promise<boolean> {
  if (
    !interaction.isButton() &&
    !interaction.isStringSelectMenu() &&
    !interaction.isModalSubmit()
  ) {
    return false;
  }
  try {
    return await route(interaction);
  } catch (error) {
    if (error instanceof LobbyDraftError || error instanceof MatchServiceError) {
      await ephemeral(interaction, { content: error.message });
      return true;
    }
    log.error({ err: error, customId: interaction.customId }, 'Lobby draft interaction failed');
    await ephemeral(interaction, { content: 'Could not apply that action. Please try again.' });
    return true;
  }
}
```

In `lobby-interactions.ts` change `function memberRoleIds` → `export function memberRoleIds`.

In `interaction-create.ts`: import and add, **before** `handleLobbyInteraction`:

```ts
if (await handleLobbyDraftInteraction(interaction)) {
  log.debug({ userId: interaction.user.id }, 'Lobby draft interaction handled');
  return;
}
```

In `index.ts`, next to `rehydrateHeroDraftTimers`:

```ts
try {
  await rehydrateLobbyDraftTimers(client);
} catch (error) {
  log.warn({ err: error }, 'Failed to rehydrate lobby draft timers');
}
```

- [ ] **Step 3: Run** `pnpm --filter @dbz/bot exec vitest run src/discord/interactions/lobby-draft-interactions.test.ts` and `pnpm typecheck` → PASS.

- [ ] **Step 4: Commit** `feat(lobby-draft): route draft interactions and rehydrate timers`.

---

### Task 9: Lobby button + lifecycle hooks (`game:warcraft3_udbr` button, `general` hooks)

**Files:**

- Modify: `apps/bot/src/services/lobby/lobby-preview.ts:675-723` (`buildLobbyButtons`)
- Modify: `apps/bot/src/services/lobby/discord-sync.ts:73-95,140-162`
- Modify: `apps/bot/src/services/lobby/lifecycle.ts`
- Test: `apps/bot/src/services/lobby/lobby-preview.test.ts`, new `apps/bot/src/services/lobby/lifecycle.test.ts`

**Interfaces:**

- Consumes: `LOBBY_DRAFT_START_ID`, `canStartLobbyDraft`, `participantKey`, `cancelActiveLobbyDraftForMatch` from `../lobby-draft/index.js`.
- Produces: `buildLobbyButtons({ …, captainDraftAvailable?: boolean })`.

- [ ] **Step 1: Failing tests**

`lobby-preview.test.ts`:

```ts
describe('captain draft button', () => {
  it('shows only when available', () => {
    const ids = (rows: ReturnType<typeof buildLobbyButtons>) =>
      rows.flatMap((r) => r.toJSON().components.map((c) => ('custom_id' in c ? c.custom_id : '')));
    expect(ids(buildLobbyButtons({ captainDraftAvailable: true }))).toContain('ldraft:start');
    expect(ids(buildLobbyButtons({}))).not.toContain('ldraft:start');
  });
});
```

`lifecycle.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  cancelDraft: vi.fn(),
  startMatch: vi.fn(),
  cancelMatch: vi.fn(),
  sync: vi.fn(),
  resolveHost: vi.fn(),
  resolveManage: vi.fn(),
}));
vi.mock('../lobby-draft/index.js', () => ({ cancelActiveLobbyDraftForMatch: m.cancelDraft }));
vi.mock('../match/match-service.js', () => ({
  startMatch: m.startMatch,
  cancelMatch: m.cancelMatch,
  matchToLobbyPlayers: () => [],
}));
vi.mock('./discord-sync.js', () => ({ syncLobbyDiscordMessage: m.sync }));
vi.mock('./resolve.js', () => ({
  resolveHostPendingMatch: m.resolveHost,
  resolvePendingMatchByMessageId: m.resolveHost,
  resolvePendingMatchForManage: m.resolveManage,
}));

import { cancelLobbyMatch, startLobbyMatch } from './lifecycle.js';

describe('lifecycle cancels active draft', () => {
  beforeEach(() => vi.clearAllMocks());

  it('on start', async () => {
    m.resolveHost.mockResolvedValue({ match: { id: 'M' } });
    m.startMatch.mockResolvedValue({ id: 'M' });
    await startLobbyMatch({ client: {} as never, hostDiscordId: 'h' });
    expect(m.cancelDraft).toHaveBeenCalledWith({}, 'M', 'the lobby was started.');
  });

  it('on cancel', async () => {
    m.resolveManage.mockResolvedValue({ match: { id: 'M', hostDiscordId: 'h' } });
    m.cancelMatch.mockResolvedValue({ id: 'M' });
    await cancelLobbyMatch({ client: {} as never, actorDiscordId: 'h', memberRoleIds: [] });
    expect(m.cancelDraft).toHaveBeenCalledWith({}, 'M', 'the lobby was cancelled.');
  });
});
```

Run → FAIL.

- [ ] **Step 2: Implement**

`buildLobbyButtons`: add `captainDraftAvailable?: boolean;` to the options type; after the Start button block (before `rows.push(topRow)`):

```ts
if (options.captainDraftAvailable) {
  topRow.addComponents(
    new ButtonBuilder()
      .setCustomId(LOBBY_DRAFT_START_ID)
      .setLabel('Captain draft')
      .setEmoji('⚔️')
      .setStyle(ButtonStyle.Secondary),
  );
}
```

(Import `LOBBY_DRAFT_START_ID` from `../lobby-draft/draft-ui.js` directly to keep the lobby → draft dependency narrow.)

`discord-sync.ts`: `resolveLeagueSettingsForLobby` selects `lobbyCaptainDraftEnabled: true` and returns `captainDraftEnabled: league.lobbyCaptainDraftEnabled` (false in the not-found and event branches). In the `pending` branch:

```ts
const captainDraftAvailable =
  captainDraftEnabled &&
  profile.heroBinding === 'slot_bound' &&
  canStartLobbyDraft(
    match.players.map((mp) => ({
      key: participantKey(mp.player.username),
      nick: mp.player.username,
      ...(mp.player.discordId ? { discordId: mp.player.discordId } : {}),
    })),
  );
```

and pass `captainDraftAvailable` to `buildLobbyButtons`. (Import `canStartLobbyDraft` from `../lobby-draft/draft-logic.js` and `participantKey` from `../lobby-draft/draft-types.js`.)

`lifecycle.ts`: after each successful `startMatch` (both functions) add `await cancelActiveLobbyDraftForMatch(input.client, match.id, 'the lobby was started.');` and after `cancelMatch` add `await cancelActiveLobbyDraftForMatch(input.client, match.id, 'the lobby was cancelled.');`. Import from `../lobby-draft/index.js`.

- [ ] **Step 3: Run full bot suite + typecheck**

Run: `pnpm --filter @dbz/bot test && pnpm typecheck`
Expected: PASS. If an existing `discord-sync` test fixture lacks `player.discordId` or the league select mock lacks the new field, update the fixture.

- [ ] **Step 4: Commit** `feat(lobby-draft): add Captain draft lobby button and lifecycle hooks`.

---

### Task 10: Docs, format, manual smoke (`general`)

**Files:**

- Modify: `.claude/rules/database-domain.md` (Tables list: add `LobbyDraft`)
- Modify: `.claude/rules/slash-commands.md` only if it lists `/league_config set` subcommands (add `captain_draft`)

- [ ] **Step 1: Docs.** In `database-domain.md` Tables, add:

```md
- **LobbyDraft** — lobby captain draft (vote → snake → side → hero pick) for one PENDING `matchId`; while ACTIVE the lobby roster is frozen (`replaceMatchRoster` / `setMatchPlayersLocked` guard). `game:warcraft3_udbr` (slot-bound) only.
```

- [ ] **Step 2: Format + full verification**

Run: `pnpm format && pnpm format:check && pnpm typecheck && pnpm --filter @dbz/bot test`
Expected: all PASS.

- [ ] **Step 3: Manual smoke on the dev guild** (local DB via `pnpm db:up`, `pnpm dev`):
  1. `/league_config set captain_draft enabled:true` on the UDBR league.
  2. Register a lobby with ≥4 players, ≥2 linked → **Captain draft** button appears; with 3 players it does not.
  3. Start → thread opens, linked players pinged, unlinked listed; lobby buttons Move/Balance reply with the frozen message.
  4. Vote from two accounts → closes early; coin choice, picks, side, hero pick with one clash → lobby embed shows the new slots; swap commands field updated.
  5. Start another draft, use **Manage → Replace** with a nick, **Remove** below 2v2 (refused), then **Cancel draft** → thread locked, lobby editable.
  6. Restart the bot mid-pick → deadline still fires.

- [ ] **Step 4: Commit** `docs(lobby-draft): document LobbyDraft table`.
