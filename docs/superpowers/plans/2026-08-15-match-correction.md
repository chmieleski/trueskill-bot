# Match Correction (Flip / Void) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let match mods flip the winner (and quitters) or void a completed match within 24 hours by restoring pre-apply OpenSkill snapshots and re-applying or clearing results.

**Architecture:** Persist `Match.completedAt` and per-entity `MatchRatingSnapshot` rows inside `completeMatch` before rating writes. Shared use-cases in `match-correction.ts` power `/match flip`, `/match void`, and Confirm/Cancel buttons. Restore snapshots, then either re-run existing `applyQuitterPenalties` + `applyMatchRatings` (flip) or clear results and set `CANCELLED` (void).

**Tech Stack:** TypeScript ESM, Prisma, discord.js v14, Vitest, OpenSkill (existing `rating-update`)

**Spec:** `docs/superpowers/specs/2026-08-15-match-correction-design.md`

## Global Constraints

- Scope: `general` (match status + OpenSkill apply shell; not game-specific)
- English-only user-facing strings and errors
- Auth: **`assertHasMatchModRole` only** — host cannot flip/void
- Window: `completedAt` present and `now - completedAt ≤ 24 hours`
- Later completed matches: warn on confirm only; do not recalculate them
- Snapshots written **once** on first complete; never replaced by flip
- Missing/incomplete snapshots → reject
- ESM imports use `.js` extension; named exports
- Shared domain logic in services; thin Discord adapters
- No new production env / SSM keys

## File map

| File                                                             | Role                                                          |
| ---------------------------------------------------------------- | ------------------------------------------------------------- |
| `prisma/schema.prisma`                                           | `completedAt`, `MatchRatingSnapshot`, `MatchRatingEntityKind` |
| `prisma/migrations/…_match_correction_snapshots/`                | Migration SQL                                                 |
| `src/services/match/match-report.ts`                             | Write snapshots + `completedAt` on complete                   |
| `src/services/match/match-correction.ts`                         | Eligibility, snapshot I/O, flip/void, customId helpers        |
| `src/services/match/match-correction.test.ts`                    | Unit tests                                                    |
| `src/services/match/index.ts`                                    | Re-exports                                                    |
| `src/services/lobby/discord-sync.ts`                             | Optional cancel reason for void                               |
| `src/commands/match/match.ts`                                    | `flip` / `void` subcommands → confirm UI                      |
| `src/commands/match/match.test.ts`                               | Subcommand registration                                       |
| `src/discord/interactions/match-correction-interactions.ts`      | Confirm/Cancel buttons                                        |
| `src/discord/interactions/match-correction-interactions.test.ts` | Button routing tests                                          |
| `src/events/interaction-create.ts`                               | Route correction buttons                                      |
| `docs/discord/staff/a2-mod-powers.md`                            | Staff docs                                                    |
| `docs/discord/staff/a5-admin-cheat-sheet.md`                     | Cheat sheet                                                   |
| `docs/discord/public/05-play-and-finish.md`                      | Flag wrong reports to mods                                    |

---

### Task 1: Schema + migration

**Files:**

- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260815220000_match_correction_snapshots/migration.sql` (or `npx prisma migrate dev --name match_correction_snapshots`)

**Interfaces:**

- Produces:
  - `Match.completedAt DateTime?`
  - `enum MatchRatingEntityKind { GLOBAL HERO }`
  - `model MatchRatingSnapshot` with `@@unique([matchId, playerId, entityKind, heroId])`
  - Relations: `Match.ratingSnapshots`, `Player.ratingSnapshots`

- [ ] **Step 1: Extend Prisma schema**

On `Match`, after `leagueId`:

```prisma
  completedAt      DateTime?
  ratingSnapshots  MatchRatingSnapshot[]
```

Add index (optional but useful):

```prisma
  @@index([leagueId, completedAt])
```

On `Player`, add:

```prisma
  ratingSnapshots MatchRatingSnapshot[]
```

After `MatchPlayer` (or near Match), add:

```prisma
enum MatchRatingEntityKind {
  GLOBAL
  HERO
}

