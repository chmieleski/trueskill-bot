# Winstreak Leaderboard — Design

**Date:** 2026-08-16  
**Status:** Approved for implementation planning  
**Scope:** `general` (per-league; not game-specific)

## Goal

Operators can expose a **per-league winstreak leaderboard**: **current** and/or **best** consecutive wins, with configurable display columns and sort key. Players see it via a **live channel message** (same config shape as the overall live board on `League`) and via **`/leaderboard winstreaks`** (paginated).

## Non-goals

- Guild-wide winstreak board (quitters stay guild-wide; this board is per-league)
- Denormalized streak counters on `PlayerRating` (v1 aggregates from match history on read)
- Hero-specific win streaks
- Changing overall/hero/quitter leaderboard behavior or slash page size (still **10 per page**)

## Locked decisions

| Topic         | Choice                                                                                                       |
| ------------- | ------------------------------------------------------------------------------------------------------------ |
| Ladder scope  | **Per-league** — filter matches by `leagueId`                                                                |
| Metrics       | **Current** and **best** win streak                                                                          |
| Display modes | `current` \| `best` \| `both` (moderator-configured)                                                         |
| Sort          | `current` \| `best` (moderator-configured; may sort by a metric not shown)                                   |
| Defaults      | display **`both`**, sort **`current`**                                                                       |
| Config home   | **`League`** (same as overall live board)                                                                    |
| Live size     | **10–100**, default **10**, chunk **25** rows/embed (mirror overall live packing)                            |
| Slash pages   | **10 per page**, Prev/Next buttons, **invoker-only**                                                         |
| Streak input  | `MatchPlayer.result` on **`COMPLETED`** matches only; order by `Match.completedAt`                           |
| Break rule    | Any **non-win** ends the streak (LOSS, including quit-as-loss). **`CANCELLED` ignored**                      |
| Current       | Trailing consecutive WINs from the newest completed match backward                                           |
| Best          | Max consecutive WINs anywhere in that player's league history (includes current)                             |
| Rank ties     | Competition rank; secondary: other metric desc, then username asc                                            |
| Refresh       | Match complete / correction that affects results; bot start; **15 min** fallback; immediate on config change |
| Language      | English user-facing strings                                                                                  |
| Computation   | **On-read aggregate** (approach 1)                                                                           |

## Approach

Mirror the **quitter** module layout (query + embed + channel + tests) but store live binding and display/sort/size on **`League`**, matching the **overall** live board tenancy. Extend `/leaderboard` with `winstreaks` / `setup_winstreaks` and `/config` league keys for display/sort/channel/size.

## Data model

Extend `League`:

```prisma
enum WinstreakLeaderboardDisplay {
  current
  best
  both
}

enum WinstreakLeaderboardSort {
  current
  best
}

model League {
  // …existing fields including overall leaderboard channel/size…
  winstreakLeaderboardChannelId  String?
  winstreakLeaderboardMessageId  String?
  winstreakLeaderboardSize       Int                          @default(10)
  winstreakLeaderboardDisplay    WinstreakLeaderboardDisplay  @default(both)
  winstreakLeaderboardSort       WinstreakLeaderboardSort     @default(current)
}
```

Reject sizes outside `[10, 100]` with a clear English error (do not silently clamp on `/config set`).

### Eligibility

| Sort      | Who appears                                 |
| --------- | ------------------------------------------- |
| `current` | Players with **current ≥ 1** in that league |
| `best`    | Players with **best ≥ 1** in that league    |

## Metrics (precise)

Scope: `Match` rows with `leagueId` = resolved league and `status = COMPLETED`. Ignore `CANCELLED`, `IN_PROGRESS`, and `PENDING`.

For each `Player` with at least one such roster appearance:

1. Collect their `MatchPlayer` rows with non-null `match.completedAt`, ordered by `completedAt` ascending (then `match.id` as tie-break).
2. Walk the sequence of `result` values:
   - `WIN` increments the run length.
   - Any other non-null result (typically `LOSS`) resets the run to 0.
3. **best** = maximum run length observed while walking.
4. **current** = run length at the **end** of the sequence (trailing wins only).

Source of truth remains `MatchPlayer.result` after match report / correction (quitters receive a non-win result and therefore break streaks).

## Commands

### `/config` (league-scoped — **requires** `league` option, like overall leaderboard keys)

