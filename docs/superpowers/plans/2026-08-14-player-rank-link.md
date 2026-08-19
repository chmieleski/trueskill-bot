# Player Rank & Account Link Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `/rank` (public profile embed), `/link` (mod-only Discord↔nick bind), and `/unlink` (self or mod) per the approved design.

**Architecture:** Thin slash adapters under `src/commands/player/` call domain services. `player-profile` is read-only (resolve + ki + competition rank + W/L + heroes). `player-link` writes `Player.discordId`. `rank-embed` builds layout A. Mod checks use a new `hasMatchModRole` helper (no host bypass) and `resolveGuildConfig` for the role ID.

**Tech Stack:** Node.js ESM TypeScript, discord.js v14, Prisma/PostgreSQL, Vitest, existing `displayOrdinal` in `rating-math.ts`.

## Global Constraints

- All user-facing strings in **English** (exact messages from the design error table).
- Never display raw OpenSkill μ/σ; public rating is **ki** via `displayOrdinal`.
- `/rank` is **read-only** (no rating INSERT/upsert).
- `/link` requires an **existing** `Player` nick (no ghost create).
- No Prisma schema migration.
- Embed layout **A**: gold `0xf0b232`, title `Rank #N · {ki} ki`, monospace heroes.

**Spec:** [docs/superpowers/specs/2026-08-14-player-rank-link-design.md](../specs/2026-08-14-player-rank-link-design.md)

## File map

| File                                  | Role                                                      |
| ------------------------------------- | --------------------------------------------------------- |
| `src/services/match-auth.ts`          | Add `hasMatchModRole` / `assertHasMatchModRole`           |
| `src/services/match-auth.test.ts`     | Cover new helpers                                         |
| `src/services/player-profile.ts`      | Resolve player, load profile DTO, pure rank/W/L helpers   |
| `src/services/player-profile.test.ts` | Unit tests for helpers + resolve errors                   |
| `src/services/player-link.ts`         | link / unlink + conflicts                                 |
| `src/services/player-link.test.ts`    | Conflict / auth-message unit coverage via injectable deps |
| `src/services/rank-embed.ts`          | Layout A `EmbedBuilder`                                   |
| `src/services/rank-embed.test.ts`     | Field/title/color assertions                              |
| `src/commands/player/rank.ts`         | `/rank` adapter                                           |
| `src/commands/player/link.ts`         | `/link` adapter                                           |
| `src/commands/player/unlink.ts`       | `/unlink` adapter                                         |

---

### Task 1: Match mod role helper (no host bypass)

**Files:**

- Modify: `src/services/match-auth.ts`
- Modify: `src/services/match-auth.test.ts`

**Interfaces:**

- Produces:
  - `hasMatchModRole(input: { memberRoleIds: string[]; matchModRoleId?: string }): boolean`
  - `assertHasMatchModRole(input: { memberRoleIds: string[]; matchModRoleId?: string }): void` — throws `MatchServiceError` with either `Match moderator role is not configured.` or `Only match moderators can do that.`

- [ ] **Step 1: Write the failing tests**

Append to `src/services/match-auth.test.ts`:

```typescript
describe('hasMatchModRole', () => {
  it('returns false when mod role is unset', () => {
    expect(hasMatchModRole({ memberRoleIds: ['role-mod'] })).toBe(false);
  });

  it('returns false when member lacks the role', () => {
    expect(hasMatchModRole({ memberRoleIds: ['other'], matchModRoleId: 'role-mod' })).toBe(false);
  });

  it('returns true when member has the role', () => {
    expect(
      hasMatchModRole({
        memberRoleIds: ['role-mod', 'other'],
        matchModRoleId: 'role-mod',
      }),
    ).toBe(true);
  });
});

describe('assertHasMatchModRole', () => {
  it('throws not-configured when role unset', () => {
    expect(() => assertHasMatchModRole({ memberRoleIds: [] })).toThrow(
      'Match moderator role is not configured.',
    );
  });

  it('throws forbidden when member lacks role', () => {
    expect(() => assertHasMatchModRole({ memberRoleIds: [], matchModRoleId: 'role-mod' })).toThrow(
      'Only match moderators can do that.',
    );
  });
});
```

