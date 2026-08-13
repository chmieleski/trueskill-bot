# Ki Display Scale — Design

**Date:** 2026-08-13  
**Status:** Approved  
**Scope:** Public display transform from OpenSkill ordinal to themed **ki** scores on embeds / leaderboards

## Goal

Show player skill as **ki** with a Dragon Ball–friendly scale: new players near **1000**, elite players around **8000**. Internal OpenSkill μ/σ and `rate()` / `predictWin` stay unchanged.

## Non-goals

- Changing default μ/σ in Prisma or OpenSkill
- Persisting a separate ki column
- Leaderboard command (none yet)
- Match-report ordinal/ki deltas

## Locked decisions

| Topic | Choice |
|-------|--------|
| Transform | Display-only |
| Formula | `ki = round(1000 + 200 × ordinal(μ, σ))` where `ordinal = μ − 3σ` |
| Cold start | ≈ **1000** |
| Elite anchor | ≈ **8000** (μ≈40, σ≈1.5) |
| Public copy | Footer / labels say **ki**, not “ordinal” |
| DTO names | Keep `globalOrdinal` / `heroOrdinal`; values hold **display ki** |

## Math

```text
KI_OFFSET = 1000
KI_SCALE  = 200
ki = round(KI_OFFSET + KI_SCALE * ordinal({ mu, sigma }))
```

| Profile | μ / σ (approx) | Ordinal | Ki |
|---------|----------------|---------|-----|
| Cold start | 25 / 8.333 | 0 | 1000 |
| Solid | 30 / 2 | 24 | 5800 |
| Strong | 35 / 2 | 29 | 6800 |
| Elite | 40 / 1.5 | ≈35.5 | ≈8100 |

## Architecture

```text
displayOrdinal(mu, sigma)  // single source of truth in rating-math.ts
  → rating-preview DTO (globalOrdinal / heroOrdinal = ki)
  → lobby / completed embeds
```

Never show raw μ on public embeds.

## Rejected alternatives

- Raising default μ toward 1000 — breaks OpenSkill priors and team math
- Storing ki in the database — redundant; always derived from μ/σ
