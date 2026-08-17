# League Lobby Channel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a guild admin enable a per-league dedicated lobby channel so ranked lobby **creation** (`/register_lobby` and wc3stats Open lobby) only works in that channel.

**Architecture:** Store `lobbyChannelEnabled` + `lobbyChannelId` on `League`. A small league service asserts the create channel and keeps the wc3stats host-prompt channel aligned when both features are on. Discord adapters stay thin: `/config` writes the fields; create paths call the assert before `createPendingMatch`.

**Tech Stack:** TypeScript ESM, Prisma, discord.js v14, Vitest

**Spec:** `docs/superpowers/specs/2026-08-17-league-lobby-channel-design.md`

**Scope:** `general`

## Global Constraints

- English-only user-facing strings, logs, command names/descriptions, and errors
- ESM imports in TypeScript source use the `.js` extension
- Named exports only
- Prisma singleton from `src/lib/prisma.ts` — never `new PrismaClient()` elsewhere
- No new production env / SSM keys
- Do not put the gate in `createPendingMatch` or `/lobby` use-cases
- Do not auto-bind `LeagueChannelBinding` for the lobby channel
- Do not split `src/commands/config/config.ts` in this feature
- `src/commands/config/config.ts` is already ~1178 lines (under the 1600 max); adding one set/clear pair is OK

## File map

| File | Role |
|------|------|
| `prisma/schema.prisma` | `League.lobbyChannelEnabled`, `League.lobbyChannelId` |
| `prisma/migrations/20260817120000_league_lobby_channel/migration.sql` | ALTER TABLE |
| `src/services/league/league-lobby-channel.ts` | Ready/assert/set/clear, mismatch helper, view-line formatter, locked copy |
| `src/services/league/league-lobby-channel.test.ts` | Unit tests for the module |
| `src/services/league/league-wc3stats.ts` | Resolve new fields; host-prompt setter calls mismatch helper |
| `src/services/league/league-wc3stats.test.ts` | Host-prompt setter mismatch + resolve defaults |
| `src/services/league/index.ts` | Re-export lobby-channel helpers used by commands |
| `src/commands/config/config.ts` | `/config set\|clear lobby_channel` + view line |
| `src/commands/lobby/register-lobby.ts` | Assert before create |
| `src/discord/interactions/wc3stats-host-prompt-interactions.ts` | Assert before Open lobby create |
| `src/services/wc3stats/wc3stats-host-prompt-poller.ts` | Skip + `log.error` when both ready and channels differ |
| `src/services/wc3stats/wc3stats-host-prompt-poller.test.ts` | Skip case |
| `docs/discord/staff/a1-roles-and-setup.md` | Admin setup |
| `docs/discord/staff/a4-wc3stats-mapping.md` | Host prompt must match lobby channel |
| `docs/discord/staff/a5-admin-cheat-sheet.md` | Cheat sheet lines |
| `docs/discord/public/03-start-a-lobby.md` | Players: use the lobby channel when the server locked it |
| `.cursor/rules/database-domain.mdc` | League holds lobby channel fields |

---

### Task 1: Schema, migration, resolve fields

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260817120000_league_lobby_channel/migration.sql`
- Modify: `src/services/league/league-wc3stats.ts`
- Create: `src/services/league/league-wc3stats.test.ts`

**Interfaces:**
- Consumes: existing `League` model and `resolveLeagueConfig`
- Produces: `League.lobbyChannelEnabled Boolean @default(false)`, `League.lobbyChannelId String?`; `ResolvedLeagueConfig.lobbyChannelEnabled: boolean`; `ResolvedLeagueConfig.lobbyChannelId: string | undefined`

- [ ] **Step 1: Add columns on `League` in `prisma/schema.prisma`**

Insert after `rankResetCooldownDays`:

```prisma
  rankResetCooldownDays         Int      @default(30)
  lobbyChannelEnabled           Boolean  @default(false)
  lobbyChannelId                String?
  createdAt                     DateTime @default(now())
```

- [ ] **Step 2: Write the migration SQL**

Create `prisma/migrations/20260817120000_league_lobby_channel/migration.sql`:

```sql
-- AlterTable
ALTER TABLE "League" ADD COLUMN "lobbyChannelEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "League" ADD COLUMN "lobbyChannelId" TEXT;
```

- [ ] **Step 3: Extend `ResolvedLeagueConfig` and `resolveLeagueConfig`**

In `src/services/league/league-wc3stats.ts`, add the two fields to the interface (after `rankResetCooldownDays`):

```typescript
  rankResetEnabled: boolean;
  rankResetCooldownDays: number;
  lobbyChannelEnabled: boolean;
  lobbyChannelId: string | undefined;
```

In `resolveLeagueConfig`, append:

```typescript
    rankResetCooldownDays:
      row?.rankResetCooldownDays != null ? row.rankResetCooldownDays : 30,
    lobbyChannelEnabled: row?.lobbyChannelEnabled === true,
    lobbyChannelId: row?.lobbyChannelId?.trim() || undefined,
  };
```

Treat missing league / null / blank id as not enabled and `lobbyChannelId` undefined.

- [ ] **Step 4: Failing tests for resolve defaults**

Create `src/services/league/league-wc3stats.test.ts`:

```typescript
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { findUnique, update } = vi.hoisted(() => ({
  findUnique: vi.fn(),
  update: vi.fn(),
}));

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    league: { findUnique, update },
  },
}));

vi.mock('../lobby/register-lobby-source.js', () => ({
  assertLeagueAllowsWc3stats: vi.fn(),
  WC3STATS_CONFIG_UNSUPPORTED_MESSAGE: 'Warcraft lobby import is not available for this game.',
}));

import { resolveLeagueConfig, setLeagueWc3statsHostPrompt } from './league-wc3stats.js';
import { MatchServiceError } from '../match/match-service.js';
import { assertLeagueAllowsWc3stats } from '../lobby/register-lobby-source.js';
import { LOBBY_CHANNEL_HOST_PROMPT_MISMATCH } from './league-lobby-channel.js';

