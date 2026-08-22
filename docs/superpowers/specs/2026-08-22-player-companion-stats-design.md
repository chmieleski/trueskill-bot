# Player Companion Stats (`/rank` teammates + `/match list` side WR) — Design

**Date:** 2026-08-22  
**Status:** Approved for implementation planning  
**Scope:** `general` (league-scoped completed-match stats; team labels from `GameProfile.teamNames`)  
**Related:** [`2026-08-14-player-rank-link-design.md`](./2026-08-14-player-rank-link-design.md), [`2026-08-19-win-rate-display-design.md`](./2026-08-19-win-rate-display-design.md), [`2026-08-19-match-list-design.md`](./2026-08-19-match-list-design.md)

## Goal

Anyone viewing a `/rank` profile can see that player’s **top 3 teammates**: most games together, most wins together, and most losses together (games + WR% on each row). Anyone browsing `/match list` can see **which side is winning** in this league — season total and last 20 completed matches — on every page.

## Non-goals (v1)

- Opponent (“played against”) lists
- Ranking win/lose lists by WR% instead of raw W/L counts
- Discord mentions of teammates (would ping on every `/rank`)
- Denormalized pair or side-WR tables
- Schema, env, or SSM changes
- New slash commands or button custom IDs
- Changing `/match history`, ki math, or overall `/rank` W/L/Q
- A games floor (a 1-game duo can be top 3)
- Configurable last-N window (fixed 20)

## Locked decisions

| Topic              | Choice                                                                                          |
| ------------------ | ----------------------------------------------------------------------------------------------- |
| Approach           | On-read aggregates from `MatchPlayer` / `Match`. No schema                                      |
| Teammate lists     | Same-team only. Three fields: Played with / Win with / Lose with                                |
| Played with sort   | `games` desc → `WR%` desc → nick A–Z. Max 3                                                     |
| Win with sort      | `wins` desc → same tie-breaks. Max 3                                                            |
| Lose with sort     | `losses` desc → same tie-breaks. Max 3                                                          |
| What counts        | `COMPLETED` matches where the **viewed player** has `WIN` or `LOSS`                             |
| Rank reset         | Teammate lists use that player’s latest `PlayerRankReset` cutoff (same as `/rank` W/L)          |
| Quit (viewed)      | Match ignored for all three lists                                                               |
| Quit (partner)     | Partner still counts if the viewed player has WIN/LOSS                                          |
| Empty fields       | Omit a `/rank` field with 0 partners. Show 1–2 if that is all                                   |
| Row copy           | Same columns on all three lists: `Nick  14G · 9W 5L · 64.3%`                                    |
| Mentions           | Nicks only                                                                                      |
| Side WR surface    | `/match list` description, **every page** (slash + Prev/Next)                                   |
| Side WR window     | Season = all `COMPLETED` in the resolved league. Last N = newest 20 in list order               |
| Side WR rank reset | **Does not apply** (league-wide, not per-player)                                                |
| Side WR labels     | `teamDisplayName` / `GameProfile.teamNames` (UDBR: Z Fighters / Evil; ACA: Team A / Team B)     |
| Side WR 0 matches  | No side line (keep `_No completed matches yet._`)                                               |
| Last N < 20        | Label `Last N` (not “Last 20”)                                                                  |
| Computation        | On-read. `/rank` loads only the viewed player’s matches. Side WR is a dedicated winner query    |
| Language           | English user-facing strings                                                                     |

## Approach

Do not scan the full-league `loadMatchDisplayStats` map to build pairs. `/rank` loads completed WIN/LOSS rows for **one** `playerId` (after that player’s rank-reset cutoff), then same-team partners on those matches. `/match list` keeps the existing 10-row page query and adds a small season/last-N winner aggregate inside `loadMatchListPage` so slash and pagination share one path.

## Formula

Reuse `winRatePercent(wins, losses)` from `rank-reset-display.ts`:

```text
games = wins + losses
games === 0 → null
else → Math.round((wins / games) * 1000) / 10
```

Stringify like existing profile WR: `` `${n}%` `` (no forced trailing `.0`).

### Teammate pair (viewed player P, partner Q)

Eligible match: `Match.status = COMPLETED`, `P.result ∈ {WIN, LOSS}`, same `leagueId`, after P’s latest rank reset (`isMatchCountedAfterRankReset`).

