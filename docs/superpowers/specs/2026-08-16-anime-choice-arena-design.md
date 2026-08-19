# Anime Choice Arena IHL (slot ≠ hero) — Design

**Date:** 2026-08-16  
**Status:** Approved — implementation plan written  
**Plan:** [docs/superpowers/plans/2026-08-16-anime-choice-arena.md](../plans/2026-08-16-anime-choice-arena.md)  
**Scope:** `general` (game profile, nullable `heroId`, team-based roster split, global-only OpenSkill when no hero) + `game:warcraft3_anime_choice_arena` (catalog seed, `/league create` choice, Discord-only lobby)  
**Depends on:** Multi-league IHL live (`Game` / `League` / `leagueId` on matches and ratings). Does **not** depend on unmerged `feature/game-scoped-heroes`.  
**Related:** [Adding a new game](../../dev/adding-a-new-game.md), [Multi-league IHL](./2026-08-15-multi-league-ihl-design.md), [Team display names](./2026-08-14-team-display-names-design.md)

## Goal

Run a second IHL on the same bot for **Anime Choice Arena** on Warcraft III **1.26**:

- Lobby slots assign **team and position only**. Heroes are picked **in-game** and are **not** recorded in v1.
- No wc3stats (old War3; map is not on that tracker).
- Ranked matches use **league-global OpenSkill only**.
- The same **game profile** seam is the base for a third game later (hero pick UX is phase 2, not this slice).

UDBR behavior stays as it is today (12 slots, `heroId = slot`, dual-entity rating, wc3stats).

## Non-goals (this slice)

- Screenshot / OCR for 1.26 lobbies (phase 2)
- wc3stats import, slot maps, or host-lobby poller for this game
- Catalog of Anime Choice Arena characters
- Recording in-game hero picks on `MatchPlayer`
- Dual-entity OpenSkill (global + hero) for this game
- Full `src/games/<id>/` adapter framework
- Changing OpenSkill math or the ordinal/`displayOrdinal` formula (only the **display word** for that number is per-game)
- Changing match status machine or `leagueId` isolation
- New production env / SSM keys
- Migrating the global `Hero` table (1–12) or `PlayerHeroRating` FKs
- Landing or depending on `feature/game-scoped-heroes`
- Per-guild or runtime overrides of flavor (v1 = code profile only; edit the preset to change)

## Locked decisions

| Topic                                | Choice                                                                                                                                                                  |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Approach                             | **Game profile in code** keyed by `gameId` (not `if (ACA)` scattered, not a full game-module framework)                                                                 |
| `gameId`                             | `warcraft3_anime_choice_arena` (stable; never rename without a migration plan)                                                                                          |
| Display name                         | `Anime Choice Arena`                                                                                                                                                    |
| War3 / import                        | 1.26 custom map; `import: none`                                                                                                                                         |
| Roster                               | 10 slots, 5 per team (1–5 team 1, 6–10 team 2)                                                                                                                          |
| Unbalanced fills                     | Allowed if both teams have ≥1 human (same rule as UDBR)                                                                                                                 |
| Lobby fill v1                        | Discord only (`/register_lobby` empty, `/lobby add`, claim/swap)                                                                                                        |
| Screenshot / wc3stats on this league | **Refuse** with English copy (not ignore)                                                                                                                               |
| Rating v1                            | League-global `PlayerRating` only                                                                                                                                       |
| Hero v1                              | `MatchPlayer.heroId = null`; do not create/update `PlayerHeroRating`                                                                                                    |
| Hero phase 2                         | `GameHero` catalog per `gameId` + persist pick; do **not** reuse UDBR `Hero` ids 1–12                                                                                   |
| Profile storage v1                   | TypeScript module; **no** new `Game` / `League` columns for slot count, hero mode, or flavor                                                                            |
| Team split                           | Persist `MatchPlayer.team`; rating/lobby split uses **`team`**, not hardcoded `slot <= 6`                                                                               |
| Display flavor (runtime)             | On `GameProfile`: `ratingLabel` + `teamNames`. UDBR = `ki` / Z Fighters / Evil; ACA v1 = `ki` / Team A / Team B. Mutable later by editing the game’s profile entry only |
| Slash command metadata               | **Global** — slot `min`/`max` stay 1–12; winner choice **labels** stay Z Fighters / Evil. Validate slot against the resolved league’s profile at execute time           |
| Create / mod roles                   | Stay guild-wide (`GuildConfig`)                                                                                                                                         |
| Isolation                            | Unchanged: ratings and matches keyed by `leagueId`                                                                                                                      |

