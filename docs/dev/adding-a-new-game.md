# Adding a new game (IHL)

**Audience:** engineers / agents implementing a second (or Nth) game on this Discord bot.  
**Related design:** `docs/superpowers/specs/2026-08-15-multi-league-ihl-design.md`  
**Scope label:** work for a new game is always `game:<gameId>` — see `.cursor/rules/feature-scope-game-vs-general.mdc`.

This guide assumes the **multi-league** model is live: `Game`, `League`, channel bindings, ratings/matches keyed by `leagueId`, and global slash commands (optional dev `GUILD_ID` for guild-scoped deploy only).

## What you are adding

A **game** is a catalog entry (`Game.id`) plus adapters that know how that game’s lobbies, rosters, and imports work. A **league** is one IHL instance of that game inside one Discord guild.

You do **not** invent a new tenancy model. You plug into `League`.

## Core APIs (general — do not fork)

Import league tenancy from `src/services/league/index.js` (barrel). Key exports:

| Area | Functions / types |
|------|-------------------|
| **Resolve** | `resolveLeagueContext`, `resolveLeagueFromInteraction`, `resolveLeagueIdFromInteraction`, `LeagueResolveInput`, `LeagueResolveResult` |
| **Interaction helpers** | `getLeagueOption`, `getInteractionCategoryId`, `withOptionalLeagueOption`, `withSubcommandLeagueOption`, `autocompleteGuildLeagues`, `respondLeagueAutocomplete`, `leagueResolveFailureMessage`, `LEAGUE_RESOLVE_*` constants |
| **CRUD** | `createLeague`, `listLeaguesForGuild`, `getLeagueById`, `getDefaultUdbrLeagueId` (legacy UDBR-only helper — prefer resolve) |
| **Bindings** | `bindDiscordToLeague`, `unbindDiscord`, `LeagueBindingKind` (`CHANNEL` \| `CATEGORY`) |
| **Staff slash** | `/league create`, `/league list`, `/league bind`, `/league unbind` — `src/commands/league/league.ts` |
| **Game id constant** | `WARCRAFT3_UDBR_GAME_ID`, `WARCRAFT3_ANIME_CHOICE_ARENA_GAME_ID`, `KnownGameId` — `src/domain/games.ts` |

**Resolution order** (same everywhere): explicit `league:` option → channel binding → category binding → sole league in guild → else ambiguous / no leagues.

Commands that need a league should call `resolveLeagueFromInteraction` (or `resolveLeagueContext` with explicit inputs) and surface `leagueResolveFailureMessage` on failure.

## WC3 UDBR reference (`game:warcraft3_udbr`)

UDBR preset/import lives on **League**, not `GuildConfig`. Import from `src/services/league/index.js`:

| Function | Purpose |
|----------|---------|
| `resolveLeagueConfig` | Read wc3stats, leaderboard, claim flags from a league row |
| `isLeagueWc3statsImportReady` | True when import enabled + map pattern set |
| `applyUdbrWc3statsPreset` | Copy UDBR map filter + slot map onto a league |
| `clearLeagueWc3statsPackage` | Disable import and clear slot maps |
| `setLeagueLeaderboardChannel` / `clearLeagueLeaderboardChannel` | Live board message ids on league |
| `setLeagueLobbyPlayerClaimEnabled` | Per-league claim toggle |

Slot map persistence: `src/services/wc3stats/wc3stats-slot-map.js` (`loadLeagueWc3statsHeroSlotMap`, `replaceLeagueWc3statsSlotMaps`, etc.) — table `LeagueWc3statsSlotMap`, PK `(leagueId, wc3statsSlot)`.

Staff apply preset via `/config set wc3stats_map_preset` (resolves league first). Module may later move under `src/games/warcraft3_udbr/`; core still calls through the league barrel or a thin game registry.

## Checklist

### 1. Register the game

- [ ] Choose a stable `gameId` string (e.g. `valorant_custom`, `warcraft3_udbr`). Never rename after ship without a migration plan.
- [ ] Add a `Game` row (seed/migration) with `displayName`.
- [ ] Add `export const YOUR_GAME_ID = '…' as const` in `src/domain/games.ts` (extend `KnownGameId` union).
- [ ] Document the id in **Known games** below.

### 2. Keep core `general`

Do **not** change these for game-specific behavior except via narrow hooks:

