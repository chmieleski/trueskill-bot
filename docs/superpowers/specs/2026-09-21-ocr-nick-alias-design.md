# Per-league OCR nick aliases — Design

**Date:** 2026-09-21  
**Status:** Approved  
**Scope:** `general`

## Goal

Staff can map screenshot-OCR misreads to canonical in-game nicks **per league** (e.g. `b0jan` → `bojan`), so lobbies link to the correct `Player` without fixing every screenshot by hand.

## Non-goals

- Fuzzy / Levenshtein matching
- Applying aliases to wc3stats import, WOS reports, or manual nick add/edit
- Requiring the target nick to already exist as a `Player`
- Guild-global or Event-scoped aliases
- Changing Gemini prompts or OCR models

## Decisions (locked)

| Topic         | Choice                                                                                               |
| ------------- | ---------------------------------------------------------------------------------------------------- |
| Scope         | Screenshot OCR only                                                                                  |
| Tenancy       | Per `leagueId`                                                                                       |
| Matching      | Exact key after `normalizeNick`                                                                      |
| Target nick   | Free-form (normalized); no Player existence check                                                    |
| Admin UX      | `/ocr_nick_alias_config` set / clear / clear_all / list (config staff); also shown on `/config view` |
| Storage       | Child table `LeagueOcrNickAlias` (not JSON on `League`)                                              |
| Event lobbies | Skip aliases (no league)                                                                             |

## Architecture

```text
Screenshot → Gemini OCR → normalizeNick (in lobby-ocr)
  → load LeagueOcrNickAlias for leagueId
  → rewrite nick on exact fromNick hit
  → apply roster

Staff configure aliases with `/ocr_nick_alias_config` (split from `/league_config` for Discord’s 8KB slash-command size limit).
  → assertConfigStaff → CRUD service → Prisma
```

Gemini parse stays league-agnostic. Alias application is a separate step once `leagueId` is known (`/register_lobby` league path, screenshot refresh). Event screenshot path does not pass a league id.

## Data model

```prisma
model LeagueOcrNickAlias {
  leagueId  String
  fromNick  String
  toNick    String
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  league League @relation(fields: [leagueId], references: [id], onDelete: Cascade)

  @@id([leagueId, fromNick])
  @@index([leagueId])
}
```

- Persist both sides after `normalizeNick`
- Reject empty or identity (`fromNick === toNick`) on set
- Upsert on set (same `fromNick` updates `toNick`)

## Commands

Split from `/league_config` so that command stays under Discord’s 8000-byte payload limit (same pattern as `/decay_config`).

- `/ocr_nick_alias_config set` — `from`, `to`
- `/ocr_nick_alias_config clear` — `from` (one entry)
- `/ocr_nick_alias_config clear_all` — all entries for the league
- `/ocr_nick_alias_config list` — list aliases for the league
- `/config view` — also lists aliases (compact lines)

English ephemeral replies. Auth: existing `assertConfigStaff`.

## Error handling

- Invalid / empty nick after normalize → `MatchServiceError` with English message
- Missing `from` on clear → soft “no mapping found” (same style as wc3stats slot clear)
- OCR failure / empty extract unchanged (aliases never run on empty roster)

## Testing

Unit tests for apply (hit / miss / preserve other fields), set validation (normalize, identity reject), and format helpers. Command handlers stay thin.

## Out of scope (reminders)

Fuzzy match; non-OCR ingest; Player FK; Event aliases.
