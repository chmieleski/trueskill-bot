# Lobby Swap Commands Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a "Swap commands" field on the Match Lobby with copy-paste `!swap <name> <in-game slot>` lines that turn the real Warcraft lobby (last screenshot/wc3stats read) into the Discord roster.

**Architecture:** Persist the last in-game roster on `Match` (3 nullable columns) whenever a roster is read from the game. A pure planner diffs Discord roster vs snapshot into absolute "put player X in slot Y" moves (stale-safe by construction). A WC3 adapter maps bot slots to in-game slots and formats `!swap`; `discord-sync` passes the rendered lines into `buildMatchLobbyEmbed`.

**Tech Stack:** TypeScript (ESM, `.js` imports), discord.js v14, Prisma 7 + PostgreSQL, Vitest, pnpm + Turborepo.

**Spec:** `docs/superpowers/specs/2026-10-06-lobby-swap-commands-design.md`

## Global Constraints

- Scope labels: snapshot, planner, embed, sync = `general`; `!swap` syntax + slot mapping = `game:warcraft3_udbr` / `game:warcraft3_wos`. No `!swap` literal outside `apps/bot/src/games/warcraft3/`.
- Command format exactly: `!swap <name> <inGameSlot>`; hero names never used.
- In-game slot = `wc3statsSlot + 1` via league `LeagueWc3statsSlotMap` → else game preset map → else bot slot.
- Snapshot written only from game reads (screenshot with ≥1 player, applied wc3stats refresh, lobby creation from screenshot/wc3stats). Never from manual edits, claim/leave, lock, Balance.
- Field only on Match Lobby (PENDING), only when profile `lobbySwapCommand !== 'none'`, a snapshot exists, and lines are non-empty.
- All user-facing strings English. ESM imports use `.js`. Prisma singleton from `apps/bot/src/lib/prisma.ts`; types from `@dbz/db`.
- No new env vars (no SSM changes).
- Before PR: `pnpm typecheck`, `pnpm --filter @dbz/bot exec vitest run`, `pnpm format:check` all green. Conventional Commit PR title.

## Review Focus

- Battle.net tag / casing in names: in-game `Goku#1234` must produce `!swap Goku 3` (raw case, tag stripped) — Task 1 test.
- Player added manually in Discord (not in snapshot): still gets a command using their username — Task 2 test.
- Extra player in the Warcraft lobby who is not on the Discord roster: no command for them, plan still converges for everyone else — Task 2 property test (extras).
- Corrupt / unexpected `inGameRoster` JSON (old rows, manual DB edits): parsed as "no snapshot" → no field, no crash — Task 2 test.
- Event lobbies (no `leagueId`): use the game preset map, no `requireLeagueId` throw — Task 3 test (`leagueSlotMap: null`).

---

## File Structure

| File                                                                                                                    | Responsibility                                                                  |
| ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `packages/db/prisma/schema.prisma`                                                                                      | `Match.inGameRoster`, `inGameRosterAt`, `inGameRosterSource`                    |
| `packages/db/prisma/migrations/20261006200000_match_in_game_roster/migration.sql`                                       | Add the 3 columns                                                               |
| `apps/bot/src/services/player/player-nick.ts`                                                                           | `stripBattleTag` (keeps case)                                                   |
| `apps/bot/src/services/lobby/lobby-ocr.ts`                                                                              | `LobbyPlayer.rawName`; OCR fills it                                             |
| `apps/bot/src/services/wc3stats/wc3stats-roster.ts`                                                                     | wc3stats extract fills `rawName`                                                |
| `apps/bot/src/services/lobby/in-game-roster.ts` (new)                                                                   | Snapshot types, build/parse, `planSwapMoves` (general, pure)                    |
| `apps/bot/src/domain/game-profile.ts`                                                                                   | `lobbySwapCommand` capability                                                   |
| `apps/bot/src/games/warcraft3/bang-swap.ts` (new)                                                                       | `!swap` formatter + bot→in-game slot mapper                                     |
| `apps/bot/src/services/lobby/swap-commands.ts` (new)                                                                    | Dispatch by profile; build lines; load for a match                              |
| `apps/bot/src/services/match/match-service.ts`                                                                          | Persist snapshot in `createPendingMatch` / `replaceMatchRoster`                 |
| `apps/bot/src/services/lobby/discord-sync.ts`                                                                           | Pass snapshot option through `applyRosterAndSync`; render field on pending sync |
| `apps/bot/src/services/lobby/lobby-preview.ts`                                                                          | `swapCommands` embed option + field                                             |
| Call sites: `lobby-screenshot.ts`, `wc3stats-refresh.ts`, `create-from-wc3stats.ts`, `commands/lobby/register-lobby.ts` | Tag game reads with a source                                                    |

---

### Task 1: Schema, migration, and raw in-game names

**Files:**

- Modify: `packages/db/prisma/schema.prisma` (model `Match`, after `lobbyRosterAuthorityAt`)
- Create: `packages/db/prisma/migrations/20261006200000_match_in_game_roster/migration.sql`
- Modify: `apps/bot/src/services/player/player-nick.ts`
- Modify: `apps/bot/src/services/lobby/lobby-ocr.ts` (`LobbyPlayer`, OCR parse loop ~line 98)
- Modify: `apps/bot/src/services/wc3stats/wc3stats-roster.ts` (~line 72, 92)
- Test: `apps/bot/src/services/player/player-nick.test.ts` (create if missing), `apps/bot/src/services/wc3stats/wc3stats-roster.test.ts`, `apps/bot/src/services/lobby/lobby-ocr.test.ts`

