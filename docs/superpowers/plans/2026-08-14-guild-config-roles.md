# Guild Config Roles via `/config` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let operators view and set per-guild match create/mod roles via `/config`, with Postgres as source of truth after first set and `.env` as fallback until then.

**Architecture:** Add `GuildConfig` (keyed by `guildId`). `resolveGuildConfig` merges DB + env per field. `match-auth` accepts injected role IDs (no env reads). Slash `/config view|set` gated by Manage Guild or hard-coded owner Discord ID. Call sites resolve once per interaction and pass IDs into auth.

**Tech Stack:** Node.js + TypeScript ESM, discord.js v14, Prisma + PostgreSQL, Vitest

**Spec:** [docs/superpowers/specs/2026-08-14-guild-config-roles-design.md](../specs/2026-08-14-guild-config-roles-design.md)

## Global Constraints

- User-facing strings in **English**
- Set-only (never write `null` / clear via command)
- Empty resolved create role → nobody creates; empty resolved mod role → host-only
- Resolve always by `interaction.guildId` (not deploy `GUILD_ID`)
- Owner ID constant: `723326675647070218` (not an env var)
- ESM imports use `.js` extensions
- Use Prisma singleton from `src/lib/prisma.ts`
- Prefer `MatchServiceError` for user-facing auth failures
- Commits only when the user asks (skip commit steps unless requested)

## File structure

| File | Responsibility |
|------|----------------|
| `prisma/schema.prisma` | `GuildConfig` model |
| `prisma/migrations/.../migration.sql` | Create `GuildConfig` table |
| `src/services/match-auth.ts` | Create/mod auth with injected role IDs |
| `src/services/match-auth.test.ts` | Unit tests for injected-ID auth |
| `src/services/guild-config.ts` | Resolve, set, configure-bot auth |
| `src/services/guild-config.test.ts` | Resolve precedence + configure auth + set upserts |
| `src/commands/config/config.ts` | `/config view` and `/config set …` |
| `src/commands/lobby/register-lobby.ts` | Resolve then `assertCanCreateMatch` |
| `src/commands/match/match.ts` | Resolve then manage-match auth |
| `src/handlers/match-interactions.ts` | Resolve then manage-match auth |
| `src/services/lobby-actions.ts` | Accept `matchModRoleId` into in-progress resolve |
| `.env.example` | Document env as fallback |
| `.cursor/rules/scripts-and-env.mdc` | Same |

---

### Task 1: Prisma `GuildConfig` model + migration

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<timestamp>_guild_config/migration.sql` (via Prisma CLI)

**Interfaces:**
- Produces: Prisma model `GuildConfig` with `guildId`, `matchCreateRoleId?`, `matchModRoleId?`, timestamps

- [ ] **Step 1: Add model to schema**

Append to `prisma/schema.prisma`:

```prisma
// GuildConfig - per-server bot settings (roles first; more keys later)
model GuildConfig {
  guildId           String   @id
  matchCreateRoleId String?
  matchModRoleId    String?
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt
}
```

- [ ] **Step 2: Create and apply migration**

Run: `npm run db:migrate`

When prompted for a name, use: `guild_config`

Expected: migration folder created; client regenerated; table exists in DB.

If the CLI cannot reach the DB in this environment, still create the migration SQL manually:

```sql
-- CreateTable
CREATE TABLE "GuildConfig" (
    "guildId" TEXT NOT NULL,
    "matchCreateRoleId" TEXT,
    "matchModRoleId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GuildConfig_pkey" PRIMARY KEY ("guildId")
);
```

Then run `npx prisma generate`.

- [ ] **Step 3: Commit** (only if user asked)

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "$(cat <<'EOF'
Add GuildConfig table for per-guild role settings.

EOF
)"
```

---

### Task 2: Inject role IDs into `match-auth`

**Files:**
- Modify: `src/services/match-auth.ts`
- Modify: `src/services/match-auth.test.ts`