describe('resolveLeagueConfig lobby channel', () => {
  beforeEach(() => {
    findUnique.mockReset();
  });

  it('defaults lobby channel to off when the league row is missing', async () => {
    findUnique.mockResolvedValue(null);
    const resolved = await resolveLeagueConfig('league-1');
    expect(resolved.lobbyChannelEnabled).toBe(false);
    expect(resolved.lobbyChannelId).toBeUndefined();
  });

  it('trims a stored lobby channel id', async () => {
    findUnique.mockResolvedValue({
      lobbyChannelEnabled: true,
      lobbyChannelId: '  chan-1  ',
    });
    const resolved = await resolveLeagueConfig('league-1');
    expect(resolved.lobbyChannelEnabled).toBe(true);
    expect(resolved.lobbyChannelId).toBe('chan-1');
  });
});

describe('setLeagueWc3statsHostPrompt vs lobby channel', () => {
  beforeEach(() => {
    findUnique.mockReset();
    update.mockReset();
    vi.mocked(assertLeagueAllowsWc3stats).mockReset();
    vi.mocked(assertLeagueAllowsWc3stats).mockResolvedValue(undefined);
  });

  it('rejects enabling the host prompt on a different channel when lobby channel is ready', async () => {
    findUnique.mockResolvedValue({
      lobbyChannelEnabled: true,
      lobbyChannelId: 'lobby-chan',
    });

    await expect(
      setLeagueWc3statsHostPrompt('league-1', { enabled: true, channelId: 'other-chan' }),
    ).rejects.toBeInstanceOf(MatchServiceError);

    await expect(
      setLeagueWc3statsHostPrompt('league-1', { enabled: true, channelId: 'other-chan' }),
    ).rejects.toThrow(LOBBY_CHANNEL_HOST_PROMPT_MISMATCH);

    expect(update).not.toHaveBeenCalled();
  });

  it('allows enabling the host prompt when it matches the ready lobby channel', async () => {
    findUnique.mockResolvedValue({
      lobbyChannelEnabled: true,
      lobbyChannelId: 'lobby-chan',
    });

    await setLeagueWc3statsHostPrompt('league-1', {
      enabled: true,
      channelId: 'lobby-chan',
    });

    expect(update).toHaveBeenCalledWith({
      where: { id: 'league-1' },
      data: {
        wc3statsHostPromptEnabled: true,
        wc3statsHostPromptChannelId: 'lobby-chan',
      },
    });
  });

  it('does not check lobby channel when disabling the host prompt', async () => {
    await setLeagueWc3statsHostPrompt('league-1', { enabled: false });
    expect(findUnique).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith({
      where: { id: 'league-1' },
      data: {
        wc3statsHostPromptEnabled: false,
        wc3statsHostPromptChannelId: null,
      },
    });
  });
});
```

The host-prompt describe will fail until Task 3 wires the setter. **In this task, keep only the `resolveLeagueConfig lobby channel` describe.** Delete or comment the `setLeagueWc3statsHostPrompt vs lobby channel` describe until Task 3 — do not leave failing tests from a later task. Put the host-prompt describe into the file in Task 3.

- [ ] **Step 5: Run generate + the resolve tests**

Run:

```bash
npx prisma generate
npx vitest run src/services/league/league-wc3stats.test.ts
```

Expected: PASS (resolve describe only).

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260817120000_league_lobby_channel/migration.sql src/services/league/league-wc3stats.ts src/services/league/league-wc3stats.test.ts
git commit -m "$(cat <<'EOF'
Add per-league lobby channel columns.

EOF
)"
```

---

### Task 2: League lobby-channel service (TDD)

**Files:**
- Create: `src/services/league/league-lobby-channel.ts`
- Create: `src/services/league/league-lobby-channel.test.ts`
- Modify: `src/services/league/index.ts`

**Interfaces:**
- Consumes: `prisma.league`, `MatchServiceError`
- Produces (exact names/types):

```typescript
export const LOBBY_CHANNEL_ENABLE_NEEDS_CHANNEL =
  'Choose a channel when enabling the lobby channel.';
export const LOBBY_CHANNEL_CHANNEL_ONLY_WHILE_DISABLED =
  'Pass enabled:true to turn the lobby channel on.';
export const LOBBY_CHANNEL_HOST_PROMPT_MISMATCH =
  'The wc3stats host prompt channel must match the lobby channel while the lobby channel is enabled.';
export const LOBBY_CHANNEL_SET_NEEDS_OPTION = 'Provide enabled and/or channel.';

export function lobbyCreationLimitedMessage(channelId: string): string;

export function isLeagueLobbyChannelReady(config: {
  lobbyChannelEnabled?: boolean | null;
  lobbyChannelId?: string | null;
}): boolean;

export function assertLobbyCreateChannel(
  config: {
    lobbyChannelEnabled?: boolean | null;
    lobbyChannelId?: string | null;
  },
  channelId: string,
): void;

export function assertLobbyHostPromptChannelsCompatible(input: {
  lobbyEnabled: boolean;
  lobbyChannelId: string | undefined;
  hostPromptEnabled: boolean;
  hostPromptChannelId: string | undefined;
}): void;

export async function assertLeagueLobbyCreateChannel(
  leagueId: string,
  channelId: string,
): Promise<void>;

export async function setLeagueLobbyChannel(
  leagueId: string,
  input: { enabled?: boolean; channelId?: string },
): Promise<void>;

export async function clearLeagueLobbyChannel(leagueId: string): Promise<void>;

export function formatLobbyChannelConfigLine(
  enabled: boolean,
  channelId: string | undefined,
): string;
```

Mismatch rule used by config setters: if the **next** lobby state is ready (`enabled` + non-empty id) **and** host prompt is configured (`enabled` + non-empty id), the two ids must be equal. Host prompt “configured” here means `wc3statsHostPromptEnabled && channelId`, not the full import-ready helper — so a stored prompt channel cannot drift from the lobby channel.

- [ ] **Step 1: Write the failing tests**

Create `src/services/league/league-lobby-channel.test.ts`:

```typescript
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { findUnique, update } = vi.hoisted(() => ({
  findUnique: vi.fn(),
  update: vi.fn(),
}));

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    league: { findUnique, update },
  },
}));

import { MatchServiceError } from '../match/match-service.js';
import {
  LOBBY_CHANNEL_CHANNEL_ONLY_WHILE_DISABLED,
  LOBBY_CHANNEL_ENABLE_NEEDS_CHANNEL,
  LOBBY_CHANNEL_HOST_PROMPT_MISMATCH,
  LOBBY_CHANNEL_SET_NEEDS_OPTION,
  assertLeagueLobbyCreateChannel,
  assertLobbyCreateChannel,
  assertLobbyHostPromptChannelsCompatible,
  clearLeagueLobbyChannel,
  formatLobbyChannelConfigLine,
  isLeagueLobbyChannelReady,
  lobbyCreationLimitedMessage,
  setLeagueLobbyChannel,
} from './league-lobby-channel.js';

describe('isLeagueLobbyChannelReady', () => {
  it('is false when disabled or id is missing', () => {
    expect(isLeagueLobbyChannelReady({})).toBe(false);
    expect(isLeagueLobbyChannelReady({ lobbyChannelEnabled: true })).toBe(false);
    expect(
      isLeagueLobbyChannelReady({ lobbyChannelEnabled: false, lobbyChannelId: 'c' }),
    ).toBe(false);
    expect(
      isLeagueLobbyChannelReady({ lobbyChannelEnabled: true, lobbyChannelId: '  ' }),
    ).toBe(false);
  });

  it('is true when enabled with a non-empty id', () => {
    expect(
      isLeagueLobbyChannelReady({ lobbyChannelEnabled: true, lobbyChannelId: 'c1' }),
    ).toBe(true);
  });
});

describe('assertLobbyCreateChannel', () => {
  it('allows any channel when not ready', () => {
    expect(() => assertLobbyCreateChannel({}, 'anywhere')).not.toThrow();
  });

  it('allows the matching channel when ready', () => {
    expect(() =>
      assertLobbyCreateChannel(
        { lobbyChannelEnabled: true, lobbyChannelId: 'lobby' },
        'lobby',
      ),
    ).not.toThrow();
  });

  it('rejects a different channel when ready', () => {
    expect(() =>
      assertLobbyCreateChannel(
        { lobbyChannelEnabled: true, lobbyChannelId: 'lobby' },
        'other',
      ),
    ).toThrow(MatchServiceError);
    expect(() =>
      assertLobbyCreateChannel(
        { lobbyChannelEnabled: true, lobbyChannelId: 'lobby' },
        'other',
      ),
    ).toThrow(lobbyCreationLimitedMessage('lobby'));
  });
});

describe('assertLobbyHostPromptChannelsCompatible', () => {
  it('allows when either side is not configured', () => {
    expect(() =>
      assertLobbyHostPromptChannelsCompatible({
        lobbyEnabled: true,
        lobbyChannelId: 'a',
        hostPromptEnabled: false,
        hostPromptChannelId: 'b',
      }),
    ).not.toThrow();
  });

  it('rejects when both are configured and ids differ', () => {
    expect(() =>
      assertLobbyHostPromptChannelsCompatible({
        lobbyEnabled: true,
        lobbyChannelId: 'lobby',
        hostPromptEnabled: true,
        hostPromptChannelId: 'prompt',
      }),
    ).toThrow(LOBBY_CHANNEL_HOST_PROMPT_MISMATCH);
  });

  it('allows when both are configured and ids match', () => {
    expect(() =>
      assertLobbyHostPromptChannelsCompatible({
        lobbyEnabled: true,
        lobbyChannelId: 'same',
        hostPromptEnabled: true,
        hostPromptChannelId: 'same',
      }),
    ).not.toThrow();
  });
});

describe('formatLobbyChannelConfigLine', () => {
  it('shows off when disabled with no id', () => {
    expect(formatLobbyChannelConfigLine(false, undefined)).toBe(
      '**Lobby channel:** `off`',
    );
  });

  it('shows saved id when disabled', () => {
    expect(formatLobbyChannelConfigLine(false, 'c1')).toBe(
      '**Lobby channel:** `off` · saved <#c1>',
    );
  });

  it('shows on with mention when ready', () => {
    expect(formatLobbyChannelConfigLine(true, 'c1')).toBe(
      '**Lobby channel:** `on` · <#c1>',
    );
  });

  it('does not show on when enabled without an id', () => {
    expect(formatLobbyChannelConfigLine(true, undefined)).toBe(
      '**Lobby channel:** `off`',
    );
  });
});

describe('assertLeagueLobbyCreateChannel', () => {
  beforeEach(() => {
    findUnique.mockReset();
  });

  it('loads the league row and allows when not ready', async () => {
    findUnique.mockResolvedValue({ lobbyChannelEnabled: false, lobbyChannelId: null });
    await expect(assertLeagueLobbyCreateChannel('L1', 'any')).resolves.toBeUndefined();
  });

  it('rejects when ready and the interaction channel differs', async () => {
    findUnique.mockResolvedValue({
      lobbyChannelEnabled: true,
      lobbyChannelId: 'lobby',
    });
    await expect(assertLeagueLobbyCreateChannel('L1', 'other')).rejects.toThrow(
      lobbyCreationLimitedMessage('lobby'),
    );
  });
});

describe('setLeagueLobbyChannel', () => {
  beforeEach(() => {
    findUnique.mockReset();
    update.mockReset();
  });

  it('rejects when neither enabled nor channel is provided', async () => {
    await expect(setLeagueLobbyChannel('L1', {})).rejects.toThrow(
      LOBBY_CHANNEL_SET_NEEDS_OPTION,
    );
  });

  it('rejects enable true when no channel is passed or stored', async () => {
    findUnique.mockResolvedValue({
      lobbyChannelEnabled: false,
      lobbyChannelId: null,
      wc3statsHostPromptEnabled: false,
      wc3statsHostPromptChannelId: null,
    });
    await expect(setLeagueLobbyChannel('L1', { enabled: true })).rejects.toThrow(
      LOBBY_CHANNEL_ENABLE_NEEDS_CHANNEL,
    );
    expect(update).not.toHaveBeenCalled();
  });

  it('enables and stores the channel', async () => {
    findUnique.mockResolvedValue({
      lobbyChannelEnabled: false,
      lobbyChannelId: null,
      wc3statsHostPromptEnabled: false,
      wc3statsHostPromptChannelId: null,
    });
    await setLeagueLobbyChannel('L1', { enabled: true, channelId: 'lobby' });
    expect(update).toHaveBeenCalledWith({
      where: { id: 'L1' },
      data: { lobbyChannelEnabled: true, lobbyChannelId: 'lobby' },
    });
  });

  it('re-enables using the stored channel', async () => {
    findUnique.mockResolvedValue({
      lobbyChannelEnabled: false,
      lobbyChannelId: 'saved',
      wc3statsHostPromptEnabled: false,
      wc3statsHostPromptChannelId: null,
    });
    await setLeagueLobbyChannel('L1', { enabled: true });
    expect(update).toHaveBeenCalledWith({
      where: { id: 'L1' },
      data: { lobbyChannelEnabled: true, lobbyChannelId: 'saved' },
    });
  });

  it('disables and keeps the stored channel', async () => {
    findUnique.mockResolvedValue({
      lobbyChannelEnabled: true,
      lobbyChannelId: 'saved',
      wc3statsHostPromptEnabled: false,
      wc3statsHostPromptChannelId: null,
    });
    await setLeagueLobbyChannel('L1', { enabled: false, channelId: 'ignored' });
    expect(update).toHaveBeenCalledWith({
      where: { id: 'L1' },
      data: { lobbyChannelEnabled: false },
    });
  });

  it('rejects channel-only while disabled', async () => {
    findUnique.mockResolvedValue({
      lobbyChannelEnabled: false,
      lobbyChannelId: 'saved',
      wc3statsHostPromptEnabled: false,
      wc3statsHostPromptChannelId: null,
    });
    await expect(setLeagueLobbyChannel('L1', { channelId: 'new' })).rejects.toThrow(
      LOBBY_CHANNEL_CHANNEL_ONLY_WHILE_DISABLED,
    );
  });

  it('updates the channel when already enabled', async () => {
    findUnique.mockResolvedValue({
      lobbyChannelEnabled: true,
      lobbyChannelId: 'old',
      wc3statsHostPromptEnabled: false,
      wc3statsHostPromptChannelId: null,
    });
    await setLeagueLobbyChannel('L1', { channelId: 'new' });
    expect(update).toHaveBeenCalledWith({
      where: { id: 'L1' },
      data: { lobbyChannelId: 'new' },
    });
  });

  it('rejects enabling on a different channel than a configured host prompt', async () => {
    findUnique.mockResolvedValue({
      lobbyChannelEnabled: false,
      lobbyChannelId: null,
      wc3statsHostPromptEnabled: true,
      wc3statsHostPromptChannelId: 'prompt',
    });
    await expect(
      setLeagueLobbyChannel('L1', { enabled: true, channelId: 'lobby' }),
    ).rejects.toThrow(LOBBY_CHANNEL_HOST_PROMPT_MISMATCH);
    expect(update).not.toHaveBeenCalled();
  });
});

describe('clearLeagueLobbyChannel', () => {
  beforeEach(() => {
    update.mockReset();
  });

  it('disables and nulls the channel', async () => {
    await clearLeagueLobbyChannel('L1');
    expect(update).toHaveBeenCalledWith({
      where: { id: 'L1' },
      data: { lobbyChannelEnabled: false, lobbyChannelId: null },
    });
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL** (module missing)

Run: `npx vitest run src/services/league/league-lobby-channel.test.ts`

Expected: FAIL with cannot find module `./league-lobby-channel.js`

- [ ] **Step 3: Implement `src/services/league/league-lobby-channel.ts`**

```typescript
import { prisma } from '../../lib/prisma.js';
import { MatchServiceError } from '../match/match-service.js';

