# Lobby-relative rating gain/loss — Design

**Date:** 2026-08-18  
**Status:** Approved (Approach A — 2026-08-18)  
**Scope:** `general` (OpenSkill apply path; keyed by `leagueId`)  
**Plan:** `docs/superpowers/plans/2026-08-18-lobby-relative-rating-scale.md`

## Goal

When a player’s skill is far from the **lobby average**, match outcomes should move their public **ki** in a way that feels fair relative to that lobby — not only relative to team win probability.

| vs lobby average | On win        | On loss       |
| ---------------- | ------------- | ------------- |
| Above average    | Gain **less** | Lose **more** |
| Below average    | Gain **more** | Lose **less** |

**Example:** A ~5k player in a ~1–3k lobby should gain less for a win and lose more for a loss than a ~1k player in the same lobby.

## Non-goals

- Replacing OpenSkill with classic Elo / Glicko
- Cross-league or global rating pools
- Changing display ki formula (`KI_OFFSET`, `KI_SCALE`, z-blend) unless we explicitly choose a display-only layer (see approaches)
- Retroactive recalculation of past completed matches
- Per-hero-only scaling without league-global scaling (both entities should stay aligned unless product says otherwise)

---

## Research summary (2026-08-18)

### ClickUp task

Task **869ek4q74** — _Scale rating gain/loss vs lobby average_ — asks for lobby-relative dampening and notes that OpenSkill already weights expected outcomes via `rate()`. Open question from task: **extra dampening on top of OpenSkill** vs **display/ki-layer tweak**.

### Current implementation

- Match apply: `applyMatchRatings` → OpenSkill `rate()` on dual-entity team arrays (`global` + `hero` per human) — see `src/services/rating/rating-update.ts`.
- Public ki deltas shown on completed embeds: `displayOrdinal` before/after (`src/services/rating/rating-preview.ts`).
- Veterans converge to **low σ** (~2–5); newcomers stay **high σ** (~6–8.3). Low σ **dampens all μ movement** — wins and losses — per OpenSkill design (`openskill-rating.mdc`).

### Database (local Docker clone = production — 2026-08-18 recheck)

| Fact                       | Value             |
| -------------------------- | ----------------- |
| Completed matches          | **41**            |
| Player-match rows analyzed | **443**           |
| MatchRatingSnapshot rows   | 606               |
| UDBR league players rated  | 148 (μ 18.3–32.9) |

Script: `scripts/analyze-lobby-rating-deltas.ts` (re-run with `npx tsx scripts/analyze-lobby-rating-deltas.ts`).

**Aggregate global ki Δ** (offset vs lobby average ±200 ki):

| Cohort              | n   | Avg ki Δ | Desired direction                                    |
| ------------------- | --- | -------- | ---------------------------------------------------- |
| Above avg, **WIN**  | 97  | **+62**  | Gain less ✓ (below avg wins +208)                    |
| Below avg, **WIN**  | 101 | **+208** | Gain more ✓                                          |
| Above avg, **LOSS** | 94  | **−58**  | Lose **more** ✗ (currently lose **less**)            |
| Below avg, **LOSS** | 104 | **−81**  | Lose less ✓ (but only because high loses too little) |

**Same match, both on losing team** (39 cases, ki spread > 800): low-rated loser typically loses **~2.4×** more ki than the high-rated loser (median ratio |low|/|high| ≈ 2.4).

Example (`cmstgk7r`, lobby avg ~3290):

| Player              | Pre-match ki | Global ki Δ |
| ------------------- | ------------ | ----------- |
| notverriegod (high) | 4904         | **−99**     |
| sekai (low)         | 1455         | **−256**    |

**Nuanced conclusion:** Player complaint is **valid for losses**, partially **already true for wins**. OpenSkill + low σ means veterans gain less on wins (good) but also **lose less** on losses (bad vs task spec). Fix should focus on **asymmetric loss scaling**, not re-tuning wins from scratch.

### Simulations (`simulatePostMatchRatings`, dual entity 6v6)

Scenario: **one ~5k veteran + eleven ~2k players** (realistic mixed lobby).

| Outcome                   | High (~5k) global ki Δ | Low (~2k) winner ki Δ | Low loser ki Δ |
| ------------------------- | ---------------------- | --------------------- | -------------- |
| High team wins (expected) | **+10**                | +177                  | −148           |
| High team loses (upset)   | **−11**                | +178                  | −149           |

Scenario: **1v1 dual entity**