### Rejected alternatives

- **ACA-only `if (gameId)` branches** — a third game would copy the same forks.
- **Full `src/games/<id>/` framework now** — too much for the first non-UDBR IHL; profile is the forced shared pattern.
- **`GameHero` table in this PR** — unused until picks exist (YAGNI). Nullable `heroId` + `heroBinding` is the v1 contract.
- **Require a `Hero` row per `MatchPlayer`** — blocks `optional_in_game`. Keep no required FK from `MatchPlayer` to `Hero` (current `main`).
- **Hardcode Dragon Ball flavor in core** — team names and the rating unit must live on `GameProfile` so a third map can swap copy without forking embeds.

## Architecture

```text
Game.id
  warcraft3_udbr
  warcraft3_anime_choice_arena

getGameProfile(gameId)     // general — code catalog
  slotCount
  teamAMaxSlot
  heroBinding: slot_bound | optional_in_game
  import: wc3stats | none
  ratingLabel              // user-facing unit, e.g. "ki"
  teamNames: { 1, 2 }

League.gameId → profile
  Match / MatchPlayer (heroId nullable)
  PlayerRating          // always
  PlayerHeroRating      // UDBR only in v1
```

|                    | UDBR                            | ACA v1                             |
| ------------------ | ------------------------------- | ---------------------------------- |
| Slots              | 12 (6+6)                        | 10 (5+5)                           |
| `heroBinding`      | `slot_bound` (`heroId = slot`)  | `optional_in_game` (`heroId` null) |
| `import`           | `wc3stats`                      | `none`                             |
| `ratingLabel`      | `ki`                            | `ki`                               |
| Runtime team names | Z Fighters / Evil               | Team A / Team B                    |
| Fill               | screenshot / wc3stats / Discord | Discord only                       |

Flavor (`ratingLabel`, `teamNames`) is **per game/map preset**, not hardcoded Dragon Ball copy in core. Both games ship with `ki` today; ACA uses neutral Team A / Team B. Changing either later is an edit to that profile row in code — no Prisma migration.

Happy path: `/league create` → `/league bind` → `/register_lobby` (empty) → add/swap/claim → start → report → `/rank`.

A third game is another `Game` row + profile entry. It does not fork tenancy or the OpenSkill apply **shell**.

### Profile API (normative)

Place a single module (e.g. `src/domain/game-profile.ts`) consumed by match, lobby, rating, and commands. Suggested shape:

```ts
export type HeroBinding = 'slot_bound' | 'optional_in_game';
export type GameImportKind = 'none' | 'wc3stats';

export type GameProfile = {
  gameId: string;
  displayName: string;
  slotCount: number;
  teamAMaxSlot: number;
  heroBinding: HeroBinding;
  import: GameImportKind;
  /** User-facing rating unit (e.g. "ki"). Math unchanged; label is per game. */
  ratingLabel: string;
  teamNames: { 1: string; 2: string };
};

export function getGameProfile(gameId: string): GameProfile;
export function teamForSlot(profile: GameProfile, slot: number): 1 | 2;
```

- `teamForSlot`: slot `1..teamAMaxSlot` → team 1; `teamAMaxSlot+1..slotCount` → team 2; otherwise invalid.
- Unknown `gameId` is a programmer error (throw); do not silently fall back to UDBR.
- `WARCRAFT3_UDBR_GAME_ID` stays in `src/domain/games.ts`; add `WARCRAFT3_ANIME_CHOICE_ARENA_GAME_ID` and extend `KnownGameId`.

### Call-site rules

Core must read the profile of the **resolved league** (or the match’s `league.gameId`) instead of literals `12`, `6`, `heroId = slot`, Z Fighters / Evil, or the word `ki` **at runtime** (user-facing surfaces).

- Embeds, rank titles, lobby footers, and similar copy use `profile.ratingLabel` and `profile.teamNames`.
- Internal DTO / field names may keep `ki` / `globalKi` for stability; that does not authorize hardcoding `"ki"` in new user-visible strings when a profile is in scope.
- Global slash **registration** may still hardcode Z Fighters / Evil (Discord one-tree limit); runtime replies after resolve must use the profile.

UDBR-only modules (`src/services/wc3stats/**`, OCR prompt, host-lobby poller) run only when `profile.import === 'wc3stats'` (or equivalent league config already used today). They must not run for ACA leagues.

