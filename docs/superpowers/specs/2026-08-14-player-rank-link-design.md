# Player Rank & Account Link — Design

**Date:** 2026-08-14  
**Status:** Approved for implementation planning  
**Scope:** Public player profile via `/rank`, plus moderator `/link` and player/mod `/unlink`

## Goal

Anyone can inspect their own or another player’s **rank profile** (global ki, leaderboard position, W/L, hero kis) in a polished Discord embed. Moderators can bind in-game nicks to Discord accounts so `/rank` with no args resolves “me”.

## Non-goals

- Self-service link with mod approval queue (see Tech debt)
- Global leaderboard command (`/leaderboard` top-N)
- Persisting ki or rank position columns
- Displaying raw OpenSkill μ/σ
- Creating ghost players from `/rank` or `/link` when the nick does not exist
- Changing rating math or match report flow

## Locked decisions

| Topic | Choice |
|-------|--------|
| Commands | Separate `/rank`, `/link`, `/unlink` (approach 1) |
| Lookup | Discord `user` **or** in-game `nick`; not both. No args → caller’s linked account |
| Profile content | Global ki, competition rank #, W/L (+ WR%), all heroes with `matchesPlayed > 0` |
| Rank position | Competition rank among all `PlayerRating` rows by display ki desc (ties share place: 1,2,2,4) |
| Embed layout | **A — Hero header**: gold accent `0xf0b232`, title `Rank #N · X ki`, compact W/L, monospace hero table, Discord avatar thumbnail when linked |
| Link auth | Match **moderator role** only (same role ID used for match mods). Lobby host alone cannot `/link` |
| Link validation | Honor-system deferred; mods set the binding. Nick must already exist as `Player` |
| Unlink | Caller unlinks self; mod may pass `user` to unlink another |
| Reply visibility | `/rank` public; `/link` / `/unlink` ephemeral |
| Language | All user-facing strings in English |
| Schema | No Prisma changes — only `Player.discordId` writes on link/unlink |

## Commands

### `/rank`

Options (optional, mutually exclusive):

- `user` — Discord user
- `nick` — in-game username

Resolution order:

1. Both set → error  
2. `user` → `Player` by `discordId`  
3. `nick` → `Player` by `username` (prefer exact case-insensitive unique match)  
4. Neither → `Player` by caller `discordId`; if missing → ask a mod to `/link`

### `/link`

- Required: `nick`  
- Required: `user` (Discord account to bind)  
- Auth: member has match moderator role; if role unset/empty → forbidden with clear copy  
- Effects: set `Player.discordId` for that nick  
- Conflicts: nick already linked to another Discord, or Discord already linked to another player → error  

### `/unlink`

- Optional: `user` (mod-only when targeting someone else)  
- No `user` → clear caller’s linked `Player.discordId`  
- With `user` → require mod role; clear that user’s link  

## Profile data

```text
globalKi     = displayOrdinal(mu, sigma) from PlayerRating
               // no row: display-only cold start (μ 25, σ 8.333) — do not INSERT on /rank
rankPosition = competition rank by globalKi among all PlayerRating rows;
               if this player has no row, rank them virtually as cold-start ki
               against existing rows (still no INSERT)
wins/losses  = MatchPlayer.result on COMPLETED matches (DRAW ignored)
winRate      = wins / (wins + losses) when games > 0; omit WR% when 0 games
heroes[]     = PlayerHeroRating where matchesPlayed > 0
               sort by hero ki desc; include hero name, ki, matchesPlayed
```

Never show raw μ/σ. Reuse `displayOrdinal` from `rating-math.ts`. `/rank` is read-only (no rating upserts).

## Architecture

```text
/rank
  → player-profile (resolve + load DTO)
  → rank-embed (layout A)
  → public reply

/link | /unlink
  → assert mod when required
  → player-link
  → ephemeral reply
```

| Module | Responsibility |
|--------|----------------|
| `src/commands/player/rank.ts` | Slash adapter |
| `src/commands/player/link.ts` | Slash adapter + mod gate |
| `src/commands/player/unlink.ts` | Slash adapter + self/mod gate |
| `src/services/player-profile.ts` | Resolve player, ki, rank #, W/L, heroes |
| `src/services/player-link.ts` | Link/unlink + conflict checks |
| `src/services/rank-embed.ts` | `EmbedBuilder` for layout A |

Auth helper: extract or reuse “has match mod role” without requiring a match host (today `canManageMatch` always allows host — `/link` must **not** use host bypass). Prefer a small `hasMatchModRole(memberRoleIds)` shared with match auth when practical.

If guild-config roles land first, resolve mod role via the same path as match commands (DB-or-env), not a hard-coded env-only fork.

## Embed (layout A)

- Accent color: `0xf0b232`  
- Author / name: in-game `username`  
- Title: `Rank #N · {ki} ki`  
- Description or field: `{W}W · {L}L · {WR}% WR` (omit WR% if 0 games)  
- Field **Heroes**: monospace block `HeroName  ki · matches` (aligned); empty → `_No hero games yet_`  
- Thumbnail: Discord avatar URL when `discordId` present  
- Footer: `Linked` + mention/tag when linked; otherwise omit or `Not linked to Discord`

## Error copy (English)

| Case | Message |
|------|---------|
| Self `/rank` not linked | `Your Discord is not linked to an in-game nick. Ask a moderator to run /link.` |
| Player not found | `Player not found.` |
| Both user and nick | `Provide either a Discord user or a nick, not both.` |
| Nick missing on link | `No player with that nick.` |
| Discord/nick already linked | `That nick or Discord account is already linked.` |
| Unlink when not linked | `Your Discord is not linked.` |
| Target unlink not linked | `That Discord account is not linked.` |
| Missing mod role | `Only match moderators can do that.` |
| Mod role not configured | `Match moderator role is not configured.` |

## Testing

- Unit: competition rank ties; W/L aggregation; resolve self/user/nick; link conflict cases  
- Unit or light snapshot: embed field shape for layout A (optional if costly)  
- No DB migration tests

## Tech debt

1. **Self-service link + mod approval (model C)** — player requests `/link`; mod approves/rejects; replaces mod-only binding for the happy path while keeping mod override.  
2. Optional `/leaderboard` top-N command.  
3. Case-collision handling if multiple usernames differ only by case (schema is case-sensitive unique today).

## Out of scope follow-ups

- Image-generated rank cards  
- Per-guild separate ladders  
- Linking during lobby OCR automatically
