# Pending lobby Cancel button Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hosts and match mods can cancel a pending lobby from a public **Cancel** button with an ephemeral Confirm / Keep step, using the same `cancelLobbyMatch` path as `/lobby cancel`.

**Architecture:** Add `lobby:cancel` on its own last row of unlocked pending cards. `lobby-interactions` auths with `assertCanManageMatch`, shows a private confirm, then calls existing `cancelLobbyMatch({ matchId })`. Confirm/Keep custom ids carry `matchId` because those clicks are on the ephemeral, not the lobby card. Do not touch `match:cancel`.

**Tech Stack:** TypeScript ESM, discord.js v14, Vitest

**Spec:** `docs/superpowers/specs/2026-08-19-lobby-cancel-button-design.md`

**Scope:** `general`

## Global Constraints

- Scope: `general` (pending lobby cancel; same for every game/league)
- English-only user-facing strings and errors
- ESM imports use the `.js` extension; named exports only
- Buttons and `/lobby cancel` share `cancelLobbyMatch` — do not fork cancel logic
- Host, match-mod role, or universal match mod (`assertCanManageMatch`)
- Custom ids: `lobby:cancel`, `lobby:cancel:ok:{matchId}`, `lobby:cancel:no:{matchId}`
- Do not change in-progress `match:cancel` or its quitter-penalty copy
- Do not remove `/lobby cancel`
- No Prisma, env, or AWS SSM changes
- Confirm copy must not mention quitter penalties
- Keep does not resolve PENDING and does not call `cancelLobbyMatch`

## File map

| File                                                              | Role                                                                              |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `src/services/lobby/lobby-preview.ts`                             | `LOBBY_CUSTOM_IDS.cancel`; last-row Cancel on unlocked pending cards              |
| `src/services/lobby/lobby-preview.test.ts`                        | Button placement tests; stop using `rows.at(-1)` as the roster row                |
| `src/discord/interactions/lobby-interactions.ts`                  | Entry auth + ephemeral confirm; Confirm calls `cancelLobbyMatch`; Keep is a no-op |
| `src/discord/interactions/lobby-interactions.test.ts`             | Host/mod confirm; outsider refused; Confirm/Keep behavior                         |
| `docs/discord/public/04-fix-the-lobby.md`                         | List Cancel with host tools                                                       |
| `docs/superpowers/specs/2026-08-19-lobby-cancel-button-design.md` | Point at this plan                                                                |

---

### Task 1: Public Cancel button (TDD)

**Files:**

- Modify: `src/services/lobby/lobby-preview.ts`
- Modify: `src/services/lobby/lobby-preview.test.ts`

**Interfaces:**

- Consumes: existing `buildLobbyButtons` options (`canStart`, `locked`, `playerCount`, `playerClaimEnabled`, `wc3statsGameId`, `wc3statsEnabled`, `profile`)
- Produces: `LOBBY_CUSTOM_IDS.cancel` is `'lobby:cancel'`. Unlocked pending cards end with a one-button Cancel row. Locked cards stay `[]`.

- [ ] **Step 1: Point roster tests at the roster row and add failing Cancel tests**

In `src/services/lobby/lobby-preview.test.ts`, inside `describe('buildLobbyButtons')`, add helpers and replace every `rows.at(-1)` roster assertion. Then add the new tests.

Replace the start of `describe('buildLobbyButtons'` so helpers exist first:

