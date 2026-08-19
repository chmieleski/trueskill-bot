# Battle.net lobby ingest (bot) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Discord bot accepts a watcher-minted lobby id, queues a join job, applies the snapshot roster to a PENDING match, and posts live UDBR discovery cards — without calling wc3stats on this path.

**Architecture:** Prisma job + live-list + heartbeat tables. Tiny Node `http` ingest (Bearer token). Shared create/refresh use-cases call `replaceMatchRoster`. Tests POST fake snapshots; no Warcraft client.

**Tech Stack:** TypeScript ESM, Prisma, Node `http`, discord.js v14, Vitest

**Spec:** `docs/superpowers/specs/2026-08-19-bnet-lobby-ingest-design.md`

**Scope:** `game:warcraft3_udbr` for map/slots/commands; jobs/ingest/roster apply keyed by `leagueId` (`general` persistence)

**Depends on:** Watcher sidecar is **not** this plan (`docs/superpowers/plans/2026-08-19-bnet-lobby-watcher.md`). A curl/fixture client is enough to test ingest.

**Do not implement until asked.**

## Global Constraints

- English-only user-facing strings and errors
- ESM imports use the `.js` extension; named exports only
- Prisma singleton from `src/lib/prisma.ts`
- Do not call wc3stats HTTP from this path
- Never map referee indices to heroes 1–12; never instruct a join into slots 1–12
- Empty-full snapshots must not wipe a non-empty Discord roster
- One `BnetJoinJob` `running` at a time
- `BNET_INGEST_TOKEN` empty → do not bind the HTTP port
- New bot env keys must follow `.cursor/rules/env-aws-sync.mdc` (SSM, Terraform SG, `refresh-env.sh`)
- Do not reuse `Match.wc3statsGameId`
- Screenshot import stays; `print` + `lobby_id` together refuse
- User-facing copy must match the spec error table verbatim

## File map

| File                                                                                    | Role                                                                                          |
| --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `prisma/schema.prisma`                                                                  | `bnetWatcherEnabled`, `Match.bnetLobbyId`, `BnetWatcherState`, `BnetLiveLobby`, `BnetJoinJob` |
| `src/config/env.ts`                                                                     | Ingest token/host/port/stale ms                                                               |
| `.env.example`, `.cursor/rules/scripts-and-env.mdc`                                     | Document keys                                                                                 |
| `infra/aws/variables.tf`, `ssm.tf`, `main.tf`, `terraform.tfvars.example`               | Token + optional ingest ingress                                                               |
| `deploy/aws/refresh-env.sh`                                                             | Echo new keys                                                                                 |
| `src/services/bnet-lobby/bnet-roster.ts`                                                | Slot → hero mapping                                                                           |
| `src/services/bnet-lobby/bnet-jobs.ts`                                                  | Enqueue / claim / complete / stale fail                                                       |
| `src/services/bnet-lobby/bnet-ingest.ts`                                                | HTTP server                                                                                   |
| `src/services/lobby/create-from-bnet.ts`                                                | Open / `/register_lobby lobby_id`                                                             |
| `src/services/lobby/bnet-refresh.ts`                                                    | Refresh + optional bind                                                                       |
| `src/services/match/match-service.ts`                                                   | `bnetLobbyId` on create/link/duplicate                                                        |
| `src/services/league/league-wc3stats.ts`                                                | Resolve `bnetWatcherEnabled` + ready helper                                                   |
| `src/commands/config/config.ts`                                                         | set/clear/view                                                                                |
| `src/commands/lobby/register-lobby.ts`                                                  | `lobby_id` + autocomplete                                                                     |
| `src/services/lobby/lobby-preview.ts`                                                   | Footer + Refresh when bound                                                                   |
| `src/discord/interactions/`                                                             | Open lobby + Refresh wiring                                                                   |
| `src/index.ts`                                                                          | Start/stop ingest + card poller                                                               |
| `docs/discord/public/03-start-a-lobby.md`, `staff/a4` or new `staff/a6-bnet-watcher.md` | User/staff copy                                                                               |

---

### Task 1: Schema

**Files:**

- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<timestamp>_bnet_lobby_ingest/migration.sql` via `npm run db:migrate`

**Interfaces:**

- Produces: Prisma models as in the spec (`League.bnetWatcherEnabled`, `Match.bnetLobbyId`, singleton `BnetWatcherState`, `BnetLiveLobby`, `BnetJoinJob` + enums). `Match` needs `bnetJoinJobs BnetJoinJob[]`.

- [ ] **Step 1: Add models to `schema.prisma`**

On `League`, after `lobbyChannelId`:

```prisma
bnetWatcherEnabled Boolean @default(false)
```

On `Match`, next to `wc3statsGameId`:

```prisma
bnetLobbyId String?
bnetJoinJobs BnetJoinJob[]
@@index([leagueId, bnetLobbyId])
```

Add models/enums exactly as the spec Data model section.

- [ ] **Step 2: Migrate local Docker**

Run: `npm run db:migrate`  
Expected: migration applied; `BnetJoinJob` exists.

- [ ] **Step 3: Commit** (when the user asks to commit this slice)

---

### Task 2: Roster mapping (TDD)

**Files:**

- Create: `src/services/bnet-lobby/bnet-roster.ts`
- Create: `src/services/bnet-lobby/bnet-roster.test.ts`

**Interfaces:**

- Consumes: `LobbyPlayer` from `src/services/lobby/lobby-ocr.ts`; `nickFromWc3statsPlayer`; `Wc3statsHeroSlotMap`; `UDBR_WC3STATS_SLOT_MAP` via `load` or pass map in
- Produces:
  - `BnetSnapshotSlot` type (spec)
  - `extractBnetRoster(input: { slots: BnetSnapshotSlot[]; slotMap: Wc3statsHeroSlotMap | null; watcherNick: string; slotsTaken?: number }): Wc3statsRosterResult`
  - Reuse `applyWc3statsRefresh` for empty-full **or** export `applyBnetRefresh` that is the same logic (prefer calling `applyWc3statsRefresh` to stay DRY)

- [ ] **Step 1: Write failing tests**

```typescript
import { describe, expect, it } from 'vitest';
import { extractBnetRoster } from './bnet-roster.js';
import { UDBR_WC3STATS_SLOT_MAP } from '../wc3stats/wc3stats-slot-map.js';

const slotMap = new Map(UDBR_WC3STATS_SLOT_MAP.map((e) => [e.wc3statsSlot, e.heroId]));

