# Per-Game Player Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scope `Player` identity and Discord↔nick links by `Game.id`, with league resolve selecting the game for `/link` / `/unlink` / lookups.

**Architecture:** Add required `Player.gameId` (FK to `Game`); replace global uniques with `@@unique([gameId, username])` and `@@unique([gameId, discordId])`. Backfill existing rows to `warcraft3_udbr`. Thread `gameId` through link, profile, lobby identity, match roster resolve, rank-reset, host-prompt, and settings. Slash commands resolve a league first, then use `league.gameId`.

**Tech Stack:** TypeScript ESM, Prisma 7 + PostgreSQL, discord.js v14, Vitest

**Spec:** `docs/superpowers/specs/2026-08-17-per-game-player-identity-design.md`

## Global Constraints

- Scope: `general` (identity / tenancy — not game-specific adapters)
- English-only user-facing strings and errors
- Isolation key: **`Game.id`** (not league, not guild)
- **Worldwide per-game bind:** one Discord + one `gameId` → one nick globally; document in public docs
- Game selection UX: **league resolve only** (no slash `game:` option)
- Migration: all existing `Player` → `warcraft3_udbr`; do not copy into other games
- `MatchPlayer.player.gameId` must equal `Match.league.gameId`
- ESM `.js` imports; named exports
- No new env/SSM keys
- Branch: `feature/per-game-player-identity` (create worktree at execution time if using worktrees skill)

## File map

| File | Role |
|------|------|
| `prisma/schema.prisma` | `Player.gameId` + composite uniques |
| `prisma/migrations/20260817090000_player_game_identity/` | SQL backfill + constraints |
| `src/services/player/player-link.ts` | `linkPlayer` / `unlinkByDiscordId` take `gameId` |
| `src/services/player/player-link.test.ts` | Unit tests |
| `src/services/player/player-profile.ts` | Discord/nick lookup scoped by league’s `gameId` |
| `src/services/player/player-profile.test.ts` | Update mocks / expectations |
| `src/services/player/player-settings.ts` | Host-ping prefs per `(gameId, discordId)` |
| `src/services/player/player-settings.test.ts` | Update if present; add if missing coverage |
| `src/commands/player/link.ts` | League resolve → `gameId` |
| `src/commands/player/unlink.ts` | League resolve → `gameId` |
| `src/commands/player/settings.ts` | League resolve → `gameId` |
| `src/commands/player/rank.ts` | Already resolves league; profile uses `gameId` internally |
| `src/services/lobby/lobby-identity.ts` | `nickForDiscordId(discordId, gameId)` |
| `src/services/lobby/lobby-identity.test.ts` | Composite lookup |
| `src/services/lobby/actions.ts` | Pass match league `gameId` into nick resolve |
| `src/services/lobby/wc3stats-refresh.ts` | Pass `gameId` |
| `src/services/lobby/create-from-wc3stats.ts` | Pass `gameId` |
| `src/commands/lobby/register-lobby.ts` | Pass `gameId` after league known |
| `src/discord/interactions/lobby-interactions.ts` | Pass `gameId` |
| `src/services/match/match-service.ts` | `resolvePlayersInTx` filter/create by `profile.gameId` |
| `src/services/rating/rank-reset.ts` | Player by `(gameId, discordId)` |
| `src/services/wc3stats/wc3stats-host-prompt-poller.ts` | Linked map filtered by league `gameId` |
| `src/services/wc3stats/wc3stats-host-prompt-poller.test.ts` | Expect `gameId` in query |
| `scripts/seed-veteran-ratings.ts` | Lookups/creates include `gameId` |
| `docs/discord/public/02-link-your-nick.md` | Per-game + worldwide rule |
| `.cursor/rules/database-domain.mdc` | Identity wording |
| `.cursor/rules/feature-scope-game-vs-general.mdc` | “Player link” → per-game |
| `docs/superpowers/specs/2026-08-15-multi-league-ihl-design.md` | Supersession note |

---

### Task 1: Prisma — `Player.gameId` + migration

**Files:**
- Modify: `prisma/schema.prisma` (`Game`, `Player`)
- Create: `prisma/migrations/20260817090000_player_game_identity/migration.sql`

**Interfaces:**
- Produces: `Player.gameId: string` (required); `@@unique([gameId, username])`; `@@unique([gameId, discordId])`; Prisma compound names `gameId_username`, `gameId_discordId`

