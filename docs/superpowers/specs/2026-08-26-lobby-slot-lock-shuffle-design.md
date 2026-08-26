# Lobby slot lock + shuffle — Design

**Date:** 2026-08-26  
**Status:** Approved for implementation planning  
**Scope:** `general` (slot/team/roster logic via `GameProfile`; hero names are display-only for slot-bound games such as `warcraft3_udbr`)  
**Related:** `lobby-balance.ts` (advisory hints), `roster.ts`, `actions.ts`, `/lobby` slash + lobby buttons

## Goal

Hosts and match mods can **lock** a player into their current lobby slot so balance **hints** and **shuffle** leave that pair alone (e.g. keep someone on Broly). They can **unlock** the same way. Separately, they can **shuffle** unlocked players randomly within teams or across the whole lobby.

## Non-goals

- Auto-applying balance suggestions (hints stay advisory; host still moves manually)
- Blocking manual move / swap / add / remove / claim / leave / wc3stats refresh because of a lock
- Players locking their own slots without host/mod
- Persisting locks after the lobby leaves `PENDING` (start/cancel)
- Re-locking automatically if a player returns to a previously locked slot
- Locking empty slots
- Balance-aware / rating-optimized shuffle (v1 is random only)

## Locked decisions

| Topic          | Choice                                                                                          |
| -------------- | ----------------------------------------------------------------------------------------------- |
| Balance        | Extend existing Balance hint field only — never suggest moves that touch a locked slot/occupant |
| Auth           | Host **or** match mod (`resolvePendingMatchForManage` / `assertCanManageMatch`)                 |
| Lock strength  | Soft — only balance hints + shuffle respect locks                                               |
| Lock semantics | **Player↔slot pair**; stored as `MatchPlayer.locked`; cleared when that pair breaks             |
| Empty slots    | Cannot lock                                                                                     |
| Shuffle scope  | Required choice: `team` (within each team) or `all` (whole lobby; teams can change)             |
| UI             | Buttons on PENDING lobby embed **and** `/lobby` subcommands                                     |
| Storage        | Approach 1: `MatchPlayer.locked Boolean @default(false)` + `LobbyPlayer.locked`                 |
| Language       | English user-facing strings                                                                     |

## Behavior

### Lock / unlock

1. Actor must be host or match mod; match must be `PENDING`.
2. **Lock** targets an occupied slot → set `locked = true` on that roster row. Reject empty slot with a clear English error.
3. **Unlock** clears `locked` on that slot (idempotent if already unlocked).
4. Slash: `/lobby lock` and `/lobby unlock` (explicit). Button: one **Lock / Unlock** flow that toggles the selected occupied slot.
5. Embed roster lines for locked players show a **🔒** marker after the nick.
6. After any roster rewrite (`replaceMatchRoster` path), keep `locked` **only** if the same player identity is still in the same slot; otherwise clear. Manual move/swap/remove/refresh never error because of lock — they simply drop the flag when the pair breaks.
7. If the same player later sits in that slot again, they are **not** locked unless someone locks again.

### Shuffle

1. Same auth + `PENDING` as lock.
2. Pure transform on `LobbyPlayer[]` + `GameProfile` + scope.
3. **`team`:** For each team independently, unlocked occupants are randomly reassigned among that team’s unlocked **occupied** slots (Fisher–Yates). Locked seats keep their occupant. Empty slots stay empty.
4. **`all`:** Unlocked occupants are randomly reassigned among all unlocked **occupied** slots lobby-wide (may change teams). Locked pairs stay put. Empty slots stay empty.
5. Unlocked players never land in a locked slot; locked players never move.
6. If fewer than two unlocked movers exist in the chosen scope, no-op with English message (“Nothing to shuffle”).
7. Apply via existing `applyRosterAndSync` / Discord embed refresh (balance hints recompute afterward).

### Balance hints

1. `suggestBalanceMoves` (and thus embed hints) skips any candidate where `fromSlot` or `toSlot` is locked (or would move a locked occupant).
2. Still up to three improving suggestions, best first; may show fewer or omit the field when nothing legal remains.
3. Disclaimer unchanged: host has the last word.

## Architecture

```text
/lobby lock|unlock|shuffle  +  lobby buttons
  → resolvePendingMatchForManage (host or mod)
  → actions.ts use-cases
       ├─ setLobbySlotLocked / unlockLobbySlot (toggle for button)
       └─ shuffleLobbyRoster(scope)
  → lock/unlock: targeted MatchPlayer.locked update (no roster rewrite)
  → shuffle: replaceMatchRoster with transformed LobbyPlayer[] (locked flags threaded)
  → syncLobbyDiscordMessage
       → loadLobbyRatingPreview → suggestBalanceMoves(…, respect locks)
       → embed with 🔒 + Balance hint
```

**Pure logic**

- `roster.ts` (or small sibling): `shuffleLobbyPlayers(players, profile, scope)` + helpers that clear `locked` when a transform breaks a player↔slot pair.
- `lobby-balance.ts`: filter candidates involving locked slots.
- Lock/unlock does not reshuffle seats; still refreshes the embed so 🔒 and hints update.

**Adapters**

- `/lobby` subcommands in `commands/lobby/lobby.ts`.
- Buttons + selects in `lobby-interactions.ts` / `LOBBY_CUSTOM_IDS` in `lobby-preview.ts`.
- Shared use-cases only in `services/lobby/actions.ts` (no forked business rules).

### Persistence note

`replaceMatchRoster` today deleteMany + createMany. Thread `locked` through `LobbyPlayer` ↔ DB mapping (`matchToLobbyPlayers` / create payload). Any transform that rebuilds the roster must recompute locks with the pair rule above so flags do not stick to the wrong player.

### Auth note

Reuse the same host-or-mod path as `/lobby cancel` (`resolvePendingMatchForManage`). Mods pass `match_id` when acting on someone else’s lobby (existing rule).

## Error handling (English)

| Case                                | Response                                                         |
| ----------------------------------- | ---------------------------------------------------------------- |
| Not host/mod                        | Existing manage-match denial                                     |
| Not PENDING / missing lobby         | Existing lobby resolve errors                                    |
| Lock empty slot                     | Nobody in that slot to lock                                      |
| Unlock empty / missing slot         | Slot out of range or empty (match existing slot validation tone) |
| Shuffle with &lt; 2 unlocked movers | Nothing to shuffle                                               |
| Invalid shuffle scope               | Discord choice validation (slash options only)                   |

## Testing

- Unit: shuffle `team` / `all` preserves locked pairs and empty slots; &lt;2 movers no-op.
- Unit: `suggestBalanceMoves` never returns a move touching a locked slot when better unlocked alternatives exist; returns empty when only locked-touching moves would improve.
- Unit/integration: lock flag survives replace when pair unchanged; clears after move/swap/remove of that player.
- Light adapter coverage for slash/button auth + custom ids if that matches existing lobby test style.

## Out of scope follow-ups (explicit)

- Auto-balance apply button
- Rating-aware shuffle
- Player self-lock
- Hard lock (block manual moves)