**Interfaces:**
- Consumes: none from Task 1 at runtime (auth stays pure)
- Produces:
  - `canManageMatch(input: { hostDiscordId: string; actorDiscordId: string; memberRoleIds: string[]; matchModRoleId?: string }): boolean`
  - `assertCanManageMatch(same): void`
  - `canCreateMatch(input: { memberRoleIds: string[]; matchCreateRoleId?: string }): boolean`
  - `assertCanCreateMatch(same): void`
  - Disabled message: `Match creation is disabled until a create role is configured.`

- [ ] **Step 1: Rewrite failing tests for injected IDs**

Replace `src/services/match-auth.test.ts` entirely:

```ts
import { describe, expect, it } from 'vitest';
import {
  assertCanCreateMatch,
  assertCanManageMatch,
  canCreateMatch,
  canManageMatch,
} from './match-auth.js';
import { MatchServiceError } from './match-service.js';

describe('canManageMatch', () => {
  it('allows the host without a mod role', () => {
    expect(
      canManageMatch({
        hostDiscordId: 'host',
        actorDiscordId: 'host',
        memberRoleIds: [],
      }),
    ).toBe(true);
  });

  it('rejects non-host when mod role is unset', () => {
    expect(
      canManageMatch({
        hostDiscordId: 'host',
        actorDiscordId: 'other',
        memberRoleIds: ['role-mod'],
      }),
    ).toBe(false);
  });

  it('allows non-host with matching mod role', () => {
    expect(
      canManageMatch({
        hostDiscordId: 'host',
        actorDiscordId: 'mod',
        memberRoleIds: ['role-mod'],
        matchModRoleId: 'role-mod',
      }),
    ).toBe(true);
  });
});

describe('canCreateMatch', () => {
  it('returns false when create role is unset', () => {
    expect(canCreateMatch({ memberRoleIds: ['111'] })).toBe(false);
  });

  it('returns false when member lacks the create role', () => {
    expect(
      canCreateMatch({ memberRoleIds: ['other'], matchCreateRoleId: 'role-create' }),
    ).toBe(false);
  });

  it('returns true when member has the create role', () => {
    expect(
      canCreateMatch({
        memberRoleIds: ['role-create', 'other'],
        matchCreateRoleId: 'role-create',
      }),
    ).toBe(true);
  });
});

describe('assertCanCreateMatch', () => {
  it('throws disabled message when create role is unset', () => {
    expect(() => assertCanCreateMatch({ memberRoleIds: [] })).toThrow(MatchServiceError);
    expect(() => assertCanCreateMatch({ memberRoleIds: [] })).toThrow(
      'Match creation is disabled until a create role is configured.',
    );
  });

  it('throws creator-role message when member lacks role', () => {
    expect(() =>
      assertCanCreateMatch({ memberRoleIds: ['other'], matchCreateRoleId: 'role-create' }),
    ).toThrow('Only members with the match creator role can register a lobby.');
  });

  it('does not throw when member has the create role', () => {
    expect(() =>
      assertCanCreateMatch({
        memberRoleIds: ['role-create'],
        matchCreateRoleId: 'role-create',
      }),
    ).not.toThrow();
  });
});

describe('assertCanManageMatch', () => {
  it('throws when actor cannot manage', () => {
    expect(() =>
      assertCanManageMatch({
        hostDiscordId: 'host',
        actorDiscordId: 'other',
        memberRoleIds: [],
      }),
    ).toThrow('Only the match host or a match moderator can do that.');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/services/match-auth.test.ts`

Expected: FAIL (still reads `env` and/or old disabled message / signatures)

- [ ] **Step 3: Implement injected-ID `match-auth`**

Replace `src/services/match-auth.ts` with:

```ts
import { MatchServiceError } from './match-service.js';

const FORBIDDEN = 'Only the match host or a match moderator can do that.';
const CREATE_DISABLED = 'Match creation is disabled until a create role is configured.';
const CREATE_FORBIDDEN = 'Only members with the match creator role can register a lobby.';

export function canManageMatch(input: {
  hostDiscordId: string;
  actorDiscordId: string;
  memberRoleIds: string[];
  matchModRoleId?: string;
}): boolean {
  if (input.actorDiscordId === input.hostDiscordId) {
    return true;
  }

  const modRoleId = input.matchModRoleId;
  if (!modRoleId) {
    return false;
  }

  return input.memberRoleIds.includes(modRoleId);
}

export function assertCanManageMatch(input: {
  hostDiscordId: string;
  actorDiscordId: string;
  memberRoleIds: string[];
  matchModRoleId?: string;
}): void {
  if (!canManageMatch(input)) {
    throw new MatchServiceError(FORBIDDEN);
  }
}

export function canCreateMatch(input: {
  memberRoleIds: string[];
  matchCreateRoleId?: string;
}): boolean {
  const createRoleId = input.matchCreateRoleId;
  if (!createRoleId) {
    return false;
  }

  return input.memberRoleIds.includes(createRoleId);
}

export function assertCanCreateMatch(input: {
  memberRoleIds: string[];
  matchCreateRoleId?: string;
}): void {
  if (canCreateMatch(input)) {
    return;
  }

  if (!input.matchCreateRoleId) {
    throw new MatchServiceError(CREATE_DISABLED);
  }

  throw new MatchServiceError(CREATE_FORBIDDEN);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/services/match-auth.test.ts`

Expected: PASS

- [ ] **Step 5: Commit** (only if user asked)

```bash
git add src/services/match-auth.ts src/services/match-auth.test.ts
git commit -m "$(cat <<'EOF'
Make match auth accept injected create/mod role IDs.

EOF
)"
```

---

### Task 3: `guild-config` service (resolve, set, configure auth)

**Files:**
- Create: `src/services/guild-config.ts`
- Create: `src/services/guild-config.test.ts`

**Interfaces:**
- Consumes: `env.matchCreateRoleId`, `env.matchModRoleId`; Prisma `guildConfig`
- Produces:
  - `BOT_OWNER_DISCORD_ID = '723326675647070218'`
  - `type RoleConfigSource = 'database' | 'env' | 'unset'`
  - `interface ResolvedGuildConfig { matchCreateRoleId?: string; matchModRoleId?: string; matchCreateRoleSource: RoleConfigSource; matchModRoleSource: RoleConfigSource }`
  - `resolveGuildConfig(guildId: string): Promise<ResolvedGuildConfig>`
  - `setMatchCreateRole(guildId: string, roleId: string): Promise<void>`
  - `setMatchModRole(guildId: string, roleId: string): Promise<void>`
  - `canConfigureBot(input: { userId: string; memberPermissions: PermissionsBitField | bigint | string | readonly string[] | null | undefined }): boolean`
  - `assertCanConfigureBot(same): void` — throws `MatchServiceError` with `You do not have permission to configure this bot.`

- [ ] **Step 1: Write failing tests**

Create `src/services/guild-config.test.ts`:

```ts
import { PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const findUnique = vi.fn();
const upsert = vi.fn();

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    guildConfig: {
      findUnique,
      upsert,
    },
  },
}));

vi.mock('../config/env.js', () => ({
  env: {
    matchCreateRoleId: undefined as string | undefined,
    matchModRoleId: undefined as string | undefined,
  },
}));

import { env } from '../config/env.js';
import {
  BOT_OWNER_DISCORD_ID,
  assertCanConfigureBot,
  canConfigureBot,
  resolveGuildConfig,
  setMatchCreateRole,
  setMatchModRole,
} from './guild-config.js';
import { MatchServiceError } from './match-service.js';

describe('resolveGuildConfig', () => {
  beforeEach(() => {
    findUnique.mockReset();
    env.matchCreateRoleId = undefined;
    env.matchModRoleId = undefined;
  });

  it('uses env when no row exists', async () => {
    findUnique.mockResolvedValue(null);
    env.matchCreateRoleId = 'env-create';
    env.matchModRoleId = 'env-mod';

    const resolved = await resolveGuildConfig('guild-1');

    expect(resolved).toEqual({
      matchCreateRoleId: 'env-create',
      matchModRoleId: 'env-mod',
      matchCreateRoleSource: 'env',
      matchModRoleSource: 'env',
    });
  });

  it('uses database when fields are set and ignores env for those fields', async () => {
    findUnique.mockResolvedValue({
      guildId: 'guild-1',
      matchCreateRoleId: 'db-create',
      matchModRoleId: null,
    });
    env.matchCreateRoleId = 'env-create';
    env.matchModRoleId = 'env-mod';

    const resolved = await resolveGuildConfig('guild-1');

    expect(resolved.matchCreateRoleId).toBe('db-create');
    expect(resolved.matchCreateRoleSource).toBe('database');
    expect(resolved.matchModRoleId).toBe('env-mod');
    expect(resolved.matchModRoleSource).toBe('env');
  });

  it('reports unset when neither DB nor env provides a value', async () => {
    findUnique.mockResolvedValue(null);

    const resolved = await resolveGuildConfig('guild-1');

    expect(resolved.matchCreateRoleId).toBeUndefined();
    expect(resolved.matchCreateRoleSource).toBe('unset');
    expect(resolved.matchModRoleSource).toBe('unset');
  });
});

describe('setMatchCreateRole / setMatchModRole', () => {
  beforeEach(() => {
    upsert.mockReset();
    upsert.mockResolvedValue({});
  });

  it('upserts create role without clearing mod', async () => {
    await setMatchCreateRole('guild-1', 'role-create');

    expect(upsert).toHaveBeenCalledWith({
      where: { guildId: 'guild-1' },
      create: { guildId: 'guild-1', matchCreateRoleId: 'role-create' },
      update: { matchCreateRoleId: 'role-create' },
    });
  });

  it('upserts mod role without clearing create', async () => {
    await setMatchModRole('guild-1', 'role-mod');

    expect(upsert).toHaveBeenCalledWith({
      where: { guildId: 'guild-1' },
      create: { guildId: 'guild-1', matchModRoleId: 'role-mod' },
      update: { matchModRoleId: 'role-mod' },
    });
  });
});

describe('canConfigureBot', () => {
  it('allows the hard-coded owner without Manage Guild', () => {
    expect(
      canConfigureBot({ userId: BOT_OWNER_DISCORD_ID, memberPermissions: null }),
    ).toBe(true);
  });

  it('allows Manage Guild', () => {
    const perms = new PermissionsBitField(PermissionFlagsBits.ManageGuild);
    expect(canConfigureBot({ userId: 'someone', memberPermissions: perms })).toBe(true);
  });

  it('rejects everyone else', () => {
    expect(canConfigureBot({ userId: 'someone', memberPermissions: 0n })).toBe(false);
  });
});

describe('assertCanConfigureBot', () => {
  it('throws when not allowed', () => {
    expect(() =>
      assertCanConfigureBot({ userId: 'someone', memberPermissions: null }),
    ).toThrow(MatchServiceError);
    expect(() =>
      assertCanConfigureBot({ userId: 'someone', memberPermissions: null }),
    ).toThrow('You do not have permission to configure this bot.');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/services/guild-config.test.ts`

Expected: FAIL (module missing)

- [ ] **Step 3: Implement `guild-config.ts`**

Create `src/services/guild-config.ts`:

```ts
import {
  PermissionFlagsBits,
  PermissionsBitField,
  type PermissionsString,
} from 'discord.js';
import { env } from '../config/env.js';
import { prisma } from '../lib/prisma.js';
import { MatchServiceError } from './match-service.js';

export const BOT_OWNER_DISCORD_ID = '723326675647070218';

const CONFIGURE_FORBIDDEN = 'You do not have permission to configure this bot.';

export type RoleConfigSource = 'database' | 'env' | 'unset';

export interface ResolvedGuildConfig {
  matchCreateRoleId: string | undefined;
  matchModRoleId: string | undefined;
  matchCreateRoleSource: RoleConfigSource;
  matchModRoleSource: RoleConfigSource;
}

function resolveField(
  dbValue: string | null | undefined,
  envValue: string | undefined,
): { value: string | undefined; source: RoleConfigSource } {
  if (dbValue !== null && dbValue !== undefined && dbValue.trim() !== '') {
    return { value: dbValue.trim(), source: 'database' };
  }

  if (envValue !== undefined && envValue.trim() !== '') {
    return { value: envValue.trim(), source: 'env' };
  }

  return { value: undefined, source: 'unset' };
}

export async function resolveGuildConfig(guildId: string): Promise<ResolvedGuildConfig> {
  const row = await prisma.guildConfig.findUnique({ where: { guildId } });

  const create = resolveField(row?.matchCreateRoleId, env.matchCreateRoleId);
  const mod = resolveField(row?.matchModRoleId, env.matchModRoleId);

  return {
    matchCreateRoleId: create.value,
    matchModRoleId: mod.value,
    matchCreateRoleSource: create.source,
    matchModRoleSource: mod.source,
  };
}

export async function setMatchCreateRole(guildId: string, roleId: string): Promise<void> {
  await prisma.guildConfig.upsert({
    where: { guildId },
    create: { guildId, matchCreateRoleId: roleId },
    update: { matchCreateRoleId: roleId },
  });
}

export async function setMatchModRole(guildId: string, roleId: string): Promise<void> {
  await prisma.guildConfig.upsert({
    where: { guildId },
    create: { guildId, matchModRoleId: roleId },
    update: { matchModRoleId: roleId },
  });
}

export function canConfigureBot(input: {
  userId: string;
  memberPermissions:
    | PermissionsBitField
    | bigint
    | string
    | ReadonlyArray<PermissionsString>
    | null
    | undefined;
}): boolean {
  if (input.userId === BOT_OWNER_DISCORD_ID) {
    return true;
  }

  if (input.memberPermissions == null) {
    return false;
  }

  const bitfield = new PermissionsBitField(input.memberPermissions as never);
  return bitfield.has(PermissionFlagsBits.ManageGuild);
}

export function assertCanConfigureBot(input: {
  userId: string;
  memberPermissions:
    | PermissionsBitField
    | bigint
    | string
    | ReadonlyArray<PermissionsString>
    | null
    | undefined;
}): void {
  if (!canConfigureBot(input)) {
    throw new MatchServiceError(CONFIGURE_FORBIDDEN);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/services/guild-config.test.ts`

Expected: PASS

- [ ] **Step 5: Commit** (only if user asked)

```bash
git add src/services/guild-config.ts src/services/guild-config.test.ts
git commit -m "$(cat <<'EOF'
Add guild config resolve/set and configure-bot auth.

EOF
)"
```

---

### Task 4: `/config` slash command

**Files:**
- Create: `src/commands/config/config.ts`

**Interfaces:**
- Consumes: `resolveGuildConfig`, `setMatchCreateRole`, `setMatchModRole`, `assertCanConfigureBot`
- Produces: Discord command `config` with subcommands `view`, `set create_role`, `set mod_role`

- [ ] **Step 1: Implement the command**

Create `src/commands/config/config.ts`:

```ts
import { GuildMember, MessageFlags, SlashCommandBuilder } from 'discord.js';
import type { ChatInputCommandInteraction } from 'discord.js';
import { createLogger } from '../../lib/logger.js';
import {
  assertCanConfigureBot,
  resolveGuildConfig,
  setMatchCreateRole,
  setMatchModRole,
  type RoleConfigSource,
} from '../../services/guild-config.js';
import { MatchServiceError } from '../../services/match-service.js';

const log = createLogger('config_cmd');

function memberPermissions(interaction: ChatInputCommandInteraction) {
  const member = interaction.member;

  if (member instanceof GuildMember) {
    return member.permissions;
  }

  if (member && typeof member === 'object' && 'permissions' in member) {
    return (member as { permissions: string }).permissions;
  }

  return null;
}

function formatRoleLine(
  label: string,
  roleId: string | undefined,
  source: RoleConfigSource,
): string {
  const value = roleId ? `<@&${roleId}> (\`${roleId}\`)` : '`unset`';
  return `**${label}:** ${value} — source: \`${source}\``;
}