- [ ] **Step 1: Update `Game` and `Player` in schema**

In `prisma/schema.prisma`, on `Game` add:

```prisma
  players Player[]
```

Replace the `Player` model with:

```prisma
model Player {
  id                             String             @id @default(uuid())
  gameId                         String
  username                       String
  discordId                      String?
  wc3statsHostPromptPingsEnabled Boolean            @default(true)
  createdAt                      DateTime           @default(now())
  updatedAt                      DateTime           @updatedAt
  game                           Game               @relation(fields: [gameId], references: [id])
  matches                        MatchPlayer[]
  ratings                        PlayerRating[]
  heroRatings                    PlayerHeroRating[]
  rankResets                     PlayerRankReset[]
  ratingSnapshots                MatchRatingSnapshot[]

  @@unique([gameId, username])
  @@unique([gameId, discordId])
  @@index([gameId])
  @@index([username])
  @@index([discordId])
}
```

Remove the old `@unique` on `username` and `discordId`.

- [ ] **Step 2: Write migration SQL**

Create `prisma/migrations/20260817090000_player_game_identity/migration.sql`:

```sql
-- AlterTable
ALTER TABLE "Player" ADD COLUMN "gameId" TEXT;

-- Backfill legacy rows to UDBR (must exist in "Game")
UPDATE "Player" SET "gameId" = 'warcraft3_udbr' WHERE "gameId" IS NULL;

-- AlterTable
ALTER TABLE "Player" ALTER COLUMN "gameId" SET NOT NULL;

-- DropIndex (names may differ — use prisma migrate diff or \d if needed)
DROP INDEX IF EXISTS "Player_username_key";
DROP INDEX IF EXISTS "Player_discordId_key";

-- CreateIndex
CREATE UNIQUE INDEX "Player_gameId_username_key" ON "Player"("gameId", "username");
CREATE UNIQUE INDEX "Player_gameId_discordId_key" ON "Player"("gameId", "discordId");
CREATE INDEX "Player_gameId_idx" ON "Player"("gameId");

-- AddForeignKey
ALTER TABLE "Player" ADD CONSTRAINT "Player_gameId_fkey" FOREIGN KEY ("gameId") REFERENCES "Game"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
```

If local index names differ, run `npx prisma migrate diff` against the DB and adjust `DROP INDEX` names before applying.

- [ ] **Step 3: Generate client and apply locally**

Run:

```bash
npx prisma generate
npx prisma migrate deploy
```

Expected: client includes `gameId`; migration applies cleanly on local Postgres.

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260817090000_player_game_identity
git commit -m "$(cat <<'EOF'
feat(db): scope Player identity by gameId

EOF
)"
```

---

### Task 2: `linkPlayer` / `unlinkByDiscordId` take `gameId`

**Files:**
- Modify: `src/services/player/player-link.ts`
- Modify: `src/services/player/player-link.test.ts`

**Interfaces:**
- Consumes: Prisma compound uniques from Task 1
- Produces:
  - `linkPlayer(input: { gameId: string; nick: string; discordId: string; allowRelink?: boolean }): Promise<{ username: string; discordId: string; gameId: string }>`
  - `unlinkByDiscordId(gameId: string, discordId: string, options?: { self?: boolean }): Promise<{ username: string }>`
  - Internal finds scoped with `gameId`

- [ ] **Step 1: Update failing tests for `gameId`**

In `player-link.test.ts`, every `linkPlayer({...})` / `unlink` call must pass `gameId: 'warcraft3_udbr'` (or a second game in a dedicated case). Add:

```typescript
it('links the same discord to different nicks on different games', async () => {
  findUnique
    .mockResolvedValueOnce(null) // nick on anime
    .mockResolvedValueOnce(null); // discord on anime
  create.mockResolvedValue({
    id: 'p2',
    username: 'Vegeta',
    discordId: 'd1',
    gameId: 'warcraft3_anime_choice_arena',
  });

  const linked = await linkPlayer({
    gameId: 'warcraft3_anime_choice_arena',
    nick: 'Vegeta',
    discordId: 'd1',
  });

  expect(linked.gameId).toBe('warcraft3_anime_choice_arena');
  expect(create).toHaveBeenCalledWith({
    data: {
      gameId: 'warcraft3_anime_choice_arena',
      username: 'Vegeta',
      discordId: 'd1',
    },
  });
});
```

Update existing `findUnique` expectations to use compound where clauses:

```typescript
expect(findUnique).toHaveBeenCalledWith({
  where: {
    gameId_username: { gameId: 'warcraft3_udbr', username: 'Tinys' },
  },
});
```

For Discord lookup:

```typescript
where: {
  gameId_discordId: { gameId: 'warcraft3_udbr', discordId: 'd1' },
}
```

Insensitive `findMany` must include `gameId` in `where`.

- [ ] **Step 2: Run tests — expect failures**

Run: `npm test -- src/services/player/player-link.test.ts`

Expected: FAIL (missing `gameId` arg / wrong where clauses).

- [ ] **Step 3: Implement `player-link.ts`**

Replace find helpers and exports with:

```typescript
async function findPlayerByNick(
  gameId: string,
  nick: string,
): Promise<LinkPlayerRow | null> {
  const exact = await prisma.player.findUnique({
    where: { gameId_username: { gameId, username: normalizeNick(nick) } },
  });
  if (exact) {
    return exact;
  }

  const matches = await prisma.player.findMany({
    where: {
      gameId,
      username: { equals: normalizeNick(nick), mode: 'insensitive' },
    },
    take: 2,
  });

  return matches.length === 1 ? matches[0]! : null;
}

