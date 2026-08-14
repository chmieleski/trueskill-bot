# Team Display Names — Design

**Date:** 2026-08-14  
**Status:** Approved  
**Scope:** User-facing Team A / Team B labels → themed names via a single helper

## Goal

Players see **Z Fighters** (team 1, slots 1–6) and **Evil** (team 2, slots 7–12) everywhere the bot currently says “Team A” / “Team B”. Internal IDs stay `1` / `2` and `teamA` / `teamB`.

## Non-goals

- Env vars, SSM, or `/config` for team names
- Per-map or per-guild names (future: only the helper’s lookup changes)
- Schema / DB changes
- Renaming slash option **values** (`A` / `B`) or custom IDs
- Rewriting developer comments / internal docs that are not user-facing

## Locked decisions

| Topic | Choice |
|-------|--------|
| Storage | Hardcoded constants in code |
| API | `teamDisplayName(team: 1 \| 2): string` in `src/services/team-names.ts` |
| Coverage | Every user-facing string (embeds, buttons, slash choice **labels**, errors, confirmations) |
| Team 1 | `Z Fighters` |
| Team 2 | `Evil` |
| Slot helper | Optional `teamDisplayNameForSlot(slot)` (slot ≤ 6 → team 1) |

## Architecture

```text
teamDisplayName(1 | 2)
  → lobby-preview embeds / win % field names / winner description
  → match-interactions buttons & winner copy (replace local teamLabel)
  → lobby-interactions slot messages
  → match slash winner choice labels (name only)
  → lobby-ocr user-facing validation error
```

Later map/guild config replaces the constant map inside this module only.

## Call sites

| Surface | File(s) | Example after |
|---------|---------|---------------|
| Roster / win % embeds | `lobby-preview.ts` | `🟥 Z Fighters (4)`, `🟥 Z Fighters win` |
| Completed match | `lobby-preview.ts` | `Z Fighters won the match.` |
| Report UI | `match-interactions.ts` | `Z Fighters Won`, `Winner: **Z Fighters**` |
| Lobby slot messages | `lobby-interactions.ts` | Uses display name instead of Team A/B |
| Slash choices | `commands/match/match.ts` | `{ name: 'Z Fighters', value: 'A' }` |
| OCR error | `lobby-ocr.ts` | `Both Z Fighters and Evil need at least one human player.` |

## Testing & ops

- Unit test `teamDisplayName` (and slot helper if added)
- Update assertions that expect `"Team A"` / `"Team B"` (e.g. `lobby-preview.test.ts`)
- Redeploy slash commands so Discord shows updated choice labels (`AUTO_DEPLOY_COMMANDS` in dev; production deploy path)

## Rejected alternatives

- Inline find-and-replace of literals — no single seam for future map/guild names
- Env / guild config now — deferred; hardcoded is enough for current map branding
