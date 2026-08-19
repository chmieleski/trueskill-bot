# Live leaderboard size — Design

**Date:** 2026-08-15  
**Status:** Approved for implementation planning  
**Scope:** `general` (per-league live overall message; not game-specific)

## Goal

Operators can configure how many overall ranks appear on the **permanent/live** leaderboard message for a league. The message stays a single Discord message, using **multiple embeds** when needed so tables stay under Discord’s description limit.

## Non-goals

- Changing `/leaderboard show` pagination (stays **10 per page**)
- Live hero leaderboard channel(s)
- Guild-global size independent of league (size lives on `League`, same as channel/message IDs)
- Configurable chunk size (fixed **25**)

## Locked decisions

| Topic               | Choice                                                                                                |
| ------------------- | ----------------------------------------------------------------------------------------------------- |
| Configurable where  | Per **league** via `/config`                                                                          |
| Min size            | **10**                                                                                                |
| Max size            | **100**                                                                                               |
| Default             | **10** (current behavior; existing leagues unchanged until set)                                       |
| Embed chunk size    | **25** rows per embed                                                                                 |
| Max embeds used     | `ceil(size / 25)` → at most **4** at size 100 (Discord allows 10)                                     |
| Why max 100         | Discord hard ceiling is `10 × 25 = 250`; 100 is enough for a channel pin without stuffing the message |
| Slash overall pages | Unchanged at **10**                                                                                   |
| On size change      | Refresh live message if channel + message are bound                                                   |

## Discord packing

- Embed description limit: **4096** characters.
- Fixed **25** rows per embed keeps each table comfortably under that limit with monospace columns.
- One message: `{ embeds: [...] }` on setup, edit, and repost.
- First embed title: `Global Leaderboard`.
- Continuation titles: `Global Leaderboard (continued)`.
- Relative update timestamp `Updated <t:UNIX:R>` only on the **last** embed’s description.
- Empty ladder: single embed, existing empty copy (`_No ranked players yet._`).

## Data model

Extend `League`:

```prisma
leaderboardSize Int @default(10)
```

Clamp on write: reject or coerce outside `[10, 100]` — **reject** with a clear English error (do not silently clamp on `/config set`).

## Commands

### `/config set leaderboard_size`

| Option   | Type                   | Notes                                         |
| -------- | ---------------------- | --------------------------------------------- |
| `size`   | integer                | Required; must be **10–100** inclusive        |
| `league` | existing league option | Same resolution as other league-scoped config |

Auth: `assertCanConfigureBot` (same as other `/config set`).

On success:

1. Persist `League.leaderboardSize`.
2. If `leaderboardChannelId` and `leaderboardMessageId` are set, refresh that message with the new size.
3. Ephemeral confirmation including the new size.

### `/config clear leaderboard_size`

Reset to default **10**, then refresh live message if bound (same as set).

### `/config view`

Show live board line including size always as a number, e.g. channel · message · size `N`.

### `/leaderboard setup` / channel set/clear

Unchanged aside from reading `leaderboardSize` when posting/editing the live message.

## Runtime

```text
setup / refresh / size change
  → load League.leaderboardSize (default 10)
  → loadOverallLeaderboardTop(leagueId, size)
  → chunk entries by 25
  → buildOverallLiveEmbeds(chunks, updatedAt)
  → channel.send | messages.edit({ embeds })
```

Replace the single-embed live path in `leaderboard-channel` with a multi-embed builder (keep command embeds on the existing single-page builder).

Constants (suggested):

- `LIVE_LEADERBOARD_MIN_SIZE = 10`
- `LIVE_LEADERBOARD_MAX_SIZE = 100`
- `LIVE_LEADERBOARD_CHUNK_SIZE = 25`
- `LIVE_LEADERBOARD_DEFAULT_SIZE = 10`

Deprecate/remove the fixed `LIVE_LEADERBOARD_SIZE = 10` as the only live limit; use the league value instead.

## Error copy (English)

| Case                   | Message                                             |
| ---------------------- | --------------------------------------------------- |
| Size out of range      | `Live leaderboard size must be between 10 and 100.` |
| Config forbidden       | Existing configure-bot message                      |
| League resolve failure | Existing league resolve messages                    |

## Testing

- Clamp/reject: size 9 and 101 fail; 10, 25, 50, 100 succeed
- Chunking: 10 → 1 embed; 25 → 1; 26 → 2; 100 → 4
- Timestamp only on last embed
- Refresh/edit passes `embeds` array
- Default 10 when column is default / unset after clear
- `/leaderboard show` page size still 10 (no regression)

## Out of scope follow-ups

- Configurable chunk size or max above 100
- Live hero boards
- Per-guild size shared across all leagues in the guild