export async function linkPlayer(input: {
  gameId: string;
  nick: string;
  discordId: string;
  allowRelink?: boolean;
}): Promise<{ username: string; discordId: string; gameId: string }> {
  const nick = normalizeNick(input.nick);
  if (!nick) {
    throw new PlayerServiceError('Nick cannot be empty.');
  }

  const [player, existingByDiscord] = await Promise.all([
    findPlayerByNick(input.gameId, nick),
    prisma.player.findUnique({
      where: {
        gameId_discordId: { gameId: input.gameId, discordId: input.discordId },
      },
    }),
  ]);

  assertLinkAllowed({
    player,
    existingByDiscord,
    discordId: input.discordId,
    allowRelink: input.allowRelink,
  });

  if (player?.discordId === input.discordId) {
    return {
      username: player.username,
      discordId: input.discordId,
      gameId: input.gameId,
    };
  }

  return prisma.$transaction(async (tx) => {
    if (existingByDiscord && existingByDiscord.id !== player?.id) {
      await tx.player.update({
        where: { id: existingByDiscord.id },
        data: { discordId: null },
      });
    }

    if (!player) {
      const created = await tx.player.create({
        data: {
          gameId: input.gameId,
          username: nick,
          discordId: input.discordId,
        },
      });
      return {
        username: created.username,
        discordId: created.discordId!,
        gameId: created.gameId,
      };
    }

    const updated = await tx.player.update({
      where: { id: player.id },
      data: { discordId: input.discordId },
    });

    return {
      username: updated.username,
      discordId: updated.discordId!,
      gameId: updated.gameId,
    };
  });
}

export async function unlinkByDiscordId(
  gameId: string,
  discordId: string,
  options: { self?: boolean } = {},
): Promise<{ username: string }> {
  const self = options.self ?? false;
  const player = await prisma.player.findUnique({
    where: { gameId_discordId: { gameId, discordId } },
  });

  if (!player) {
    throw new PlayerServiceError(
      self
        ? 'Your Discord is not linked for this game.'
        : 'That Discord account is not linked for this game.',
    );
  }

  await prisma.player.update({
    where: { id: player.id },
    data: { discordId: null },
  });

  return { username: player.username };
}
```

Keep `assertLinkAllowed` unchanged (still pure).

- [ ] **Step 4: Run tests — expect pass**

Run: `npm test -- src/services/player/player-link.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/player/player-link.ts src/services/player/player-link.test.ts
git commit -m "$(cat <<'EOF'
feat(player): scope link/unlink by gameId