Import the new symbols in the existing import list.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/services/match-auth.test.ts`

Expected: FAIL — `hasMatchModRole` / `assertHasMatchModRole` not exported.

- [ ] **Step 3: Implement helpers**

In `src/services/match-auth.ts` add:

```typescript
const MOD_NOT_CONFIGURED = 'Match moderator role is not configured.';
const MOD_FORBIDDEN = 'Only match moderators can do that.';

export function hasMatchModRole(input: {
  memberRoleIds: string[];
  matchModRoleId?: string;
}): boolean {
  const modRoleId = input.matchModRoleId;
  if (!modRoleId) {
    return false;
  }
  return input.memberRoleIds.includes(modRoleId);
}

export function assertHasMatchModRole(input: {
  memberRoleIds: string[];
  matchModRoleId?: string;
}): void {
  if (!input.matchModRoleId) {
    throw new MatchServiceError(MOD_NOT_CONFIGURED);
  }
  if (!hasMatchModRole(input)) {
    throw new MatchServiceError(MOD_FORBIDDEN);
  }
}
```

Do **not** change `canManageMatch` host bypass behavior.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/services/match-auth.test.ts`

Expected: PASS

- [ ] **Step 5: Commit** (only if the user asked for commits)

```bash
git add src/services/match-auth.ts src/services/match-auth.test.ts
git commit -m "$(cat <<'EOF'
feat: add match mod role check without host bypass

EOF
)"
```

---

### Task 2: Player profile service (pure helpers + load)

**Files:**

- Create: `src/services/player-profile.ts`
- Create: `src/services/player-profile.test.ts`

**Interfaces:**

- Produces:
  - `export class PlayerServiceError extends Error`
  - `export type PlayerProfileHero = { heroId: number; name: string; ki: number; matchesPlayed: number }`
  - `export type PlayerProfile = { playerId: string; username: string; discordId: string | null; globalKi: number; rankPosition: number; wins: number; losses: number; winRatePercent: number | null; heroes: PlayerProfileHero[] }`
  - `export type RankLookup = { kind: 'self'; discordId: string } | { kind: 'user'; discordId: string } | { kind: 'nick'; nick: string } | { kind: 'both' }`
  - `competitionRank(targetKi: number, allKis: number[]): number` — competition ranking (ties share place)
  - `coldStartKi(): number` — `displayOrdinal(25, 8.333)`
  - `parseRankOptions(input: { selfDiscordId: string; userDiscordId?: string | null; nick?: string | null }): RankLookup`
  - `async loadPlayerProfile(lookup: RankLookup): Promise<PlayerProfile>` — throws `PlayerServiceError` with design copy

- [ ] **Step 1: Write the failing tests**

Create `src/services/player-profile.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import {
  coldStartKi,
  competitionRank,
  parseRankOptions,
  PlayerServiceError,
} from './player-profile.js';
import { displayOrdinal } from './rating-math.js';

describe('competitionRank', () => {
  it('returns 1 for the top score', () => {
    expect(competitionRank(4000, [4000, 3000, 2000])).toBe(1);
  });

  it('shares place on ties (1,2,2,4)', () => {
    const kis = [4000, 3000, 3000, 2000];
    expect(competitionRank(4000, kis)).toBe(1);
    expect(competitionRank(3000, kis)).toBe(2);
    expect(competitionRank(2000, kis)).toBe(4);
  });
});

describe('coldStartKi', () => {
  it('matches displayOrdinal defaults', () => {
    expect(coldStartKi()).toBe(displayOrdinal(25, 8.333));
  });
});

describe('parseRankOptions', () => {
  it('returns both when user and nick provided', () => {
    expect(
      parseRankOptions({
        selfDiscordId: 'me',
        userDiscordId: 'u1',
        nick: 'Tinys',
      }),
    ).toEqual({ kind: 'both' });
  });

  it('prefers user when only user set', () => {
    expect(parseRankOptions({ selfDiscordId: 'me', userDiscordId: 'u1', nick: null })).toEqual({
      kind: 'user',
      discordId: 'u1',
    });
  });

  it('uses nick when only nick set', () => {
    expect(parseRankOptions({ selfDiscordId: 'me', userDiscordId: null, nick: 'Tinys' })).toEqual({
      kind: 'nick',
      nick: 'Tinys',
    });
  });

  it('defaults to self', () => {
    expect(parseRankOptions({ selfDiscordId: 'me' })).toEqual({
      kind: 'self',
      discordId: 'me',
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/services/player-profile.test.ts`

