# Match Create Role Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Gate `/register_lobby` behind `MATCH_CREATE_ROLE_ID` so only that Discord role can create PENDING matches; empty/unset disables creation for everyone.

**Architecture:** Parse a separate env var (same shape as `MATCH_MOD_ROLE_ID`). Add `canCreateMatch` / `assertCanCreateMatch` in `match-auth.ts`. Call the assert in `/register_lobby` immediately after `deferReply`, before OCR. Host lobby management and `MATCH_MOD_ROLE_ID` report auth stay unchanged.

**Tech Stack:** Node.js + TypeScript ESM, discord.js v14, Vitest

**Spec:** [docs/superpowers/specs/2026-08-13-match-create-role-design.md](../specs/2026-08-13-match-create-role-design.md)

## Global Constraints

- User-facing strings in **English**
- Empty/unset `MATCH_CREATE_ROLE_ID` → **nobody** can create (unlike `MATCH_MOD_ROLE_ID`, which falls back to host-only)
- Scope is **`/register_lobby` only**
- ESM imports use `.js` extensions
- Prefer Prisma singleton / existing `MatchServiceError` for user-facing auth failures
- Commits only when the user asks (skip commit steps unless requested)

## File structure

| File | Responsibility |
|------|----------------|
| `src/config/env.ts` | Parse `matchCreateRoleId` from `MATCH_CREATE_ROLE_ID` |
| `.cursor/rules/scripts-and-env.mdc` | Document the env var |
| `.env.example` | Placeholder for operators |
| `src/services/match-auth.ts` | `canCreateMatch` / `assertCanCreateMatch` |
| `src/services/match-auth.test.ts` | Unit tests for create-role auth |
| `src/commands/lobby/register-lobby.ts` | Assert before OCR; map `MatchServiceError` to reply |

---

### Task 1: Env + create-role auth helpers

**Files:**
- Modify: `src/config/env.ts`
- Modify: `.cursor/rules/scripts-and-env.mdc`
- Modify: `.env.example`
- Modify: `src/services/match-auth.ts`
- Create: `src/services/match-auth.test.ts`

**Interfaces:**
- Produces:
  - `env.matchCreateRoleId: string | undefined`
  - `canCreateMatch(input: { memberRoleIds: string[] }): boolean`
  - `assertCanCreateMatch(input: { memberRoleIds: string[] }): void` — throws `MatchServiceError`

- [ ] **Step 1: Write the failing tests**

Create `src/services/match-auth.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({
  env: {
    matchCreateRoleId: undefined as string | undefined,
    matchModRoleId: undefined as string | undefined,
    // unused by match-auth but keep object shape flexible
  },
}));

import { env } from '../config/env.js';
import { assertCanCreateMatch, canCreateMatch } from './match-auth.js';
import { MatchServiceError } from './match-service.js';

describe('canCreateMatch', () => {
  beforeEach(() => {
    env.matchCreateRoleId = undefined;
  });

  it('returns false when MATCH_CREATE_ROLE_ID is unset', () => {
    expect(canCreateMatch({ memberRoleIds: ['111'] })).toBe(false);
  });

  it('returns false when member lacks the create role', () => {
    env.matchCreateRoleId = 'role-create';
    expect(canCreateMatch({ memberRoleIds: ['other'] })).toBe(false);
  });

  it('returns true when member has the create role', () => {
    env.matchCreateRoleId = 'role-create';
    expect(canCreateMatch({ memberRoleIds: ['role-create', 'other'] })).toBe(true);
  });
});

describe('assertCanCreateMatch', () => {
  beforeEach(() => {
    env.matchCreateRoleId = undefined;
  });

  it('throws disabled message when env is unset', () => {
    expect(() => assertCanCreateMatch({ memberRoleIds: [] })).toThrow(MatchServiceError);
    expect(() => assertCanCreateMatch({ memberRoleIds: [] })).toThrow(
      'Match creation is disabled until MATCH_CREATE_ROLE_ID is configured.',
    );
  });

  it('throws creator-role message when member lacks role', () => {
    env.matchCreateRoleId = 'role-create';
    expect(() => assertCanCreateMatch({ memberRoleIds: ['other'] })).toThrow(
      'Only members with the match creator role can register a lobby.',
    );
  });

  it('does not throw when member has the create role', () => {
    env.matchCreateRoleId = 'role-create';
    expect(() => assertCanCreateMatch({ memberRoleIds: ['role-create'] })).not.toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/services/match-auth.test.ts`

Expected: FAIL (missing `canCreateMatch` / `assertCanCreateMatch` and/or `matchCreateRoleId`)

- [ ] **Step 3: Extend env**

In `src/config/env.ts`, add to `EnvConfig`:

```ts
/** Discord role ID required to create lobbies via /register_lobby. Empty = creation disabled. */
matchCreateRoleId: string | undefined;
```

