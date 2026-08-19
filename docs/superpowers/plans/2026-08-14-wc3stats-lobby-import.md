# wc3stats Lobby Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Import Ultimate Dragon Ball Reborn lobby players from wc3stats into a PENDING Discord match, with Refresh while pending, without trusting empty `slots[]` payloads.

**Architecture:** Thin REST client + pure map/roster/resolve functions. `/register_lobby` tries wc3stats when enabled and no screenshot (or when `wc3stats_id` is passed). `Match.wc3statsGameId` enables Refresh via `replaceMatchRoster`. Discord remains the ranked authority.

**Tech Stack:** Node.js + TypeScript ESM, discord.js v14, Prisma, Vitest, Node `fetch`

**Spec:** [docs/superpowers/specs/2026-08-14-screenshotless-lobby-design.md](../specs/2026-08-14-screenshotless-lobby-design.md) — Phase 2 (route D)

**Depends on:** Phase 1 ([screenshot-optional-lobby](./2026-08-14-screenshot-optional-lobby.md)) so `/register_lobby` already works without `print`.

## Global Constraints

- User-facing strings in **English**
- Create-role unchanged
- Nick = `normalizeNick` of name, with `#digits` stripped; never persist `Name#1234`
- Bot slot = wc3stats `slots` index + 1; ignore `team` / `teamName`
- Empty-full (`slotsTaken > 0` && no occupied humans) must not wipe a non-empty Discord roster
- `WC3STATS_ENABLED` default false
- ESM `.js` imports
- Commits only when the user asks

## File structure

| File                                   | Responsibility                            |
| -------------------------------------- | ----------------------------------------- |
| `src/config/env.ts`                    | Parse wc3stats flags                      |
| `src/services/wc3stats-map.ts`         | Map allow / deny                          |
| `src/services/wc3stats-roster.ts`      | Detail → players + usability              |
| `src/services/wc3stats-client.ts`      | HTTP                                      |
| `src/services/wc3stats-resolve.ts`     | Pick lobby or fail closed                 |
| `src/services/lobby-actions.ts`        | `refreshLobbyFromWc3stats`                |
| `src/services/match-service.ts`        | Persist `wc3statsGameId`; duplicate check |
| `src/commands/lobby/register-lobby.ts` | Optional `wc3stats_id`; import path       |
| `src/services/lobby-preview.ts`        | Refresh button + source footer            |
| `src/handlers/lobby-interactions.ts`   | Route refresh                             |
| `prisma/schema.prisma`                 | `Match.wc3statsGameId`                    |
| Tests colocated `*.test.ts`            |                                           |

---

### Task 1: Map filter + nick strip (pure)

**Files:**

- Create: `src/services/wc3stats-map.ts`
- Create: `src/services/wc3stats-map.test.ts`
- Create: `src/services/wc3stats-roster.ts` (nick helper only first — or put nick in roster file from the start)
- Create: `src/services/wc3stats-roster.test.ts`

**Interfaces:**

- Produces:
  - `isUdbrMap(input: { map?: string; path?: string; normalizedName?: string; sha1?: string }, config: { pattern: RegExp; sha1Allowlist: Set<string> }): boolean`
  - `nickFromWc3statsPlayer(player: { name?: string | null; battleTag?: string | null }): string` (empty string if unusable)

- [ ] **Step 1: Write failing tests**

