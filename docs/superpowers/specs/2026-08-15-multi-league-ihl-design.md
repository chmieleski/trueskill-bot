# Multi-League IHL (multi-guild, multi-game-ready) — Design

**Date:** 2026-08-15  
**Status:** Approved — implementation plan written  
**Plan:** [docs/superpowers/plans/2026-08-15-multi-league-ihl.md](../plans/2026-08-15-multi-league-ihl.md)  
**Scope:** One Discord bot process serving many guilds; each guild may run **multiple IHLs (leagues)** in parallel (one per game instance); ratings and matches isolated per league; slash commands available in every guild the bot is in. WC3 UDBR is the only game wired end-to-end in this slice.  
**Depends on:** Finish in-flight [guild wc3stats config](./2026-08-15-guild-wc3stats-config-design.md) slice (tasks 7–8) on `GuildConfig`, then migrate those fields onto `League`.

## Goal

- Operators invite the bot to any Discord server and run an independent IHL without sharing Elo with other servers.
- A single guild can host **more than one** IHL at once (e.g. WC3 UDBR today; another game later), each with its own matches, ratings, leaderboard binding, and game-specific config.
- The same Discord user / battletag is one global `Player`; Elo is per league.
- Channel binding selects the league for day-to-day lobby/match flows; unbound commands resolve via a fixed fallback chain.
- Production slash commands are **global** (not a single `GUILD_ID`).
- Agents and humans always know whether work is **general** or **game-scoped** (Cursor rule + new-game guide).

## Non-goals (this slice)

- Implementing a second game end-to-end (only the extension guide + seams)
- Full game-domain generalization (pluggable OCR/import/hero systems for arbitrary games) — deferred “scope A”
- Fat map presets (heroes, team names as preset packages) — remains Part 2 of the wc3stats guild-config spec
- PostgreSQL schema-per-tenant or RLS as the primary isolation mechanism
- Per-league `Player` rows / separate Discord links per league
- Changing OpenSkill math itself

## Decisions (locked)

| Topic | Choice |
|-------|--------|
| Multi-game per guild | **B** — many IHLs in parallel per guild |
| Day-to-day IHL selection | **A** — channel (or category) bound to a league |
| Unbound command selection | **C** — binding → if exactly one league in guild use it → else require `league:` autocomplete |
| Player identity | **A** — global `Player`; Discord `discordId` stays uniquely linked; ratings/matches per league |
| First delivery depth | **C** — multi-league model + only WC3 UDBR wired; document how to add a game; Cursor scope rule |
| Tenancy storage | Shared Postgres schema + `leagueId` on IHL tables (hybrid: global identity, league-scoped competition) |
| Multi-schema / DB-per-guild | **Rejected** |
| RLS as primary isolation | **Rejected** (optional later only if untrusted clients hit the DB) |
| wc3stats in-flight work | Finish slice on `GuildConfig` (tasks 7–8), then **migrate** filter/slots onto `League` |
| Command registration | Production: global `applicationCommands`; dev: optional guild deploy via `GUILD_ID` |
| Create/mod roles (v1) | Stay on `GuildConfig` for this slice unless a follow-up moves them per-league; document as follow-up |

## Architecture

```text
Discord guild
  └── League[]  (guildId + gameId + displayName)
        ├── ChannelBinding (channelId | categoryId → leagueId)
        ├── Match / MatchPlayer
        ├── PlayerRating / PlayerHeroRating
        └── Game-specific config (WC3: wc3stats filter + slot maps)

Global
  ├── Player (username, optional discordId unique)
  ├── Game catalog (id: warcraft3_udbr, …)
  └── Hero (WC3 1–12 catalog for this slice only)

Interaction
  → resolveLeagueContext(guildId, channelId, optional leagueOption)
  → all rating / match / lobby / leaderboard reads-writes use leagueId
```

### Resolution order (`resolveLeagueContext`)

1. If `league:` option present and belongs to this guild → use it  
2. Else if channel (or its category) has a binding → that league  
3. Else if guild has exactly one league → that league  
4. Else → error / require autocomplete (no silent pick)

Lobby register, refresh, report, claim, and wc3stats import **must** run in a bound channel (or pass explicit league) so staff cannot accidentally write the wrong IHL.

### Data model (sketch)