EOF
)"
```

---

### Task 3: Profile + settings lookups by `gameId`

**Files:**
- Modify: `src/services/player/player-profile.ts`
- Modify: `src/services/player/player-profile.test.ts` (if lookups are asserted)
- Modify: `src/services/player/player-settings.ts`
- Modify: `src/services/player/player-settings.test.ts` (create/update as needed)

**Interfaces:**
- Consumes: `getGameProfileForLeague(leagueId).gameId`
- Produces: profile Discord/nick find filtered by that `gameId`; settings APIs take `gameId`

- [ ] **Step 1: Failing settings tests**

If `player-settings.test.ts` exists, update calls to require `gameId`. Otherwise create minimal tests:

```typescript
it('reads host prompt preference for game-scoped link', async () => {
  findUnique.mockResolvedValue({
    username: 'Goku',
    wc3statsHostPromptPingsEnabled: false,
  });
  await expect(
    getPlayerHostPromptPingsEnabled('warcraft3_udbr', 'd1'),
  ).resolves.toBe(false);
  expect(findUnique).toHaveBeenCalledWith({
    where: { gameId_discordId: { gameId: 'warcraft3_udbr', discordId: 'd1' } },
    select: { username: true, wc3statsHostPromptPingsEnabled: true },
  });
});
```

- [ ] **Step 2: Implement profile find helpers**

In `player-profile.ts`, change private helpers and use them inside `loadPlayerProfile`:

```typescript
async function findPlayerByDiscordId(gameId: string, discordId: string) {
  return prisma.player.findUnique({
    where: { gameId_discordId: { gameId, discordId } },
  });
}

async function findPlayerByNick(gameId: string, nick: string) {
  const exact = await prisma.player.findUnique({
    where: { gameId_username: { gameId, username: normalizeNick(nick) } },
  });
  if (exact) {
    return exact;
  }

  const matches = await prisma.player.findMany({
    where: {
      gameId,
      username: { equals: normalizeNick(nick), mode: 'insensitive' },
    },
    take: 2,
  });

  return matches.length === 1 ? matches[0]! : null;
}
```

At the start of `loadPlayerProfile`, resolve game before lookup:

```typescript
  const gameProfile = await getGameProfileForLeague(leagueId);
  const gameId = gameProfile.gameId;

  let player =
    lookup.kind === 'nick'
      ? await findPlayerByNick(gameId, lookup.nick)
      : await findPlayerByDiscordId(gameId, lookup.discordId);
```

Remove the later duplicate `getGameProfileForLeague` call (reuse `gameProfile`). Update self-unlinked copy to:

```typescript
'Your Discord is not linked to an in-game nick for this league’s game. Use /link to bind it.',
```

- [ ] **Step 3: Implement settings**

```typescript
export async function getPlayerHostPromptPingsEnabled(
  gameId: string,
  discordId: string,
): Promise<boolean | null> {
  const row = await prisma.player.findUnique({
    where: { gameId_discordId: { gameId, discordId } },
    select: { username: true, wc3statsHostPromptPingsEnabled: true },
  });
  if (!row) {
    return null;
  }
  return row.wc3statsHostPromptPingsEnabled !== false;
}

export async function setPlayerHostPromptPingsEnabled(
  gameId: string,
  discordId: string,
  enabled: boolean,
): Promise<{ username: string; enabled: boolean }> {
  const player = await prisma.player.findUnique({
    where: { gameId_discordId: { gameId, discordId } },
    select: { id: true, username: true },
  });
  if (!player) {
    throw new PlayerServiceError(NOT_LINKED);
  }

  const updated = await prisma.player.update({
    where: { id: player.id },
    data: { wc3statsHostPromptPingsEnabled: enabled },
    select: { username: true, wc3statsHostPromptPingsEnabled: true },
  });

  return {
    username: updated.username,
    enabled: updated.wc3statsHostPromptPingsEnabled !== false,
  };
}
```

Update the docstring: preference is **per game**, not global.

- [ ] **Step 4: Run tests**

Run:

```bash
npm test -- src/services/player/player-profile.test.ts src/services/player/player-settings.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/player/player-profile.ts src/services/player/player-profile.test.ts src/services/player/player-settings.ts src/services/player/player-settings.test.ts
git commit -m "$(cat <<'EOF'
feat(player): scope profile and settings by gameId

