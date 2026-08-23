# Manual New-player flag command Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `/player_new set` and `/player_new clear` so match-mods can set or clear league-scoped `PlayerRating.isNewPlayer` by nick or Discord user.

**Architecture:** Shared write helpers in `src/services/rating/new-player.ts`; thin Discord adapter in `src/commands/player/player-new.ts`. No schema changes. Historical `MatchPlayer.wasNewPlayer` is never rewritten.

**Tech Stack:** Node.js + TypeScript (ESM), discord.js v14 Slash Commands, Prisma, Vitest

**Spec:** `docs/superpowers/specs/2026-08-24-player-new-command-design.md`

## Global Constraints

- Scope: `general` (league-keyed; no WC3-only imports)
- Permissions: match-mod only (`assertHasMatchModRole`)
- Target: exactly one of `nick` or `user` (reject both / neither)
- Language: English user-facing strings
- Idempotent set/clear replies
- Do not mutate `MatchPlayer.wasNewPlayer`
- Conventional Commits for every commit

---

## File map

| File                                     | Responsibility                                           |
| ---------------------------------------- | -------------------------------------------------------- |
| `src/services/rating/new-player.ts`      | `setPlayerNewFlag` / `clearPlayerNewFlag` + result types |
| `src/services/rating/new-player.test.ts` | Unit tests for set/clear (extend existing file)          |
| `src/services/rating/index.ts`           | Re-export new helpers/types                              |
| `src/commands/player/player-new.ts`      | Slash command `data` + `execute` + league autocomplete   |
| `src/commands/player/player-new.test.ts` | Subcommand registration smoke test                       |

---

### Task 1: Service helpers — set/clear New flag

**Files:**

- Modify: `src/services/rating/new-player.ts`
- Modify: `src/services/rating/new-player.test.ts`
- Modify: `src/services/rating/index.ts`
- Test: `src/services/rating/new-player.test.ts`

**Interfaces:**

- Consumes: `ensurePlayerRatings` from `./rating-preview.js`; `prisma` / optional `Db`; `isLeagueWritable` + `LEAGUE_ARCHIVED_MESSAGE` from `../league/league.js`; `MatchServiceError` from `../match/match-service.js`
- Produces:

  ```ts
  export type PlayerNewFlagResult =
    | { status: 'set'; username: string }
    | { status: 'already_new'; username: string }
    | { status: 'cleared'; username: string }
    | { status: 'not_new'; username: string };

  export async function setPlayerNewFlag(input: {
    leagueId: string;
    playerId: string;
    username: string;
    db?: Db;
  }): Promise<PlayerNewFlagResult>; // 'set' | 'already_new'; throws if league archived

  export async function clearPlayerNewFlag(input: {
    leagueId: string;
    playerId: string;
    username: string;
    db?: Db;
  }): Promise<PlayerNewFlagResult>; // 'cleared' | 'not_new'; throws if league archived
  ```

- [ ] **Step 1: Write the failing tests**

Append to `src/services/rating/new-player.test.ts` (add prisma + ensurePlayerRatings mocks at top of file alongside existing pure tests, or add a second describe block with hoisted mocks — prefer extending the file with a hoisted mock section used only by the DB tests):

```ts
const {
  leagueFindUnique,
  playerRatingFindUnique,
  playerRatingUpdate,
  playerRatingCreateMany,
  playerHeroRatingCreateMany,
} = vi.hoisted(() => ({
  leagueFindUnique: vi.fn(),
  playerRatingFindUnique: vi.fn(),
  playerRatingUpdate: vi.fn(),
  playerRatingCreateMany: vi.fn(),
  playerHeroRatingCreateMany: vi.fn(),
}));

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    league: { findUnique: leagueFindUnique },
    playerRating: {
      findUnique: playerRatingFindUnique,
      update: playerRatingUpdate,
      createMany: playerRatingCreateMany,
    },
    playerHeroRating: { createMany: playerHeroRatingCreateMany },
  },
}));

// import setPlayerNewFlag, clearPlayerNewFlag after mocks
```

Tests:

