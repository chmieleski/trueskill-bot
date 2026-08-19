# Lobby swap pairs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hosts can reseat named players in one `/lobby swap` via `pairs` (`1-7, 5-Gohan`) while classic `slot_a`/`slot_b` still swaps two occupied seats.

**Architecture:** Pure `remap.ts` parses comma pairs, resolves slot-or-nick against the working roster, and folds existing `movePlayer`. `remapLobbyPlayers` persists once. `/lobby swap` XOR-validates classic vs `pairs` in `resolveSwapForm`. No button, schema, or env.

**Tech Stack:** TypeScript ESM, discord.js v14, Vitest

**Spec:** `docs/superpowers/specs/2026-08-19-lobby-swap-pairs-design.md`

**Scope:** `general`

**Workspace:** Isolated worktree `/home/lesk/www/bot/.worktrees/feat-lobby-swap-pairs` on branch `feat/lobby-swap-pairs`. Do not edit the main checkout.

## Global Constraints

- Scope: `general` (host lobby roster; keyed by `leagueId` via existing pending-match resolve)
- English-only user-facing strings, logs, command names/descriptions, and errors
- ESM imports use the `.js` extension; named exports only
- Shared domain logic: buttons and slash call the same roster use-cases; remap calls `movePlayer`, does not duplicate swap/move
- Classic two-slot form stays `swapPlayers` (empty dest still rejected)
- Batch form uses sequential `movePlayer` (empty dest = move, occupied = swap)
- Nick resolve uses `normalizeNick` (trim + lowercase) against the roster **after** previous pairs
- Token matching `^[1-9]\d*$` is a **slot attempt** (out of range → `invalidSlotMessage`, not a nick)
- Split each pair on the **last** ASCII `-`; pairs are **comma-separated only**
- Persist once via `applyRosterAndSync`; parse/apply failures must not write
- Host-only; optional `match_id` unchanged; no match-mod access; no new button
- No schema, env vars, or AWS SSM
- Discord builder: `slot_a` and `slot_b` **must** be optional so `pairs` can be used alone

## File map

| File                                      | Role                                                                        |
| ----------------------------------------- | --------------------------------------------------------------------------- |
| `src/services/lobby/remap.ts`             | `parseRemapPairs`, `resolveRemapSide`, `applyRemapPairs`, `resolveSwapForm` |
| `src/services/lobby/remap.test.ts`        | Parser, resolve, sequential apply, XOR form                                 |
| `src/services/lobby/actions.ts`           | `remapLobbyPlayers` use-case                                                |
| `src/services/lobby/index.ts`             | Export use-case + `resolveSwapForm` / `parseRemapPairs`                     |
| `src/commands/lobby/lobby.ts`             | Optional options, XOR, classic vs remap                                     |
| `src/commands/lobby/lobby.test.ts`        | Command data for `pairs` and optional slots                                 |
| `docs/discord/public/04-fix-the-lobby.md` | Host-facing `pairs` examples                                                |

---

### Task 1: Parse remap pairs

**Files:**

- Create: `src/services/lobby/remap.test.ts`
- Create: `src/services/lobby/remap.ts`

**Interfaces:**

- Consumes: `MatchServiceError` from `../match/match-service.js`
- Produces: `export type RemapPair = { raw: string; left: string; right: string }`; `parseRemapPairs(raw: string): RemapPair[]`

- [ ] **Step 1: Write the failing tests**

Create `src/services/lobby/remap.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { MatchServiceError } from '../match/match-service.js';
import { parseRemapPairs } from './remap.js';

describe('parseRemapPairs', () => {
  it('splits comma pairs and last hyphen, trimming whitespace', () => {
    expect(parseRemapPairs('1-7, 5-4')).toEqual([
      { raw: '1-7', left: '1', right: '7' },
      { raw: '5-4', left: '5', right: '4' },
    ]);
  });

  it('keeps hyphenated nicks by splitting on the last dash', () => {
    expect(parseRemapPairs('cool-guy-7')).toEqual([
      { raw: 'cool-guy-7', left: 'cool-guy', right: '7' },
    ]);
  });

  it('trims around the hyphen', () => {
    expect(parseRemapPairs('1 - 7')).toEqual([{ raw: '1 - 7', left: '1', right: '7' }]);
  });

  it('rejects empty or whitespace input', () => {
    expect(() => parseRemapPairs('')).toThrow(MatchServiceError);
    expect(() => parseRemapPairs('   ')).toThrow('pairs cannot be empty.');
  });

  it('rejects empty comma segments', () => {
    expect(() => parseRemapPairs('1-7,')).toThrow('Invalid pair "". Use like 1-7 or Gohan-4.');
    expect(() => parseRemapPairs(',1-7')).toThrow('Invalid pair "". Use like 1-7 or Gohan-4.');
  });

  it('rejects a missing hyphen or empty side', () => {
    expect(() => parseRemapPairs('17')).toThrow('Invalid pair "17". Use like 1-7 or Gohan-4.');
    expect(() => parseRemapPairs('-7')).toThrow('Invalid pair "-7". Use like 1-7 or Gohan-4.');
    expect(() => parseRemapPairs('1-')).toThrow('Invalid pair "1-". Use like 1-7 or Gohan-4.');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/services/lobby/remap.test.ts`

