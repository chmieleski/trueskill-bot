# WOS match-file-only report — Design

**Date:** 2026-08-28  
**Status:** Approved (rev 2 — lobby fill + winner suggestion, no auto-complete)  
**Scope:** `game:warcraft3_wos` (parser, roster mapping, winner inference) + `general` (use-case shell, `/register_lobby`, lobby button, report wizard winner step)

## Goal

Let WOS hosts fill a **PENDING** lobby from the WOS2 bot `.txt` export — no manual roster add for captain draft. Primary entry: `/register_lobby report:<attachment>`. Secondary: **Report from file** button on PENDING WOS lobbies (modal paste).

The host still clicks **Start**, then uses the normal **Report Winner** wizard. When the report was supplied at register time, the **winner step** shows a suggestion and a one-click **Continue with {team}** button (override still available).

## Non-goals

- Auto-start or auto-complete from file upload
- One-shot confirm screen (`wos-report-confirm` flow)
- UDBR screenshot / OCR changes
- Message-drop file upload in lobby channels
- Hero binding on `MatchPlayer.heroId`

## Locked decisions

| Topic            | Choice                                                                       |
| ---------------- | ---------------------------------------------------------------------------- |
| Primary entry    | `/register_lobby` + `report` attachment                                      |
| Secondary entry  | PENDING lobby button → modal paste                                           |
| Match lifecycle  | **PENDING** after file → host **Start** → IN_PROGRESS → Report Winner wizard |
| Winner UX        | Suggest + **Continue with {team}** on winner step; both team buttons remain  |
| Stats            | Persist at register (PENDING); stats step skipped when report already stored |
| Winner inference | Rounds → win flags → inconclusive (no preselect)                             |
| Roster slots     | Report `pid` → bot slot via `WOS_WC3STATS_SLOT_MAP`                          |
| Partial lobbies  | Allowed if both teams have ≥1 player                                         |
| Shared use-case  | `fillLobbyFromWos2Report()` — slash + button                                 |
| Game gate        | `profile.postMatchStats === 'wos2_bot_v1'`                                   |
| Start required   | Always — never report from PENDING                                           |

## User flows

### Flow A — `/register_lobby report:<file>`

1. Host runs command with `.txt` attachment.
2. Bot parses report → builds roster → `createPendingMatch` (or `replaceMatchRoster` on existing PENDING via button).
3. Bot persists `MatchStatsReport` + `MatchPlayerStats` while **PENDING**.
4. Lobby embed shows filled roster; **Start** enabled when both teams occupied.
5. Host clicks **Start** → IN_PROGRESS.
6. **Report Winner** → griefer → quitter → **winner step with suggestion** → stats/confirm (stats already present) → complete.

### Flow B — PENDING lobby button

1. Host opens empty `/register_lobby` lobby.
2. **Report from file** → modal paste → same as Flow A steps 2–6.

### Winner step (when report at register)

- Text: `Report suggests **{teamName}** won ({rounds}).`
- Primary: **Continue with {teamName}** → proceeds like picking that team
- Secondary: existing **Team 1 Won** / **Team 2 Won** buttons for override
- If inconclusive: no Continue button; both team buttons only

## Architecture

```
/register_lobby report ──┐
lobby button → modal ────┼──► fillLobbyFromWos2Report()
                         │         ├─ parseWos2BotReport()
                         │         ├─ lobbyPlayersFromWos2Report()
                         │         ├─ createPendingMatch | replaceMatchRoster
                         │         └─ persistWos2MatchStats() on PENDING
                         │
Report Winner wizard ────┴──► showReportWinnerStep() reads suggested winner
                              from stored report / inferSuggestedWinner()
```

## Modules

| Module                                       | Scope                                                            |
| -------------------------------------------- | ---------------------------------------------------------------- |
| `wos2-bot-report-roster.ts`                  | `game:warcraft3_wos`                                             |
| `wos2-bot-report-winner.ts`                  | `game:warcraft3_wos`                                             |
| `match-from-wos-report.ts`                   | `fillLobbyFromWos2Report()`                                      |
| `match-stats-upload.ts`                      | `persistWos2MatchStats()`; allow PENDING when roster from report |
| `register-lobby.ts` + source                 | `report` attachment                                              |
| `lobby-preview.ts` + `lobby-interactions.ts` | Button + modal                                                   |
| `match-interactions.ts`                      | Winner step suggestion + Continue button                         |

## Command surface

| Option   | Notes                                |
| -------- | ------------------------------------ |
| `report` | WOS only; `.txt` / `.log` / `text/*` |
| `print`  | UDBR only; rejected on WOS           |

Mutual exclusion: cannot attach both `print` and `report`.

## Error handling

| Case                                      | Behavior                                              |
| ----------------------------------------- | ----------------------------------------------------- |
| Parse / roster error                      | No match created (slash) or no roster change (button) |
| Unknown `pid`                             | Error before write                                    |
| Modal > 4 000 chars                       | Direct to slash attachment                            |
| Duplicate `externalId` on completed match | Warning in winner step text                           |