```ts
describe('setPlayerNewFlag', () => {
  beforeEach(() => {
    leagueFindUnique.mockResolvedValue({ archivedAt: null });
    playerRatingCreateMany.mockResolvedValue({ count: 1 });
    playerHeroRatingCreateMany.mockResolvedValue({ count: 0 });
    playerRatingUpdate.mockResolvedValue({});
  });

  it('sets isNewPlayer when currently false', async () => {
    playerRatingFindUnique.mockResolvedValue({ isNewPlayer: false });
    await expect(
      setPlayerNewFlag({ leagueId: 'L', playerId: 'P', username: 'rookie' }),
    ).resolves.toEqual({ status: 'set', username: 'rookie' });
    expect(playerRatingUpdate).toHaveBeenCalledWith({
      where: { leagueId_playerId: { leagueId: 'L', playerId: 'P' } },
      data: { isNewPlayer: true },
    });
  });

  it('returns already_new when flag is true', async () => {
    playerRatingFindUnique.mockResolvedValue({ isNewPlayer: true });
    await expect(
      setPlayerNewFlag({ leagueId: 'L', playerId: 'P', username: 'rookie' }),
    ).resolves.toEqual({ status: 'already_new', username: 'rookie' });
    expect(playerRatingUpdate).not.toHaveBeenCalled();
  });
});

describe('clearPlayerNewFlag', () => {
  beforeEach(() => {
    leagueFindUnique.mockResolvedValue({ archivedAt: null });
    playerRatingUpdate.mockResolvedValue({});
  });

  it('clears when currently true', async () => {
    playerRatingFindUnique.mockResolvedValue({ isNewPlayer: true });
    await expect(
      clearPlayerNewFlag({ leagueId: 'L', playerId: 'P', username: 'rookie' }),
    ).resolves.toEqual({ status: 'cleared', username: 'rookie' });
    expect(playerRatingUpdate).toHaveBeenCalledWith({
      where: { leagueId_playerId: { leagueId: 'L', playerId: 'P' } },
      data: { isNewPlayer: false },
    });
  });

  it('returns not_new when missing row or false', async () => {
    playerRatingFindUnique.mockResolvedValue(null);
    await expect(
      clearPlayerNewFlag({ leagueId: 'L', playerId: 'P', username: 'rookie' }),
    ).resolves.toEqual({ status: 'not_new', username: 'rookie' });
    expect(playerRatingUpdate).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/services/rating/new-player.test.ts`

Expected: FAIL — `setPlayerNewFlag` / `clearPlayerNewFlag` not exported

- [ ] **Step 3: Implement helpers**

In `src/services/rating/new-player.ts`:

1. Import `ensurePlayerRatings` from `./rating-preview.js`.
2. Import `isLeagueWritable`, `LEAGUE_ARCHIVED_MESSAGE` from `../league/league.js`.
3. Import `MatchServiceError` from `../match/match-service.js` (file import — avoid `../match/index.js` circular risk with match-report → new-player). **Lock:** throw `MatchServiceError(LEAGUE_ARCHIVED_MESSAGE)` after loading the league.

```ts
async function assertLeagueWritable(leagueId: string, db: Db): Promise<void> {
  const league = await db.league.findUnique({
    where: { id: leagueId },
    select: { archivedAt: true },
  });
  if (league && !isLeagueWritable(league)) {
    throw new MatchServiceError(LEAGUE_ARCHIVED_MESSAGE);
  }
}

export async function setPlayerNewFlag(input: {
  leagueId: string;
  playerId: string;
  username: string;
  db?: Db;
}): Promise<Extract<PlayerNewFlagResult, { status: 'set' | 'already_new' }>> {
  const db = input.db ?? prisma;
  await assertLeagueWritable(input.leagueId, db);
  await ensurePlayerRatings(input.leagueId, [{ playerId: input.playerId, heroId: null }], db);
  const row = await db.playerRating.findUnique({
    where: { leagueId_playerId: { leagueId: input.leagueId, playerId: input.playerId } },
    select: { isNewPlayer: true },
  });
  if (row?.isNewPlayer) {
    return { status: 'already_new', username: input.username };
  }
  await db.playerRating.update({
    where: { leagueId_playerId: { leagueId: input.leagueId, playerId: input.playerId } },
    data: { isNewPlayer: true },
  });
  return { status: 'set', username: input.username };
}

export async function clearPlayerNewFlag(input: {
  leagueId: string;
  playerId: string;
  username: string;
  db?: Db;
}): Promise<Extract<PlayerNewFlagResult, { status: 'cleared' | 'not_new' }>> {
  const db = input.db ?? prisma;
  await assertLeagueWritable(input.leagueId, db);
  const row = await db.playerRating.findUnique({
    where: { leagueId_playerId: { leagueId: input.leagueId, playerId: input.playerId } },
    select: { isNewPlayer: true },
  });
  if (!row?.isNewPlayer) {
    return { status: 'not_new', username: input.username };
  }
  await db.playerRating.update({
    where: { leagueId_playerId: { leagueId: input.leagueId, playerId: input.playerId } },
    data: { isNewPlayer: false },
  });
  return { status: 'cleared', username: input.username };
}
```

Note: `Db` today is `Prisma.TransactionClient | typeof prisma`. `league.findUnique` must exist on the client — it does on both.

