# Database query & Logs Ingest reduction — Design

**Date:** 2026-09-30  
**Status:** Approved for implementation (pending written-spec user review)  
**Scope:** `general` (cross-league query patterns; not game-specific)  
**Related:**  
[`2026-08-23-rating-decay-design.md`](./2026-08-23-rating-decay-design.md),  
[`2026-08-24-league-decay-config-design.md`](./2026-08-24-league-decay-config-design.md),  
[`2026-08-15-soft-early-ki-design.md`](./2026-08-15-soft-early-ki-design.md),  
[`2026-09-27-dc-flag-season-penalty-design.md`](./2026-09-27-dc-flag-season-penalty-design.md)

## Problem

Supabase Free plan **Logs Ingest** quota is **5 GB / month**. Org usage hit ~**10 GB**. Investigation (project DBZU, 2026-09-30) showed:

| Observation | Implication |
| --- | --- |
| Public schema ~**21 MB** | Not a database-size problem |
| ~**99%** of recent log events = `supavisor_logs` (auth / terminate) | Pooler connection + query chatter drives ingest |
| ~2.66 M `League` decay-config PK reads + ~2.66 M `PlayerRating` PK reads | On-read decay catch-up reloads League every time |
| ~664 k per-player `MatchPlayer` history dumps; league-wide hero-stats ~1.2 k rows/call | Display W/L/Q/G/DC and hero boards over-fetch |
| `replaceMatchRoster` = `deleteMany` + `createMany` | Lobby rewrite amplifies WAL / session work |

Shared Pooler **Egress** (also 5 GB Free) is a sibling risk from the same row-return volume; this design targets both by cutting query/connection chatter.

## Goal

Reduce Logs Ingest and Shared Pooler Egress **without changing** player-facing μ/ki, OpenSkill apply, lobby correctness, or board semantics.

## Locked decisions

| Topic | Choice |
| --- | --- |
| Delivery | **Two projects:** A = fast relief (no schema); B = denormalized display counters |
| Counter cutover | **Shadow mode** first (history remains source of truth); flip only after clean shadow |
| Rollback | Env `DISPLAY_STATS_SOURCE=history\|counters` (default `history`) |
| Cache | Process-local League decay cache + invalidate on decay/league writes; TTL fallback |
| Roster | Diff/upsert in `replaceMatchRoster`; preserve locks and PENDING-only edits |
| Counters grain | League-global on `PlayerRating` matching `PlayerMatchDisplayStats` |
| Out of v1 counters | Hero W/L maps, side (team1/team2) W/L denorm |
| OpenSkill | Unchanged; counters are display / calibrating / decay-exempt inputs only |

## Non-goals

- Changing decay math, display-ki formula, or OpenSkill `rate()` paths
- Hero-rating counters on `PlayerHeroRating`
- Leaving Supabase / “upgrade plan” as the primary fix
- Tuning Auth/Storage/Realtime logging (not our drivers)
- Redis or multi-region shared cache (single EC2 bot process today)

---

# Project A — Fast Log Ingest relief

Ship first as separate PRs in order A1 → A2 → A3.

## A1. League decay settings cache

### Behavior

`applyPendingDecay` / `applyPendingDecayForPlayers` / daily batch currently `league.findUnique` per call (~1:1 with `PlayerRating` reads). Cache the League row (decay select shape) in-process:

- **Key:** `leagueId`
- **Invalidate:** every writer in `league-decay.ts` (`setDecay*`, enable/disable) and any other update that mutates decay-relevant League columns (status, `seasonEndsAt`, `crunchStartedAt`, `archivedAt`, decay override fields)
- **TTL:** 30–60 seconds as a backstop if a write path forgets invalidate
- **Miss:** DB fetch → store → return

Decay **math and catch-up on μ-read remain** (product decision from rating-decay design). Only redundant League SELECTs are removed.

### Files (expected)

- Create: `apps/bot/src/services/rating/rating-decay-league-cache.ts`
- Modify: `apps/bot/src/services/rating/rating-decay.ts`
- Modify: `apps/bot/src/services/league/league-decay.ts` (+ any other League decay field writers)
- Test: `apps/bot/src/services/rating/rating-decay-apply.test.ts` (+ new cache unit tests)

### Safety

- Same select fields as today
- Unit tests: hit, miss, invalidate, TTL expiry
- No env / SSM changes

## A2. History / hero-stats query scoping

### Behavior

Keep public APIs:

- `loadMatchDisplayStatsByPlayer(leagueId, playerIds?, db?)`
- Hero stats loaders in `hero-stats.ts`

Changes:

1. **Leaderboard / hot paths that already have player ids** must pass `playerIds` into `loadMatchDisplayStatsByPlayer` (avoid full-league `MatchPlayer` OR dumps when the board set is known).
2. **Audit** all `loadHeroStats` / `loadHeroStatsRowsForSelection` call sites: Discord player `/hero` (and similar) **must** pass `playerId`. League-wide pulls only for explicit “all players” staff/API surfaces.
3. Prefer narrower Prisma `select` lists where call sites only need a subset (no semantic change).

No Prisma migration. Rank-reset cutoffs still applied in `aggregateMatchDisplayStats` as today.

### Files (expected)

- Modify: `apps/bot/src/services/leaderboard/leaderboard.ts` (and quitter/griefer boards if they unscoped-fetch)
- Modify: `apps/bot/src/services/player/hero-stats.ts` + call sites under `commands/player/`
- Modify: `apps/bot/src/services/rating/rank-reset-display.ts` only if adding a safer aggregate helper without changing semantics
- Tests: existing leaderboard / hero-stats / rank-display suites + new “playerIds required on player path” assertions where applicable

### Safety

