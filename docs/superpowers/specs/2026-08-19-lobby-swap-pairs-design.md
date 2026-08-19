# Lobby swap pairs — Design

**Date:** 2026-08-19  
**Status:** Approved  
**Scope:** `general` (host lobby roster; keyed by `leagueId` via existing pending-match resolve)  
**Plan:** written after this spec is signed off (`docs/superpowers/plans/2026-08-19-lobby-swap-pairs.md`)

## Goal

Hosts can reseat **only the players they name** in one `/lobby swap` by passing a compact `pairs` string (`1-7, 5-Gohan, Vegeta-4`). Each pair is a sequential swap or move. Classic two-slot swap stays available on the same command.

## Non-goals

- A new lobby **button** or modal
- Changing the Move / Edit / Add / Remove buttons
- Auto-applying balance hints
- Screenshot / OCR / wc3stats refresh
- Renaming nicks (`1-Gohan` means seat the slot-1 player into Gohan’s **current** seat, not rename slot 1)
- Match-mod access (swap stays **host-only**)
- Schema, env vars, or AWS SSM

## Locked decisions

| Topic | Choice |
| ----- | ------ |
| Entry | Slash only: extend `/lobby swap` |
| Classic form | `slot_a` + `slot_b` (both occupied; existing `swapPlayers`) |
| Batch form | Optional string option `pairs` |
| Mutual exclusion | Exactly one form: pairs **XOR** (`slot_a` **and** `slot_b`) |
| Discord required flags | `slot_a` and `slot_b` become **optional** on the builder (otherwise Discord always demands them). Execute validates XOR. |
| Pair grammar | Either side is a slot **or** a nick: `1-7`, `1-Gohan`, `Gohan-7`, `Gohan-Vegeta` |
| Apply model | Sequential left-to-right `movePlayer` on a working roster (empty dest = move, occupied = swap) |
| Nick binding | Resolve each side against the roster **after** previous pairs |
| Persist | One `applyRosterAndSync` after every pair succeeds; failures do not write |
| Separator | Comma-separated pairs only; whitespace around commas and hyphens ignored |
| Hyphen in nicks | Split each pair on the **last** ASCII `-` |
| Slot vs nick | If the token matches `^[1-9]\d*$`, it is a **slot attempt**: in range → that slot; out of range → `invalidSlotMessage` (not a nick lookup). Otherwise nick (`normalizeNick`) |
| Digit-only nicks | Token `7` is always slot 7, even if a player’s nick is `"7"` |
| Auth | Host only; optional `match_id` unchanged |

## Command contract

`/lobby swap`

| Option | Type | Builder required | Role |
| ------ | ---- | ---------------- | ---- |
| `slot_a` | integer, min/max = game-agnostic 1–12 as today | **false** (was true) | Classic form |
| `slot_b` | integer, same | **false** (was true) | Classic form |
| `pairs` | string, max length **200** | false | Batch form |
| `match_id` | string | false | Unchanged |

Subcommand description should mention both forms (two slots, or `pairs` like `1-7,5-Gohan`).

### XOR rules (execute)

| Input | Result |
| ----- | ------ |
| `pairs` set (non-blank) and neither slot | Batch remap |
| Both slots set and `pairs` absent/blank | Classic `swapLobbyPlayers` |
| Neither form | Error — no roster change |
| Both forms | Error — no roster change |
| Only one of `slot_a` / `slot_b` | Error — no roster change |

Blank `pairs` (whitespace only) counts as **absent**.

## Pair syntax

Examples: `1-7`, `1-7,5-4`, `1-7, 5-Gohan, Vegeta-4`, `cool-guy-7` (nick `cool-guy` → slot 7).

1. Split `pairs` on `,`.
2. Trim each segment. A segment that is empty after trim (leading/trailing/double comma) is invalid.
3. If the whole string trims to empty, the **command** treats it as absent (XOR). The pure parser, if called on empty/whitespace, throws `pairs cannot be empty.`
4. For each segment, split on the **last** `-`. If there is no `-`, or either side is empty after trim → invalid pair.
5. Do **not** treat spaces as pair separators. `1-7 5-4` is one invalid or surprising pair, not two.

## Apply pipeline

```text
/lobby swap
  → XOR validate
  → resolveHostPendingMatch + profileForLeague (unchanged)
  → classic: swapPlayers(slotA, slotB)
     pairs:  applyRemapPairs(players, raw, profile)
  → applyRosterAndSync once
```

`applyRemapPairs` is pure. For each parsed pair, against the **current** working roster:

