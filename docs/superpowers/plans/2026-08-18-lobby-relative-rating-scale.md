# Lobby-relative rating scale (Approach A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan step-by-step. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After OpenSkill `rate()`, scale each active player's **Δμ** by how far their pre-match global **ki** is from the lobby average — above avg gains less / loses more; below avg the opposite.

**Architecture:** Pure scale helpers in `lobby-relative-scale.ts`. `rating-update.ts` calls them after `rate()` in both `applyMatchRatings` (DB apply) and `simulatePostMatchRatings` (replay/history). **σ unchanged.** `predictWin` / balance hint untouched.

**Tech Stack:** TypeScript ESM, OpenSkill, Vitest, Prisma (read-only for game counts)

**Spec:** `docs/superpowers/specs/2026-08-18-lobby-relative-rating-scale-design.md`

## Global Constraints

- Scope: `general` (OpenSkill apply; keyed by `leagueId`)
- English-only strings; public score is **ki**, never raw μ/σ on embeds
- Do **not** change `predictWin`, lobby preview, or balance-hint inputs
- Do **not** scale quitter synthetic losses
- Hero entity uses **same** win/loss scale as global (offset from global ki)
- Forward-only: no backfill of past matches
- ESM imports use `.js` extension; named exports
- No new production env / SSM keys

## File map

| File                                                 | Role                                             |
| ---------------------------------------------------- | ------------------------------------------------ |
| `src/services/rating/lobby-relative-scale.ts`        | Constants + pure scale/lobby-avg helpers         |
| `src/services/rating/lobby-relative-scale.test.ts`   | Unit tests                                       |
| `src/services/rating/rating-update.ts`               | Wire scaling after `rate()`                      |
| `src/services/rating/rating-update.simulate.test.ts` | Regression: high loser moves more in mixed lobby |
| `src/services/match/match-history-preview.ts`        | Pass pre-match game counts into simulate         |
| `.cursor/rules/openskill-rating.mdc`                 | Document lobby-relative apply                    |

---

### Task 1: Pure lobby scale helpers

**Files:**

- Create: `src/services/rating/lobby-relative-scale.ts`
- Create: `src/services/rating/lobby-relative-scale.test.ts`

**Interfaces:**

- Produces:
  - `LOBBY_OFFSET_KI_FULL_EFFECT = 2000`
  - `LOBBY_SCALE_MIN = 0.5`, `LOBBY_SCALE_MAX = 1.5`
  - `clamp(value: number, min: number, max: number): number`
  - `lobbyOffsetT(offsetKi: number): number` — `clamp(offsetKi / 2000, -1, 1)`
  - `lobbyScaleWin(offsetKi: number): number` — `clamp(1 - 0.5 * t, 0.5, 1.5)`
  - `lobbyScaleLoss(offsetKi: number): number` — `clamp(1 + 0.5 * t, 0.5, 1.5)`
  - `computeLobbyAvgKi(preMatchGlobalKis: number[]): number` — arithmetic mean, 0 if empty
  - `scaleAppliedMu(beforeMu: number, afterMu: number, won: boolean, offsetKi: number): number` — returns `beforeMu + deltaMu * scale`

- [ ] **Step 1: Write failing tests**

```typescript
import { describe, expect, it } from 'vitest';
import {
  computeLobbyAvgKi,
  lobbyScaleLoss,
  lobbyScaleWin,
  scaleAppliedMu,
} from './lobby-relative-scale.js';

describe('lobbyScaleWin', () => {
  it('returns 0.5 at +2000 ki above lobby', () => {
    expect(lobbyScaleWin(2000)).toBe(0.5);
  });
  it('returns 1.0 at lobby average', () => {
    expect(lobbyScaleWin(0)).toBe(1);
  });
  it('returns 1.5 at -2000 ki below lobby', () => {
    expect(lobbyScaleWin(-2000)).toBe(1.5);
  });
});

describe('lobbyScaleLoss', () => {
  it('returns 1.5 at +2000 ki above lobby', () => {
    expect(lobbyScaleLoss(2000)).toBe(1.5);
  });
  it('returns 1.0 at lobby average', () => {
    expect(lobbyScaleLoss(0)).toBe(1);
  });
  it('returns 0.5 at -2000 ki below lobby', () => {
    expect(lobbyScaleLoss(-2000)).toBe(0.5);
  });
});

describe('scaleAppliedMu', () => {
  it('shrinks a win gain when above lobby avg', () => {
    const scaled = scaleAppliedMu(30, 30.4, true, 2000);
    expect(scaled).toBeCloseTo(30.2, 5);
  });
  it('amplifies a loss when above lobby avg', () => {
    const scaled = scaleAppliedMu(30, 29.6, false, 2000);
    expect(scaled).toBeCloseTo(29.4, 5);
  });
});

describe('computeLobbyAvgKi', () => {
  it('averages pre-match global ki values', () => {
    expect(computeLobbyAvgKi([5000, 2000, 2000])).toBeCloseTo(3000, 5);
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL**

Run: `npx vitest run src/services/rating/lobby-relative-scale.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `lobby-relative-scale.ts`**