- Snapshot or golden compare: same W/L/Q/G/DC for fixture leagues with and without the scoping change
- Manual smoke: `/rank`, `/leaderboard show`, `/hero` for a linked player

## A3. Soften `replaceMatchRoster`

### Current

`apps/bot/src/services/match/match-service.ts` → `replaceMatchRoster`: in a transaction, `matchPlayer.deleteMany({ matchId })` then `createMany` for the full roster.

### Target

Inside the same transaction and invariants (PENDING-only, slot/nick validation, hero catalog, lock pair reconciliation, optional `lobbyRosterAuthorityAt`):

1. Load existing `MatchPlayer` rows for `matchId`
2. Diff against resolved incoming roster
3. **Delete** only rows no longer present
4. **Update** rows whose `playerId` / `team` / `slot` / `heroId` / quit flags / `locked` changed
5. **Insert** new rows

Return type and callers unchanged: `discord-sync`, `wc3stats-refresh`, WOS report ingest.

### Safety

- Tests: empty→full, full→empty, slot swap, lock pair preservation across refresh, PENDING guard
- Manual smoke: OCR refresh, shuffle, claim/lock flows

No schema change.

---

# Project B — Denormalized display counters (follow-up)

## Schema

On `PlayerRating` (PK `(leagueId, playerId)`), add integers defaulting to `0`:

| Column | Maps to `PlayerMatchDisplayStats` |
| --- | --- |
| `displayWins` | `wins` |
| `displayLosses` | `losses` |
| `displayQuits` | `quits` |
| `displayGriefs` | `griefs` |
| `displayDcs` | `dcs` |

Derived `games` for readers = `displayWins + displayLosses` (same as aggregator today).

Optional debug: `displayCountersUpdatedAt DateTime?` — not required for flip logic.

**Not denormalized in v1:** per-hero W/L, per-side W/L, pending griefer ki tax sums (those keep history queries).

## Semantics (must match history aggregator)

Counters obey the same rules as `aggregateMatchDisplayStats` + `loadMatchDisplayRows` in `rank-reset-display.ts`:

- WIN/LOSS on `COMPLETED` matches increment wins/losses (and thus games)
- Quitter on COMPLETED/CANCELLED increments quits
- Griefer with `isQuitter = false` on COMPLETED/CANCELLED increments griefs
- DC with `isQuitter = false` on COMPLETED/CANCELLED increments dcs
- **Rank reset:** after reset, counters reflect only matches with `completedAt > resetAt` (reset path zeroes then optionally recomputes, or zeroes and future writers only — prefer **recompute from history in the rank-reset transaction** for safety)

## Writers

Update counters in the **same Prisma transaction** as history mutations:

- Match complete / cancel (including quit/griefer/DC flags)
- Match correction
- Manual sanction
- Rank reset
- Any other path that changes `MatchPlayer` result/flags for a finished match

Never best-effort fire-and-forget.

## Shadow mode (default)

After backfill + writers:

1. Readers still call history-based `loadMatchDisplayStatsByPlayer`
2. Also load counter columns for the same players
3. Compare; on mismatch → structured **warn** log (`leagueId`, `playerId`, history vs counters) — **return history**
4. Ops verify script: full active-league scan; non-zero exit on mismatch

## Flip / rollback

- Env: `DISPLAY_STATS_SOURCE` = `history` | `counters` (default **`history`**)
- Parse in `apps/bot/src/config/env.ts`
- Full AWS sync: `.env.example`, `scripts-and-env.mdc`, Terraform SSM, `refresh-env.sh` (per `env-aws-sync` rule)
- Flip to `counters` only after shadow shows **0 mismatches** across an agreed window (multiple active game nights)
- Rollback: set `history` and redeploy/refresh-env — writers may keep updating

## Backfill

One-off script (or migrate + script): for each `PlayerRating` row, compute via existing `loadMatchDisplayStatsByPlayer(leagueId, [playerId])` and write columns. Run against target DB before relying on shadow in production.

---

## Testing strategy

| Layer | Project A | Project B |
| --- | --- | --- |
| Unit | Cache, roster diff, scoped call contracts | Counter increment rules vs aggregator fixtures |
| Integration / existing suites | Decay, lobby, hero, leaderboard, rank | Complete/cancel/correction/sanction/rank-reset |
| Ops | — | Verify script before flip |
| Manual smoke | `/rank`, lobby OCR, `/hero`, leaderboard | Shadow logs quiet; flip on staging/prod with rollback ready |

## Rollout order

1. A1 League cache PR  
2. A2 Query scoping PR  
3. A3 Roster diff PR  
4. B1 Migration + backfill + writers + shadow (flag stays `history`)  
5. B2 Flip `DISPLAY_STATS_SOURCE=counters` after clean shadow  

## Success metrics

- Supabase **Logs Ingest** daily GB and `supavisor_logs` event rate trend down after A  
- `pg_stat_statements`: sharp drop in League-by-id calls (A1) and unscoped MatchPlayer dumps (A2); fewer MatchPlayer write churn ops (A3)  
- After B flip: `loadMatchDisplayStatsByPlayer` no longer full-history scans on hot paths  
- **Correctness:** no player-visible W/L/Q/ki/board regressions; shadow mismatches = 0 before flip  

## Implementation plans

Separate plans (writing-plans skill after this spec is user-approved):

1. `docs/superpowers/plans/2026-09-30-db-ingest-relief-project-a.md`  
2. `docs/superpowers/plans/2026-09-30-db-display-counters-project-b.md`  

## Agent constraints

- Declare scope `general` on every PR  
- Do not change translation keys  
- Do not weaken league isolation (`leagueId` on all rating/counter reads/writes)  
- English-only user-facing strings / logs  
- Conventional Commits; format check before PR  
- New production env keys must complete env-aws-sync checklist  
