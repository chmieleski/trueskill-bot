# Lobby Rating Preview (OpenSkill) — Design

**Date:** 2026-08-13  
**Status:** Approved for implementation planning  
**Scope:** Read-only OpenSkill win-chance + per-player ordinals on Match Lobby / Match In Progress embeds

## Goal

On the **Match Lobby** embed (and **Match In Progress** when the same team fields are shown), show a rating preview for the current roster:

1. **Per-player public ordinals** on each roster line: global and hero (`μ − 3σ`), labeled so players know what the numbers mean
2. **Win chance** for Team A and Team B (percentages that sum to 100%)

This is a **read-only prediction**. Do **not** call OpenSkill `rate()` or update ratings from match outcomes in this feature.

## Non-goals

- Match completion / result reporting
- Quitter penalties
- Leaderboard commands
- Displaying a single team-level public ordinal on the embed
- Classic Elo / Glicko / equal point splits

## Domain rules

Ratings use **OpenSkill** (Weng–Lin). Persist μ/σ in `PlayerRating` and `PlayerHeroRating` (defaults: μ `25.0`, σ `8.333` ≈ `25/3`).

### Dual entity graph (per human participant)

Each filled human slot contributes **two** rating entities to that team’s array:

1. **Global** — `PlayerRating`
2. **Hero** — `PlayerHeroRating` for that slot’s hero (`heroId = slot`, 1–12)

```text
Team array = [Player1, Hero1, Player2, Hero2, ...]
```

Empty slots are **absent** entities (not zero-μ fillers). Unbalanced lobbies are valid if both teams have ≥1 player.

### Public ordinal

```text
Public ordinal = μ − 3σ
```

Never show raw μ on public embeds.

### Win probability

Use the `openskill` package’s `predictWin([teamA, teamB])` on the dual-entity arrays. Do not invent a separate Elo formula for P(win).

Team aggregate strength `(Σμ) − 3√(Σσ²)` is the domain definition of team public rating but is **not displayed** in this feature (reserved if needed later).

## Decisions (locked)

| Topic | Choice |
|-------|--------|
| Win chance math | `openskill` + `predictWin` |
| Cold start | Upsert missing `PlayerRating` / `PlayerHeroRating` on preview load |
| Embed layout | Dedicated **Rating preview** field (win % only) |
| Per-player display | Both ordinals: `global / hero` |
| Legend | Footnote under Rating preview: `Per player: global / hero (ordinal)` |
| Architecture | Dedicated `rating-preview` service; thin Discord adapters |

## Architecture

```text
syncLobbyDiscordMessage / register_lobby
  → loadLobbyRatingPreview(matchPlayers)
      → ensure Hero 1–12 exist (FK)
      → upsert missing PlayerRating + PlayerHeroRating
      → build dual-entity teams
      → predictWin → round percents to sum 100
      → return LobbyRatingPreview DTO
  → buildMatchLobbyEmbed / buildMatchInProgressEmbed(dto)
```

### New module

`src/services/rating-preview.ts` (name may include a tiny `ordinal.ts` helper if preferred):

- `ordinal(mu, sigma): number` — `μ − 3σ`, rounded for display
- `ensureRatingEntitiesForRoster(...)` — cold-start upserts
- `loadLobbyRatingPreview(entries): Promise<LobbyRatingPreview>`

Rating math stays out of commands/buttons; they only call shared sync / preview loaders.

### Dependency

Add npm package `openskill`.

### Hero FK prerequisite

`PlayerHeroRating.heroId` references `Hero`. There is currently **no seed** for heroes. Preview load must **ensure** rows for ids `1..12` exist before hero rating upserts (placeholder names e.g. `Hero {id}` if real map names are not yet defined). Do not block lobby on missing hero names.

## Data contracts

### Input

Prefer roster entries from `MatchWithPlayers` (have `playerId`, `slot`, `heroId`, username), not nick-only OCR `LobbyPlayer[]`.

### DTO

```ts
export interface LobbyRatingPlayerLine {
  slot: number;
  nick: string;
  globalOrdinal: number;
  heroOrdinal: number;
}

export interface LobbyRatingPreview {
  players: LobbyRatingPlayerLine[];
  /** Present only when both teams have ≥1 human. */
  winChance?: {
    teamAPercent: number;
    teamBPercent: number;
  };
}
```

## Embed UI

### Roster lines

```text
[Slot N] - nick · {globalOrdinal} / {heroOrdinal}
```

### Rating preview field

Shown only when `winChance` is present:

- **Name:** `Rating preview`
- **Value:**
  ```text
  Team A · {teamAPercent}% · Team B · {teamBPercent}%
  Per player: global / hero (ordinal)
  ```

Same structure on Match Lobby and Match In Progress.

### Call sites

1. [`src/services/lobby-actions.ts`](../../../src/services/lobby-actions.ts) — `syncLobbyDiscordMessage` loads preview and passes it into embed builders
2. [`src/commands/lobby/register-lobby.ts`](../../../src/commands/lobby/register-lobby.ts) — after `createPendingMatch`, build embed from persisted match + preview (not OCR-only nicks)
3. [`src/services/lobby-preview.ts`](../../../src/services/lobby-preview.ts) — accept optional/required preview DTO; format lines + field

## Edge cases

| Case | Behavior |
|------|----------|
| One or both teams empty | Ordinals when ratings load; **omit** Rating preview field |
| Missing ratings | Upsert defaults (μ 25 / σ 8.333) |
| Unbalanced fill | Dual-entity arrays as-is |
| DB / `predictWin` failure | Log; fall back to nick-only lines, no preview field; do not fail lobby message sync |
| Percent rounding | Integers with `teamAPercent + teamBPercent === 100` |

## Testing

The repo has no test runner yet. Add a minimal **Vitest** setup (devDependency + `npm test` script) for unit tests only:

- Ordinal helper (`μ − 3σ`)
- Dual-entity team array ordering / shape
- Win % rounding to sum 100
- Preview omitted when a team is empty

No Discord integration tests for this feature.

## Spec self-review

- No TBD/TODO placeholders
- Win % via `predictWin`; team aggregate ordinal defined but not shown (matches UI decisions)
- Cold-start upserts + Hero 1–12 ensure called out (FK gap in current DB)
- Scope limited to read-only lobby/in-progress preview

## Out of scope (explicit)

- Calling `rate()` after matches
- Quitter static penalties
- Leaderboards
- Showing team aggregate ordinal on the embed
