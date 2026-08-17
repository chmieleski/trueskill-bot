# Lobby Channel Command Allowlist Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a Discord channel is any league’s ready `lobby_channel`, only `/register_lobby`, `/lobby`, and `/match complete|cancel|quitters` may run there; other slash commands get an ephemeral refusal.

**Architecture:** Pure allowlist + guild/channel DB lookup helpers live beside existing lobby-channel logic. A single denial helper returns `string | null`. `interaction-create` calls it before slash autocomplete and `execute`. Message components stay ungated.

**Tech Stack:** TypeScript ESM, Prisma, discord.js v14, Vitest

**Spec:** `docs/superpowers/specs/2026-08-17-lobby-channel-command-allowlist-design.md`

**Scope:** `general`

## Global Constraints

- English-only user-facing strings, logs, command names/descriptions, and errors
- ESM imports in TypeScript source use the `.js` extension
- Named exports only
- Prisma singleton from `src/lib/prisma.ts` — never `new PrismaClient()` elsewhere
- No schema, env, or AWS SSM changes
- Do not gate message components / modals
- Do not put the allowlist inside match/lobby use-cases or individual command files
- New slash commands default to **blocked** in a ready lobby channel unless added to the allowlist
- Deny copy must be exactly: `Only lobby and match commands can be used in <#id>.`

## File map

| File | Role |
|------|------|
| `src/services/league/league-lobby-channel.ts` | Allowlist, `isGuildLobbyChannel`, denial helper + locked copy |
| `src/services/league/league-lobby-channel.test.ts` | Unit tests for new helpers |
| `src/services/league/index.ts` | Re-export helpers used by the event handler |
| `src/events/interaction-create.ts` | Central gate before autocomplete + `execute` |
| `docs/discord/staff/a1-roles-and-setup.md` | One-line note that the lobby channel also limits slash commands |
| `docs/discord/staff/a5-admin-cheat-sheet.md` | Same brief note |

---

### Task 1: Allowlist + denial helpers (TDD)

**Files:**
- Modify: `src/services/league/league-lobby-channel.ts`
- Modify: `src/services/league/league-lobby-channel.test.ts`
- Modify: `src/services/league/index.ts`

**Interfaces:**
- Consumes: existing `prisma` usage patterns in `league-lobby-channel.ts`; existing vitest prisma mock in the test file
- Produces:
  - `lobbyChannelCommandsLimitedMessage(channelId: string): string`
  - `isLobbyChannelAllowedCommand(commandName: string, subcommand?: string | null): boolean`
  - `isGuildLobbyChannel(guildId: string, channelId: string): Promise<boolean>`
  - `getLobbyChannelSlashDenial(guildId: string | null, channelId: string | null, commandName: string, subcommand?: string | null): Promise<string | null>`

- [ ] **Step 1: Extend the Prisma mock so `findFirst` exists**

In `src/services/league/league-lobby-channel.test.ts`, the hoisted mock currently only has `findUnique` and `update`. Add `findFirst`:

```typescript
const { findUnique, findFirst, update } = vi.hoisted(() => ({
  findUnique: vi.fn(),
  findFirst: vi.fn(),
  update: vi.fn(),
}));

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    league: { findUnique, findFirst, update },
  },
}));
```

In `beforeEach` (or wherever mocks are reset), also `findFirst.mockReset()`.

- [ ] **Step 2: Write failing tests for allowlist + message + guild lookup + denial**

Append to `src/services/league/league-lobby-channel.test.ts` (update the import list to include the new symbols):