```ts
import { describe, expect, it } from 'vitest';
import { isUdbrMap } from './wc3stats-map.js';
import { nickFromWc3statsPlayer } from './wc3stats-roster.js';

const config = {
  pattern: /ultimate.?dragon.?ball.?reborn|udbr/i,
  sha1Allowlist: new Set<string>(['abc123']),
};

describe('isUdbrMap', () => {
  it('accepts UDBR-like filenames', () => {
    expect(isUdbrMap({ map: 'UltimateDragonBallReborn_v1.w3x' }, config)).toBe(true);
    expect(isUdbrMap({ normalizedName: 'Ultimate Dragon Ball Reborn' }, config)).toBe(true);
  });

  it('rejects Tribute and unrelated maps', () => {
    expect(isUdbrMap({ map: 'DBZ_Tribute_Elite_v2.1mb_slk.w3x' }, config)).toBe(false);
    expect(isUdbrMap({ map: 'DotA_v6_89Q.w3x' }, config)).toBe(false);
  });

  it('accepts sha1 allowlist even if the name is odd', () => {
    expect(isUdbrMap({ map: 'weird.w3x', sha1: 'abc123' }, config)).toBe(true);
  });
});

describe('nickFromWc3statsPlayer', () => {
  it('uses name and strips battle tag discriminator', () => {
    expect(nickFromWc3statsPlayer({ name: 'Goku', battleTag: 'Goku#1234' })).toBe('goku');
    expect(nickFromWc3statsPlayer({ name: null, battleTag: 'Vegeta#99' })).toBe('vegeta');
  });

  it('returns empty for missing player fields', () => {
    expect(nickFromWc3statsPlayer({})).toBe('');
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL (modules missing)**

Run: `npx vitest run src/services/wc3stats-map.test.ts src/services/wc3stats-roster.test.ts`

- [ ] **Step 3: Implement**

`wc3stats-map.ts`:

```ts
export interface Wc3statsMapInput {
  map?: string;
  path?: string;
  normalizedName?: string;
  sha1?: string;
}

export interface Wc3statsMapConfig {
  pattern: RegExp;
  sha1Allowlist: Set<string>;
}

/** True when the lobby is Ultimate Dragon Ball Reborn (name regex or sha1 allowlist). */
export function isUdbrMap(input: Wc3statsMapInput, config: Wc3statsMapConfig): boolean {
  const sha1 = input.sha1?.trim().toLowerCase();
  if (sha1 && config.sha1Allowlist.has(sha1)) {
    return true;
  }

  const haystack = [input.map, input.path, input.normalizedName]
    .filter((value): value is string => typeof value === 'string' && value.trim() !== '')
    .join('\n');

  return haystack !== '' && config.pattern.test(haystack);
}
```

In `wc3stats-roster.ts` (nick helper):

```ts
import { normalizeNick } from './player-nick.js';

const TAG_SUFFIX = /^(.*)#\d+$/;

export function nickFromWc3statsPlayer(player: {
  name?: string | null;
  battleTag?: string | null;
}): string {
  const raw = (player.name ?? player.battleTag ?? '').trim();
  if (raw === '') {
    return '';
  }

  const stripped = TAG_SUFFIX.exec(raw)?.[1] ?? raw;
  return normalizeNick(stripped);
}
```

- [ ] **Step 4: Run tests — expect PASS**

---

### Task 2: Roster extraction + empty-full

**Files:**

- Modify: `src/services/wc3stats-roster.ts`
- Modify: `src/services/wc3stats-roster.test.ts`

**Interfaces:**

- Produces:
  - `export type Wc3statsSlot = { status?: string; isComputer?: boolean; isObserver?: boolean; player?: { name?: string | null; battleTag?: string | null } | null }`
  - `export type Wc3statsRosterResult = { usable: boolean; players: LobbyPlayer[]; occupiedCount: number }`
  - `export function extractWc3statsRoster(detail: { numPlayers?: number; slots?: Wc3statsSlot[] }): Wc3statsRosterResult`

- [ ] **Step 1: Add failing tests**

```ts
import { extractWc3statsRoster } from './wc3stats-roster.js';