## Data model

### v1 schema

- Seed `Game` (`id = warcraft3_anime_choice_arena`, `displayName = Anime Choice Arena`).
- `MatchPlayer.heroId` becomes `Int?`.
  - UDBR: always set to `slot` (1–12).
  - ACA v1: always `null`.
- `MatchPlayer.slot` and `MatchPlayer.team` remain required. ACA slots are 1–10; `team` is 1 or 2 from the profile.
- `PlayerRating` unchanged (PK `leagueId` + `playerId`).
- `Hero` (global 1–12) and `PlayerHeroRating` (FK to `Hero`) **unchanged**. ACA v1 never writes `PlayerHeroRating`.
- `MatchRatingSnapshot`: ACA v1 writes **GLOBAL** rows only (`heroId` sentinel `0`, same as today). No `HERO` snapshot rows when `heroId` is null.
- No new env vars. No SSM / `refresh-env` changes.

### Phase 2 (specified, not this PR)

When this game (or the next) records in-game picks:

1. Add `GameHero` (`gameId`, `heroId`, `name`) — catalog **per game**, not UDBR slot ids.
2. Set `MatchPlayer.heroId` for that game.
3. Point `PlayerHeroRating` at that game’s heroes (separate migration). Dual-entity `rate()` applies only when `heroId` is present.

Until then, `heroBinding: optional_in_game` + nullable `heroId` is the contract the apply/preview path honors.

## Rating

The OpenSkill **shell** stays `applyMatchRatings(leagueId, entries, winningTeam)` / `applyQuitterPenalties` (`general`).

`RatingRosterEntry.heroId` becomes `number | null`.

| `heroId`        | Team array for `rate()`       | `PlayerHeroRating`                                                 | Quitter synthetic loss |
| --------------- | ----------------------------- | ------------------------------------------------------------------ | ---------------------- |
| number (UDBR)   | `[global, hero, …]` per human | ensure + update; increment `matchesPlayed` for active non-quitters | both entities          |
| `null` (ACA v1) | `[global, …]` per human       | **no** ensure, **no** update                                       | global only            |

- `ensurePlayerRatings` creates `PlayerRating` always; creates `PlayerHeroRating` only when `heroId` is non-null.
- `splitRosterByTeam` takes `team: 1 | 2` on each entry (not `slot <= 6`). Callers pass persisted `MatchPlayer.team`.
- Preview, win %, and balance hint for ACA use **global rating only** (label from `profile.ratingLabel`, default preset `ki`). No hero line, no “move to destination hero”.
- `/rank` omits the hero block when `heroBinding === 'optional_in_game'` (ACA), and also when the player has no `PlayerHeroRating` rows with games. Do not invent placeholder heroes. Titles/lines that show the number use `profile.ratingLabel`.
- `/leaderboard` hero subcommand (or hero option) on an `optional_in_game` league with no catalog: refuse — _Hero rankings are not available for this game._

Correction (`/match flip` / `void`) stays `general`. Restore GLOBAL snapshots; skip HERO restore when none were written.

## Lobby and match flow

1. Staff `/league create game:warcraft3_anime_choice_arena name:…` → bind channel.
2. Create-role host `/register_lobby` with **no** screenshot and **no** wc3stats id → `PENDING`, empty roster. Skip `assertHeroCatalogReady` when `heroBinding !== slot_bound`.
3. Host fills slots 1–10 via existing Discord actions. `heroId` stays null; `team` from profile.
4. Start requires both teams ≥1 occupied slot (same as UDBR).
5. Complete / cancel / quitters / correction: same status machine; rating path as above.

If the host attaches a screenshot or a wc3stats lobby id while the resolved league has `import: none` and OCR is not enabled for this game: **reject**, do not create a match from that input.

Existing empty-lobby path (`/register_lobby` with zero options) is the ACA v1 path. UDBR empty lobby + screenshot + wc3stats stay available on UDBR leagues.

## Discord UX

All user-facing strings stay **English**.

**Staff:** `/league create` adds choice `{ name: 'Anime Choice Arena', value: 'warcraft3_anime_choice_arena' }`. Bind/unbind unchanged.

**Runtime (match-scoped):** embeds, lobby buttons/selects, start/report copy use `profile.slotCount`, `profile.teamNames`, and `profile.ratingLabel`. ACA lobby shows 10 slot controls, Team A / Team B, global `ki` only (same label as UDBR until a future preset change).

