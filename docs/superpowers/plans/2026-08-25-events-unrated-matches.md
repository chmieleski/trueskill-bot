# Events (unrated matches) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add guild+game Event containers that own unrated Matches via the existing lobby flow, with channel bindings to a specific Event and hard isolation from IHL ratings and stats.

**Architecture:** Extend `Match` with optional `eventId` and nullable `leagueId` (XOR). New `Event` + `EventChannelBinding`. Lobby resolve checks Event bind first; `completeMatch` / cancel / correction skip all rating when `eventId` is set. IHL surfaces already keyed by `leagueId` stay correct; audit any COMPLETED queries that omit `leagueId`.

**Tech Stack:** Prisma + PostgreSQL, discord.js v14 slash commands, Vitest, TypeScript ESM.

## Global Constraints

- Scope: `general` (not game-specific)
- English-only user-facing strings
- Conventional Commits
- No rating writes for Event matches
- Channel snowflake: at most one of league bind or event bind
- Completing/cancelling an Event does not auto-cancel open matches
- Reject lobby create when Event is not `ACTIVE`

---

## File map

| Path                                     | Responsibility                               |
| ---------------------------------------- | -------------------------------------------- |
| `prisma/schema.prisma` + migration       | `Event`, `EventChannelBinding`, Match XOR    |
| `src/services/event/*`                   | CRUD, bind/unbind, resolve                   |
| `src/services/league/league-binding.ts`  | Reject bind if event-bound                   |
| `src/services/match/match-service.ts`    | `createPendingMatch` accepts event or league |
| `src/services/match/match-report.ts`     | Skip rating for events                       |
| `src/services/match/match-correction.ts` | Skip re-rate for events                      |
| `src/commands/lobby/register-lobby.ts`   | Event resolve path                           |
| `src/commands/event/event.ts`            | Slash command                                |
| `src/services/lobby/lobby-preview.ts`    | Event label on embeds                        |
| IHL query sites                          | Ensure `leagueId` not null / present         |

---

### Task 1: Schema — Event + Match XOR

**Files:**

- Modify: `prisma/schema.prisma`
- Create: migration via `npx prisma migrate dev`

**Steps:**

- [ ] Add enums `EventStatus`, `EventBindingKind`
- [ ] Add `Event` model (`guildId`, `gameId`, `name`, `status`, relations to `Game`, bindings, matches)
- [ ] Add `EventChannelBinding` (`discordId` PK, `eventId`, `kind`) mirroring `LeagueChannelBinding`
- [ ] On `Game`: add `events Event[]`
- [ ] On `Match`: `leagueId String?`, add `eventId String?`, relations; indexes on `eventId`
- [ ] Add raw SQL check in migration: `(("leagueId" IS NOT NULL AND "eventId" IS NULL) OR ("leagueId" IS NULL AND "eventId" IS NOT NULL))`
- [ ] `npx prisma migrate dev --name events_unrated_matches` and `npx prisma generate`
- [ ] Commit: `feat(db): add Event and unrated match tenancy`

---

### Task 2: Event service — CRUD, bind, resolve

**Files:**

- Create: `src/services/event/event.ts`, `event-binding.ts`, `event-resolve.ts`, `index.ts`
- Create: `src/services/event/event-resolve.test.ts`, `event-binding.test.ts`
- Modify: `src/services/league/league-binding.ts` — before upsert, if `eventChannelBinding` exists for `discordId`, throw clear error
- Modify: event bind — reject if league binding exists

**Produces:**

- `createEvent({ guildId, gameId, name })`
- `listEventsForGuild(guildId, gameId?)`
- `getEventById(id)`
- `setEventStatus(id, status)`
- `bindDiscordToEvent({ eventId, discordId, kind })`
- `unbindEventDiscord(discordId)`
- `resolveEventContext({ guildId, channelId, categoryId })` → `{ ok: true, event } | { ok: false }`
- `EVENT_NOT_ACTIVE_MESSAGE`, bind conflict messages

