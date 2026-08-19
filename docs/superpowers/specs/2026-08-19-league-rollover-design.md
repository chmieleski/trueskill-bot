# League season rollover — Design

**Date:** 2026-08-19  
**Status:** Implemented  
**Scope:** `general` (league lifecycle + OpenSkill seeding; not game-specific)  
**Plan:** `docs/superpowers/plans/2026-08-19-league-rollover.md`

## Goal

Staff can **finish** an active league and **open a successor** league derived from it. The old league becomes a **read-only archive** (match history and leaderboards remain queryable). Channel bindings move to the new league so day-to-day play continues without manual rebind.

Three rating modes when seeding the successor:

| Mode           | Effect                                                                                                                                 |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| **Continue**   | Copy global and hero μ, σ, and hero `matchesPlayed` **unchanged**. Archive is a freeze; play continues on the new name with no reset   |
| **Hard reset** | Every carried player starts at OpenSkill defaults (μ `25`, σ `8.333`); no hero rows until first pick                                   |
| **Soft reset** | Global and hero μ compress toward each entity’s league average; σ bumped up (recalibration); `matchesPlayed` reset to `0` on hero rows |

Staff choose the successor **display name** and (for soft reset) a **compression** factor at rollover time.

`continue` is **not** `soft` with `compression: 0`. Soft always recalibrates (σ bump, `matchesPlayed = 0`). Continue does not.

### Season 1 → 1.5 → 2 recipe

Typical IHL break between seasons is **two** rollovers. Season 2 seeds from **end of 1.5**, not from the frozen Season 1 board.

```text
Season 1  --continue-->  Season 1.5  --soft-->  Season 2
 (archive)                (live break)           (new season)
```

| Step            | Staff runs                                                           | Result                                                                                      |
| --------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| End of Season 1 | `/league rollover name:Season 1.5 reset:continue`                    | Season 1 archived (ending board frozen). Live 1.5 has identical ki / Calibrating state      |
| After the break | `/league rollover name:Season 2 reset:soft` (optional `compression`) | 1.5 archived (break history kept). Season 2 is a soft reset of **then-current 1.5** ratings |

1.5 is not a special league type — it is whatever display name staff pass. `/league list` stays Active vs Archived only. Further `continue` rollovers are allowed.

## Non-goals

- Auto-increment league names (`"Season N"`) without staff input
- Keeping both old and new leagues active for new matches
- Auto-cancelling active lobbies/matches during rollover
- Per-league stored compression preset (`/config`) — v1 picks at rollover only
- Retroactive recalculation of archived match ratings
- Cross-league rating pools or merged leaderboards across seasons
- Changing OpenSkill `rate()` math or display ki formula
- Web dashboard / export for season history
- `INTERMISSION` (or other) league status — staff naming is enough
- A `Season` entity or point-in-time snapshot tables on the same league
- Seeding Season 2 from the frozen Season 1 archive while ignoring 1.5 play

## Locked decisions

| Topic                      | Choice                                                                                                                      |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Old league fate            | **Archive** — `ARCHIVED` status; no new matches; history readable                                                           |
| Active matches at rollover | **Block** until zero `PENDING` / `IN_PROGRESS` matches in source league                                                     |
| Soft reset math            | Compress μ toward **league mean** (global and per-hero independently)                                                       |
| Hero ratings on soft reset | Same compression as global; `matchesPlayed = 0` on copied hero rows                                                         |
| Continue seed              | Identity copy of existing `PlayerRating` and `PlayerHeroRating` rows (μ, σ, `matchesPlayed`)                                |
| Continue missing globals   | Do **not** invent a default global row for hero-only players                                                                |
| Soft/hard missing globals  | Include hero-only players; seed global defaults for them (existing edge case)                                               |
| Successor name             | **Staff required** `name` option                                                                                            |
| Compression                | **Only with `soft`**. Staff picks `0.0`–`1.0`; default `0.5` when omitted. **Rejected** if passed with `continue` or `hard` |
| Season 2 seed source       | The **predecessor at rollover time** (typically 1.5), not an older archive in the chain                                     |
| Bindings                   | **Move** all `LeagueChannelBinding` rows from source → successor                                                            |
| Architecture               | **Approach 1** — new `League` row + `status` + `predecessorLeagueId` lineage                                                |
| Permission                 | Same as `/league create` — `assertCanConfigureBot`                                                                          |
| Confirmation               | Ephemeral Confirm / Cancel (rank-reset button pattern)                                                                      |
| Documentation              | Staff guide + player impact note + cheat-sheet line                                                                         |

