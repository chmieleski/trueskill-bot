# Battle.net lobby watcher (Windows sidecar) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Windows sidecar talks to the bot ingest API, keeps a live UDBR game list with stable minted ids, and on each job joins a **referee** seat, snapshots slots, leaves, then POSTs the result.

**Architecture:** Separate Node entry under `watcher/` (no discord.js). HTTP client matches the ingest contract. WC3 access is an adapter: `listGames` / `joinAndSnapshot` / `leave`. First adapter may be a **dump/spy** or stub; production adapter must use the running Reforged client. One join at a time (the bot already serializes jobs).

**Tech Stack:** TypeScript ESM, Node 22, `fetch`, Reforged on Windows

**Spec:** `docs/superpowers/specs/2026-08-19-bnet-lobby-ingest-design.md`  
**Depends on:** Bot ingest plan (`docs/superpowers/plans/2026-08-19-bnet-lobby-ingest.md`) so `/v1/watcher/*` exists.

**Scope:** `game:warcraft3_udbr`

**Do not implement until asked.**

## Global Constraints

- English logs
- Never join hero slots 1–12. If only those are open, fail the job with `no_referee` and the spec message
- One in-flight join; do not call `GET /jobs/next` while joining
- Watcher-minted ids are positive integers, **stable** while the game remains on the list, reused across heartbeats, **retired** on remove
- Do not put Battle.net passwords or ingest tokens in git
- Do not import `watcher/` from the Discord `src/index.ts` bot process
- CI may run HTTP-client + id-mint tests only (no Warcraft)

## File map

| File | Role |
|------|------|
| `watcher/package.json` | Private package, `"type": "module"` |
| `watcher/src/config.ts` | `BNET_INGEST_URL`, `BNET_INGEST_TOKEN`, `WATCHER_NICK`, poll ms |
| `watcher/src/ingest-client.ts` | Heartbeat, gamelist PUT, jobs next/result |
| `watcher/src/lobby-ids.ts` | Mint/reuse/retire ids |
| `watcher/src/wc3-adapter.ts` | Interface + errors |
| `watcher/src/wc3-stub.ts` | Fixture adapter for tests |
| `watcher/src/loop.ts` | Main loop |
| `watcher/src/index.ts` | Entry |
| `watcher/README.md` | Windows ops: Reforged logged in, referee, firewall to EC2 |

---

### Task 1: Ingest client (TDD)

**Files:**
- Create: `watcher/src/ingest-client.ts`
- Create: `watcher/src/ingest-client.test.ts`

**Interfaces:**
- Produces:
  - `createIngestClient(input: { baseUrl: string; token: string }): IngestClient`
  - `IngestClient.heartbeat(watcherNick: string): Promise<void>`
  - `IngestClient.putGamelist(lobbies: LiveLobby[]): Promise<void>`
  - `IngestClient.nextJob(): Promise<JoinJob | null>` — `204` → null
  - `IngestClient.postResult(jobId: string, body: JobResult): Promise<void>`

`Authorization: Bearer ${token}`. Paths exactly as the spec.

- [ ] **Step 1: Tests with `vi.stubGlobal('fetch', ...)`** for 204 vs 200 nextJob, 401 throws a named error.

- [ ] **Step 2: Implement with `fetch` + `AbortSignal.timeout`.**

- [ ] **Step 3: Tests pass** (`npx vitest run` from `watcher/` or root if wired). Prefer root Vitest include `watcher/**/*.test.ts` **or** watcher’s own vitest — pick one; do not double-run Discord bot tests against WC3.

---

### Task 2: Stable lobby ids (TDD)

**Files:**
- Create: `watcher/src/lobby-ids.ts`
- Create: `watcher/src/lobby-ids.test.ts`

**Interfaces:**
- Produces:
  - `type ObservedGame = { key: string; name: string; host: string; map: string; slotsTaken: number; slotsTotal: number; server?: string }`
  - `createLobbyIdMint(): { sync(games: ObservedGame[]): LiveLobby[] }`
  - `LiveLobby` includes minted `id: number`

**Key:** `server + '\\0' + host + '\\0' + name + '\\0' + map` (same host hosting two identical names on one server is accepted collision; document in README).

- [ ] **Step 1: Tests**

```typescript
it('reuses id while the key remains', () => {
  const mint = createLobbyIdMint();
  const a = mint.sync([game('h', 'udbr')]);
  const b = mint.sync([game('h', 'udbr')]);
  expect(a[0]!.id).toBe(b[0]!.id);
});

it('retires id when the game leaves, does not reuse that integer for a new key in v1', () => {
  const mint = createLobbyIdMint();
  mint.sync([game('h1', 'udbr')]);
  mint.sync([]);
  const next = mint.sync([game('h2', 'udbr')]);
  expect(next[0]!.id).toBeGreaterThan(1);
});
```

