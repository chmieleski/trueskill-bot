# Lobby Balance Hint Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On Match Lobby, when OpenSkill win chance is outside 45–55%, show one advisory Balance hint (best single swap or empty-slot move) scored with the same dual-entity `predictWin` math as the rating preview.

**Architecture:** Pure search in `lobby-balance.ts` enumerates cross-team swaps and moves into empty slots, scores each candidate in-memory, and returns the best improving move. `loadLobbyRatingPreview` batch-loads destination hero ratings and attaches `balanceSuggestion` to the DTO. `buildMatchLobbyEmbed` renders a Balance hint field; Match In Progress does not.

**Tech Stack:** Node.js + TypeScript ESM, `openskill` `predictWin`, Vitest

**Spec:** [docs/superpowers/specs/2026-08-13-lobby-balance-hint-design.md](../specs/2026-08-13-lobby-balance-hint-design.md)

## Global Constraints

- User-facing strings in **English**
- Dual-entity teams: `[global, hero, …]`; `heroId = slot` (1–12)
- Win chance via `predictWin` only — never invent Elo formulas; never call `rate()`
- Public embeds never show raw μ
- Advisory only — no Apply button / auto roster mutation
- ESM imports use `.js` extensions
- Prefer Prisma singleton and `createLogger`
- Commits only when the user asks (skip commit steps unless requested)

## File structure

| File                                 | Responsibility                                                                    |
| ------------------------------------ | --------------------------------------------------------------------------------- |
| `src/services/lobby-balance.ts`      | Gate, enumerate candidates, score, pick; `BalanceSuggestion` type + format helper |
| `src/services/lobby-balance.test.ts` | Unit tests for gate, search, ties, empty-team rejection                           |
| `src/services/rating-preview.ts`     | Batch hero ratings for destinations; call suggest; extend DTO                     |
| `src/services/lobby-preview.ts`      | Match Lobby Balance hint field only                                               |
| `src/services/lobby-preview.test.ts` | Assert hint text on lobby embed; absent on in-progress                            |

---

### Task 1: Pure balance suggestion module (TDD)

**Files:**

- Create: `src/services/lobby-balance.ts`
- Create: `src/services/lobby-balance.test.ts`

**Interfaces:**

- Produces:
  - `BalanceSuggestion` type (same shape as spec)
  - `isUnbalancedWinChance(teamAPercent: number): boolean`
  - `suggestBalanceMove(roster, lookup, currentWinChance): BalanceSuggestion | undefined`
  - `formatBalanceHint(suggestion: BalanceSuggestion): string`
  - `MuSigma` / `BalanceRatingLookup` types for in-memory μ/σ

- [ ] **Step 1: Write failing tests**