Expected: FAIL — module missing.

- [ ] **Step 3: Implement `player-profile.ts`**

```typescript
import { MatchStatus, MatchResult } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { displayOrdinal } from './rating-math.js';

const DEFAULT_MU = 25;
const DEFAULT_SIGMA = 8.333;

export class PlayerServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlayerServiceError';
  }
}

export type PlayerProfileHero = {
  heroId: number;
  name: string;
  ki: number;
  matchesPlayed: number;
};

export type PlayerProfile = {
  playerId: string;
  username: string;
  discordId: string | null;
  globalKi: number;
  rankPosition: number;
  wins: number;
  losses: number;
  winRatePercent: number | null;
  heroes: PlayerProfileHero[];
};

export type RankLookup =
  | { kind: 'self'; discordId: string }
  | { kind: 'user'; discordId: string }
  | { kind: 'nick'; nick: string }
  | { kind: 'both' };

/** Competition rank: 1 + count of strictly higher scores (ties share place). */
export function competitionRank(targetKi: number, allKis: number[]): number {
  let higher = 0;
  for (const ki of allKis) {
    if (ki > targetKi) {
      higher += 1;
    }
  }
  return higher + 1;
}

export function coldStartKi(): number {
  return displayOrdinal(DEFAULT_MU, DEFAULT_SIGMA);
}

export function parseRankOptions(input: {
  selfDiscordId: string;
  userDiscordId?: string | null;
  nick?: string | null;
}): RankLookup {
  const nick = input.nick?.trim() || null;
  const userDiscordId = input.userDiscordId?.trim() || null;

  if (userDiscordId && nick) {
    return { kind: 'both' };
  }
  if (userDiscordId) {
    return { kind: 'user', discordId: userDiscordId };
  }
  if (nick) {
    return { kind: 'nick', nick };
  }
  return { kind: 'self', discordId: input.selfDiscordId };
}

async function findPlayerByDiscordId(discordId: string) {
  return prisma.player.findUnique({ where: { discordId } });
}

async function findPlayerByNick(nick: string) {
  const exact = await prisma.player.findUnique({ where: { username: nick } });
  if (exact) {
    return exact;
  }

  const matches = await prisma.player.findMany({
    where: { username: { equals: nick, mode: 'insensitive' } },
    take: 2,
  });

  if (matches.length === 1) {
    return matches[0]!;
  }

  return null;
}

export async function loadPlayerProfile(lookup: RankLookup): Promise<PlayerProfile> {
  if (lookup.kind === 'both') {
    throw new PlayerServiceError('Provide either a Discord user or a nick, not both.');
  }

  let player =
    lookup.kind === 'nick'
      ? await findPlayerByNick(lookup.nick)
      : await findPlayerByDiscordId(lookup.discordId);

  if (!player) {
    if (lookup.kind === 'self') {
      throw new PlayerServiceError(
        'Your Discord is not linked to an in-game nick. Ask a moderator to run /link.',
      );
    }
    throw new PlayerServiceError('Player not found.');
  }

  const [rating, allRatings, matchPlayers, heroRatings] = await Promise.all([
    prisma.playerRating.findUnique({ where: { playerId: player.id } }),
    prisma.playerRating.findMany({ select: { playerId: true, mu: true, sigma: true } }),
    prisma.matchPlayer.findMany({
      where: {
        playerId: player.id,
        match: { status: MatchStatus.COMPLETED },
        result: { in: [MatchResult.WIN, MatchResult.LOSS] },
      },
      select: { result: true },
    }),
    prisma.playerHeroRating.findMany({
      where: { playerId: player.id, matchesPlayed: { gt: 0 } },
      include: { hero: true },
    }),
  ]);

  const globalKi = rating ? displayOrdinal(rating.mu, rating.sigma) : coldStartKi();

  const allKis = allRatings.map((row) => displayOrdinal(row.mu, row.sigma));
  if (!rating) {
    allKis.push(globalKi);
  }

  const rankPosition = competitionRank(globalKi, allKis);

  let wins = 0;
  let losses = 0;
  for (const row of matchPlayers) {
    if (row.result === MatchResult.WIN) {
      wins += 1;
    } else if (row.result === MatchResult.LOSS) {
      losses += 1;
    }
  }

  const games = wins + losses;
  const winRatePercent = games > 0 ? Math.round((wins / games) * 1000) / 10 : null;

  const heroes: PlayerProfileHero[] = heroRatings
    .map((row) => ({
      heroId: row.heroId,
      name: row.hero.name,
      ki: displayOrdinal(row.mu, row.sigma),
      matchesPlayed: row.matchesPlayed,
    }))
    .sort((a, b) => b.ki - a.ki || a.name.localeCompare(b.name));

  return {
    playerId: player.id,
    username: player.username,
    discordId: player.discordId,
    globalKi,
    rankPosition,
    wins,
    losses,
    winRatePercent,
    heroes,
  };
}
```

