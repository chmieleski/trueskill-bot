# Habitual quitter flag — Design

**Date:** 2026-08-22  
**Status:** Approved  
**Scope:** `general` (league-scoped roster display; keyed by `leagueId`)  
**Related:** [`2026-08-16-quitter-leaderboard-design.md`](./2026-08-16-quitter-leaderboard-design.md), `/rank` W/L/Q in `rank-reset-display.ts`, `.cursor/rules/openskill-rating.mdc`

## Goal

Players should see who has a high quit rate **on the match roster**, without looking each nick up with `/rank`. Flag anyone whose league quit rate is **50% or more**.

## Non-goals

- Changing OpenSkill `rate()`, quitter synthetics, or griefer penalties
- `/rank`, overall/hero boards, match history, or `/leaderboard quitters`
- Denormalized `quitCount` / `completedCount` columns
- Guild-wide stats (quitter leaderboard stays guild-wide; this flag does not)
- A games floor above 0
- Configurable threshold
- Progress copy or showing the numeric rate on the line

## Locked decisions

| Topic           | Choice                                                                                  |
| --------------- | --------------------------------------------------------------------------------------- |
| Approach        | Derive the flag from display stats already loaded for Calibrating                       |
| Surfaces        | PENDING lobby, IN_PROGRESS, and completed **match roster lines** (ki preview formatter) |
| Tenancy         | **This league only** — same W/L/Q as `/rank`                                            |
| Rank reset      | Same cutoff as `/rank` (counts restart after latest `PlayerRankReset`)                  |
| Threshold       | `quits / games ≥ 0.5` (inclusive). No minimum games                                     |
| Cancelled-only  | `games = 0` and `quits ≥ 1` → flag                                                      |
| Marker          | ⚠️ outside the code span                                                                |
| This-match quit | 🚪 unchanged                                                                            |
| Griefer         | 🐛 unchanged (still omitted when they quit this match)                                  |
| Marker order    | ⚠️ then 🚪 then 🐛                                                                      |
| Legend          | Footer suffix ` · ⚠️ quit 50%+` only when at least one line is flagged                  |
| Unlinked nick   | No flag                                                                                 |
| Language        | English user-facing strings                                                             |

## Rule

```text
isHabitualQuitter(quits, games) =
  quits ≥ 1 AND (games = 0 OR quits / games ≥ 0.5)
```

`games` and `quits` are `PlayerMatchDisplayStats` for that `(leagueId, playerId)`:

- **games** — completed WIN/LOSS in the league since the latest rank reset (lifetime if never reset)
- **quits** — `MatchPlayer.isQuitter` on COMPLETED or CANCELLED matches in that same window

Same source as `/rank` (`loadMatchDisplayStatsByPlayer`). Do not use the guild quitter-leaderboard aggregate.

Examples: 0/0 no; 1/0 yes; 1/1 yes; 1/2 yes; 1/3 no; 2/5 no; 3/5 yes; 0/10 no.

## Display

`formatTeamLinesFromPreview` only (the ki roster). Nick-only fallback lines (`**1.** goku`) have no stats and stay unflagged.

```text
` 1  goku      Calibrating` ⚠️
` 2  vegeta         3300 / 4400`
` 7  piccolo        2100 / 1800` ⚠️ 🚪
```

- ⚠️ is **outside** the monospace span, same as 🚪 / 🐛
- Calibrating copy is unchanged; ⚠️ may sit next to it
- This match’s quit is **not** in display stats until the match is COMPLETED or CANCELLED, so IN_PROGRESS 🚪 is independent of ⚠️

Footer (plain text, no markdown), when any preview line has the flag:

```text
Per player: slot  nick  global / hero (ki) · ⚠️ quit 50%+
```

Hero-hidden variant uses the existing hide-hero footer, plus the same suffix. Clean lobbies keep today’s footer.

## Architecture

```text
rank-reset-display.ts
  isHabitualQuitter(quits, games)

LobbyRatingPlayerLine.habitualQuitter?: boolean

loadLobbyRatingPreview
buildCompletedRatingPreview
  → already load displayStats for Calibrating
  → set habitualQuitter from stats.quits + stats.games

lobby-preview.formatTeamLinesFromPreview
  → append ⚠️
lobby-preview footer
  → legend if any habitualQuitter
```

Completed / flip paths today pass only a `games` map into `buildCompletedRatingPreview`. Pass **quits** (or the stats map) the same way so a quit on the match just finished can newly cross 50% on that embed (after-match counts, same timing as Calibrating reveal).

No Prisma migration. Do not persist the flag; recompute whenever the preview is built.

Commands and buttons stay thin.

## Edge cases

| Case                                    | Rule                                                                  |
| --------------------------------------- | --------------------------------------------------------------------- |
| 1 quit in 1 completed game              | Flag (100%)                                                           |
| 1 quit in 2 completed games             | Flag (50%)                                                            |
| Cancelled quits, 0 completed games      | Flag                                                                  |
| Quits > games (cancelled + completed)   | Use `quits / games`; can exceed 100% and still flag                   |
| Rank reset                              | Flag can drop when post-reset `quits`/`games` no longer meet the rule |
| Unlinked / no `playerId`                | No flag                                                               |
| This-match quitter, historically clean  | 🚪 only until complete; then stats include this quit                  |
| Habitual + this-match quit              | `⚠️ 🚪`                                                               |
| Habitual + griefer, not this-match quit | `⚠️ 🐛`                                                               |
| Rating preview failed / omitted         | Nick-only fallback: no flag                                           |

## Testing (acceptance)

- Unit: `isHabitualQuitter` — 0/0, 1/0, 1/1, 1/2, 1/3, 2/5, 3/5, 0/10
- Unit: formatter — ⚠️ outside the span; `⚠️ 🚪`; `⚠️ 🐛`; no ⚠️ when false; Calibrating + ⚠️
- Unit: footer legend only when at least one flagged line
- Unit: preview builders set `habitualQuitter` from display stats, including after a just-completed quit
- Regression: 🚪 / 🐛 / Calibrating / signed deltas / column padding unchanged

## Open follow-ups (not v1)

- `/rank` ⚠️ or rate on the profile
- Match history roster
- Configurable threshold or games floor
- Denormalized counters