Add to the `env` object (alongside `matchModRoleId`):

```ts
matchCreateRoleId: (() => {
  const value = process.env.MATCH_CREATE_ROLE_ID?.trim();
  return value && value.length > 0 ? value : undefined;
})(),
```

- [ ] **Step 4: Document env var**

In `.cursor/rules/scripts-and-env.mdc`, under Env vars, add:

```md
- `MATCH_CREATE_ROLE_ID` — Discord role required to run `/register_lobby` (empty/unset = creation disabled for everyone)
```

In `.env.example`, append:

```env
# Discord role ID required to create lobbies (/register_lobby). Empty = nobody can create.
# For wave-1 testing, set the same value as MATCH_MOD_ROLE_ID if one staff role does both.
# MATCH_CREATE_ROLE_ID=
# MATCH_MOD_ROLE_ID=
```

- [ ] **Step 5: Implement auth helpers**

In `src/services/match-auth.ts`, keep existing manage-match helpers and add:

```ts
const CREATE_DISABLED =
  'Match creation is disabled until MATCH_CREATE_ROLE_ID is configured.';
const CREATE_FORBIDDEN =
  'Only members with the match creator role can register a lobby.';

export function canCreateMatch(input: { memberRoleIds: string[] }): boolean {
  const createRoleId = env.matchCreateRoleId;
  if (!createRoleId) {
    return false;
  }

  return input.memberRoleIds.includes(createRoleId);
}

export function assertCanCreateMatch(input: { memberRoleIds: string[] }): void {
  if (canCreateMatch(input)) {
    return;
  }

  if (!env.matchCreateRoleId) {
    throw new MatchServiceError(CREATE_DISABLED);
  }

  throw new MatchServiceError(CREATE_FORBIDDEN);
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test -- src/services/match-auth.test.ts`

Expected: PASS (all 6 tests)

- [ ] **Step 7: Commit** (only if user asked)

```bash
git add src/config/env.ts src/services/match-auth.ts src/services/match-auth.test.ts \
  .cursor/rules/scripts-and-env.mdc .env.example
git commit -m "$(cat <<'EOF'
Add MATCH_CREATE_ROLE_ID gate helpers for lobby creation.

EOF
)"
```

---

### Task 2: Wire `/register_lobby`

**Files:**
- Modify: `src/commands/lobby/register-lobby.ts`

**Interfaces:**
- Consumes: `assertCanCreateMatch({ memberRoleIds: string[] })`
- Produces: early English failure reply; no OCR/DB on auth failure

- [ ] **Step 1: Add role helper + early assert**

In `src/commands/lobby/register-lobby.ts`:

1. Import `GuildMember` from `discord.js` (alongside existing imports).
2. Import `assertCanCreateMatch` from `../../services/match-auth.js`.
3. Add the same `memberRoleIds` helper used in `src/commands/match/match.ts`:

```ts
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
```

4. In `execute`, immediately after `await interaction.deferReply();`, assert before attachment/OCR work:

```ts
try {
  assertCanCreateMatch({ memberRoleIds: memberRoleIds(interaction) });
} catch (error) {
  if (error instanceof MatchServiceError) {
    log.warn({ err: error, userId: interaction.user.id }, 'Match lobby creation forbidden');
    await interaction.editReply(error.message);
    return;
  }

  throw error;
}
```

Do **not** call `tryExtractLobbyPlayers` / `createPendingMatch` when assert fails.

- [ ] **Step 2: Manual smoke checklist**

With bot running (`npm run dev`):

1. Unset `MATCH_CREATE_ROLE_ID` → `/register_lobby` → disabled message; no new PENDING match  
2. Set `MATCH_CREATE_ROLE_ID` to a role the tester lacks → creator-role message  
3. Give tester the role (or set env to a role they have) → lobby creates as before  
4. Confirm host without create role can still edit/start an existing lobby they host  

- [ ] **Step 3: Commit** (only if user asked)

```bash
git add src/commands/lobby/register-lobby.ts
git commit -m "$(cat <<'EOF'
Gate /register_lobby behind MATCH_CREATE_ROLE_ID.

EOF
)"
```

---

## Spec coverage (self-review)

| Spec requirement | Task |
|------------------|------|
| `MATCH_CREATE_ROLE_ID` env | Task 1 |
| Empty → nobody creates | Task 1 (`canCreateMatch` false + disabled message) |
| Set → role required | Task 1 + Task 2 |
| `/register_lobby` only | Task 2 |
| Assert before OCR | Task 2 |
| English error messages | Task 1 |
| Document env + `.env.example` | Task 1 |
| Unit tests | Task 1 |
| Wave-1 same ID as mod role | Ops note in `.env.example` / spec (no code) |