Note on virtual cold-start rank: when the player has no `PlayerRating` row, push their display cold-start ki into `allKis` so they are ranked against existing rows without inserting.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/services/player-profile.test.ts`

Expected: PASS

- [ ] **Step 5: Commit** (only if asked)

```bash
git add src/services/player-profile.ts src/services/player-profile.test.ts
git commit -m "$(cat <<'EOF'
feat: add player profile loader for /rank

EOF
)"
```

---

### Task 3: Player link / unlink service

**Files:**

- Create: `src/services/player-link.ts`
- Create: `src/services/player-link.test.ts`

**Interfaces:**

- Consumes: `PlayerServiceError` from `player-profile.ts` (reuse for user-facing errors)
- Produces:
  - `async linkPlayer(input: { nick: string; discordId: string }): Promise<{ username: string; discordId: string }>`
  - `async unlinkByDiscordId(discordId: string, options?: { self: boolean }): Promise<{ username: string }>`  
    — `self: true` → message `Your Discord is not linked.`; else → `That Discord account is not linked.`

- [ ] **Step 1: Write failing tests with an injectable store**

To avoid live DB in unit tests, implement link logic against a minimal port **or** export pure conflict helpers. Prefer this structure in `player-link.ts`:

```typescript
export type LinkPlayerRow = {
  id: string;
  username: string;
  discordId: string | null;
};

export function assertLinkAllowed(input: {
  player: LinkPlayerRow | null;
  existingByDiscord: LinkPlayerRow | null;
}): LinkPlayerRow {
  if (!input.player) {
    throw new PlayerServiceError('No player with that nick.');
  }
  if (input.player.discordId && input.player.discordId.length > 0) {
    throw new PlayerServiceError('That nick or Discord account is already linked.');
  }
  if (input.existingByDiscord && input.existingByDiscord.id !== input.player.id) {
    throw new PlayerServiceError('That nick or Discord account is already linked.');
  }
  return input.player;
}
```

Test file:

```typescript
import { describe, expect, it } from 'vitest';
import { assertLinkAllowed } from './player-link.js';
import { PlayerServiceError } from './player-profile.js';

