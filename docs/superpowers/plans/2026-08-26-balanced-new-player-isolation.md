# Balanced New-player isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Freeze New seats only when pairable across teams (`k = min(newA, newB)` among non-quit New); excess / one-sided New participate in team OpenSkill `rate()`.

**Architecture:** Change `partitionRosterForRating` only (recompute freeze from `wasNewPlayer` + `team` + `slot`). No schema change. Apply/simulate already consume `activeRateable` / `newNonQuit`; update tests that assumed always-exclude. Docs/rules sync.

**Tech Stack:** TypeScript ESM, OpenSkill, Vitest

**Spec:** `docs/superpowers/specs/2026-08-26-balanced-new-player-isolation-design.md`

## Global Constraints

- Scope: `general` (league-keyed rating core; no WC3-only imports)
- English-only user-facing strings / docs
- Pair-off among **non-quit** New only; New quitters stay on synthetic quit path and do **not** count toward `k`
- Freeze **k lowest slots** per team; leftover New → `activeRateable`
- `newNonQuit` return bucket = **frozen** New only (μ/σ freeze + idle-streak reset path)
- No new Prisma columns; re-rate derives freeze from `wasNewPlayer` + team + slot
- ESM `.js` imports; named exports; Conventional Commits
- Do not retroactively rewrite historical payouts already stored under always-exclude

## File map

| File                                                 | Role                                                                                  |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `src/services/rating/rating-update.ts`               | Pair-off logic in `partitionRosterForRating`                                          |
| `src/services/rating/rating-update.test.ts`          | Partition unit cases + idle-reset case for one-sided New                              |
| `src/services/rating/rating-update.simulate.test.ts` | Simulate: keep 1v1 freeze; add one-sided rates; keep all-New skip                     |
| `.cursor/rules/openskill-rating.mdc`                 | New-player isolation bullet                                                           |
| Specs already written                                | `2026-08-26-…` + amended `2026-08-22-…` (include in docs commit if not committed yet) |

---

### Task 1: Partition pair-off — failing tests then implement

**Files:**

- Modify: `src/services/rating/rating-update.ts` (`partitionRosterForRating`, ~91–101)
- Modify: `src/services/rating/rating-update.test.ts` (`describe('partitionRosterForRating')`)
- Modify: `src/services/rating/rating-update.simulate.test.ts` (`describe('simulatePostMatchRatings with New')`)
- Modify: `src/services/rating/rating-update.test.ts` (idle-decay New test ~290–305)

**Interfaces:**

- Consumes: roster entries with `isQuitter`, `wasNewPlayer?`, **`team: 1 | 2`**, **`slot: number`**
- Produces: unchanged shape `{ quitters, newNonQuit, activeRateable }` where `newNonQuit` = frozen paired New only; `activeRateable` = non-quitters not in frozen set (veterans + excess New)

- [ ] **Step 1: Update / add failing partition tests**

In `rating-update.test.ts`, change the one-sided New test and add pair-off cases. Require `team` on fixtures used for New logic.

Replace `puts non-quit New into newNonQuit…` with balanced + unbalanced cases:

```typescript
it('freezes paired New (1v1) and leaves veterans rateable', () => {
  const { quitters, newNonQuit, activeRateable } = partitionRosterForRating([
    { slot: 1, team: 1 as const, isQuitter: false, wasNewPlayer: true },
    { slot: 2, team: 1 as const, isQuitter: false, wasNewPlayer: false },
    { slot: 7, team: 2 as const, isQuitter: false, wasNewPlayer: true },
    { slot: 8, team: 2 as const, isQuitter: false, wasNewPlayer: false },
  ]);

  expect(newNonQuit.map((entry) => entry.slot).sort()).toEqual([1, 7]);
  expect(activeRateable.map((entry) => entry.slot).sort()).toEqual([2, 8]);
  expect(quitters).toEqual([]);
});

it('rates one-sided New (k=0) instead of freezing', () => {
  const { newNonQuit, activeRateable, quitters } = partitionRosterForRating([
    { slot: 1, team: 1 as const, isQuitter: false, wasNewPlayer: false },
    { slot: 2, team: 1 as const, isQuitter: false, wasNewPlayer: false },
    { slot: 7, team: 2 as const, isQuitter: false, wasNewPlayer: true },
    { slot: 8, team: 2 as const, isQuitter: true, wasNewPlayer: true },
  ]);

  expect(newNonQuit).toEqual([]);
  expect(activeRateable.map((entry) => entry.slot).sort()).toEqual([1, 2, 7]);
  expect(quitters.map((entry) => entry.slot)).toEqual([8]);
});

it('freezes k lowest slots per team and rates excess New (2v1)', () => {
  const { newNonQuit, activeRateable } = partitionRosterForRating([
    { slot: 1, team: 1 as const, isQuitter: false, wasNewPlayer: true },
    { slot: 3, team: 1 as const, isQuitter: false, wasNewPlayer: true },
    { slot: 2, team: 1 as const, isQuitter: false, wasNewPlayer: false },
    { slot: 7, team: 2 as const, isQuitter: false, wasNewPlayer: true },
    { slot: 8, team: 2 as const, isQuitter: false, wasNewPlayer: false },
  ]);

  // k=1 → freeze slot 1 (lowest New on T1) and slot 7; excess New slot 3 rates
  expect(newNonQuit.map((entry) => entry.slot).sort()).toEqual([1, 7]);
  expect(activeRateable.map((entry) => entry.slot).sort()).toEqual([2, 3, 8]);
});

it('does not count New quitters toward k', () => {
  const { newNonQuit, activeRateable, quitters } = partitionRosterForRating([
    { slot: 1, team: 1 as const, isQuitter: true, wasNewPlayer: true },
    { slot: 2, team: 1 as const, isQuitter: false, wasNewPlayer: false },
    { slot: 7, team: 2 as const, isQuitter: false, wasNewPlayer: true },
    { slot: 8, team: 2 as const, isQuitter: false, wasNewPlayer: false },
  ]);

  expect(quitters.map((entry) => entry.slot)).toEqual([1]);
  expect(newNonQuit).toEqual([]);
  expect(activeRateable.map((entry) => entry.slot).sort()).toEqual([2, 7, 8]);
});
```

Keep existing non-New / missing-`wasNewPlayer` tests; add `team` where needed so the generic still typechecks (use `team: 1` / `team: 2` on every entry once the signature requires `team` + `slot`).

In `rating-update.simulate.test.ts`:

- Keep `freezes New non-quit μ…` (already 1v1 New — still freezes).
- Add:

```typescript
it('rates one-sided New μ when the other team has no non-quit New', () => {
  const entries = [
    {
      playerId: 'vetA',
      slot: 1,
      team: 1 as const,
      heroId: null,
      isQuitter: false,
      wasNewPlayer: false,
    },
    {
      playerId: 'newB',
      slot: 7,
      team: 2 as const,
      heroId: null,
      isQuitter: false,
      wasNewPlayer: true,
    },
  ];
  const start = new Map([
    ['vetA', { mu: 32, sigma: 5 }],
    ['newB', { mu: 25, sigma: 8.333 }],
  ]);

  const { globalByPlayer } = simulatePostMatchRatings(entries, 1, start, new Map());

  expect(globalByPlayer.get('vetA')!.mu).toBeGreaterThan(32);
  expect(globalByPlayer.get('newB')!.mu).not.toBe(25);
});
```

- Keep `skips team rate when both sides are only New` (still valid: k=1 freezes both finishers).

Fix idle test `resets idle decay streak even when New freeze skips team rate`: under pair-off, one New vs one veteran **rates** the New. Change roster to **1v1 New + one veteran each** so freeze still happens, **or** rename and assert one-sided New gets a full μ write. Prefer freeze path:

```typescript
it('resets idle decay streak for frozen New who skip team rate', async () => {
  const db = heroNullDb();
  const roster: RatingRosterEntry[] = [
    { playerId: 'new1', slot: 1, team: 1, heroId: null, isQuitter: false, wasNewPlayer: true },
    { playerId: 'vet1', slot: 2, team: 1, heroId: null, isQuitter: false, wasNewPlayer: false },
    { playerId: 'new2', slot: 7, team: 2, heroId: null, isQuitter: false, wasNewPlayer: true },
    { playerId: 'vet2', slot: 8, team: 2, heroId: null, isQuitter: false, wasNewPlayer: false },
  ];
  // mock findMany to return all four player ratings…
  await applyMatchRatings('league-1', roster, 1, COMPLETED_AT, db as never);
  // assert new1/new2 updates are activity-reset-only; vet1/vet2 get μ/σ writes
});
```

Mirror whatever `heroNullDb` / `activityResetData` pattern the neighboring idle tests already use so the test stays consistent (read those helpers in the same file before editing).

- [ ] **Step 2: Run tests — expect partition / simulate failures**

Run:

```bash
npx vitest run src/services/rating/rating-update.test.ts src/services/rating/rating-update.simulate.test.ts
```

Expected: FAIL on new pair-off / one-sided expectations (old always-exclude still freezes slot 7 alone).

- [ ] **Step 3: Implement pair-off in `partitionRosterForRating`**

Replace the function in `rating-update.ts` with:

```typescript
export function partitionRosterForRating<
  T extends { isQuitter: boolean; wasNewPlayer?: boolean; team: 1 | 2; slot: number },
>(entries: T[]): { quitters: T[]; newNonQuit: T[]; activeRateable: T[] } {
  const quitters = entries.filter((entry) => entry.isQuitter);
  const nonQuit = entries.filter((entry) => !entry.isQuitter);
  const nonQuitNew = nonQuit.filter((entry) => entry.wasNewPlayer === true);

  const newOnTeam = (team: 1 | 2) =>
    nonQuitNew.filter((entry) => entry.team === team).sort((a, b) => a.slot - b.slot);

  const team1New = newOnTeam(1);
  const team2New = newOnTeam(2);
  const k = Math.min(team1New.length, team2New.length);

  const frozen = new Set<T>([...team1New.slice(0, k), ...team2New.slice(0, k)]);

  return {
    quitters,
    newNonQuit: nonQuitNew.filter((entry) => frozen.has(entry)),
    activeRateable: nonQuit.filter((entry) => !frozen.has(entry)),
  };
}
```

Update the comment above idle reset if it still says all New skip team rate — frozen only.

Fix any TypeScript call sites that pass objects missing `team`/`slot` into `partitionRosterForRating` (grep callers; roster entries already have both).

- [ ] **Step 4: Re-run tests — expect pass**

```bash
npx vitest run src/services/rating/rating-update.test.ts src/services/rating/rating-update.simulate.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/rating/rating-update.ts \
  src/services/rating/rating-update.test.ts \
  src/services/rating/rating-update.simulate.test.ts
git commit -m "$(cat <<'EOF'
fix(rating): freeze New only when pairable across teams

EOF
)"
```

---

### Task 2: Docs / rules sync

**Files:**

- Modify: `.cursor/rules/openskill-rating.mdc` (New player isolation table row)
- Add (if uncommitted): `docs/superpowers/specs/2026-08-26-balanced-new-player-isolation-design.md`
- Modify (if uncommitted): `docs/superpowers/specs/2026-08-22-new-player-rating-isolation-design.md`
- Add: `docs/superpowers/plans/2026-08-26-balanced-new-player-isolation.md` (this plan)

**Interfaces:** none (docs only)

- [ ] **Step 1: Update openskill-rating rule bullet**

Replace the **New player isolation** row with text matching the spec, e.g.:

> **New player isolation** | `PlayerRating.isNewPlayer` → among non-quit New, freeze `k = min(newA,newB)` lowest slots per team; excess New rate. Quitters (incl. New) stay on synthetic path and do not count toward `k`. After removing frozen New + quitters, if either team has 0 rateable humans → skip team `rate()`. Snapshot `wasNewPlayer`; auto-clear when g ≥ 5. Spec: `2026-08-26-balanced-new-player-isolation-design.md`.

- [ ] **Step 2: Commit docs**

```bash
git add .cursor/rules/openskill-rating.mdc \
  docs/superpowers/specs/2026-08-26-balanced-new-player-isolation-design.md \
  docs/superpowers/specs/2026-08-22-new-player-rating-isolation-design.md \
  docs/superpowers/plans/2026-08-26-balanced-new-player-isolation.md
git commit -m "$(cat <<'EOF'
docs(rating): balanced New pair-off isolation

EOF
)"
```

---

## Spec coverage (self-review)

| Spec requirement                           | Task                            |
| ------------------------------------------ | ------------------------------- |
| Pair-off `k = min(newA,newB)` non-quit New | Task 1                          |
| Lowest-slot freeze                         | Task 1                          |
| Excess / one-sided New rate                | Task 1                          |
| Quitters not in `k`                        | Task 1                          |
| Equal New still freeze                     | Task 1 (1v1 tests)              |
| Degenerate skip when only New              | Task 1 (existing simulate test) |
| No schema / recompute from snapshot        | Task 1 (no Prisma)              |
| Idle reset for frozen New                  | Task 1 (idle test rewrite)      |
| Docs / openskill rule                      | Task 2                          |
| Display `· New` / calibrating              | unchanged — no task             |
| Suggest / auto-clear                       | unchanged — no task             |
