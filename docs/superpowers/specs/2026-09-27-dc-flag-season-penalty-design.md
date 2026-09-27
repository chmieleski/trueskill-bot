# DC flag + season disconnect penalty — Design

**Date:** 2026-09-27  
**Status:** Approved  
**Scope:** `general` (league-scoped flags, `/rank`, match report, sanction, season rollover)  
**Related:** [`2026-09-01-manual-quitter-griefer-sanction-design.md`](./2026-09-01-manual-quitter-griefer-sanction-design.md), [`2026-08-19-league-rollover-design.md`](./2026-08-19-league-rollover-design.md), `.cursor/rules/openskill-rating.mdc`, griefer tax (`griefer-tax.ts`)

## Goal

Mods and hosts can mark players who **disconnect** (DC) the same way they mark griefers: during report/cancel and via `/match sanction`. Each DC is a countable incident. At **season rollover**, every **3** DCs cost **−300** display ki on the ending-season global rating (rewards board). Remainder DCs (`count % 3`) carry no tax that season.

## Non-goals

- Live DC leaderboard channel (no guild board config)
- Per-incident deferred ki column (unlike `grieferKiAccrued`)
- Immediate OpenSkill μ/σ change when marking DC
- Event-match DC sanctions (IHL leagues only; event complete/cancel may still persist the flag for display but applies no season tax — events have no rollover)
- Changing quit/griefer tax formulas
- Reason/note field on DC marks
- Habitual-DC roster warning (v1)

## Locked decisions

| Topic                  | Choice                                                                          |
| ---------------------- | ------------------------------------------------------------------------------- |
| Threshold              | Every **3** DCs → **−300** ki (`floor(dcCount / 3) * 300`)                      |
| Mark surfaces          | In-match report/cancel **and** `/match sanction add\|remove` with `type: dc`    |
| Quit vs DC             | **Quitter wins** — setting quitter clears `isDc`; DC cannot apply while quitter |
| Grief vs DC            | **Independent** — a player may be both griefer and DC on the same match         |
| Team rating            | DC stays in team `rate()` (same as griefer; not excluded like quitter)          |
| Immediate penalty      | **None** — count only until rollover                                            |
| Season tax source      | All `isDc && !isQuitter` rows in the **league** (real + manual sanctions)       |
| `/rank` DC count       | Rank-reset cutoff (same as quits/griefs)                                        |
| Pending tax on `/rank` | Full-league DC count (same population as rollover tax), not reset-cutoff        |
| Accrual storage        | **No** `dcKiAccrued`; tax computed at preview/rollover                          |
| Live board             | **None**                                                                        |
| Match history          | `dcs_only` filter; exclude `isManualSanction` (same as griefers_only)           |
| Clear command          | `/match undc` parallel to `/match ungrief`                                      |
| Auth                   | In-match: existing host/report perms; sanction/undc: match mod role             |
| Language               | English user-facing strings                                                     |

## Data model

```prisma
model MatchPlayer {
  // …existing fields…
  isDc Boolean @default(false) // Disconnect incident; season tax from count
}
```

No new tables. No accrued-ki column.

## Commands & UI

### Slash — extend `/match`

| Path                                | Behavior                                                               |
| ----------------------------------- | ---------------------------------------------------------------------- |
| `/match dcs`                        | Set DC slots on a reportable match (mirror `/match griefers`)          |
| `/match undc`                       | Clear DC on completed/cancelled match (optional slots; omit = all DCs) |
| `/match sanction add` `type: dc`    | Manual +1 DC (synthetic CANCELLED `isManualSanction` match)            |
| `/match sanction remove` `type: dc` | Clear latest manual DC, or `match_id` via `clearMatchDcs`              |
| `/match complete` / `cancel`        | Optional `dcs` slot string (mirror `griefers`)                         |
| `/match history`                    | Optional `dcs_only` boolean                                            |

### In-match UI

Extend report/cancel / approval flows with DC slot toggles parallel to griefer toggles. Selecting quitter on a slot clears DC. Selecting DC on a quitter slot clears quitter (same pattern as marking griefer today). Griefer and DC are independent checkboxes/slots.

### Lobby / embeds