EOF
)"
```

---

### Task 4: `nickForDiscordId(discordId, gameId)` + lobby callers

**Files:**
- Modify: `src/services/lobby/lobby-identity.ts`
- Modify: `src/services/lobby/lobby-identity.test.ts`
- Modify: `src/services/lobby/actions.ts`
- Modify: `src/services/lobby/wc3stats-refresh.ts`
- Modify: `src/services/lobby/create-from-wc3stats.ts`
- Modify: `src/commands/lobby/register-lobby.ts`
- Modify: `src/discord/interactions/lobby-interactions.ts`
- Modify: any tests that mock `nickForDiscordId` arity

**Interfaces:**
- Produces: `nickForDiscordId(discordId: string, gameId: string): Promise<string>`
- Consumes: match/`leagueId` → `gameId` via `getGameProfileForLeague` or `prisma.league`

- [ ] **Step 1: Failing identity tests**

```typescript
it('looks up by gameId and discordId', async () => {
  findUnique.mockResolvedValue({ username: 'goku' });
  await expect(nickForDiscordId('d1', 'warcraft3_udbr')).resolves.toBe('goku');
  expect(findUnique).toHaveBeenCalledWith({
    where: {
      gameId_discordId: { gameId: 'warcraft3_udbr', discordId: 'd1' },
    },
  });
});
```

- [ ] **Step 2: Implement identity**

```typescript
export const UNLINKED_DISCORD_MESSAGE =
  'Your Discord is not linked to an in-game nick for this league’s game. Run /link or ask a moderator.';

export async function nickForDiscordId(
  discordId: string,
  gameId: string,
): Promise<string> {
  const player = await prisma.player.findUnique({
    where: { gameId_discordId: { gameId, discordId } },
  });

  if (!player) {
    throw new MatchServiceError(UNLINKED_DISCORD_MESSAGE);
  }

  return player.username;
}
```

- [ ] **Step 3: Wire lobby actions**

In `actions.ts`, for claim/leave/`addLobbyPlayerFromDiscord`, resolve match (or use existing match) then:

```typescript
const profile = await profileForLeague(match.leagueId);
const nick = await nickForDiscordId(input.discordId, profile.gameId);
```

Reorder `addLobbyPlayerFromDiscord` to resolve the pending match **before** nick lookup (same as claim), then call `addLobbyPlayer` with the nick.

- [ ] **Step 4: Wire other callers**

For each `nickForDiscordId(x)` site, pass the league’s `gameId`:

| Caller | Source of `gameId` |
|--------|--------------------|
| `claimLobbySlot` / `leaveLobbySlot` | `profileForLeague(match.leagueId).gameId` |
| `addLobbyPlayerFromDiscord` | same after resolving match |
| `wc3stats-refresh.ts` | profile/league of working match |
| `create-from-wc3stats.ts` | input league / profile |
| `register-lobby.ts` | resolved league before host nick |
| `lobby-interactions.ts` | match’s league profile |

- [ ] **Step 5: Run lobby + identity tests**

Run:

```bash
npm test -- src/services/lobby/lobby-identity.test.ts src/services/lobby/lobby-claim.test.ts
```

Expected: PASS (update mocks to accept second arg).

- [ ] **Step 6: Commit**

```bash
git add src/services/lobby src/commands/lobby/register-lobby.ts src/discord/interactions/lobby-interactions.ts
git commit -m "$(cat <<'EOF'
feat(lobby): resolve Discord nick per gameId

EOF
)"
```

---

### Task 5: Match roster resolve by `profile.gameId`

**Files:**
- Modify: `src/services/match/match-service.ts` (`resolvePlayersInTx`)

**Interfaces:**
- Consumes: `profile.gameId` already passed into `resolvePlayersInTx`
- Produces: find/create `Player` only for that `gameId`

- [ ] **Step 1: Change `resolvePlayersInTx` queries**

Replace the username-only find/create block with:

```typescript
  const gameId = profile.gameId;
  const existing = await tx.player.findMany({
    where: {
      gameId,
      OR: nicks.map((nick) => ({
        username: { equals: nick, mode: 'insensitive' as const },
      })),
    },
  });
  const byNick = new Map(existing.map((row) => [normalizeNick(row.username), row]));

  const missingNicks = nicks.filter((nick) => !byNick.has(nick));
  if (missingNicks.length > 0) {
    await tx.player.createMany({
      data: missingNicks.map((username) => ({ username, gameId })),
      skipDuplicates: true,
    });
    const created = await tx.player.findMany({
      where: { gameId, username: { in: missingNicks } },
    });
    for (const row of created) {
      byNick.set(normalizeNick(row.username), row);
    }
  }
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`

Expected: no errors from missing `gameId` on create.

- [ ] **Step 3: Commit**

```bash
git add src/services/match/match-service.ts
git commit -m "$(cat <<'EOF'
feat(match): create and resolve players per gameId