```typescript
describe('buildLobbyButtons', () => {
  function rowCustomIds(
    row: ReturnType<typeof buildLobbyButtons>[number] | undefined,
  ): Array<string | undefined> {
    return row?.toJSON().components.map((button) => button.custom_id) ?? [];
  }

  function rosterCustomIds(rows: ReturnType<typeof buildLobbyButtons>): Array<string | undefined> {
    const roster = rows.find((row) => rowCustomIds(row).includes(LOBBY_CUSTOM_IDS.editNick));
    return rowCustomIds(roster);
  }

  it('labels roster controls with text so they are readable', () => {
    const rows = buildLobbyButtons({
      playerCount: 2,
      playerClaimEnabled: false,
    });
    const roster = rows
      .find((row) => rowCustomIds(row).includes(LOBBY_CUSTOM_IDS.editNick))
      ?.toJSON().components as Array<{ custom_id?: string; label?: string }>;
    const labels = Object.fromEntries(
      (roster ?? []).map((button) => [button.custom_id, button.label]),
    );

    expect(labels[LOBBY_CUSTOM_IDS.editNick]).toBe('Edit');
    expect(labels[LOBBY_CUSTOM_IDS.move]).toBe('Move');
    expect(labels[LOBBY_CUSTOM_IDS.remove]).toBe('Remove');
    expect(labels[LOBBY_CUSTOM_IDS.add]).toBe('Add');
  });

  it('includes Add when the lobby is not full', () => {
    const rows = buildLobbyButtons({
      canStart: true,
      playerCount: 11,
      playerClaimEnabled: false,
    });

    expect(rosterCustomIds(rows)).toContain(LOBBY_CUSTOM_IDS.add);
  });

  it('omits Add when all 12 slots are filled', () => {
    const rows = buildLobbyButtons({
      canStart: true,
      playerCount: 12,
      playerClaimEnabled: false,
    });

    expect(rosterCustomIds(rows)).not.toContain(LOBBY_CUSTOM_IDS.add);
    expect(rosterCustomIds(rows)).toEqual([
      LOBBY_CUSTOM_IDS.editNick,
      LOBBY_CUSTOM_IDS.move,
      LOBBY_CUSTOM_IDS.remove,
    ]);
  });
```

Keep the Claim / Refresh tests that already use `flatMap` or `rows[0]`. Change the ACA “omits Add” test from `rows.at(-1)` to `rosterCustomIds(rows)`.

Add these tests at the end of `describe('buildLobbyButtons')`, before the closing `});`:

```typescript
it('puts Cancel on its own last row', () => {
  const rows = buildLobbyButtons({
    canStart: true,
    playerCount: 2,
    playerClaimEnabled: false,
  });

  expect(rowCustomIds(rows.at(-1))).toEqual([LOBBY_CUSTOM_IDS.cancel]);
  expect(rows.at(-1)?.toJSON().components[0]).toMatchObject({
    custom_id: LOBBY_CUSTOM_IDS.cancel,
    label: 'Cancel',
    style: 2,
  });
});

it('shows Cancel when Start is hidden', () => {
  const rows = buildLobbyButtons({
    playerCount: 0,
    playerClaimEnabled: false,
  });
  const ids = rows.flatMap((row) => rowCustomIds(row));

  expect(ids).toContain(LOBBY_CUSTOM_IDS.cancel);
  expect(ids).not.toContain(LOBBY_CUSTOM_IDS.start);
  expect(rowCustomIds(rows.at(-1))).toEqual([LOBBY_CUSTOM_IDS.cancel]);
});

it('does not put Cancel on the Start / Refresh row', () => {
  const rows = buildLobbyButtons({
    canStart: true,
    playerCount: 2,
    playerClaimEnabled: false,
    wc3statsGameId: '42',
  });

  expect(rowCustomIds(rows[0])).toEqual([LOBBY_CUSTOM_IDS.start, LOBBY_CUSTOM_IDS.refresh]);
  expect(rowCustomIds(rows.at(-1))).toEqual([LOBBY_CUSTOM_IDS.cancel]);
});

it('omits Cancel when the card is locked', () => {
  const rows = buildLobbyButtons({ locked: true, canStart: true, playerCount: 2 });

  expect(rows).toEqual([]);
});
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `npx vitest run src/services/lobby/lobby-preview.test.ts`

Expected: FAIL — `LOBBY_CUSTOM_IDS.cancel` is undefined and last row is roster/claim, not Cancel.

- [ ] **Step 3: Add the custom id and last-row button**

In `src/services/lobby/lobby-preview.ts`, add `cancel: 'lobby:cancel'` to `LOBBY_CUSTOM_IDS` (keep `cancelInProgress: 'match:cancel'`):

```typescript
export const LOBBY_CUSTOM_IDS = {
  start: 'lobby:start',
  editNick: 'lobby:edit_nick',
  move: 'lobby:move',
  remove: 'lobby:remove',
  add: 'lobby:add',
  claim: 'lobby:claim',
  leave: 'lobby:leave',
  refresh: 'lobby:refresh',
  cancel: 'lobby:cancel',
  reportWinner: 'match:report',
  quitters: 'match:quitters',
  cancelInProgress: 'match:cancel',
} as const;
```

At the end of `buildLobbyButtons`, before `return rows`, append the Cancel row (still skipped when `locked` because that path returns `[]` first):

```typescript
rows.push(
  new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(LOBBY_CUSTOM_IDS.cancel)
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Secondary),
  ),
);

