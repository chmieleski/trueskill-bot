# Leaderboard — Design

**Date:** 2026-08-14  
**Status:** Approved for implementation planning  
**Scope:** Global overall + hero leaderboards via `/leaderboard`, plus a per-guild live overall message that auto-refreshes

## Goal

Players and moderators can view **top rankings** in polished Discord embeds:

- **Overall (global ki)** — on demand via `/leaderboard`, paginated; plus an optional **live channel message** (top 10) that updates whenever ratings change.
- **Hero (hero ki)** — on demand via `/leaderboard` only (no live channel in v1).

Ratings remain global (not per-guild). Public scores use **ki** via `displayOrdinal`; never show raw μ/σ.

## Non-goals (v1)

- Live hero leaderboard channel(s)
- Per-guild ladders or rating isolation
- Persisting ki or rank position columns
- Configurable minimum-games threshold (fixed rules in v1)
- Self-service link changes (unchanged from rank/link spec)

## Locked decisions

| Topic                             | Choice                                                                                   |
| --------------------------------- | ---------------------------------------------------------------------------------------- |
| Overall command                   | Top **10 per page**, paginated                                                           |
| Overall live channel              | Top **10 only**, single edited message                                                   |
| Hero command — no `hero` option   | All **12 heroes**, top **3** each (`matchesPlayed > 0`)                                  |
| Hero command — with `hero` option | Top **10** for that hero                                                                 |
| Live channel content              | **Overall only** (hero live = tech debt)                                                 |
| Pagination UX                     | **Buttons** (Prev/Next) **and** slash `page` option                                      |
| Pagination auth                   | **Only the invoker** may use page buttons                                                |
| Live channel setup                | `/leaderboard setup` in target channel **and** `/config set leaderboard_channel` to move |
| Live channel disable              | `/config clear leaderboard_channel`                                                      |
| Setup auth                        | `canConfigureBot` (Manage Guild or hard-coded owner ID)                                  |
| Refresh triggers                  | Match **COMPLETED** + **bot start** + **15 min** periodic fallback                       |
| Overall eligibility               | Player must have **≥1 completed match** (WIN/LOSS on COMPLETED match)                    |
| Hero eligibility                  | `PlayerHeroRating.matchesPlayed > 0`                                                     |
| Rank ties                         | Competition rank (1, 2, 2, 4) — same as `/rank`                                          |
| Ladder scope                      | **Global** across all players in DB                                                      |
| Visual style                      | Gold accent `0xf0b232`, monospace aligned tables (consistent with `/rank`)               |
| Language                          | All user-facing strings in **English**                                                   |

## Tech debt

1. **Live hero leaderboard** — optional second live message or dual-embed channel (overall + hero boards).
2. **Configurable minimum games** — per-guild threshold instead of fixed ≥1 overall.
3. **Per-guild filtered leaderboard** — would need guild-scoped player sets or match filtering.
4. **Leaderboard entry animations / rank delta** — show ↑↓ since last refresh.

## Commands

Discord requires **subcommands** when `setup` exists, so the root command is `/leaderboard` with:

- `show` — view leaderboards (this is the default user-facing action)
- `setup` — bind live overall message to the current channel

### `/leaderboard show`

Options:

| Option | Type                 | Notes                                                                                                        |
| ------ | -------------------- | ------------------------------------------------------------------------------------------------------------ |
| `type` | string choice        | `overall` (default) \| `hero`                                                                                |
| `hero` | string, autocomplete | When `type=hero`: omit for all-heroes compact view; set for single-hero top 10. Ignored when `type=overall`. |
| `page` | integer ≥1           | Default `1`; **overall only**                                                                                |

Behavior:

- **`type=overall`** (default): load eligible global top-N, render page `page` (10 entries). Attach Prev/Next buttons when total pages > 1. Buttons disabled at bounds.
- **`type=hero`, no `hero`**: single embed — 12 heroes × top 3 each. No pagination.
- **`type=hero`, with `hero`**: resolve hero by autocomplete name → top 10 for that hero. No pagination.

Reply: **public** (same as `/rank` lookups for other players).

