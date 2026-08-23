# Manual New-player flag command — Design

**Date:** 2026-08-24  
**Status:** Draft  
**Scope:** `general` (league-scoped `PlayerRating.isNewPlayer`; slash command)  
**Related:** [`2026-08-22-new-player-rating-isolation-design.md`](./2026-08-22-new-player-rating-isolation-design.md)

## Goal

Mods need to correct mistaken New marks (or apply New outside the lobby suggest flow) without waiting for the 5-game auto-clear.

## Non-goals

- Changing auto-suggest, Confirm/Decline buttons, or auto-clear at ≥ 5 completed games
- Rewriting historical `MatchPlayer.wasNewPlayer` snapshots
- Self-service set/clear for non-mods
- Schema or migration changes
- Decay / calibrating rule changes

## Locked decisions

| Topic          | Choice                                                                       |
| -------------- | ---------------------------------------------------------------------------- |
| Command shape  | `/player_new` with subcommands `set` and `clear`                             |
| Permissions    | Match-mod only (`assertHasMatchModRole`)                                     |
| Target         | Exactly one of `nick` or Discord `user` (reject both / neither)              |
| League         | Optional `league` option; same resolve path as other player commands         |
| Effect         | Live `PlayerRating.isNewPlayer` only for `(leagueId, playerId)`              |
| Idempotency    | Already set / already clear → success message stating current state          |
| History        | Do not mutate past `wasNewPlayer`                                            |
| Implementation | Shared use-case in `src/services/rating/new-player.ts`; thin command adapter |
| Language       | English user-facing strings                                                  |

Supersedes the v1 non-goal in the isolation design that deferred “manual toggle beyond auto-suggest.”

## UX

### `/player_new set`

- Options: `nick?`, `user?`, `league?`
- Ensures a `PlayerRating` row exists, then sets `isNewPlayer = true`
- Ephemeral reply, e.g. marked as New / already New

### `/player_new clear`

- Same options
- Sets `isNewPlayer = false` when a row exists; if no row or already false → not marked New
- Ephemeral reply

### Errors (English)

- Guild-only
- Not a match-mod
- Both nick and user, or neither
- Unknown nick / Discord user not linked for the game
- League resolve failure (ambiguous / unbound channel)

## Architecture

```text
/player_new set|clear
  → assertHasMatchModRole
  → resolveLeagueIdFromInteraction
  → resolve player (gameId from league; nick or discordId)
  → setPlayerNewFlag | clearPlayerNewFlag
  → ephemeral reply
```

| Piece                               | Role                                                                  |
| ----------------------------------- | --------------------------------------------------------------------- |
| `src/commands/player/player-new.ts` | Slash `data` + `execute` + league autocomplete                        |
| `src/services/rating/new-player.ts` | `setPlayerNewFlag` / `clearPlayerNewFlag` (write + return status)     |
| Confirm button                      | May call `setPlayerNewFlag` later (optional DRY); not required for v1 |

Rating apply, lobby markers, and decay exemptions keep reading live `isNewPlayer` as today.

## Testing

- Unit: set/clear idempotency and flag write
- Command: subcommand registration (`set`, `clear`) and option presence

## Out of scope follow-ups

- Refactor Confirm button onto `setPlayerNewFlag`
- Audit log / mod-action history for flag changes
