# Host one active lobby Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A non-mod host may have only one `PENDING` or `IN_PROGRESS` match they host in a league; a second create refuses and names that match. Match mods (create role still required) may host several.

**Architecture:** Extract `hostLobbyCapMessage` + `assertHostLobbyCapInTx` in `match-service.ts`. The create transaction calls the assert before insert. `/register_lobby` and wc3stats Open pass `bypassHostLobbyCap: hasMatchModRole(...)`. No schema or unique index.

**Tech Stack:** TypeScript ESM, Prisma, discord.js v14, Vitest

**Spec:** `docs/superpowers/specs/2026-08-18-host-one-active-lobby-design.md`

**Scope:** `general`

## Global Constraints

- Scope: `general` (match create; keyed by `leagueId`)
- English-only user-facing strings and errors
- ESM imports use the `.js` extension; named exports only
- Prisma singleton from `src/lib/prisma.ts`
- Cap is per `hostDiscordId` + `leagueId` for `PENDING` and `IN_PROGRESS` only
- Refuse; never auto-cancel or replace
- `bypassHostLobbyCap` defaults to **false** (omit/undefined enforces the cap)
- Match mods skip the cap via `hasMatchModRole`; create role stays required
- No Prisma unique index, no new env vars, no AWS SSM keys
- Do not change `/lobby` ambiguous-pending resolve
- Do not cap players seated in someone else’s lobby

## File map

| File | Role |
|------|------|
| `src/services/match/match-service.ts` | Message helper, cap assert, `CreatePendingMatchInput.bypassHostLobbyCap`, call inside create tx |
| `src/services/match/host-lobby-cap.test.ts` | Unit tests for message + cap helper |
| `src/commands/lobby/register-lobby.ts` | Pass `hasMatchModRole(...)` as bypass |
| `src/services/lobby/create-from-wc3stats.ts` | Same bypass flag |
| `docs/discord/public/03-start-a-lobby.md` | One line: non-mod hosts close the current match first |

---

### Task 1: Cap helpers (TDD)

**Files:**
- Create: `src/services/match/host-lobby-cap.test.ts`
- Modify: `src/services/match/match-service.ts`

**Interfaces:**
- Consumes: `MatchServiceError`; `Prisma.TransactionClient` (already imported in `match-service.ts`)
- Produces:
  - `hostLobbyCapMessage(status: 'PENDING' | 'IN_PROGRESS', matchId: string): string`
  - `assertHostLobbyCapInTx(tx: Prisma.TransactionClient, input: { leagueId: string; hostDiscordId: string; bypassHostLobbyCap?: boolean }): Promise<void>`

- [ ] **Step 1: Write the failing tests**

Create `src/services/match/host-lobby-cap.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@prisma/client';
import {
  assertHostLobbyCapInTx,
  hostLobbyCapMessage,
  MatchServiceError,
} from './match-service.js';

function fakeTx(row: { id: string; status: 'PENDING' | 'IN_PROGRESS' } | null) {
  const findFirst = vi.fn().mockResolvedValue(row);
  return {
    tx: { match: { findFirst } } as unknown as Prisma.TransactionClient,
    findFirst,
  };
}

describe('hostLobbyCapMessage', () => {
  it('names a pending lobby and tells the host to cancel', () => {
    expect(hostLobbyCapMessage('PENDING', 'abc123')).toBe(
      'You already have a pending lobby (abc123). Cancel it before opening another.',
    );
  });

  it('names an in-progress match and tells the host to report or cancel', () => {
    expect(hostLobbyCapMessage('IN_PROGRESS', 'abc123')).toBe(
      'You already have a match in progress (abc123). Report or cancel it before opening another lobby.',
    );
  });
});

describe('assertHostLobbyCapInTx', () => {
  const base = { leagueId: 'league-1', hostDiscordId: 'host-1' };

  it('does not throw when there is no active hosted match', async () => {
    const { tx, findFirst } = fakeTx(null);
    await expect(assertHostLobbyCapInTx(tx, base)).resolves.toBeUndefined();
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        leagueId: 'league-1',
        hostDiscordId: 'host-1',
        status: { in: ['PENDING', 'IN_PROGRESS'] },
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true, status: true },
    });
  });

  it('throws the pending copy when a pending match exists', async () => {
    const { tx } = fakeTx({ id: 'match-p', status: 'PENDING' });
    await expect(assertHostLobbyCapInTx(tx, base)).rejects.toThrow(MatchServiceError);
    await expect(assertHostLobbyCapInTx(tx, base)).rejects.toThrow(
      hostLobbyCapMessage('PENDING', 'match-p'),
    );
  });

  it('throws the in-progress copy when an in-progress match exists', async () => {
    const { tx } = fakeTx({ id: 'match-i', status: 'IN_PROGRESS' });
    await expect(assertHostLobbyCapInTx(tx, base)).rejects.toThrow(
      hostLobbyCapMessage('IN_PROGRESS', 'match-i'),
    );
  });

  it('skips the query when bypassHostLobbyCap is true', async () => {
    const { tx, findFirst } = fakeTx({ id: 'match-p', status: 'PENDING' });
    await expect(
      assertHostLobbyCapInTx(tx, { ...base, bypassHostLobbyCap: true }),
    ).resolves.toBeUndefined();
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('enforces the cap when bypassHostLobbyCap is omitted', async () => {
    const { tx } = fakeTx({ id: 'match-p', status: 'PENDING' });
    await expect(assertHostLobbyCapInTx(tx, base)).rejects.toThrow(
      hostLobbyCapMessage('PENDING', 'match-p'),
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/services/match/host-lobby-cap.test.ts`