**Interfaces:**

- Produces: `stripBattleTag(nick: string): string`; `LobbyPlayer.rawName?: string`; Prisma `Match.inGameRoster: Json | null`, `Match.inGameRosterAt: Date | null`, `Match.inGameRosterSource: string | null`.

- [ ] **Step 1: Write failing tests**

`apps/bot/src/services/player/player-nick.test.ts` (append; merge `stripBattleTag` into the existing import):

```ts
import { describe, expect, it } from 'vitest';
import { normalizeNick, stripBattleTag } from './player-nick.js';

describe('stripBattleTag', () => {
  it('trims and strips #1234 but keeps case', () => {
    expect(stripBattleTag('  Goku#1234 ')).toBe('Goku');
    expect(stripBattleTag('Vegeta')).toBe('Vegeta');
  });

  it('normalizeNick still lowercases the stripped nick', () => {
    expect(normalizeNick('Goku#1234')).toBe('goku');
  });
});
```

`apps/bot/src/services/wc3stats/wc3stats-roster.test.ts` (append):

```ts
describe('extractWc3statsRoster rawName', () => {
  it('keeps the in-game name (case, no battle tag) as rawName', () => {
    const result = extractWc3statsRoster({
      slots: [{ status: 'occupied', player: { name: 'Goku#1234' } } as Wc3statsSlot],
    });
    expect(result.players).toEqual([{ slot: 1, nick: 'goku', rawName: 'Goku' }]);
  });
});
```

(Add `type Wc3statsSlot` to the existing import from `./wc3stats-roster.js` if not already imported.)

`apps/bot/src/services/lobby/lobby-ocr.test.ts` — add `parsePlayersPayload` to the existing import from `./lobby-ocr.js` (line ~25) and append:

```ts
describe('parsePlayersPayload rawName', () => {
  it('keeps the raw OCR nick as rawName', () => {
    const players = parsePlayersPayload('{"players":[{"slot":2,"nick":"Broly#42"}]}');
    expect(players).toEqual([{ slot: 2, nick: 'broly', rawName: 'Broly' }]);
  });
});
```

`parsePlayersPayload` (`lobby-ocr.ts:69`) is module-private today — change `function parsePlayersPayload` to `export function parsePlayersPayload` (no behavior change).

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @dbz/bot exec vitest run src/services/player src/services/wc3stats/wc3stats-roster.test.ts src/services/lobby/lobby-ocr.test.ts`
Expected: FAIL (`stripBattleTag` not exported; `rawName` missing).

- [ ] **Step 3: Implement**

`player-nick.ts`:

```ts
const BATTLE_TAG_SUFFIX = /^(.*)#\d+$/;

/** In-game display nick: trim and strip optional Battle.net `#1234`; case kept. */
export function stripBattleTag(nick: string): string {
  const trimmed = nick.trim();
  return BATTLE_TAG_SUFFIX.exec(trimmed)?.[1] ?? trimmed;
}

/**
 * Canonical in-game nick: trim, strip optional Battle.net `#1234` suffix, lowercase.
 * All Player create/lookup paths must run nicks through this before hitting the DB.
 */
export function normalizeNick(nick: string): string {
  return stripBattleTag(nick).toLowerCase();
}
```

`lobby-ocr.ts` — add to `LobbyPlayer`:

```ts
  /** Exact in-game name (case kept, battle tag stripped) when read from the game. */
  rawName?: string;
```

and in the OCR parse loop replace the push with:

```ts
players.push({
  slot,
  nick: cleanedNick,
  rawName: stripBattleTag(nick),
});
```

(import `stripBattleTag` alongside `normalizeNick`).

`wc3stats-roster.ts` — replace `const nick = normalizeNick(slot.player?.name ?? '');` with:

```ts
const rawName = stripBattleTag(slot.player?.name ?? '');
const nick = rawName.toLowerCase();
```

and `players.push({ slot: heroSlot, nick });` with `players.push({ slot: heroSlot, nick, rawName });` (import `stripBattleTag`; drop the `normalizeNick` import if now unused).

Existing tests that `toEqual` OCR/wc3stats player arrays will now fail on the extra `rawName` key — update those expectations to include `rawName` (raw case of the fixture name).

`schema.prisma` — in `model Match`, after `lobbyRosterAuthorityAt DateTime?`:

```prisma
  /// Last roster read from the game (screenshot OCR / wc3stats): [{ slot, nick, rawName }] in bot slots.
  inGameRoster                Json?
  inGameRosterAt              DateTime?
  /// 'screenshot' | 'wc3stats'
  inGameRosterSource          String?
```

Migration `packages/db/prisma/migrations/20261006200000_match_in_game_roster/migration.sql`:

```sql
-- Last in-game roster read (screenshot OCR or wc3stats) for lobby swap commands.
ALTER TABLE "Match" ADD COLUMN "inGameRoster" JSONB;
ALTER TABLE "Match" ADD COLUMN "inGameRosterAt" TIMESTAMP(3);
ALTER TABLE "Match" ADD COLUMN "inGameRosterSource" TEXT;
```

Then regenerate the client: `pnpm db:generate`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @dbz/bot exec vitest run src/services/player src/services/wc3stats src/services/lobby` and `pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/db/prisma apps/bot/src/services/player apps/bot/src/services/lobby/lobby-ocr.ts apps/bot/src/services/lobby/lobby-ocr.test.ts apps/bot/src/services/wc3stats
git commit -m "feat(lobby): store raw in-game names and add in-game roster columns"
```

---

### Task 2: In-game roster snapshot + swap planner (`general`, pure)