Create `src/services/lobby-balance.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  formatBalanceHint,
  isUnbalancedWinChance,
  suggestBalanceMove,
  type BalanceRatingLookup,
  type BalanceRosterEntry,
  type MuSigma,
} from './lobby-balance.js';

const DEFAULT: MuSigma = { mu: 25, sigma: 8.333 };

function lookupFromMaps(
  globals: Record<string, MuSigma>,
  heroes: Record<string, MuSigma>,
): BalanceRatingLookup {
  return {
    global: (playerId) => globals[playerId] ?? DEFAULT,
    hero: (playerId, heroId) => heroes[`${playerId}:${heroId}`] ?? DEFAULT,
  };
}

describe('isUnbalancedWinChance', () => {
  it('is true outside 45–55 inclusive band edges', () => {
    expect(isUnbalancedWinChance(44)).toBe(true);
    expect(isUnbalancedWinChance(56)).toBe(true);
    expect(isUnbalancedWinChance(45)).toBe(false);
    expect(isUnbalancedWinChance(55)).toBe(false);
    expect(isUnbalancedWinChance(50)).toBe(false);
  });
});

describe('suggestBalanceMove', () => {
  it('returns undefined when current win chance is balanced', () => {
    const roster: BalanceRosterEntry[] = [
      { playerId: 'a', slot: 1, heroId: 1, nick: 'Alice' },
      { playerId: 'b', slot: 7, heroId: 7, nick: 'Bob' },
    ];
    const lookup = lookupFromMaps({}, {});
    expect(
      suggestBalanceMove(roster, lookup, { teamAPercent: 50, teamBPercent: 50 }),
    ).toBeUndefined();
  });

  it('rejects moves that would empty a team', () => {
    // 1v2: only A player moving to B empty slot would empty A — must not suggest that
    // unless a swap exists. With one on A, swaps are possible with B players.
    const roster: BalanceRosterEntry[] = [
      { playerId: 'strong', slot: 1, heroId: 1, nick: 'Strong' },
      { playerId: 'w1', slot: 7, heroId: 7, nick: 'Weak1' },
      { playerId: 'w2', slot: 8, heroId: 8, nick: 'Weak2' },
    ];
    const lookup = lookupFromMaps(
      {
        strong: { mu: 40, sigma: 2 },
        w1: { mu: 20, sigma: 8 },
        w2: { mu: 20, sigma: 8 },
      },
      {},
    );
    const suggestion = suggestBalanceMove(roster, lookup, {
      teamAPercent: 90,
      teamBPercent: 10,
    });
    // If a suggestion exists, both teams must still have ≥1 after applying it
    if (suggestion) {
      const next = new Map(roster.map((e) => [e.slot, e]));
      if (suggestion.kind === 'move') {
        const moving = next.get(suggestion.fromSlot)!;
        next.delete(suggestion.fromSlot);
        next.set(suggestion.toSlot, {
          ...moving,
          slot: suggestion.toSlot,
          heroId: suggestion.toSlot,
        });
      } else {
        const a = next.get(suggestion.fromSlot)!;
        const b = next.get(suggestion.toSlot)!;
        next.set(suggestion.fromSlot, {
          ...b,
          slot: suggestion.fromSlot,
          heroId: suggestion.fromSlot,
        });
        next.set(suggestion.toSlot, { ...a, slot: suggestion.toSlot, heroId: suggestion.toSlot });
      }
      const teamA = [...next.values()].filter((e) => e.slot <= 6);
      const teamB = [...next.values()].filter((e) => e.slot > 6);
      expect(teamA.length).toBeGreaterThanOrEqual(1);
      expect(teamB.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('prefers an improving swap when it beats staying put', () => {
    // Strong on A alone vs two weak on B → swap Strong with a weak should improve
    const roster: BalanceRosterEntry[] = [
      { playerId: 'strong', slot: 1, heroId: 1, nick: 'Strong' },
      { playerId: 'w1', slot: 7, heroId: 7, nick: 'Weak1' },
      { playerId: 'mid', slot: 8, heroId: 8, nick: 'Mid' },
    ];
    const lookup = lookupFromMaps(
      {
        strong: { mu: 40, sigma: 2 },
        w1: { mu: 18, sigma: 8 },
        mid: { mu: 25, sigma: 5 },
      },
      {},
    );
    const suggestion = suggestBalanceMove(roster, lookup, {
      teamAPercent: 85,
      teamBPercent: 15,
    });
    expect(suggestion).toBeDefined();
    expect(suggestion!.kind).toBe('swap');
    expect(suggestion!.fromNick).toBe('Strong');
    expect(
      suggestion!.resultingWinChance.teamAPercent + suggestion!.resultingWinChance.teamBPercent,
    ).toBe(100);
    const imbalance = Math.abs(50 - suggestion!.resultingWinChance.teamAPercent);
    expect(imbalance).toBeLessThan(Math.abs(50 - 85));
  });

  it('can suggest a move into an empty slot when that improves balance', () => {
    // 1v3 skew: moving one B player onto empty A slot can help
    const roster: BalanceRosterEntry[] = [
      { playerId: 'a1', slot: 1, heroId: 1, nick: 'A1' },
      { playerId: 'b1', slot: 7, heroId: 7, nick: 'B1' },
      { playerId: 'b2', slot: 8, heroId: 8, nick: 'B2' },
      { playerId: 'b3', slot: 9, heroId: 9, nick: 'B3' },
    ];
    const lookup = lookupFromMaps(
      {
        a1: { mu: 22, sigma: 6 },
        b1: { mu: 30, sigma: 4 },
        b2: { mu: 30, sigma: 4 },
        b3: { mu: 30, sigma: 4 },
      },
      {},
    );
    const suggestion = suggestBalanceMove(roster, lookup, {
      teamAPercent: 20,
      teamBPercent: 80,
    });
    expect(suggestion).toBeDefined();
    expect(Math.abs(50 - suggestion!.resultingWinChance.teamAPercent)).toBeLessThan(
      Math.abs(50 - 20),
    );
  });

  it('on ties prefers swap over move, then lower fromSlot', () => {
    // Construct equal-improvement case is brittle with real predictWin;
    // instead assert comparator helpers via two candidates with identical
    // resulting percents by calling suggest on a tiny roster where swap
    // and move are both improving — if both yield same |50-p|, kind === 'swap'.
    // Fallback: unit-test pickBalanceSuggestion if exported for testing.
    expect(true).toBe(true); // replaced in Step 3 with real tie fixture or exported picker test
  });
});

describe('formatBalanceHint', () => {
  it('formats swap and move lines', () => {
    expect(
      formatBalanceHint({
        kind: 'swap',
        fromSlot: 3,
        toSlot: 9,
        fromNick: 'Alice',
        toNick: 'Bob',
        resultingWinChance: { teamAPercent: 52, teamBPercent: 48 },
      }),
    ).toBe('Swap Alice (3) ↔ Bob (9) → ~52% / 48%');

    expect(
      formatBalanceHint({
        kind: 'move',
        fromSlot: 3,
        toSlot: 10,
        fromNick: 'Alice',
        resultingWinChance: { teamAPercent: 51, teamBPercent: 49 },
      }),
    ).toBe('Move Alice (3) → slot 10 → ~51% / 49%');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/services/lobby-balance.test.ts`

