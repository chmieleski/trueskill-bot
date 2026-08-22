# Independent overall vs hero OpenSkill `rate()` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rate overall and hero on two independent OpenSkill `rate()` calls so a pick no longer taxes league-global Δμ.

**Architecture:** Keep 80/20 `predictWin` blend. Replace dual-entity `[global, hero]` `rate()` / synthetics with overall-only teams then hero-only teams. Share one in-memory helper between `applyMatchRatings` and `simulatePostMatchRatings` so history replay stays in lockstep with persist.

**Tech Stack:** TypeScript ESM, OpenSkill `rate()`, Vitest, Prisma (no schema change)

**Spec:** `docs/superpowers/specs/2026-08-22-independent-overall-hero-rate-design.md`

**Worktree:** `/home/lesk/www/bot/.worktrees/feat-independent-overall-hero-rate` on branch `feat/independent-overall-hero-rate`

## Global Constraints

- Scope: `general` (keyed by `leagueId`; no WC3-only imports in rating core)
- Do not merge `PlayerRating` / `PlayerHeroRating` into one μ
- Do not change 80/20 `ratingEntitiesForBalance` / lobby win%
- Do not change display-ki formula, roster ki numbers, New isolation, or lobby-relative **rules** (still apply the same global-ki offset to both ladders after both `rate()` calls)
- Empty `activeRateable` side: skip **both** team `rate()` calls (no throw)
- Empty hero side: skip **hero** `rate()` only; overall still runs; do not write hero μ/σ or increment `matchesPlayed` when hero `rate()` is skipped
- Quit/griffer synthetics: two N=1 peer losses (overall vs overall, hero vs hero when `heroId` set); still not lobby-scaled
- No ladder backfill; history/flip replay current math
- ESM imports use `.js` extension; named exports
- Conventional Commits on this branch
- English-only (no new user-facing strings)

## File map

| File                                                                     | Role                                                                                        |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `src/services/rating/rating-entities.ts`                                 | `ratingEntitiesForOverall` / `ratingEntitiesForHero`; remove dual `ratingEntitiesForPlayer` |
| `src/services/rating/rating-entities.test.ts`                            | Entity helper tests; keep 80/20 tests unchanged                                             |
| `src/services/rating/rating-update.ts`                                   | `canRunHeroRate`; independent synthetics; two-pass team `rate()`                            |
| `src/services/rating/rating-update.test.ts`                              | `canRunHeroRate`; apply skip-hero; ACA unchanged                                            |
| `src/services/rating/rating-update.simulate.test.ts`                     | Product claim; skip hero `rate()`; quit overall independent of hero                         |
| `src/services/rating/rating-preview.ts`                                  | Comment only (`rate()` no longer dual-entity)                                               |
| `.cursor/rules/openskill-rating.mdc`                                     | Independent ladders; 80/20 stays predictWin-only                                            |
| `docs/superpowers/specs/2026-08-22-player-hero-balance-weight-design.md` | Note apply/synthetics superseded                                                            |

---

### Task 1: Overall / hero entity helpers

**Files:**

- Modify: `src/services/rating/rating-entities.ts`
- Modify: `src/services/rating/rating-entities.test.ts`

**Interfaces:**

- Consumes: existing `MuSigma`
- Produces:
  - `ratingEntitiesForOverall(global: MuSigma): MuSigma[]` → always `[global]`
  - `ratingEntitiesForHero(hero: MuSigma): MuSigma[]` → always `[hero]`
  - Keep `ratingEntitiesForPlayer` until Task 4 so apply still compiles

- [ ] **Step 1: Write the failing tests**

Replace the `ratingEntitiesForPlayer` describe in `src/services/rating/rating-entities.test.ts` with (keep the 80/20 describes):

```ts
import {
  blendedRatingForBalance,
  ratingEntitiesForBalance,
  ratingEntitiesForHero,
  ratingEntitiesForOverall,
  ratingEntitiesForPlayer,
  rosterEntriesWithHeroId,
} from './rating-entities.js';

describe('ratingEntitiesForOverall', () => {
  it('returns only the global entity', () => {
    expect(ratingEntitiesForOverall(G)).toEqual([G]);
  });
});

describe('ratingEntitiesForHero', () => {
  it('returns only the hero entity', () => {
    expect(ratingEntitiesForHero(H)).toEqual([H]);
  });
});
```

