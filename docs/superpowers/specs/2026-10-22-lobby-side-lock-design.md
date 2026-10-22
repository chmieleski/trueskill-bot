# Lobby side lock — Design

**Date:** 2026-10-22  
**Status:** Implemented  
**Scope:** `general` (team/slot logic via `GameProfile`; no game-specific code)  
**Related:** `2026-08-26-lobby-slot-lock-shuffle-design.md` (slot lock), `lobby-balance.ts`, `locked-slots.ts`

## Goal

Let a host or match mod keep a player on their **team** (e.g. "player 2 stays on Evils") while the
Balance button is still free to move them to any other slot on that team, and to re-seat everyone
else to get as close to 50/50 as possible.

## Lock modes

- **`slot`** (`MatchPlayer.locked`): Balance never moves the seat. Cleared when the player↔slot
  pair breaks.
- **`side`** (`MatchPlayer.sideLocked`): Balance moves the player only within their team. Cleared
  when the player ends up on the other team or leaves.
- **`none`** (both false): Balance moves the player freely.

A seat holds at most one mode. Setting one clears the other (`setMatchPlayersLocked` writes both
flags). If both were ever set, `locked` wins (`lockModeOf`).

Locks stay soft: manual move / swap / remove / refresh never error because of a lock.

## Balance (`findBalancedRoster`)

Each attempt:

1. Slot-locked seats stay put; their slots are removed from the open pool.
2. Open slots are split by team and shuffled. Side-locked players take random open slots on their
   own team first.
3. Free players take random slots from what is left (either team).

Scoring is unchanged: team-size gap → New gap → calibrating gap → win% imbalance. Side locks can
force an uneven team split (e.g. 4 of 6 players side-locked on one team); the reply already reports
"Teams split X/Y because of locked seats".

## Persistence (`replaceMatchRoster`)

`reconcileMatchPlayerSideLocked` keeps `sideLocked` when the same `playerId` stays on the team it
was side-locked on (any slot). Incoming `sideLocked: false` = explicit unlock; omitted = no opinion
(screenshot / wc3stats reads). A seat that keeps its slot lock never also keeps a side lock.

Migration: `20261022120000_match_player_side_lock` adds `MatchPlayer.sideLocked BOOLEAN NOT NULL
DEFAULT false`.

## UI

- **Lock / Unlock button:** two selects — 🔒 Slot lock and 🛡️ Side lock — each defaulted to current
  locks. Submitting one sets exactly that mode on the selected seats, clears that mode elsewhere,
  and leaves the other mode alone (`lockChangesForSelection`). The selects re-render after each
  change so both can be edited in one go.
- **`/lobby lock slots:… mode:slot|side`** — `mode` defaults to `slot` (old behaviour).
- **`/lobby unlock`** clears both modes.
- Roster lines show 🔒 (slot) or 🛡️ (side) after the nick.

## Testing

- `locked-slots.test.ts`: side-lock reconcile (same team any slot, team switch, explicit unlock),
  `lockModeOf`, `lockChangesForSelection`.
- `lobby-balance.test.ts`: side-locked players never change team but can change slot; forced uneven
  team split is reported.
- `replace-match-roster.test.ts`: side lock survives an in-team move, clears on team switch and on
  explicit unlock.
