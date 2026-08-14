# Ephemeral Replace on Public Buttons Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a user opens a new private (ephemeral) UI from a public lobby/match button, delete their previous ephemeral in that channel (best-effort), then send the new one.

**Architecture:** In-memory session map keyed by `userId:channelId` stores `{ applicationId, token, messageId }`. A shared send helper deletes the previous entry via `InteractionWebhook.deleteMessage`, then replies/followUps and remembers the new message. Wizard steps keep using `interaction.update` / `editReply` (refresh session token only).

**Tech Stack:** TypeScript ESM, discord.js v14 (`InteractionWebhook`), Vitest

**Spec:** `docs/superpowers/specs/2026-08-15-ephemeral-replace-design.md`

## Global Constraints

- English-only user-facing strings (no new user copy required for this feature)
- In-memory only — no Prisma, env, SSM, or Terraform
- Delete failures are swallowed; always still send the new ephemeral
- Do not change public lobby/match embeds or button layouts
- Do not rework unrelated slash ephemerals (`/config`, `/link`, etc.) in this plan
- ESM imports use `.js` extension; named exports only
- Wizard in-place updates must not create a second ephemeral

## File map

| File | Role |
|------|------|
| `src/lib/ephemeral-session.ts` | **Create** — map + remember / take / deletePrevious |
| `src/lib/ephemeral-session.test.ts` | **Create** — unit tests for map + empty delete |
| `src/lib/ephemeral-reply.ts` | **Create** — shared `sendReplacingEphemeral` + optional `touchEphemeralSession` |
| `src/handlers/match-interactions.ts` | Route `replyEphemeral` / `updateEphemeral` through helpers |
| `src/handlers/lobby-interactions.ts` | Same; replace direct `reply`/`followUp` entry points |

---

### Task 1: Ephemeral session store + tests

**Files:**
- Create: `src/lib/ephemeral-session.ts`
- Create: `src/lib/ephemeral-session.test.ts`

**Interfaces:**
- Produces:
  - `export type EphemeralRef = { applicationId: string; token: string; messageId: string }`
  - `export function ephemeralSessionKey(userId: string, channelId: string): string`
  - `export function rememberEphemeral(userId: string, channelId: string, ref: EphemeralRef): void`
  - `export function takePreviousEphemeral(userId: string, channelId: string): EphemeralRef | null`
  - `export async function deletePreviousEphemeral(client: Client, userId: string, channelId: string): Promise<void>`
  - `export function clearEphemeralSessionsForTests(): void` — test-only reset

- [ ] **Step 1: Write the failing test**

Create `src/lib/ephemeral-session.test.ts`:

```typescript
import { describe, expect, it, beforeEach } from 'vitest';
import {
  clearEphemeralSessionsForTests,
  ephemeralSessionKey,
  rememberEphemeral,
  takePreviousEphemeral,
  deletePreviousEphemeral,
} from './ephemeral-session.js';

describe('ephemeral-session', () => {
  beforeEach(() => {
    clearEphemeralSessionsForTests();
  });

  it('builds a stable user+channel key', () => {
    expect(ephemeralSessionKey('u1', 'c1')).toBe('u1:c1');
  });

  it('remember then takePrevious returns and clears', () => {
    rememberEphemeral('u1', 'c1', {
      applicationId: 'app',
      token: 'tok',
      messageId: 'm1',
    });

    expect(takePreviousEphemeral('u1', 'c1')).toEqual({
      applicationId: 'app',
      token: 'tok',
      messageId: 'm1',
    });
    expect(takePreviousEphemeral('u1', 'c1')).toBeNull();
  });

  it('isolates sessions by user and channel', () => {
    rememberEphemeral('u1', 'c1', {
      applicationId: 'app',
      token: 'a',
      messageId: '1',
    });
    rememberEphemeral('u2', 'c1', {
      applicationId: 'app',
      token: 'b',
      messageId: '2',
    });
    rememberEphemeral('u1', 'c2', {
      applicationId: 'app',
      token: 'c',
      messageId: '3',
    });

    expect(takePreviousEphemeral('u1', 'c1')?.messageId).toBe('1');
    expect(takePreviousEphemeral('u2', 'c1')?.messageId).toBe('2');
    expect(takePreviousEphemeral('u1', 'c2')?.messageId).toBe('3');
  });

  it('deletePreviousEphemeral no-ops when empty', async () => {
    await expect(
      deletePreviousEphemeral({} as never, 'u1', 'c1'),
    ).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/lib/ephemeral-session.test.ts`