- `resolveLeagueContext` / `resolveLeagueFromInteraction` (binding → single league → autocomplete)
- Match status machine (`PENDING` / `IN_PROGRESS` / `COMPLETED` / `CANCELLED`)
- OpenSkill apply **shell** (`applyMatchRatings(leagueId, …)`, `ensurePlayerRatings(leagueId, …)`); game only supplies roster and results
- Global `Player` identity + Discord link (`username` / `discordId` stay globally unique)
- Slash command **registration** (`registerCommands` — global unless dev `GUILD_ID` is set)

### 3. Create a game module

Suggested layout (adjust to repo conventions):

```text
src/games/<gameId>/
  constants.ts          # preset payloads, map filters, display defaults
  lobby.ts              # roster shape, slot rules, team split
  import.ts             # optional external lobby import (if any)
  preset.ts             # apply/clear preset onto a League
  index.ts              # public adapter surface only
```

- [ ] Export a small adapter interface used by commands/services (apply preset, validate lobby, map import → slots).
- [ ] Core services import **only** `src/games/<gameId>/index.ts` (or a registry), never deep game files from unrelated domains.

### 4. League config columns / tables

- [ ] Prefer **nullable columns or side tables on `League`** (or `League*` children) over process env for per-IHL settings.
- [ ] Do **not** add process-wide env flags that turn a game on for every guild (no `WC3STATS_ENABLED`-style globals).
- [ ] Preset command should **copy** versioned constants into the league row (so deploys do not silently rewrite live IHLs), unless product explicitly wants “live follow code defaults.”

### 5. Heroes / roster catalog

WC3 UDBR uses a global `Hero` table (slots 1–12). That is **not** universal.

- [ ] If the new game’s roster differs, add a game-scoped catalog (or league-scoped) — do not overload WC3 hero ids.
- [ ] `PlayerHeroRating` PK is `(leagueId, playerId, heroId)` — hero ratings stay isolated per league.
- [ ] Update rating preview / leaderboard queries for that game’s hero dimension only inside the game module or clearly branched adapters.

### 6. Commands & UX

- [ ] Staff create a league: `/league create game:<id> name:<display name>`.
- [ ] Staff bind lobby channels: `/league bind target:#channel league:<name>` (category bind uses a category target).
- [ ] Channel/category bind resolution is general — no game-specific logic in `league-resolve.ts`.
- [ ] `/config` (or game-specific staff commands) apply presets to the **resolved league** (`resolveLeagueFromInteraction` + optional `league:` option).
- [ ] User commands (`/register_lobby`, `/rank`, `/leaderboard`) resolve league from interaction channel or `league:` option.
- [ ] User-facing copy is English.
- [ ] Label the plan/PR scope `game:<gameId>`.

### 7. Isolation tests (required)

- [ ] Match complete in league A does not mutate ratings in league B (even same `Player` / Discord).
- [ ] Leaderboard/rank for league A never lists league B ki.
- [ ] External lobby id uniqueness is per `leagueId` (e.g. `findActiveMatchByWc3statsGameId(leagueId, gameId)`).
- [ ] Happy path: `/league create` → `/league bind` → `/register_lobby` → report → `/rank`.

### 8. Docs & rules

- [ ] Add the game to **Known games** below.
- [ ] If you introduce new always-on conventions, update `.cursor/rules/feature-scope-game-vs-general.mdc` only when the rule is truly cross-cutting.
- [ ] Do not claim the feature is `general` if it would break a guild that also runs WC3.

## Do not

- Put map SHA-1 / game filters in `.env` as the source of truth for all guilds.
- Assume 12 slots, DBZ hero names, or wc3stats in `resolveLeagueContext` or rating core.
- Use schema-per-game or RLS as a substitute for `leagueId` on IHL tables.
- Create a second `Player` row per game for the same Discord user (identity stays global).
- Read `env.guildId` in business logic (deploy-only).

## Known games

| `gameId` | Status | Module (current) |
|----------|--------|------------------|
| `warcraft3_udbr` | First game | `src/services/league/league-wc3stats.ts` + `src/services/wc3stats/**` |
| `warcraft3_anime_choice_arena` | Second game (v1: Discord-only, global rating, no in-game pick) | `src/domain/game-profile.ts` |

## When to invest in “full” generalization

Shipping with WC3-only adapters and a league tenant (design scope **C**) is intentional. The shared pattern is `GameProfile` in `src/domain/game-profile.ts` (`slotCount`, `heroBinding`, `import`). Full `src/games/<id>/` adapters still wait. `optional_in_game` is the second hero pattern; do not reuse UDBR `Hero` ids 1–12. Prefer duplicating a thin adapter once over abstracting too early — but **never** duplicate tenancy or Elo isolation.