**Files:**

- Create: `apps/bot/src/services/lobby/in-game-roster.ts`
- Test: `apps/bot/src/services/lobby/in-game-roster.test.ts`

**Interfaces:**

- Consumes: `LobbyPlayer` (`slot`, `nick`, `rawName?`), `normalizeNick`.
- Produces:
  - `type InGameRosterSource = 'screenshot' | 'wc3stats'`
  - `type InGameRosterEntry = { slot: number; nick: string; rawName: string }`
  - `toInGameRosterSnapshot(players: ReadonlyArray<LobbyPlayer>): InGameRosterEntry[]`
  - `inGameRosterData(players, source, now?): { inGameRoster: InGameRosterEntry[]; inGameRosterAt: Date; inGameRosterSource: InGameRosterSource }`
  - `parseInGameRoster(value: unknown): InGameRosterEntry[] | null`
  - `parseInGameRosterSource(value: unknown): InGameRosterSource | null`
  - `type SwapMove = { name: string; botSlot: number }`
  - `planSwapMoves(target: ReadonlyArray<Pick<LobbyPlayer, 'slot' | 'nick'>>, snapshot: ReadonlyArray<InGameRosterEntry>): SwapMove[]`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest';
import {
  inGameRosterData,
  parseInGameRoster,
  parseInGameRosterSource,
  planSwapMoves,
  toInGameRosterSnapshot,
  type InGameRosterEntry,
  type SwapMove,
} from './in-game-roster.js';

/** Simulate the host bot: `!swap name slot` swaps name's seat with whatever is in slot. */
function applySwaps(start: Map<number, string>, moves: SwapMove[]): Map<number, string> {
  const seats = new Map(start);
  for (const move of moves) {
    const from = [...seats.entries()].find(
      ([, name]) => name.toLowerCase() === move.name.toLowerCase(),
    )?.[0];
    if (from === undefined) {
      continue; // player not in game: host bot errors, nothing moves
    }
    const occupant = seats.get(move.botSlot);
    seats.delete(from);
    if (occupant !== undefined) {
      seats.set(from, occupant);
    }
    seats.set(move.botSlot, move.name);
  }
  return seats;
}

function seeded(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(items: T[], random: () => number): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
}

describe('toInGameRosterSnapshot / inGameRosterData', () => {
  it('normalizes nick and falls back rawName to nick', () => {
    expect(
      toInGameRosterSnapshot([
        { slot: 1, nick: 'Goku', rawName: 'Goku' },
        { slot: 7, nick: 'broly' },
      ]),
    ).toEqual([
      { slot: 1, nick: 'goku', rawName: 'Goku' },
      { slot: 7, nick: 'broly', rawName: 'broly' },
    ]);
  });

  it('builds the Match update data with source and time', () => {
    const now = new Date('2026-10-06T12:00:00Z');
    expect(inGameRosterData([{ slot: 1, nick: 'goku' }], 'wc3stats', now)).toEqual({
      inGameRoster: [{ slot: 1, nick: 'goku', rawName: 'goku' }],
      inGameRosterAt: now,
      inGameRosterSource: 'wc3stats',
    });
  });
});

describe('parseInGameRoster', () => {
  it('round-trips a valid snapshot', () => {
    const snapshot: InGameRosterEntry[] = [{ slot: 3, nick: 'goku', rawName: 'Goku' }];
    expect(parseInGameRoster(JSON.parse(JSON.stringify(snapshot)))).toEqual(snapshot);
  });

  it('returns null for null, non-arrays, and malformed entries', () => {
    expect(parseInGameRoster(null)).toBeNull();
    expect(parseInGameRoster({ slot: 1 })).toBeNull();
    expect(parseInGameRoster([{ slot: '1', nick: 'a', rawName: 'a' }])).toBeNull();
    expect(parseInGameRoster([{ slot: 1, nick: '', rawName: 'a' }])).toBeNull();
  });

  it('parses the source column', () => {
    expect(parseInGameRosterSource('screenshot')).toBe('screenshot');
    expect(parseInGameRosterSource('wc3stats')).toBe('wc3stats');
    expect(parseInGameRosterSource('other')).toBeNull();
    expect(parseInGameRosterSource(null)).toBeNull();
  });
});