EOF
)"
```

---

### Task 6: Rank-reset + wc3stats host-prompt poller

**Files:**
- Modify: `src/services/rating/rank-reset.ts`
- Modify: `src/services/wc3stats/wc3stats-host-prompt-poller.ts`
- Modify: `src/services/wc3stats/wc3stats-host-prompt-poller.test.ts`
- Modify: `src/discord/interactions/rank-reset-interactions.ts` if it loads Player by discordId alone

**Interfaces:**
- Produces: `loadLinkedPlayersByNick(gameId: string): Promise<Map<string, string>>`
- `PromptReadyLeague` includes `gameId`
- Rank reset loads player with league’s `gameId`

- [ ] **Step 1: Update poller tests**

Expect `findMany` where to include `gameId: 'warcraft3_udbr'` when loading linked players for a UDBR league.

- [ ] **Step 2: Implement poller**

Add `gameId` to `PromptReadyLeague` and `ready.push({ ..., gameId: row.gameId })`.

Change loader:

```typescript
export async function loadLinkedPlayersByNick(
  gameId: string,
): Promise<Map<string, string>> {
  const rows = await prisma.player.findMany({
    where: {
      gameId,
      discordId: { not: null },
      wc3statsHostPromptPingsEnabled: true,
    },
    select: { username: true, discordId: true },
  });
  // ... same map build
}
```

In `runWc3statsHostPromptTick`, **do not** load one global map. Inside the league loop:

```typescript
    const linkedByNick = await loadLinkedPlayersByNick(league.gameId);
    if (linkedByNick.size === 0) {
      continue;
    }
```

(Optional micro-opt: cache `Map<gameId, Map<nick, discordId>>` per tick — fine either way.)

- [ ] **Step 3: Rank reset**

After loading `league`, use `league.gameId`:

```typescript
  const player = await prisma.player.findUnique({
    where: {
      gameId_discordId: {
        gameId: league.gameId,
        discordId: input.targetDiscordId,
      },
    },
  });
```

Update any interaction helper that finds by `discordId` alone the same way (load league first).

- [ ] **Step 4: Run tests**

Run:

```bash
npm test -- src/services/wc3stats/wc3stats-host-prompt-poller.test.ts src/services/rating/
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/wc3stats/wc3stats-host-prompt-poller.ts src/services/wc3stats/wc3stats-host-prompt-poller.test.ts src/services/rating/rank-reset.ts src/discord/interactions/rank-reset-interactions.ts
git commit -m "$(cat <<'EOF'
feat: scope host-prompt and rank-reset links by gameId

EOF
)"
```

---

### Task 7: Slash commands — `/link`, `/unlink`, `/settings`

**Files:**
- Modify: `src/commands/player/link.ts`
- Modify: `src/commands/player/unlink.ts`
- Modify: `src/commands/player/settings.ts`

**Interfaces:**
- Consumes: `withOptionalLeagueOption`, `resolveLeagueIdFromInteraction`, `getLeagueOption`, `getLeagueById` or `prisma.league` / `getGameProfileForLeague`
- Produces: commands that fail closed when league resolve fails

- [ ] **Step 1: Update `/link` data + execute**

Wrap builder with `withOptionalLeagueOption`, add `autocomplete` like `/rank`.

After guild/mod checks:

```typescript
    const resolved = await resolveLeagueIdFromInteraction(
      interaction,
      getLeagueOption(interaction),
    );
    if (!resolved.ok) {
      await interaction.editReply({ content: resolved.message });
      return;
    }

    const gameProfile = await getGameProfileForLeague(resolved.leagueId);
    const linked = await linkPlayer({
      gameId: gameProfile.gameId,
      nick,
      discordId: target.id,
      allowRelink: isMod,
    });
    await interaction.editReply({
      content: `Linked **${linked.username}** to <@${linked.discordId}> for \`${linked.gameId}\`.`,
    });
```

Import league helpers from `../../services/league/index.js`.

- [ ] **Step 2: Update `/unlink` the same way**

Resolve league → `gameId` → `unlinkByDiscordId(gameId, discordId, { self })`.

Reply may mention the game id briefly.

- [ ] **Step 3: Update `/settings`**

Add `withOptionalLeagueOption` + autocomplete. Resolve league before `getPlayerHostPromptPingsEnabled` / `setPlayerHostPromptPingsEnabled`.

- [ ] **Step 4: Typecheck + full test suite**

Run:

```bash
npx tsc --noEmit
npm test
```

Expected: compile clean; all tests pass. Fix any remaining `linkPlayer` / `nickForDiscordId` / settings call sites the compiler reports (including `scripts/seed-veteran-ratings.ts`).

For `scripts/seed-veteran-ratings.ts`, use `WARCRAFT3_UDBR_GAME_ID` on find/create:

```typescript
let player = await db.player.findUnique({
  where: {
    gameId_username: { gameId: WARCRAFT3_UDBR_GAME_ID, username: nick },
  },
});
// create: { gameId: WARCRAFT3_UDBR_GAME_ID, username: nick }
```

- [ ] **Step 5: Commit**

```bash
git add src/commands/player/link.ts src/commands/player/unlink.ts src/commands/player/settings.ts scripts/seed-veteran-ratings.ts
git commit -m "$(cat <<'EOF'
feat(commands): resolve league game for link, unlink, settings