return rows;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/services/lobby/lobby-preview.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/lobby/lobby-preview.ts src/services/lobby/lobby-preview.test.ts
git commit -m "$(cat <<'EOF'
feat(lobby): add cancel button on pending lobby cards

EOF
)"
```

---

### Task 2: Confirm flow in lobby-interactions (TDD)

**Files:**

- Create: `src/discord/interactions/lobby-interactions.test.ts`
- Modify: `src/discord/interactions/lobby-interactions.ts`

**Interfaces:**

- Consumes: `resolvePendingMatchByMessageId`, `assertCanManageMatch`, `cancelLobbyMatch`, `replyEphemeral` / `updateEphemeral`, `memberRoleIds`, `resolveGuildConfig`
- Produces: public `lobby:cancel` → ephemeral confirm; `lobby:cancel:ok:{matchId}` → `cancelLobbyMatch`; `lobby:cancel:no:{matchId}` → “was not cancelled” without calling cancel

- [ ] **Step 1: Write the failing interaction tests**

Create `src/discord/interactions/lobby-interactions.test.ts`:

```typescript
import type { Interaction } from 'discord.js';
import { ButtonStyle, MessageFlags } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MatchServiceError } from '../../services/match/index.js';
import { clearEphemeralSessionsForTests } from '../../lib/ephemeral-session.js';

const {
  resolvePendingMatchByMessageId,
  cancelLobbyMatch,
  resolveGuildConfig,
  assertCanManageMatch,
} = vi.hoisted(() => ({
  resolvePendingMatchByMessageId: vi.fn(),
  cancelLobbyMatch: vi.fn(),
  resolveGuildConfig: vi.fn(),
  assertCanManageMatch: vi.fn(),
}));

vi.mock('../../services/lobby/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/lobby/index.js')>();
  return {
    ...actual,
    resolvePendingMatchByMessageId,
    cancelLobbyMatch,
  };
});

vi.mock('../../services/guild/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/guild/index.js')>();
  return {
    ...actual,
    resolveGuildConfig,
  };
});

vi.mock('../../services/match/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/match/index.js')>();
  return {
    ...actual,
    assertCanManageMatch,
  };
});

import { handleLobbyInteraction } from './lobby-interactions.js';

const FORBIDDEN = 'Only the match host or a match moderator can do that.';
const PENDING = {
  match: { id: 'match-1', hostDiscordId: 'host-1', status: 'PENDING' },
  players: [],
};

