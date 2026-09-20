# Hero champion roles — Design

**Date:** 2026-09-20  
**Status:** Approved for implementation  
**Scope:** `general` framework (schema, sync, `/league_config`); first enablement `game:warcraft3_udbr`

## Goal

Automatically assign Discord roles to the **#1 hero-ki** player for each mapped character in a league. Staff create the roles and map them; the bot adds/removes membership when ratings change. Built so other games can opt in later without a rewrite.

## Non-goals (v1)

- Bot-created or auto-renamed Discord roles
- Periodic cron-only sync (event-driven only)
- Stricter min hero-games beyond public leaderboard rules
- Auto-copy mappings on league rollover
- Player-facing `/champion` command
- Multiple holders per role on ties

## Decisions (locked)

| Topic             | Choice                                                                             |
| ----------------- | ---------------------------------------------------------------------------------- |
| Ranking           | Public **hero ki** (`displayOrdinal` on `PlayerHeroRating`)                        |
| Eligibility       | Discord-linked, not calibrating (overall games &lt; 5), `matchesPlayed &gt; 0`     |
| Ties              | **Sticky incumbent** — keep current holder until someone strictly exceeds their ki |
| Role provisioning | Staff create roles; map via `/league_config`                                       |
| Sync trigger      | After rating side-effects (same moments as live overall board refresh)             |
| Tenancy           | League-scoped mappings + enable flag                                               |
| Game gate         | Explicit `GameProfile.heroChampionRoles` (`true` for UDBR in v1)                   |

## Data model

```prisma
model League {
  // …
  heroChampionRolesEnabled Boolean @default(false)
  heroChampionRoles        LeagueHeroChampionRole[]
}

model LeagueHeroChampionRole {
  leagueId        String
  heroId          Int
  discordRoleId   String
  holderDiscordId String?
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  league League @relation(fields: [leagueId], references: [id], onDelete: Cascade)
  hero   Hero   @relation(fields: [heroId], references: [id], onDelete: Cascade)

  @@id([leagueId, heroId])
  @@unique([leagueId, discordRoleId])
  @@index([leagueId])
}
```

## Architecture

```text
Rating change (complete / correction / rank reset / …)
  → notifyLeagueRatingChanged(client, leagueId)
       → syncHeroChampionRoles (always attempted; best-effort)
       → refreshLeagueLeaderboard (may no-op if no live board)

/league_config set|clear hero champion …
  → upsert/delete mapping or toggle enabled
  → syncHeroChampionRoles
```

`notifyLeagueRatingChanged` exists because `refreshLeagueLeaderboard` early-returns when no live board channel is bound; champion sync must still run.

### Sync algorithm (per mapped hero)

1. No-op if league disabled, game profile `heroChampionRoles === false`, or no mappings
2. Load eligible candidates (linked Discord, not calibrating, hero `matchesPlayed > 0`), sort by ki desc
3. Pick champion with sticky incumbent on equal ki
4. Discord: remove role from previous holder if different; add to new holder
5. Persist `holderDiscordId` (null when no eligible champion)

Discord failures log a warning and do not fail match completion.

## Staff commands

| Action                                              | Behavior                                           |
| --------------------------------------------------- | -------------------------------------------------- |
| `/league_config set hero_champion_roles enabled:`   | Toggle; refuse unsupported games                   |
| `/league_config set hero_champion_role hero: role:` | Upsert mapping; unique role per league; sync after |
| `/league_config clear hero_champion_role hero:`     | Delete mapping; strip role from holder if possible |
| `/league_config view` (or equivalent show)          | Include enabled flag, mappings, holders            |

## Edge cases

| Case                                  | Behavior                                                                            |
| ------------------------------------- | ----------------------------------------------------------------------------------- |
| Player leaves guild / unlinks Discord | Clear holder; try remove role; next sync awards next eligible                       |
| Role deleted in Discord               | Warn; keep mapping until staff remaps/clears                                        |
| Rank reset / correction               | Same `notifyLeagueRatingChanged` path                                               |
| League rollover                       | Mappings stay on archived league; successor starts disabled/unmapped (no auto-copy) |
| Missing Manage Roles / hierarchy      | Warn log; no match failure                                                          |

## Future games

Set `heroChampionRoles: true` on the game profile and reuse the same table, sync, and commands. Hero catalog ids must exist for that game’s mapped `heroId`s.

## Docs

- Staff: `docs/discord/staff/a10-hero-champion-roles.md` (+ cross-link from `a1-roles-and-setup.md`)