Expected: FAIL — `hostLobbyCapMessage` / `assertHostLobbyCapInTx` are not exported.

- [ ] **Step 3: Implement the helpers**

In `src/services/match/match-service.ts`, add next to `duplicateWc3statsMatchMessage` (around line 210):

```typescript
export function hostLobbyCapMessage(
  status: 'PENDING' | 'IN_PROGRESS',
  matchId: string,
): string {
  if (status === 'IN_PROGRESS') {
    return `You already have a match in progress (${matchId}). Report or cancel it before opening another lobby.`;
  }

  return `You already have a pending lobby (${matchId}). Cancel it before opening another.`;
}

export async function assertHostLobbyCapInTx(
  tx: Prisma.TransactionClient,
  input: {
    leagueId: string;
    hostDiscordId: string;
    bypassHostLobbyCap?: boolean;
  },
): Promise<void> {
  if (input.bypassHostLobbyCap === true) {
    return;
  }

  const existing = await tx.match.findFirst({
    where: {
      leagueId: input.leagueId,
      hostDiscordId: input.hostDiscordId,
      status: { in: ['PENDING', 'IN_PROGRESS'] },
    },
    orderBy: { createdAt: 'desc' },
    select: { id: true, status: true },
  });

  if (!existing) {
    return;
  }

  const status = existing.status === 'IN_PROGRESS' ? 'IN_PROGRESS' : 'PENDING';
  throw new MatchServiceError(hostLobbyCapMessage(status, existing.id));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/services/match/host-lobby-cap.test.ts`

Expected: PASS (all tests in that file).

- [ ] **Step 5: Commit**

```bash
git add src/services/match/match-service.ts src/services/match/host-lobby-cap.test.ts
git commit -m "$(cat <<'EOF'
Add per-league host lobby cap helpers.

Non-mod hosts will be limited to one PENDING or IN_PROGRESS match per league.
EOF
)"
```

---

### Task 2: Enforce the cap inside `createPendingMatch`

**Files:**
- Modify: `src/services/match/match-service.ts` (`CreatePendingMatchInput` and the create transaction)

**Interfaces:**
- Consumes: `assertHostLobbyCapInTx` from Task 1
- Produces: `CreatePendingMatchInput.bypassHostLobbyCap?: boolean` (default omit = enforce)

- [ ] **Step 1: Add the input field**

In `CreatePendingMatchInput` (around line 43):

```typescript
export interface CreatePendingMatchInput {
  leagueId: string;
  hostDiscordId: string;
  discordChannelId: string;
  players: LobbyPlayer[];
  wc3statsGameId?: string | null;
  bypassHostLobbyCap?: boolean;
}
```

- [ ] **Step 2: Call the assert at the start of the create transaction**

In `createPendingMatch`, inside `prisma.$transaction`, **before** the wc3stats duplicate check:

```typescript
  const created = await prisma.$transaction(async (tx) => {
    await assertHostLobbyCapInTx(tx, {
      leagueId: input.leagueId,
      hostDiscordId: input.hostDiscordId,
      bypassHostLobbyCap: input.bypassHostLobbyCap === true,
    });

    if (wc3statsGameId) {
      const existing = await tx.match.findFirst({
        where: {
          leagueId: input.leagueId,
          wc3statsGameId,
          status: { in: ['PENDING', 'IN_PROGRESS'] },
        },
        select: { id: true },
      });

      if (existing) {
        throw new MatchServiceError(duplicateWc3statsMatchMessage(existing.id));
      }
    }
```

Do not add a unique index. Leave `COMPLETED` / `CANCELLED` out of the status filter.

- [ ] **Step 3: Re-run cap tests**

Run: `npx vitest run src/services/match/host-lobby-cap.test.ts`

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/services/match/match-service.ts
git commit -m "$(cat <<'EOF'
Enforce host lobby cap on pending match create.

