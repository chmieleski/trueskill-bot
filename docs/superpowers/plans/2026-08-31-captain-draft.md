# Captain Draft Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Standalone mod-run captain snake draft with live public embed, captain pick UI, post-draft per-team leaderboard-style embeds, captain/mod roster management, and persistent Discord message sync.

**Architecture:** Postgres `CaptainDraft` + JSON `DraftState`; pure draft logic in `src/services/captain-draft/`; thin `/captain_draft` slash adapter and `cdraft:` button/select handlers. Mod actions and captain picks share the same use-cases; embed refresh centralized in `draft-display-sync.ts`.

**Tech Stack:** TypeScript ESM, Prisma, discord.js v14, Vitest

**Spec:** `docs/superpowers/specs/2026-08-31-captain-draft-design.md`

## Global Constraints

- Scope: `general` — standalone; no lobby/match coupling in v1
- English-only user-facing strings, command names, descriptions, and errors
- Match moderators only for setup, publish, cancel, and all mod subcommands (`assertHasMatchModRole`)
- Current captain only for `pick`; team captain only for `rename` (discord-linked captains)
- ESM imports use `.js` extension; named exports; Prisma singleton from `src/lib/prisma.ts`
- No new production env / SSM keys
- Run `npm run format:check` before PR; conventional commit messages
- Shared domain logic: slash + interactions call the same service functions

## File map

| File                                                          | Role                                             |
| ------------------------------------------------------------- | ------------------------------------------------ |
| `prisma/schema.prisma`                                        | `CaptainDraft`, `CaptainDraftDisplay`            |
| `prisma/migrations/…_captain_draft/`                          | Migration SQL                                    |
| `src/services/captain-draft/draft-types.ts`                   | `DraftState`, `DraftParticipant`, errors         |
| `src/services/captain-draft/draft-logic.ts`                   | Snake math, shuffle, pick/undo/swap/move         |
| `src/services/captain-draft/draft-logic.test.ts`              | Pure logic tests                                 |
| `src/services/captain-draft/draft-resolve.ts`                 | Parse players string, nick → discordId           |
| `src/services/captain-draft/draft-resolve.test.ts`            | Resolver tests                                   |
| `src/services/captain-draft/draft-state.ts`                   | DB load/save, find active by channel             |
| `src/services/captain-draft/draft-auth.ts`                    | Mod/captain/turn guards                          |
| `src/services/captain-draft/draft-live-embed.ts`              | ACTIVE embed + pick button                       |
| `src/services/captain-draft/draft-team-embed.ts`              | Post-draft per-team embeds                       |
| `src/services/captain-draft/draft-display-sync.ts`            | Publish/refresh Discord messages                 |
| `src/services/captain-draft/draft-mod-actions.ts`             | Mod use-cases + embed side effects               |
| `src/services/captain-draft/draft-actions.ts`                 | Core flow: start, set lists, begin, pick, cancel |
| `src/services/captain-draft/index.ts`                         | Re-exports                                       |
| `src/commands/captain-draft/captain-draft.ts`                 | Slash command + autocomplete                     |
| `src/commands/captain-draft/captain-draft.test.ts`            | Slash builder tests                              |
| `src/discord/interactions/captain-draft-interactions.ts`      | Pick button + select                             |
| `src/discord/interactions/captain-draft-interactions.test.ts` | Interaction tests                                |
| `src/events/interaction-create.ts`                            | Route `cdraft:` handler                          |

---

### Task 1: Schema + draft types

**Files:**

- Modify: `prisma/schema.prisma`
- Create: `src/services/captain-draft/draft-types.ts`
- Create: migration via `npm run db:migrate -- --name captain_draft`

**Interfaces:**

- Produces:
  - `CaptainDraftError` class
  - `DraftParticipant`, `DraftTeam`, `DraftState` types
  - `CaptainDraftStatus` union: `'SETUP' | 'ACTIVE' | 'COMPLETE' | 'CANCELLED'`
  - Prisma models (see spec)

- [ ] **Step 1: Add Prisma models**

```prisma
model CaptainDraft {
  id              String   @id @default(cuid())
  guildId         String
  channelId       String
  hostDiscordId   String
  leagueId        String?
  status          String
  state           Json
  draftMessageId  String?
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  display CaptainDraftDisplay?

  @@index([guildId, channelId, status])
  @@index([guildId, status])
}

model CaptainDraftDisplay {
  id         String   @id @default(cuid())
  draftId    String   @unique
  channelId  String
  messageIds Json
  updatedAt  DateTime @updatedAt

  draft CaptainDraft @relation(fields: [draftId], references: [id], onDelete: Cascade)
}
```

- [ ] **Step 2: Create `draft-types.ts`**