Partner: every other `MatchPlayer` on **P’s team** in that match (including if Q is a quitter).

```text
games  = eligible matches P and Q shared a team
wins   = those where P.result === WIN
losses = those where P.result === LOSS
WR%    = winRatePercent(wins, losses)
```

`games === wins + losses` for every pair. Exclude P from their own lists.

### Side WR

Winner of a completed match: existing `winningTeamFromPlayers`. Skip a match with **no** `result === WIN` on either team (do not dump it onto team 2).

```text
order           = completedAt DESC (nulls last), then createdAt DESC
                  (same as /match list)
season window   = every COMPLETED match in the league
last-N window   = the newest min(20, totalCompleted) matches in that order
                  (same rows the list would show first — not “walk until 20 WINs”)
team wins       = among matches in the window that have at least one WIN
side WR         = winRatePercent(thatSideWins, otherSideWins)
Last N label    = N = matches in the window (20, or totalCompleted if smaller)
                  even if a corrupt row was skipped in the W–L count
```

“Season” is the resolved league. Archived leagues stay on `/match list` with `league:` — they are not mixed into the live league.

## Architecture

```text
/rank
  → loadPlayerProfile (unchanged)
  → loadTeammateStats(leagueId, playerId)
  → buildRankEmbed(profile, { teammates, … })

/match list  (slash + ml:p: buttons)
  → loadMatchListPage            // page rows + side WR
  → buildMatchListEmbed          // description includes side line
```

```text
MatchPlayer (COMPLETED, viewed player WIN/LOSS, rank-reset cutoff)
  → same-team partners → three top-3 lists

Match (COMPLETED, leagueId) + MatchPlayer.team/result
  → season + last-N side wins → description line
```

Commands and button handlers stay thin. No Prisma migration.

## DTOs

```typescript
type TeammatePairStats = {
  playerId: string;
  username: string;
  games: number;
  wins: number;
  losses: number;
  winRatePercent: number | null;
};

type TeammateStats = {
  playedWith: TeammatePairStats[]; // 0–3
  winWith: TeammatePairStats[];
  loseWith: TeammatePairStats[];
};

type LeagueSideWindow = {
  team1Wins: number;
  team2Wins: number;
  /** Matches in this window (season total, or min(20, totalCompleted)). */
  windowSize: number;
};

type LeagueSideWinRate = {
  season: LeagueSideWindow;
  lastN: LeagueSideWindow; // lastN.windowSize is the N in “Last N”
};

function pickTopTeammates(
  pairs: TeammatePairStats[],
  primary: 'games' | 'wins' | 'losses',
  limit?: number, // default 3
): TeammatePairStats[];

function formatTeammateTable(pairs: TeammatePairStats[]): string;

function formatLeagueSideWinRateLine(
  stats: LeagueSideWinRate,
  teamLabelFor: (team: 1 | 2) => string,
): string | null; // null when season.windowSize === 0
```

Tie-break for `pickTopTeammates`: primary desc, then `winRatePercent` desc (`null` sorts last), then `username` localeCompare (A–Z). Never more than 3.

A nick may appear on more than one list.

## Embeds

Gold accent `0xf0b232`. Existing `/rank` title, record, Heroes, thumbnail, and footer unchanged.

### `/rank` teammate fields

After Heroes (when shown). Field names: `Played with`, `Win with`, `Lose with`. Omit a field when its array is empty.

```text
Played with
Ghost     14G · 9W 5L · 64.3%
Krillin   11G · 6W 5L · 54.5%
Piccolo    8G · 5W 3L · 62.5%
```

- Monospace fence like `formatHeroTable`. In **that** field, pad nicks to the longest name and pad the `NG` token (`14G`) to the longest games cell so columns line up.
- Then ` · {wins}W {losses}L` and ` · {wr}%` when `winRatePercent !== null`.
- Omit `%` only when `winRatePercent === null` (should not happen for a listed pair).

### `/match list` description

Insert the side line **above** the existing page line:

```text
Z Fighters 34–25 (57.6%) · Last 20: Evil 11–9 (55%)
Page 1 of 4 · 39 matches
```

Each window shows the **leader**: `{name} {wins}–{otherWins} ({wr}%)`.