describe('planSwapMoves', () => {
  it('skips players already in their target slot', () => {
    const snapshot = [
      { slot: 1, nick: 'goku', rawName: 'Goku' },
      { slot: 7, nick: 'broly', rawName: 'Broly' },
    ];
    expect(
      planSwapMoves(
        [
          { slot: 1, nick: 'goku' },
          { slot: 7, nick: 'broly' },
        ],
        snapshot,
      ),
    ).toEqual([]);
  });

  it('uses the raw in-game name and absolute target slots', () => {
    const snapshot = [
      { slot: 1, nick: 'goku', rawName: 'Goku' },
      { slot: 7, nick: 'broly', rawName: 'Broly' },
    ];
    expect(
      planSwapMoves(
        [
          { slot: 7, nick: 'goku' },
          { slot: 1, nick: 'broly' },
        ],
        snapshot,
      ),
    ).toEqual([
      { name: 'Broly', botSlot: 1 },
      { name: 'Goku', botSlot: 7 },
    ]);
  });

  it('commands a Discord-only player by username', () => {
    expect(planSwapMoves([{ slot: 2, nick: 'vegeta' }], [])).toEqual([
      { name: 'vegeta', botSlot: 2 },
    ]);
  });

  it('never commands in-game players missing from the Discord roster', () => {
    const moves = planSwapMoves(
      [{ slot: 2, nick: 'goku' }],
      [
        { slot: 1, nick: 'goku', rawName: 'Goku' },
        { slot: 2, nick: 'cell', rawName: 'Cell' },
      ],
    );
    expect(moves).toEqual([{ name: 'Goku', botSlot: 2 }]);
  });

  it('converges from any start: accurate snapshot, unknown start, extras in game', () => {
    const random = seeded(7);
    const slots = Array.from({ length: 12 }, (_, i) => i + 1);
    for (let run = 0; run < 300; run += 1) {
      const humans = Math.floor(random() * 11) + 1;
      const names = Array.from({ length: humans }, (_, i) => `P${i}`);
      const extras = random() < 0.5 ? ['Extra'] : [];
      const targetSlots = shuffled(slots, random).slice(0, humans);
      const target = names.map((name, i) => ({ slot: targetSlots[i]!, nick: name.toLowerCase() }));

      const startSlots = shuffled(slots, random);
      const start = new Map<number, string>();
      [...names, ...extras].forEach((name, i) => start.set(startSlots[i]!, name));
      const snapshot = [...start.entries()].map(([slot, name]) => ({
        slot,
        nick: name.toLowerCase(),
        rawName: name,
      }));

      for (const plan of [planSwapMoves(target, snapshot), planSwapMoves(target, [])]) {
        const end = applySwaps(start, plan);
        for (const { slot, nick } of target) {
          expect(end.get(slot)?.toLowerCase()).toBe(nick);
        }
      }
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @dbz/bot exec vitest run src/services/lobby/in-game-roster.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `in-game-roster.ts`**

```ts
import { normalizeNick } from '../player/player-nick.js';
import type { LobbyPlayer } from './lobby-ocr.js';

export type InGameRosterSource = 'screenshot' | 'wc3stats';

/** One seat of the last roster read from the game, in bot slots. */
export type InGameRosterEntry = { slot: number; nick: string; rawName: string };

/** "Put this player into this bot slot" — absolute, so any order converges. */
export type SwapMove = { name: string; botSlot: number };

/** Snapshot rows from a game read; rawName falls back to the nick. */
export function toInGameRosterSnapshot(players: ReadonlyArray<LobbyPlayer>): InGameRosterEntry[] {
  return players.map((player) => ({
    slot: player.slot,
    nick: normalizeNick(player.nick),
    rawName: player.rawName ?? player.nick,
  }));
}

/** `Match` update data recording a fresh game read. */
export function inGameRosterData(
  players: ReadonlyArray<LobbyPlayer>,
  source: InGameRosterSource,
  now: Date = new Date(),
): {
  inGameRoster: InGameRosterEntry[];
  inGameRosterAt: Date;
  inGameRosterSource: InGameRosterSource;
} {
  return {
    inGameRoster: toInGameRosterSnapshot(players),
    inGameRosterAt: now,
    inGameRosterSource: source,
  };
}

function isEntry(value: unknown): value is InGameRosterEntry {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const entry = value as Record<string, unknown>;
  return (
    Number.isInteger(entry.slot) &&
    typeof entry.nick === 'string' &&
    entry.nick !== '' &&
    typeof entry.rawName === 'string' &&
    entry.rawName !== ''
  );
}

/** Read `Match.inGameRoster` JSON; anything malformed counts as "no snapshot". */
export function parseInGameRoster(value: unknown): InGameRosterEntry[] | null {
  if (!Array.isArray(value) || !value.every(isEntry)) {
    return null;
  }
  return value.map(({ slot, nick, rawName }) => ({ slot, nick, rawName }));
}

export function parseInGameRosterSource(value: unknown): InGameRosterSource | null {
  return value === 'screenshot' || value === 'wc3stats' ? value : null;
}

/**
 * Moves that make the game match `target`. Each move names a player and their
 * final slot; target slots are distinct, so a later move never disturbs an
 * earlier one and the plan converges from any start. The snapshot only skips
 * players it shows already seated — a stale snapshot can drop a line, never
 * produce a wrong swap.
 */
// ponytail: names that prefix another player's name may be ambiguous on prefix-matching host bots.
export function planSwapMoves(
  target: ReadonlyArray<Pick<LobbyPlayer, 'slot' | 'nick'>>,
  snapshot: ReadonlyArray<InGameRosterEntry>,
): SwapMove[] {
  const seen = new Map(snapshot.map((entry) => [entry.nick, entry]));
  return target
    .map((player) => ({ player, inGame: seen.get(normalizeNick(player.nick)) }))
    .filter(({ player, inGame }) => inGame?.slot !== player.slot)
    .map(({ player, inGame }) => ({
      name: inGame?.rawName ?? normalizeNick(player.nick),
      botSlot: player.slot,
    }))
    .sort((a, b) => a.botSlot - b.botSlot);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @dbz/bot exec vitest run src/services/lobby/in-game-roster.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/bot/src/services/lobby/in-game-roster.ts apps/bot/src/services/lobby/in-game-roster.test.ts
git commit -m "feat(lobby): plan stale-safe swap moves from the in-game roster"
```

---

### Task 3: WC3 `!swap` adapter + profile capability + line builder

**Files:**

- Modify: `apps/bot/src/domain/game-profile.ts` (type + both profiles)
- Create: `apps/bot/src/games/warcraft3/bang-swap.ts`
- Create: `apps/bot/src/services/lobby/swap-commands.ts`
- Test: `apps/bot/src/games/warcraft3/bang-swap.test.ts`, `apps/bot/src/services/lobby/swap-commands.test.ts`

**Interfaces:**

- Consumes: `planSwapMoves`, `InGameRosterEntry` (Task 2); `UDBR_WC3STATS_SLOT_MAP`, `WOS_WC3STATS_SLOT_MAP`, `toWc3statsHeroSlotMap`, `type Wc3statsHeroSlotMap` from `services/wc3stats/wc3stats-slot-map.js`.
- Produces:
  - `type LobbySwapCommandKind = 'none' | 'wc3_bang_swap'`; `GameProfile.lobbySwapCommand: LobbySwapCommandKind`
  - `formatBangSwap(name: string, inGameSlot: number): string`
  - `wc3InGameSlot(profile: GameProfile, leagueSlotMap: Wc3statsHeroSlotMap | null, botSlot: number): number`
  - `buildSwapCommandLines(input: { profile: GameProfile; target: ReadonlyArray<Pick<LobbyPlayer, 'slot' | 'nick'>>; snapshot: ReadonlyArray<InGameRosterEntry>; leagueSlotMap: Wc3statsHeroSlotMap | null }): string[]`

- [ ] **Step 1: Write failing tests**

`apps/bot/src/games/warcraft3/bang-swap.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { getGameProfile } from '../../domain/game-profile.js';
import { WARCRAFT3_UDBR_GAME_ID, WARCRAFT3_WOS_GAME_ID } from '../../domain/games.js';
import { formatBangSwap, wc3InGameSlot } from './bang-swap.js';

const udbr = getGameProfile(WARCRAFT3_UDBR_GAME_ID);
const wos = getGameProfile(WARCRAFT3_WOS_GAME_ID);

describe('formatBangSwap', () => {
  it('formats name then slot', () => {
    expect(formatBangSwap('Goku', 6)).toBe('!swap Goku 6');
  });
});

describe('wc3InGameSlot', () => {
  it('uses the UDBR preset when the league has no map (bot 5 → 6, bot 7 → 5)', () => {
    expect(wc3InGameSlot(udbr, null, 1)).toBe(1);
    expect(wc3InGameSlot(udbr, null, 5)).toBe(6);
    expect(wc3InGameSlot(udbr, null, 7)).toBe(5);
    expect(wc3InGameSlot(udbr, null, 12)).toBe(12);
  });

  it('prefers the league slot map (wc3stats index + 1)', () => {
    const leagueMap = new Map([[9, 1]]); // wc3stats index 9 → bot slot 1
    expect(wc3InGameSlot(udbr, leagueMap, 1)).toBe(10);
  });

  it('falls back to the preset when the league map lacks that bot slot', () => {
    const leagueMap = new Map([[9, 1]]);
    expect(wc3InGameSlot(udbr, leagueMap, 7)).toBe(5);
  });

  it('uses the WOS preset for WOS', () => {
    expect(wc3InGameSlot(wos, null, 1)).toBe(1);
  });
});
```

`apps/bot/src/services/lobby/swap-commands.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { getGameProfile, type GameProfile } from '../../domain/game-profile.js';
import { WARCRAFT3_UDBR_GAME_ID } from '../../domain/games.js';
import { buildSwapCommandLines } from './swap-commands.js';

const udbr = getGameProfile(WARCRAFT3_UDBR_GAME_ID);

describe('buildSwapCommandLines', () => {
  it('maps bot slots to in-game slots and sorts by in-game slot', () => {
    const lines = buildSwapCommandLines({
      profile: udbr,
      target: [
        { slot: 5, nick: 'goku' },
        { slot: 7, nick: 'broly' },
      ],
      snapshot: [
        { slot: 7, nick: 'goku', rawName: 'Goku' },
        { slot: 5, nick: 'broly', rawName: 'Broly' },
      ],
      leagueSlotMap: null,
    });
    expect(lines).toEqual(['!swap Broly 5', '!swap Goku 6']);
  });

  it('returns no lines when the game has no swap command', () => {
    const noSwap: GameProfile = { ...udbr, lobbySwapCommand: 'none' };
    expect(
      buildSwapCommandLines({
        profile: noSwap,
        target: [{ slot: 1, nick: 'goku' }],
        snapshot: [],
        leagueSlotMap: null,
      }),
    ).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @dbz/bot exec vitest run src/games/warcraft3 src/services/lobby/swap-commands.test.ts`
Expected: FAIL (modules not found).

- [ ] **Step 3: Implement**

`game-profile.ts` — add the type next to `PostMatchStatsKind`:

```ts
/** In-game lobby command used to re-seat players (`none` = no Swap commands field). */
export type LobbySwapCommandKind = 'none' | 'wc3_bang_swap';
```

add to `GameProfile` after `postMatchStats`:

```ts
/** Lobby re-seat command syntax for the Swap commands field. */
lobbySwapCommand: LobbySwapCommandKind;
```

and `lobbySwapCommand: 'wc3_bang_swap',` to both the UDBR and WOS profile objects (after `postMatchStats`). Fix any test fixtures that build a full `GameProfile` literal (typecheck will list them) by adding `lobbySwapCommand: 'none'`.

`apps/bot/src/games/warcraft3/bang-swap.ts`:

```ts
import type { GameProfile } from '../../domain/game-profile.js';
import { WARCRAFT3_UDBR_GAME_ID, WARCRAFT3_WOS_GAME_ID } from '../../domain/games.js';
import {
  toWc3statsHeroSlotMap,
  UDBR_WC3STATS_SLOT_MAP,
  WOS_WC3STATS_SLOT_MAP,
  type Wc3statsHeroSlotMap,
} from '../../services/wc3stats/wc3stats-slot-map.js';

/** Host-bot command: `!swap <name|slot> <name|slot>`; hero names are not accepted. */
export function formatBangSwap(name: string, inGameSlot: number): string {
  return `!swap ${name} ${inGameSlot}`;
}

const PRESET_MAPS: Record<string, Wc3statsHeroSlotMap> = {
  [WARCRAFT3_UDBR_GAME_ID]: toWc3statsHeroSlotMap(UDBR_WC3STATS_SLOT_MAP),
  [WARCRAFT3_WOS_GAME_ID]: toWc3statsHeroSlotMap(WOS_WC3STATS_SLOT_MAP),
};

function inGameSlotFromMap(map: Wc3statsHeroSlotMap | null | undefined, botSlot: number) {
  for (const [wc3statsIndex, heroSlot] of map ?? []) {
    if (heroSlot === botSlot) {
      return wc3statsIndex + 1;
    }
  }
  return undefined;
}

/**
 * Bot slot → Warcraft lobby slot number (wc3stats index + 1).
 * League slot map first, then the game's preset, then the bot slot itself.
 */
export function wc3InGameSlot(
  profile: GameProfile,
  leagueSlotMap: Wc3statsHeroSlotMap | null,
  botSlot: number,
): number {
  return (
    inGameSlotFromMap(leagueSlotMap, botSlot) ??
    inGameSlotFromMap(PRESET_MAPS[profile.gameId], botSlot) ??
    botSlot
  );
}
```

`apps/bot/src/services/lobby/swap-commands.ts`:

```ts
import type { GameProfile } from '../../domain/game-profile.js';
import { formatBangSwap, wc3InGameSlot } from '../../games/warcraft3/bang-swap.js';
import type { Wc3statsHeroSlotMap } from '../wc3stats/wc3stats-slot-map.js';
import { planSwapMoves, type InGameRosterEntry } from './in-game-roster.js';
import type { LobbyPlayer } from './lobby-ocr.js';

/**
 * Copy-paste in-game commands turning the last game read into the Discord roster,
 * ordered by in-game slot. Empty when the game has no swap command.
 */
export function buildSwapCommandLines(input: {
  profile: GameProfile;
  target: ReadonlyArray<Pick<LobbyPlayer, 'slot' | 'nick'>>;
  snapshot: ReadonlyArray<InGameRosterEntry>;
  leagueSlotMap: Wc3statsHeroSlotMap | null;
}): string[] {
  if (input.profile.lobbySwapCommand === 'none') {
    return [];
  }
  return planSwapMoves(input.target, input.snapshot)
    .map((move) => ({
      name: move.name,
      inGameSlot: wc3InGameSlot(input.profile, input.leagueSlotMap, move.botSlot),
    }))
    .sort((a, b) => a.inGameSlot - b.inGameSlot)
    .map((move) => formatBangSwap(move.name, move.inGameSlot));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @dbz/bot exec vitest run src/games/warcraft3 src/services/lobby/swap-commands.test.ts` and `pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/bot/src/domain/game-profile.ts apps/bot/src/games/warcraft3 apps/bot/src/services/lobby/swap-commands.ts apps/bot/src/services/lobby/swap-commands.test.ts
git commit -m "feat(lobby): add WC3 !swap adapter and swap command lines"
```

---

### Task 4: Persist the snapshot on every game read

**Files:**

- Modify: `apps/bot/src/services/match/match-service.ts` (`CreatePendingMatchInput` ~line 59, `createPendingMatch` create data ~line 507, `ReplaceMatchRosterOptions` ~line 82, `replaceMatchRoster` tx ~line 779)
- Modify: `apps/bot/src/services/lobby/discord-sync.ts` (`applyRosterAndSync` ~line 280)
- Modify: `apps/bot/src/services/lobby/lobby-screenshot.ts` (`applyRosterAndSync` call)
- Modify: `apps/bot/src/services/lobby/wc3stats-refresh.ts` (final `replaceMatchRoster` call)
- Modify: `apps/bot/src/services/lobby/create-from-wc3stats.ts` (`createPendingMatch` call)
- Modify: `apps/bot/src/commands/lobby/register-lobby.ts` (both `createPendingMatch` calls: event ~line 333, league ~line 606)

**Interfaces:**

- Consumes: `inGameRosterData`, `type InGameRosterSource` (Task 2).
- Produces: `CreatePendingMatchInput.inGameRosterSource?: InGameRosterSource`; `ReplaceMatchRosterOptions.inGameRosterSource?: InGameRosterSource`; `applyRosterAndSync(client, matchId, nextPlayers, options?: { inGameRosterSource?: InGameRosterSource })`.

These are orchestration call sites (Prisma + Discord); the data shape is already pinned by Task 2's `inGameRosterData` test. Verification here is typecheck + the full suite + the manual check in Task 6.

- [ ] **Step 1: match-service — create and replace**

Add to `CreatePendingMatchInput` (before `lobbyRosterAuthorityAt`):

```ts
  /** Set when `players` were read from the game; records the in-game roster snapshot. */
  inGameRosterSource?: InGameRosterSource;
```

In `createPendingMatch`, inside the `tx.match.create({ data: { ... } })` object next to `lobbyRosterAuthorityAt: input.lobbyRosterAuthorityAt ?? undefined,` add:

```ts
        ...(input.inGameRosterSource && players.length > 0
          ? inGameRosterData(players, input.inGameRosterSource)
          : {}),
```

Add to `ReplaceMatchRosterOptions`:

```ts
  /** Set when the roster was read from the game; records the in-game roster snapshot. */
  inGameRosterSource?: InGameRosterSource;
```

In `replaceMatchRoster`, right after the `if (options.markLobbyRosterAuthority) { ... }` block inside the transaction:

```ts
if (options.inGameRosterSource && players.length > 0) {
  await tx.match.update({
    where: { id: matchId },
    data: inGameRosterData(players, options.inGameRosterSource),
  });
}
```

(`players` is the function parameter; `withNormalizedNicks` spreads each player, so `rawName` survives either way.) Import: `import { inGameRosterData, type InGameRosterSource } from '../lobby/in-game-roster.js';`.

If Prisma rejects the `InGameRosterEntry[]` as `Json` input, cast at the two call sites: `inGameRoster: data.inGameRoster as Prisma.InputJsonValue` via a spread — keep `inGameRosterData` itself Prisma-free.

- [ ] **Step 2: discord-sync — pass the option through**

```ts
/** Persist a new roster then sync the Discord embed. */
export async function applyRosterAndSync(
  client: Client,
  matchId: string,
  nextPlayers: LobbyPlayer[],
  options: { inGameRosterSource?: InGameRosterSource } = {},
): Promise<LobbyActionResult> {
  const updated = await replaceMatchRoster(matchId, nextPlayers, {
    markLobbyRosterAuthority: true,
    inGameRosterSource: options.inGameRosterSource,
  });
  await syncLobbyDiscordMessage(client, updated, 'pending');
  return { match: updated, players: matchToLobbyPlayers(updated) };
}
```

- [ ] **Step 3: tag the game reads**

- `lobby-screenshot.ts`: `applyRosterAndSync(input.client, match.id, extracted, { inGameRosterSource: 'screenshot' })`.
- `wc3stats-refresh.ts`: `replaceMatchRoster(linked.id, applied.players, { inGameRosterSource: 'wc3stats' })` (only the final applied path; stale and kept-existing paths unchanged).
- `create-from-wc3stats.ts`: add `inGameRosterSource: 'wc3stats',` to the `createPendingMatch` input (empty `players` is ignored by Step 1's guard).
- `register-lobby.ts` event path (~line 333): add `inGameRosterSource: printAttachment ? 'screenshot' : undefined,`.
- `register-lobby.ts` league path (~line 606): add

```ts
      inGameRosterSource:
        source.kind === 'screenshot' ? 'screenshot' : wc3statsGameId ? 'wc3stats' : undefined,
```

Do **not** touch `actions.ts` (manual edits, claim/leave, Balance) — they must not write the snapshot.

- [ ] **Step 4: Verify**

Run: `pnpm typecheck` and `pnpm --filter @dbz/bot exec vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/bot/src/services/match/match-service.ts apps/bot/src/services/lobby apps/bot/src/commands/lobby/register-lobby.ts
git commit -m "feat(lobby): record the in-game roster on screenshot and wc3stats reads"
```

---

### Task 5: Swap commands field on the Match Lobby embed

**Files:**

- Modify: `apps/bot/src/services/lobby/lobby-preview.ts` (`buildMatchLobbyEmbed` options + fields)
- Modify: `apps/bot/src/services/lobby/swap-commands.ts` (add loader)
- Modify: `apps/bot/src/services/lobby/discord-sync.ts` (pending branch of `syncLobbyDiscordMessage`)
- Test: `apps/bot/src/services/lobby/lobby-preview.test.ts`

**Interfaces:**

- Consumes: `buildSwapCommandLines` (Task 3), `parseInGameRoster`, `parseInGameRosterSource`, `type InGameRosterSource` (Task 2), `loadLeagueWc3statsHeroSlotMap`.
- Produces:
  - `type LobbySwapCommands = { lines: string[]; source: InGameRosterSource; observedAt: Date }` (exported from `lobby-preview.ts`)
  - `buildMatchLobbyEmbed(..., { swapCommands?: LobbySwapCommands })`
  - `loadLobbySwapCommands(match: MatchWithPlayers, profile: GameProfile): Promise<LobbySwapCommands | undefined>`

- [ ] **Step 1: Write failing tests** (append to `lobby-preview.test.ts`)

```ts
describe('swap commands field', () => {
  const players = [
    { nick: 'goku', slot: 1 },
    { nick: 'broly', slot: 7 },
  ];
  const observedAt = new Date('2026-10-06T12:00:00Z');

  it('lists one inline-code command per line with source footer', () => {
    const embed = buildMatchLobbyEmbed('m1', players, {
      swapCommands: {
        lines: ['!swap Goku 1', '!swap Broly 5'],
        source: 'screenshot',
        observedAt,
      },
    });
    const field = (embed.data.fields ?? []).find((f) => f.name === 'Swap commands');
    expect(field?.value).toBe(
      '`!swap Goku 1`\n`!swap Broly 5`\n' +
        `_From screenshot · <t:${observedAt.getTime() / 1000}:R>. Refresh or post a screenshot after swapping to confirm._`,
    );
    expect(field?.inline).toBe(false);
  });

  it('omits the field when there are no lines or no swap data', () => {
    const empty = buildMatchLobbyEmbed('m1', players, {
      swapCommands: { lines: [], source: 'wc3stats', observedAt },
    });
    const none = buildMatchLobbyEmbed('m1', players, {});
    for (const embed of [empty, none]) {
      expect((embed.data.fields ?? []).some((f) => f.name === 'Swap commands')).toBe(false);
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @dbz/bot exec vitest run src/services/lobby/lobby-preview.test.ts`
Expected: FAIL (no field).

- [ ] **Step 3: Implement the field**

In `lobby-preview.ts` add (import `type InGameRosterSource` from `./in-game-roster.js`; `time` / `TimestampStyles` are already imported):

```ts
/** Copy-paste in-game commands for the Match Lobby (see swap-commands.ts). */
export type LobbySwapCommands = {
  lines: string[];
  source: InGameRosterSource;
  observedAt: Date;
};

function swapCommandFields(swap: LobbySwapCommands | undefined) {
  if (!swap || swap.lines.length === 0) {
    return [];
  }
  const footer = `_From ${swap.source} · ${time(swap.observedAt, TimestampStyles.RelativeTime)}. Refresh or post a screenshot after swapping to confirm._`;
  return [
    {
      name: 'Swap commands',
      value: [...swap.lines.map((line) => `\`${line}\``), footer].join('\n'),
      inline: false,
    },
  ];
}
```

Add `swapCommands?: LobbySwapCommands;` to the `buildMatchLobbyEmbed` options type, and in its `.addFields(...)` after `...ratingPreviewFields(...)` add `...swapCommandFields(options.swapCommands),`.

- [ ] **Step 4: Implement the loader and sync wiring**

Append to `swap-commands.ts`:

```ts
import type { MatchWithPlayers } from '../match/match-service.js';
import { matchToLobbyPlayers } from '../match/match-service.js';
import { loadLeagueWc3statsHeroSlotMap } from '../wc3stats/wc3stats-slot-map.js';
import { parseInGameRoster, parseInGameRosterSource } from './in-game-roster.js';
import type { LobbySwapCommands } from './lobby-preview.js';

/** Swap commands for a PENDING lobby; undefined when there is no usable snapshot or nothing to do. */
export async function loadLobbySwapCommands(
  match: MatchWithPlayers,
  profile: GameProfile,
): Promise<LobbySwapCommands | undefined> {
  const snapshot = parseInGameRoster(match.inGameRoster);
  const source = parseInGameRosterSource(match.inGameRosterSource);
  if (!snapshot || !source || !match.inGameRosterAt || profile.lobbySwapCommand === 'none') {
    return undefined;
  }
  const leagueSlotMap = match.leagueId ? await loadLeagueWc3statsHeroSlotMap(match.leagueId) : null;
  const lines = buildSwapCommandLines({
    profile,
    target: matchToLobbyPlayers(match),
    snapshot,
    leagueSlotMap,
  });
  return lines.length > 0 ? { lines, source, observedAt: match.inGameRosterAt } : undefined;
}
```

(Merge the new imports into the file's existing import block; keep `import type` for type-only ones.)

In `discord-sync.ts`, pending branch of `syncLobbyDiscordMessage`, before `payload = {`:

```ts
const swapCommands = await loadLobbySwapCommands(match, profile);
```

and pass `swapCommands,` in the `buildMatchLobbyEmbed(match.id, players, { ... })` options. Import `loadLobbySwapCommands` from `./swap-commands.js`.

- [ ] **Step 5: Verify**

Run: `pnpm --filter @dbz/bot exec vitest run` and `pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/bot/src/services/lobby
git commit -m "feat(lobby): show Swap commands on the Match Lobby"
```

---

### Task 6: Docs, verification, PR

**Files:**

- Modify: `.claude/rules/database-domain.md` (Tables → `Match` line)

- [ ] **Step 1: Document the columns**

Change the `**Match**` bullet in `.claude/rules/database-domain.md` to:

```markdown
- **Match** — Up to 6v6 sessions; exactly one of `leagueId` (IHL) or `eventId` (unrated Event); status (unbalanced fills allowed). `inGameRoster` / `inGameRosterAt` / `inGameRosterSource` hold the last roster read from the game (screenshot or wc3stats) for lobby Swap commands — never written by Discord-side edits.
```

- [ ] **Step 2: Full verification**

```bash
pnpm typecheck
pnpm --filter @dbz/bot exec vitest run
pnpm format && pnpm format:check
```

Expected: all green.

- [ ] **Step 3: Manual check (local bot, `pnpm db:up`, `pnpm db:migrate`, `pnpm dev`)**

1. `/register_lobby` with a UDBR screenshot → no Swap commands field (Discord = game).
2. Press **⚖️ Balance teams** → field lists `!swap` lines; names have in-game case; slot numbers use in-game colors (bot 5 → 6, bot 7 → 5).
3. Post a screenshot of the lobby after running the commands → field disappears.
4. Manual **Move** in Discord → field shows one line for that player.

- [ ] **Step 4: Commit, push, PR, merge**

```bash
git add .claude/rules/database-domain.md
git commit -m "docs: document in-game roster columns"
git push -u origin feat/lobby-swap-commands
gh pr create --title "feat(lobby): show in-game swap commands after Balance" --body "Scope: \`general\` (snapshot, planner, embed) + \`game:warcraft3_udbr\` / \`game:warcraft3_wos\` (\`!swap\` adapter).

- Save the last roster read from the game (screenshot OCR or wc3stats) on \`Match\` (3 nullable columns + migration).
- Match Lobby shows a **Swap commands** field: one \`!swap <name> <in-game slot>\` per line turning the game into the Discord roster (after Balance or manual edits).
- Stale-safe: each command seats one player in their absolute final slot, so the list converges from any start; the snapshot only skips players already seated. Footer shows source + age; field disappears once a new read matches.
- Spec: docs/superpowers/specs/2026-10-06-lobby-swap-commands-design.md

Test plan: typecheck, full vitest (incl. convergence property test), format:check, manual lobby check."
gh pr merge --squash --delete-branch
```

The migration runs on deploy (`migrate:deploy`); no env/SSM changes.