## Data model

### `LeagueStatus` enum + columns

```prisma
enum LeagueStatus {
  ACTIVE
  ARCHIVED
}

model League {
  // …existing fields…
  status              LeagueStatus @default(ACTIVE)
  predecessorLeagueId String?
  archivedAt          DateTime?

  predecessor League?  @relation("LeagueSuccession", fields: [predecessorLeagueId], references: [id])
  successors  League[] @relation("LeagueSuccession")
}
```

- Existing leagues backfill to `ACTIVE`.
- `predecessorLeagueId` set on the **successor** only (single-step lineage; chain forms `S3 → S2 → S1`).
- `archivedAt` set when status becomes `ARCHIVED`.

### Archived league behavior

| Operation                                                      | Allowed?                            |
| -------------------------------------------------------------- | ----------------------------------- |
| `/register_lobby`, lobby buttons, wc3stats import              | **No** — reject: league is archived |
| `/rank_reset`                                                  | **No**                              |
| `/match list`, `/leaderboard` with explicit archived `league:` | **Yes**                             |
| `/config set …` on archived league                             | **No**                              |
| Autocomplete for play/config commands                          | **ACTIVE only**                     |
| Autocomplete for history (`/match list`, `/leaderboard`)       | ACTIVE + ARCHIVED                   |

## Command: `/league rollover`

### Options

| Option        | Required                             | Notes                                                                                                        |
| ------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `name`        | yes                                  | Display name for successor (max 100 chars, trimmed)                                                          |
| `reset`       | yes                                  | Choice: `hard` \| `soft` \| `continue`                                                                       |
| `compression` | when `soft`                          | Number `0.0`–`1.0`; default `0.5`. Higher = **more** pull toward average. Rejected with `continue` or `hard` |
| `league`      | if guild has multiple ACTIVE leagues | Autocomplete; ACTIVE only                                                                                    |

### Flow

1. `assertCanConfigureBot`.
2. Resolve source league (option or single-league fallback — same rules as other league admin commands).
3. Reject if source `status !== ACTIVE`.
4. Count matches with `status IN (PENDING, IN_PROGRESS)` for `leagueId`; if any → reject listing up to 5 match ids + total count.
5. Validate `name` non-empty; unique `(guildId, gameId, name)` on create (same as `/league create`).
6. If `reset=soft`, validate `compression` in `[0, 1]` (default `0.5`). If `reset` is `continue` or `hard` and `compression` was provided → reject.
7. Ephemeral preview + Confirm / Cancel buttons (actor-bound custom ids). Preview for `continue` must say ratings are copied unchanged and the old league will be frozen — not that ki will move toward average.
8. On confirm — **single Prisma transaction**:
   - `create` successor `League` with copied config (see below), `status: ACTIVE`, `predecessorLeagueId: source.id`.
   - Seed ratings (see below).
   - Copy `LeagueWc3statsSlotMap` rows to successor.
   - `updateMany` bindings: `leagueId` source → successor.
   - `update` source: `status: ARCHIVED`, `archivedAt: now`, clear source `leaderboardMessageId` (optional — message is stale; channel binding moved).
   - Successor: `leaderboardMessageId: null` (staff repost via `/leaderboard setup` or auto-refresh on next match if channel id copied).