function buttonInteraction(customId: string, overrides: Record<string, unknown> = {}): Interaction {
  return {
    isButton: () => true,
    isStringSelectMenu: () => false,
    isModalSubmit: () => false,
    customId,
    user: { id: 'host-1' },
    guildId: 'guild-1',
    channelId: 'channel-1',
    applicationId: 'app-1',
    token: 'token-1',
    member: { roles: [] },
    message: { id: 'msg-1' },
    client: {},
    replied: false,
    deferred: false,
    reply: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue({ id: 'ephemeral-1' }),
    editReply: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as Interaction;
}

describe('handleLobbyInteraction pending cancel', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    clearEphemeralSessionsForTests();
    resolvePendingMatchByMessageId.mockResolvedValue(PENDING);
    resolveGuildConfig.mockResolvedValue({ matchModRoleId: 'mod-role' });
    assertCanManageMatch.mockImplementation(() => undefined);
    cancelLobbyMatch.mockResolvedValue({ match: PENDING.match, players: [] });
  });

  it('shows confirm to the host and does not cancel yet', async () => {
    const interaction = buttonInteraction('lobby:cancel');

    await expect(handleLobbyInteraction(interaction)).resolves.toBe(true);

    expect(resolvePendingMatchByMessageId).toHaveBeenCalledWith({ messageId: 'msg-1' });
    expect(assertCanManageMatch).toHaveBeenCalledWith({
      hostDiscordId: 'host-1',
      actorDiscordId: 'host-1',
      memberRoleIds: [],
      matchModRoleId: 'mod-role',
    });
    expect(cancelLobbyMatch).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledOnce();
    const payload = vi.mocked(interaction.reply).mock.calls[0]![0] as {
      content: string;
      flags: number;
      components: Array<{
        toJSON: () => { components: Array<{ custom_id: string; label: string; style: number }> };
      }>;
    };
    expect(payload.content).toBe('Cancel lobby `match-1`?');
    expect(payload.flags).toBe(MessageFlags.Ephemeral);
    expect(payload.components[0]?.toJSON().components).toEqual([
      expect.objectContaining({
        custom_id: 'lobby:cancel:ok:match-1',
        label: 'Cancel Lobby',
        style: ButtonStyle.Danger,
      }),
      expect.objectContaining({
        custom_id: 'lobby:cancel:no:match-1',
        label: 'Keep Lobby',
        style: ButtonStyle.Secondary,
      }),
    ]);
  });

  it('refuses an outsider and does not cancel', async () => {
    assertCanManageMatch.mockImplementation(() => {
      throw new MatchServiceError(FORBIDDEN);
    });
    const interaction = buttonInteraction('lobby:cancel', { user: { id: 'player-1' } });

    await expect(handleLobbyInteraction(interaction)).resolves.toBe(true);

    expect(cancelLobbyMatch).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith({
      content: FORBIDDEN,
      flags: MessageFlags.Ephemeral,
      components: [],
    });
  });

  it('confirms with matchId from the custom id', async () => {
    const interaction = buttonInteraction('lobby:cancel:ok:match-1', {
      message: { id: 'ephemeral-not-lobby' },
    });

    await expect(handleLobbyInteraction(interaction)).resolves.toBe(true);

    expect(resolvePendingMatchByMessageId).not.toHaveBeenCalled();
    expect(cancelLobbyMatch).toHaveBeenCalledWith({
      client: interaction.client,
      actorDiscordId: 'host-1',
      matchId: 'match-1',
      memberRoleIds: [],
      matchModRoleId: 'mod-role',
    });
    expect(interaction.update).toHaveBeenCalledWith({
      content: 'Match `match-1` cancelled.',
      components: [],
    });
  });

  it('keeps the lobby without calling cancel', async () => {
    const interaction = buttonInteraction('lobby:cancel:no:match-1', {
      message: { id: 'ephemeral-not-lobby' },
    });

    await expect(handleLobbyInteraction(interaction)).resolves.toBe(true);

    expect(cancelLobbyMatch).not.toHaveBeenCalled();
    expect(resolvePendingMatchByMessageId).not.toHaveBeenCalled();
    expect(interaction.update).toHaveBeenCalledWith({
      content: 'Match `match-1` was not cancelled.',
      components: [],
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/discord/interactions/lobby-interactions.test.ts`

Expected: FAIL — Cancel is unhandled (no confirm reply / `cancelLobbyMatch` not wired).

- [ ] **Step 3: Implement handlers**

In `src/discord/interactions/lobby-interactions.ts`:

1. Add `cancelLobbyMatch` to the existing `../../services/lobby/index.js` import that already has `resolvePendingMatchByMessageId` / `startLobbyMatchByMessageId`.

2. Change the match import to:

```typescript
import { assertCanManageMatch, MatchServiceError } from '../../services/match/index.js';
```

3. Add helpers after `updateEphemeral`:

```typescript
function buildLobbyCancelConfirmRow(matchId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`lobby:cancel:ok:${matchId}`)
      .setLabel('Cancel Lobby')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`lobby:cancel:no:${matchId}`)
      .setLabel('Keep Lobby')
      .setStyle(ButtonStyle.Secondary),
  );
}

async function handleCancelEntry(interaction: ButtonInteraction): Promise<void> {
  const result = await requirePendingMatch(interaction.message.id);

  if ('error' in result) {
    await replyEphemeral(interaction, result.error);
    return;
  }

  if (!interaction.guildId) {
    await replyEphemeral(interaction, 'This action can only be used in a server.');
    return;
  }

  try {
    const config = await resolveGuildConfig(interaction.guildId);
    assertCanManageMatch({
      hostDiscordId: result.match.hostDiscordId,
      actorDiscordId: interaction.user.id,
      memberRoleIds: memberRoleIds(interaction),
      matchModRoleId: config.matchModRoleId,
    });
  } catch (error) {
    if (error instanceof MatchServiceError) {
      await replyEphemeral(interaction, error.message);
      return;
    }
    throw error;
  }

  await replyEphemeral(interaction, `Cancel lobby \`${result.match.id}\`?`, [
    buildLobbyCancelConfirmRow(result.match.id),
  ]);
}

async function handleCancelConfirm(interaction: ButtonInteraction, matchId: string): Promise<void> {
  if (!interaction.guildId) {
    await updateEphemeral(interaction, 'This action can only be used in a server.');
    return;
  }

  try {
    const config = await resolveGuildConfig(interaction.guildId);
    const cancelled = await cancelLobbyMatch({
      client: interaction.client,
      actorDiscordId: interaction.user.id,
      matchId,
      memberRoleIds: memberRoleIds(interaction),
      matchModRoleId: config.matchModRoleId,
    });
    await updateEphemeral(interaction, `Match \`${cancelled.match.id}\` cancelled.`);
  } catch (error) {
    if (error instanceof MatchServiceError) {
      await updateEphemeral(interaction, error.message);
      return;
    }
    throw error;
  }
}

async function handleCancelKeep(interaction: ButtonInteraction, matchId: string): Promise<void> {
  await updateEphemeral(interaction, `Match \`${matchId}\` was not cancelled.`);
}
```

4. In `handleButton`, after the `refresh` branch and before the unhandled warn:

```typescript
if (customId === LOBBY_CUSTOM_IDS.cancel) {
  await handleCancelEntry(interaction);
  return;
}

const parts = parseCustomId(customId);
if (parts[1] === 'cancel' && parts[2] === 'ok' && parts[3]) {
  await handleCancelConfirm(interaction, parts[3]);
  return;
}

if (parts[1] === 'cancel' && parts[2] === 'no' && parts[3]) {
  await handleCancelKeep(interaction, parts[3]);
  return;
}
```

Do not resolve Confirm/Keep by `interaction.message.id`. Do not call `cancelLobbyMatch` on Keep.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/discord/interactions/lobby-interactions.test.ts src/services/lobby/lobby-preview.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/discord/interactions/lobby-interactions.ts src/discord/interactions/lobby-interactions.test.ts
git commit -m "$(cat <<'EOF'
feat(lobby): confirm pending cancel from the lobby button

EOF
)"
```

---

### Task 3: Player docs

**Files:**

- Modify: `docs/discord/public/04-fix-the-lobby.md`
- Modify: `docs/superpowers/specs/2026-08-19-lobby-cancel-button-design.md`

**Interfaces:**

- Consumes: host-tools list in `04-fix-the-lobby.md`
- Produces: Cancel listed as a host button; spec points at this plan

- [ ] **Step 1: Document the button**

In `docs/discord/public/04-fix-the-lobby.md`, add this bullet under **Host tools** (after Start Match):

```markdown
• **Cancel** — close a pending lobby (host or match moderator; asks for confirm)
```

In the spec header, add:

```markdown
**Plan:** `docs/superpowers/plans/2026-08-19-lobby-cancel-button.md`
```

- [ ] **Step 2: Commit**

```bash
git add docs/discord/public/04-fix-the-lobby.md docs/superpowers/specs/2026-08-19-lobby-cancel-button-design.md
git commit -m "$(cat <<'EOF'
docs: document pending lobby cancel button

EOF
)"
```

---

## Manual verification (after tasks)

1. Host: Cancel → Keep → public card still pending.
2. Host: Cancel → Confirm → cancelled embed, buttons gone.
3. Seated player (not host): Cancel → error, lobby unchanged.
4. Match mod: Confirm → cancelled (`by a moderator`).
5. `/lobby cancel` still works.