describe('assertLinkAllowed', () => {
  it('rejects missing nick', () => {
    expect(() => assertLinkAllowed({ player: null, existingByDiscord: null })).toThrow(
      'No player with that nick.',
    );
  });

  it('rejects nick already linked', () => {
    expect(() =>
      assertLinkAllowed({
        player: { id: '1', username: 'Tinys', discordId: 'd1' },
        existingByDiscord: null,
      }),
    ).toThrow(PlayerServiceError);
  });

  it('rejects discord already linked to another player', () => {
    expect(() =>
      assertLinkAllowed({
        player: { id: '1', username: 'Tinys', discordId: null },
        existingByDiscord: { id: '2', username: 'Other', discordId: 'd9' },
      }),
    ).toThrow('That nick or Discord account is already linked.');
  });

  it('allows a free nick and free discord', () => {
    const player = { id: '1', username: 'Tinys', discordId: null };
    expect(assertLinkAllowed({ player, existingByDiscord: null })).toEqual(player);
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

Run: `npm test -- src/services/player-link.test.ts`

- [ ] **Step 3: Implement service**

```typescript
import { prisma } from '../lib/prisma.js';
import { PlayerServiceError } from './player-profile.js';

export type LinkPlayerRow = {
  id: string;
  username: string;
  discordId: string | null;
};

export function assertLinkAllowed(input: {
  player: LinkPlayerRow | null;
  existingByDiscord: LinkPlayerRow | null;
}): LinkPlayerRow {
  if (!input.player) {
    throw new PlayerServiceError('No player with that nick.');
  }

  if (input.player.discordId) {
    throw new PlayerServiceError('That nick or Discord account is already linked.');
  }

  if (input.existingByDiscord && input.existingByDiscord.id !== input.player.id) {
    throw new PlayerServiceError('That nick or Discord account is already linked.');
  }

  return input.player;
}

async function findPlayerByNick(nick: string): Promise<LinkPlayerRow | null> {
  const exact = await prisma.player.findUnique({ where: { username: nick } });
  if (exact) {
    return exact;
  }

  const matches = await prisma.player.findMany({
    where: { username: { equals: nick, mode: 'insensitive' } },
    take: 2,
  });

  return matches.length === 1 ? matches[0]! : null;
}

export async function linkPlayer(input: {
  nick: string;
  discordId: string;
}): Promise<{ username: string; discordId: string }> {
  const nick = input.nick.trim();
  if (!nick) {
    throw new PlayerServiceError('No player with that nick.');
  }

  const [player, existingByDiscord] = await Promise.all([
    findPlayerByNick(nick),
    prisma.player.findUnique({ where: { discordId: input.discordId } }),
  ]);

  const allowed = assertLinkAllowed({ player, existingByDiscord });

  const updated = await prisma.player.update({
    where: { id: allowed.id },
    data: { discordId: input.discordId },
  });

  return { username: updated.username, discordId: updated.discordId! };
}

export async function unlinkByDiscordId(
  discordId: string,
  options: { self: boolean },
): Promise<{ username: string }> {
  const player = await prisma.player.findUnique({ where: { discordId } });

  if (!player) {
    throw new PlayerServiceError(
      options.self ? 'Your Discord is not linked.' : 'That Discord account is not linked.',
    );
  }

  await prisma.player.update({
    where: { id: player.id },
    data: { discordId: null },
  });

  return { username: player.username };
}
```

- [ ] **Step 4: Run tests — expect PASS**

Run: `npm test -- src/services/player-link.test.ts`

- [ ] **Step 5: Commit** (only if asked)

---

### Task 4: Rank embed (layout A)

**Files:**

- Create: `src/services/rank-embed.ts`
- Create: `src/services/rank-embed.test.ts`

**Interfaces:**

- Consumes: `PlayerProfile`
- Produces: `buildRankEmbed(profile: PlayerProfile, options?: { avatarUrl?: string | null }): EmbedBuilder`

- [ ] **Step 1: Write failing tests**

```typescript
import { describe, expect, it } from 'vitest';
import { buildRankEmbed, formatHeroTable } from './rank-embed.js';
import type { PlayerProfile } from './player-profile.js';

const baseProfile: PlayerProfile = {
  playerId: 'p1',
  username: 'Tinys',
  discordId: 'd1',
  globalKi: 4000,
  rankPosition: 3,
  wins: 12,
  losses: 5,
  winRatePercent: 70.6,
  heroes: [
    { heroId: 1, name: 'Goku', ki: 4200, matchesPlayed: 8 },
    { heroId: 2, name: 'Vegeta', ki: 3900, matchesPlayed: 4 },
  ],
};

describe('formatHeroTable', () => {
  it('aligns names and shows ki · matches', () => {
    const table = formatHeroTable(baseProfile.heroes);
    expect(table).toContain('Goku');
    expect(table).toContain('4200');
    expect(table).toContain('· 8');
  });

  it('returns italic empty copy when no heroes', () => {
    expect(formatHeroTable([])).toBe('_No hero games yet_');
  });
});

describe('buildRankEmbed', () => {
  it('uses gold accent and rank title', () => {
    const embed = buildRankEmbed(baseProfile, { avatarUrl: 'https://cdn.example/a.png' });
    const data = embed.toJSON();
    expect(data.color).toBe(0xf0b232);
    expect(data.title).toBe('Rank #3 · 4000 ki');
    expect(data.author?.name).toBe('Tinys');
    expect(data.thumbnail?.url).toBe('https://cdn.example/a.png');
  });

  it('omits WR% when no games', () => {
    const embed = buildRankEmbed({
      ...baseProfile,
      wins: 0,
      losses: 0,
      winRatePercent: null,
    });
    const description = embed.toJSON().description ?? '';
    expect(description).toBe('0W · 0L');
    expect(description).not.toContain('WR');
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `npm test -- src/services/rank-embed.test.ts`

- [ ] **Step 3: Implement**

```typescript
import { EmbedBuilder } from 'discord.js';
import type { PlayerProfile, PlayerProfileHero } from './player-profile.js';

const RANK_GOLD = 0xf0b232;

export function formatHeroTable(heroes: PlayerProfileHero[]): string {
  if (heroes.length === 0) {
    return '_No hero games yet_';
  }

  const nameWidth = Math.max(...heroes.map((hero) => hero.name.length));
  const kiWidth = Math.max(...heroes.map((hero) => String(hero.ki).length));

  const lines = heroes.map((hero) => {
    const name = hero.name.padEnd(nameWidth, ' ');
    const ki = String(hero.ki).padStart(kiWidth, ' ');
    return `${name}  ${ki} · ${hero.matchesPlayed}`;
  });

  return `\`\`\`\n${lines.join('\n')}\n\`\`\``;
}

export function buildRankEmbed(
  profile: PlayerProfile,
  options?: { avatarUrl?: string | null },
): EmbedBuilder {
  const record =
    profile.winRatePercent === null
      ? `${profile.wins}W · ${profile.losses}L`
      : `${profile.wins}W · ${profile.losses}L · ${profile.winRatePercent}% WR`;

  const embed = new EmbedBuilder()
    .setColor(RANK_GOLD)
    .setAuthor({ name: profile.username })
    .setTitle(`Rank #${profile.rankPosition} · ${profile.globalKi} ki`)
    .setDescription(record)
    .addFields({ name: 'Heroes', value: formatHeroTable(profile.heroes) });

  if (options?.avatarUrl) {
    embed.setThumbnail(options.avatarUrl);
  }

  if (profile.discordId) {
    embed.setFooter({ text: `Linked · <@${profile.discordId}>` });
  } else {
    embed.setFooter({ text: 'Not linked to Discord' });
  }

  return embed;
}
```

Note: Discord footers do not resolve mentions; that is acceptable per design (“mention/tag”). If preferred later, put the mention in the description instead — out of scope unless tests fail UX review.

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Commit** (only if asked)

---

### Task 5: `/rank` command

**Files:**

- Create: `src/commands/player/rank.ts`

**Interfaces:**

- Consumes: `parseRankOptions`, `loadPlayerProfile`, `PlayerServiceError`, `buildRankEmbed`
- Produces: slash command `rank` auto-loaded by `load-commands.ts`

- [ ] **Step 1: Implement command**

```typescript
import { SlashCommandBuilder } from 'discord.js';
import type { ChatInputCommandInteraction } from 'discord.js';
import { createLogger } from '../../lib/logger.js';
import {
  loadPlayerProfile,
  parseRankOptions,
  PlayerServiceError,
} from '../../services/player-profile.js';
import { buildRankEmbed } from '../../services/rank-embed.js';

const log = createLogger('rank_cmd');

export const data = new SlashCommandBuilder()
  .setName('rank')
  .setDescription('Show your rank profile or look up another player')
  .addUserOption((option) =>
    option.setName('user').setDescription('Discord user to look up').setRequired(false),
  )
  .addStringOption((option) =>
    option.setName('nick').setDescription('In-game nick to look up').setRequired(false),
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply();

  const user = interaction.options.getUser('user');
  const nick = interaction.options.getString('nick');

  try {
    const lookup = parseRankOptions({
      selfDiscordId: interaction.user.id,
      userDiscordId: user?.id,
      nick,
    });
    const profile = await loadPlayerProfile(lookup);

    let avatarUrl: string | null = null;
    if (profile.discordId) {
      if (user && user.id === profile.discordId) {
        avatarUrl = user.displayAvatarURL({ size: 128 });
      } else if (profile.discordId === interaction.user.id) {
        avatarUrl = interaction.user.displayAvatarURL({ size: 128 });
      } else {
        try {
          const fetched = await interaction.client.users.fetch(profile.discordId);
          avatarUrl = fetched.displayAvatarURL({ size: 128 });
        } catch {
          avatarUrl = null;
        }
      }
    }

    await interaction.editReply({
      embeds: [buildRankEmbed(profile, { avatarUrl })],
    });
  } catch (error) {
    if (error instanceof PlayerServiceError) {
      await interaction.editReply({ content: error.message });
      return;
    }
    log.error({ err: error }, 'rank command failed');
    await interaction.editReply({ content: 'Something went wrong loading that rank.' });
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`

Expected: no errors related to `rank.ts`.

- [ ] **Step 3: Manual smoke (dev bot)**

With `npm run dev` (auto-deploy on):

1. `/rank nick:<seeded veteran>` → embed gold, title with ki
2. `/rank` without link → English not-linked message
3. `/rank user:@x nick:y` → both-options error

- [ ] **Step 4: Commit** (only if asked)

---

### Task 6: `/link` and `/unlink` commands

**Files:**

- Create: `src/commands/player/link.ts`
- Create: `src/commands/player/unlink.ts`

**Interfaces:**

- Consumes: `resolveGuildConfig`, `assertHasMatchModRole`, `linkPlayer`, `unlinkByDiscordId`, `PlayerServiceError`, `MatchServiceError`
- Reuse the same `memberRoleIds(interaction)` helper pattern as `register-lobby.ts` (copy the small local function into each file, or extract later — do **not** block on a shared util refactor).

- [ ] **Step 1: Implement `/link`**

```typescript
import { GuildMember, MessageFlags, SlashCommandBuilder } from 'discord.js';
import type { ChatInputCommandInteraction } from 'discord.js';
import { createLogger } from '../../lib/logger.js';
import { resolveGuildConfig } from '../../services/guild-config.js';
import { assertHasMatchModRole } from '../../services/match-auth.js';
import { MatchServiceError } from '../../services/match-service.js';
import { linkPlayer } from '../../services/player-link.js';
import { PlayerServiceError } from '../../services/player-profile.js';

const log = createLogger('link_cmd');

function memberRoleIds(interaction: { member: unknown }): string[] {
  const member = interaction.member;
  if (member instanceof GuildMember) {
    return [...member.roles.cache.keys()];
  }
  if (member && typeof member === 'object' && 'roles' in member) {
    const roles = (member as { roles: unknown }).roles;
    if (Array.isArray(roles)) {
      return roles;
    }
    if (roles && typeof roles === 'object' && 'cache' in roles) {
      const cache = (roles as { cache?: Map<string, unknown> }).cache;
      if (cache instanceof Map) {
        return [...cache.keys()];
      }
    }
  }
  return [];
}

export const data = new SlashCommandBuilder()
  .setName('link')
  .setDescription('Link an in-game nick to a Discord account (moderators only)')
  .addStringOption((option) =>
    option.setName('nick').setDescription('In-game nick').setRequired(true),
  )
  .addUserOption((option) =>
    option.setName('user').setDescription('Discord user to bind').setRequired(true),
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const nick = interaction.options.getString('nick', true);
  const user = interaction.options.getUser('user', true);

  try {
    if (!interaction.guildId) {
      await interaction.editReply({ content: 'This command can only be used in a server.' });
      return;
    }

    const config = await resolveGuildConfig(interaction.guildId);
    assertHasMatchModRole({
      memberRoleIds: memberRoleIds(interaction),
      matchModRoleId: config.matchModRoleId,
    });

    const linked = await linkPlayer({ nick, discordId: user.id });
    await interaction.editReply({
      content: `Linked **${linked.username}** to <@${linked.discordId}>.`,
    });
  } catch (error) {
    if (error instanceof PlayerServiceError || error instanceof MatchServiceError) {
      await interaction.editReply({ content: error.message });
      return;
    }
    log.error({ err: error }, 'link command failed');
    await interaction.editReply({ content: 'Something went wrong linking that account.' });
  }
}
```

- [ ] **Step 2: Implement `/unlink`**

```typescript
import { GuildMember, MessageFlags, SlashCommandBuilder } from 'discord.js';
import type { ChatInputCommandInteraction } from 'discord.js';
import { createLogger } from '../../lib/logger.js';
import { resolveGuildConfig } from '../../services/guild-config.js';
import { assertHasMatchModRole } from '../../services/match-auth.js';
import { MatchServiceError } from '../../services/match-service.js';
import { unlinkByDiscordId } from '../../services/player-link.js';
import { PlayerServiceError } from '../../services/player-profile.js';

const log = createLogger('unlink_cmd');

function memberRoleIds(interaction: { member: unknown }): string[] {
  const member = interaction.member;
  if (member instanceof GuildMember) {
    return [...member.roles.cache.keys()];
  }
  if (member && typeof member === 'object' && 'roles' in member) {
    const roles = (member as { roles: unknown }).roles;
    if (Array.isArray(roles)) {
      return roles;
    }
    if (roles && typeof roles === 'object' && 'cache' in roles) {
      const cache = (roles as { cache?: Map<string, unknown> }).cache;
      if (cache instanceof Map) {
        return [...cache.keys()];
      }
    }
  }
  return [];
}

export const data = new SlashCommandBuilder()
  .setName('unlink')
  .setDescription('Unlink a Discord account from an in-game nick')
  .addUserOption((option) =>
    option
      .setName('user')
      .setDescription('Discord user to unlink (moderators only)')
      .setRequired(false),
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const target = interaction.options.getUser('user');
  const self = !target || target.id === interaction.user.id;
  const discordId = self ? interaction.user.id : target!.id;

  try {
    if (!self) {
      if (!interaction.guildId) {
        await interaction.editReply({ content: 'This command can only be used in a server.' });
        return;
      }
      const config = await resolveGuildConfig(interaction.guildId);
      assertHasMatchModRole({
        memberRoleIds: memberRoleIds(interaction),
        matchModRoleId: config.matchModRoleId,
      });
    }

    const result = await unlinkByDiscordId(discordId, { self });
    await interaction.editReply({
      content: self
        ? `Unlinked your Discord from **${result.username}**.`
        : `Unlinked <@${discordId}> from **${result.username}**.`,
    });
  } catch (error) {
    if (error instanceof PlayerServiceError || error instanceof MatchServiceError) {
      await interaction.editReply({ content: error.message });
      return;
    }
    log.error({ err: error }, 'unlink command failed');
    await interaction.editReply({ content: 'Something went wrong unlinking that account.' });
  }
}
```

- [ ] **Step 3: Run full unit suite**

Run: `npm test`

Expected: all existing + new tests PASS.

- [ ] **Step 4: Manual smoke**

1. Non-mod `/link` → mod forbidden / not configured
2. Mod `/link nick:Tinys user:@you` → success; `/rank` no-args shows profile
3. `/unlink` self → success; `/rank` no-args → not linked
4. Conflicting second link → already linked error

- [ ] **Step 5: Commit** (only if asked)

```bash
git add src/commands/player src/services/player-link.ts src/services/player-link.test.ts src/services/rank-embed.ts src/services/rank-embed.test.ts src/services/player-profile.ts src/services/player-profile.test.ts src/services/match-auth.ts src/services/match-auth.test.ts
git commit -m "$(cat <<'EOF'
feat: add /rank, /link, and /unlink player commands

EOF
)"
```

---

## Spec coverage checklist

| Spec item                        | Task                      |
| -------------------------------- | ------------------------- |
| `/rank` user \| nick \| self     | 2, 5                      |
| Profile ki, rank #, W/L, heroes  | 2, 4                      |
| Competition ties 1,2,2,4         | 2                         |
| Layout A gold embed              | 4                         |
| `/link` mod-only + existing nick | 1, 3, 6                   |
| `/unlink` self + mod target      | 3, 6                      |
| Guild config mod role resolve    | 6                         |
| Error copy table                 | 2, 3, 1                   |
| Tech debt C noted (not built)    | — documented in spec only |
| No schema migration              | —                         |

## Placeholder / consistency review

- No TBD steps; exact English strings match the design table.
- `PlayerServiceError` shared by profile + link; mod auth uses `MatchServiceError`.
- Footer mention limitation called out; implement as specified.