model MatchRatingSnapshot {
  id            String                @id @default(cuid())
  matchId       String
  playerId      String
  entityKind    MatchRatingEntityKind
  /// For GLOBAL use sentinel `0`. For HERO use the slot hero id (1–12 for UDBR).
  heroId        Int
  mu            Float
  sigma         Float
  matchesPlayed Int?
  createdAt     DateTime              @default(now())

  match  Match  @relation(fields: [matchId], references: [id], onDelete: Cascade)
  player Player @relation(fields: [playerId], references: [id], onDelete: Cascade)

  @@unique([matchId, playerId, entityKind, heroId])
  @@index([matchId])
}
```

- [ ] **Step 2: Create migration SQL**

```sql
ALTER TABLE "Match" ADD COLUMN "completedAt" TIMESTAMP(3);

CREATE INDEX "Match_leagueId_completedAt_idx" ON "Match"("leagueId", "completedAt");

CREATE TYPE "MatchRatingEntityKind" AS ENUM ('GLOBAL', 'HERO');

CREATE TABLE "MatchRatingSnapshot" (
    "id" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "entityKind" "MatchRatingEntityKind" NOT NULL,
    "heroId" INTEGER NOT NULL,
    "mu" DOUBLE PRECISION NOT NULL,
    "sigma" DOUBLE PRECISION NOT NULL,
    "matchesPlayed" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MatchRatingSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MatchRatingSnapshot_matchId_playerId_entityKind_heroId_key"
  ON "MatchRatingSnapshot"("matchId", "playerId", "entityKind", "heroId");
CREATE INDEX "MatchRatingSnapshot_matchId_idx" ON "MatchRatingSnapshot"("matchId");

ALTER TABLE "MatchRatingSnapshot"
  ADD CONSTRAINT "MatchRatingSnapshot_matchId_fkey"
  FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MatchRatingSnapshot"
  ADD CONSTRAINT "MatchRatingSnapshot_playerId_fkey"
  FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;
```

- [ ] **Step 3: Generate client**

Run: `npx prisma generate`  
Expected: client includes `matchRatingSnapshot` and `completedAt`.

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260815220000_match_correction_snapshots
git commit -m "$(cat <<'EOF'
feat(db): add match completedAt and rating snapshots

EOF
)"
```

---

### Task 2: Write snapshots on complete

**Files:**

- Modify: `src/services/match/match-report.ts`
- Create: helpers may live in `match-correction.ts` and be imported (prefer writing `writeMatchRatingSnapshots` there first, then call from complete — if Task 3 not done yet, put a minimal private helper in match-report and move in Task 3; **preferred:** implement `writeMatchRatingSnapshots` in Task 3 first, or do Tasks 2–3 as one agent pass with Task 3 module created before completeMatch wiring)

**Recommended order within this task:** create `match-correction.ts` with snapshot write/restore + constants only; wire complete; leave flip/void for Task 3.

**Interfaces:**

- Produces: `writeMatchRatingSnapshots(leagueId, matchId, players, tx): Promise<void>`
- Consumes: existing `completeMatch` transaction client
- Constant: `GLOBAL_SNAPSHOT_HERO_ID = 0`

- [ ] **Step 1: Add snapshot writer**

In `src/services/match/match-correction.ts`:

```typescript
import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { MatchServiceError } from './match-service.js';

export const CORRECTION_WINDOW_MS = 24 * 60 * 60 * 1000;
export const GLOBAL_SNAPSHOT_HERO_ID = 0;

type Db = Prisma.TransactionClient | typeof prisma;

type SnapshotPlayer = {
  playerId: string;
  heroId: number;
};

/**
 * Persist pre-apply μ/σ (and hero matchesPlayed) for every roster player.
 * Call once before OpenSkill writes on first complete. Idempotent reject if any rows exist.
 */
export async function writeMatchRatingSnapshots(
  leagueId: string,
  matchId: string,
  players: SnapshotPlayer[],
  db: Db = prisma,
): Promise<void> {
  const existing = await db.matchRatingSnapshot.count({ where: { matchId } });
  if (existing > 0) {
    throw new MatchServiceError('Rating snapshots already exist for this match.');
  }

  const playerIds = players.map((p) => p.playerId);
  const [globals, heroes] = await Promise.all([
    db.playerRating.findMany({ where: { leagueId, playerId: { in: playerIds } } }),
    db.playerHeroRating.findMany({
      where: {
        leagueId,
        OR: players.map((p) => ({ playerId: p.playerId, heroId: p.heroId })),
      },
    }),
  ]);

  const globalByPlayer = new Map(globals.map((row) => [row.playerId, row]));
  const heroByKey = new Map(heroes.map((row) => [`${row.playerId}:${row.heroId}`, row]));

  const rows = players.flatMap((player) => {
    const global = globalByPlayer.get(player.playerId);
    const hero = heroByKey.get(`${player.playerId}:${player.heroId}`);
    if (!global || !hero) {
      throw new MatchServiceError('Cannot snapshot ratings: missing player or hero rating rows.');
    }
    return [
      {
        matchId,
        playerId: player.playerId,
        entityKind: 'GLOBAL' as const,
        heroId: GLOBAL_SNAPSHOT_HERO_ID,
        mu: global.mu,
        sigma: global.sigma,
        matchesPlayed: null,
      },
      {
        matchId,
        playerId: player.playerId,
        entityKind: 'HERO' as const,
        heroId: player.heroId,
        mu: hero.mu,
        sigma: hero.sigma,
        matchesPlayed: hero.matchesPlayed,
      },
    ];
  });

  await db.matchRatingSnapshot.createMany({ data: rows });
}
```

Ensure `ensurePlayerRatings` still runs **before** snapshot write inside complete (today apply paths call ensure). Snapshot after ensure, before apply:

In `completeMatch`, after building `entries` / asserting teams, before applying ratings:

```typescript
await ensurePlayerRatings(
  match.leagueId,
  match.players.map((p) => ({ playerId: p.playerId, heroId: p.heroId })),
  tx,
);
// Or rely on apply* ensure — but snapshot needs rows present first.
await writeMatchRatingSnapshots(
  match.leagueId,
  matchId,
  match.players.map((p) => ({ playerId: p.playerId, heroId: p.heroId })),
  tx,
);
```

Import `ensurePlayerRatings` from rating-preview if not already used in match-report.

Update match status write:

```typescript
await tx.match.update({
  where: { id: matchId },
  data: { status: 'COMPLETED', completedAt: new Date() },
});
```

- [ ] **Step 2: Unit test snapshot shape helpers**

Add `src/services/match/match-correction.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { CORRECTION_WINDOW_MS, GLOBAL_SNAPSHOT_HERO_ID } from './match-correction.js';

describe('match correction constants', () => {
  it('uses a 24h window', () => {
    expect(CORRECTION_WINDOW_MS).toBe(24 * 60 * 60 * 1000);
  });

  it('uses heroId sentinel 0 for GLOBAL rows', () => {
    expect(GLOBAL_SNAPSHOT_HERO_ID).toBe(0);
  });
});
```

Run: `npm test -- src/services/match/match-correction.test.ts`  
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/services/match/match-correction.ts src/services/match/match-correction.test.ts src/services/match/match-report.ts src/services/match/index.ts
git commit -m "$(cat <<'EOF'
feat(match): snapshot ratings on complete

EOF
)"
```

Export `writeMatchRatingSnapshots` from `index.ts` only if other packages need it; otherwise keep internal and export flip/void APIs in Task 3.

---

### Task 3: Correction use-cases (assert, restore, flip, void, later-match warn)

**Files:**

- Modify: `src/services/match/match-correction.ts`
- Modify: `src/services/match/match-correction.test.ts`
- Modify: `src/services/match/index.ts`
- Modify: `src/services/lobby/discord-sync.ts` (cancel reason)

**Interfaces:**

- Produces:
  - `assertMatchCorrectable(match): void` (throws `MatchServiceError`)
  - `hasNewerCompletedMatches(leagueId, matchId, completedAt, playerIds): Promise<boolean>`
  - `restoreMatchRatingSnapshots(leagueId, matchId, tx): Promise<void>`
  - `previewMatchCorrection(matchId): Promise<MatchCorrectionPreview>`
  - `flipCompletedMatch(matchId, winningTeam, quitterSlots?): Promise<CompleteMatchResult-like>`
  - `voidCompletedMatch(matchId): Promise<MatchWithPlayers>`
  - Button customId build/parse (`matchcorr:` prefix)

- [ ] **Step 1: Write failing tests for pure helpers**

```typescript
import { describe, expect, it } from 'vitest';
import {
  CORRECTION_WINDOW_MS,
  isWithinCorrectionWindow,
  parseMatchCorrectionButtonCustomId,
  buildMatchCorrectionConfirmCustomId,
} from './match-correction.js';
import { MatchServiceError } from './match-service.js';