export const data = new SlashCommandBuilder()
  .setName('config')
  .setDescription('View or set bot configuration for this server')
  .addSubcommand((subcommand) =>
    subcommand.setName('view').setDescription('Show match create/mod role settings'),
  )
  .addSubcommandGroup((group) =>
    group
      .setName('set')
      .setDescription('Set a bot configuration value')
      .addSubcommand((subcommand) =>
        subcommand
          .setName('create_role')
          .setDescription('Set the role required to register lobbies')
          .addRoleOption((option) =>
            option
              .setName('role')
              .setDescription('Discord role that may use /register_lobby')
              .setRequired(true),
          ),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName('mod_role')
          .setDescription('Set the role that may report/cancel matches like the host')
          .addRoleOption((option) =>
            option
              .setName('role')
              .setDescription('Discord role for match moderators')
              .setRequired(true),
          ),
      ),
  );

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guildId) {
    await interaction.reply({
      content: 'This command can only be used in a server.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  try {
    assertCanConfigureBot({
      userId: interaction.user.id,
      memberPermissions: memberPermissions(interaction),
    });
  } catch (error) {
    if (error instanceof MatchServiceError) {
      await interaction.reply({
        content: error.message,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    throw error;
  }

  const subcommandGroup = interaction.options.getSubcommandGroup(false);
  const subcommand = interaction.options.getSubcommand(true);

  if (subcommand === 'view') {
    const resolved = await resolveGuildConfig(interaction.guildId);
    await interaction.reply({
      content: [
        'Bot configuration for this server:',
        formatRoleLine(
          'Create role',
          resolved.matchCreateRoleId,
          resolved.matchCreateRoleSource,
        ),
        formatRoleLine('Mod role', resolved.matchModRoleId, resolved.matchModRoleSource),
      ].join('\n'),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (subcommandGroup === 'set') {
    const role = interaction.options.getRole('role', true);

    if (subcommand === 'create_role') {
      await setMatchCreateRole(interaction.guildId, role.id);
      log.info(
        { guildId: interaction.guildId, roleId: role.id, userId: interaction.user.id },
        'Match create role updated',
      );
      await interaction.reply({
        content: `Create role set to <@&${role.id}>.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (subcommand === 'mod_role') {
      await setMatchModRole(interaction.guildId, role.id);
      log.info(
        { guildId: interaction.guildId, roleId: role.id, userId: interaction.user.id },
        'Match mod role updated',
      );
      await interaction.reply({
        content: `Mod role set to <@&${role.id}>.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  }

  await interaction.reply({
    content: 'Unknown config subcommand.',
    flags: MessageFlags.Ephemeral,
  });
}
```

- [ ] **Step 2: Typecheck / unit suite still green**

Run: `npm test`

Expected: PASS (existing + new tests). Command file is loaded at runtime by the bot; no unit test required for Discord I/O in this slice.

- [ ] **Step 3: Commit** (only if user asked)

```bash
git add src/commands/config/config.ts
git commit -m "$(cat <<'EOF'
Add /config view and set commands for guild roles.

EOF
)"
```

---

### Task 5: Wire call sites to `resolveGuildConfig`

**Files:**
- Modify: `src/commands/lobby/register-lobby.ts`
- Modify: `src/commands/match/match.ts`
- Modify: `src/handlers/match-interactions.ts`
- Modify: `src/services/lobby-actions.ts`

**Interfaces:**
- Consumes: `resolveGuildConfig(guildId)` → pass `matchCreateRoleId` / `matchModRoleId` into auth helpers
- Produces: all create/manage checks use resolved guild config

- [ ] **Step 1: Update `register-lobby.ts`**

1. Import `resolveGuildConfig` from `../../services/guild-config.js`.
2. Replace the create assert block with:

```ts
  try {
    if (!interaction.guildId) {
      throw new MatchServiceError('This command can only be used in a server.');
    }

    const config = await resolveGuildConfig(interaction.guildId);
    assertCanCreateMatch({
      memberRoleIds: memberRoleIds(interaction),
      matchCreateRoleId: config.matchCreateRoleId,
    });
  } catch (error) {
    if (error instanceof MatchServiceError) {
      log.warn({ err: error, userId: interaction.user.id }, 'Match lobby creation forbidden');
      await interaction.editReply(error.message);
      return;
    }

    throw error;
  }
```

- [ ] **Step 2: Update `lobby-actions.ts` in-progress resolver**

Change `resolveInProgressMatchByMessageId` to accept and forward mod role:

```ts
export async function resolveInProgressMatchByMessageId(input: {
  messageId: string;
  actorDiscordId: string;
  memberRoleIds: string[];
  matchModRoleId?: string;
}): Promise<MatchWithPlayers> {
  const match = await getMatchByDiscordMessageId(input.messageId);

  if (!match) {
    throw new MatchServiceError('This match was not found.');
  }

  if (match.status !== 'IN_PROGRESS') {
    throw new MatchServiceError('This match is not in progress.');
  }

  assertCanManageMatch({
    hostDiscordId: match.hostDiscordId,
    actorDiscordId: input.actorDiscordId,
    memberRoleIds: input.memberRoleIds,
    matchModRoleId: input.matchModRoleId,
  });

  return match;
}
```

- [ ] **Step 3: Update `match-interactions.ts`**

1. Import `resolveGuildConfig`.
2. Where `resolveInProgressMatchByMessageId` is called (~line 248), resolve config first:

```ts
  if (!interaction.guildId) {
    throw new MatchServiceError('This action can only be used in a server.');
  }

  const config = await resolveGuildConfig(interaction.guildId);

  return resolveInProgressMatchByMessageId({
    messageId: interaction.message.id,
    actorDiscordId: interaction.user.id,
    memberRoleIds: memberRoleIds(interaction),
    matchModRoleId: config.matchModRoleId,
  });
```

3. In `resolveById`, before `assertCanManageMatch`:

```ts
  if (!interaction.guildId) {
    throw new MatchServiceError('This action can only be used in a server.');
  }

  const config = await resolveGuildConfig(interaction.guildId);

  assertCanManageMatch({
    hostDiscordId: match.hostDiscordId,
    actorDiscordId: interaction.user.id,
    memberRoleIds: memberRoleIds(interaction),
    matchModRoleId: config.matchModRoleId,
  });
```

- [ ] **Step 4: Update `match.ts`**

1. Remove `import { env } from '../../config/env.js'`.
2. Import `resolveGuildConfig`.
3. Replace `hasMatchModeratorRole` to take the resolved mod role:

```ts
function hasMatchModeratorRole(
  interaction: { member: unknown },
  matchModRoleId: string | undefined,
): boolean {
  if (!matchModRoleId) {
    return false;
  }

  return memberRoleIds(interaction).includes(matchModRoleId);
}
```

4. At the start of `resolveMatchForCommand`, require guild and resolve config:

```ts
async function resolveMatchForCommand(
  interaction: ChatInputCommandInteraction,
  matchId: string | null,
): Promise<MatchWithPlayers> {
  if (!interaction.guildId) {
    throw new MatchServiceError('This command can only be used in a server.');
  }

  const config = await resolveGuildConfig(interaction.guildId);
  const roles = memberRoleIds(interaction);

  if (matchId) {
    const match = await getMatchById(matchId);

    if (!match) {
      throw new MatchServiceError('This match was not found.');
    }

    if (match.status !== 'IN_PROGRESS') {
      throw new MatchServiceError('This match is not in progress.');
    }

    assertCanManageMatch({
      hostDiscordId: match.hostDiscordId,
      actorDiscordId: interaction.user.id,
      memberRoleIds: roles,
      matchModRoleId: config.matchModRoleId,
    });

    return match;
  }

  const matches = await findInProgressMatchesByHost(interaction.user.id);

  if (matches.length === 1) {
    return matches[0]!;
  }

  if (matches.length > 1) {
    throw new MatchServiceError(
      'You have more than one in-progress match. Pass match_id to choose one.',
    );
  }

  if (hasMatchModeratorRole(interaction, config.matchModRoleId)) {
    throw new MatchServiceError('Provide match_id when using the match moderator role.');
  }

  throw new MatchServiceError('You have no in-progress match. Pass match_id to choose one.');
}
```

(Simplify the previous `canAct` + redundant `assertCanManageMatch` to a single assert as above.)

- [ ] **Step 5: Run full test suite**

Run: `npm test`

Expected: PASS. Fix any TypeScript/signature breakages from `resolveInProgressMatchByMessageId`.

- [ ] **Step 6: Commit** (only if user asked)

```bash
git add src/commands/lobby/register-lobby.ts src/commands/match/match.ts \
  src/handlers/match-interactions.ts src/services/lobby-actions.ts
git commit -m "$(cat <<'EOF'
Resolve guild role config at match auth call sites.

EOF
)"
```

---

### Task 6: Document env fallback

**Files:**
- Modify: `.env.example`
- Modify: `.cursor/rules/scripts-and-env.mdc`

**Interfaces:**
- Produces: operator docs stating env is fallback until `/config set`

- [ ] **Step 1: Update `.env.example`**

Replace the match role comments with:

```env
# Fallback Discord role IDs until each is set per-server with /config set …
# After /config set create_role|mod_role, the database value wins for that guild.
# Empty create fallback = nobody can /register_lobby until configured.
# Empty mod fallback = host-only manage until configured.
# MATCH_CREATE_ROLE_ID=
# MATCH_MOD_ROLE_ID=
```

- [ ] **Step 2: Update `scripts-and-env.mdc`**

Replace the two role bullets with:

```md
- `MATCH_MOD_ROLE_ID` — fallback Discord role that may report/cancel in-progress matches (host always can); overridden per guild after `/config set mod_role`
- `MATCH_CREATE_ROLE_ID` — fallback Discord role required to run `/register_lobby` (empty/unset = creation disabled); overridden per guild after `/config set create_role`
```

- [ ] **Step 3: Commit** (only if user asked)

```bash
git add .env.example .cursor/rules/scripts-and-env.mdc
git commit -m "$(cat <<'EOF'
Document MATCH_* role env vars as guild-config fallbacks.

EOF
)"
```

---

### Task 7: Manual smoke checklist

- [ ] **Step 1: Restart bot** (`npm run dev`) so `/config` deploys

- [ ] **Step 2: Verify**

1. No `GuildConfig` row + env create/mod set → `/config view` shows roles with source `env`; create/mod auth still works
2. `/config set create_role @SomeRole` as Manage Guild user → success; `view` shows source `database` for create; mod still `env` if unset in DB
3. Owner ID `723326675647070218` can `/config` without Manage Guild
4. Random member without Manage Guild → permission error
5. Unset env create **and** never set DB create → `/register_lobby` → `Match creation is disabled until a create role is configured.`
6. After DB create role set, member with that role can register; member without cannot
7. DM `/config` → server-only message

---

## Spec coverage (self-review)

| Spec requirement | Task |
|------------------|------|
| `GuildConfig` table | Task 1 |
| DB wins per field; else env | Task 3 |
| Set-only upserts | Task 3 + 4 |
| `/config view` + sources | Task 4 |
| `/config set create_role` / `mod_role` | Task 4 |
| Manage Guild \| owner ID | Task 3 + 4 |
| Owner constant in code | Task 3 |
| Resolve by `interaction.guildId` | Task 4 + 5 |
| `match-auth` injected IDs | Task 2 |
| Call sites wired | Task 5 |
| New disabled-create copy | Task 2 |
| Env kept as fallback + docs | Task 6 |
| Tech debt (toggles/clear) | Spec only (no code) |
| Unit tests resolve/auth/set | Task 2 + 3 |
| Manual smoke | Task 7 |