Expected: FAIL (cannot resolve `./ephemeral-session.js`)

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/ephemeral-session.ts`:

```typescript
import { InteractionWebhook, type Client } from 'discord.js';

export type EphemeralRef = {
  applicationId: string;
  token: string;
  messageId: string;
};

const sessions = new Map<string, EphemeralRef>();

/** Session key: one active private UI per user per channel. */
export function ephemeralSessionKey(userId: string, channelId: string): string {
  return `${userId}:${channelId}`;
}

/** Store the latest ephemeral reply for this user in this channel. */
export function rememberEphemeral(
  userId: string,
  channelId: string,
  ref: EphemeralRef,
): void {
  sessions.set(ephemeralSessionKey(userId, channelId), ref);
}

/** Take and remove the previous ephemeral ref, if any. */
export function takePreviousEphemeral(
  userId: string,
  channelId: string,
): EphemeralRef | null {
  const key = ephemeralSessionKey(userId, channelId);
  const prev = sessions.get(key) ?? null;
  if (prev) {
    sessions.delete(key);
  }
  return prev;
}

/**
 * Best-effort delete of the user's previous ephemeral in this channel.
 * Ignores missing sessions and Discord errors (expired token, unknown message).
 */
export async function deletePreviousEphemeral(
  client: Client,
  userId: string,
  channelId: string,
): Promise<void> {
  const prev = takePreviousEphemeral(userId, channelId);
  if (!prev) {
    return;
  }

  try {
    const webhook = new InteractionWebhook(client, prev.applicationId, prev.token);
    await webhook.deleteMessage(prev.messageId);
  } catch {
    // Token expired, bot restarted mid-session, or message already gone.
  }
}

/** Clears all sessions — for unit tests only. */
export function clearEphemeralSessionsForTests(): void {
  sessions.clear();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/lib/ephemeral-session.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/ephemeral-session.ts src/lib/ephemeral-session.test.ts
git commit -m "$(cat <<'EOF'
feat: add in-memory ephemeral session store for private UI replace

EOF
)"
```

---

### Task 2: Shared `sendReplacingEphemeral` helper

**Files:**
- Create: `src/lib/ephemeral-reply.ts`

**Interfaces:**
- Consumes: `deletePreviousEphemeral`, `rememberEphemeral` from `./ephemeral-session.js`
- Produces:
  - `sendReplacingEphemeral(interaction, { content, components? }): Promise<void>`
  - `touchEphemeralSession(interaction): void` — refresh stored token/message after in-place update

- [ ] **Step 1: Implement helper**

Create `src/lib/ephemeral-reply.ts`:

```typescript
import {
  MessageFlags,
  type ActionRowBuilder,
  type ButtonBuilder,
  type MessageComponentInteraction,
  type ModalSubmitInteraction,
  type StringSelectMenuBuilder,
} from 'discord.js';
import { deletePreviousEphemeral, rememberEphemeral } from './ephemeral-session.js';

type ComponentRow =
  | ActionRowBuilder<ButtonBuilder>
  | ActionRowBuilder<StringSelectMenuBuilder>;

type EphemeralPayload = {
  content: string;
  components?: ComponentRow[];
};

/**
 * Modal deferReply → edit the same ephemeral (no stack).
 * Otherwise delete previous private UI for this user+channel, then reply/followUp and remember.
 */
