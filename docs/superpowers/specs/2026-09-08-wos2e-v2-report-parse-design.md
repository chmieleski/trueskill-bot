# WOS2E / WOS2_BOT_V2 report parse — Design

**Date:** 2026-09-08  
**Status:** Approved  
**Scope:** `game:warcraft3_wos` (codec + parser + fixtures/tests/docs). Shared ingest call sites (`/register_lobby`, Discord paste, `POST /v1/matches/wos-report`) keep using `parseWos2BotReport` — no HTTP contract change beyond accepted `reportText` format.

## Goal

Replace plaintext **`WOS2_BOT_V1`** parsing with the map’s new **WOS2E v1** authenticated encrypted container. After decrypt, parse **`WOS2_BOT_V2`** / **`schema=2`** records into an extended typed report. Single entrypoint for Discord and the HTTP API.

Reference implementation: `examples/wos2/wos2_bot_decoder.js`.  
Sample export: `examples/wos2/WOS2_bot_match_40789973-21466950-72151551-80533748.txt`.

## Non-goals

- Preferring `lobby_slot` / `visual_slot` in roster mapping (keep existing `team_slot` → pid fallback)
- Persisting new round / ITEM_RATE aggregate fields in the DB in this change
- Changing `POST /v1/matches/wos-report` path, auth, or JSON response shape
- Dual support for plaintext V1
- Shipping codec keys to clients / players

## Locked decisions

| Topic          | Choice                                                                                   |
| -------------- | ---------------------------------------------------------------------------------------- |
| Format support | **WOS2E only** — reject plaintext V1                                                     |
| Implementation | Port decoder to TypeScript under `src/games/warcraft3_wos/`                              |
| Module split   | `wos2e-codec.ts` (crypto/container) + `wos2-bot-report-parser.ts` (records → report)     |
| Entrypoint     | Keep `parseWos2BotReport(rawText)` for all callers                                       |
| New V2 fields  | Parse onto `Wos2BotReport` now; wire consumers later only where needed                   |
| Keys           | Server-side constants ported from map codec; comment: do not distribute to players       |
| Examples       | Keep `examples/wos2/wos2_bot_decoder.js` as map-side reference (not imported by the bot) |
| API            | Same endpoint/body; `reportText` must be WOS2E; update integrator docs                   |

## Architecture

```
raw reportText (Preload wrapper or plain)
        │
        ▼
 extract payload lines (unchanged wrapper strip)
        │
        ▼
 wos2e-codec: WOS2E header + D lines + Z
   → verify MAC / final tag → decrypt → plaintext pipe lines
        │
        ▼
 wos2-bot-report-parser: WOS2_BOT_V2 / schema=2
   → Wos2BotReport (extended)
        │
        ├── fillLobbyFromWos2Report / waiting-approval / stats upload
        └── POST /v1/matches/wos-report (unchanged HTTP shell)
```

## Modules

| Module                         | Role                                                                |
| ------------------------------ | ------------------------------------------------------------------- |
| `wos2e-codec.ts`               | Derive keys, context, MAC, decrypt, container extract, size guard   |
| `wos2-bot-report-parser.ts`    | V2 record validation → `Wos2BotReport`; drop `WOS2_BOT_V1` constant |
| Fixtures / examples            | Encrypted sample for integration-style parse tests                  |
| `docs/api/wos-match-upload.md` | Document WOS2E + `WOS2_BOT_V2`                                      |

## Data model

### Container (before decrypt)

- Header: `WOS2E|v=1|id=<matchId>|alg=R87M2`
- Data: `D|s=<seq>|c=<cipher>|t=<8-char base36 MAC>` (contiguous seq from 0)
- End: `Z|n=<count>|t=<8-char final tag>`

### Decrypted records → `Wos2BotReport`

| Area       | Fields                                                                                                              |
| ---------- | ------------------------------------------------------------------------------------------------------------------- |
| Report     | `format: 'WOS2_BOT_V2'`, `externalId`, `schema: 2`, `teamsReorganized`, `team1Rounds`, `team2Rounds`, `playerCount` |
| Player     | Existing + `lobbySlot`, `visualSlot` (nullable ints); keep `teamSlot`, `left`, hero, items, damage/heal/kills       |
| Stats      | Existing damage/heal/kills + `roundsPlayed`, `roundWins`, `roundLosses`                                             |
| Item rates | Existing `objectId` + `name` + `games`, `wins`, `winratePct`                                                        |

Structural checks match the reference decoder (ID/MATCH, PLAYER+STATS+ITEMS triples, END id match, damage totals, ITEM_RATE winrate math).

## Errors

- Auth/crypto failures (bad MAC, reorder, truncate, invalid cipher char) → parse error mapped to English user/API `400` (same as today’s `Wos2BotReportParseError` path).
- Input over ~1 MiB rejected (aligned with API body limit / reference decoder).
- No silent fallback to plaintext V1.

## Testing

- Codec self-test: round-trip encode/decode + reject tampered / reordered / truncated (port of JS CLI `--self-test`).
- Parser: real encrypted sample → assert V2 fields; reject V1 plaintext.
- Update existing WOS parser / roster / winner / API tests that embed V1 fixtures.

## Downstream (this change)

- Roster, winner inference, stats persistence: **behavior unchanged** except format acceptance; new fields available on the type for later use.
- Integrators uploading via API must send WOS2E exports after deploy.

## Out of scope (follow-ups)

- Slot mapping using `lobby_slot` / `visual_slot`
- DB / UI for round stats and richer ITEM_RATE aggregates
