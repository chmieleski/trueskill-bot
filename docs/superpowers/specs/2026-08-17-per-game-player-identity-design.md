# Per-Game Player Identity & Discord Link — Design

**Date:** 2026-08-17  
**Status:** Approved for implementation planning  
**Scope:** `general` (identity / tenancy — not `game:<id>` adapters)

## Goal

Make **Player identity** and **Discord↔nick linking** scoped by **`Game.id`** (catalog game / map product, e.g. `warcraft3_udbr` vs `warcraft3_anime_choice_arena`), while keeping ratings and matches league-scoped.

A channel (or category) bound to a league automatically selects that league’s `gameId` for `/link`, `/unlink`, and Discord→nick resolution — same league-resolve path as `/rank`.

## Problem

Today `Player.username` and `Player.discordId` are **globally** unique. One Discord account can bind only one nick across the whole bot. A second game (different map / roster) cannot use a different nick for the same Discord user without fighting the UDBR link.

Multi-league already isolates **Elo** per league; identity was deliberately left global. That identity choice is superseded here for multi-game guilds.

## Non-goals

- Per-**league** or per-**guild** Discord links
- Explicit slash `game:` option (league resolve is enough)
- Changing OpenSkill math, match status machine, or leaderboard formulas
- Rewriting historical match nick strings
- Self-service link approval queues

## Locked decisions

| Topic             | Choice                                                                                                   |
| ----------------- | -------------------------------------------------------------------------------------------------------- |
| Isolation key     | **`Game.id`** (not league, not guild)                                                                    |
| Player identity   | **`(gameId, username)`** — same nick string on two games = two `Player` rows                             |
| Discord bind      | On `Player`: at most one linked Discord per `(gameId, discordId)`; at most one nick per Discord per game |
| World scope       | Bind is **global for that game** — not per guild. Documented below.                                      |
| Game selection UX | **League resolve** only (same as `/rank`)                                                                |
| Legacy migration  | All existing `Player` rows → `gameId = warcraft3_udbr`; existing Discord binds become UDBR binds         |
| New games         | Fresh `Player` rows + fresh `/link`s (no auto-copy from UDBR)                                            |
| Schema approach   | Add `gameId` on `Player`; drop global uniques on `username` / `discordId`                                |

### Documented rule — worldwide per-game bind

**One Discord account + one `gameId` → one in-game nick, worldwide.**

- Linking in Guild A for UDBR also applies in Guild B’s UDBR leagues.
- Two UDBR leagues in the same guild share one UDBR bind.
- Relinking that Discord on UDBR (any guild) is a conflict / mod `allowRelink`, not a second identity.
- Anime Choice (or any other `Game.id`) is a **separate** bind and may use a different nick.

This is intentional. Operators and public docs must say so.

## Relationship to prior specs

| Spec                                                                                              | Change                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [2026-08-15-multi-league-ihl-design](./2026-08-15-multi-league-ihl-design.md)                     | **Supersedes** locked “global Player; unique `discordId`” and the non-goal “per-league Player / Discord link” **only for identity**. Ratings/matches remain `leagueId`-scoped. Leave a short supersession note in that doc when implementing. |
| [2026-08-14-player-rank-link-design](./2026-08-14-player-rank-link-design.md)                     | `/link` / `/unlink` / Discord lookup for `/rank` gain `gameId` via league resolve; auth and conflict copy stay the same shape.                                                                                                                |
| [2026-08-15-wc3stats-host-lobby-prompt-design](./2026-08-15-wc3stats-host-lobby-prompt-design.md) | Host nick match and ping preference resolve against the **league’s game** `Player` row.                                                                                                                                                       |

## Data model

```prisma
model Player {
  id                             String   @id @default(uuid())
  gameId                         String
  username                       String   // in-game nick within this game
  discordId                      String?  // optional Discord bind for this game
  wc3statsHostPromptPingsEnabled Boolean  @default(true)
  createdAt                      DateTime @default(now())
  updatedAt                      DateTime @updatedAt

  game            Game                 @relation(...)
  matches         MatchPlayer[]
  ratings         PlayerRating[]
  heroRatings     PlayerHeroRating[]
  rankResets      PlayerRankReset[]
  ratingSnapshots MatchRatingSnapshot[]

  @@unique([gameId, username])
  @@unique([gameId, discordId])
  @@index([gameId])
  @@index([discordId])
  @@index([username])
}
```