export const LOBBY_CHANNEL_ENABLE_NEEDS_CHANNEL =
  'Choose a channel when enabling the lobby channel.';
export const LOBBY_CHANNEL_CHANNEL_ONLY_WHILE_DISABLED =
  'Pass enabled:true to turn the lobby channel on.';
export const LOBBY_CHANNEL_HOST_PROMPT_MISMATCH =
  'The wc3stats host prompt channel must match the lobby channel while the lobby channel is enabled.';
export const LOBBY_CHANNEL_SET_NEEDS_OPTION = 'Provide enabled and/or channel.';

/** User-facing copy when /register_lobby or Open lobby is used outside the gated channel. */
export function lobbyCreationLimitedMessage(channelId: string): string {
  return `Lobby creation for this league is limited to <#${channelId}>.`;
}

function trimOptionalId(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** True when the league gate is on and a channel id is stored. */
export function isLeagueLobbyChannelReady(config: {
  lobbyChannelEnabled?: boolean | null;
  lobbyChannelId?: string | null;
}): boolean {
  return config.lobbyChannelEnabled === true && Boolean(trimOptionalId(config.lobbyChannelId));
}

/**
 * Throw if lobby creation is gated to another Discord channel.
 * No-op when the league gate is not ready.
 */
export function assertLobbyCreateChannel(
  config: {
    lobbyChannelEnabled?: boolean | null;
    lobbyChannelId?: string | null;
  },
  channelId: string,
): void {
  if (!isLeagueLobbyChannelReady(config)) {
    return;
  }
  const lobbyChannelId = trimOptionalId(config.lobbyChannelId)!;
  if (channelId !== lobbyChannelId) {
    throw new MatchServiceError(lobbyCreationLimitedMessage(lobbyChannelId));
  }
}

/**
 * Throw if the next lobby-channel state and a configured host-prompt channel would differ.
 */
export function assertLobbyHostPromptChannelsCompatible(input: {
  lobbyEnabled: boolean;
  lobbyChannelId: string | undefined;
  hostPromptEnabled: boolean;
  hostPromptChannelId: string | undefined;
}): void {
  const lobbyReady = input.lobbyEnabled && Boolean(input.lobbyChannelId);
  const promptConfigured = input.hostPromptEnabled && Boolean(input.hostPromptChannelId);
  if (!lobbyReady || !promptConfigured) {
    return;
  }
  if (input.lobbyChannelId !== input.hostPromptChannelId) {
    throw new MatchServiceError(LOBBY_CHANNEL_HOST_PROMPT_MISMATCH);
  }
}

/** Load league lobby-channel fields and assert the interaction channel. */
export async function assertLeagueLobbyCreateChannel(
  leagueId: string,
  channelId: string,
): Promise<void> {
  const row = await prisma.league.findUnique({
    where: { id: leagueId },
    select: { lobbyChannelEnabled: true, lobbyChannelId: true },
  });
  assertLobbyCreateChannel(row ?? {}, channelId);
}

/**
 * Set or toggle the per-league lobby creation channel.
 * `enabled: false` keeps `lobbyChannelId`. Channel-only updates require the gate already on.
 */
export async function setLeagueLobbyChannel(
  leagueId: string,
  input: { enabled?: boolean; channelId?: string },
): Promise<void> {
  if (input.enabled === undefined && input.channelId === undefined) {
    throw new MatchServiceError(LOBBY_CHANNEL_SET_NEEDS_OPTION);
  }

  const row = await prisma.league.findUnique({
    where: { id: leagueId },
    select: {
      lobbyChannelEnabled: true,
      lobbyChannelId: true,
      wc3statsHostPromptEnabled: true,
      wc3statsHostPromptChannelId: true,
    },
  });

  const storedId = trimOptionalId(row?.lobbyChannelId);
  const currentlyEnabled = row?.lobbyChannelEnabled === true;
  const hostPromptEnabled = row?.wc3statsHostPromptEnabled === true;
  const hostPromptChannelId = trimOptionalId(row?.wc3statsHostPromptChannelId);

  if (input.enabled === false) {
    await prisma.league.update({
      where: { id: leagueId },
      data: { lobbyChannelEnabled: false },
    });
    return;
  }

  if (input.enabled === undefined) {
    const nextId = trimOptionalId(input.channelId);
    if (!currentlyEnabled || !storedId || !nextId) {
      throw new MatchServiceError(LOBBY_CHANNEL_CHANNEL_ONLY_WHILE_DISABLED);
    }
    assertLobbyHostPromptChannelsCompatible({
      lobbyEnabled: true,
      lobbyChannelId: nextId,
      hostPromptEnabled,
      hostPromptChannelId,
    });
    await prisma.league.update({
      where: { id: leagueId },
      data: { lobbyChannelId: nextId },
    });
    return;
  }

  const nextId = trimOptionalId(input.channelId) ?? storedId;
  if (!nextId) {
    throw new MatchServiceError(LOBBY_CHANNEL_ENABLE_NEEDS_CHANNEL);
  }
  assertLobbyHostPromptChannelsCompatible({
    lobbyEnabled: true,
    lobbyChannelId: nextId,
    hostPromptEnabled,
    hostPromptChannelId,
  });
  await prisma.league.update({
    where: { id: leagueId },
    data: { lobbyChannelEnabled: true, lobbyChannelId: nextId },
  });
}

/** Disable the gate and forget the stored channel. */
export async function clearLeagueLobbyChannel(leagueId: string): Promise<void> {
  await prisma.league.update({
    where: { id: leagueId },
    data: { lobbyChannelEnabled: false, lobbyChannelId: null },
  });
}

/** `/config view` line. Invalid enabled-without-id is shown as off. */
export function formatLobbyChannelConfigLine(
  enabled: boolean,
  channelId: string | undefined,
): string {
  if (!channelId) {
    return '**Lobby channel:** `off`';
  }
  if (!enabled) {
    return `**Lobby channel:** \`off\` · saved <#${channelId}>`;
  }
  return `**Lobby channel:** \`on\` · <#${channelId}>`;
}
```

- [ ] **Step 4: Re-export from `src/services/league/index.ts`**

Add:

```typescript
export {
  LOBBY_CHANNEL_CHANNEL_ONLY_WHILE_DISABLED,
  LOBBY_CHANNEL_ENABLE_NEEDS_CHANNEL,
  LOBBY_CHANNEL_HOST_PROMPT_MISMATCH,
  LOBBY_CHANNEL_SET_NEEDS_OPTION,
  assertLeagueLobbyCreateChannel,
  clearLeagueLobbyChannel,
  formatLobbyChannelConfigLine,
  isLeagueLobbyChannelReady,
  lobbyCreationLimitedMessage,
  setLeagueLobbyChannel,
} from './league-lobby-channel.js';
```

- [ ] **Step 5: Run tests — expect PASS**

Run: `npx vitest run src/services/league/league-lobby-channel.test.ts`

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/services/league/league-lobby-channel.ts src/services/league/league-lobby-channel.test.ts src/services/league/index.ts
git commit -m "$(cat <<'EOF'
Add league lobby-channel gate service.

EOF
)"
```

---

### Task 3: Host-prompt setter must match lobby channel

**Files:**
- Modify: `src/services/league/league-wc3stats.ts` (`setLeagueWc3statsHostPrompt`)
- Modify: `src/services/league/league-wc3stats.test.ts` (add the host-prompt describe from Task 1)

**Interfaces:**
- Consumes: `assertLobbyHostPromptChannelsCompatible` from `./league-lobby-channel.js`
- Produces: `setLeagueWc3statsHostPrompt` still `{ enabled: true; channelId: string } | { enabled: false }`; enable path loads lobby fields and throws `LOBBY_CHANNEL_HOST_PROMPT_MISMATCH` when lobby is ready and ids differ

- [ ] **Step 1: Add the host-prompt describe to `league-wc3stats.test.ts`** (the full describe from Task 1 Step 4)

Keep the existing resolve describe. Import `setLeagueWc3statsHostPrompt`, `MatchServiceError`, `assertLeagueAllowsWc3stats`, and `LOBBY_CHANNEL_HOST_PROMPT_MISMATCH` as shown in Task 1.

- [ ] **Step 2: Run tests — expect FAIL** on mismatch reject (`update` still called / no throw)

Run: `npx vitest run src/services/league/league-wc3stats.test.ts`

Expected: FAIL on `rejects enabling the host prompt on a different channel`

- [ ] **Step 3: Guard `setLeagueWc3statsHostPrompt`**

At the top of `src/services/league/league-wc3stats.ts` add:

```typescript
import { assertLobbyHostPromptChannelsCompatible } from './league-lobby-channel.js';
```

Replace `setLeagueWc3statsHostPrompt` with:

```typescript
export async function setLeagueWc3statsHostPrompt(
  leagueId: string,
  input: { enabled: true; channelId: string } | { enabled: false },
): Promise<void> {
  if (input.enabled) {
    await assertLeagueAllowsWc3stats(leagueId);
    const row = await prisma.league.findUnique({
      where: { id: leagueId },
      select: { lobbyChannelEnabled: true, lobbyChannelId: true },
    });
    assertLobbyHostPromptChannelsCompatible({
      lobbyEnabled: row?.lobbyChannelEnabled === true,
      lobbyChannelId: row?.lobbyChannelId?.trim() || undefined,
      hostPromptEnabled: true,
      hostPromptChannelId: input.channelId,
    });
  }
  if (!input.enabled) {
    await prisma.league.update({
      where: { id: leagueId },
      data: {
        wc3statsHostPromptEnabled: false,
        wc3statsHostPromptChannelId: null,
      },
    });
    return;
  }

  await prisma.league.update({
    where: { id: leagueId },
    data: {
      wc3statsHostPromptEnabled: true,
      wc3statsHostPromptChannelId: input.channelId,
    },
  });
}
```

Do not change `clearLeagueWc3statsHostPrompt` (it already calls `{ enabled: false }`).

- [ ] **Step 4: Run tests — expect PASS**

Run: `npx vitest run src/services/league/league-wc3stats.test.ts src/services/league/league-lobby-channel.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/league/league-wc3stats.ts src/services/league/league-wc3stats.test.ts
git commit -m "$(cat <<'EOF'
Reject host-prompt channel that disagrees with lobby channel.

EOF
)"
```

---

### Task 4: `/config set|clear lobby_channel` and view

**Files:**
- Modify: `src/commands/config/config.ts`

**Interfaces:**
- Consumes: `setLeagueLobbyChannel`, `clearLeagueLobbyChannel`, `formatLobbyChannelConfigLine` from `../../services/league/index.js` (or `league-lobby-channel.js`); existing `requireLeagueId`, `assertCanConfigureBot`, `ChannelType`
- Produces: slash subcommands `set lobby_channel` and `clear lobby_channel`; view line after player-claim / before rank-reset (keep IHL settings grouped)

- [ ] **Step 1: Import helpers**

The file already imports from `../../services/league/index.js`. Add these symbols to **that** import (do not add a second import path):

```typescript
  clearLeagueLobbyChannel,
  formatLobbyChannelConfigLine,
  LOBBY_CHANNEL_SET_NEEDS_OPTION,
  setLeagueLobbyChannel,
```

- [ ] **Step 2: Add slash subcommands**

Under `/config set`, after `player_claim` and before `rank_reset`:

```typescript
      .addSubcommand((subcommand) =>
        withSubcommandLeagueOption(
          subcommand
            .setName('lobby_channel')
            .setDescription('Require lobby creation in a dedicated channel')
            .addBooleanOption((option) =>
              option
                .setName('enabled')
                .setDescription('On: only create lobbies in the chosen channel')
                .setRequired(false),
            )
            .addChannelOption((option) =>
              option
                .setName('channel')
                .setDescription('Dedicated lobby channel (required when first enabling)')
                .setRequired(false),
            ),
        ),
      )
```

Under `/config clear`, after `leaderboard_size` (or near other league clears), add:

```typescript
      .addSubcommand((subcommand) =>
        withSubcommandLeagueOption(
          subcommand
            .setName('lobby_channel')
            .setDescription('Disable the lobby channel gate and forget the channel'),
        ),
      )
```

- [ ] **Step 3: View line**

In the `view` reply array, after `formatPlayerClaimLine(...)` add:

```typescript
          formatLobbyChannelConfigLine(
            leagueConfig.lobbyChannelEnabled,
            leagueConfig.lobbyChannelId,
          ),
```

- [ ] **Step 4: Set handler**

Inside `if (subcommandGroup === 'set')`, after the `player_claim` block:

```typescript
      if (subcommand === 'lobby_channel') {
        const leagueId = await requireLeagueId(interaction);
        if (!leagueId) return;

        const enabled = interaction.options.getBoolean('enabled');
        const channel = interaction.options.getChannel('channel', false);

        if (enabled === null && !channel) {
          await interaction.reply({
            content: LOBBY_CHANNEL_SET_NEEDS_OPTION,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        if (channel) {
          const allowedTypes = new Set([
            ChannelType.GuildText,
            ChannelType.GuildAnnouncement,
          ]);
          if (!allowedTypes.has(channel.type)) {
            await interaction.reply({
              content: 'Choose a server text channel for lobbies.',
              flags: MessageFlags.Ephemeral,
            });
            return;
          }
        }

        await setLeagueLobbyChannel(leagueId, {
          ...(enabled !== null ? { enabled } : {}),
          ...(channel ? { channelId: channel.id } : {}),
        });

        const updated = await resolveLeagueConfig(leagueId);
        log.info(
          {
            guildId: interaction.guildId,
            leagueId,
            enabled: updated.lobbyChannelEnabled,
            channelId: updated.lobbyChannelId,
            userId: interaction.user.id,
          },
          'Lobby channel setting updated',
        );
        await interaction.reply({
          content: formatLobbyChannelConfigLine(
            updated.lobbyChannelEnabled,
            updated.lobbyChannelId,
          ).replace('**Lobby channel:** ', 'Lobby channel: '),
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
```

Use the same `MatchServiceError` catch already wrapping the `execute` try (do not add a nested try). `setLeagueLobbyChannel` throws `MatchServiceError` for business rules; that outer catch replies ephemeral.

- [ ] **Step 5: Clear handler**

Inside `if (subcommandGroup === 'clear')`:

```typescript
      if (subcommand === 'lobby_channel') {
        const leagueId = await requireLeagueId(interaction);
        if (!leagueId) return;

        await clearLeagueLobbyChannel(leagueId);
        log.info(
          { guildId: interaction.guildId, leagueId, userId: interaction.user.id },
          'Lobby channel cleared',
        );
        await interaction.reply({
          content: 'Lobby channel disabled and channel cleared.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
```

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`

Expected: PASS (no errors in `config.ts`)

- [ ] **Step 7: Commit**

```bash
git add src/commands/config/config.ts
git commit -m "$(cat <<'EOF'
Add /config lobby_channel set, clear, and view.

EOF
)"
```

---

### Task 5: Gate `/register_lobby` and Open lobby

**Files:**
- Modify: `src/commands/lobby/register-lobby.ts`
- Modify: `src/discord/interactions/wc3stats-host-prompt-interactions.ts`

**Interfaces:**
- Consumes: `assertLeagueLobbyCreateChannel(leagueId: string, channelId: string): Promise<void>`
- Produces: both create paths throw/reply `Lobby creation for this league is limited to <#id>.` when the gate is ready and `interaction.channelId` differs. `/lobby` commands unchanged.