```prisma
model Game {
  id          String   @id  // e.g. "warcraft3_udbr"
  displayName String
  leagues     League[]
}

model League {
  id        String   @id @default(cuid())
  guildId   String
  gameId    String
  name      String   // display name within the guild
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  // After migrate from GuildConfig (WC3-only columns OK for now):
  wc3statsEnabled    Boolean @default(false)
  wc3statsMapPattern String?
  wc3statsMapSha1    String?

  game              Game                   @relation(fields: [gameId], references: [id])
  channelBindings   LeagueChannelBinding[]
  wc3statsSlotMaps  LeagueWc3statsSlotMap[]
  matches           Match[]
  ratings           PlayerRating[]
  heroRatings       PlayerHeroRating[]

  @@unique([guildId, gameId, name])
  @@index([guildId])
  @@index([gameId])
}

model LeagueChannelBinding {
  leagueId  String
  discordId String   // channel or category snowflake
  kind      LeagueBindingKind // CHANNEL | CATEGORY

  league League @relation(fields: [leagueId], references: [id], onDelete: Cascade)

  @@id([discordId]) // one binding target → one league globally (snowflake unique)
  @@index([leagueId])
}

enum LeagueBindingKind {
  CHANNEL
  CATEGORY
}

model Match {
  // …existing fields…
  leagueId String
  league   League @relation(…)
  @@index([leagueId, status])
  // active wc3statsGameId uniqueness scoped per league, not process-wide
}

model PlayerRating {
  leagueId String
  playerId String
  mu       Float @default(25.0)
  sigma    Float @default(8.333)
  @@id([leagueId, playerId])
}

model PlayerHeroRating {
  leagueId String
  playerId String
  heroId   Int
  // …mu, sigma, matchesPlayed…
  @@id([leagueId, playerId, heroId])
}
```