export async function sendReplacingEphemeral(
  interaction: MessageComponentInteraction | ModalSubmitInteraction,
  payload: EphemeralPayload,
): Promise<void> {
  const components = payload.components ?? [];
  const channelId = interaction.channelId;

  if (interaction.deferred || interaction.replied) {
    if (interaction.isModalSubmit()) {
      await interaction.editReply({
        content: payload.content,
        components,
      });
      if (channelId) {
        rememberEphemeral(interaction.user.id, channelId, {
          applicationId: interaction.applicationId,
          token: interaction.token,
          messageId: '@original',
        });
      }
      return;
    }

    if (channelId) {
      await deletePreviousEphemeral(
        interaction.client,
        interaction.user.id,
        channelId,
      );
    }

    const message = await interaction.followUp({
      content: payload.content,
      components,
      flags: MessageFlags.Ephemeral,
    });

    if (channelId) {
      rememberEphemeral(interaction.user.id, channelId, {
        applicationId: interaction.applicationId,
        token: interaction.token,
        messageId: message.id,
      });
    }
    return;
  }

  if (channelId) {
    await deletePreviousEphemeral(
      interaction.client,
      interaction.user.id,
      channelId,
    );
  }

  await interaction.reply({
    content: payload.content,
    components,
    flags: MessageFlags.Ephemeral,
  });

  if (channelId) {
    rememberEphemeral(interaction.user.id, channelId, {
      applicationId: interaction.applicationId,
      token: interaction.token,
      messageId: '@original',
    });
  }
}

/**
 * After interaction.update / editReply on an existing ephemeral wizard step,
 * refresh the stored token so a later replace can still delete this message.
 */
export function touchEphemeralSession(
  interaction: MessageComponentInteraction,
): void {
  const channelId = interaction.channelId;
  if (!channelId) {
    return;
  }

  rememberEphemeral(interaction.user.id, channelId, {
    applicationId: interaction.applicationId,
    token: interaction.token,
    messageId: interaction.message.id,
  });
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`

Expected: PASS (or only pre-existing errors unrelated to this file)

- [ ] **Step 3: Commit**

```bash
git add src/lib/ephemeral-reply.ts
git commit -m "$(cat <<'EOF'
feat: add sendReplacingEphemeral helper for private UI replace

EOF
)"
```

---

### Task 3: Wire match interactions

**Files:**
- Modify: `src/handlers/match-interactions.ts` (`replyEphemeral`, `updateEphemeral`)

**Interfaces:**
- Consumes: `sendReplacingEphemeral`, `touchEphemeralSession` from `../lib/ephemeral-reply.js`

- [ ] **Step 1: Replace local helpers**

In `src/handlers/match-interactions.ts`:

1. Add import:

```typescript
import {
  sendReplacingEphemeral,
  touchEphemeralSession,
} from '../lib/ephemeral-reply.js';
```

2. Replace `replyEphemeral` body with:

```typescript
async function replyEphemeral(
  interaction: MessageComponentInteraction,
  content: string,
  components: ComponentRow[] = [],
): Promise<void> {
  await sendReplacingEphemeral(interaction, { content, components });
}
```

3. Update `updateEphemeral` so after a successful update/edit it touches the session:

```typescript
async function updateEphemeral(
  interaction: MessageComponentInteraction,
  content: string,
  components: ComponentRow[] = [],
): Promise<void> {
  if (interaction.deferred || interaction.replied) {
    await interaction.editReply({ content, components });
    touchEphemeralSession(interaction);
    return;
  }

  await interaction.update({ content, components });
  touchEphemeralSession(interaction);
}
```

Do **not** change wizard handlers that already call `updateEphemeral` / `replyEphemeral` — entry points (`handleReportEntry`, `handleQuittersEntry`, `handleCancelEntry`) already go through `replyEphemeral`.

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`

Expected: PASS for these changes

- [ ] **Step 3: Commit**

```bash
git add src/handlers/match-interactions.ts
git commit -m "$(cat <<'EOF'
feat: replace prior match ephemeral when opening report UI

EOF
)"
```

---

### Task 4: Wire lobby interactions

**Files:**
- Modify: `src/handlers/lobby-interactions.ts` (`replyEphemeral`, `updateEphemeral`, direct `reply`/`followUp` entry points)

**Interfaces:**
- Consumes: `sendReplacingEphemeral`, `touchEphemeralSession` from `../lib/ephemeral-reply.js`

- [ ] **Step 1: Point helpers at shared send/touch**

Add the same imports as Task 3.

Replace `replyEphemeral` so it accepts optional components and delegates:

```typescript
async function replyEphemeral(
  interaction: MessageComponentInteraction | ModalSubmitInteraction,
  content: string,
  components: (
    | ActionRowBuilder<ButtonBuilder>
    | ActionRowBuilder<StringSelectMenuBuilder>
  )[] = [],
): Promise<void> {
  await sendReplacingEphemeral(interaction, { content, components });
}
```