Defer when query may exceed ~3s (hero all-12 mode or large player pool).

Command description should mention both modes so users discover `/leaderboard show` easily (e.g. root description: "View global and hero leaderboards").

### `/leaderboard setup`

Run in the target channel.

- Auth: `assertCanConfigureBot`
- Best-effort delete previous live message if `leaderboardMessageId` exists
- Post fresh overall top-10 embed (no buttons)
- Persist `leaderboardChannelId` + `leaderboardMessageId` on `GuildConfig`
- Ephemeral confirmation: `Live overall leaderboard set in this channel. Keep only this message here.`

### `/config` extensions

| Subcommand                                 | Effect                                                   |
| ------------------------------------------ | -------------------------------------------------------- |
| `set leaderboard_channel` + channel option | Same as setup but for chosen channel; repost message     |
| `clear leaderboard_channel`                | Null channel/message IDs; best-effort delete old message |
| `view`                                     | Show leaderboard channel + message ID lines              |

Auth: same as existing `/config` (Manage Guild | owner).

## Data model

Prisma migration — extend `GuildConfig`:

```prisma
model GuildConfig {
  guildId                String   @id
  matchCreateRoleId      String?
  matchModRoleId         String?
  leaderboardChannelId   String?
  leaderboardMessageId   String?
  createdAt              DateTime @default(now())
  updatedAt              DateTime @updatedAt
}
```

No new tables. Ki always derived from μ/σ at read time.

## DTOs & queries

### Overall entry

```typescript
type OverallLeaderboardEntry = {
  rank: number; // competition rank on full eligible list
  playerId: string;
  username: string;
  ki: number;
  games: number; // completed WIN/LOSS count
  discordId: string | null;
};
```

Query strategy:

1. Load `PlayerRating` rows with `Player` join.
2. For each player, count `MatchPlayer` where `match.status = COMPLETED` and `result IN (WIN, LOSS)`.
3. Filter `games >= 1`.
4. Compute `ki = displayOrdinal(mu, sigma)`.
5. Sort `ki DESC`, `username ASC`.
6. Assign competition ranks on the full sorted list; slice for page.

Pagination: `pageSize = 10`, `offset = (page - 1) * 10`, clamp `page` to `[1, totalPages]`.

### Hero entry

```typescript
type HeroLeaderboardEntry = {
  rank: number;
  playerId: string;
  username: string;
  ki: number;
  matchesPlayed: number;
};
```

- Single hero: top 10 where `heroId` matches and `matchesPlayed > 0`.
- All heroes: for each hero ID 1–12, top 3 by ki (same filter).

Hero autocomplete: load hero names from `Hero` table (ensure rows exist via same pattern as `rating-preview`).

## Embeds

Shared constants: `RANK_GOLD = 0xf0b232`.

### Overall (command page or live channel)

- **Title:** `Global Leaderboard`
- **Description:** `Page {page} of {totalPages} · {totalPlayers} players` (omit page line on live channel — always page 1)
- **Body:** monospace code block, columns `#`, `Player`, `Ki`, `G` (games)
- Top 3 rows prefixed with medal emoji (`🥇🥈🥉`) in the `#` column; ranks 4+ use `#4`, `#5`, …
- **Footer (live channel):** `Updated <t:UNIX:R>` (Discord relative timestamp)
- **Footer (command):** `Use /leaderboard page:N to jump · Only you can use the buttons` when buttons shown

Linked Discord accounts: show in-game `username` only in the table (no mass mentions in live channel). Command pages may append a second line or field `Linked accounts on this page` only if needed — default **username only** to avoid clutter.

### Hero — all 12

- **Title:** `Hero Leaderboards`
- **Fields:** one field per hero (name = hero name), value = monospace top-3 block `# rank  player  ki` or `_No games yet_` if empty.

Layout: up to 12 fields; prefer 3-column inline grouping where Discord limits allow, or stacked fields if cleaner.

### Hero — single

- **Title:** `{HeroName} Leaderboard`
- Same table style as overall (top 10, medals for top 3).

## Live channel refresh