describe('extractBnetRoster', () => {
  it('maps UDBR colors to heroes 1–12 and skips referee 13–16', () => {
    const slots = Array.from({ length: 16 }, (_, index) => ({
      index,
      status: index === 0 ? ('occupied' as const) : ('open' as const),
      player: index === 0 ? { name: 'Goku#1' } : null,
    }));
    const result = extractBnetRoster({ slots, slotMap, watcherNick: 'ihlbot' });
    expect(result.usable).toBe(true);
    expect(result.players).toEqual([{ slot: 1, nick: 'goku' }]);
  });

  it('strips the watcher nick', () => {
    const result = extractBnetRoster({
      slots: [{ index: 0, status: 'occupied', player: { name: 'IhlBot#2' } }],
      slotMap,
      watcherNick: 'ihlbot',
      slotsTaken: 1,
    });
    expect(result.players).toEqual([]);
    expect(result.usable).toBe(false); // occupied count claimed but no humans left
  });

  it('marks empty-full unusable', () => {
    const result = extractBnetRoster({
      slots: [],
      slotMap,
      watcherNick: 'ihlbot',
      slotsTaken: 6,
    });
    expect(result.usable).toBe(false);
    expect(result.players).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests — fail**

Run: `npm test -- src/services/bnet-lobby/bnet-roster.test.ts`  
Expected: fail (module missing).

- [ ] **Step 3: Implement `extractBnetRoster`**

Same occupancy rules as `extractWc3statsRoster` (`status === 'occupied'`, not computer, not observer). Skip indices not in `slotMap`. Skip `nick === watcherNick`. `usable = occupiedCount > 0 || (slotsTaken ?? 0) === 0`.

- [ ] **Step 4: Run tests — pass**

---

### Task 3: Jobs (TDD)

**Files:**

- Create: `src/services/bnet-lobby/bnet-jobs.ts`
- Create: `src/services/bnet-lobby/bnet-jobs.test.ts`

**Interfaces:**

- Produces:
  - `enqueueBnetJoinJob(input: { bnetLobbyId: string; matchId: string; purpose: 'create' | 'refresh' }): Promise<BnetJoinJob>`
  - `claimNextBnetJoinJob(): Promise<BnetJoinJob | null>` — null if another `running` exists or queue empty
  - `failStaleRunningJobs(staleMs: number): Promise<number>`
  - `completeBnetJoinJob(id: string, result: { ok: true } | { ok: false; code: string; message: string }): Promise<void>`
  - `isBnetWatcherFresh(staleMs: number): Promise<boolean>`
  - `upsertBnetHeartbeat(watcherNick: string): Promise<void>`
  - `replaceBnetGamelist(lobbies: Array<{ id: number; name: string; host: string; map: string; slotsTaken: number; slotsTotal: number; server?: string }>): Promise<void>`

- [ ] **Step 1: Tests with mocked `prisma`** (`vi.hoisted` + `vi.mock('../../lib/prisma.js')`)

Cover: claim returns null when a `running` row exists; `failStaleRunningJobs` sets `running` with old `claimedAt` to `failed` / `watcher_offline`; `replaceBnetGamelist` deletes ids not in the payload (assert `deleteMany` where `id not in`).

- [ ] **Step 2: Implement with Prisma singleton**

`claimNextBnetJoinJob` must be a transaction: `findFirst running` → if found return null; else `findFirst queued orderBy createdAt asc` → update `running` + `claimedAt`.

- [ ] **Step 3: Tests pass**

---

### Task 4: Ingest HTTP

**Files:**

- Create: `src/services/bnet-lobby/bnet-ingest.ts`
- Create: `src/services/bnet-lobby/bnet-ingest.test.ts`
- Create: `src/services/bnet-lobby/bnet-copy.ts` — freeze spec strings
- Modify: `src/index.ts` — `startBnetIngestIfConfigured()` / stop on shutdown

**Interfaces:**

- Consumes: `env.bnetIngestToken`, jobs helpers, `extractBnetRoster`, `replaceMatchRoster`, `syncLobbyDiscordMessage`
- Produces: `startBnetIngestServer(): Promise<{ close: () => Promise<void> } | null>`

- [ ] **Step 1: Copy constants in `bnet-copy.ts`** (verbatim from spec Error handling table)

- [ ] **Step 2: Tests** — `http.request` against `startBnetIngestServer` with a test token:

  - no/wrong `Authorization` → 401
  - `POST /v1/watcher/heartbeat` `{ watcherNick: "IhlBot#1" }` → 204 and nick stored normalized
  - `GET /v1/watcher/jobs/next` with empty queue → 204
  - `POST /v1/watcher/jobs/:id/result` success with occupied slot → match roster updated (mock match-service)

- [ ] **Step 3: Implement router**

Parse `Authorization` as `Bearer ` + token (timing-safe compare). Unknown path → 404. JSON body errors → 400. Job result: load job; if not `running` → 409; if match not `PENDING` → 200 ignore write; else extract roster, `applyWc3statsRefresh`, `replaceMatchRoster` when applying, `completeBnetJoinJob`.

- [ ] **Step 4: Bootstrap** — if token empty, log and skip listen. Else listen `env.bnetIngestHost:env.bnetIngestPort`. Shutdown closes the server.

---

### Task 5: Env + AWS

**Files:**

- Modify: `src/config/env.ts`
- Modify: `.env.example`
- Modify: `.cursor/rules/scripts-and-env.mdc`
- Modify: `infra/aws/variables.tf`, `ssm.tf`, `main.tf`, `terraform.tfvars.example`
- Modify: `deploy/aws/refresh-env.sh`

**Interfaces:**

- Produces: `env.bnetIngestToken?: string`, `bnetIngestHost: string`, `bnetIngestPort: number`, `bnetWatcherStaleMs: number`

- [ ] **Step 1: Parse env**

Empty token → `undefined`. Port default `8787`. Host default `0.0.0.0`. Stale default `60000`.

- [ ] **Step 2: SSM SecureString for token, String for host/port/stale.** Empty token → `__EMPTY__` sentinel.

- [ ] **Step 3: `enable_bnet_ingest` default `false`.** When true, SG ingress TCP `bnet_ingest_port` from `bnet_watcher_cidr` (required `/32` when enabled). Do not change the existing SG description text (immutable).

- [ ] **Step 4: `refresh-env.sh` explicit `echo BNET_INGEST_TOKEN=...` lines**

---

### Task 6: Match bind + create-from-bnet

**Files:**

- Modify: `src/services/match/match-service.ts`
- Create: `src/services/lobby/create-from-bnet.ts`
- Create: `src/services/lobby/create-from-bnet.test.ts`
- Modify: `src/services/league/league-wc3stats.ts` — `bnetWatcherEnabled` + `isLeagueBnetWatcherReady`

**Interfaces:**

- Produces:
  - `isLeagueBnetWatcherReady(config, input: { gameId: string; ingestConfigured: boolean; watcherFresh: boolean }): boolean` — `gameId === warcraft3_udbr` + enabled + map pattern + ingest + fresh
  - `findActiveMatchByBnetLobbyId(leagueId, bnetLobbyId)`
  - `linkMatchBnetLobbyId(matchId, bnetLobbyId)` — mirror wc3stats link
  - `createPendingMatch` accepts `bnetLobbyId?: string | null` and duplicate-checks per league
  - `createMatchFromBnetLobby(input: { leagueId; hostDiscordId; discordChannelId; bnetLobbyId: string; bypassHostLobbyCap: boolean; roleIds; ... }): Promise<{ match; job; existing?: true }>`

- [ ] **Step 1: Duplicate message** — `You already have a match for Warcraft lobby {id} ({matchId}).`

- [ ] **Step 2: If live lobby missing or `!isUdbrMap` → throw spec copy** (`No live lobby...` / `That lobby is not Ultimate Dragon Ball Reborn.`)

- [ ] **Step 3: If watcher not fresh → throw offline copy. Do not create.**

- [ ] **Step 4: Create PENDING + `enqueueBnetJoinJob` purpose `create`.** If duplicate active id, return existing match and **do not** enqueue.

- [ ] **Step 5: Tests** for duplicate, not UDBR, stale watcher (mock prisma + jobs).

---

### Task 7: `/register_lobby lobby_id` + autocomplete

**Files:**

- Modify: `src/commands/lobby/register-lobby.ts`
- Modify: `src/services/lobby/register-lobby-source.ts` if needed

- [ ] **Step 1: Option `lobby_id` string, autocomplete live ids** (name + host + id). Filter by resolved league map config.

- [ ] **Step 2: If `lobby_id` and `print` both set →** `Pick either a screenshot or a lobby id.`

- [ ] **Step 3: If `lobby_id` set, skip wc3stats import.** Call `createMatchFromBnetLobby`. Defer already exists. Poll job status until `succeeded`/`failed` or 45s timeout, then `editReply` with lobby embed + buttons. Timeout copy: match exists, retry Refresh.

- [ ] **Step 4: Deploy commands** (dev auto).

---

### Task 8: Refresh + embed

**Files:**

- Create: `src/services/lobby/bnet-refresh.ts`
- Modify: `src/services/lobby/lobby-preview.ts`
- Modify: `src/discord/interactions/lobby-interactions.ts`
- Modify: `src/commands/lobby/lobby.ts` if Refresh is also a subcommand

**Interfaces:**

- Produces: `refreshLobbyFromBnet(input)` — PENDING only; enqueue `refresh`; wait or return busy copy if a `running` job already exists for **another** match (this match’s job is queued). 15s debounce per match.

- [ ] **Step 1: Show Refresh when `bnetLobbyId` or watcher-ready** (in addition to wc3stats). Footer `Source: Warcraft lobby {id}`.

- [ ] **Step 2: Handler: if match has `bnetLobbyId`, use bnet refresh, not wc3stats.** If both ids somehow set, **bnet wins**.

- [ ] **Step 3: Empty-full → kept roster + spec sentence.**

- [ ] **Step 4: Preview tests** for footer/button.

---

### Task 9: Discovery cards

**Files:**

- Create: `src/services/bnet-lobby/bnet-host-prompt.ts`
- Create: `src/services/bnet-lobby/bnet-host-prompt-poller.ts`
- Create: `src/discord/interactions/bnet-host-prompt-interactions.ts`
- Modify: `src/index.ts` start/stop poller

**Interfaces:**

- Custom id: `bnet_prompt:open:{leagueId}:{bnetLobbyId}` and `bnet_prompt:dismiss:...` (keep under 100 chars; `bnetLobbyId` is numeric)

- [ ] **Step 1: Poll ~45s.** For each league with watcher ready **and** lobby channel ready, list `BnetLiveLobby` passing `isUdbrMap`. Skip ids with an active match. Dedupe in-memory `leagueId:id`.

- [ ] **Step 2: Post embed: name, host, map, slots, `Lobby id: N`, Open + Dismiss.** Open requires create-role → `createMatchFromBnetLobby` → replace the card with the match embed (`attachDiscordMessage`).

- [ ] **Step 3: Dismiss: delete/edit card; remember id until gamelist drop.**

- [ ] **Step 4: Tests for custom-id parse + map filter (no Discord).**

---

### Task 10: `/config` + docs

**Files:**

- Modify: `src/commands/config/config.ts`
- Create: `docs/discord/staff/a6-bnet-watcher.md`
- Modify: `docs/discord/public/03-start-a-lobby.md`
- Modify: `docs/discord/README.md` staff index if needed
- Modify: `src/services/bnet-lobby/index.ts` barrel

- [ ] **Step 1:** `/config set bnet_watcher enabled:True` / `clear` / `view` (heartbeat age, live count, ingest on/off). Refuse ACA.

- [ ] **Step 2: Staff doc:** enable UDBR map preset first, then watcher; referee slots must stay open; AWS SG + token.

- [ ] **Step 3: Public doc:** optional `lobby_id` and cards.

---

## Verification

Run: `npm test -- src/services/bnet-lobby src/services/lobby/create-from-bnet.test.ts src/services/lobby/lobby-preview.test.ts`  
Expected: pass.

Manual (fixture, no WC3): `curl` heartbeat + gamelist + fake job result against local ingest; `/register_lobby lobby_id:1` updates roster.