| Window | Copy |
| ------ | ---- |
| Team 1 leads | `Z Fighters 34–25 (57.6%)` |
| Team 2 leads | `Evil 11–9 (55%)` |
| Tie | `Tied 10–10 (50%)` (W–L is team1–team2) |
| Last N, N = 20 | prefix `Last 20: ` |
| Last N, N < 20 | prefix `Last N: ` (e.g. `Last 12: `) |
| `season.windowSize === 0` | omit the whole side line |

Use an en dash in W–L (`34–25`). `teamLabelFor` is the existing `teamDisplayName(team, profile)` callback. List rows, pagination, and empty-state field are unchanged.

## Modules

| Path | Responsibility |
| ---- | -------------- |
| `src/services/player/teammate-stats.ts` | Load pairs, `pickTopTeammates`, `formatTeammateTable` |
| `src/services/player/teammate-stats.test.ts` | Aggregation, sort/ties, table |
| `src/services/player/rank-embed.ts` | 0–3 fields after Heroes |
| `src/services/player/rank-embed.test.ts` | Field presence/order; Heroes unchanged |
| `src/services/player/index.ts` | Re-export load + types |
| `src/commands/player/rank.ts` | `loadTeammateStats` after profile; pass into embed |
| `src/services/match/side-win-rate.ts` | Season + last-N aggregate + description line |
| `src/services/match/side-win-rate.test.ts` | Leader/tie/`Last N`; skip no-WIN |
| `src/services/match/match-list.ts` | Load side WR on the page DTO; prepend description |
| `src/services/match/match-list.test.ts` | Description; empty league has no side line |
| `src/services/match/index.ts` | Re-export if tests/adapters need the formatter |
| `docs/discord/public/06-rank-and-boards.md` | One English line: `/rank` shows top teammates |
| `docs/discord/public/07-cheat-sheet.md` | `/match list` mentions side WR |

`src/discord/interactions/match-list-interactions.ts` stays a thin `loadMatchListPage` + `buildMatchListEmbed` adapter — no second query there.

Reuse `loadLatestRankResetAtByPlayer(leagueId, [playerId])` and `isMatchCountedAfterRankReset`. Reuse `winningTeamFromPlayers` and `winRatePercent`. Do not import player-history query or full-league display-stats into the new modules.

## Edge cases

| Case | Result |
| ---- | ------ |
| Solo on a team | That match adds no partners |
| Partner quit, viewed player WIN/LOSS | Partner still counts |
| Viewed player quit | Match ignored |
| Rank reset | Teammate lists restart; side WR unchanged |
| Other / archived league | Ignored (always resolved `leagueId`) |
| Four-way tie for 3rd | WR% then nick A–Z; still 3 rows |
| Same nick on two lists | Allowed |
| Side WR 50–50 | `Tied 10–10 (50%)` |
| 1–19 completed | `Last N:` with that N |
| 0 completed | No side line |
| ACA | `Team A` / `Team B` |
| Corrupt match (no WIN) | Skip for side WR |
| Calibrating `/rank` | Teammate fields still show (same as hero WR) |
| Unlinked nick | Teammate nicks still shown; no mentions |

No new user-facing error strings. `/rank` and `/match list` keep today’s failures.

## Testing (acceptance)

Unit tests only (no Discord, no Prisma round-trip required for the new helpers). Mock Prisma on loaders the same way `match-list.test.ts` does.

- `pickTopTeammates` — games/wins/losses primary; WR% tie-break; nick A–Z; cap 3; `null` WR last
- Pair aggregation — rank-reset cutoff; viewed-player quit ignored; partner quit included; same-team only; exclude self
- `formatTeammateTable` — `14G · 9W 5L · 64.3%`; omit `%` when null; nick padding
- `buildRankEmbed` — omits empty fields; order Heroes → Played → Win → Lose; existing title/record/Heroes unchanged
- Side WR — leader copy; tie; `Last 12` vs `Last 20`; skip no-WIN; 0 matches → `null` line
- `buildMatchListEmbed` — side line above page line; empty list has no side line; rows/buttons unchanged

## Out of scope follow-ups

- Rank win/lose lists by WR% with a min-games floor
- Played-against (opponents) lists
- Denormalize pair stats if `/rank` on-read becomes slow
- Side WR on other surfaces (`/leaderboard`, lobby)
- Per-player Z vs Evil on `/rank`