```text
match-report → applyMatchRatings → status COMPLETED
  → refreshAllLeaderboardChannels(client)   // fire-and-forget

ready
  → refreshAllLeaderboardChannels(client)
  → startLeaderboardRefreshScheduler(client)   // 15 min interval

scheduler tick
  → refreshAllLeaderboardChannels(client)
```

`refreshGuildLeaderboard(client, guildId)`:

1. Load `GuildConfig` leaderboard IDs.
2. If either ID missing → return.
3. Build overall top-10 embed (same builder as live channel; no pagination).
4. Try `channel.messages.edit(messageId, { embeds })`.
5. On failure (404, channel gone): post new message, update `leaderboardMessageId`.
6. Log warnings; never throw into match-report path.

Refresh all guilds: `findMany` guild configs where `leaderboardChannelId` and `leaderboardMessageId` are non-null.

## Pagination buttons

Custom ID format: `leaderboard:page:{invokerId}:{page}`

- `invokerId` = Discord user ID who ran `/leaderboard`
- Handler rejects interaction if `interaction.user.id !== invokerId` with ephemeral: `Only the person who ran /leaderboard can change pages.`
- Rebuild embed for requested page; update buttons (Prev disabled on page 1, Next disabled on last page).

Store minimal state in the custom ID (page + invoker); **no in-memory session store** — re-query DB on each button press.

## Architecture

```text
/leaderboard | /leaderboard setup
  → leaderboard service (queries)
  → leaderboard-embed (builders)
  → reply / post

/config set|clear leaderboard_channel
  → guild-config
  → leaderboard-channel (setup / clear)

leaderboard button
  → assert invoker
  → leaderboard service + embed
  → interaction.update

match-report COMPLETED
  → leaderboard-channel.refreshAll (async)

ready
  → refreshAll + scheduler
```

| Module                                     | Responsibility                                         |
| ------------------------------------------ | ------------------------------------------------------ |
| `src/services/leaderboard.ts`              | Queries, pagination, competition rank, hero resolution |
| `src/services/leaderboard-embed.ts`        | Embed builders (overall, hero single, hero all)        |
| `src/services/leaderboard-channel.ts`      | Setup, clear, refresh one/all, repost on 404           |
| `src/services/guild-config.ts`             | Extended resolve + set/clear leaderboard fields        |
| `src/commands/player/leaderboard.ts`       | Slash command + setup subcommand                       |
| `src/handlers/leaderboard-interactions.ts` | Page button handler                                    |
| `src/commands/config/config.ts`            | set/clear/view leaderboard channel                     |
| `src/handlers/interaction-create.ts`       | Route `leaderboard:*` buttons                          |
| `src/services/match-report.ts`             | Hook after COMPLETED                                   |
| `src/events/ready.ts`                      | Initial refresh + scheduler                            |

Auth for setup/config reuses `assertCanConfigureBot` — no match-mod role required.

## Error copy (English)

| Case                          | Message                                                  |
| ----------------------------- | -------------------------------------------------------- |
| Unknown hero                  | `Unknown hero.`                                          |
| Invalid page                  | `Page must be between 1 and {totalPages}.`               |
| Pagination not yours          | `Only the person who ran /leaderboard can change pages.` |
| Setup not in guild            | `This command can only be used in a server.`             |
| Config forbidden              | `You do not have permission to configure this bot.`      |
| Hero option with overall type | Silently ignore `hero` when `type=overall`               |
| Empty overall ladder          | Embed title + `_No ranked players yet._`                 |
| Empty hero ladder             | `_No games yet for {hero}.`                              |

## Testing

- Unit: competition rank on leaderboard list; pagination bounds; eligibility filter (≥1 game overall, hero matchesPlayed); page clamp
- Unit: embed snapshot / field shape for overall page, all-heroes, single-hero
- Unit: button custom ID parse; invoker mismatch → error
- Unit: guild-config set/clear leaderboard fields
- Integration-light: refresh skips guilds without config; repost updates message ID (mock Discord client optional)

## Out of scope follow-ups

- Rank history graphs
- Seasonal resets
- Web dashboard export
