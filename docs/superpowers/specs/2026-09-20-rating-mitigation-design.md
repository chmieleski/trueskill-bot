# Rating mitigation (soft result)

**Date:** 2026-09-20  
**Scope:** `general`

## Problem

Sometimes a ranked match ends under weird circumstances (disconnects, map bugs, unfinished rounds) but staff still want to award a winner without applying a full-strength OpenSkill swing.

## Product rules

- Mitigation reduces **both** sides’ team Δμ by the same keep-factor: `keep = 1 − pct/100` (25→0.75, 35→0.65, 50→0.50).
- Presets only: **none / 25 / 35 / 50**.
- UI: Report Winner **confirm** step (after winner + required stats).
- **Host** (non-mod) + mitigation ≠ none → do **not** complete; post Approve / Reject / Edit in the **match lobby channel**.
- **Mod** (button or `/match complete`) → complete immediately with the chosen %.
- Quit/griefer **synthetics and season tax are not scaled**.
- Event matches stay unrated; mitigation is ignored for rating math.

## Rating pipeline

```text
OpenSkill rate() → lobby-relative Δμ scale → mitigation Δμ scale → persist
```

Helper: `applyMitigationToMu(before, after, pct)` in `src/services/rating/rating-mitigation.ts`.  
Applied to global and hero μ for active non-quit seats; σ unchanged. Wired through `applyMatchRatings` / `simulatePostMatchRatings` / `completeMatch`.

## Data model

- `MatchStatus.WAITING_FOR_MITIGATION_APPROVAL` — host soft-result pending mod action (distinct from WOS `WAITING_FOR_APPROVAL`).
- `Match.ratingMitigationPercent Int?` — persisted on completed matches when > 0.
- `Match.mitigationApprovalMessageId String?` — lobby-channel approval message.
- `Match.approvalWinnerTeam` — reused while waiting for mitigation approval; cleared on complete/reject.

## Flows

1. Host confirms with mitigation → `requestMitigationApproval` → status waiting → channel message.
2. Mod Approve → `approveMitigationMatch` → `completeMatch(..., pct)`.
3. Mod Reject → status back to `IN_PROGRESS`; clear pending fields.
4. Mod Edit → change pending pct (including none) then Approve.

## Out of scope

Free-form percentages, losers-only mitigation, scaling quit/griefer synthetics, WOS `matchApprovalChannelId` reuse.