| Subcommand                            | Effect                                                                |
| ------------------------------------- | --------------------------------------------------------------------- |
| `set winstreak_leaderboard_channel`   | Bind/repost live message in chosen guild text channel for that league |
| `set winstreak_leaderboard_size`      | Persist size; refresh if bound                                        |
| `set winstreak_leaderboard_display`   | `current` \| `best` \| `both`                                         |
| `set winstreak_leaderboard_sort`      | `current` \| `best`                                                   |
| `clear winstreak_leaderboard_channel` | Unbind + best-effort delete message                                   |
| `clear winstreak_leaderboard_size`    | Reset to **10** + refresh if bound                                    |
| `clear winstreak_leaderboard_display` | Reset to **both**                                                     |
| `clear winstreak_leaderboard_sort`    | Reset to **current**                                                  |
| `view`                                | Include channel · message · size · display · sort for the league      |

Auth: `assertCanConfigureBot` (same as other `/config`).

Mismatched sort vs display (e.g. sort `best` while display `current` only) is **allowed**.

### `/leaderboard winstreaks`

| Option   | Type                  | Notes                                     |
| -------- | --------------------- | ----------------------------------------- |
| `league` | string (autocomplete) | Same resolve rules as `/leaderboard show` |
| `page`   | integer ≥1            | Default `1`                               |

- Load page of 10 using that league's display/sort settings.
- Public reply; pagination buttons with distinct custom ids (e.g. `lb:winstreaks:<userId>:<leagueId>:<page>`).
- Defer if the aggregate may exceed ~3s.

### `/leaderboard setup_winstreaks`

| Option   | Type                  | Notes                                    |
| -------- | --------------------- | ---------------------------------------- |
| `league` | string (autocomplete) | Required when ambiguous; same as `setup` |

- Run in the target channel.
- Auth: `assertCanConfigureBot`.
- Best-effort delete previous live message if bound; post fresh multi-embed live board; persist channel + message ids on that `League`.
- Ephemeral confirmation.

## Embeds

- Title: `Winstreak Leaderboard` (continuations: `Winstreak Leaderboard (continued)`).
- Accent: gold `0xf0b232` (same family as overall).
- Columns: `#` · `Player` · optional `Current` · optional `Best`, filtered by display mode.
- Note sort mode in footer or description (`Sorted by current` / `Sorted by best`).
- Live: chunk 25; `Updated <t:UNIX:R>` only on the **last** embed.
- Empty: `_No win streaks yet._`

## Runtime

```text
setup / refresh / config change
  → load League display, sort, size
  → load COMPLETED MatchPlayer rows for leagueId (result + completedAt + player)
  → compute current/best per player
  → filter eligible + sort + competition ranks
  → take top `size` (live) or page slice (slash)
  → build embed(s)
  → channel.send | messages.edit | interaction reply
```

Hook league winstreak refresh wherever overall league leaderboards already refresh after match complete / correction, plus `ready` and the shared 15‑minute scheduler (`refreshAll…` also refreshes bound winstreak boards).

## Module layout (suggested)

- `src/services/leaderboard/winstreak-leaderboard.ts` — compute, sort, page DTO
- `src/services/leaderboard/winstreak-leaderboard-embed.ts`
- `src/services/leaderboard/winstreak-leaderboard-channel.ts`
- League setters alongside overall leaderboard helpers in the league config service
- Slash: extend `src/commands/player/leaderboard.ts`
- Config: extend `src/commands/config/config.ts`
- Interactions: extend leaderboard button handler for `lb:winstreaks:…`

## Error copy (English)

| Case                     | Message                                                  |
| ------------------------ | -------------------------------------------------------- |
| Size out of range        | `Winstreak leaderboard size must be between 10 and 100.` |
| Not a guild text channel | Same tone as overall live board channel errors           |
| Config forbidden         | Existing configure-bot message                           |
| DM / no guild            | Reject with existing guild-only messaging                |
| League resolve failure   | Existing league resolve messaging                        |

## Testing

- Streak computation: wins continue; loss/quit-as-loss breaks; cancelled ignored; best ≥ current; empty history → 0/0
- Isolation: league A streaks never include league B matches
- Sort by current vs best; competition ranks and secondary keys
- Display column filtering for `current` / `best` / `both`
- Size reject 9 / 101; accept 10 / 100
- Live chunking (same rules as overall size packing)
- Pagination bounds + invoker-only buttons (custom id includes leagueId)
- Refresh skip when channel/message unbound
- Config defaults after clear

## Out of scope follow-ups

- Denormalized `currentWinStreak` / `bestWinStreak` on `PlayerRating` for read performance
- Guild-wide winstreak board
- Hero-scoped streaks
- Configurable slash page size