describe('isWithinCorrectionWindow', () => {
  it('accepts completedAt within 24h', () => {
    expect(isWithinCorrectionWindow(new Date(Date.now() - 1000), Date.now())).toBe(true);
  });

  it('rejects null completedAt', () => {
    expect(isWithinCorrectionWindow(null, Date.now())).toBe(false);
  });

  it('rejects older than 24h', () => {
    const old = new Date(Date.now() - CORRECTION_WINDOW_MS - 1);
    expect(isWithinCorrectionWindow(old, Date.now())).toBe(false);
  });
});

describe('matchcorr customId', () => {
  it('round-trips flip confirm', () => {
    const id = buildMatchCorrectionConfirmCustomId({
      action: 'flip',
      matchId: 'clxxxxxxxxxxxxxxxxxxxxxx',
      actorDiscordId: '123456789012345678',
      winningTeam: 2,
      quitterSlots: [1, 7],
    });
    expect(id.length).toBeLessThanOrEqual(100);
    expect(parseMatchCorrectionButtonCustomId(id)).toEqual({
      kind: 'confirm',
      action: 'flip',
      matchId: 'clxxxxxxxxxxxxxxxxxxxxxx',
      actorDiscordId: '123456789012345678',
      winningTeam: 2,
      quitterSlots: [1, 7],
    });
  });

  it('round-trips void confirm', () => {
    const id = buildMatchCorrectionConfirmCustomId({
      action: 'void',
      matchId: 'clxxxxxxxxxxxxxxxxxxxxxx',
      actorDiscordId: '123456789012345678',
    });
    expect(parseMatchCorrectionButtonCustomId(id)?.action).toBe('void');
  });
});
```

Run tests — expect FAIL until implemented.

- [ ] **Step 2: Implement eligibility + customId + restore + flip/void**

Key pieces (full file should include):

```typescript
export function isWithinCorrectionWindow(
  completedAt: Date | null | undefined,
  nowMs: number = Date.now(),
): boolean {
  if (!completedAt) {
    return false;
  }
  return nowMs - completedAt.getTime() <= CORRECTION_WINDOW_MS;
}