| Outcome            | High (~5k) ki Δ | Low (~2k) ki Δ |
| ------------------ | --------------- | -------------- |
| High wins          | +30             | −319           |
| High loses (upset) | **−30**         | **+631**       |

### Root-cause analysis

1. **Sigma dampening (primary)** — Veterans (low σ) absorb almost no μ swing; newcomers (high σ) absorb most of it. This is _by design_ in OpenSkill, but players read ki deltas, not μ.
2. **Dual-entity team dilution** — In 6v6, each human is 2 of ~12 team entities; per-player global μΔ can be ~0.05 even when team outcome is decisive.
3. **OpenSkill expected outcome is team-level** — A 5k player on a 5k+2k×5 team is still a **favorite**; when that team loses, OpenSkill treats it as an upset for the _team_, but the high player's **individual** entity barely moves because σ is low.
4. **Display ki is non-linear in σ** — Same μΔ yields smaller ki Δ when σ is low (veteran on z=2.5).

**Conclusion:** The complaint is **legitimate** under current math. OpenSkill's team expected-outcome weighting does **not** produce lobby-relative _per-player_ swings in the direction players expect. An additional mechanism is needed if product wants “5k in a 2k lobby loses big on upset.”

---

## Locked: apply layer (from ClickUp scope)

ClickUp scope is `general` **(OpenSkill apply; keyed by** `leagueId`**)** — not a display-only tweak.

| Option                               | Verdict                                                              |
| ------------------------------------ | -------------------------------------------------------------------- |
| A — Post-`rate()` μ delta scaler     | **Chosen** — persisted apply; ladder + embeds stay aligned           |
| B — Display ki delta multiplier only | Rejected — contradicts task scope; `/rank` would disagree with embed |
| C — σ / prior tweak                  | Rejected — side-effects on `predictWin` and balance hints            |

Scale **Δμ after** `rate()`; leave **σ** from OpenSkill unchanged.

---

## Approaches

### Approach A — Post-apply μ delta scaler (recommended)

After `rate()` returns updated entities, adjust each **human global** (and optionally hero) entity:

```text
lobbyAvgKi = mean(displayOrdinal(global μ, σ, games) for calibrated active humans)
             // games >= 5; if none calibrated → all active humans
playerKi   = displayOrdinal(this player global before match)
offset     = playerKi − lobbyAvgKi   // signed

scaleWin  = f(offset)   // offset > 0 → scaleWin  < 1 (less gain)
scaleLoss = g(offset)   // offset > 0 → scaleLoss > 1 (more loss)

Δμ_applied = Δμ_openskill × scaleWin   if win
           = Δμ_openskill × scaleLoss   if loss
```

- `f`, `g` are monotonic, clamped (e.g. 0.25–2.0), tunable.
- **Lobby average** uses **league-global** ki only (not hero), pre-match, active non-quitters who are **not** calibrating.
- **σ unchanged** by scaler (preserves OpenSkill uncertainty model).
- Quitter synthetic path: **unchanged** unless product wants lobby scaling there too.

| Pros                                                                                  | Cons                                              |
| ------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Directly targets embed + ladder complaint                                             | Tuning constants need playtesting                 |
| Does not fork OpenSkill internals                                                     | Theoretically can diverge from “pure” Weng–Lin    |
| Works with dual entity (scale per human global; hero optional same offset or hero ki) | Must define behavior for unbalanced lobbies (4v6) |

### Approach B — Display-only ki delta multiplier

Keep `applyMatchRatings` unchanged; when building `globalDelta` / `heroDelta` on completed embed, multiply displayed delta by a lobby-relative factor.

| Pros                          | Cons                                     |
| ----------------------------- | ---------------------------------------- |
| Zero risk to ladder integrity | Leaderboard and match embed **disagree** |
| Fast to ship                  | Does not fix actual skill tracking       |
| Easy A/B in preview           | Violates “one source of truth” principle |

### Approach C — Inflate veteran σ or deflation floor

Raise σ for veterans when lobby average is much lower, or cap σ reduction — more movement for high-μ players in mixed lobbies.

| Pros                     | Cons                                              |
| ------------------------ | ------------------------------------------------- |
| Stays “inside” OpenSkill | Hard to reason about; affects win% / balance hint |
| No post-processing       | Indirect control of ki swings                     |
|                          | Risky for long-term ladder stability              |

**Recommendation:** **Approach A** with conservative default curves; document constants in `rating-math.ts`; unit tests + simulation fixtures from research above.