If the existing `new-player.test.ts` mock only stubs `playerRating.findMany`, expand the prisma mock so pure tests still pass (existing `collect*` tests live in `new-player-suggest.test.ts`; this file’s pure tests do not need prisma — but adding `vi.mock('../../lib/prisma.js')` at file top is fine).

Export from `src/services/rating/index.ts`:

```ts
  setPlayerNewFlag,
  clearPlayerNewFlag,
  type PlayerNewFlagResult,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/services/rating/new-player.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/rating/new-player.ts src/services/rating/new-player.test.ts src/services/rating/index.ts
git commit -m "$(cat <<'EOF'
feat(rating): add set/clear New player flag helpers

EOF
)"
```

---

### Task 2: Slash command `/player_new`

**Files:**

- Create: `src/commands/player/player-new.ts`
- Create: `src/commands/player/player-new.test.ts`
- Test: `src/commands/player/player-new.test.ts`

**Interfaces:**

- Consumes: `setPlayerNewFlag`, `clearPlayerNewFlag` from Task 1; `parseRankOptions`, `findPlayerForRankLookup`, `PlayerServiceError` from player service; `assertHasMatchModRole`, `MatchServiceError` from match; league resolve helpers + `withSubcommandLeagueOption`; `resolveGuildConfig`
- Produces: loaded command name `player_new` (auto-discovered by `load-commands.ts`)

- [ ] **Step 1: Write the failing registration test**

Create `src/commands/player/player-new.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { data } from './player-new.js';

describe('player_new command data', () => {
  it('registers set and clear subcommands', () => {
    const json = data.toJSON();
    expect(json.name).toBe('player_new');
    expect(json.options?.map((option) => option.name)).toEqual(['set', 'clear']);
  });

  it('set and clear accept nick, user, and league', () => {
    const json = data.toJSON();
    for (const name of ['set', 'clear'] as const) {
      const sub = json.options?.find((option) => option.name === name);
      const optionNames = sub?.options?.map((option) => option.name) ?? [];
      expect(optionNames).toEqual(expect.arrayContaining(['nick', 'user', 'league']));
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/commands/player/player-new.test.ts`

Expected: FAIL — cannot resolve `./player-new.js`

- [ ] **Step 3: Implement the command**

Create `src/commands/player/player-new.ts` following `link.ts` / `leaderboard.ts` patterns:

```ts
import { GuildMember, MessageFlags, SlashCommandBuilder } from 'discord.js';
import type { AutocompleteInteraction, ChatInputCommandInteraction } from 'discord.js';
import { createLogger } from '../../lib/logger.js';
import { resolveGuildConfig } from '../../services/guild/index.js';
import {
  getGameProfileForLeague,
  getLeagueOption,
  resolveLeagueIdFromInteraction,
  respondLeagueAutocomplete,
  withSubcommandLeagueOption,
} from '../../services/league/index.js';
import { assertHasMatchModRole, MatchServiceError } from '../../services/match/index.js';
import {
  findPlayerForRankLookup,
  parseRankOptions,
  PlayerServiceError,
} from '../../services/player/index.js';
import { clearPlayerNewFlag, setPlayerNewFlag } from '../../services/rating/index.js';

const log = createLogger('player_new_cmd');

// Copy memberRoleIds helper verbatim from src/commands/player/link.ts

export const data = new SlashCommandBuilder()
  .setName('player_new')
  .setDescription('Set or clear the New-player rating flag (moderators)')
  .addSubcommand((subcommand) =>
    withSubcommandLeagueOption(
      subcommand
        .setName('set')
        .setDescription('Mark a player as New for this league')
        .addStringOption((option) =>
          option.setName('nick').setDescription('In-game nick').setRequired(false),
        )
        .addUserOption((option) =>
          option.setName('user').setDescription('Discord user').setRequired(false),
        ),
    ),
  )
  .addSubcommand((subcommand) =>
    withSubcommandLeagueOption(
      subcommand
        .setName('clear')
        .setDescription('Remove the New flag from a player in this league')
        .addStringOption((option) =>
          option.setName('nick').setDescription('In-game nick').setRequired(false),
        )
        .addUserOption((option) =>
          option.setName('user').setDescription('Discord user').setRequired(false),
        ),
    ),
  );

export async function autocomplete(interaction: AutocompleteInteraction): Promise<void> {
  await respondLeagueAutocomplete(interaction);
}

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const subcommand = interaction.options.getSubcommand(true);
  const nick = interaction.options.getString('nick');
  const user = interaction.options.getUser('user');

  try {
    if (!interaction.guildId) {
      await interaction.editReply({ content: 'This command can only be used in a server.' });
      return;
    }

    const config = await resolveGuildConfig(interaction.guildId);
    assertHasMatchModRole({
      actorDiscordId: interaction.user.id,
      memberRoleIds: memberRoleIds(interaction),
      matchModRoleId: config.matchModRoleId,
    });

    // Require exactly one of nick | user (do not default to self).
    if (nick && user) {
      throw new PlayerServiceError('Provide either a Discord user or a nick, not both.');
    }
    if (!nick && !user) {
      throw new PlayerServiceError('Provide a nick or a Discord user.');
    }

    const lookup = parseRankOptions({
      selfDiscordId: interaction.user.id,
      userDiscordId: user?.id,
      nick,
    });
    if (lookup.kind === 'both' || lookup.kind === 'self') {
      throw new PlayerServiceError('Provide a nick or a Discord user.');
    }

    const resolved = await resolveLeagueIdFromInteraction(
      interaction,
      getLeagueOption(interaction),
    );
    if (!resolved.ok) {
      await interaction.editReply({ content: resolved.message });
      return;
    }

    const gameProfile = await getGameProfileForLeague(resolved.leagueId);
    const player = await findPlayerForRankLookup(gameProfile.gameId, lookup);
    if (!player) {
      throw new PlayerServiceError('Player not found.');
    }

    if (subcommand === 'set') {
      const result = await setPlayerNewFlag({
        leagueId: resolved.leagueId,
        playerId: player.id,
        username: player.username,
      });
      await interaction.editReply({
        content:
          result.status === 'set'
            ? `Marked **${result.username}** as New. They will not affect team ratings until 5 games.`
            : `**${result.username}** is already marked New.`,
      });
      return;
    }

    if (subcommand === 'clear') {
      const result = await clearPlayerNewFlag({
        leagueId: resolved.leagueId,
        playerId: player.id,
        username: player.username,
      });
      await interaction.editReply({
        content:
          result.status === 'cleared'
            ? `Cleared New from **${result.username}**. They rate normally from the next completed match.`
            : `**${result.username}** is not marked New.`,
      });
      return;
    }

    await interaction.editReply({ content: 'Unknown subcommand.' });
  } catch (error) {
    if (error instanceof PlayerServiceError || error instanceof MatchServiceError) {
      await interaction.editReply({ content: error.message });
      return;
    }
    log.error({ err: error }, 'player_new command failed');
    await interaction.editReply({ content: 'Something went wrong updating the New flag.' });
  }
}
```

Copy `memberRoleIds` verbatim from `src/commands/player/link.ts`.

- [ ] **Step 4: Run tests**

Run:

```bash
npx vitest run src/commands/player/player-new.test.ts src/services/rating/new-player.test.ts
npm run typecheck
```

Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add src/commands/player/player-new.ts src/commands/player/player-new.test.ts
git commit -m "$(cat <<'EOF'
feat(player): add /player_new set and clear commands

EOF
)"
```

---

### Task 3: Spec status + smoke notes

**Files:**

- Modify: `docs/superpowers/specs/2026-08-24-player-new-command-design.md` — set `Status: Implemented` after code lands (or `Approved` when starting; `Implemented` when Task 2 is done)

- [ ] **Step 1: Update design status to Implemented**

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/specs/2026-08-24-player-new-command-design.md
git commit -m "$(cat <<'EOF'
docs: mark player_new command design implemented

EOF
)"
```

- [ ] **Step 3: Manual smoke (dev bot)**

1. Restart bot so `AUTO_DEPLOY_COMMANDS` registers `/player_new`.
2. As mod: `/player_new set nick:<known>` → New marker on next lobby preview.
3. `/player_new clear nick:<same>` → marker gone; reply says cleared.
4. Repeat set when already New → already-marked message.
5. Non-mod → forbidden.
6. Both nick+user → error.

---

## Spec coverage checklist

| Spec requirement                   | Task                             |
| ---------------------------------- | -------------------------------- |
| `/player_new set` / `clear`        | 2                                |
| Match-mod only                     | 2                                |
| nick XOR user                      | 2                                |
| Optional league                    | 2 (`withSubcommandLeagueOption`) |
| Live `isNewPlayer` only            | 1                                |
| Idempotent replies                 | 1 + 2                            |
| No `wasNewPlayer` rewrite          | 1 (no code path)                 |
| Shared use-case in `new-player.ts` | 1                                |
| Ensure rating row on set           | 1                                |
| English strings                    | 2                                |
| Unit + registration tests          | 1 + 2                            |

## Branch note

Implement on a feature branch off `main` (e.g. `feat/player-new-command`), not on unrelated deploy fix branches. The design doc commit may already be on another branch — cherry-pick or move as needed before opening a PR.