export function assertMatchCorrectable(match: { status: string; completedAt: Date | null }): void {
  if (match.status !== 'COMPLETED') {
    throw new MatchServiceError('This match is not completed.');
  }
  if (!isWithinCorrectionWindow(match.completedAt)) {
    throw new MatchServiceError('This match can only be corrected within 24 hours of completion.');
  }
}

export async function assertSnapshotsComplete(
  matchId: string,
  rosterSize: number,
  db: Db = prisma,
): Promise<void> {
  const count = await db.matchRatingSnapshot.count({ where: { matchId } });
  // 2 rows per player (GLOBAL + HERO)
  if (count !== rosterSize * 2) {
    throw new MatchServiceError(
      'This match cannot be corrected because rating snapshots are missing.',
    );
  }
}

export async function hasNewerCompletedMatches(
  leagueId: string,
  matchId: string,
  completedAt: Date,
  playerIds: string[],
  db: Db = prisma,
): Promise<boolean> {
  if (playerIds.length === 0) {
    return false;
  }
  const newer = await db.matchPlayer.findFirst({
    where: {
      playerId: { in: playerIds },
      matchId: { not: matchId },
      match: {
        leagueId,
        status: 'COMPLETED',
        completedAt: { gt: completedAt },
      },
    },
    select: { playerId: true },
  });
  return newer !== null;
}
```

`restoreMatchRatingSnapshots`: load all snapshots for matchId; for each GLOBAL update `playerRating`; for each HERO update `playerHeroRating` including `matchesPlayed: snapshot.matchesPlayed ?? 0`.

`flipCompletedMatch`:

1. Transaction + `SELECT … FOR UPDATE` on Match where status COMPLETED
2. assert correctable + snapshots
3. restore
4. Resolve quitters via existing `resolveQuitterSlots`
5. Update MatchPlayer flags/results (same as complete)
6. `applyQuitterPenalties` + `applyMatchRatings`
7. Do **not** touch snapshots or `completedAt`
8. Build rating preview like complete (optional but good for embed)

`voidCompletedMatch`:

1. Same lock/assert/restore
2. Clear each player `result: null`, `isQuitter: false`
3. `status: CANCELLED` (leave `completedAt` as-is)
4. Return match

CustomId format (≤100 chars), prefix `matchcorr`:

- Confirm flip: `matchcorr:ok:f:{matchId}:{actorId}:{team}:{slots}` where slots use `encodeSlots` (`1-7` or `-`)
- Confirm void: `matchcorr:ok:v:{matchId}:{actorId}`
- Cancel: `matchcorr:no:f:…` / `matchcorr:no:v:…` (payload still bound so Cancel is actor-scoped)

Reuse encode/decode slot helpers (copy small private functions into match-correction to avoid coupling to match-interactions).

- [ ] **Step 3: Extend discord-sync cancel reason**

```typescript
export async function syncLobbyDiscordMessage(
  client: Client,
  match: MatchWithPlayers,
  mode: LobbySyncMode,
  options: { ratingPreview?: LobbyRatingPreview; cancelReason?: string } = {},
): Promise<void> {
  // …
  } else {
    payload = {
      embeds: [
        buildMatchCancelledEmbed(
          match.id,
          options.cancelReason ?? 'by the host',
        ),
      ],
      components: [],
    };
  }