---

## Proposed design (Approach A — approved)

### Lobby average

```text
activeHumans = roster entries where !isQuitter
calibrated   = activeHumans where leagueGames >= 5
lobbyAvgKi   = mean( preMatchGlobalKi(p) for p in calibrated )
             // if calibrated empty → mean over all activeHumans
```

- Use `displayOrdinal(global μ, σ, leagueGames)` with pre-match game counts (same as completed embed “before”).
- **Unbalanced fills:** include all active humans on both teams (empty slots excluded).
- **Single league:** always filter by `leagueId`.
- **Calibrating:** still get a personal offset vs that avg (and still have Δμ scaled); they just do not pull the avg down/up.

### Offset and scales (initial proposal — tune in implementation plan)

```text
offsetKi = playerGlobalKi − lobbyAvgKi
t        = clamp(offsetKi / 2000, −1, 1)   // ±2000 ki → full effect

scaleWin  = clamp(1 − 0.5 × t, 0.5, 1.5)   // above avg: min 0.5× gain
scaleLoss = clamp(1 + 0.5 × t, 0.5, 1.5)   // above avg: max 1.5× loss
```

Illustrative targets (to validate in sim):

| Player vs lobby           | Win scale | Loss scale |
| ------------------------- | --------- | ---------- |
| +2000 ki (5k in 3k lobby) | 0.5×      | 1.5×       |
| At average                | 1.0×      | 1.0×       |
| −2000 ki                  | 1.5×      | 0.5×       |

Apply to **Δμ** only for each player's **global** entity after team `rate()`. **Hero entity:** same scale factors using **global** offset (keep global/hero aligned) unless playtesting says hero-only offset.

### Integration point

```text
applyMatchRatings / simulatePostMatchRatings
  → rate() as today
  → for each active human:
       compute preMatch lobbyAvgKi + offset
       scale Δμ_global (and Δμ_hero if hero present)
       write scaled μ; σ from OpenSkill unchanged
```

- `simulatePostMatchRatings` must apply the same logic (match history / correction parity).
- **Match correction / flip:** restore snapshots → re-apply with scaler (no change to snapshot design).

### Edge cases

| Case                   | Rule                                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------- |
| 1v1                    | Lobby avg = opponent ki; full ± effect                                                            |
| All players similar ki | t ≈ 0 → scaler ≈ 1 (no-op)                                                                        |
| Calibrating players    | Excluded from lobby avg (`games < 5`); if everyone is calibrating, fall back to all active humans |
| Quitters               | Excluded from lobby avg and active apply; penalty path unchanged                                  |
| Rank reset             | No special case; uses current μ/σ                                                                 |
| Multi-league           | Scaler computed inside `leagueId` only                                                            |

### Testing

- Unit: scale functions monotonicity, clamps, 1v1 symmetry
- Regression: reproduce research fixtures (5k/2k 6v6, 1v1 upset) — assert high loser |Δki| increases vs baseline
- Integration: `simulatePostMatchRatings` + `buildCompletedRatingPreview` delta signs
- Manual: replay prod match pattern (~4786 vs ~1636) and confirm direction matches product

### Success criteria

- In mixed-lobby sims, a ~5k player who **loses** loses **more ki** than a ~2k loser in the same match (baseline today: ~11 vs ~149 — target narrows gap per product tuning, not necessarily equality).
- A ~5k player who **wins** as favorite gains **less** than a ~2k winner on the same team.
- Pure OpenSkill win probability / balance hint path unchanged (`predictWin` inputs untouched).
- Ladder and match embed use the same scaled μ.

---

## Locked for v1 (2026-08-18)

1. **Scale curve** — linear `t`, clamps **0.5×–1.5×**, offset full effect at **±2000 ki** (ship defaults; tune later if needed).
2. **Hero entity** — same scale factors as global (offset from **global** ki).
3. **Quitter penalties** — **unchanged** (no lobby scaling on synthetic path).
4. **Migration** — forward-only; no retroactive recalc.

---

## References

- ClickUp: [869ek4q74](https://app.clickup.com/t/869ek4q74) — _Scale rating gain/loss vs lobby average_
- `src/services/rating/rating-update.ts` — `applyMatchRatings`, `simulatePostMatchRatings`
- `src/services/rating/rating-math.ts` — `displayOrdinal`
- `.cursor/rules/openskill-rating.mdc` — dual entity, σ dampening
- Related (display only): `2026-08-15-soft-early-ki-design.md`