- [ ] **Step 1: Guard `/register_lobby` after league id is known, before OCR/import**

In `src/commands/lobby/register-lobby.ts`, add `assertLeagueLobbyCreateChannel` to the existing `../../services/league/index.js` import.

Immediately after `const leagueId = leagueResolved.leagueId;` (and still before `extractLobbyPlayers` / wc3stats import), add:

```typescript
  try {
    await assertLeagueLobbyCreateChannel(leagueId, interaction.channelId);
  } catch (error) {
    if (error instanceof MatchServiceError) {
      await interaction.editReply(error.message);
      return;
    }
    throw error;
  }
```

`deferReply` already ran at the start of `execute`, so `editReply` is correct (not a new ephemeral).

- [ ] **Step 2: Guard Open lobby before `deferUpdate`**

In `src/discord/interactions/wc3stats-host-prompt-interactions.ts`, import:

```typescript
import { assertLeagueLobbyCreateChannel } from '../../services/league/index.js';
```

In `handleOpen`, after the guild/channelId check and **before** `await interaction.deferUpdate()`, add:

```typescript
  try {
    await assertLeagueLobbyCreateChannel(parsed.leagueId, interaction.channelId);
  } catch (error) {
    if (error instanceof MatchServiceError) {
      await replyEphemeral(interaction, error.message);
      return;
    }
    throw error;
  }
```