Notes:

- Postgres `UNIQUE (gameId, discordId)` allows multiple rows with `discordId = NULL` (unlinked players).
- Drop `username @unique` and `discordId @unique`.
- `Game` gains `players Player[]`.

### Migration

1. Add nullable `gameId` (or add with default in SQL).
2. `UPDATE "Player" SET "gameId" = 'warcraft3_udbr' WHERE "gameId" IS NULL`.
3. Enforce `NOT NULL` + FK to `Game`.
4. Replace unique indexes as above.
5. Ensure `Game` row `warcraft3_udbr` exists before FK (already required by multi-league).

No duplication of players into other games.

## Commands & resolve path

**Game selection** for `/link`, `/unlink`, and any Discord→nick lookup used from slash/settings:

1. Explicit `league:` option (where present)
2. Channel binding
3. Category binding
4. Sole league in guild
5. Else fail with existing league-resolve copy

Then use `league.gameId`.

| Surface                                 | Behavior                                                                                                                                                     |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/link`                                 | Resolve league → bind Discord to `(gameId, nick)`. Create `Player` for that game if nick unseen there. First-time bind open; relink needs mod `allowRelink`. |
| `/unlink`                               | Resolve league → clear `discordId` only on that game’s row.                                                                                                  |
| `/rank`                                 | Ratings already use `leagueId`; Discord/nick → `Player` must filter by that league’s `gameId`.                                                               |
| Lobby claim / `/lobby add user:`        | Use the **match’s** league `gameId` (match already has `leagueId`).                                                                                          |
| Host prompt / player host-ping settings | League/channel context → that game’s `Player`; preference remains on the per-game row.                                                                       |

**Copy:** English. Unlinked errors may name the game when helpful (e.g. not linked for this league’s game).

`/link` and `/unlink` should gain the same optional `league` option pattern as other IHL commands if not already present.

## Integrity

- **Roster resolve** (`resolvePlayersInTx` and equivalents): find/create by `(gameId, username)` only, with `gameId` from the match’s league — never username-global.
- **Invariant:** `MatchPlayer.player.gameId === Match.league.gameId` (enforce in app when attaching roster; do not cross-wire games).
- Ghost create on first sighting or `/link` creates only that `(gameId, nick)`.

## Call sites to update (implementation checklist)

Non-exhaustive but required:

- `src/services/player/player-link.ts` (+ tests)
- `src/services/player/player-profile.ts` (+ tests)
- `src/services/player/player-settings.ts` (+ tests)
- `src/commands/player/link.ts`, `unlink.ts`, `rank.ts` (league resolve on link/unlink)
- `src/services/lobby/lobby-identity.ts` (+ tests) — `nickForDiscordId(discordId, gameId)`
- `src/services/match/match-service.ts` — `resolvePlayersInTx` filter/create by `gameId`
- Rank-reset / host-prompt paths that load `Player` by `discordId`
- Scripts that `findUnique` by `username` alone (e.g. seed helpers)
- Public/staff Discord docs: `docs/discord/public/02-link-your-nick.md`
- Cursor rules that still say “global Player link” (`feature-scope-game-vs-general.mdc`, overview if needed)
- Supersession note on multi-league identity section

## Testing

- Link Discord to nick A on UDBR and nick B on Anime Choice; both succeed; lookups are game-correct.
- UDBR `/link` does not satisfy Anime Choice lobby claim / `nickForDiscordId`.
- Two guilds, same game: second `/link` for same Discord without relink → conflict.
- Match roster create finds existing `(udbr, nick)` and does not attach `(anime, nick)`.
- Migration backfill: existing rows have `warcraft3_udbr`; unique constraints apply.

## Success criteria

- Same Discord can hold different nicks on different `Game.id`s.
- Channel-bound league automatically selects the game for link/unlink/claim.
- Legacy UDBR history and links keep working after migration.
- Docs state the worldwide-per-game bind rule clearly.
- No global `@unique` remains on `Player.username` or `Player.discordId`.