Update `updateEphemeral` like match (call `touchEphemeralSession` after update/editReply).

- [ ] **Step 2: Route public-button entry replies through `replyEphemeral`**

Replace each direct ephemeral `interaction.reply({ content, components, flags: Ephemeral })` used to open Fix Reading / claim UIs with `replyEphemeral(interaction, content, [row])`.

Known sites in this file (verify with search for `flags: MessageFlags.Ephemeral`):

- `handleEditNick` — select player to edit
- `handleMove` — select player to move
- `handleRemove` — select player to remove
- `handleAdd` — add-player UI (if it uses raw `reply`)
- Claim-slot select opener (raw `reply` near `lobby:select:claim`)

Example transformation:

```typescript
// before
await interaction.reply({
  content: 'Select a player to edit their nick:',
  components: [row],
  flags: MessageFlags.Ephemeral,
});

// after
await replyEphemeral(
  interaction,
  'Select a player to edit their nick:',
  [row],
);
```

- [ ] **Step 3: Route public `deferUpdate` + `followUp` feedback through `replyEphemeral`**

For handlers that `deferUpdate()` on the **public** lobby message then `followUp` ephemeral (e.g. leave lobby, balance/start error toasts that followUp after deferUpdate): replace those `followUp({ content, flags: Ephemeral })` calls with `replyEphemeral(interaction, content)` so they also replace the previous private UI.

Do **not** change paths that already `updateEphemeral` on an ephemeral select/button.

For handlers that `deferReply({ flags: Ephemeral })` then `editReply` (slow actions): before `deferReply`, call:

```typescript
if (interaction.channelId) {
  await deletePreviousEphemeral(
    interaction.client,
    interaction.user.id,
    interaction.channelId,
  );
}
```

Import `deletePreviousEphemeral` from `../lib/ephemeral-session.js`. After successful `deferReply`, remember:

```typescript
if (interaction.channelId) {
  rememberEphemeral(interaction.user.id, interaction.channelId, {
    applicationId: interaction.applicationId,
    token: interaction.token,
    messageId: '@original',
  });
}
```

Import `rememberEphemeral` from the same module.

- [ ] **Step 4: Typecheck + unit tests**

Run:

```bash
npx tsc --noEmit
npm test -- src/lib/ephemeral-session.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/handlers/lobby-interactions.ts
git commit -m "$(cat <<'EOF'
feat: replace prior lobby ephemeral when opening Fix Reading UI

EOF
)"
```

---

### Task 5: Manual verification checklist

**Files:** none (ops only)

- [ ] **Step 1: Manual Discord checks** (dev bot)

1. Open lobby **Edit nick** twice from the public message → only **one** ephemeral visible; public buttons stay reachable without scrolling past a stack.
2. Open **Move**, then **Remove** → previous private UI disappears; one remains.
3. Open match **Report Winner**, step through quitters → winner (in-place updates, single message).
4. Dismiss mentally / click **Report Winner** again from the public match message → previous report ephemeral deleted; new one appears.
5. After a leave/claim followUp toast, open Edit nick → toast ephemeral is replaced.

- [ ] **Step 2: Commit spec/plan if not already committed**

```bash
git add docs/superpowers/specs/2026-08-15-ephemeral-replace-design.md \
  docs/superpowers/plans/2026-08-15-ephemeral-replace.md
git commit -m "$(cat <<'EOF'
docs: ephemeral replace design and implementation plan

EOF
)"
```

---

## Spec coverage (self-review)

| Spec requirement | Task |
|------------------|------|
| Track + delete previous ephemeral | Task 1–2 |
| Key `userId:channelId` | Task 1 |
| In-memory only | Task 1 |
| Wizard keeps update/editReply | Task 3–4 (`updateEphemeral` + `touchEphemeralSession`) |
| Delete failure ignored | Task 1 `deletePreviousEphemeral` catch |
| Lobby Fix Reading entry | Task 4 |
| Match Report / Quitters / Cancel entry | Task 3 |
| followUp after public deferUpdate | Task 4 Step 3 |
| Unit tests for session map | Task 1 |
| No env/SSM/Prisma | Global constraints |

No placeholders left in steps. Types (`EphemeralRef`, helper names) are consistent across tasks.