```typescript
export const LOBBY_OFFSET_KI_FULL_EFFECT = 2000;
export const LOBBY_SCALE_MIN = 0.5;
export const LOBBY_SCALE_MAX = 1.5;
export const LOBBY_SCALE_WIN_COEFF = 0.5;
export const LOBBY_SCALE_LOSS_COEFF = 0.5;

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function lobbyOffsetT(offsetKi: number): number {
  return clamp(offsetKi / LOBBY_OFFSET_KI_FULL_EFFECT, -1, 1);
}

export function lobbyScaleWin(offsetKi: number): number {
  const t = lobbyOffsetT(offsetKi);
  return clamp(1 - LOBBY_SCALE_WIN_COEFF * t, LOBBY_SCALE_MIN, LOBBY_SCALE_MAX);
}

export function lobbyScaleLoss(offsetKi: number): number {
  const t = lobbyOffsetT(offsetKi);
  return clamp(1 + LOBBY_SCALE_LOSS_COEFF * t, LOBBY_SCALE_MIN, LOBBY_SCALE_MAX);
}

export function computeLobbyAvgKi(preMatchGlobalKis: number[]): number {
  if (preMatchGlobalKis.length === 0) {
    return 0;
  }
  return preMatchGlobalKis.reduce((sum, ki) => sum + ki, 0) / preMatchGlobalKis.length;
}

/** Apply lobby-relative scaling to OpenSkill μ result; σ is unchanged by caller. */
export function scaleAppliedMu(
  beforeMu: number,
  afterMu: number,
  won: boolean,
  offsetKi: number,
): number {
  const delta = afterMu - beforeMu;
  const scale = won ? lobbyScaleWin(offsetKi) : lobbyScaleLoss(offsetKi);
  return beforeMu + delta * scale;
}
```

- [ ] **Step 4: Run tests — expect PASS**

Run: `npx vitest run src/services/rating/lobby-relative-scale.test.ts`
Expected: PASS

---

### Task 2: Wire scaling into `simulatePostMatchRatings`

**Files:**

- Modify: `src/services/rating/rating-update.ts`
- Modify: `src/services/rating/rating-update.simulate.test.ts`

**Interfaces:**

- Consumes: all exports from `lobby-relative-scale.ts`, `displayOrdinal` from `rating-math.ts`
- Modifies `simulatePostMatchRatings` signature — add optional 5th arg:
  - `globalGamesByPlayer?: Map<string, number>` (default empty → games `0` for ki)
- Produces: scaled μ in returned maps (same shape as today)

- [ ] **Step 1: Write failing regression test**

Add to `rating-update.simulate.test.ts`:

```typescript
import { displayOrdinal } from './rating-math.js';

it('high-rated loser loses more ki than low-rated loser in same mixed lobby', () => {
  const highMu = 32;
  const highSigma = 5;
  const lowMu = 25;
  const lowSigma = 8.333;
  const highKi = displayOrdinal(highMu, highSigma, 20);
  const lowKi = displayOrdinal(lowMu, lowSigma, 20);

  const entries = [
    { playerId: 'high', slot: 1, team: 1 as const, heroId: 1, isQuitter: false },
    { playerId: 'lowA', slot: 2, team: 1 as const, heroId: 2, isQuitter: false },
    { playerId: 'lowB', slot: 7, team: 2 as const, heroId: 7, isQuitter: false },
    { playerId: 'lowC', slot: 8, team: 2 as const, heroId: 8, isQuitter: false },
  ];
  const startGlobal = new Map([
    ['high', { mu: highMu, sigma: highSigma }],
    ['lowA', { mu: lowMu, sigma: lowSigma }],
    ['lowB', { mu: lowMu, sigma: lowSigma }],
    ['lowC', { mu: lowMu, sigma: lowSigma }],
  ]);
  const games = new Map([
    ['high', 20],
    ['lowA', 20],
    ['lowB', 20],
    ['lowC', 20],
  ]);

  // Team 2 wins -> high loses
  const after = simulatePostMatchRatings(entries, 2, startGlobal, new Map(), games);
  const highDelta = displayOrdinal(after.globalByPlayer.get('high')!.mu, highSigma, 21) - highKi;
  const lowDelta = displayOrdinal(after.globalByPlayer.get('lowA')!.mu, lowSigma, 21) - lowKi;

  expect(Math.abs(highDelta)).toBeGreaterThan(
    displayOrdinal(lowMu, lowSigma, 20) - displayOrdinal(lowMu, lowSigma, 20),
  );
  // High loser should lose MORE than without scaling would allow vs low loser gap narrowing
  expect(Math.abs(highDelta)).toBeGreaterThan(0);
});
```

Refine assertion: compare that **|highDelta| / |lowDelta|** is **closer to 1** than baseline without scaling (optional: run baseline in same test by comparing mu deltas). Minimal pass: `Math.abs(highDelta) > Math.abs(lowDelta) * 0.5` OR high loses more absolute ki than pre-change fixture (~11 vs ~149 baseline — after scale high should increase).

Simpler assertion for test:

```typescript
expect(Math.abs(highDelta)).toBeGreaterThan(15); // was ~11 unscaled in research
expect(Math.abs(lowDelta)).toBeLessThan(Math.abs(highDelta) * 3); // gap narrows from ~2.4x
```

- [ ] **Step 2: Run test — expect FAIL**

Run: `npx vitest run src/services/rating/rating-update.simulate.test.ts`
Expected: FAIL

- [ ] **Step 3: Add helper + integrate in `simulatePostMatchRatings`**

In `rating-update.ts`:

1. Import `displayOrdinal`, scale helpers.
2. Add internal function:

```typescript
function applyLobbyRelativeScalingToResults(
  active: RatingRosterEntry[],
  winningTeam: 1 | 2,
  preGlobal: Map<string, MuSigma>,
  updatedByPlayer: Map<string, { global: Rating; hero?: Rating; heroId: number | null }>,
  globalGamesByPlayer: Map<string, number>,
): void {
  const preKis: number[] = [];
  const preKiByPlayer = new Map<string, number>();

  for (const entry of active) {
    const before = preGlobal.get(entry.playerId);
    if (!before) continue;
    const games = globalGamesByPlayer.get(entry.playerId) ?? 0;
    const ki = displayOrdinal(before.mu, before.sigma, games);
    preKiByPlayer.set(entry.playerId, ki);
    preKis.push(ki);
  }

  const lobbyAvg = computeLobbyAvgKi(preKis);

  for (const entry of active) {
    const before = preGlobal.get(entry.playerId);
    const updated = updatedByPlayer.get(entry.playerId);
    if (!before || !updated) continue;

    const playerKi = preKiByPlayer.get(entry.playerId) ?? lobbyAvg;
    const offsetKi = playerKi - lobbyAvg;
    const won = entry.team === winningTeam;

    const scaledGlobalMu = scaleAppliedMu(
      before.mu,
      updated.global.mu,
      won,
      offsetKi,
    );
    updated.global = { mu: scaledGlobalMu, sigma: updated.global.sigma };

    if (entry.heroId != null && updated.hero) {
      const heroBefore = /* hero pre mu from preGlobal hero map passed separately */;
      // Use same offsetKi; scale hero delta from hero before mu
    }
  }
}
```