```typescript
import {
  // …existing imports…
  getLobbyChannelSlashDenial,
  isGuildLobbyChannel,
  isLobbyChannelAllowedCommand,
  lobbyChannelCommandsLimitedMessage,
} from './league-lobby-channel.js';

describe('isLobbyChannelAllowedCommand', () => {
  it('allows register_lobby and lobby regardless of subcommand', () => {
    expect(isLobbyChannelAllowedCommand('register_lobby')).toBe(true);
    expect(isLobbyChannelAllowedCommand('lobby', 'add')).toBe(true);
    expect(isLobbyChannelAllowedCommand('lobby', null)).toBe(true);
  });

  it('allows only match complete, cancel, and quitters', () => {
    expect(isLobbyChannelAllowedCommand('match', 'complete')).toBe(true);
    expect(isLobbyChannelAllowedCommand('match', 'cancel')).toBe(true);
    expect(isLobbyChannelAllowedCommand('match', 'quitters')).toBe(true);
    expect(isLobbyChannelAllowedCommand('match', 'history')).toBe(false);
    expect(isLobbyChannelAllowedCommand('match', 'show')).toBe(false);
    expect(isLobbyChannelAllowedCommand('match', 'flip')).toBe(false);
    expect(isLobbyChannelAllowedCommand('match', 'void')).toBe(false);
    expect(isLobbyChannelAllowedCommand('match', null)).toBe(false);
    expect(isLobbyChannelAllowedCommand('match')).toBe(false);
  });

  it('blocks other root commands', () => {
    expect(isLobbyChannelAllowedCommand('rank')).toBe(false);
    expect(isLobbyChannelAllowedCommand('config', 'view')).toBe(false);
    expect(isLobbyChannelAllowedCommand('leaderboard', 'show')).toBe(false);
  });
});

describe('lobbyChannelCommandsLimitedMessage', () => {
  it('uses the locked English copy', () => {
    expect(lobbyChannelCommandsLimitedMessage('chan-1')).toBe(
      'Only lobby and match commands can be used in <#chan-1>.',
    );
  });
});

describe('isGuildLobbyChannel', () => {
  beforeEach(() => {
    findFirst.mockReset();
  });

  it('is true when a ready league row matches guild + channel', async () => {
    findFirst.mockResolvedValue({ id: 'L1' });
    await expect(isGuildLobbyChannel('g1', 'lobby')).resolves.toBe(true);
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        guildId: 'g1',
        lobbyChannelEnabled: true,
        lobbyChannelId: 'lobby',
      },
      select: { id: true },
    });
  });

  it('is false when no row matches', async () => {
    findFirst.mockResolvedValue(null);
    await expect(isGuildLobbyChannel('g1', 'other')).resolves.toBe(false);
  });
});

describe('getLobbyChannelSlashDenial', () => {
  beforeEach(() => {
    findFirst.mockReset();
  });

  it('returns null without guild or channel', async () => {
    await expect(
      getLobbyChannelSlashDenial(null, 'c', 'rank'),
    ).resolves.toBeNull();
    await expect(
      getLobbyChannelSlashDenial('g', null, 'rank'),
    ).resolves.toBeNull();
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('returns null for allowed commands without hitting the DB', async () => {
    await expect(
      getLobbyChannelSlashDenial('g', 'lobby', 'lobby', 'add'),
    ).resolves.toBeNull();
    await expect(
      getLobbyChannelSlashDenial('g', 'lobby', 'match', 'complete'),
    ).resolves.toBeNull();
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('returns null when the channel is not a ready lobby channel', async () => {
    findFirst.mockResolvedValue(null);
    await expect(
      getLobbyChannelSlashDenial('g', 'chat', 'rank'),
    ).resolves.toBeNull();
  });

  it('returns the locked message when blocked in a ready lobby channel', async () => {
    findFirst.mockResolvedValue({ id: 'L1' });
    await expect(
      getLobbyChannelSlashDenial('g', 'lobby', 'match', 'history'),
    ).resolves.toBe(lobbyChannelCommandsLimitedMessage('lobby'));
    await expect(
      getLobbyChannelSlashDenial('g', 'lobby', 'rank'),
    ).resolves.toBe(lobbyChannelCommandsLimitedMessage('lobby'));
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test -- src/services/league/league-lobby-channel.test.ts`

Expected: FAIL (new symbols not exported / not defined).

- [ ] **Step 4: Implement helpers in `league-lobby-channel.ts`**

Append (after the existing exports; keep `trimOptionalId` private as today):

```typescript
const LOBBY_CHANNEL_ALLOWED_MATCH_SUBCOMMANDS = new Set([
  'complete',
  'cancel',
  'quitters',
]);

/** User-facing copy when a non-allowlisted slash command is used in a ready lobby channel. */
export function lobbyChannelCommandsLimitedMessage(channelId: string): string {
  return `Only lobby and match commands can be used in <#${channelId}>.`;
}

