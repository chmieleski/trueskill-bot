# Quitter Leaderboard — Design

**Date:** 2026-08-16  
**Status:** Approved for implementation planning  
**Scope:** `general` (guild-wide across all leagues in a Discord server; not game-specific)

## Goal

Operators can expose a **guild-wide quitter leaderboard**: lifetime quit count and/or quit rate, with configurable display columns and sort key. Players see it via a **live channel message** (same config shape as the overall live board) and via **`/leaderboard quitters`** (paginated).

## Non-goals

- Per-league quitter boards (overall live board stays per-league; this board is guild-level)
- Denormalized running counters (v1 aggregates from match history on read)
- Hero-specific quit stats
- Changing overall/hero leaderboard behavior or pagination size (still **10 per page** for slash)

## Locked decisions

| Topic | Choice |
|-------|--------|
| Ladder scope | **Guild-wide** — all leagues with `league.guildId` = this Discord |
| Metrics | **Quit count** and **quit rate** |
| Display modes | `count` \| `rate` \| `both` (moderator-configured) |
| Sort | `count` \| `rate` (moderator-configured; may sort by a metric not shown in columns) |
| Config home | **`GuildConfig`** (not `League`) |
| Live size | **10–100**, default **10**, chunk **25** rows/embed (mirror overall live packing) |
| Slash pages | **10 per page**, Prev/Next buttons, **invoker-only** |
| Quit count | `MatchPlayer.isQuitter = true` on matches in guild leagues |
| Completed (denominator) | Roster appearances on **`COMPLETED`** matches in those leagues |
| Rate | `quitCount / completedCount`; eligible when **completed ≥ 1** (no extra floor) |
| Rank ties | Competition rank; secondary: other metric desc, then username asc |
| Refresh | Match outcome / correction / quitter flag changes that affect counts; bot start; **15 min** fallback; immediate on config change |
| Language | English user-facing strings |

## Approach

Mirror the live overall leaderboard patterns (channel + message id + size + refresh) on **`GuildConfig`**, with on-read aggregation. Extend `/leaderboard` with `quitters` / `setup_quitters` and `/config` guild keys for display/sort/channel/size.

## Data model

Extend `GuildConfig`:

```prisma
enum QuitterLeaderboardDisplay {
  count
  rate
  both
}

enum QuitterLeaderboardSort {
  count
  rate
}

model GuildConfig {
  // …existing role fields…
  quitterLeaderboardChannelId  String?
  quitterLeaderboardMessageId  String?
  quitterLeaderboardSize       Int                        @default(10)
  quitterLeaderboardDisplay    QuitterLeaderboardDisplay  @default(both)
  quitterLeaderboardSort       QuitterLeaderboardSort     @default(count)
}
```

Reject sizes outside `[10, 100]` with a clear English error (do not silently clamp on `/config set`).

### Eligibility

| Sort | Who appears |
|------|-------------|
| `count` | Players with **≥1 quit** in guild leagues |
| `rate` | Players with **≥1 completed** match in guild leagues (rate may be `0%`) |

## Metrics (precise)

Scope: `Match` rows whose `League.guildId` equals the Discord guild. Ignore `IN_PROGRESS` / `PENDING` lobbies so provisional quit flags do not inflate the board.

For each `Player`:

- **quitCount** = count of `MatchPlayer` rows with `isQuitter = true` on matches with status **`COMPLETED` or `CANCELLED`**
- **completedCount** = count of `MatchPlayer` rows on matches with status **`COMPLETED`**
- **rate** = `quitCount / completedCount` when `completedCount ≥ 1`

Source of truth remains `MatchPlayer.isQuitter` (same as match report), keyed by `Match.leagueId → League.guildId`.

## Commands

### `/config` (guild-scoped — **no** `league` option)

| Subcommand | Effect |
|------------|--------|
| `set quitter_leaderboard_channel` | Bind/repost live message in chosen guild text channel |
| `set quitter_leaderboard_size` | Persist size; refresh if bound |
| `set quitter_leaderboard_display` | `count` \| `rate` \| `both` |
| `set quitter_leaderboard_sort` | `count` \| `rate` |
| `clear quitter_leaderboard_channel` | Unbind + best-effort delete message |
| `clear quitter_leaderboard_size` | Reset to **10** + refresh if bound |
| `clear quitter_leaderboard_display` | Reset to **both** |
| `clear quitter_leaderboard_sort` | Reset to **count** |
| `view` | Include channel · message · size · display · sort |

Auth: `assertCanConfigureBot` (same as other `/config`).

Mismatched sort vs display (e.g. sort `rate` while display `count` only) is **allowed**.

### `/leaderboard quitters`

| Option | Type | Notes |
|--------|------|-------|
| `page` | integer ≥1 | Default `1` |

- No league option (guild-wide).
- Load page of 10 using guild display/sort settings.
- Public reply; pagination buttons with distinct custom ids (e.g. `lb:quitters:<userId>:<page>`).
- Defer if the aggregate may exceed ~3s.

### `/leaderboard setup_quitters`

- Run in the target channel.
- Auth: `assertCanConfigureBot`.
- Best-effort delete previous live message if bound; post fresh multi-embed live board; persist channel + message ids on `GuildConfig`.
- Ephemeral confirmation.

## Embeds

- Title: `Quitter Leaderboard` (continuations: `Quitter Leaderboard (continued)`).
- Accent: gold `0xf0b232` (same family as overall).
- Columns: `#` · `Player` · optional `Quits` · optional `Rate` (e.g. `12.5%`) · `G` (completed games), filtered by display mode.
- Note sort mode in footer or description (`Sorted by quits` / `Sorted by rate`).
- Live: chunk 25; `Updated <t:UNIX:R>` only on the **last** embed.
- Empty (count sort): `_No quitters recorded yet._`
- Empty (rate sort): `_No completed matches yet._`

## Runtime

```text
setup / refresh / config change
  → load GuildConfig display, sort, size
  → aggregate quit/completed by player for guild leagues
  → sort + competition ranks
  → take top `size` (live) or page slice (slash)
  → build embed(s)
  → channel.send | messages.edit | interaction reply
```

Hook guild quitter refresh wherever overall leaderboards already refresh after match complete / correction / quitter updates, plus `ready` and the shared 15‑minute scheduler (`refreshAll…` also refreshes bound guild quitter boards).

## Module layout (suggested)

- `src/services/leaderboard/quitter-leaderboard.ts` — aggregate, sort, page DTO
- Channel helpers alongside or in `leaderboard-channel.ts` (guild-scoped refresh APIs)
- Slash: extend `src/commands/player/leaderboard.ts`
- Config: extend `src/commands/config/config.ts` + guild config service
- Interactions: extend leaderboard button handler for `lb:quitters:…`

## Error copy (English)

| Case | Message |
|------|---------|
| Size out of range | `Quitter leaderboard size must be between 10 and 100.` |
| Not a guild text channel | Same tone as overall live board channel errors |
| Config forbidden | Existing configure-bot message |
| DM / no guild | Reject with existing guild-only messaging |

## Testing

- Aggregation across multiple leagues in one guild; other guilds excluded
- Sort by count vs rate; competition ranks and secondary keys
- Display column filtering for `count` / `rate` / `both`
- Size reject 9 / 101; accept 10 / 100
- Live chunking (same rules as overall size packing)
- Pagination bounds + invoker-only buttons
- Refresh skip when channel/message unbound
- Config defaults after clear

## Out of scope follow-ups

- Denormalized `quitCount` / `completedCount` columns for read performance
- Per-league quitter boards
- Minimum-games floor above 1 for rate eligibility
- Configurable slash page size