Do not call this inside `createMatchFromWc3statsLobby` or `createPendingMatch`.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`

Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/commands/lobby/register-lobby.ts src/discord/interactions/wc3stats-host-prompt-interactions.ts
git commit -m "$(cat <<'EOF'
Limit ranked lobby creation to the league lobby channel.

EOF
)"
```

---

### Task 6: Poller skips invalid lobby/prompt channel pairs

**Files:**
- Modify: `src/services/wc3stats/wc3stats-host-prompt-poller.ts`
- Modify: `src/services/wc3stats/wc3stats-host-prompt-poller.test.ts`

**Interfaces:**
- Consumes: `isLeagueLobbyChannelReady` from `../league/league-lobby-channel.js`
- Produces: `listHostPromptReadyLeagues` omits a league when lobby channel is ready **and** `lobbyChannelId !== wc3statsHostPromptChannelId`; logs `error` with `leagueId` and both channel ids

- [ ] **Step 1: Add a failing test**

In `src/services/wc3stats/wc3stats-host-prompt-poller.test.ts`, add to `describe('listHostPromptReadyLeagues')`:

```typescript
  it('skips a league when lobby channel is ready and differs from the host prompt channel', async () => {
    const leagueFindMany = vi.mocked(prisma.league.findMany);
    leagueFindMany.mockResolvedValue([
      {
        id: 'mismatch',
        guildId: 'g1',
        gameId: WARCRAFT3_UDBR_GAME_ID,
        wc3statsHostPromptChannelId: 'prompt-chan',
        wc3statsMapPattern: 'udbr',
        wc3statsMapSha1: null,
        wc3statsEnabled: true,
        wc3statsHostPromptEnabled: true,
        lobbyChannelEnabled: true,
        lobbyChannelId: 'lobby-chan',
      },
      {
        id: 'aligned',
        guildId: 'g1',
        gameId: WARCRAFT3_UDBR_GAME_ID,
        wc3statsHostPromptChannelId: 'same-chan',
        wc3statsMapPattern: 'udbr',
        wc3statsMapSha1: null,
        wc3statsEnabled: true,
        wc3statsHostPromptEnabled: true,
        lobbyChannelEnabled: true,
        lobbyChannelId: 'same-chan',
      },
    ] as never);

    const ready = await listHostPromptReadyLeagues();
    expect(ready.map((league) => league.id)).toEqual(['aligned']);
  });
```

