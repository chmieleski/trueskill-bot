# Battle.net lobby ingest (join-on-demand) — Design

**Date:** 2026-08-19  
**Status:** Approved (Approach 1 — join-on-demand)  
**Scope:** `game:warcraft3_udbr` (watcher, UDBR slot map, map filter). Job queue + roster apply are `general` but keyed by `leagueId`.  
**Plans:**

- Bot ingest: `docs/superpowers/plans/2026-08-19-bnet-lobby-ingest.md`
- Windows watcher: `docs/superpowers/plans/2026-08-19-bnet-lobby-watcher.md`

**Do not implement until asked.** Specs and plans only.

**ClickUp:** [869ekn2yt](https://app.clickup.com/t/869ekn2yt) — *Battle.net lobby ingest (join-on-demand watcher)* (`in design`)

## Goal

A dedicated Warcraft III: Reforged client (Battle.net account) **joins a UDBR lobby as referee**, reads hero seats 1–12, and the Discord bot **creates or refreshes** a PENDING match from that snapshot. Hosts discover lobbies via **channel cards** and a typed **`lobby_id`**. wc3stats is not used on this path.

## Non-goals

- Calling wc3stats HTTP/WebSocket on this path (existing wc3stats code may remain until a later rip-out)
- Occupying hero slots 1–12
- Staying in a lobby after the snapshot (join-on-demand: join → read → leave)
- Two Reforged clients / parallel joins
- Host-PC local WebSocket companion
- ACA / `import: none` leagues
- Replacing screenshot OCR (fallback stays)
- TLS/ALB in v1 (token + optional CIDR on the ingest port)

## Locked decisions

| Topic | Choice |
|-------|--------|
| Watcher | Always-on **Windows + Reforged**, one Battle.net account |
| Join mode | **On demand** only; one `running` job globally |
| Seat | Referee/observer only (UDBR colors 13–16). Never hero 1–12 |
| Discord | Create from id **and** Refresh with the same id **and** discovery cards |
| Lobby id | Watcher-minted **positive integer**, stable while the game stays on the list, dropped when it leaves |
| Match bind | New `Match.bnetLobbyId` (`String?`). Do **not** reuse `wc3statsGameId` |
| Duplicate | At most one non-terminal match per `(leagueId, bnetLobbyId)` — point at existing |
| Transport | Watcher **outbound HTTPS** to the bot ingest API (shared token) |
| Queue | Discord defers; watcher polls `GET /jobs/next`; result POSTs roster |
| Empty-full | Unusable snapshot must not wipe a non-empty Discord roster |
| Profile | UDBR stays `import: 'wc3stats'` in code. Watcher is a **league flag**, off by default |
| Game gate | Enable only when `gameId === warcraft3_udbr` |
| Map filter | Reuse that league’s existing UDBR pattern + sha1 allowlist |
| Cards channel | Same rule as host prompt: lobby channel when lobby channel is ready |
| Screenshot | Unchanged fallback |

## Architecture

```
Windows (Reforged + watcher)                 AWS (existing Discord bot)
  game list → mint ids                          ingest HTTP (token)
  poll GET /jobs/next  ---------------------->  BnetJoinJob queue
  join referee → snapshot → leave               createPendingMatch
  POST job result + gamelist + heartbeat        replaceMatchRoster
                                                discovery cards
```

The Discord process does not load WC3 protocol code. The watcher talks only through the ingest contract. CI uses a fake watcher.

EC2 today has **no inbound** except optional SSH. This feature **requires ingest ingress** (new SG rule, IP allowlist). That is an intentional exception to “inbound none.”

## Components

| Unit | Path (intent) | Responsibility |
|------|----------------|----------------|
| Roster map | `src/services/bnet-lobby/bnet-roster.ts` | Watcher slots → heroes 1–12; skip referee; strip watcher nick |
| Jobs | `src/services/bnet-lobby/bnet-jobs.ts` | Enqueue, claim one, complete/fail, stale `running` |
| Ingest HTTP | `src/services/bnet-lobby/bnet-ingest.ts` | Heartbeat, gamelist upsert, job next/result |
| Create/refresh | `src/services/lobby/create-from-bnet.ts`, `bnet-refresh.ts` | Same patterns as wc3stats create/refresh |
| Cards | `src/services/bnet-lobby/bnet-host-prompt.ts` + poller | Live UDBR cards + Open lobby |
| Watcher | `watcher/` (separate entry, Windows) | List, mint ids, join referee, snapshot, leave, HTTP client |

WC3 join stays behind `listGames()`, `joinAndSnapshot(id)`, `leave()`. Bot tests never call them.

## Data model

### League

```prisma
bnetWatcherEnabled   Boolean @default(false)
```

Ready when: league `gameId` is `warcraft3_udbr` **and** `bnetWatcherEnabled` **and** wc3stats map pattern is set (same UDBR filter we already store) **and** ingest token is configured **and** watcher heartbeat is fresh.

Reuse `wc3statsMapPattern` / `wc3statsMapSha1` / slot maps. Do not duplicate map columns. `/config set wc3stats_map_preset UDBR` remains how staff load the filter; watcher enable is a separate switch.

v1 cards **only when lobby channel is ready**; post to `lobbyChannelId`. No second channel column.

### Match

```prisma
bnetLobbyId String?
@@index([leagueId, bnetLobbyId])
```

Store the minted id as a decimal string (`"42"`). Uniqueness among `PENDING` / `IN_PROGRESS` per league is enforced in `createPendingMatch` / link (same style as wc3stats), not a partial unique index.

### Singleton heartbeat

```prisma
model BnetWatcherState {
  id           Int      @id @default(1)
  lastSeenAt   DateTime
  watcherNick  String   // normalized nick to strip from snapshots
}
```

Stale when `now - lastSeenAt > 60s` (env `BNET_WATCHER_STALE_MS`, default `60000`).

### Live list (for cards + autocomplete)

```prisma
model BnetLiveLobby {
  id          Int      @id // watcher-minted
  name        String
  host        String
  map         String
  slotsTaken  Int
  slotsTotal  Int
  server      String?
  updatedAt   DateTime
}
```

Replace-all on each gamelist PUT: upsert posted ids, **delete** ids not in the payload (lobby left the list).

### Jobs

```prisma
enum BnetJoinJobStatus {
  queued
  running
  succeeded
  failed
}

enum BnetJoinJobPurpose {
  create
  refresh
}

model BnetJoinJob {
  id           String            @id @default(cuid())
  bnetLobbyId  String
  matchId      String
  purpose      BnetJoinJobPurpose
  status       BnetJoinJobStatus @default(queued)
  errorCode    String?
  errorMessage String?
  claimedAt    DateTime?
  finishedAt   DateTime?
  createdAt    DateTime          @default(now())
  match        Match             @relation(...)
  @@index([status, createdAt])
}
```

Claim: one `running` row at a time. `GET /jobs/next` atomically sets the oldest `queued` to `running` only if no other `running` exists. If a job is `running` and heartbeat is stale, mark it `failed` with `watcher_offline` so the queue cannot stick.

## Ingest API

Listen only when `BNET_INGEST_TOKEN` is non-empty. Bind `BNET_INGEST_HOST` (default `0.0.0.0`) and `BNET_INGEST_PORT` (default `8787`). Node `http` — no new dependency.

Header: `Authorization: Bearer <BNET_INGEST_TOKEN>`. Wrong/missing → `401`, no writes.

| Method | Path | Body / result |
|--------|------|----------------|
| POST | `/v1/watcher/heartbeat` | `{ "watcherNick": string }` → upsert singleton |
| PUT | `/v1/watcher/gamelist` | `{ "lobbies": BnetLiveLobby[] }` → replace-all |
| GET | `/v1/watcher/jobs/next` | `204` empty, or `200` `{ id, bnetLobbyId, matchId, purpose }` |
| POST | `/v1/watcher/jobs/:id/result` | success `{ "ok": true, "slots": [...] }` or `{ "ok": false, "code", "message" }` |

Snapshot slot:

```ts
type BnetSnapshotSlot = {
  index: number; // 0-based color index, same as today’s wc3stats slots[]
  status: 'occupied' | 'open' | 'closed';
  isComputer?: boolean;
  isObserver?: boolean;
  player?: { name?: string | null; battleTag?: string | null } | null;
};
```

Reuse UDBR slot map (`LeagueWc3statsSlotMap` / `UDBR_WC3STATS_SLOT_MAP`). Unmapped indices (referee) skipped. Watcher nick stripped. Computers, observers, empty names skipped.

Apply result only if the job is `running` and `matchId` is still `PENDING`. Then `replaceMatchRoster` + Discord message refresh (same helper as other lobby actions).

## Discord UX

### `/config`

- `/config set bnet_watcher enabled:True` — refuse unless `gameId === warcraft3_udbr`
- `/config clear bnet_watcher` — disable
- `/config view` — on/off, heartbeat age, live lobby count

Cards run when watcher is ready **and** lobby channel is ready.

### `/register_lobby`

New optional string `lobby_id` (positive integer). Autocomplete from `BnetLiveLobby` filtered by the resolved league’s map config.

If `lobby_id` is set, ignore wc3stats import for that invocation. Screenshot + `lobby_id` together: refuse (`Pick either a screenshot or a lobby id.`).

Create-role, lobby channel, host cap, mods bypass cap — unchanged.

Flow: create PENDING bound to `bnetLobbyId` (empty roster OK) → enqueue `create` job → edit reply when result arrives or on timeout (match exists; footer says import pending/failed).

Open lobby on a card: same create helper as `/register_lobby lobby_id` (shared `create-from-bnet.ts`). v1 cards: **public list of live UDBR games**. Open requires create-role. Dismiss hides that card for that id until it leaves and returns.

### Refresh

Existing Refresh button works when `bnetLobbyId` is set (show Refresh if watcher-ready **or** id bound). Enqueue `refresh`. Optional bind via `linkMatchBnetLobbyId` (mirror `linkMatchWc3statsGameId`) when a PENDING match was created empty.

Debounce: 15s per match. If a match has both `bnetLobbyId` and `wc3statsGameId`, **bnet wins**.

### Lookup

`/register_lobby` autocomplete is enough for typed ids. Cards print **Lobby id: N**. No extra slash in v1.

## Data flow

1. Watcher heartbeats and PUTs gamelist (~15s).
2. Bot poller upserts Discord cards for live UDBR rows (dedupe `leagueId:bnetLobbyId` in memory, skip if an active match already has that id).
3. Create / Open / Refresh → `BnetJoinJob` `queued`.
4. Watcher `GET /jobs/next` → joins referee → POSTs result → leaves.
5. Bot maps slots → `replaceMatchRoster` if usable → refresh embed. Footer: `Source: Warcraft lobby N`.

Queue: a second job stays `queued`. User copy: watcher busy; the embed updates when this job finishes. Do not start a second Reforged join.

## Error handling

English only. After defer, edit the same reply. Never occupy heroes 1–12.

| Situation | Copy / behavior |
|-----------|-----------------|
| Token unset / ingest down | Feature not ready; `/config view` says ingest is off |
| Heartbeat stale | `The Warcraft lobby watcher is offline. Use a screenshot or add players manually.` Refuse new jobs. Screenshot still allowed |
| Unknown / expired id | `No live lobby with that id. Check the lobby cards or pick an id from autocomplete.` |
| Not UDBR | `That lobby is not Ultimate Dragon Ball Reborn.` Do not enqueue |
| Lobby gone before join | Job `failed` `lobby_gone`. Match unchanged |
| No referee seat | Job `failed` `no_referee`. `Cannot read that lobby without taking a player seat. Leave a referee slot open and try again.` |
| Join timeout / hung | Job `failed` `join_timeout`. Match unchanged. Watcher must leave/reset |
| Empty-full | Unusable. Keep Discord roster. `The watcher saw no player list. Your current roster was kept.` |
| Watcher nick only occupant | Unusable after strip |
| Duplicate active id | Point at existing match |
| Discord wait timeout | Match stays; footer/error: last import failed, retry Refresh |
| Job result for non-PENDING | Ignore roster write |
| Wrong game | `Warcraft lobby import is not supported for this game.` |
| Screenshot + lobby_id | `Pick either a screenshot or a lobby id.` |
| Watcher busy | `The watcher is reading another lobby. This match will update when that finishes.` |

Crash mid-join: stale heartbeat fails `running` jobs.

## Env / AWS

Bot-read (SSM + `refresh-env.sh` + `.env.example` + `scripts-and-env.mdc`):

| Key | Default | Notes |
|-----|---------|--------|
| `BNET_INGEST_TOKEN` | empty | Empty = do not listen |
| `BNET_INGEST_HOST` | `0.0.0.0` | |
| `BNET_INGEST_PORT` | `8787` | |
| `BNET_WATCHER_STALE_MS` | `60000` | |

Terraform: optional SG ingress `BNET_INGEST_PORT` from `bnet_watcher_cidr` (e.g. home `/32`), default **disabled** (`enable_bnet_ingest = false`) so existing boxes stay closed until ops turn it on.

Watcher box (local, **not** SSM): `BNET_INGEST_URL`, `BNET_INGEST_TOKEN`, Battle.net account (never in git).

## Testing

CI: no Warcraft, no Battle.net. Fake ingest client in tests.

- Roster: UDBR map, skip 13–16, strip nick, empty-full unusable
- Jobs: one `running`; stale heartbeat fails running; duplicate id
- Ingest: 401; gamelist replace-all; usable snapshot applies
- Discord: `lobby_id` and Refresh share apply path; watcher-offline copy
- Windows: manual list/join/snapshot/leave (plan 2)

## Phasing

1. **Bot ingest** (plan 1) — schema, HTTP, jobs, Discord, tests against a fake result POST. Shippable without Reforged if ops POST fixtures.
2. **Windows watcher** (plan 2) — HTTP client + Reforged join adapter. Highest risk.

## Open ops (not product)

Reforged join automation (UI vs local webui vs protocol) is validated in plan 2. The bot contract does not depend on which adapter wins.