Leave the existing `ratingEntitiesForPlayer` tests in place for now.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/services/rating/rating-entities.test.ts`

Expected: FAIL — `ratingEntitiesForOverall` / `ratingEntitiesForHero` are not exported.

- [ ] **Step 3: Add the helpers**

In `src/services/rating/rating-entities.ts`, after the weight constants:

```ts
/** Overall OpenSkill entity for `rate()` / overall synthetics (hero-agnostic). */
export function ratingEntitiesForOverall(global: MuSigma): MuSigma[] {
  return [global];
}

/** Hero OpenSkill entity for `rate()` / hero synthetics. */
export function ratingEntitiesForHero(hero: MuSigma): MuSigma[] {
  return [hero];
}
```

Do not change `ratingEntitiesForBalance` or `ratingEntitiesForPlayer` in this task.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/services/rating/rating-entities.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/rating/rating-entities.ts src/services/rating/rating-entities.test.ts
git commit -m "$(cat <<'EOF'
feat(rating): add overall and hero rate entity helpers

EOF
)"
```

---

### Task 2: `canRunHeroRate`

**Files:**

- Modify: `src/services/rating/rating-update.ts`
- Modify: `src/services/rating/rating-update.test.ts`

**Interfaces:**

- Consumes: `activeRateable` entries with `team` and `heroId`
- Produces: `canRunHeroRate(activeRateable: { team: 1 | 2; heroId: number | null }[]): boolean` — true iff both teams have ≥1 entry with `heroId != null`

- [ ] **Step 1: Write the failing tests**

In `src/services/rating/rating-update.test.ts`, import `canRunHeroRate` next to `canRunTeamRate` and add:

```ts
describe('canRunHeroRate', () => {
  it('requires at least one hero seat on each team', () => {
    expect(
      canRunHeroRate([
        { team: 1, heroId: 1 },
        { team: 2, heroId: 7 },
      ]),
    ).toBe(true);
    expect(
      canRunHeroRate([
        { team: 1, heroId: null },
        { team: 2, heroId: 7 },
      ]),
    ).toBe(false);
    expect(
      canRunHeroRate([
        { team: 1, heroId: 1 },
        { team: 2, heroId: null },
      ]),
    ).toBe(false);
    expect(canRunHeroRate([])).toBe(false);
  });

  it('allows mixed ACA + hero when both teams still have a hero', () => {
    expect(
      canRunHeroRate([
        { team: 1, heroId: null },
        { team: 1, heroId: 2 },
        { team: 2, heroId: 7 },
      ]),
    ).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/services/rating/rating-update.test.ts`

Expected: FAIL — `canRunHeroRate` is not exported.

- [ ] **Step 3: Implement**

In `src/services/rating/rating-update.ts`, immediately after `canRunTeamRate`:

```ts
/** True when both teams have ≥1 hero seat eligible for the hero OpenSkill rate(). */
export function canRunHeroRate(activeRateable: { team: 1 | 2; heroId: number | null }[]): boolean {
  const withHero = activeRateable.filter((entry) => entry.heroId != null);
  const hasTeamA = withHero.some((entry) => entry.team === 1);
  const hasTeamB = withHero.some((entry) => entry.team === 2);
  return hasTeamA && hasTeamB;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/services/rating/rating-update.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/rating/rating-update.ts src/services/rating/rating-update.test.ts
git commit -m "$(cat <<'EOF'
feat(rating): gate hero rate on both teams having a hero

EOF
)"
```

---

### Task 3: Independent quit / griffer synthetics

**Files:**

- Modify: `src/services/rating/rating-update.ts`
- Modify: `src/services/rating/rating-update.simulate.test.ts`

**Interfaces:**

- Consumes: `ratingEntitiesForOverall`, `ratingEntitiesForHero`, `applySyntheticLosses`
- Produces: `applyIndependentSyntheticLosses(global, hero, heroId)` used by `applySyntheticPenalties` and both simulate loops. Two N=1 `rate()` calls; never `[global, hero]` as one team.

- [ ] **Step 1: Write the failing test**

Add to `src/services/rating/rating-update.simulate.test.ts`:

```ts
describe('simulatePostMatchRatings quit synthetics', () => {
  it('moves overall Δμ the same regardless of hero μ/σ', () => {
    const entries = [
      {
        playerId: 'quitA',
        slot: 1,
        team: 1 as const,
        heroId: 1,
        isQuitter: true,
      },
      {
        playerId: 'vetB',
        slot: 7,
        team: 2 as const,
        heroId: null,
        isQuitter: false,
      },
    ];
    const overall = { mu: 28, sigma: 6 };
    const afterCold = simulatePostMatchRatings(
      entries,
      2,
      new Map([
        ['quitA', overall],
        ['vetB', { mu: 25, sigma: 8.333 }],
      ]),
      new Map([['quitA:1', { mu: 25, sigma: 8.333 }]]),
    );
    const afterMain = simulatePostMatchRatings(
      entries,
      2,
      new Map([
        ['quitA', overall],
        ['vetB', { mu: 25, sigma: 8.333 }],
      ]),
      new Map([['quitA:1', { mu: 35, sigma: 3 }]]),
    );

    expect(afterCold.globalByPlayer.get('quitA')!.mu).toBeCloseTo(
      afterMain.globalByPlayer.get('quitA')!.mu,
    );
    expect(afterCold.heroByKey.get('quitA:1')!.mu).not.toBeCloseTo(
      afterMain.heroByKey.get('quitA:1')!.mu,
    );
  });
});
```

Team 1 has only a quitter, so `canRunTeamRate` is false — only synthetics run. Today dual-entity synthetics couple overall Δμ to the hero entity, so this should fail.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/services/rating/rating-update.simulate.test.ts`

Expected: FAIL — overall μ after cold vs main hero synthetics differ.

- [ ] **Step 3: Implement independent synthetics**

In `src/services/rating/rating-update.ts`:

1. Import `ratingEntitiesForOverall`, `ratingEntitiesForHero` (keep `ratingEntitiesForPlayer` until Task 4).
2. Add:

```ts
function applyIndependentSyntheticLosses(
  global: { mu: number; sigma: number },
  hero: { mu: number; sigma: number },
  heroId: number | null,
): { global: Rating; hero?: Rating } {
  const [nextGlobal] = applySyntheticLosses(toOpenSkillRatings(ratingEntitiesForOverall(global)));
  if (!nextGlobal) {
    return { global: rating({ mu: global.mu, sigma: global.sigma }) };
  }
  if (heroId == null) {
    return { global: nextGlobal };
  }
  const [nextHero] = applySyntheticLosses(toOpenSkillRatings(ratingEntitiesForHero(hero)));
  return { global: nextGlobal, hero: nextHero };
}
```

3. In `applySyntheticPenalties`, replace the `applySyntheticLosses(ratingEntitiesForPlayer(...))` block with:

```ts
const updated = applyIndependentSyntheticLosses(global, hero, entry.heroId);
const nextGlobal = updated.global;

await db.playerRating.update({
  where: { leagueId_playerId: { leagueId, playerId: entry.playerId } },
  data: {
    mu: nextGlobal.mu,
    sigma: nextGlobal.sigma,
  },
});

if (entry.heroId == null || !updated.hero) {
  continue;
}