- [ ] **Step 2: Run test — expect FAIL** (`mismatch` still included)

Run: `npx vitest run src/services/wc3stats/wc3stats-host-prompt-poller.test.ts`

Expected: FAIL, received `['mismatch', 'aligned']`

- [ ] **Step 3: Filter in `listHostPromptReadyLeagues`**

Import:

```typescript
import { isLeagueLobbyChannelReady } from '../league/league-lobby-channel.js';
```

Add `lobbyChannelEnabled` and `lobbyChannelId` to the Prisma `select`.

After the existing `isLeagueWc3statsHostPromptReady` continue, and before `ready.push`, add:

```typescript
    if (
      isLeagueLobbyChannelReady({
        lobbyChannelEnabled: row.lobbyChannelEnabled,
        lobbyChannelId: row.lobbyChannelId,
      }) &&
      trimOptional(row.lobbyChannelId) !== config.wc3statsHostPromptChannelId
    ) {
      log.error(
        {
          leagueId: row.id,
          lobbyChannelId: row.lobbyChannelId,
          hostPromptChannelId: config.wc3statsHostPromptChannelId,
        },
        'Skipping host-prompt league: lobby channel and host prompt channel differ',
      );
      continue;
    }
```

Inline trim instead of a new helper if the file has no `trimOptional`: use `row.lobbyChannelId?.trim() || undefined`. Missing `lobbyChannelEnabled` on old mocks must count as not ready (existing tests stay green).