Expected: FAIL — cannot find module `./remap.js` (or `parseRemapPairs` is not exported).

- [ ] **Step 3: Write minimal implementation**

Create `src/services/lobby/remap.ts`:

```typescript
import { MatchServiceError } from '../match/match-service.js';

export type RemapPair = { raw: string; left: string; right: string };

function invalidPairMessage(segment: string): string {
  return `Invalid pair "${segment}". Use like 1-7 or Gohan-4.`;
}

/**
 * Split a host `pairs` string into left/right tokens.
 * Comma-separated only; each pair splits on the last ASCII hyphen.
 */
export function parseRemapPairs(raw: string): RemapPair[] {
  if (raw.trim() === '') {
    throw new MatchServiceError('pairs cannot be empty.');
  }

  const pairs: RemapPair[] = [];

  for (const segment of raw.split(',')) {
    const trimmed = segment.trim();
    if (trimmed === '') {
      throw new MatchServiceError(invalidPairMessage(''));
    }

    const dash = trimmed.lastIndexOf('-');
    if (dash <= 0 || dash === trimmed.length - 1) {
      throw new MatchServiceError(invalidPairMessage(trimmed));
    }

    const left = trimmed.slice(0, dash).trim();
    const right = trimmed.slice(dash + 1).trim();
    if (left === '' || right === '') {
      throw new MatchServiceError(invalidPairMessage(trimmed));
    }

    pairs.push({ raw: trimmed, left, right });
  }

  return pairs;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/services/lobby/remap.test.ts`

Expected: PASS (parse cases only).

- [ ] **Step 5: Commit**

```bash
git add src/services/lobby/remap.ts src/services/lobby/remap.test.ts
git commit -m "feat(lobby): parse swap pairs strings"
```

---

### Task 2: Resolve slot or nick

**Files:**

- Modify: `src/services/lobby/remap.test.ts`
- Modify: `src/services/lobby/remap.ts`

**Interfaces:**

- Consumes: `LobbyPlayer` from `./lobby-ocr.js`; `GameProfile`, `invalidSlotMessage`, `isSlotInProfile` from `../../domain/game-profile.js`; `normalizeNick` from `../player/player-nick.js`; `parseRemapPairs` from Task 1
- Produces: `resolveRemapSide(token: string, players: LobbyPlayer[], profile: GameProfile): number`

- [ ] **Step 1: Write the failing tests**

In `src/services/lobby/remap.test.ts`, extend imports and add profiles + helper **above** the existing `parseRemapPairs` describe, then append the new describe.

Imports and helpers to add:

```typescript
import { getGameProfile } from '../../domain/game-profile.js';
import {
  WARCRAFT3_ANIME_CHOICE_ARENA_GAME_ID,
  WARCRAFT3_UDBR_GAME_ID,
} from '../../domain/games.js';
import type { LobbyPlayer } from './lobby-ocr.js';
import { parseRemapPairs, resolveRemapSide } from './remap.js';

const udbr = getGameProfile(WARCRAFT3_UDBR_GAME_ID);
const aca = getGameProfile(WARCRAFT3_ANIME_CHOICE_ARENA_GAME_ID);

function roster(...rows: Array<[number, string]>): LobbyPlayer[] {
  return rows.map(([slot, nick]) => ({ slot, nick }));
}
```

New tests:

```typescript
describe('resolveRemapSide', () => {
  it('treats in-range integers as slots', () => {
    expect(resolveRemapSide('7', roster([1, 'a']), udbr)).toBe(7);
  });

  it('rejects out-of-range integer tokens as invalid slots, not nicks', () => {
    expect(() => resolveRemapSide('99', roster([1, '99']), udbr)).toThrow(
      'Invalid slot. This game uses slots 1–12.',
    );
    expect(() => resolveRemapSide('11', [], aca)).toThrow(
      'Invalid slot. This game uses slots 1–10.',
    );
  });

  it('resolves a nick to the occupant slot', () => {
    expect(resolveRemapSide('Gohan', roster([3, 'gohan']), udbr)).toBe(3);
  });

  it('rejects an unknown nick', () => {
    expect(() => resolveRemapSide('Gohan', roster([1, 'vegeta']), udbr)).toThrow(
      'No player with nick "gohan" in the lobby.',
    );
  });

  it('never treats token 7 as nick 7', () => {
    expect(resolveRemapSide('7', roster([8, '7']), udbr)).toBe(7);
  });

  it('treats 0 and leading zeros as nicks, not slots', () => {
    expect(resolveRemapSide('07', roster([4, '07']), udbr)).toBe(4);
    expect(() => resolveRemapSide('0', [], udbr)).toThrow('No player with nick "0" in the lobby.');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/services/lobby/remap.test.ts`

Expected: FAIL — `resolveRemapSide` is not exported.

- [ ] **Step 3: Write minimal implementation**

Add to `src/services/lobby/remap.ts`:

```typescript
import {
  invalidSlotMessage,
  isSlotInProfile,
  type GameProfile,
} from '../../domain/game-profile.js';
import { normalizeNick } from '../player/player-nick.js';
import type { LobbyPlayer } from './lobby-ocr.js';

const SLOT_TOKEN = /^[1-9]\d*$/;

/**
 * Map a pair side to a slot. Digit tokens are slot attempts; everything else is a nick.
 */
export function resolveRemapSide(
  token: string,
  players: LobbyPlayer[],
  profile: GameProfile,
): number {
  const trimmed = token.trim();

  if (SLOT_TOKEN.test(trimmed)) {
    const slot = Number(trimmed);
    if (!isSlotInProfile(profile, slot)) {
      throw new MatchServiceError(invalidSlotMessage(profile));
    }
    return slot;
  }

  const nick = normalizeNick(trimmed);
  const player = players.find((entry) => entry.nick === nick);
  if (!player) {
    throw new MatchServiceError(`No player with nick "${nick}" in the lobby.`);
  }
  return player.slot;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/services/lobby/remap.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/lobby/remap.ts src/services/lobby/remap.test.ts
git commit -m "feat(lobby): resolve swap pair sides to slots"
```

---

### Task 3: Sequential applyRemapPairs

**Files:**

- Modify: `src/services/lobby/remap.test.ts`
- Modify: `src/services/lobby/remap.ts`

**Interfaces:**

- Consumes: `movePlayer` from `./roster.js`; `parseRemapPairs` and `resolveRemapSide` from Tasks 1–2
- Produces: `applyRemapPairs(players: LobbyPlayer[], raw: string, profile: GameProfile): LobbyPlayer[]`

- [ ] **Step 1: Write the failing tests**

Append the `describe('applyRemapPairs')` block to `src/services/lobby/remap.test.ts`. Add `movePlayer` from `./roster.js` and `applyRemapPairs` to the existing remap import. Do not duplicate helpers.

