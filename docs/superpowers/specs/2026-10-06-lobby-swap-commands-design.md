# Lobby swap commands — design

**Date:** 2026-10-06
**Scope:** mixed — `general` (in-game roster snapshot, embed field, command planner) + `game:warcraft3_udbr` / `game:warcraft3_wos` (`!swap` syntax, bot slot → in-game slot mapping)

## Goal

After **Balance** (or any manual Move/Swap) the Discord roster differs from the real Warcraft lobby. Show the host the exact in-game commands to make the Warcraft lobby match the Discord roster, one per line, copy-paste ready — replacing the removed "Balance hint" field with something actionable.

## What the user said

- Save the last in-game state from a **screenshot or sync** — always the most recent one.
- When people press Balance, show the commands needed to swap quickly in Warcraft, **one per line** for copy/paste; may look like the old suggestion field.
- Room state can be stale — design around it.
- Host-bot command: `!swap <name|slot> <name|slot>`. Slot is the **original in-game slot** (mappable from bot slot; e.g. Broly might be 6, Uub 7). Player names match **case-insensitively and by prefix**. Hero names are **not** accepted.
- Display: **Match Lobby embed field** (visible to everyone).

## Assumptions (correct me)

- "Save the screenshot" = persist the **parsed** roster, not the image.
- In-game swap slot = wc3stats `slots[]` index + 1 (the lobby color number).
- Players not in the Warcraft lobby will simply make their command fail in-game; no extra handling.

## Design

### 1. In-game roster snapshot (`general`)

New nullable columns on `Match`:

| Column               | Type        | Meaning                                                            |
| -------------------- | ----------- | ------------------------------------------------------------------ |
| `inGameRoster`       | `Json?`     | `Array<{ slot: number; nick: string; rawName: string }>` bot slots |
| `inGameRosterAt`     | `DateTime?` | When that state was observed                                       |
| `inGameRosterSource` | `String?`   | `'screenshot' \| 'wc3stats'` — shown in the field footer           |

- `nick` = canonical (normalized, alias-applied) username; `rawName` = exact in-game name (pre-normalize; an OCR alias replaces it with the alias target, since the raw OCR text is the misread) when the source has it, else `nick`.
- **Written** (overwritten, latest wins) whenever a roster comes from the game:
  - Screenshot refresh with ≥1 OCR player (`refreshLobbyFromScreenshot`)
  - wc3stats Refresh that is applied (`refreshLobbyFromWc3stats`, fresh and not kept-existing)
  - Lobby creation from screenshot or wc3stats (`/register_lobby`, `create-from-wc3stats`)
- **Never written** by manual edits, claim/leave, lock, or Balance — those change Discord, not the game.
- Cleared implicitly with the match (PENDING-only feature; not shown after start).
- Raw names: `LobbyPlayer` gains optional `rawName`; OCR extract and `extractWc3statsRoster` populate it before `normalizeNick` / OCR alias mapping.

### 2. Command planner (`general`, pure)

`planSwapCommands(target, snapshot, toInGameSlot)`:

- `target` = current Discord roster (`{ slot, nick }[]`); `snapshot` = `inGameRoster`.
- For each target player `p` at bot slot `t`: if the snapshot has `p.nick` at `t` → skip; else emit `{ name, inGameSlot }` where `name` = snapshot `rawName` for that nick, else `p.nick`, and `inGameSlot = toInGameSlot(t)`.
- Ordered by in-game slot ascending (any order is correct; ascending reads naturally).

**Why this is stale-safe:** each command puts one named player into their **absolute final** slot. Target slots are distinct, so a later command never names a player already placed nor targets a placed slot → the sequence converges from **any** starting arrangement, in any order. The snapshot is only used to _skip_ players already in place. The only stale failure mode is a skipped player who actually moved in-game since the snapshot. Mitigations:

- Footer shows source + age: `_From screenshot · 4 min ago. Run these in Warcraft; after all swaps, Refresh or a new screenshot copies the Warcraft lobby back into Discord._`
- After a game read (Refresh/screenshot) the Discord roster is **replaced** by the Warcraft lobby, so the field always disappears — it is not a confirmation that every swap succeeded. Hosts refresh only after all swaps; if teams are still off, press Balance again. (Corrected after final review.)
- No snapshot → no field (nothing to diff against).

### 3. Game adapter (`game:warcraft3_*`)

- `GameProfile.lobbySwapCommand: 'wc3_bang_swap' | 'none'` — `wc3_bang_swap` for UDBR and WOS.
- Formatter: `` `!swap ${name} ${inGameSlot}` ``.
- `toInGameSlot(botSlot)`: league `LeagueWc3statsSlotMap` (inverted, `wc3statsSlot + 1`) → else game preset map (`UDBR_WC3STATS_SLOT_MAP` / `WOS_WC3STATS_SLOT_MAP`) → else bot slot.
- Core (`lobby-preview`, `discord-sync`) only calls the adapter; no `!swap` literals outside the adapter.

### 4. Embed field

- Match Lobby only (not In Progress / Completed), only when `lobbySwapCommand !== 'none'`, a snapshot exists, and the plan is non-empty.
- Name: `Swap commands`. Value: one command per line, each in inline code (protects names with `_`/`*`; copies cleanly), then the footer line. Capped at the 1024-char field limit: overflow lines collapse to `…and N more`.
- `syncLobbyDiscordMessage` loads the slot map and passes `inGameRoster`, `inGameRosterAt`, `inGameRosterSource`, and the mapper into `buildMatchLobbyEmbed`.

## Known limits

- Players present in Warcraft but not on the Discord roster can be bumped into other slots by the swaps.
- Prefix matching: a full name that is a prefix of another lobby player's name (`goku` / `goku2`) may be ambiguous on the host bot. Accepted for now (`ponytail:` note in the planner).
- Snapshot staleness can only cause _missing_ lines, never wrong swaps (see §2).

## Testing

- Planner property test: simulate `!swap name slot` on random starting arrangements (incl. empty slots and extra in-game players); applying the plan from any start where the snapshot is accurate yields the target; applying the **unskipped** plan from any start yields the target.
- Planner unit tests: skip-in-place, raw name preferred, no snapshot → empty.
- Slot mapping: league map, UDBR preset (bot 5 → 6, bot 7 → 5), WOS preset, fallback.
- Embed: field present on lobby with diff; absent with no snapshot, no diff, In Progress, or `lobbySwapCommand: 'none'`.
- Persistence: screenshot refresh and wc3stats refresh write the snapshot; Balance / manual edits do not.

## Out of scope

- Storing screenshot images.
- Auto-detecting whether commands were executed (verification is via Refresh/screenshot).
- Ephemeral reply to the Balance clicker (unchanged).