Pass `startingHero` hero before values for hero scaling. Hero: `scaleAppliedMu(heroBefore.mu, updated.hero.mu, won, offsetKi)`.

3. Call helper after `registerTeam` loops, before writing back to `globalByPlayer` / `heroByKey`.

4. Extend signature:

```typescript
export function simulatePostMatchRatings(
  entries: RatingRosterEntry[],
  winningTeam: 1 | 2,
  startingGlobal: Map<string, MuSigma>,
  startingHero: Map<string, MuSigma>,
  globalGamesByPlayer: Map<string, number> = new Map(),
): ...
```

- [ ] **Step 4: Run simulate tests — expect PASS**

Run: `npx vitest run src/services/rating/rating-update.simulate.test.ts`

---

### Task 3: Wire scaling into `applyMatchRatings`

**Files:**

- Modify: `src/services/rating/rating-update.ts`

**Interfaces:**

- Consumes: `loadMatchDisplayStatsByPlayer`, `gamesByPlayerFromStats` from `rank-reset-display.ts`
- At apply time (match completing), game counts are **pre-match** because this match is not yet COMPLETED in DB

- [ ] **Step 1: Load game counts alongside globals**

In `applyMatchRatings`, after `playerIds` resolved:

```typescript
const displayStats = await loadMatchDisplayStatsByPlayer(leagueId, playerIds, db);
const globalGamesByPlayer = gamesByPlayerFromStats(displayStats);
```

- [ ] **Step 2: Reuse same `applyLobbyRelativeScalingToResults` helper**

Before DB updates loop (after `registerTeam`), call helper with:

- `preGlobal` = map built from DB rows before rate (copy mu/sigma before mutate)
- `updatedByPlayer` from rate
- `globalGamesByPlayer`

**Important:** Snapshot `preGlobal` from DB **before** `rate()` mutates in-memory maps if sharing references — clone `{ mu, sigma }` per player.

- [ ] **Step 3: Run full rating test suite**

Run: `npx vitest run src/services/rating/`
Expected: PASS

---

### Task 4: Match history replay parity

**Files:**

- Modify: `src/services/match/match-history-preview.ts`

- [ ] **Step 1: Load `globalGames` before simulate**

In `rebuildCompletedRatingPreview`, move `loadGlobalGamesBeforeMatch(...)` **before** `simulatePostMatchRatings` call.

- [ ] **Step 2: Pass games map as 5th argument**

```typescript
afterMaps = simulatePostMatchRatings(
  rosterEntries,
  winningTeam,
  globalByPlayer,
  heroMuOnlyMap,
  globalGames,
);
```

- [ ] **Step 3: Manual smoke**

Run: `npx vitest run src/services/match/` (if tests exist) or rebuild one match in dev.

---

### Task 5: Docs + rules

**Files:**

- Modify: `.cursor/rules/openskill-rating.mdc`

- [ ] **Step 1: Add section "Lobby-relative μ scaling"**

Document:

- After `rate()`, Δμ scaled by offset from lobby avg global ki
- Constants: 2000 ki full effect, 0.5–1.5× clamps
- Quitters excluded; predictWin unchanged
- Link to spec

- [ ] **Step 2: Run full test suite**

Run: `npm test` or `npx vitest run`
Expected: PASS

---

## Self-review (spec coverage)

| Spec requirement                     | Task                         |
| ------------------------------------ | ---------------------------- |
| Post-rate μ scaler                   | 2, 3                         |
| σ unchanged                          | 2, 3 (only mu written)       |
| Lobby avg = mean global pre-match ki | 1, 2                         |
| Hero same scale as global            | 2                            |
| Quitters unchanged                   | 2, 3 (only `active` entries) |
| simulate + apply parity              | 2, 3, 4                      |
| predictWin untouched                 | no changes to preview        |
| Forward-only                         | no migration task            |
| Unit + regression tests              | 1, 2                         |
| openskill-rating.mdc                 | 5                            |

## Success verification

After all tasks, re-run:

```bash
npx tsx scripts/analyze-lobby-rating-deltas.ts
```

Check aggregate: **above-avg LOSS** avg |Δki| should increase vs baseline **−58**; ratio high/low losers in mixed matches should move toward **< 2.4×** (tuning may need follow-up).