1. `from = resolveRemapSide(left)`
2. `to = resolveRemapSide(right)`
3. `working = movePlayer(working, from, to, profile)`

`movePlayer` already swaps when the destination is occupied and moves when it is empty. Same-slot and empty-source errors stay those of `movePlayer`.

Classic two-slot swap does **not** switch to `movePlayer` (empty destination still rejected).

## Modules

| File | Change |
| ---- | ------ |
| `src/services/lobby/remap.ts` | `parseRemapPairs`, `resolveRemapSide`, `applyRemapPairs` |
| `src/services/lobby/remap.test.ts` | Parser, resolve, sequential overlap, move vs swap, no persist (pure) |
| `src/services/lobby/actions.ts` | `remapLobbyPlayers({ client, hostDiscordId, matchId, pairs })` |
| `src/services/lobby/index.ts` | Export the use-case |
| `src/commands/lobby/lobby.ts` | Optional `pairs`; optional `slot_a`/`slot_b`; XOR; call remap or classic swap |
| `src/commands/lobby/lobby.test.ts` | Command data: `pairs` optional string; slots no longer required |
| `docs/discord/public/04-fix-the-lobby.md` | Document `pairs` examples |

Keep `roster.ts` as slot math. Remap calls `movePlayer`; it does not duplicate swap/move.

### Interfaces

```ts
type RemapPair = { raw: string; left: string; right: string };

function parseRemapPairs(raw: string): RemapPair[];
function resolveRemapSide(
  token: string,
  players: LobbyPlayer[],
  profile: GameProfile,
): number;
function applyRemapPairs(
  players: LobbyPlayer[],
  raw: string,
  profile: GameProfile,
): LobbyPlayer[];
```

`resolveRemapSide`: trim → if the token matches `^[1-9]\d*$`, parse `n` and return it when `isSlotInProfile(profile, n)`, else throw `invalidSlotMessage(profile)` (e.g. `99` on UDBR is not nick `"99"`). Otherwise `normalizeNick` and find the unique occupant (nicks are already unique per lobby). Unknown nick uses existing copy: `No player with nick "…" in the lobby.`

Integer `0` or leading zeros (`07`) are **nicks**, not slots.

## Errors and copy (English)

Prefix **apply** failures (resolve or `movePlayer`) with the pair’s original trimmed segment:

`Could not apply ${raw}: ${reason}`

Parse failures are not prefixed that way; they use the rows below.

| Case | Message |
| ---- | ------- |
| Neither form | Provide slot_a and slot_b, or pairs. |
| Both forms | Use either slot_a and slot_b, or pairs, not both. |
| Only one slot option | Provide both slot_a and slot_b, or use pairs instead. |
| Parser given empty/whitespace | pairs cannot be empty. |
| Empty comma segment (`, ,` or trailing comma) | Invalid pair "". Use like 1-7 or Gohan-4. |
| No `-` / empty side after last `-` | Invalid pair "{segment}". Use like 1-7 or Gohan-4. |
| Unknown nick | No player with nick "{nick}" in the lobby. |
| Empty source, same slot, occupied-classic | Existing `movePlayer` / `swapPlayers` / slot-range copy |

Success:

- Classic: `Swapped slots {a} and {b} in match `{id}`.` (unchanged)
- Batch: `Applied {n} seat change(s) in match `{id}`.` where `n` is the number of pairs.

## Testing

`remap.test.ts` (UDBR profile unless noted):

- Parse `1-7, 5-4` and hyphenated nick `cool-guy-7`
- Reject missing hyphen, empty side, empty comma segment
- `1-7` occupied dest → swap; empty dest → move
- Sequential overlap: start A@1, B@7, C@3; `1-7, 7-3` matches two leftover `movePlayer` steps (order matters)
- Nick resolves after a prior pair (Gohan moved, then `Gohan-4` uses new seat)
- Unknown nick; invalid slot; token `7` is always slot 7, even if a player’s nick is `"7"` (target that player only by their current slot number, not as a nick)
- ACA slot 11 rejected via profile range

`lobby.test.ts`: `pairs` option present and not required; `slot_a` / `slot_b` not required.

No Discord integration test. No DB migration.

## User guide

In `docs/discord/public/04-fix-the-lobby.md`, add under slash examples:

```
/lobby swap slot_a:1 slot_b:7
/lobby swap pairs:1-7,5-Gohan
```

One line: pairs are slot or nick on each side, comma-separated; occupied dest swaps, empty dest moves.