Expected: FAIL (module not found / exports missing)

- [ ] **Step 3: Implement `lobby-balance.ts`**

Create `src/services/lobby-balance.ts`:

```ts
import { predictWin } from 'openskill';
import { roundWinPercents, splitRosterByTeam, toOpenSkillRatings } from './rating-math.js';

const TEAM_A_MAX = 6;
const ALL_SLOTS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] as const;

export type MuSigma = { mu: number; sigma: number };

export type BalanceRosterEntry = {
  playerId: string;
  slot: number;
  heroId: number;
  nick: string;
};

export type BalanceRatingLookup = {
  global: (playerId: string) => MuSigma;
  hero: (playerId: string, heroId: number) => MuSigma;
};

export type BalanceSuggestion = {
  kind: 'swap' | 'move';
  fromSlot: number;
  toSlot: number;
  fromNick: string;
  toNick?: string;
  resultingWinChance: { teamAPercent: number; teamBPercent: number };
};

export function isUnbalancedWinChance(teamAPercent: number): boolean {
  return teamAPercent < 45 || teamAPercent > 55;
}

function imbalance(teamAPercent: number): number {
  return Math.abs(50 - teamAPercent);
}

function teamCountsOk(roster: BalanceRosterEntry[]): boolean {
  const { teamA, teamB } = splitRosterByTeam(roster);
  return teamA.length >= 1 && teamB.length >= 1;
}

function winChanceForRoster(
  roster: BalanceRosterEntry[],
  lookup: BalanceRatingLookup,
): { teamAPercent: number; teamBPercent: number } | undefined {
  if (!teamCountsOk(roster)) {
    return undefined;
  }

  const { teamA, teamB } = splitRosterByTeam(roster);
  const entities = (team: BalanceRosterEntry[]) => {
    const list: MuSigma[] = [];
    for (const entry of team) {
      list.push(lookup.global(entry.playerId));
      list.push(lookup.hero(entry.playerId, entry.heroId));
    }
    return toOpenSkillRatings(list);
  };

  const [pA, pB] = predictWin([entities(teamA), entities(teamB)]);
  return roundWinPercents(pA ?? 0.5, pB ?? 0.5);
}

function applySwap(
  roster: BalanceRosterEntry[],
  slotA: number,
  slotB: number,
): BalanceRosterEntry[] {
  return roster.map((entry) => {
    if (entry.slot === slotA) {
      const other = roster.find((e) => e.slot === slotB)!;
      return { ...entry, slot: slotB, heroId: slotB, nick: other.nick, playerId: other.playerId };
    }
    if (entry.slot === slotB) {
      const other = roster.find((e) => e.slot === slotA)!;
      return { ...entry, slot: slotA, heroId: slotA, nick: other.nick, playerId: other.playerId };
    }
    return entry;
  });
}

function applyMove(
  roster: BalanceRosterEntry[],
  fromSlot: number,
  toSlot: number,
): BalanceRosterEntry[] {
  return roster.map((entry) =>
    entry.slot === fromSlot ? { ...entry, slot: toSlot, heroId: toSlot } : entry,
  );
}

/** Exposed for tie-break unit tests. */
export function compareSuggestions(a: BalanceSuggestion, b: BalanceSuggestion): number {
  const imbDiff =
    imbalance(a.resultingWinChance.teamAPercent) - imbalance(b.resultingWinChance.teamAPercent);
  if (imbDiff !== 0) {
    return imbDiff;
  }
  if (a.kind !== b.kind) {
    return a.kind === 'swap' ? -1 : 1;
  }
  if (a.fromSlot !== b.fromSlot) {
    return a.fromSlot - b.fromSlot;
  }
  return a.toSlot - b.toSlot;
}

export function suggestBalanceMove(
  roster: BalanceRosterEntry[],
  lookup: BalanceRatingLookup,
  currentWinChance: { teamAPercent: number; teamBPercent: number },
): BalanceSuggestion | undefined {
  if (!isUnbalancedWinChance(currentWinChance.teamAPercent)) {
    return undefined;
  }

  const currentImbalance = imbalance(currentWinChance.teamAPercent);
  const occupied = new Set(roster.map((e) => e.slot));
  const emptySlots = ALL_SLOTS.filter((slot) => !occupied.has(slot));
  const teamA = roster.filter((e) => e.slot <= TEAM_A_MAX);
  const teamB = roster.filter((e) => e.slot > TEAM_A_MAX);

  const candidates: BalanceSuggestion[] = [];

  for (const a of teamA) {
    for (const b of teamB) {
      const next = applySwap(roster, a.slot, b.slot);
      const wc = winChanceForRoster(next, lookup);
      if (!wc || imbalance(wc.teamAPercent) >= currentImbalance) {
        continue;
      }
      candidates.push({
        kind: 'swap',
        fromSlot: a.slot,
        toSlot: b.slot,
        fromNick: a.nick,
        toNick: b.nick,
        resultingWinChance: wc,
      });
    }
  }

  for (const entry of roster) {
    for (const toSlot of emptySlots) {
      const next = applyMove(roster, entry.slot, toSlot);
      if (!teamCountsOk(next)) {
        continue;
      }
      const wc = winChanceForRoster(next, lookup);
      if (!wc || imbalance(wc.teamAPercent) >= currentImbalance) {
        continue;
      }
      candidates.push({
        kind: 'move',
        fromSlot: entry.slot,
        toSlot,
        fromNick: entry.nick,
        resultingWinChance: wc,
      });
    }
  }

  if (candidates.length === 0) {
    return undefined;
  }

  candidates.sort(compareSuggestions);
  return candidates[0];
}

export function formatBalanceHint(suggestion: BalanceSuggestion): string {
  const { teamAPercent, teamBPercent } = suggestion.resultingWinChance;
  if (suggestion.kind === 'swap') {
    return `Swap ${suggestion.fromNick} (${suggestion.fromSlot}) ↔ ${suggestion.toNick} (${suggestion.toSlot}) → ~${teamAPercent}% / ${teamBPercent}%`;
  }
  return `Move ${suggestion.fromNick} (${suggestion.fromSlot}) → slot ${suggestion.toSlot} → ~${teamAPercent}% / ${teamBPercent}%`;
}
```