await db.playerHeroRating.update({
  where: {
    leagueId_playerId_heroId: {
      leagueId,
      playerId: entry.playerId,
      heroId: entry.heroId,
    },
  },
  data: {
    mu: updated.hero.mu,
    sigma: updated.hero.sigma,
  },
});
```

Still do **not** increment `matchesPlayed` here.

4. In `simulatePostMatchRatings`, replace **both** quitter and griffer loops with:

```ts
const updated = applyIndependentSyntheticLosses(global, hero, entry.heroId);
globalByPlayer.set(entry.playerId, { mu: updated.global.mu, sigma: updated.global.sigma });
if (entry.heroId != null && updated.hero) {
  heroByKey.set(heroKey(entry.playerId, entry.heroId), {
    mu: updated.hero.mu,
    sigma: updated.hero.sigma,
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/services/rating/rating-update.test.ts src/services/rating/rating-update.simulate.test.ts`

Expected: PASS (including existing 1-entity ACA griffer/quit tests).

- [ ] **Step 5: Commit**

```bash
git add src/services/rating/rating-update.ts src/services/rating/rating-update.simulate.test.ts
git commit -m "$(cat <<'EOF'
feat(rating): split quit synthetics into overall and hero rate calls

EOF
)"
```

---

### Task 4: Two-pass team `rate()` (apply + simulate)

**Files:**

- Modify: `src/services/rating/rating-update.ts`
- Modify: `src/services/rating/rating-update.test.ts`
- Modify: `src/services/rating/rating-update.simulate.test.ts`
- Modify: `src/services/rating/rating-entities.ts` (delete `ratingEntitiesForPlayer`)
- Modify: `src/services/rating/rating-entities.test.ts` (delete dual-entity tests)

**Interfaces:**

- Consumes: `ratingEntitiesForOverall`, `ratingEntitiesForHero`, `canRunHeroRate`, `rosterEntriesWithHeroId`, `canRunTeamRate`
- Produces: internal `rateActiveMatchTeams(...)` → `Map<string, UpdatedPlayerRating>` used by `applyMatchRatings` and `simulatePostMatchRatings`
- Overall register is 1:1 with roster order (stride 1)
- Hero register is 1:1 with `rosterEntriesWithHeroId(team)` order
- If `!canRunHeroRate`, leave `updated.hero` unset so persist skips hero μ/σ and `matchesPlayed`

- [ ] **Step 1: Write the failing product tests**

Add to `src/services/rating/rating-update.simulate.test.ts`:

```ts
describe('independent overall vs hero rate', () => {
  it('gives the same overall Δμ on a cold hero as on a main', () => {
    const overallA = { mu: 32, sigma: 5 };
    const overallB = { mu: 25, sigma: 8.333 };
    const entries = [
      { playerId: 'a', slot: 1, team: 1 as const, heroId: 1, isQuitter: false },
      { playerId: 'b', slot: 7, team: 2 as const, heroId: 7, isQuitter: false },
    ];
    const globals = new Map([
      ['a', overallA],
      ['b', overallB],
    ]);
    const afterCold = simulatePostMatchRatings(
      entries,
      1,
      globals,
      new Map([
        ['a:1', { mu: 25, sigma: 8.333 }],
        ['b:7', { mu: 25, sigma: 8.333 }],
      ]),
    );
    const afterMain = simulatePostMatchRatings(
      entries,
      1,
      globals,
      new Map([
        ['a:1', { mu: 32, sigma: 5 }],
        ['b:7', { mu: 25, sigma: 8.333 }],
      ]),
    );

    const coldOverallDelta = afterCold.globalByPlayer.get('a')!.mu - overallA.mu;
    const mainOverallDelta = afterMain.globalByPlayer.get('a')!.mu - overallA.mu;
    expect(coldOverallDelta).toBeCloseTo(mainOverallDelta);

    const coldHeroDelta = afterCold.heroByKey.get('a:1')!.mu - 25;
    const mainHeroDelta = afterMain.heroByKey.get('a:1')!.mu - 32;
    expect(coldHeroDelta).not.toBeCloseTo(mainHeroDelta);
  });

  it('skips hero rate when one team has no hero seats and still updates overall', () => {
    const entries = [
      { playerId: 'aca', slot: 1, team: 1 as const, heroId: null, isQuitter: false },
      { playerId: 'udbr', slot: 7, team: 2 as const, heroId: 7, isQuitter: false },
    ];
    const startGlobal = new Map([
      ['aca', { mu: 25, sigma: 8.333 }],
      ['udbr', { mu: 25, sigma: 8.333 }],
    ]);
    const startHero = new Map([['udbr:7', { mu: 28, sigma: 7 }]]);
    const after = simulatePostMatchRatings(entries, 1, startGlobal, startHero);

    expect(after.globalByPlayer.get('aca')!.mu).toBeGreaterThan(25);
    expect(after.globalByPlayer.get('udbr')!.mu).toBeLessThan(25);
    expect(after.heroByKey.get('udbr:7')!.mu).toBe(28);
    expect(after.heroByKey.get('udbr:7')!.sigma).toBe(7);
  });
});
```

Add to `src/services/rating/rating-update.test.ts` inside `describe('applyMatchRatings')`:

```ts
it('does not write hero ratings when one team has no hero seats', async () => {
  const playerRating = {
    createMany: vi.fn().mockResolvedValue({ count: 2 }),
    findMany: vi.fn().mockResolvedValue([
      { playerId: 'p1', mu: 25, sigma: 8.333 },
      { playerId: 'p2', mu: 25, sigma: 8.333 },
    ]),
    update: vi.fn().mockResolvedValue({}),
  };
  const playerHeroRating = {
    createMany: vi.fn().mockResolvedValue({ count: 1 }),
    findMany: vi.fn().mockResolvedValue([{ playerId: 'p2', heroId: 7, mu: 28, sigma: 7 }]),
    update: vi.fn().mockResolvedValue({}),
  };
  const db = {
    playerRating,
    playerHeroRating,
    matchPlayer: { findMany: vi.fn().mockResolvedValue([]) },
    playerRankReset: { findMany: vi.fn().mockResolvedValue([]) },
  };
  const roster: RatingRosterEntry[] = [
    { playerId: 'p1', slot: 1, team: 1, heroId: null, isQuitter: false },
    { playerId: 'p2', slot: 7, team: 2, heroId: 7, isQuitter: false },
  ];

  await applyMatchRatings('league-1', roster, 1, db as never);

  expect(playerRating.update).toHaveBeenCalled();
  expect(playerHeroRating.update).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/services/rating/rating-update.simulate.test.ts src/services/rating/rating-update.test.ts`

Expected: FAIL — cold vs main overall Δμ differ; `udbr:7` hero μ moves; `playerHeroRating.update` is called.

- [ ] **Step 3: Implement two-pass `rate()`**

In `src/services/rating/rating-update.ts`:

1. Import `rosterEntriesWithHeroId` from `./rating-entities.js`. Drop `ratingEntitiesForPlayer`.
2. Replace `buildTeamEntities` with:

```ts
function buildOverallTeamEntities(
  team: RatingRosterEntry[],
  globalByPlayer: Map<string, { mu: number; sigma: number }>,
): Rating[] {
  return toOpenSkillRatings(
    team.flatMap((entry) => {
      const global = globalByPlayer.get(entry.playerId) ?? defaultRatingEntity();
      return ratingEntitiesForOverall(global);
    }),
  );
}

function buildHeroTeamEntities(
  team: RatingRosterEntry[],
  heroByKey: Map<string, { mu: number; sigma: number }>,
): Rating[] {
  return toOpenSkillRatings(
    rosterEntriesWithHeroId(team).flatMap((entry) => {
      const hero = heroByKey.get(heroKey(entry.playerId, entry.heroId)) ?? defaultRatingEntity();
      return ratingEntitiesForHero(hero);
    }),
  );
}

function rateActiveMatchTeams(
  activeRateable: RatingRosterEntry[],
  winningTeam: 1 | 2,
  globalByPlayer: Map<string, MuSigma>,
  heroByKey: Map<string, MuSigma>,
  globalGamesByPlayer: Map<string, number>,
): Map<string, UpdatedPlayerRating> {
  const { teamA, teamB } = splitRosterByTeam(activeRateable);
  const winningRoster = winningTeam === 1 ? teamA : teamB;
  const losingRoster = winningTeam === 1 ? teamB : teamA;
  const { preGlobal, preHero } = snapshotPreMatchMuSigma(activeRateable, globalByPlayer, heroByKey);

  const [updatedWinningOverall, updatedLosingOverall] = rate(
    [
      buildOverallTeamEntities(winningRoster, globalByPlayer),
      buildOverallTeamEntities(losingRoster, globalByPlayer),
    ],
    { rank: [1, 2] },
  );

  const updatedByPlayer = new Map<string, UpdatedPlayerRating>();

  const registerOverall = (team: RatingRosterEntry[], ratings: Rating[]): void => {
    for (const [index, entry] of team.entries()) {
      const global = ratings[index];
      if (!global) {
        continue;
      }
      updatedByPlayer.set(entry.playerId, {
        global,
        heroId: entry.heroId,
      });
    }
  };

  registerOverall(winningRoster, updatedWinningOverall);
  registerOverall(losingRoster, updatedLosingOverall);

  if (canRunHeroRate(activeRateable)) {
    const winningHeroRoster = rosterEntriesWithHeroId(winningRoster);
    const losingHeroRoster = rosterEntriesWithHeroId(losingRoster);
    const [updatedWinningHero, updatedLosingHero] = rate(
      [
        buildHeroTeamEntities(winningRoster, heroByKey),
        buildHeroTeamEntities(losingRoster, heroByKey),
      ],
      { rank: [1, 2] },
    );

    const registerHero = (
      team: Array<RatingRosterEntry & { heroId: number }>,
      ratings: Rating[],
    ): void => {
      for (const [index, entry] of team.entries()) {
        const hero = ratings[index];
        const updated = updatedByPlayer.get(entry.playerId);
        if (!updated || !hero) {
          continue;
        }
        updated.hero = hero;
      }
    };

    registerHero(winningHeroRoster, updatedWinningHero);
    registerHero(losingHeroRoster, updatedLosingHero);
  }

  applyLobbyRelativeScalingToResults(
    activeRateable,
    winningTeam,
    preGlobal,
    preHero,
    updatedByPlayer,
    globalGamesByPlayer,
  );

  return updatedByPlayer;
}
```

3. In `applyMatchRatings`, after loading maps and `globalGamesByPlayer`, replace the `splitRosterByTeam` / `rate` / `registerTeam` block with:

```ts
const updatedByPlayer = rateActiveMatchTeams(
  activeRateable,
  winningTeam,
  globalByPlayer,
  heroByKey,
  globalGamesByPlayer,
);
```

Keep the persist loop as-is (`matchesPlayed` increment only when `updated.hero` is set).

4. In `simulatePostMatchRatings`, after the `canRunTeamRate` early return, replace the `rate` / `registerTeam` / scale block with:

```ts
const updatedByPlayer = rateActiveMatchTeams(
  activeRateable,
  winningTeam,
  globalByPlayer,
  heroByKey,
  globalGamesByPlayer,
);
```

Keep the loop that writes `updatedByPlayer` back into the maps.

5. Delete `ratingEntitiesForPlayer` from `rating-entities.ts` and its tests from `rating-entities.test.ts`.

- [ ] **Step 4: Run rating tests**

Run: `npx vitest run src/services/rating`

Expected: new tests PASS. Existing `high-rated loser loses more ki` keeps the inequality (`Math.abs(highDelta) > 15` and low < high×3). If magnitudes change enough to fail, keep the **direction** (high-rated loser |Δki| > 15 and larger than the low teammate) and loosen the constant, do not revert two-pass `rate()`.

Also run: `npx vitest run src/services/rating/rating-entities.test.ts`

Expected: PASS with no `ratingEntitiesForPlayer` tests.

- [ ] **Step 5: Commit**

```bash
git add src/services/rating/rating-update.ts src/services/rating/rating-update.test.ts src/services/rating/rating-update.simulate.test.ts src/services/rating/rating-entities.ts src/services/rating/rating-entities.test.ts
git commit -m "$(cat <<'EOF'
feat(rating): rate overall and hero on independent OpenSkill teams

EOF
)"
```

---

### Task 5: Docs

**Files:**

- Modify: `.cursor/rules/openskill-rating.mdc`
- Modify: `docs/superpowers/specs/2026-08-22-player-hero-balance-weight-design.md`
- Modify: `src/services/rating/rating-preview.ts` (comment on `computeWinChanceFromRatings`)

**Interfaces:**

- Consumes: this spec
- Produces: rules + 80/20 spec that no longer claim dual-entity `rate()`

- [ ] **Step 1: Update OpenSkill rule**

Replace the **Dual entity graph** section and the predictWin paragraph that still says dual `rate()`, with:

````md
## Dual ratings (per human participant)

Each filled human slot still has **two persisted** ratings:

1. **League-global** (`PlayerRating`, PK `leagueId` + `playerId`) — hero-agnostic within that league
2. **Hero** (`PlayerHeroRating`, PK `leagueId` + `playerId` + `heroId`) — mechanics on that slot’s hero (IDs **1–12** for UDBR; slot = hero)

They are **not** teammates in `rate()`. Apply runs two independent OpenSkill calls on the same win/loss:

```text
Team array (overall rate()) = [Player1, Player2, ...]
Team array (hero rate())    = [Hero1, Hero2, ...]   // seats with heroId only
```
````

A full 6v6 is 12 overall entities, then up to 12 hero entities — not 24 in one array. Unbalanced fills (e.g. 4v6) are valid if both teams have ≥1 rateable human. If either team has 0 hero seats, skip the hero `rate()`; overall still runs.

Spec: `docs/superpowers/specs/2026-08-22-independent-overall-hero-rate-design.md`

````

In **Team strength**, keep the 80/20 blend. Change:

- `Public roster ki is unchanged (still two numbers). \`rate()\` / quitter synthetics stay equal dual entities.`
  → `Public roster ki is unchanged (still two numbers). \`rate()\` is the independent ladders above, not this blend.`
- `After the match, OpenSkill updates μ/σ from actual vs expected outcome on the **unblended** dual-entity arrays.`
  → `After the match, OpenSkill updates overall then hero from the actual outcome on those separate arrays.`

In **Edge cases**:

- **Cold start (new hero):** `Missing PlayerHeroRating → create defaults. Overall rate() does not see the new hero, so a veteran’s global Δμ is the same as on a main. The new hero’s high-σ row still absorbs a large swing on the hero ladder.`
- **Quitters:** `N=1 synthetic loss vs a peer dummy on overall, and a second N=1 vs a peer dummy on hero when heroId is set. Excluded from match team rate(). Hero matchesPlayed is not incremented.`

In **Agent constraints**, keep “never persist the 80/20 blend”. Add: `Never feed [global, hero] as one rate() team.`

- [ ] **Step 2: Update the 80/20 spec**

At the top of `docs/superpowers/specs/2026-08-22-player-hero-balance-weight-design.md`, after **Related** (or under Status), add:

```md
**Superseded for apply:** Dual-entity `rate()` / synthetics are replaced by [`2026-08-22-independent-overall-hero-rate-design.md`](./2026-08-22-independent-overall-hero-rate-design.md). This spec remains the source for **predictWin / balance hints only**.
````

Change the Non-goals bullet `Changing OpenSkill rate()...` to past tense / “deferred, then done in independent-overall-hero-rate”. Change Decision + Architecture so `ratingEntitiesForPlayer` is no longer the apply helper; list `ratingEntitiesForOverall` / `ratingEntitiesForHero` instead.

- [ ] **Step 3: Fix the preview comment**

In `src/services/rating/rating-preview.ts`:

```ts
 * Hero slots use an 80% player / 20% hero blend; `rate()` is independent overall then hero.
```

- [ ] **Step 4: Run a focused test + typecheck**

Run: `npx vitest run src/services/rating && npm run typecheck`

Expected: PASS / no `tsc` errors.

- [ ] **Step 5: Commit**

```bash
git add .cursor/rules/openskill-rating.mdc docs/superpowers/specs/2026-08-22-player-hero-balance-weight-design.md src/services/rating/rating-preview.ts
git commit -m "$(cat <<'EOF'
docs: document independent overall and hero OpenSkill rate

EOF
)"
```

---

## Self-review (spec coverage)

| Spec requirement                                                         | Task                                                   |
| ------------------------------------------------------------------------ | ------------------------------------------------------ |
| Two independent `rate()` calls                                           | 4                                                      |
| Overall team = one entity per human                                      | 1, 4                                                   |
| Hero team = `heroId` seats only                                          | 1, 4                                                   |
| Skip both team `rate()` if empty `activeRateable` side                   | unchanged; still `canRunTeamRate`                      |
| Skip hero `rate()` if empty hero side; overall still runs; no hero write | 2, 4                                                   |
| ACA overall-only                                                         | 4 (existing ACA apply test + skip-hero test)           |
| New / quitters excluded from both team `rate()`                          | unchanged partition                                    |
| Independent quit/griffer synthetics                                      | 3                                                      |
| Lobby-relative scale after both `rate()`, global-ki offset, σ unchanged  | 4 (`rateActiveMatchTeams` still calls existing scaler) |
| `matchesPlayed` not on quit; not when hero `rate()` skipped              | 3, 4                                                   |
| Product claim: same overall Δμ cold vs main                              | 4                                                      |
| Apply / simulate lockstep                                                | 4 (shared helper)                                      |
| 80/20 predictWin unchanged                                               | 1 (do not touch balance helpers), 5                    |
| No schema / no backfill                                                  | —                                                      |
| Docs                                                                     | 5                                                      |