```typescript
describe('applyRemapPairs', () => {
  it('swaps when the destination is occupied', () => {
    const players = roster([1, 'a'], [7, 'b']);
    expect(applyRemapPairs(players, '1-7', udbr)).toEqual(movePlayer(players, 1, 7, udbr));
  });

  it('moves when the destination is empty', () => {
    const players = roster([1, 'a']);
    expect(applyRemapPairs(players, '1-7', udbr)).toEqual(movePlayer(players, 1, 7, udbr));
  });

  it('applies overlapping pairs left to right', () => {
    const players = roster([1, 'a'], [7, 'b'], [3, 'c']);
    const afterFirst = movePlayer(players, 1, 7, udbr);
    const expected = movePlayer(afterFirst, 7, 3, udbr);
    expect(applyRemapPairs(players, '1-7, 7-3', udbr)).toEqual(expected);
  });

  it('resolves nicks against the roster after previous pairs', () => {
    const players = roster([1, 'gohan'], [7, 'vegeta']);
    const afterSwap = movePlayer(players, 1, 7, udbr);
    const expected = movePlayer(afterSwap, 7, 4, udbr);
    expect(applyRemapPairs(players, '1-7, Gohan-4', udbr)).toEqual(expected);
  });

  it('moves a hyphenated nick via last-dash parse', () => {
    const players = roster([1, 'cool-guy']);
    expect(applyRemapPairs(players, 'cool-guy-7', udbr)).toEqual(movePlayer(players, 1, 7, udbr));
  });

  it('does not wrap parse errors with Could not apply', () => {
    expect(() => applyRemapPairs([], '17', udbr)).toThrow(MatchServiceError);
    try {
      applyRemapPairs([], '17', udbr);
    } catch (error) {
      expect((error as Error).message).toBe('Invalid pair "17". Use like 1-7 or Gohan-4.');
    }
  });

  it('prefixes resolve and move failures with the pair text', () => {
    const players = roster([1, 'a'], [8, '7']);
    expect(() => applyRemapPairs(players, '7-4', udbr)).toThrow(
      'Could not apply 7-4: Slot 7 is empty.',
    );
    expect(() => applyRemapPairs(roster([1, 'a']), 'Gohan-4', udbr)).toThrow(
      'Could not apply Gohan-4: No player with nick "gohan" in the lobby.',
    );
  });

  it('leaves the input array unchanged on failure', () => {
    const players = roster([1, 'a'], [7, 'b']);
    const snapshot = structuredClone(players);
    expect(() => applyRemapPairs(players, '1-7, 99-1', udbr)).toThrow(MatchServiceError);
    expect(players).toEqual(snapshot);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/services/lobby/remap.test.ts`

Expected: FAIL — `applyRemapPairs` is not exported.

- [ ] **Step 3: Write minimal implementation**

Add to `src/services/lobby/remap.ts`:

```typescript
import { movePlayer } from './roster.js';

/**
 * Apply every pair left to right on a working roster. Does not persist.
 * Parse errors keep their own copy; resolve/move errors are prefixed with the pair.
 */
export function applyRemapPairs(
  players: LobbyPlayer[],
  raw: string,
  profile: GameProfile,
): LobbyPlayer[] {
  const pairs = parseRemapPairs(raw);
  let working = players;

  for (const pair of pairs) {
    try {
      const fromSlot = resolveRemapSide(pair.left, working, profile);
      const toSlot = resolveRemapSide(pair.right, working, profile);
      working = movePlayer(working, fromSlot, toSlot, profile);
    } catch (error) {
      if (error instanceof MatchServiceError) {
        throw new MatchServiceError(`Could not apply ${pair.raw}: ${error.message}`);
      }
      throw error;
    }
  }

  return working;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/services/lobby/remap.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/lobby/remap.ts src/services/lobby/remap.test.ts
git commit -m "feat(lobby): apply swap pairs sequentially"
```

---

### Task 4: XOR swap form

**Files:**

- Modify: `src/services/lobby/remap.test.ts`
- Modify: `src/services/lobby/remap.ts`

**Interfaces:**

- Consumes: `MatchServiceError`
- Produces:
  - `export type SwapForm = { kind: 'classic'; slotA: number; slotB: number } | { kind: 'pairs'; pairs: string }`
  - `resolveSwapForm(input: { slotA: number | null; slotB: number | null; pairs: string | null }): SwapForm`

- [ ] **Step 1: Write the failing tests**

Append the `describe('resolveSwapForm')` block to `src/services/lobby/remap.test.ts`. Add `resolveSwapForm` to the existing remap import.

```typescript
describe('resolveSwapForm', () => {
  it('returns classic when both slots are set and pairs is blank', () => {
    expect(resolveSwapForm({ slotA: 1, slotB: 7, pairs: null })).toEqual({
      kind: 'classic',
      slotA: 1,
      slotB: 7,
    });
    expect(resolveSwapForm({ slotA: 1, slotB: 7, pairs: '  ' })).toEqual({
      kind: 'classic',
      slotA: 1,
      slotB: 7,
    });
  });

  it('returns pairs when only pairs is set', () => {
    expect(resolveSwapForm({ slotA: null, slotB: null, pairs: ' 1-7 ' })).toEqual({
      kind: 'pairs',
      pairs: '1-7',
    });
  });

  it('rejects neither form', () => {
    expect(() => resolveSwapForm({ slotA: null, slotB: null, pairs: null })).toThrow(
      'Provide slot_a and slot_b, or pairs.',
    );
  });

  it('rejects both forms', () => {
    expect(() => resolveSwapForm({ slotA: 1, slotB: 7, pairs: '1-7' })).toThrow(
      'Use either slot_a and slot_b, or pairs, not both.',
    );
  });

  it('rejects a single slot option', () => {
    expect(() => resolveSwapForm({ slotA: 1, slotB: null, pairs: null })).toThrow(
      'Provide both slot_a and slot_b, or use pairs instead.',
    );
    expect(() => resolveSwapForm({ slotA: null, slotB: 7, pairs: '1-7' })).toThrow(
      'Use either slot_a and slot_b, or pairs, not both.',
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/services/lobby/remap.test.ts`