**Fix `applySwap`:** The sketch above incorrectly swaps nick/playerId via map. Prefer building two entry objects explicitly:

```ts
function applySwap(
  roster: BalanceRosterEntry[],
  slotA: number,
  slotB: number,
): BalanceRosterEntry[] {
  const a = roster.find((e) => e.slot === slotA)!;
  const b = roster.find((e) => e.slot === slotB)!;
  return roster.map((entry) => {
    if (entry.slot === slotA) {
      return { playerId: b.playerId, nick: b.nick, slot: slotA, heroId: slotA };
    }
    if (entry.slot === slotB) {
      return { playerId: a.playerId, nick: a.nick, slot: slotB, heroId: slotB };
    }
    return entry;
  });
}
```

Replace the placeholder tie test with:

```ts
it('compareSuggestions prefers swap over move, then lower fromSlot', () => {
  const base = {
    resultingWinChance: { teamAPercent: 52, teamBPercent: 48 },
    fromNick: 'x',
  };
  const swap = { ...base, kind: 'swap' as const, fromSlot: 2, toSlot: 9, toNick: 'y' };
  const move = { ...base, kind: 'move' as const, fromSlot: 1, toSlot: 10 };
  expect(compareSuggestions(swap, move)).toBeLessThan(0);

  const swapHigh = { ...swap, fromSlot: 3 };
  const swapLow = { ...swap, fromSlot: 1 };
  expect(compareSuggestions(swapLow, swapHigh)).toBeLessThan(0);
});
```