**Resolve order for lobby (Task 4):** Event channel → Event category → else league resolve.

- [ ] TDD bind mutual exclusion + resolve channel/category
- [ ] Commit: `feat(event): add event CRUD bind and resolve`

---

### Task 3: Match create + complete/cancel skip rating

**Files:**

- Modify: `src/services/match/match-service.ts` — `CreatePendingMatchInput`: either `leagueId` or `eventId` (not both)
- Modify: `src/services/match/match-report.ts` — early branch when `match.eventId`: write results/status only; skip snapshots, `applyQuitterPenalties`, `accrueGrieferPenalties`, `applyMatchRatings` (may still set `isQuitter`/`isGriefer` flags on players if callers pass them)
- Modify: `src/services/match/match-correction.ts` — if `eventId`, flip/void without rating restore/apply
- Tests: `match-report.test.ts` (or new `match-report-event.test.ts`) — complete event match does not call rating mocks

- [ ] Implement + tests
- [ ] Commit: `feat(match): support event tenancy without ratings`

---

### Task 4: Lobby register + embeds + recreate

**Files:**

- Modify: `src/commands/lobby/register-lobby.ts` — try `resolveEventContext` first; if Event, assert `ACTIVE`, skip `assertLeagueLobbyCreateChannel` / use Event-appropriate channel rules (reuse create-role only), `createPendingMatch({ eventId, ... })`
- Modify: `src/services/lobby/recreate-lobby-from-match.ts` — preserve `eventId` when recreating
- Modify: `src/services/lobby/create-from-wc3stats.ts` — leave league-only for v1 (no Event wc3stats import) OR skip if channel is event-bound
- Modify: `src/services/lobby/lobby-preview.ts` — accept optional `eventName`; author/footer `Event: {name}` when set
- Modify: `discord-sync` / callers to pass event name when match has `eventId`

- [ ] Commit: `feat(lobby): register and label event matches`

---

### Task 5: `/event` slash command

**Files:**

- Create: `src/commands/event/event.ts`
- Mirror `/league` bind target channel types and `assertCanConfigureBot` at execute top
- Subcommands: `create`, `list`, `bind`, `unbind`, `complete`, `cancel`
- Autoload via existing `load-commands` scan

- [ ] Commit: `feat(event): add /event staff commands`

---

### Task 6: IHL query audit

**Files to verify (filter `leagueId` / exclude null):**

- `src/services/rating/rank-reset-display.ts`
- `src/services/match/match-history.ts`
- `src/services/match/match-list.ts`
- `src/services/player/teammate-stats.ts`
- `src/services/leaderboard/quitter-leaderboard.ts`
- `src/services/leaderboard/griefer-leaderboard.ts`
- `src/services/rating/rating-decay.ts`
- Any `match.findMany` with only `status: COMPLETED`

Rule: every IHL aggregate must include `leagueId: <id>` or `leagueId: { not: null }` if scanning broadly.

- [ ] Fix any gaps; add a regression test that an Event COMPLETED match does not increment display W/L for a league
- [ ] Commit: `fix(match): keep IHL stats exclusive of event matches`

---

### Task 7: Format + typecheck

- [ ] `npm run format` && `npm run typecheck` && targeted vitest
- [ ] Commit any format fixes if needed

---

## Spec coverage

| Spec requirement                     | Task |
| ------------------------------------ | ---- |
| Event guild+game                     | 1–2  |
| EventChannelBinding → specific Event | 2, 5 |
| Mutual exclusion with league bind    | 2    |
| Match XOR                            | 1, 3 |
| Lobby reuse, skip rating             | 3–4  |
| Event-only visibility                | 6    |
| `/event` commands                    | 5    |
| Embed Event label                    | 4    |
| Reject non-ACTIVE lobby              | 4    |
| Complete Event ≠ cancel matches      | 2, 5 |