`Player` and `Hero` stay global for this slice. A future game with a different roster gets its own catalog strategy (see [Adding a new game](#deliverable-adding-a-new-game)).

### What stays on `GuildConfig` (v1)

| Field | Reason |
|-------|--------|
| `matchCreateRoleId` / `matchModRoleId` | Still guild-wide staff roles unless/until per-league auth is requested |
| `leaderboardChannelId` / `leaderboardMessageId` | **Move to league** (each IHL has its own live board) |
| `lobbyPlayerClaimEnabled` | Prefer **per league** after migrate; acceptable interim: guild default |
| `wc3stats*` + slot maps | **Migrate off** to `League` |

### Command registration

| Environment | Behavior |
|-------------|----------|
| Production | `PUT Routes.applicationCommands(clientId)` once per deploy; `GUILD_ID` not required |
| Development | Optional `GUILD_ID` → guild-scoped PUT for instant updates; `AUTO_DEPLOY_COMMANDS` unchanged |
| Cutover | After global deploy, `PUT` empty guild command list on the former prod `GUILD_ID` to avoid duplicates |

Do **not** iterate all guilds on `ready` to register commands.

Runtime always uses `interaction.guildId` + resolved `leagueId` — never deploy `GUILD_ID` for business logic.

## Migration path

Prerequisite: merge/finish guild wc3stats config (env keys removed; columns on `GuildConfig`).

1. Add `Game`, `League`, `LeagueChannelBinding`; seed `warcraft3_udbr`.
2. For each distinct `guildId` that has `GuildConfig` and/or existing matches/ratings, create one default league (`name` e.g. `UDBR` / `Default`).
3. Add nullable `leagueId` on `Match`; backfill from that guild’s default league (legacy rows without recoverable guild → production snowflake used historically for the single-tenant era, documented in ops notes).
4. Rebuild `PlayerRating` / `PlayerHeroRating` PKs to include `leagueId`; backfill.
5. Copy `wc3stats*` + slot map rows from `GuildConfig` → league; drop guild columns / old slot table FK.
6. Move leaderboard channel/message ids onto the league (or bind leaderboard channel as a channel binding + store message id on league).
7. Scope active `wc3statsGameId` uniqueness to `(leagueId, wc3statsGameId)` among non-terminal matches.
8. Thread `leagueId` through rating, report, preview, leaderboard, rank, register, refresh, discord-sync.
9. Switch command deploy to global; make `GUILD_ID` optional in `env.ts` + AWS checklist.
10. Ship docs + Cursor rule (below).

New guilds: no league until staff runs setup / UDBR preset for a league (empty IHL; cold-start ratings on first match).

## Discord UX (v1)

| Action | Behavior |
|--------|----------|
| Create league | Staff (`Manage Guild` or bot owner); pick `game:` (`warcraft3_udbr` only for now) + name |
| Bind / unbind channel or category | Staff; one discord snowflake → one league |
| `/config` wc3stats preset / clear | Operate on **resolved league** (bound channel or `league:`) |
| `/rank`, leaderboard queries | `resolveLeagueContext` |
| Register lobby / report | Prefer bound channel; refuse if unresolved |

All user-facing strings remain **English**.

## Edge cases

| Case | Behavior |
|------|----------|
| Guild with zero leagues | IHL commands refuse with setup guidance |
| Unbound channel, multiple leagues | Require `league:` |
| Same Discord in two leagues | One `Player`; independent Elo rows |
| Same live wc3stats lobby id in two leagues | Allowed (uniqueness per league) |
| Category binding + channel binding | Channel binding wins (more specific) |
| DM / no guildId | Reject guild-scoped commands |
| Missing `where: { leagueId }` in a query | Treat as bug; tests must cover cross-league isolation |

## Testing

1. Resolve: binding / single league / multi without binding / explicit option  
2. Completing a match in league A does not change ratings or leaderboard of league B  
3. `/rank` in guild with two leagues does not silently use the wrong board  
4. Migration backfill: legacy single-tenant rows land on the intended default league  
5. Global command deploy works with `GUILD_ID` unset; guild deploy still works when set (dev)  
6. After wc3stats migrate, preset/clear/view read/write league columns only  

## Deliverable: Adding a new game

Ship `docs/dev/adding-a-new-game.md` (English) with a checklist covering:

1. Add `Game` row / constant id  
2. What must stay in **general** core (league resolve, ratings shell, match lifecycle, command deploy)  
3. What belongs in a **game module** (lobby shape, import source, slot/hero catalog, OCR copy, presets)  
4. How to register presets and wire `/config` without leaking game imports into unrelated services  
5. Test matrix (isolation + game-specific happy path)  
6. Explicit “do not” list (hardcoding WC3 assumptions into `resolveLeagueContext`, global Elo, process-wide feature flags for game filters)

## Deliverable: Cursor rule — feature scope

Ship `.cursor/rules/feature-scope-game-vs-general.mdc` with `alwaysApply: true`:

- Every feature/PR/plan must declare scope: `general` or `game:<gameId>` (e.g. `game:warcraft3_udbr`)
- General code must not import game-specific modules except via narrow adapters/presets
- Game-scoped work must not change cross-league isolation invariants
- When unclear, ask before coding

Update `CLAUDE.md` rule index to link it.

## Delivery sequence

1. **Finish** guild wc3stats config tasks 7–8 (`GuildConfig` + env/SSM cleanup).  
2. **Multi-league schema** + backfill + move wc3stats/leaderboard onto `League`.  
3. **Channel binding** + `resolveLeagueContext` + thread `leagueId` through services/commands.  
4. **Global slash command deploy** + optional `GUILD_ID`.  
5. **Docs** (`adding-a-new-game.md`) + **Cursor rule** + `CLAUDE.md` index.  

## Rejected alternatives

| Option | Why rejected |
|--------|----------------|
| Guild-only Elo (`guildId` without `League`) | Breaks multi-IHL-per-guild (decision B) |
| Schema-per-guild / DB-per-guild | Poor Prisma fit; ops cost; shared `Player` painful |
| RLS as primary isolation | Bot uses privileged Prisma connection; RLS does not replace `leagueId` in PKs |
| Per-league Player / Discord link | Contradicts locked identity model |
| Register commands on every guild at ready | Rate limits; unnecessary when definitions are identical — use global commands |
| Abort in-flight wc3stats GuildConfig work | Wasteful at task 7; migrate forward instead |

## Relationship to prior specs

| Spec | Relationship |
|------|----------------|
| `2026-08-15-guild-wc3stats-config-design.md` | Prerequisite slice; columns land on `GuildConfig` first, then move to `League` |
| `2026-08-14-guild-config-roles-design.md` | Roles remain guild-scoped for now; resolve key stays `interaction.guildId` |
| `2026-08-14-leaderboard-design.md` | Supersedes “ratings remain global” — live boards become **per league** |
| Part 2 fat presets (wc3stats design) | Still deferred; hero/team packs stay out of this slice |

## Follow-ups (explicit)

1. Per-league create/mod roles  
2. Second game implementation using `docs/dev/adding-a-new-game.md`  
3. Fat presets / non-WC3 hero catalogs  
4. Optional RLS defense-in-depth if a non-bot client is exposed to the same DB  
5. Optional `GuildPlayer` / membership table for “who played in this IHL”