9. Reply with summary: archived name + id, successor name + id, reset mode, compression (if soft), players seeded count, bindings moved count.
10. Optional: trigger `refreshLeagueLeaderboard` on successor if leaderboard channel configured. The board shows **seeded** ratings (copied for `continue`; reset for `hard`/`soft`) — not an empty board.

### Config copy (successor `create` data)

Copy from source:

- `gameId`, `wc3statsEnabled`, `wc3statsMapPattern`, `wc3statsMapSha1`
- `leaderboardChannelId`, `leaderboardSize`
- `lobbyPlayerClaimEnabled`, `lobbyChannelEnabled`, `lobbyChannelId`
- `wc3statsHostPromptEnabled`, `wc3statsHostPromptChannelId`
- `rankResetEnabled`, `rankResetCooldownDays`

Do **not** copy:

- `id`, `name` (new), `createdAt`, `updatedAt`, `status`, `predecessorLeagueId`, `archivedAt`
- `leaderboardMessageId` (null on successor)
- Matches, snapshots, rank-reset audit rows

## Rating seeding

Constants (match existing defaults):

```text
DEFAULT_MU    = 25.0
DEFAULT_SIGMA = 8.333
SIGMA_FLOOR   = 6.0
```

### Player set

**Hard and soft:** all `playerId` values with a `PlayerRating` row in the source league. Players who only have `PlayerHeroRating` rows (no global) are included; seed global defaults for them.

**Continue:** copy **only rows that exist**. Union of `playerId`s from source `PlayerRating` and `PlayerHeroRating`. Do **not** create a default global row that was missing on the source.

Empty source league: allowed (0 players seeded).

### Continue

For each source `PlayerRating` row, `create` the same `playerId`, μ, σ on the successor.

For each source `PlayerHeroRating` row, `create` the same `playerId`, `heroId`, μ, σ, and `matchesPlayed` on the successor.

No mean, no compression, no σ clamp, no dropped hero rows, no invented globals.

### Hard reset

For each player in set:

1. `create` `PlayerRating` on successor: μ `DEFAULT_MU`, σ `DEFAULT_SIGMA`.
2. No `PlayerHeroRating` rows (cold-start heroes on first match, same as `/rank_reset`).

### Soft reset

**Global** — compute once per source league:

```text
meanMu = arithmetic mean of PlayerRating.mu in source (empty → DEFAULT_MU)
retention = 1 - compression
newMu = meanMu + (oldMu - meanMu) × retention
newSigma = clamp(max(oldSigma, SIGMA_FLOOR), SIGMA_FLOOR, DEFAULT_SIGMA)
```

**Hero** — for each `(playerId, heroId)` row in source `PlayerHeroRating`:

```text
meanHeroMu = mean of PlayerHeroRating.mu for that heroId in source (empty → DEFAULT_MU)
newHeroMu = meanHeroMu + (oldHeroMu - meanHeroMu) × retention
newHeroSigma = same σ rule as global
matchesPlayed = 0
```

If a player has global rating but no hero rows, only global row is created.

**Compression guide** (staff-facing):

| `compression` | Retention | Effect                                  |
| ------------- | --------- | --------------------------------------- |
| `0.3`         | 70%       | Gentle — small move toward average      |
| `0.5`         | 50%       | Default — halfway to average            |
| `0.7`         | 30%       | Aggressive — strong pull toward average |

### Public ki impact (player-facing summary)

Display ki uses `ki = round(1000 + 200 × (μ − z·σ))` with calibration z — unchanged.

- **Continue:** ki and hero Calibrating state are **unchanged** on the new league name. The archived league still shows the freeze.
- **Hard reset:** everyone near **1000 ki**; shows **Calibrating** until 5 completed league games (same as new player).
- **Soft reset:** ki shifts toward the old season’s average; top players drop, lower players rise; higher σ means larger early swings; hero mains re-enter **Calibrating** per hero until 5 hero games (`matchesPlayed` reset).