**ACA add / move (buttons):** Host does not pick a raw slot.

- **Add:** ephemeral **team dropdown** (only teams with an empty seat), then a nick-only modal. Bot seats the player in the **lowest empty slot** on that team.
- **Move:** after picking a player, destinations are **Move → Team A/B** (lowest empty seat on that team; omit the player’s current team and full teams) and **Swap → &lt;nick&gt;** for each other occupied seat.
- UDBR keeps slot-number add and per-slot move/swap destinations.
- Slash `/lobby add|swap` still uses slot integers (global command tree); execute-time validation stays profile-aware.

**Global slash metadata (Discord limitation):** one command tree for all guilds. Do **not** change registered slot `minValue`/`maxValue` (stay 1–12) or winner choice **names** (stay Z Fighters / Evil, values `A` / `B`). Execute/autocomplete validate against the **resolved league** profile:

- ACA slot 11 or 12 → _Invalid slot. This game uses slots 1–10._
- UDBR slot 12 remains valid.

**Claim, start, report, correction, rank reset:** same commands; no hero UI for ACA.

## Error copy (English, locked)

| Situation                                | Message                                                                                        |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Screenshot on ACA / `import: none`       | `Lobby screenshots are not supported for this game yet.`                                       |
| wc3stats id on this league               | `Warcraft lobby import is not supported for this game.`                                        |
| `/config` wc3stats preset on this league | `This league's game does not use wc3stats import.`                                             |
| Slot outside profile range               | `Invalid slot. This game uses slots 1–10.` (range text from `profile.slotCount`)               |
| Hero leaderboard on this league          | `Hero rankings are not available for this game.`                                               |
| Both teams empty on start/complete       | Keep existing UDBR wording, but team **names** come from the profile (Team A / Team B on ACA). |

Host-lobby poller: skip leagues whose profile `import !== 'wc3stats'` (in addition to existing “not ready” checks).

## Testing

Required coverage:

- Profiles: UDBR 12 / `slot_bound` / `wc3stats` / `ratingLabel: ki` / Z Fighters–Evil; ACA 10 / `optional_in_game` / `none` / `ratingLabel: ki` / Team A–B.
- `teamForSlot` and persist `MatchPlayer.team` for both layouts.
- `splitRosterByTeam` uses `team` (UDBR 6v6 and ACA 5v5, including unbalanced).
- `applyMatchRatings` and quitters with `heroId` null: only `PlayerRating` rows change; zero `PlayerHeroRating` writes.
- `createPendingMatch` for ACA: empty roster, no `Hero` catalog requirement.
- Isolation: completing an ACA match does not mutate UDBR ratings for the same `Player`.
- Refuse screenshot, wc3stats id, and wc3stats preset on an ACA league.
- Slot 11 fails on ACA; slot 12 succeeds on UDBR.

## Docs

Update `docs/dev/adding-a-new-game.md` **Known games** with `warcraft3_anime_choice_arena` and point at the profile module. Note that slot-bound heroes are UDBR-specific; `optional_in_game` is the second pattern.

Do not put ACA map SHA-1 or 1.26 details in `.env`.

## Phase 2 (out of this PR)

1. Optional lobby screenshot OCR that reads **nicks and teams**, not heroes.
2. `GameHero` + persist pick (`MatchPlayer.heroId` set).
3. Dual-entity OpenSkill when `heroId` is present on that game.
4. Retheme ACA (or any game) by editing that profile’s `teamNames` / `ratingLabel` only — already supported; no extra feature work.
5. A third game = new `gameId` + `GameProfile` row in code + `Game` seed (including its own flavor preset).

## Edge cases

| Case                                  | Rule                                                            |
| ------------------------------------- | --------------------------------------------------------------- |
| Guild runs UDBR + ACA                 | Separate leagues, separate `leagueId`; same global `Player`     |
| ACA `/register_lobby` with screenshot | Refuse; no PENDING created from that invocation                 |
| ACA host uses `/lobby add slot:12`    | Refuse; roster unchanged                                        |
| Complete ACA 5v5                      | 10 global entities in `rate()` (5+5), not 20                    |
| Complete ACA 3v5                      | Allowed; entities = occupied humans only                        |
| Flip/void ACA                         | Restore GLOBAL snapshots only                                   |
| Missing `Hero` rows in DB             | Must not block ACA create; still required for UDBR `slot_bound` |
| Unknown `gameId` on a league row      | Throw in `getGameProfile`; do not treat as UDBR                 |