v1: monotonic `nextId++`; never reuse integers in-process (avoids Discord cards pointing at the wrong lobby after a quick host recycle). Process restart may reuse from 1 — document: Refresh may 404 until the host re-opens from a new card.

- [ ] **Step 2: Implement**

- [ ] **Step 3: Tests pass**

---

### Task 3: WC3 adapter interface + stub

**Files:**
- Create: `watcher/src/wc3-adapter.ts`
- Create: `watcher/src/wc3-stub.ts`
- Create: `watcher/src/wc3-adapter.test.ts`

**Interfaces:**
- Produces:

```typescript
export class Wc3AdapterError extends Error {
  constructor(
    public readonly code: 'no_referee' | 'join_timeout' | 'lobby_gone' | 'not_udbr',
    message: string,
  ) {
    super(message);
    this.name = 'Wc3AdapterError';
  }
}

export type Wc3Adapter = {
  listGames(): Promise<ObservedGame[]>;
  /** Join referee only. Must not occupy hero slots 1–12. */
  joinAndSnapshot(bnetLobbyId: number, resolveGame: (id: number) => ObservedGame | undefined): Promise<BnetSnapshotSlot[]>;
  leave(): Promise<void>;
};
```

Copy `no_referee` message from spec.

- [ ] **Step 1: Stub adapter** reads `watcher/fixtures/gamelist.json` + `snapshot.json` for tests.

- [ ] **Step 2: Test `joinAndSnapshot` throws `no_referee` when fixture `refereeOpen: false`.**

- [ ] **Step 3: Real Reforged adapter is Task 5.** Do not call Battle.net from CI.

---

### Task 4: Main loop

**Files:**
- Create: `watcher/src/loop.ts`
- Create: `watcher/src/loop.test.ts`
- Create: `watcher/src/index.ts`
- Create: `watcher/src/config.ts`

**Interfaces:**
- Loop tick (~5s): heartbeat → `listGames` → mint → `putGamelist` → if not joining, `nextJob` → joinAndSnapshot → `postResult` → `leave` in `finally`.

- [ ] **Step 1: Tests with stub adapter + mocked ingest:** job `no_referee` posts `{ ok: false, code: 'no_referee', message }` and still calls `leave`.

- [ ] **Step 2: Map adapter errors to spec codes:** `lobby_gone`, `join_timeout`, `not_udbr`.

- [ ] **Step 3: Config from env:** `BNET_INGEST_URL` (e.g. `http://BOT_PUBLIC_IP:8787`), `BNET_INGEST_TOKEN`, `WATCHER_NICK` (BattleTag of the bot account, used on heartbeat).

- [ ] **Step 4: README run:** `npx tsx src/index.ts` from `watcher/` on Windows while Reforged is logged in.

---

### Task 5: Reforged join adapter (Windows, manual)

**Files:**
- Create: `watcher/src/wc3-reforged.ts`
- Create: `watcher/README.md` (ops + spike notes)

This task is a **spike with a locked fail-closed contract**. Do not ship a hero-slot join even if it “works.”

- [ ] **Step 1: Dump native game list** (local webui websocket and/or UI) into `watcher/fixtures/` from a real UDBR lobby. Document message shapes in README. Prefer read-only dump first (`listGames` only).

- [ ] **Step 2: Implement `listGames` against the chosen source.** Map to `ObservedGame`. Filter nothing here — bot filters UDBR; sending the full custom list is OK.

- [ ] **Step 3: Implement join as referee.** If the client would land in colors 1–12, **abort**, `leave` if needed, throw `no_referee`. Confirm on a 12/12 lobby with referee closed: fail, no hero seat taken.

- [ ] **Step 4: Snapshot `BnetSnapshotSlot[]` using the same 0-based color index as `LeagueWc3statsSlotMap`.** Occupied humans have `player.name` or `battleTag`.

- [ ] **Step 5: `leave` always in the loop `finally`.** Hung join → `join_timeout` after `WATCHER_JOIN_TIMEOUT_MS` (default 30000).

- [ ] **Step 6: Manual checklist** (not CI): list appears in Discord cards; Open lobby fills 1–12; Refresh after a swap; full lobby without referee fails with spec copy; bot account never starts the WC3 match.

---

### Task 6: Ops README

**Files:**
- Modify: `watcher/README.md`
- Modify: `docs/discord/staff/a6-bnet-watcher.md` (link from ingest plan) — Windows box, Reforged always in custom-game browser, ingest SG `/32`, token, referee slots 13–16 left open on UDBR hosts

- [ ] **Step 1: Write start order:** bot ingest listening → watcher process → host UDBR with referee open → card → Open.

- [ ] **Step 2: Explicit: Battle.net ToS / account is the operator’s risk; the bot will not store the password.**

---

## Verification

Run (CI): watcher unit tests only.  
Run (Windows): Task 5 checklist against a private UDBR lobby.