Archived season ki/history remains viewable when selecting the archived league on history commands. After a 1.5 continue, selecting archived Season 1 shows the ending board; break games exist only on Season 1.5.

## `/league list` changes

Two sections in reply:

```text
Active leagues (N):
• …

Archived leagues (read-only) (M):
• … (archived <t:UNIX:D>)
```

Archived entries include predecessor hint when useful (`successor: …` is optional v2).

## Module layout

| Path                                                       | Responsibility                                       |
| ---------------------------------------------------------- | ---------------------------------------------------- |
| `src/services/league/league-rollover.ts`                   | Eligibility, preview, transaction, rating seed math  |
| `src/services/league/league-rollover.test.ts`              | Unit tests for math + guards                         |
| `src/commands/league/league.ts`                            | `/league rollover` subcommand adapter                |
| `src/discord/interactions/league-rollover-interactions.ts` | Confirm/Cancel buttons                               |
| `src/services/league/league-resolve.ts`                    | Reject archived for write paths; filter autocomplete |
| `src/services/league/league.ts`                            | `listLeaguesForGuild` split active/archived helpers  |

Shared constants for `DEFAULT_MU` / `DEFAULT_SIGMA` should be imported from one rating module (avoid a third copy long-term; acceptable to duplicate in rollover service with comment if import cycle risk).

## Error messages (English)

| Case                                  | Message                                                                         |
| ------------------------------------- | ------------------------------------------------------------------------------- |
| Source archived                       | `That league is archived and cannot be rolled over.`                            |
| Active matches                        | `Finish or cancel all active lobbies and matches first (N active: \`id1\`, …).` |
| Duplicate name                        | Same as `/league create`                                                        |
| Compression with `continue` or `hard` | `Compression is only used with reset:soft.`                                     |
| Invalid compression                   | `Compression must be between 0 and 1.`                                          |
| Wrong button actor                    | `Only the person who ran /league rollover can use these buttons.`               |
| Stale confirm                         | `That rollover confirmation is no longer valid.`                                |
| Write to archived league              | `That league is archived. Start a new season or pick an active league.`         |

## Testing

- Unit: continue copies μ, σ, `matchesPlayed` exactly (global + hero); hero-only player gets no invented global
- Unit: after continue, updating successor ratings does not change archived source rows
- Unit: `compression` rejected for `continue` and `hard`
- Unit: empty league continue seeds 0 players and still archives
- Unit: soft-reset μ/σ for global + hero; compression `0`, `0.5`, `1`; empty league mean fallback
- Unit: hard reset produces defaults only
- Unit: block when active matches exist
- Unit: binding migration count; archived status on source
- Integration-light: transaction rolls back on duplicate name
- Command: confirm/cancel; actor mismatch

## Documentation deliverables

| File                                         | Audience                       |
| -------------------------------------------- | ------------------------------ |
| `docs/discord/staff/a6-league-rollover.md`   | Staff — full how-to + impact   |
| `docs/discord/staff/a5-admin-cheat-sheet.md` | Staff — one-line entry         |
| `docs/discord/public/06-rank-and-boards.md`  | Players — short season note    |
| `docs/discord/README.md`                     | Index — add `a6` to staff list |

## Migration / rollout

1. Prisma migration: `LeagueStatus` enum + columns; backfill `ACTIVE`.
2. Deploy bot; existing leagues unchanged until staff run rollover.
3. Post staff guide `a6` in private admin channel.

## Follow-ups (out of scope)

- `/league list` successor/predecessor links in Discord
- Bulk export archived season standings
- Scheduled auto-rollover at date/time
- Tier-band soft reset (alternative math)
- Merge archived leagues in guild-wide leaderboard views
- Seed a successor from a non-predecessor archive (e.g. S2 from frozen S1 while 1.5 is the source)
- Dedicated `/league intermission` command