Expected: FAIL — `resolveSwapForm` is not exported.

- [ ] **Step 3: Write minimal implementation**

Add to `src/services/lobby/remap.ts`:

```typescript
export type SwapForm =
  { kind: 'classic'; slotA: number; slotB: number } | { kind: 'pairs'; pairs: string };

/**
 * Discord `/lobby swap` XOR: classic two slots, or a pairs string, never both.
 * Whitespace-only `pairs` counts as absent.
 */
export function resolveSwapForm(input: {
  slotA: number | null;
  slotB: number | null;
  pairs: string | null;
}): SwapForm {
  const pairs = input.pairs?.trim() ?? '';
  const hasPairs = pairs !== '';
  const hasA = input.slotA !== null;
  const hasB = input.slotB !== null;

  if (hasPairs && !hasA && !hasB) {
    return { kind: 'pairs', pairs };
  }

  if (!hasPairs && hasA && hasB) {
    return { kind: 'classic', slotA: input.slotA!, slotB: input.slotB! };
  }

  if (hasPairs && (hasA || hasB)) {
    throw new MatchServiceError('Use either slot_a and slot_b, or pairs, not both.');
  }

  if (hasA !== hasB) {
    throw new MatchServiceError('Provide both slot_a and slot_b, or use pairs instead.');
  }

  throw new MatchServiceError('Provide slot_a and slot_b, or pairs.');
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/services/lobby/remap.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/lobby/remap.ts src/services/lobby/remap.test.ts
git commit -m "feat(lobby): xor classic swap and pairs"
```

---

### Task 5: Slash command, use-case, and host docs

**Files:**

- Modify: `src/services/lobby/actions.ts`
- Modify: `src/services/lobby/index.ts`
- Modify: `src/commands/lobby/lobby.ts`
- Modify: `src/commands/lobby/lobby.test.ts`
- Modify: `docs/discord/public/04-fix-the-lobby.md`

**Interfaces:**

- Consumes: `resolveSwapForm`, `applyRemapPairs`, `parseRemapPairs` from `remap.ts`; `swapLobbyPlayers` unchanged
- Produces: `remapLobbyPlayers({ client, hostDiscordId, matchId?, pairs: string }): Promise<LobbyActionResult>`

- [ ] **Step 1: Write the failing command-data test**

Add to `src/commands/lobby/lobby.test.ts` inside `describe('lobby command data')`:

```typescript
it('exposes swap with optional slots and pairs', () => {
  const json = data.toJSON();
  const swap = json.options?.find((option) => option.name === 'swap');
  const options = swap && 'options' in swap ? (swap.options ?? []) : [];

  const slotA = options.find((option) => option.name === 'slot_a');
  const slotB = options.find((option) => option.name === 'slot_b');
  const pairs = options.find((option) => option.name === 'pairs');

  expect(slotA?.required).toBeFalsy();
  expect(slotB?.required).toBeFalsy();
  expect(pairs?.required).toBeFalsy();
  expect(pairs?.type).toBe(ApplicationCommandOptionType.String);
  expect(swap && 'description' in swap ? swap.description : '').toMatch(/pairs/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/commands/lobby/lobby.test.ts`

Expected: FAIL — `slot_a` is still required and `pairs` is missing.

- [ ] **Step 3: Wire use-case, command, and docs**

In `src/services/lobby/actions.ts`, import `applyRemapPairs` from `./remap.js` and add:

```typescript
export async function remapLobbyPlayers(input: {
  client: Client;
  hostDiscordId: string;
  matchId?: string | null;
  pairs: string;
}): Promise<LobbyActionResult> {
  const { match, players } = await resolveHostPendingMatch({
    hostDiscordId: input.hostDiscordId,
    matchId: input.matchId,
  });
  const profile = await profileForLeague(match.leagueId);
  const next = applyRemapPairs(players, input.pairs, profile);
  return applyRosterAndSync(input.client, match.id, next);
}
```

