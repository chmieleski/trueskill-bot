# Balance by display ki (per-league mode)

Scope: `general` — lobby win% / Balance strength source, keyed by `leagueId`. `rate()` and public ki unchanged.

## Problem

Players and staff read **ki**, but lobby win% / Balance used OpenSkill μ/σ (`predictWin` on the 80/20 blend). Teams that looked even by ki were called unbalanced and vice versa, and the bot lost trust.

## Evidence (prod backtest, 2026-10-11)

Every completed UDBR league match (440, pre-match `MatchRatingSnapshot`), scored against the real winner:

| Model                    | Accuracy | AUC   | Log-loss |
| ------------------------ | -------- | ----- | -------- |
| μ/σ (`dynamic`, current) | 50.2%    | 0.503 | 0.745    |
| μ, σ=6 (`static`)        | 50.2%    | 0.507 | 0.729    |
| **display ki (`ki`)**    | 56.5%    | 0.583 | 0.682    |
| μ only (no σ)            | 49.9%    | 0.487 | 0.693    |

Coin flip = 50% / 0.500 / 0.693. The gain comes from the `−z·σ` term: new / uncertain players perform below the μ=25 prior, and ki discounts them. Caveat: historical lobbies were balanced with μ/σ, which pushes that model toward 50/50.

## Design

`League.balanceKiStrengthEnabled` (default **false**). With it on, each seat in `predictWin` is:

```text
μ_eff = 0.8 × (μ_p − z(g_p)·σ_p) + 0.2 × (μ_h − z(g_h)·σ_h)   // WOS: global term only
σ_eff = BALANCE_STATIC_SIGMA (6)
```

`z(g)` is the public-ki conservatism (3 → 2.5 over 5 games), so `1000 + 200 × μ_eff` is the 80/20 blend of the ki players see. Global `g` = league display W/L games; hero `g` = `matchesPlayed` (snapshot value for completed matches).

New pair-off omission and excess-New μ discount are **skipped** in this mode: ki already penalizes uncertainty, and this is the model the backtest measured. The Balance button still splits New seats evenly across teams before optimising win% (seating, not strength).

## Staff

`/league_config set balance_mode mode:dynamic|static|ki` replaces `balance_static_sigma` (the command hit Discord's 8000-byte payload limit). It writes `balanceStaticSigmaEnabled` and `balanceKiStrengthEnabled` together so the modes cannot overlap. Successor leagues inherit both flags at rollover.