```

- [ ] **Step 4: Export from `match/index.ts`**

Export preview, flip, void, customId builders/parsers, `CORRECTION_WINDOW_MS` as needed by Discord adapters.

- [ ] **Step 5: Run tests**

`npm test -- src/services/match/match-correction.test.ts`  
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/services/match/match-correction.ts src/services/match/match-correction.test.ts src/services/match/index.ts src/services/lobby/discord-sync.ts
git commit -m "$(cat <<'EOF'
feat(match): add flip and void correction use-cases

EOF
)"
```

---

### Task 4: Slash commands + confirm buttons

**Files:**

- Modify: `src/commands/match/match.ts`
- Modify: `src/commands/match/match.test.ts`
- Create: `src/discord/interactions/match-correction-interactions.ts`
- Create: `src/discord/interactions/match-correction-interactions.test.ts`
- Modify: `src/events/interaction-create.ts`

**Interfaces:**

- Consumes: `previewMatchCorrection`, `flipCompletedMatch`, `voidCompletedMatch`, customId helpers, `assertHasMatchModRole`
- Produces: `/match flip`, `/match void`; button handler returning `boolean`

- [ ] **Step 1: Update command registration test (fail first)**

In `match.test.ts`, expect subcommands:

```typescript
expect(json.options?.map((option) => option.name)).toEqual([
  'quitters',
  'complete',
  'cancel',
  'flip',
  'void',
]);
```

- [ ] **Step 2: Add subcommands to `data`**

```typescript
  .addSubcommand((subcommand) =>
    subcommand
      .setName('flip')
      .setDescription('Correct the winner of a completed match (mods only, 24h)')
      .addStringOption((option) =>
        option.setName('match_id').setDescription('Completed match id').setRequired(true),
      )
      .addStringOption((option) =>
        option
          .setName('winner')
          .setDescription('Correct winning team')
          .setRequired(true)
          .addChoices(
            { name: teamDisplayName(1), value: 'A' },
            { name: teamDisplayName(2), value: 'B' },
          ),
      )
      .addStringOption((option) =>
        option
          .setName('quitters')
          .setDescription('Comma-separated slots; omit to keep current quitters')
          .setRequired(false),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('void')
      .setDescription('Void a completed match and restore ratings (mods only, 24h)')
      .addStringOption((option) =>
        option.setName('match_id').setDescription('Completed match id').setRequired(true),
      ),
  );
```

- [ ] **Step 3: Command execute paths**

For `flip` / `void`:

1. Require guild
2. `resolveGuildConfig` → `assertHasMatchModRole`
3. Require `match_id`; `getMatchById`
4. `previewMatchCorrection(match.id)` — throws if not correctable
5. For flip: parse winner; parse quitters only if option present (`undefined` = keep)
6. Build warning text:

```typescript
const lines = [
  action === 'flip'
    ? `Flip match \`${match.id}\` → winner **${teamDisplayName(winner)}**${quittersLine}.`
    : `Void match \`${match.id}\`. Ratings will be restored to pre-match values and the match will be cancelled.`,
];
if (preview.hasNewerMatches) {
  lines.push(
    'Warning: some players have completed ranked matches since this one. Those later results will not be recalculated.',
  );
}
lines.push('This can only be done within 24 hours of completion.');
```

7. `editReply` with Confirm/Cancel components from interaction helper

Do **not** call flip/void until Confirm.

Refactor: extract a `resolveCompletedMatchForModCorrection` that does not use host-based `resolveMatchForCommand`.

- [ ] **Step 4: Interaction module**

Mirror `rank-reset-interactions.ts`:

- `buildMatchCorrectionConfirmComponents(input)`
- `handleMatchCorrectionInteraction(interaction): Promise<boolean>` — true if `customId.startsWith('matchcorr:')`
- Confirm: deferUpdate → re-assert mod role → `flipCompletedMatch` / `voidCompletedMatch` → `syncLobbyDiscordMessage` (`completed` or `cancelled` with `cancelReason: 'by a moderator'`) → `refreshLeagueLeaderboard(client, match.leagueId)` → editReply success
- Cancel: editReply `Cancelled.` and clear components
- Wrong actor: `Only the moderator who ran this command can use these buttons.`

- [ ] **Step 5: Route in `interaction-create.ts`**

Before or after rank-reset:

```typescript
import { handleMatchCorrectionInteraction } from '../discord/interactions/match-correction-interactions.js';

if (await handleMatchCorrectionInteraction(interaction)) {
  return;
}
```

- [ ] **Step 6: Tests**

- Command data includes flip/void
- `handleMatchCorrectionInteraction` returns false for unrelated ids; true for `matchcorr:`
- Wrong actor message (mock interaction)

Run: `npm test -- src/commands/match/match.test.ts src/discord/interactions/match-correction-interactions.test.ts`

- [ ] **Step 7: Commit**

```bash
git add src/commands/match src/discord/interactions/match-correction-interactions.ts src/discord/interactions/match-correction-interactions.test.ts src/events/interaction-create.ts
git commit -m "$(cat <<'EOF'
feat(match): add /match flip and /match void for mods

EOF
)"
```

---

### Task 5: Docs + manual check

**Files:**

- Modify: `docs/discord/staff/a2-mod-powers.md`
- Modify: `docs/discord/staff/a5-admin-cheat-sheet.md`
- Modify: `docs/discord/public/05-play-and-finish.md`

- [ ] **Step 1: Staff docs**

In `a2-mod-powers.md`, after cancel bullets:

```markdown
**Correcting a finished match** (within 24 hours)
• `/match flip match_id:… winner:…` — fix wrong winner (optional `quitters`)
• `/match void match_id:…` — undo the result and restore ki
• Hosts cannot do this — mod role only
• If players already played more ranked games, later matches are not recalculated
```

Update `a5-admin-cheat-sheet.md` similarly.

- [ ] **Step 2: Public note**

In `05-play-and-finish.md`, after fair-play line:

```markdown
If a result was reported wrong, tell a match mod quickly — they can fix or void it within 24 hours.
```

- [ ] **Step 3: Manual smoke (dev bot)**

1. Complete a match → confirm `completedAt` + snapshot rows in DB
2. `/match flip` as mod → confirm → embed winner flips; ki moves
3. Complete another; `/match void` → cancelled embed; ratings back
4. Non-mod → rejected
5. Host without mod role → rejected
6. After hacking `completedAt` older than 24h → rejected

- [ ] **Step 4: Commit**

```bash
git add docs/discord
git commit -m "$(cat <<'EOF'
docs: document match flip and void for mods

EOF
)"
```

---

## Self-review vs spec

| Spec requirement                                    | Task                 |
| --------------------------------------------------- | -------------------- |
| `/match flip` + `/match void`, required `match_id`  | 4                    |
| Mod only                                            | 4                    |
| Flip winner + optional quitters                     | 3–4                  |
| Void → restore + CANCELLED                          | 3                    |
| 24h via `completedAt`                               | 1–3                  |
| Later-match warning                                 | 3–4                  |
| Snapshots on complete, immutable on flip            | 2–3                  |
| Missing snapshots reject                            | 3                    |
| Confirm buttons                                     | 4                    |
| Leaderboard refresh                                 | 4                    |
| Staff/public docs                                   | 5                    |
| No host access / no embed buttons / no chain replay | honored in non-goals |

No TBD placeholders. CustomId prefix `matchcorr:` avoids colliding with in-progress `match:` wizard. `GLOBAL` rows use `heroId = 0` sentinel for unique constraint.