```typescript
export type CaptainDraftStatus = 'SETUP' | 'ACTIVE' | 'COMPLETE' | 'CANCELLED';

export type DraftParticipant = {
  key: string;
  label: string;
  discordId?: string;
};

export type DraftTeam = {
  captainKey: string;
  displayName: string;
  roster: DraftParticipant[];
  pickOrderIndex: number;
};

export type DraftState = {
  captains: DraftParticipant[];
  memberPool: DraftParticipant[];
  pickOrder: number[];
  teams: DraftTeam[];
  pickIndex: number;
};

export class CaptainDraftError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CaptainDraftError';
  }
}

export function emptyDraftState(): DraftState {
  return { captains: [], memberPool: [], pickOrder: [], teams: [], pickIndex: 0 };
}
```

- [ ] **Step 3: Migrate and generate**

```bash
npm run db:migrate -- --name captain_draft
npm run db:generate
```

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma prisma/migrations src/services/captain-draft/draft-types.ts
git commit -m "feat(captain-draft): add schema and draft state types"
```

---

### Task 2: Pure draft logic (snake, pick, undo, swap, move)

**Files:**

- Create: `src/services/captain-draft/draft-logic.ts`
- Create: `src/services/captain-draft/draft-logic.test.ts`

**Interfaces:**

- Consumes: `DraftState`, `DraftParticipant`, `CaptainDraftError` from `draft-types.ts`
- Produces:
  - `shufflePickOrder(count: number, rng?: () => number): number[]`
  - `captainIndexForPick(pickIndex: number, captainCount: number): number`
  - `buildTeamsFromCaptains(captains: DraftParticipant[], pickOrder: number[]): DraftTeam[]`
  - `applyPick(state: DraftState, participantKey: string): DraftState`
  - `undoLastPick(state: DraftState): DraftState`
  - `addToPool(state: DraftState, player: DraftParticipant): DraftState`
  - `removeFromPool(state: DraftState, participantKey: string): DraftState`
  - `addToTeam(state: DraftState, participantKey: string, captainKey: string): DraftState`
  - `removeFromTeam(state: DraftState, participantKey: string): DraftState`
  - `swapParticipants(state: DraftState, keyA: string, keyB: string): DraftState`
  - `moveParticipant(state: DraftState, participantKey: string, toCaptainKey: string): DraftState`
  - `isDraftComplete(state: DraftState): boolean`
  - `currentCaptainKey(state: DraftState): string | null`
  - `findParticipant(state: DraftState, key: string): DraftParticipant | undefined`

- [ ] **Step 1: Write failing snake-order tests**

```typescript
import { describe, expect, it } from 'vitest';
import { captainIndexForPick, shufflePickOrder } from './draft-logic.js';

describe('captainIndexForPick', () => {
  it('snakes forward then reverse for 4 captains', () => {
    const n = 4;
    expect(captainIndexForPick(0, n)).toBe(0);
    expect(captainIndexForPick(3, n)).toBe(3);
    expect(captainIndexForPick(4, n)).toBe(3);
    expect(captainIndexForPick(7, n)).toBe(0);
    expect(captainIndexForPick(8, n)).toBe(0);
  });
});