Import `compareSuggestions` in the test file.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/services/lobby-balance.test.ts`

Expected: PASS

- [ ] **Step 5: Commit (only if user asked)**

```bash
git add src/services/lobby-balance.ts src/services/lobby-balance.test.ts
git commit -m "feat: add OpenSkill lobby balance suggestion search"
```

---

### Task 2: Wire suggestion into rating preview DTO

**Files:**

- Modify: `src/services/rating-preview.ts`
- Re-export or import `BalanceSuggestion` from `lobby-balance.ts` on `LobbyRatingPreview`

**Interfaces:**

- Consumes: `suggestBalanceMove`, `isUnbalancedWinChance`, `BalanceRatingLookup` from `lobby-balance.ts`
- Produces: `LobbyRatingPreview.balanceSuggestion?: BalanceSuggestion`

- [ ] **Step 1: Extend DTO**

In `rating-preview.ts`, import types and add optional field:

```ts
import { suggestBalanceMove, type BalanceSuggestion } from './lobby-balance.js';

export type { BalanceSuggestion };

export interface LobbyRatingPreview {
  players: LobbyRatingPlayerLine[];
  winChance?: {
    teamAPercent: number;
    teamBPercent: number;
  };
  balanceSuggestion?: BalanceSuggestion;
}
```

- [ ] **Step 2: Batch-load hero ratings for all destinations**

Inside `loadLobbyRatingPreview`, after ensuring current ratings, expand the hero query so every roster `playerId` has rows for heroes `1..12` (createMany skipDuplicates, then findMany). Build:

```ts
const lookup: BalanceRatingLookup = {
  global: (playerId) => {
    const row = globalByPlayer.get(playerId);
    return row ? { mu: row.mu, sigma: row.sigma } : defaultMuSigma();
  },
  hero: (playerId, heroId) => {
    const row = heroByKey.get(`${playerId}:${heroId}`);
    return row ? { mu: row.mu, sigma: row.sigma } : defaultMuSigma();
  },
};
```

Concrete ensure + fetch pattern (replace the current heroes `OR: sorted.map(current hero only)` block):

```ts
await prisma.playerHeroRating.createMany({
  data: sorted.flatMap((entry) =>
    ALL_HERO_IDS.map((heroId) => ({
      playerId: entry.playerId,
      heroId,
    })),
  ),
  skipDuplicates: true,
});