Second create in the same league refuses unless bypassHostLobbyCap is set.
EOF
)"
```

---

### Task 3: Pass the mod bypass from both create paths + public doc

**Files:**
- Modify: `src/commands/lobby/register-lobby.ts`
- Modify: `src/services/lobby/create-from-wc3stats.ts`
- Modify: `docs/discord/public/03-start-a-lobby.md`

**Interfaces:**
- Consumes: `hasMatchModRole` from `src/services/match/match-auth.ts` (already exported via `src/services/match/index.ts`); `CreatePendingMatchInput.bypassHostLobbyCap` from Task 2
- Produces: both create paths set `bypassHostLobbyCap: hasMatchModRole(...)`

- [ ] **Step 1: Wire `/register_lobby`**

In `src/commands/lobby/register-lobby.ts`, add `hasMatchModRole` to the existing `assertCanCreateMatch` import:

```typescript
import { assertCanCreateMatch, hasMatchModRole } from '../../services/match/index.js';
```

At the `createPendingMatch` call (around line 265), pass the bypass. `guildConfig` is set earlier in the same `execute` after a successful create-role check:

```typescript
    const created = await createPendingMatch({
      leagueId,
      hostDiscordId: interaction.user.id,
      discordChannelId: interaction.channelId,
      players,
      wc3statsGameId,
      bypassHostLobbyCap: hasMatchModRole({
        actorDiscordId: interaction.user.id,
        memberRoleIds: memberRoleIds(interaction),
        matchModRoleId: guildConfig?.matchModRoleId,
      }),
    });
```

Do not skip `assertCanCreateMatch`. Mods without the create role still cannot open a lobby.

- [ ] **Step 2: Wire wc3stats Open**

In `src/services/lobby/create-from-wc3stats.ts`, add `hasMatchModRole` to the match import:

```typescript
import {
  assertCanCreateMatch,
  attachDiscordMessage,
  createPendingMatch,
  getMatchById,
  hasMatchModRole,
  MatchServiceError,
} from '../match/index.js';
```

At the `createPendingMatch` call (around line 120):

```typescript
  const created = await createPendingMatch({
    leagueId: input.leagueId,
    hostDiscordId: input.hostDiscordId,
    discordChannelId: input.discordChannelId,
    players,
    wc3statsGameId,
    bypassHostLobbyCap: hasMatchModRole({
      actorDiscordId: input.hostDiscordId,
      memberRoleIds: input.memberRoleIds,
      matchModRoleId: guildConfig.matchModRoleId,
    }),
  });
```

`guildConfig` is already loaded at the top of `createMatchFromWc3statsLobby`.

- [ ] **Step 3: Confirm both call sites pass the flag**

Run: `rg -n "bypassHostLobbyCap" src/commands/lobby/register-lobby.ts src/services/lobby/create-from-wc3stats.ts src/services/match/match-service.ts`

Expected: the two callers pass `hasMatchModRole(...)`; `CreatePendingMatchInput` and `assertHostLobbyCapInTx` inside `createPendingMatch` mention the field.

- [ ] **Step 4: Update the public lobby guide**

In `docs/discord/public/03-start-a-lobby.md`, after the create-role paragraph (after line 4), add:

```markdown
A host who is not a match moderator can have only one open lobby or in-progress match in that league at a time. Cancel or report it before opening another. Moderators can open more than one.
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run src/services/match/host-lobby-cap.test.ts src/services/match/match-auth.test.ts src/services/lobby/resolve.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/commands/lobby/register-lobby.ts src/services/lobby/create-from-wc3stats.ts docs/discord/public/03-start-a-lobby.md
git commit -m "$(cat <<'EOF'
Bypass the host lobby cap for match moderators.

Create role is unchanged; only staff may host more than one active match per league.
EOF
)"
```

---

## Manual check (after all tasks)

1. Create-role host (not mod): `/register_lobby` → success. Second `/register_lobby` in the same league → refuse naming the first match id. `/lobby cancel` → third `/register_lobby` succeeds.
2. Same host, start the match (IN_PROGRESS): second `/register_lobby` refuses with the in-progress copy.
3. Same host, other league: second lobby is allowed.
4. Match mod with create role: two `/register_lobby` in the same league both succeed.
5. wc3stats Open for a non-mod who already hosts an active match in that league: same refuse as slash.

## Spec coverage

| Spec requirement | Task |
|------------------|------|
| Active = PENDING or IN_PROGRESS | 1, 2 |
| Per league (`hostDiscordId` + `leagueId`) | 1 query + 2 |
| Refuse and name match id | 1 messages |
| Newest leftover when several exist | 1 `orderBy createdAt desc` |
| Mod / universal mod bypass via `hasMatchModRole` | 3 |
| Create role still required | 3 (do not skip `assertCanCreateMatch`) |
| Enforce inside `createPendingMatch` tx | 2 |
| Default bypass false | 1 omitted-flag test + 2 `=== true` |
| Both create paths | 3 |
| Public doc line | 3 |
| No unique index / no env / no seated-player cap | not implemented (non-goals) |