/**
 * Slash commands permitted inside a ready league lobby channel.
 * `/match` is limited to in-progress ops; missing/unknown subcommand is denied.
 */
export function isLobbyChannelAllowedCommand(
  commandName: string,
  subcommand?: string | null,
): boolean {
  if (commandName === 'register_lobby' || commandName === 'lobby') {
    return true;
  }
  if (commandName === 'match') {
    return (
      typeof subcommand === 'string' &&
      LOBBY_CHANNEL_ALLOWED_MATCH_SUBCOMMANDS.has(subcommand)
    );
  }
  return false;
}

/**
 * True when any league in the guild has the lobby channel gate ready on this channel id.
 * Stored ids are trimmed on write; query uses the interaction channel id as-is.
 */
export async function isGuildLobbyChannel(
  guildId: string,
  channelId: string,
): Promise<boolean> {
  const row = await prisma.league.findFirst({
    where: {
      guildId,
      lobbyChannelEnabled: true,
      lobbyChannelId: channelId,
    },
    select: { id: true },
  });
  return row != null;
}

/**
 * If this slash/autocomplete must be blocked in the current channel, return the deny message.
 * Otherwise null (proceed). Allowed commands skip the DB lookup.
 */
export async function getLobbyChannelSlashDenial(
  guildId: string | null,
  channelId: string | null,
  commandName: string,
  subcommand?: string | null,
): Promise<string | null> {
  if (!guildId || !channelId) {
    return null;
  }
  if (isLobbyChannelAllowedCommand(commandName, subcommand)) {
    return null;
  }
  if (!(await isGuildLobbyChannel(guildId, channelId))) {
    return null;
  }
  return lobbyChannelCommandsLimitedMessage(channelId);
}
```

- [ ] **Step 5: Re-export from `src/services/league/index.ts`**

Add to the existing `league-lobby-channel.js` export block:

```typescript
export {
  LOBBY_CHANNEL_CHANNEL_ONLY_WHILE_DISABLED,
  LOBBY_CHANNEL_ENABLE_NEEDS_CHANNEL,
  LOBBY_CHANNEL_HOST_PROMPT_MISMATCH,
  LOBBY_CHANNEL_SET_NEEDS_OPTION,
  assertLeagueLobbyCreateChannel,
  clearLeagueLobbyChannel,
  formatLobbyChannelConfigLine,
  getLobbyChannelSlashDenial,
  isGuildLobbyChannel,
  isLeagueLobbyChannelReady,
  isLobbyChannelAllowedCommand,
  lobbyChannelCommandsLimitedMessage,
  lobbyCreationLimitedMessage,
  setLeagueLobbyChannel,
} from './league-lobby-channel.js';
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test -- src/services/league/league-lobby-channel.test.ts`

Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/services/league/league-lobby-channel.ts src/services/league/league-lobby-channel.test.ts src/services/league/index.ts
git commit -m "$(cat <<'EOF'
Add lobby channel slash command allowlist helpers.

EOF
)"
```

---

### Task 2: Central gate in `interaction-create`

**Files:**
- Modify: `src/events/interaction-create.ts`

**Interfaces:**
- Consumes: `getLobbyChannelSlashDenial(guildId, channelId, commandName, subcommand?)` from Task 1
- Produces: Slash autocomplete and `execute` blocked with ephemeral / empty choices when denial is non-null; components unchanged

- [ ] **Step 1: Import the denial helper**

At the top of `src/events/interaction-create.ts`, add:

```typescript
import { getLobbyChannelSlashDenial } from '../services/league/index.js';
```

- [ ] **Step 2: Gate autocomplete**

Replace the autocomplete block so denial runs first:

```typescript
  if (interaction.isAutocomplete()) {
    try {
      const denial = await getLobbyChannelSlashDenial(
        interaction.guildId,
        interaction.channelId,
        interaction.commandName,
        interaction.options.getSubcommand(false),
      );
      if (denial) {
        await interaction.respond([]);
        return;
      }

      const command = interaction.client.commands.get(interaction.commandName);
      if (command?.autocomplete) {
        await command.autocomplete(interaction);
      }
    } catch (error) {
      log.error(
        { err: error, command: interaction.commandName, userId: interaction.user.id },
        'Failed to handle autocomplete',
      );
    }
    return;
  }
```