const heroes = await prisma.playerHeroRating.findMany({
  where: { playerId: { in: playerIds } },
});
```

Where `ALL_HERO_IDS = [1,2,...,12]`. Keep global ensure as today. Build `heroByKey` from the full set. Existing player lines still use each entry’s **current** `heroId` for display ki.

- [ ] **Step 3: Attach suggestion after winChance**

After computing `winChance`:

```ts
const winChance = roundWinPercents(pA ?? 0.5, pB ?? 0.5);
const balanceSuggestion = suggestBalanceMove(
  sorted.map((e) => ({
    playerId: e.playerId,
    slot: e.slot,
    heroId: e.heroId,
    nick: e.nick,
  })),
  lookup,
  winChance,
);

return { players, winChance, balanceSuggestion };
```

Wrap suggestion in try/catch only if needed — outer try already omits everything on failure. If `suggestBalanceMove` throws, catch locally, log, omit suggestion but keep winChance:

```ts
let balanceSuggestion: BalanceSuggestion | undefined;
try {
  balanceSuggestion = suggestBalanceMove(/* ... */);
} catch (error) {
  log.warn({ err: error }, 'Failed to compute balance suggestion');
}
```

- [ ] **Step 4: Sanity-check**

Run: `npm test -- src/services/lobby-balance.test.ts src/services/rating-math.test.ts`  
Run: `npx tsc --noEmit`

Expected: PASS

- [ ] **Step 5: Commit (only if user asked)**

```bash
git add src/services/rating-preview.ts
git commit -m "feat: attach balance suggestion to lobby rating preview"
```

---

### Task 3: Embed Balance hint on Match Lobby

**Files:**

- Modify: `src/services/lobby-preview.ts`
- Modify: `src/services/lobby-preview.test.ts`

**Interfaces:**

- Consumes: `formatBalanceHint`, `LobbyRatingPreview.balanceSuggestion`
- Produces: embed field `Balance hint` on Match Lobby only

- [ ] **Step 1: Write failing embed tests**

Add to `lobby-preview.test.ts`:

```ts
import { buildMatchInProgressEmbed, buildMatchLobbyEmbed } from './lobby-preview.js';