describe('extractWc3statsRoster', () => {
  it('maps occupied humans to slot = index + 1', () => {
    const result = extractWc3statsRoster({
      numPlayers: 2,
      slots: [
        { status: 'occupied', player: { name: 'Alice' } },
        { status: 'open', player: null },
        { status: 'occupied', isComputer: true, player: { name: 'Comp' } },
        { status: 'occupied', player: { name: 'Bob' } },
      ],
    });
    expect(result.usable).toBe(true);
    expect(result.players).toEqual([
      { slot: 1, nick: 'alice' },
      { slot: 4, nick: 'bob' },
    ]);
  });

  it('treats empty slots with numPlayers > 0 as unusable', () => {
    const result = extractWc3statsRoster({ numPlayers: 10, slots: [] });
    expect(result.usable).toBe(false);
    expect(result.players).toEqual([]);
  });

  it('treats all-open slots with numPlayers > 0 as unusable', () => {
    const result = extractWc3statsRoster({
      numPlayers: 5,
      slots: [{ status: 'open' }, { status: 'open' }],
    });
    expect(result.usable).toBe(false);
    expect(result.players).toEqual([]);
  });

  it('allows truly empty lobbies (host only not yet observed, numPlayers 0)', () => {
    const result = extractWc3statsRoster({ numPlayers: 0, slots: [] });
    expect(result.usable).toBe(true);
    expect(result.players).toEqual([]);
  });
});
```

- [ ] **Step 2: Run — expect FAIL on `extractWc3statsRoster`**

- [ ] **Step 3: Implement extraction**

Rules:

- Iterate `slots` with index `i`; bot slot = `i + 1`; skip slot > 12.
- Occupied human: `status === 'occupied' && !isComputer && !isObserver` and nick non-empty.
- `occupiedCount` = number of extracted players.
- `usable = occupiedCount > 0 || (numPlayers ?? 0) === 0`
- Duplicate nicks: skip later duplicates (log), do not throw here; `createPendingMatch` still asserts uniqueness if they slip through — prefer dropping duplicates in extract to avoid hard-failing the command.

- [ ] **Step 4: Run tests — PASS**

---

### Task 3: Env + HTTP client

**Files:**

- Modify: `src/config/env.ts`
- Modify: `.env.example`
- Modify: `.cursor/rules/scripts-and-env.mdc`
- Create: `src/services/wc3stats-client.ts`
- Create: `src/services/wc3stats-client.test.ts`

**Interfaces:**

- Produces:
  - `env.wc3statsEnabled: boolean` (default false)
  - `env.wc3statsMapPattern: string` (default `ultimate.?dragon.?ball.?reborn|udbr`)
  - `env.wc3statsMapSha1: string[]`
  - `env.wc3statsTimeoutMs: number` (default 4000)
  - `fetchGamelist(): Promise<Wc3statsListGame[]>`
  - `fetchGameDetail(id: number): Promise<Wc3statsGameDetail>`
  - `export class Wc3statsClientError extends Error`

- [ ] **Step 1: Tests with mocked `fetch`**

Use `vi.stubGlobal('fetch', ...)`.

- Timeout / non-OK → `Wc3statsClientError`
- 200 list → parse `body` array
- 200 detail → parse `body` object

- [ ] **Step 2: Implement client**

```ts
const LIST_URL = 'https://api.wc3stats.com/gamelist';

