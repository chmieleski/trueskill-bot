# Events (unrated matches) — Design

**Date:** 2026-08-25  
**Status:** Approved  
**Scope:** `general`  
**Plan:** [docs/superpowers/plans/2026-08-25-events-unrated-matches.md](../plans/2026-08-25-events-unrated-matches.md)

## Goal

- Introduce an **Event** container (tournaments and similar) scoped to **guild + game**, sibling to League.
- Record multiple matches under an Event via the **existing lobby lifecycle**.
- Event matches store roster and results only — **no OpenSkill / IHL rating side effects**.
- Bind Discord channels/categories to a **specific Event** so day-to-day lobbies resolve without picking a league.

## Non-goals (v1)

- Bracket / format engines, seeding, standings math
- Separate “manual log match” commands (lobby create → report covers it)
- wc3stats auto-import into Events
- Player-facing Event browser beyond staff commands + in-channel lobby UX
- Putting Events under a League

## Decisions (locked)

| Topic           | Choice                                                         |
| --------------- | -------------------------------------------------------------- |
| Container       | **A** — Event parent owns many matches                         |
| Tenancy         | **B** — Guild + Game (sibling to League)                       |
| v1 depth        | **A** — Event CRUD + record matches; no format logic           |
| Match ingest    | **A** — Reuse lobby flow; skip rating                          |
| Visibility      | **A** — Event-scoped only; not IHL profile / W/L / leaderboard |
| Channel binding | **A** — Snowflake binds to a **specific** Event                |
| Data approach   | Extend `Match` with `eventId`; XOR with `leagueId`             |

## Architecture

```text
Discord guild
  ├── League[]          (IHL — rated)
  │     └── LeagueChannelBinding
  └── Event[]           (guildId + gameId — unrated)
        ├── EventChannelBinding
        └── Match[] (eventId set, leagueId null)

Global
  ├── Player (game-scoped identity)
  ├── Game
  └── Hero
```

### Resolution order (lobby / match create)

1. If channel (or category) has an **Event** binding → that Event (must be `ACTIVE`)
2. Else existing **League** resolve (`resolveLeagueContext`)

A Discord snowflake must not be both league-bound and event-bound. Bind/unbind enforce mutual exclusion.

### Match lifecycle

Unchanged status machine: `PENDING` → `IN_PROGRESS` → `COMPLETED` | `CANCELLED`.

On complete/cancel for Event matches:

- Persist `MatchPlayer` results / quitter / griefer **flags** as needed for history
- **Do not** write `MatchRatingSnapshot`
- **Do not** call `applyMatchRatings`
- **Do not** apply IHL quit/griefer rating accrual (no `PlayerRating` / hero rating writes)
- Correction paths for Event matches: roster/result only

### Visibility

- Event match lists: filter by `eventId`
- Rank, leaderboard, profile W/L, soft-z game counts, decay qualifying activity: **league-scoped matches only** (`leagueId` present)

## Data model

```prisma
enum EventStatus {
  ACTIVE
  COMPLETED
  CANCELLED
}

enum EventBindingKind {
  CHANNEL
  CATEGORY
}

model Event {
  id        String      @id @default(cuid())
  guildId   String
  gameId    String
  name      String
  status    EventStatus @default(ACTIVE)
  createdAt DateTime    @default(now())
  updatedAt DateTime    @updatedAt

  game            Game                   @relation(...)
  channelBindings EventChannelBinding[]
  matches         Match[]

  @@index([guildId])
  @@index([gameId])
  @@index([guildId, gameId])
}

model EventChannelBinding {
  eventId   String
  discordId String
  kind      EventBindingKind

  event Event @relation(..., onDelete: Cascade)

  @@id([discordId])
  @@index([eventId])
}

// Match changes:
// - leagueId String?  (optional)
// - eventId  String?
// - invariant: exactly one of leagueId | eventId (DB check + app)
```

Existing `Match` rows keep `leagueId`; migration backfills nothing for events.

## Commands (v1)

| Command           | Behavior                                                |
| ----------------- | ------------------------------------------------------- |
| `/event create`   | `game:` + `name:` → Event `ACTIVE`                      |
| `/event list`     | List guild events (optional game filter)                |
| `/event bind`     | Channel/category → specific Event; fail if league-bound |
| `/event unbind`   | Remove Event binding                                    |
| `/event complete` | Event → `COMPLETED` (does not cancel open matches)      |
| `/event cancel`   | Event → `CANCELLED` (does not cancel open matches)      |

Permissions: staff bar aligned with `/league` configure/bind (`assertCanConfigureBot` or equivalent).

Lobby create in Event-bound channels: reuse existing create-role / host rules. Lobby embeds must label the Event name so the match is visibly not IHL.

Reject `/register_lobby` (and recreate) when the bound Event is not `ACTIVE`.

## Error handling

| Case                                 | Response                                       |
| ------------------------------------ | ---------------------------------------------- |
| Bind Event on league-bound snowflake | Clear error; no overwrite                      |
| Bind League on event-bound snowflake | Clear error; no overwrite                      |
| Lobby in non-`ACTIVE` Event channel  | Reject                                         |
| Complete Event with open matches     | Allowed; staff finish those matches separately |
| Event match complete                 | Results stored; ratings untouched              |

## Testing

- XOR invariant: create Match with both/neither tenant keys fails
- Complete Event match → no rating / snapshot writes
- Resolve prefers Event bind; mutual exclusion with league bind
- IHL surfaces unchanged when Event matches exist for the same players

## Follow-ups (explicitly later)

- Tournament formats / brackets
- Optional `event:` slash option when unbound
- wc3stats → Event import
- Player Event history views