- [ ] **Step 4: Run tests — expect PASS**

Run: `npx vitest run src/services/wc3stats/wc3stats-host-prompt-poller.test.ts`

Expected: PASS (including the two existing gameId tests)

- [ ] **Step 5: Commit**

```bash
git add src/services/wc3stats/wc3stats-host-prompt-poller.ts src/services/wc3stats/wc3stats-host-prompt-poller.test.ts
git commit -m "$(cat <<'EOF'
Skip host prompts when lobby and prompt channels differ.

EOF
)"
```

---

### Task 7: Docs

**Files:**
- Modify: `docs/discord/staff/a1-roles-and-setup.md`
- Modify: `docs/discord/staff/a4-wc3stats-mapping.md`
- Modify: `docs/discord/staff/a5-admin-cheat-sheet.md`
- Modify: `docs/discord/public/03-start-a-lobby.md`
- Modify: `.cursor/rules/database-domain.mdc`
- Modify: `docs/superpowers/specs/2026-08-17-league-lobby-channel-design.md` (status already Approved if the brainstorming pass set it)

Stay under Discord’s 2000-character limit per staff/public file. If a file is already tight, prefer a short bullet over a long paragraph.

- [ ] **Step 1: Staff setup (`a1-roles-and-setup.md`)**

Insert a new numbered section after **3) Player claim** (renumber following sections). Keep it short:

```markdown
**4) Dedicated lobby channel (optional, per league)**
Default is **off** (create in whatever channel you run `/register_lobby`). When on, `/register_lobby` and wc3stats **Open lobby** only work in that channel. `/lobby` commands still work anywhere.
```
/config set lobby_channel enabled:True channel:#lobbies
/config set lobby_channel enabled:False
/config clear lobby_channel
```
If host lobby prompts are also on, they **must** use this same channel. Bind the channel with `/league bind` separately if you want commands there to pick the league automatically.
```

Renumber the old 4/5/6 (leaderboard, rank reset, quitter board) to 5/6/7.

- [ ] **Step 2: Host prompt note (`a4-wc3stats-mapping.md`)**

After the host prompt command block, add:

```markdown
If `/config set lobby_channel` is on for the league, this prompt channel **must be the same channel** (the bot rejects a mismatch). Open lobby then happens in that lobby channel.
```

- [ ] **Step 3: Cheat sheet (`a5-admin-cheat-sheet.md`)**

After `player_claim`, add:

```markdown
• `/config set|clear lobby_channel` — optional per-league create-only channel
```

- [ ] **Step 4: Public lobby guide (`03-start-a-lobby.md`)**

After the `/register_lobby` command block, add:

```markdown
If the server turned on a **lobby channel**, run this command there (the bot will tell you which channel).
```

- [ ] **Step 5: `database-domain.mdc`**

In the League bullet, change “wc3stats, leaderboard channel ids, lobby claim flag” to also name lobby channel fields:

`Holds per-IHL settings (wc3stats, leaderboard channel ids, lobby claim flag, optional lobby creation channel).`

- [ ] **Step 6: Commit**

```bash
git add docs/discord/staff/a1-roles-and-setup.md docs/discord/staff/a4-wc3stats-mapping.md docs/discord/staff/a5-admin-cheat-sheet.md docs/discord/public/03-start-a-lobby.md .cursor/rules/database-domain.mdc docs/superpowers/specs/2026-08-17-league-lobby-channel-design.md docs/superpowers/plans/2026-08-17-league-lobby-channel.md
git commit -m "$(cat <<'EOF'
Document the per-league lobby channel gate.

EOF
)"
```

---

## Verification

```bash
npx prisma generate
npx vitest run src/services/league/league-lobby-channel.test.ts src/services/league/league-wc3stats.test.ts src/services/wc3stats/wc3stats-host-prompt-poller.test.ts
npx tsc --noEmit
```

Manual Discord check (dev guild):

1. `/config view` — lobby channel `off`
2. `/config set lobby_channel enabled:True` with no channel — error to choose a channel
3. `/config set lobby_channel enabled:True channel:#lobbies` — view shows `on · #lobbies`
4. `/register_lobby` in another channel — limited-to-#lobbies message
5. `/register_lobby` in `#lobbies` — card posts as today
6. `/lobby add` from a third channel — still works
7. Enable host prompt on a different channel — mismatch error
8. Enable host prompt on `#lobbies` — Open lobby works there; Open lobby leftover in another channel is denied
9. `/config set lobby_channel enabled:False` — create works anywhere; view shows `off · saved #lobbies`
10. `/config clear lobby_channel` — view `off`, no saved id

## Spec coverage

| Spec item | Task |
|-----------|------|
| League columns + default off | 1 |
| Ready = enabled + id | 2 |
| set/clear semantics (keep id on disable) | 2, 4 |
| Host-prompt mismatch on both setters | 2, 3, 4 |
| `/config view` lines | 2, 4 |
| Assert on `/register_lobby` and Open lobby only | 5 |
| Assert not in `createPendingMatch` / `/lobby` | 5 (omission) |
| Poller skip + error log | 6 |
| English copy | 2, 4, 5 |
| Staff/public docs | 7 |
| No env/SSM | all (omission) |
| No auto-bind | 7 (docs say bind separately) |