export async function fetchGamelist(timeoutMs: number): Promise<Wc3statsListGame[]> {
  const body = await getJson(LIST_URL, timeoutMs);
  if (!body || !Array.isArray(body.body) && !Array.isArray(body)) {
    // accept either { body: [] } wrapper or raw array
  }
  ...
}
```

Use `AbortSignal.timeout(timeoutMs)` (Node 22 on the EC2 host).

Parse list items: `{ id, name, host, map, slotsTaken, slotsTotal, server }`. Host on the list is a string battleTag.

Detail: `{ id, name, host: { battleTag, name }, map: { path, normalizedName, sha1, name }, numPlayers, numSlots, slots }`.

- [ ] **Step 3: Parse env**

```ts
wc3statsEnabled: parseBoolean(process.env.WC3STATS_ENABLED, false),
wc3statsMapPattern: process.env.WC3STATS_MAP_PATTERN?.trim() || 'ultimate.?dragon.?ball.?reborn|udbr',
wc3statsMapSha1: (process.env.WC3STATS_MAP_SHA1 ?? '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean),
wc3statsTimeoutMs: Number.parseInt(process.env.WC3STATS_TIMEOUT_MS ?? '4000', 10) || 4000,
```

Invalid regex at runtime: compile in `getWc3statsMapConfig()` and throw a clear English `MatchServiceError` only when enabled and used.

---

### Task 4: Resolver (fail closed)

**Files:**

- Create: `src/services/wc3stats-resolve.ts`
- Create: `src/services/wc3stats-resolve.test.ts`

**Interfaces:**

- Produces:
  - `export type ResolveWc3statsLobbyInput = { wc3statsId?: number | null; hostNick?: string | null; games: Wc3statsListGame[]; mapConfig: Wc3statsMapConfig }`
  - `export type ResolveWc3statsLobbyResult = { ok: true; game: Wc3statsListGame } | { ok: false; code: 'not_found' | 'ambiguous' | 'not_udbr'; message: string; candidates: Wc3statsListGame[] }`
  - `resolveWc3statsLobby(input): ResolveWc3statsLobbyResult`

- [ ] **Step 1: Tests**

- Explicit id found + UDBR → ok
- Explicit id found + Tribute → `not_udbr`
- Explicit id missing from list → `not_found` (detail fetch later can still work; resolver on list may return not_found — **decision:** if `wc3statsId` is set, skip list filter and let detail fetch decide map. Document this in the function: explicit id bypasses list.)

Lock: **explicit `wc3stats_id` skips the list** and goes straight to `fetchGameDetail`. Resolver on list is only for auto-pick.

Auto-pick tests:

- Zero UDBR games → `not_found`
- One UDBR → ok
- Two UDBR → `ambiguous` unless `hostNick` matches exactly one host (compare `normalizeNick` of host name / battleTag stripped)
- Two UDBR same host → still `ambiguous`

- [ ] **Step 2: Implement**

Messages from the spec failure-copy table.

- [ ] **Step 3: Tests PASS**

---

### Task 5: Prisma field

**Files:**

- Modify: `prisma/schema.prisma`
- Create: Prisma migration via `npm run db:migrate`

**Interfaces:**

- Produces: `Match.wc3statsGameId String?` with `@@index([wc3statsGameId])`

- [ ] **Step 1: Add field to schema** (no `@unique`)

- [ ] **Step 2: Create migration**

Run: `npx prisma migrate dev --name match_wc3stats_game_id`

Expected: migration SQL adds nullable column + index.

- [ ] **Step 3: `npx prisma generate`**

---

### Task 6: Persist game id + duplicate PENDING

**Files:**

- Modify: `src/services/match-service.ts`
- Create or modify: `src/services/match-service` tests if a focused test file exists; otherwise add `src/services/wc3stats-match.test.ts` that tests a small exported helper to avoid heavy Prisma mocking.

Prefer a helper:

```ts
export async function findActiveMatchByWc3statsGameId(
  wc3statsGameId: string,
): Promise<MatchWithPlayers | null>;
```

`createPendingMatch` input gains optional `wc3statsGameId?: string | null`.

If set:

1. `findActiveMatchByWc3statsGameId` where status in `PENDING | IN_PROGRESS`
2. If found, throw `MatchServiceError` with `That Warcraft lobby is already registered as match ${id}.`
3. Else store the id on create

- [ ] **Step 1: Extend `CreatePendingMatchInput`**

- [ ] **Step 2: Duplicate check inside the transaction** (avoid races)

```ts
const existing = await tx.match.findFirst({
  where: { wc3statsGameId: input.wc3statsGameId, status: { in: ['PENDING', 'IN_PROGRESS'] } },
});
```

- [ ] **Step 3: Pass the field through `tx.match.create`**

---

### Task 7: Wire `/register_lobby`

**Files:**

- Modify: `src/commands/lobby/register-lobby.ts`
- Modify: `src/services/register-lobby-source.ts` (add wc3stats kind)
- Modify: `src/services/register-lobby-source.test.ts`

**Interfaces:**

- Slash: optional string `wc3stats_id`
- Resolution order:
  1. If `print` image → OCR (ignore wc3stats for player extract; still may store id if also passed)
  2. Else if `WC3STATS_ENABLED` and (`wc3stats_id` or auto-resolve) → import
  3. Else empty

**Lock:** Screenshot wins over wc3stats for the roster. If both `print` and `wc3stats_id` are passed: OCR players, still attach `wc3statsGameId` for Refresh.

- [ ] **Step 1: Extend source helper tests** for `wc3stats_id` vs screenshot vs empty

- [ ] **Step 2: Command flow after create-role**

```text
defer already done
parse wc3stats_id (integer; invalid → English error)
if screenshot: players = OCR
else if env.wc3statsEnabled:
  try import
    on client error → players = [], no game id, log warn
    on not_udbr / not_found / ambiguous / unavailable → create empty Discord lobby (no game id); Refresh can attach later
    on usable roster → players = result.players
    on unusable roster → players = [], keep game id
else: players = []
createPendingMatch({ ..., wc3statsGameId })
embed; if unusable, description already covers add-players; add footer "Source: wc3stats (roster pending)"
```

A live wc3stats lobby is **not** required to create a Discord match. Ambiguous/not_found/not_udbr/client-down all create empty PENDING. Auto-import without `wc3stats_id` only attaches when the host's linked nick is in a live UDBR lobby.

- [ ] **Step 3: Deploy commands on next bot restart**

---

### Task 8: Refresh use-case + button

**Files:**

- Modify: `src/services/lobby-actions.ts`
- Modify: `src/services/lobby-preview.ts`
- Modify: `src/handlers/lobby-interactions.ts`
- Create: `src/services/lobby-actions-wc3stats.test.ts` for the empty-full keep-roster rule (pure function)

**Interfaces:**

- Produces:
  - `export function applyWc3statsRefresh(current: LobbyPlayer[], incoming: Wc3statsRosterResult): { players: LobbyPlayer[]; keptExisting: boolean }`
  - `export async function refreshLobbyFromWc3stats(input: { client; hostDiscordId; matchId?: string | null; memberRoleIds: string[]; matchModRoleId?: string }): Promise<LobbyActionResult>`
  - `LOBBY_CUSTOM_IDS.refresh = 'lobby:refresh'`

- [ ] **Step 1: Tests for `applyWc3statsRefresh`**

```ts
it('replaces when incoming is usable', () => { ... });
it('keeps current when incoming is unusable and current is non-empty', () => { ... });
it('keeps empty when both empty', () => { ... });
```

- [ ] **Step 2: Implement apply + refresh**

Refresh:

- Resolve PENDING match (host or `assertCanManageMatch` with mod role — **host or mod**, same as start? Spec: host/mod. Use `assertCanManageMatch` which already allows host + mod.)
- If `!match.wc3statsGameId` throw `This lobby is not linked to a Warcraft game list entry.`
- Debounce: in-memory `Map<matchId, lastRefreshMs>` in the module (15_000 ms). Throw wait message.
- Fetch detail; map check; extract; apply; `replaceMatchRoster` only when players actually change **or** when usable (always replace on usable).
- `syncLobbyDiscordMessage`

- [ ] **Step 3: Button**

Show Refresh when `options.wc3statsGameId` is set and not locked.

Put it on the Start row if Start is visible, else its own row (Discord max 5 buttons/row). Label: `Refresh`. Emoji: `🔄`. Style: Secondary.

- [ ] **Step 4: Handler**

Parse `lobby:refresh` like other lobby buttons; call `refreshLobbyFromWc3stats`; ephemeral `Lobby updated.` or the kept-existing warning.

---

### Task 9: Embed source line

**Files:**

- Modify: `src/services/lobby-preview.ts`
- Modify: `src/services/lobby-preview.test.ts` if embed description is asserted

When `wc3statsGameId` is set, append to description:

- usable/filled: `Source: wc3stats`
- empty players: `wc3stats has not published the player list yet. Use Refresh, a screenshot, or add players.`

Do not mention raw API JSON.

---

### Task 10: Feature-flag default and operator docs

**Files:**

- `.env.example`
- `.cursor/rules/scripts-and-env.mdc`
- `infra/aws` only if you already inject env via SSM — **do not** add Terraform vars in this task unless `user-data` must list every key. Prefer documenting the vars; operators add them to `.env` / SSM manually.

Leave `WC3STATS_ENABLED=false` until a live UDBR lobby confirms `map.path` / sha1. Log those fields at `info` when a detail is fetched and the map is rejected, so the allowlist can be updated.

---

## Rollback

Set `WC3STATS_ENABLED=false`. Screenshot-optional Phase 1 still works. Nullable `wc3statsGameId` can stay.

## Done when

- With flag off: behavior is Phase 1.
- With flag on + usable detail: roster imported, Refresh works.
- Empty-full never clears a manual roster.
- Tribute maps never import.
- Duplicate PENDING for the same game id is rejected.