describe('balance hint on embeds', () => {
  it('shows Balance hint on Match Lobby when suggestion present', () => {
    const embed = buildMatchLobbyEmbed(
      'm1',
      [
        { nick: 'Alice', slot: 1 },
        { nick: 'Bob', slot: 7 },
      ],
      {
        ratingPreview: {
          players: [
            { slot: 1, nick: 'Alice', globalOrdinal: 1000, heroOrdinal: 1000 },
            { slot: 7, nick: 'Bob', globalOrdinal: 1000, heroOrdinal: 1000 },
          ],
          winChance: { teamAPercent: 70, teamBPercent: 30 },
          balanceSuggestion: {
            kind: 'swap',
            fromSlot: 1,
            toSlot: 7,
            fromNick: 'Alice',
            toNick: 'Bob',
            resultingWinChance: { teamAPercent: 52, teamBPercent: 48 },
          },
        },
      },
    );
    const fields = embed.data.fields ?? [];
    const hint = fields.find((f) => f.name === 'Balance hint');
    expect(hint?.value).toBe('Swap Alice (1) ↔ Bob (7) → ~52% / 48%');
  });

  it('omits Balance hint on Match In Progress even if DTO has suggestion', () => {
    const embed = buildMatchInProgressEmbed(
      'm1',
      [
        { nick: 'Alice', slot: 1 },
        { nick: 'Bob', slot: 7 },
      ],
      {
        ratingPreview: {
          players: [
            { slot: 1, nick: 'Alice', globalOrdinal: 1000, heroOrdinal: 1000 },
            { slot: 7, nick: 'Bob', globalOrdinal: 1000, heroOrdinal: 1000 },
          ],
          winChance: { teamAPercent: 70, teamBPercent: 30 },
          balanceSuggestion: {
            kind: 'move',
            fromSlot: 7,
            toSlot: 2,
            fromNick: 'Bob',
            resultingWinChance: { teamAPercent: 51, teamBPercent: 49 },
          },
        },
      },
    );
    const fields = embed.data.fields ?? [];
    expect(fields.some((f) => f.name === 'Balance hint')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify fail**

Run: `npm test -- src/services/lobby-preview.test.ts`

Expected: FAIL (no Balance hint field)

- [ ] **Step 3: Implement embed field**

In `lobby-preview.ts`:

```ts
import { formatBalanceHint } from './lobby-balance.js';

function balanceHintFields(preview: LobbyRatingPreview | undefined) {
  if (!preview?.balanceSuggestion) {
    return [];
  }
  return [
    {
      name: 'Balance hint',
      value: formatBalanceHint(preview.balanceSuggestion),
      inline: false,
    },
  ];
}
```

In `buildMatchLobbyEmbed` `addFields`, after `...ratingPreviewFields(...)`, add `...balanceHintFields(options.ratingPreview)`.

Do **not** add `balanceHintFields` to `buildMatchInProgressEmbed`.

Optional optimization (spec): skip computing suggestion for in-progress sync — only if there is a separate code path. If both use `loadLobbyRatingPreview`, leaving suggestion unused on in-progress is fine for v1.

- [ ] **Step 4: Run tests**

Run: `npm test -- src/services/lobby-preview.test.ts src/services/lobby-balance.test.ts`

Expected: PASS

- [ ] **Step 5: Commit (only if user asked)**

```bash
git add src/services/lobby-preview.ts src/services/lobby-preview.test.ts
git commit -m "feat: show lobby balance hint on Match Lobby embed"
```

---

### Task 4: Manual smoke + plan checklist

**Files:** none (verification)

- [ ] **Step 1: Full unit suite**

Run: `npm test`

Expected: PASS

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`

Expected: PASS

- [ ] **Step 3: Manual Discord smoke (dev bot)**

1. Create a lobby with a clearly skewed roster (strong vs weak / uneven fill)
2. Confirm win % outside 45–55 and a **Balance hint** field appears
3. Manually apply the suggested Move/Swap
4. Confirm embed refreshes; hint updates or disappears when inside 45–55
5. Start match — In Progress embed has win % but **no** Balance hint

---

## Spec coverage (self-review)

| Spec requirement                             | Task                      |
| -------------------------------------------- | ------------------------- |
| Greedy single move (swap + empty move)       | Task 1                    |
| 45–55 gate                                   | Task 1                    |
| Strict improvement + tie-break               | Task 1                    |
| Dual-entity `predictWin` + cold-start heroes | Tasks 1–2                 |
| Batch destination hero ratings               | Task 2                    |
| DTO `balanceSuggestion`                      | Task 2                    |
| Match Lobby field copy                       | Task 3                    |
| No hint on In Progress                       | Task 3                    |
| Advisory only / no AI                        | All (no Apply, no Gemini) |
| Failure omits hint                           | Task 2 local catch        |

## Placeholder / consistency check

- Types `BalanceSuggestion`, `BalanceRatingLookup`, `MuSigma` named consistently across tasks
- `formatBalanceHint` strings match spec exactly
- No TBD/TODO left in plan steps