describe('shufflePickOrder', () => {
  it('is deterministic with injected rng', () => {
    const rng = () => 0;
    expect(shufflePickOrder(3, rng)).toEqual([0, 2, 1]);
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL**

```bash
npm run test -- src/services/captain-draft/draft-logic.test.ts
```

- [ ] **Step 3: Implement `draft-logic.ts`**

Snake index:

```typescript
export function captainIndexForPick(pickIndex: number, captainCount: number): number {
  if (captainCount <= 0) return 0;
  const round = Math.floor(pickIndex / captainCount);
  const pos = pickIndex % captainCount;
  const forward = round % 2 === 0;
  return forward ? pos : captainCount - 1 - pos;
}
```

`applyPick`: remove from `memberPool`, append to correct team roster, increment `pickIndex`.

`undoLastPick`: decrement `pickIndex`, pop last non-captain from team that picked at `pickIndex`, push back to pool.

`swapParticipants`: locate both in pool or team rosters; exchange positions; error if either is a captain.

`moveParticipant`: remove from current location, append to target team (not captain slot).

- [ ] **Step 4: Add pick/undo/swap/move tests and run until green**

```bash
npm run test -- src/services/captain-draft/draft-logic.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/services/captain-draft/draft-logic.ts src/services/captain-draft/draft-logic.test.ts
git commit -m "feat(captain-draft): add snake draft pure logic"
```

---

### Task 3: Player string resolver (mentions + linked nicks)

**Files:**

- Create: `src/services/captain-draft/draft-resolve.ts`
- Create: `src/services/captain-draft/draft-resolve.test.ts`

**Interfaces:**

- Produces: `resolveParticipantsFromInput(input: { raw: string; gameId: string | null; guild: Guild }): Promise<DraftParticipant[]>`
- Uses `normalizeNick` pattern from match service; `prisma.player.findMany` with insensitive username OR

- [ ] **Step 1: Write failing resolver test** (mock prisma or use vi.mock)

Test cases: `@mention`, plain text, linked nick → discordId, dedupe.

- [ ] **Step 2: Implement resolver**

Split on commas; regex for `<@!?(\d+)>`; fetch member display name for mentions; batch nick lookup when `gameId` present.

- [ ] **Step 3: Run tests**

```bash
npm run test -- src/services/captain-draft/draft-resolve.test.ts
```

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(captain-draft): resolve mentions and linked nicks"
```

---

### Task 4: Draft state persistence

**Files:**

- Create: `src/services/captain-draft/draft-state.ts`

**Interfaces:**

- Produces:
  - `findActiveDraftForChannel(guildId: string, channelId: string): Promise<CaptainDraft | null>`
  - `parseDraftState(row: CaptainDraft): DraftState`
  - `saveDraftState(draftId: string, status: CaptainDraftStatus, state: DraftState, extra?: { draftMessageId?: string | null }): Promise<CaptainDraft>`
  - `createDraft(input: { guildId; channelId; hostDiscordId; leagueId? }): Promise<CaptainDraft>`

Active = status in `SETUP`, `ACTIVE`, `COMPLETE` (one per channel — query newest non-CANCELLED).

- [ ] **Step 1: Implement + unit test state parse/serialize round-trip**

- [ ] **Step 2: Commit**

```bash
git commit -m "feat(captain-draft): add draft persistence helpers"
```

---

### Task 5: Auth helpers

**Files:**

- Create: `src/services/captain-draft/draft-auth.ts`

**Interfaces:**

- Produces:
  - `assertCaptainDraftMod(interaction, guildConfig)`
  - `assertCurrentCaptainPick(state, actorDiscordId)`
  - `assertTeamCaptainRename(state, actorDiscordId, captainKey)`
  - `resolveModContext(interaction)` → `{ memberRoleIds, matchModRoleId }`

Wrap `assertHasMatchModRole` from `src/services/match/match-auth.ts`.

- [ ] **Step 1: Implement + small test for captain turn match**

- [ ] **Step 2: Commit**

---

### Task 6: Live + team embed builders

**Files:**

- Create: `src/services/captain-draft/draft-live-embed.ts`
- Create: `src/services/captain-draft/draft-team-embed.ts`
- Create: `src/services/captain-draft/draft-team-embed.test.ts`

**Interfaces:**

- Produces:
  - `buildLiveDraftEmbed(state: DraftState, status: CaptainDraftStatus): EmbedBuilder`
  - `buildLiveDraftComponents(draftId: string, status: CaptainDraftStatus): ActionRowBuilder[]`
  - `buildTeamRosterEmbeds(state: DraftState, completedAt: Date): EmbedBuilder[]`
  - `TEAM_EMBED_COLORS: number[]` — rotating palette (reuse `RANK_GOLD` style from leaderboard)

Team embed: title = `displayName`, description = captain line, field = monospace roster (`#` + player), footer on last embed.

Live embed: ON THE CLOCK team highlighted in field name; Available pool truncated if >1024 chars.

- [ ] **Step 1: Write team embed snapshot test**

- [ ] **Step 2: Implement builders**

- [ ] **Step 3: Run tests + commit**

```bash
git commit -m "feat(captain-draft): add live and team roster embeds"
```

---

### Task 7: Display sync (publish + refresh)

**Files:**

- Create: `src/services/captain-draft/draft-display-sync.ts`

**Interfaces:**

- Produces:
  - `syncLiveDraftMessage(client, draft: CaptainDraft): Promise<void>`
  - `publishTeamRosters(client, draft: CaptainDraft, channel: TextChannel): Promise<void>`
  - `refreshPublishedTeamsIfAny(client, draft: CaptainDraft): Promise<void>`

Chunk embeds: max 10 per message. Store/update `CaptainDraftDisplay.messageIds`. On edit failure (unknown message), re-send and update ids.

- [ ] **Step 1: Implement with best-effort error logging** (pattern from `leaderboard-channel.ts`)

- [ ] **Step 2: Commit**

---

### Task 8: Core draft actions

**Files:**

- Create: `src/services/captain-draft/draft-actions.ts`
- Create: `src/services/captain-draft/draft-mod-actions.ts`
- Create: `src/services/captain-draft/index.ts`

**Interfaces:**

- `startCaptainDraft`, `setCaptains`, `setMembers`, `beginCaptainDraft`, `applyCaptainDraftPick`, `cancelCaptainDraft`, `renameCaptainTeam`, `publishCaptainDraft`
- Mod: `modAddPlayer`, `modRemovePlayer`, `modSwapPlayers`, `modMovePlayer`, `modUndoPick`, `modForcePick`, `modRenameTeam`

Each mutating action: load draft → validate status → mutate state → save → `syncLiveDraftMessage` if ACTIVE → `refreshPublishedTeamsIfAny` if display exists.

`beginCaptainDraft`: shuffle `pickOrder`, build teams, set ACTIVE, send initial live message, store `draftMessageId`.

`applyCaptainDraftPick`: on complete pool → COMPLETE, remove pick button from live embed.

- [ ] **Step 1: Implement `draft-actions.ts`**

- [ ] **Step 2: Implement `draft-mod-actions.ts` delegating to `draft-logic.ts`**

- [ ] **Step 3: Export from `index.ts`**

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(captain-draft): add core and mod draft actions"
```

---

### Task 9: Slash command `/captain_draft`

**Files:**

- Create: `src/commands/captain-draft/captain-draft.ts`
- Create: `src/commands/captain-draft/captain-draft.test.ts`

**Subcommands to register:**

`start`, `captains`, `members`, `begin`, `pick`, `rename`, `rename_team`, `publish`, `cancel`, `add`, `remove`, `swap`, `move`, `undo`, `force_pick`

Options:

- `players` string on `captains` / `members`
- `player` string with autocomplete on `pick`, `add`, `remove`, `force_pick`, `move`, `swap`
- `player_a`, `player_b` on `swap`
- `team` string autocomplete on `move`, `rename_team`, `add` (when COMPLETE)
- `name` on `rename` / `rename_team`
- `channel` on `publish`

Autocomplete handler: pool players + team names + roster players from active channel draft.

Pattern: defer ephemeral for mod commands; `begin` posts public message; errors → ephemeral `CaptainDraftError.message`.

- [ ] **Step 1: Write slash data test** (subcommand names exist)

- [ ] **Step 2: Implement execute router**

Resolve league from channel via `resolveLeagueContext`. Load guild config for mod checks.

- [ ] **Step 3: Run typecheck**

```bash
npm run typecheck
npm run test -- src/commands/captain-draft/captain-draft.test.ts
```

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(captain-draft): add slash command with mod subcommands"
```

---

### Task 10: Pick button + select interactions

**Files:**

- Create: `src/discord/interactions/captain-draft-interactions.ts`
- Create: `src/discord/interactions/captain-draft-interactions.test.ts`
- Modify: `src/events/interaction-create.ts` — register before lobby handler

**Custom IDs:**

- `cdraft:pick_btn:{draftId}`
- `cdraft:pick_sel:{draftId}:{page}`

Flow:

1. Button → ephemeral select (pool page 0, max 25)
2. Select → `applyCaptainDraftPick` → edit live message → ephemeral ack
3. Validate current captain on both steps

Use `sendReplacingEphemeral` from `src/lib/ephemeral-reply.ts`.

- [ ] **Step 1: Implement handler + test custom id routing**

- [ ] **Step 2: Wire in `interaction-create.ts`**

- [ ] **Step 3: Commit**

```bash
git commit -m "feat(captain-draft): add pick button and select handler"
```

---

### Task 11: End-to-end verification

- [ ] **Step 1: Format**

```bash
npm run format:check
npm run format
npm run format:check
```

- [ ] **Step 2: Full test suite**

```bash
npm run typecheck
npm run test
```

- [ ] **Step 3: Manual smoke checklist**

1. Mod `/captain_draft start`
2. `/captain_draft captains` with mix of @mentions and nicks
3. `/captain_draft members` with pool
4. `/captain_draft begin` — live embed appears
5. Captain picks via button + mod `force_pick`
6. Mod `undo`, `swap`, `add` late player
7. Draft completes
8. Mod `/captain_draft publish`
9. Captain `/captain_draft rename` — published embeds update
10. Mod `/captain_draft rename_team`, `move`, `remove`

---

## Spec self-review

| Spec requirement                                     | Task    |
| ---------------------------------------------------- | ------- |
| DB persistence                                       | 1       |
| Mod-only setup                                       | 5, 9    |
| Snake draft                                          | 2, 8    |
| Select + slash pick                                  | 9, 10   |
| Nick → mention                                       | 3       |
| Explicit begin                                       | 8, 9    |
| Live embed                                           | 6, 7    |
| Per-team publish embeds                              | 6, 7    |
| Captain rename                                       | 8, 9    |
| Mod add/remove/swap/move/undo/force_pick/rename_team | 2, 8, 9 |
| Always update published messages                     | 7, 8    |
| Interaction prefix `cdraft:`                         | 10      |
| English-only                                         | all     |

No placeholders remain in task steps above.