- Roster mark when `isDc && !isQuitter`: ` 🔌` (griefer keeps ` 🐛`; both may show).
- History line: ` · DC` when flagged.
- `/rank`: show `DCs` count; when pending tax &gt; 0, show pending disconnect season tax (ki).

## Rating & rollover

### Pure helpers (`dc-tax.ts` or extend `griefer-tax.ts` neighbors)

```text
DC_PENALTY_THRESHOLD = 3
DC_PENALTY_KI = 300

computeDcSeasonTaxKi(dcCount) = floor(dcCount / 3) * 300
```

Reuse `applyKiTaxToMu` for applying the flat tax to ending-season global μ.

### Rollover

1. Load all league `MatchPlayer` with `isDc: true`, `isQuitter: false`, `match.leagueId = source`.
2. Count per `playerId` → `taxByPlayer = computeDcSeasonTaxKi(count)`.
3. Apply alongside (after or combined with) griefer season tax to ending-season globals for rewards.
4. Do **not** clear `isDc` (archive history). Successor seeding uses post-tax μ the same way as griefer tax (`continue`/`soft` copy post-tax; `hard` defaults).

Preview strings on `/league rollover` include DC season tax summary (player count with tax &gt; 0, total ki).

### Complete / cancel

Persist `isDc` on `MatchPlayer` like `isGriefer`. No accrual call. Quitter slots force `isDc: false`.

### Manual sanction add (`type: dc`)

1. Assert league writable.
2. Create CANCELLED `isManualSanction` match + one `MatchPlayer` with `isDc: true` (not quitter/griefer).
3. No snapshots / OpenSkill / griefer accrual.
4. Return updated DC count (+ pending tax optional in reply).

### Manual / undc remove

- Without `match_id`: latest manual DC for player in league → `clearMatchDcs`.
- With `match_id`: `clearMatchDcs(matchId, [slot])`.
- `clearMatchDcs`: set `isDc: false` only (no rating restore).

## Flag interaction matrix

| Action        | Result                                                       |
| ------------- | ------------------------------------------------------------ |
| Set quitter   | `isQuitter=true`, `isGriefer=false`, `isDc=false`            |
| Set griefer   | `isGriefer=true`, `isQuitter=false`; **keep** `isDc`         |
| Set DC        | `isDc=true`, `isQuitter=false`; **keep** `isGriefer`         |
| Clear DC      | `isDc=false` only                                            |
| Clear griefer | `isGriefer=false`, clear `grieferKiAccrued`; **keep** `isDc` |

## Architecture

```text
/match dcs|undc|sanction|complete|cancel|history
  → setDcs | clearMatchDcs | addManualSanction(type:dc) | removeManualSanction
  → completeMatch / cancelMatch (persist isDc)
  → loadMatchHistoryPage(dcsOnly)
/rank
  → displayStats.dcs + pendingDcSeasonTaxKi
/league rollover
  → loadPendingDcTaxForLeague → applyKiTaxToMu on ending globals
```

## Testing (acceptance)

- Unit: `computeDcSeasonTaxKi` — 0→0, 2→0, 3→300, 5→300, 6→600
- Unit: `setDcs` clears quitter; `setQuitters` clears DC; griefer+DC both persist
- Unit: `addManualSanction` dc — CANCELLED manual row, `isDc`, no griefer accrual / quit synthetics
- Unit: `removeManualSanction` dc — clears latest manual only
- Unit: `loadMatchHistoryPage` `dcs_only` excludes manual sanctions; includes real DC matches
- Unit: rollover applies `floor(n/3)*300` with griefer tax (both can hit same player)
- Command: sanction type includes `dc`; undc mod-gated
- Regression: griefer paths unchanged when `isDc` false

## Open follow-ups (not v1)

- Live DC leaderboard
- Habitual DC ⚠️ on lobby
- Optional `reason` on sanctions
- Mid-season “tax already applied” bookkeeping if matches are ever moved across leagues (out of scope)

## Spec self-review

- No TBD placeholders; threshold fixed at 3.
- Tax population (full league) vs `/rank` count (rank-reset) called out explicitly.
- Event matches: flag OK, no season tax path (no league rollover).
- Scope remains one feature: DC flag + season penalty + surfaces.
