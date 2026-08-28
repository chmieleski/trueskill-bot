# WOS Hero Display Names — Design

**Date:** 2026-08-29  
**Status:** Approved (scope A)  
**Scope:** `game:warcraft3_wos` (catalog, report upsert) + `general` (display resolution, `/hero_config`, stats queries)

## Goal

Staff (server admin or match moderator) can set **shorter display names** for WOS report heroes (e.g. `Raiden Ei` → `Raiden`). Names appear consistently in `/hero`, `/items`, `/rank` hero list, match summaries, and autocomplete.

## Non-goals

- UDBR `Hero` table (lobby slots 1–12)
- Per-league aliases (names are game-global via `gameId`, same as `GameItem`)
- Rewriting `MatchStatsReport.rawText`
- Env / AWS changes

## Approach

Mirror `GameItem`:

1. **`GameHero`** table — `(gameId, objectId, name)`; `name` is the staff-editable display label.
2. **Report upload** — `upsertGameHeroesFromReport` inserts new heroes only; does **not** overwrite existing rows (preserves mod renames).
3. **Display resolution** — `resolveHeroDisplayName(gameId, objectId, fallback)` everywhere hero names are shown.
4. **Stats queries** — match rows by `heroObjectId` when known so renames do not split aggregates; fall back to case-insensitive `heroName` when `heroObjectId` is null.
5. **`/hero_config rename`** — `hero` (autocomplete) + `display_name`; auth = Manage Guild / bot owner **or** match mod role.

## Schema

```prisma
model GameHero {
  gameId    String
  objectId  Int
  name      String
  updatedAt DateTime @updatedAt

  game Game @relation(fields: [gameId], references: [id], onDelete: Cascade)

  @@id([gameId, objectId])
  @@index([gameId])
}
```

`Game` gains `heroes GameHero[]`.

## Rename behavior

| Case                 | Action                                                                       |
| -------------------- | ---------------------------------------------------------------------------- |
| `heroObjectId` known | Upsert `GameHero.name`                                                       |
| `heroObjectId` null  | Bulk-update `MatchPlayerStats.heroName` in the resolved league (legacy rows) |

## Auth

`assertCanRenameGameHero`: `assertCanConfigureBot` **or** `assertHasMatchModRole` (same pattern as completed-match log channel).

## Error messages (English)

| Case               | Message                                                  |
| ------------------ | -------------------------------------------------------- |
| Non-WOS league     | `Hero display names are only available for WOS leagues.` |
| Unknown hero       | `No hero found matching **{name}** in this league.`      |
| Empty display name | `Display name cannot be empty.`                          |
| No permission      | Existing config / mod role messages                      |