In `src/services/lobby/index.ts`:

- Add `remapLobbyPlayers` to the `./actions.js` export list.
- Add:

```typescript
export { applyRemapPairs, parseRemapPairs, resolveSwapForm } from './remap.js';
```

In `src/commands/lobby/lobby.ts`:

1. Import `remapLobbyPlayers`, `parseRemapPairs`, `resolveSwapForm` from `../../services/lobby/index.js`.
2. Change the swap subcommand to:

```typescript
  .addSubcommand((subcommand) =>
    subcommand
      .setName('swap')
      .setDescription('Swap or move seats (two slots, or pairs like 1-7,5-Gohan)')
      .addIntegerOption((option) =>
        option
          .setName('slot_a')
          .setDescription('First occupied slot')
          .setRequired(false)
          .setMinValue(MIN_SLOT)
          .setMaxValue(MAX_SLOT),
      )
      .addIntegerOption((option) =>
        option
          .setName('slot_b')
          .setDescription('Second occupied slot')
          .setRequired(false)
          .setMinValue(MIN_SLOT)
          .setMaxValue(MAX_SLOT),
      )
      .addStringOption((option) =>
        option
          .setName('pairs')
          .setDescription('Comma-separated pairs: 1-7, 5-Gohan, Vegeta-4')
          .setRequired(false)
          .setMaxLength(200),
      )
      .addStringOption((option) =>
        option
          .setName('match_id')
          .setDescription('Pending match id (required if you have more than one)')
          .setRequired(false),
      ),
  )
```

3. Replace the `subcommand === 'swap'` branch with:

```typescript
if (subcommand === 'swap') {
  const form = resolveSwapForm({
    slotA: interaction.options.getInteger('slot_a'),
    slotB: interaction.options.getInteger('slot_b'),
    pairs: interaction.options.getString('pairs'),
  });

  if (form.kind === 'classic') {
    const result = await swapLobbyPlayers({
      client: interaction.client,
      hostDiscordId,
      matchId,
      slotA: form.slotA,
      slotB: form.slotB,
    });
    await interaction.editReply({
      content: `Swapped slots ${form.slotA} and ${form.slotB} in match \`${result.match.id}\`.`,
    });
    return;
  }

  const result = await remapLobbyPlayers({
    client: interaction.client,
    hostDiscordId,
    matchId,
    pairs: form.pairs,
  });
  const n = parseRemapPairs(form.pairs).length;
  await interaction.editReply({
    content: `Applied ${n} seat change(s) in match \`${result.match.id}\`.`,
  });
  return;
}
```

In `docs/discord/public/04-fix-the-lobby.md`, replace the swap line in the slash block with:

```
/lobby swap slot_a:1 slot_b:7
/lobby swap pairs:1-7,5-Gohan
```

Immediately after that code block, add:

```
**Swap pairs:** each side is a slot or a nick (`1-7`, `Gohan-4`). Comma-separated. Occupied dest swaps; empty dest moves.
```

- [ ] **Step 4: Run tests**

Run:

```bash
npx vitest run src/commands/lobby/lobby.test.ts src/services/lobby/remap.test.ts
npx vitest run
```

Expected: PASS, including the new swap command-data test. Full suite stays green (557+ new tests, 0 failures).

- [ ] **Step 5: Commit**

```bash
git add src/services/lobby/actions.ts src/services/lobby/index.ts \
  src/commands/lobby/lobby.ts src/commands/lobby/lobby.test.ts \
  docs/discord/public/04-fix-the-lobby.md
git commit -m "feat(lobby): add /lobby swap pairs"
```

---

## Spec coverage

| Spec section                                                | Task                        |
| ----------------------------------------------------------- | --------------------------- |
| Pair syntax / last `-` / commas                             | Task 1                      |
| Slot vs nick / digit nicks / ACA range                      | Task 2                      |
| Sequential `movePlayer`, prefix errors, no persist          | Task 3                      |
| XOR classic vs pairs; blank pairs absent                    | Task 4                      |
| Optional Discord options, use-case, host docs, success copy | Task 5                      |
| No button / no schema / host-only                           | Task 5 (does not add those) |
| Classic `swapPlayers` unchanged                             | Task 5 classic branch       |