EOF
)"
```

---

### Task 8: Docs + Cursor rules + multi-league supersession

**Files:**
- Modify: `docs/discord/public/02-link-your-nick.md`
- Modify: `.cursor/rules/database-domain.mdc`
- Modify: `.cursor/rules/feature-scope-game-vs-general.mdc`
- Modify: `docs/superpowers/specs/2026-08-15-multi-league-ihl-design.md` (short note only)

- [ ] **Step 1: Public link guide**

Replace the rules section with:

```markdown
**Rules (easy version)**
• Link is **per game** (the channel’s league picks the game — e.g. UDBR vs Anime Choice)
• One Discord account ↔ one nick **per game**, shared across all servers for that game
• Different games can use different nicks
• If your nick is already linked to someone else on that game, ask a **mod**
• Mods can `/link` or `/unlink` **other people** if something is wrong

Use `/link` in a channel bound to the right league (or pass `league:` when you have more than one).
```

- [ ] **Step 2: `database-domain.mdc`**

Replace the tenancy sentence about global uniqueness with:

```markdown
Ratings and matches **never** cross `leagueId`. `Player` identity is **`(gameId, username)`**; Discord link is unique per **`(gameId, discordId)`** (worldwide for that game — not per guild/league). See `docs/superpowers/specs/2026-08-17-per-game-player-identity-design.md`.
```

Update the Player bullet:

```markdown
- **Player** — `(gameId, username)` nick identity; optional `discordId` bind for that game
```

- [ ] **Step 3: `feature-scope-game-vs-general.mdc`**

In the `general` examples row, change `Player` link to `per-game Player link (via league.gameId)`.

- [ ] **Step 4: Multi-league spec note**

Directly under the locked “Player identity | **A** — global…” row (or in a short “Supersessions” subsection), add:

```markdown
> **Superseded (identity only, 2026-08-17):** Player identity and Discord links are per `Game.id` — see [per-game player identity](./2026-08-17-per-game-player-identity-design.md). Ratings/matches remain league-scoped; the non-goal “per-league Discord link” still holds.
```

- [ ] **Step 5: Commit**

```bash
git add docs/discord/public/02-link-your-nick.md .cursor/rules/database-domain.mdc .cursor/rules/feature-scope-game-vs-general.mdc docs/superpowers/specs/2026-08-15-multi-league-ihl-design.md
git commit -m "$(cat <<'EOF'
docs: document per-game Discord link identity

EOF
)"
```

---

## Spec coverage checklist

| Spec requirement | Task |
|------------------|------|
| `Player.gameId` + composite uniques | 1 |
| Backfill → `warcraft3_udbr` | 1 |
| `linkPlayer` / `unlink` per game | 2 |
| Profile Discord/nick by game | 3 |
| Settings per game | 3, 7 |
| League resolve for `/link` `/unlink` | 7 |
| `nickForDiscordId(discordId, gameId)` | 4 |
| Match roster create/find by game | 5 |
| Host prompt linked map by game | 6 |
| Rank-reset by game | 6 |
| Worldwide-per-game documented | 8 |
| Multi-league supersession note | 8 |
| Cursor rules updated | 8 |
| No `game:` slash option | 7 (league only) |
| Same Discord different nicks on two games | 2 test |

## Plan self-review

1. **Spec coverage:** All locked decisions mapped to tasks above; no orphan requirements.
2. **Placeholders:** None left (no TBD / “similar to Task N” without code).
3. **Type consistency:** `linkPlayer` always returns `{ username, discordId, gameId }`; `unlinkByDiscordId(gameId, discordId, …)`; `nickForDiscordId(discordId, gameId)`; settings `(gameId, discordId)`; Prisma compounds `gameId_username` / `gameId_discordId`.