- [ ] **Step 3: Gate chat input `execute`**

After resolving `command` and before the `log.info` / `command.execute` try block, insert:

```typescript
  const denial = await getLobbyChannelSlashDenial(
    interaction.guildId,
    interaction.channelId,
    interaction.commandName,
    interaction.options.getSubcommand(false),
  );
  if (denial) {
    await interaction.reply({ content: denial, flags: MessageFlags.Ephemeral });
    return;
  }
```

Full shape of the chat-input section after the change:

```typescript
  if (!interaction.isChatInputCommand()) {
    return;
  }

  const command = interaction.client.commands.get(interaction.commandName);

  if (!command) {
    log.error({ commandName: interaction.commandName }, 'Command not found');
    return;
  }

  const denial = await getLobbyChannelSlashDenial(
    interaction.guildId,
    interaction.channelId,
    interaction.commandName,
    interaction.options.getSubcommand(false),
  );
  if (denial) {
    await interaction.reply({ content: denial, flags: MessageFlags.Ephemeral });
    return;
  }

  log.info(
    {
      command: interaction.commandName,
      userId: interaction.user.id,
      guildId: interaction.guildId,
    },
    'Executing slash command',
  );

  try {
    await command.execute(interaction);
    // …existing catch unchanged…
```

Do **not** wrap component handlers. Do **not** change lobby/match command files.

- [ ] **Step 4: Typecheck / focused tests**

Run:

```bash
npm test -- src/services/league/league-lobby-channel.test.ts
npx tsc --noEmit
```

Expected: tests PASS; `tsc` clean (or only pre-existing unrelated errors — fix any new errors from this change).

- [ ] **Step 5: Commit**

```bash
git add src/events/interaction-create.ts
git commit -m "$(cat <<'EOF'
Gate non-lobby slash commands in ready lobby channels.

EOF
)"
```

---

### Task 3: Staff docs note

**Files:**
- Modify: `docs/discord/staff/a1-roles-and-setup.md`
- Modify: `docs/discord/staff/a5-admin-cheat-sheet.md`

**Interfaces:**
- Consumes: locked allowlist behavior from the spec
- Produces: short admin-facing note that a ready lobby channel also limits slash commands

- [ ] **Step 1: Update `a1-roles-and-setup.md`**

Near the existing `/config set lobby_channel` lines, add one sentence such as:

```markdown
When the lobby channel is on, only `/register_lobby`, `/lobby`, and `/match complete|cancel|quitters` work in that channel; other slash commands are refused there.
```

Keep surrounding setup instructions intact.

- [ ] **Step 2: Update `a5-admin-cheat-sheet.md`**

On the lobby_channel cheat-sheet line (or immediately under it), add the same constraint in one short clause, e.g.:

```markdown
• `/config set|clear lobby_channel` — optional per-league create-only channel; when on, also limits slash commands in that channel to lobby/match ops
```

- [ ] **Step 3: Commit**

```bash
git add docs/discord/staff/a1-roles-and-setup.md docs/discord/staff/a5-admin-cheat-sheet.md
git commit -m "$(cat <<'EOF'
Document lobby channel slash command limits for staff.

EOF
)"
```

---

## Manual verification (after all tasks)

1. Ready lobby channel → `/rank` ephemeral: `Only lobby and match commands can be used in <#…>.`
2. Same channel → `/match history` denied; `/match complete` allowed (subject to existing auth)
3. Same channel → `/lobby add` and `/register_lobby` allowed
4. Lobby embed buttons still work
5. Other channel → `/rank` and `/match history` unchanged
6. Disable lobby channel → allowlist no longer applies in that channel

---

## Spec coverage (self-review)

| Spec requirement | Task |
|------------------|------|
| Trigger: any ready league lobby channel in guild | Task 1 `isGuildLobbyChannel` |
| Allow `/register_lobby`, `/lobby`, `/match complete\|cancel\|quitters` | Task 1 allowlist |
| Block `/match history` and other roots | Task 1 + Task 2 |
| Central gate in `interaction-create` | Task 2 |
| Autocomplete gated | Task 2 |
| Components ungated | Task 2 (no changes to component path) |
| Locked English deny copy | Task 1 |
| No schema/env | All tasks |
| Staff note | Task 3 |
