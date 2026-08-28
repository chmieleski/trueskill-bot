# WOS Match-File Report Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let WOS hosts report captain-draft matches from the WOS2 bot `.txt` export via `/register_lobby report:<file>` or a PENDING lobby **Report from file** button, with a confirm step (suggested winner + optional quitter/griefer).

**Architecture:** Game-scoped roster/winner helpers in `src/games/warcraft3_wos/`; shared use-case `submitWos2ReportForLobby()` in `src/services/match/` mirrors `createMatchFromWc3statsLobby()`. Slash command and lobby modal both call it; confirm UI completes via existing `completeMatch()`.

**Tech Stack:** Node.js ESM, TypeScript, discord.js v14, Prisma, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-28-wos-match-file-report-design.md`

## Global Constraints

- Scope: `game:warcraft3_wos` for WOS-specific logic; `general` for shared match/lobby shell.
- All user-facing strings in **English**.
- ESM imports use `.js` extension in TypeScript source.
- Named exports; Prisma singleton from `src/lib/prisma.ts`.
- Do not break UDBR screenshot/wc3stats flows.
- Gate on `profile.postMatchStats === 'wos2_bot_v1'`.
- Run `npm run format:check` before PR; fix with `npm run format` if needed.
- Conventional Commits for any commits.

---

## File map

| File                                                | Action | Responsibility                      |
| --------------------------------------------------- | ------ | ----------------------------------- |
| `src/games/warcraft3_wos/wos2-bot-report-roster.ts` | Create | `pid` → slot → `LobbyPlayer[]`      |
| `src/games/warcraft3_wos/wos2-bot-report-winner.ts` | Create | `inferSuggestedWinner()`            |
| `src/games/warcraft3_wos/index.ts`                  | Modify | Re-export new helpers               |
| `src/services/match/match-stats-upload.ts`          | Modify | Extract `persistWos2MatchStats()`   |
| `src/services/match/match-from-wos-report.ts`       | Create | `submitWos2ReportForLobby()`        |
| `src/services/lobby/register-lobby-source.ts`       | Modify | `wos2_report` source + validation   |
| `src/commands/lobby/register-lobby.ts`              | Modify | `report` attachment option          |
| `src/services/lobby/lobby-preview.ts`               | Modify | Report button on PENDING WOS        |
| `src/discord/interactions/lobby-interactions.ts`    | Modify | Button + modal handlers             |
| `src/discord/interactions/wos-report-confirm.ts`    | Create | Confirm UI + button handlers        |
| `src/discord/interactions/match-interactions.ts`    | Modify | Route `match:fr:*` custom ids       |
| `src/handlers/load-events.ts` or interaction router | Modify | Register confirm handlers if needed |

---

### Task 1: WOS roster mapping from report

**Files:**

- Create: `src/games/warcraft3_wos/wos2-bot-report-roster.ts`
- Create: `src/games/warcraft3_wos/wos2-bot-report-roster.test.ts`
- Modify: `src/games/warcraft3_wos/index.ts`

**Interfaces:**

- Consumes: `parseWos2BotReport`, `Wos2BotReport`, `WOS_WC3STATS_SLOT_MAP` from `wc3stats-slot-map.ts`, `GameProfile`, `LobbyPlayer`
- Produces:

  ```typescript
  export class Wos2ReportRosterError extends Error { ... }
  export function wc3statsPidToBotSlot(pid: number): number
  export function lobbyPlayersFromWos2Report(
    report: Wos2BotReport,
    profile: GameProfile,
  ): LobbyPlayer[]
  ```

- [ ] **Step 1: Write the failing tests**

```typescript
// src/games/warcraft3_wos/wos2-bot-report-roster.test.ts
import { describe, expect, it } from 'vitest';
import { getGameProfile } from '../../domain/game-profile.js';
import { WARCRAFT3_WOS_GAME_ID } from '../../domain/games.js';
import { parseWos2BotReport } from './wos2-bot-report-parser.js';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  lobbyPlayersFromWos2Report,
  wc3statsPidToBotSlot,
  Wos2ReportRosterError,
} from './wos2-bot-report-roster.js';

const sampleRaw = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'fixtures/wos2-bot-sample.txt'),
  'utf8',
);

describe('wc3statsPidToBotSlot', () => {
  it('maps pid 0 to slot 1 and pid 5 to slot 6', () => {
    expect(wc3statsPidToBotSlot(0)).toBe(1);
    expect(wc3statsPidToBotSlot(5)).toBe(6);
  });

  it('throws for unknown pid', () => {
    expect(() => wc3statsPidToBotSlot(99)).toThrow(Wos2ReportRosterError);
  });
});

describe('lobbyPlayersFromWos2Report', () => {
  it('builds lobby players from sample report', () => {
    const profile = getGameProfile(WARCRAFT3_WOS_GAME_ID);
    const report = parseWos2BotReport(sampleRaw);
    const players = lobbyPlayersFromWos2Report(report, profile);

    expect(players).toEqual([
      { slot: 1, nick: 'Chmieleski#1941' },
      { slot: 6, nick: 'Tiny#11318' },
    ]);
  });

  it('requires at least one player per team', () => {
    const profile = getGameProfile(WARCRAFT3_WOS_GAME_ID);
    const report = parseWos2BotReport(sampleRaw);
    report.players = report.players.filter((p) => p.team === 1);

    expect(() => lobbyPlayersFromWos2Report(report, profile)).toThrow(Wos2ReportRosterError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/games/warcraft3_wos/wos2-bot-report-roster.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement**

```typescript
// src/games/warcraft3_wos/wos2-bot-report-roster.ts
import type { GameProfile } from '../../domain/game-profile.js';
import { teamForSlot } from '../../domain/game-profile.js';
import type { LobbyPlayer } from '../../services/lobby/lobby-ocr.js';
import { WOS_WC3STATS_SLOT_MAP } from '../../services/wc3stats/wc3stats-slot-map.js';
import type { Wos2BotReport } from './wos2-bot-report-parser.js';

export class Wos2ReportRosterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Wos2ReportRosterError';
  }
}

const PID_TO_SLOT = new Map(
  WOS_WC3STATS_SLOT_MAP.map((entry) => [entry.wc3statsSlot, entry.heroId]),
);

/** Map wc3stats player id (0–9) to bot lobby slot (1–10). */
export function wc3statsPidToBotSlot(pid: number): number {
  const slot = PID_TO_SLOT.get(pid);
  if (slot === undefined) {
    throw new Wos2ReportRosterError(`Unknown player id (pid) in report: ${pid}`);
  }
  return slot;
}

/** Build lobby roster from a parsed WOS2 bot report. */
export function lobbyPlayersFromWos2Report(
  report: Wos2BotReport,
  profile: GameProfile,
): LobbyPlayer[] {
  const players: LobbyPlayer[] = [];
  const seenSlots = new Set<number>();

  for (const reportPlayer of report.players) {
    const slot = wc3statsPidToBotSlot(reportPlayer.pid);
    if (seenSlots.has(slot)) {
      throw new Wos2ReportRosterError(`Duplicate slot ${slot} in report.`);
    }
    seenSlots.add(slot);
    players.push({ slot, nick: reportPlayer.name.trim() });
  }

  if (players.length === 0) {
    throw new Wos2ReportRosterError('Report contains no players.');
  }

  const teamCounts = { 1: 0, 2: 0 };
  for (const player of players) {
    teamCounts[teamForSlot(profile, player.slot)] += 1;
  }
  if (teamCounts[1] === 0 || teamCounts[2] === 0) {
    throw new Wos2ReportRosterError('Both teams must have at least one player in the report.');
  }

  return players;
}
```

- [ ] **Step 4: Export from `index.ts`**

- [ ] **Step 5: Run tests**

Run: `npm test -- src/games/warcraft3_wos/wos2-bot-report-roster.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/games/warcraft3_wos/wos2-bot-report-roster.ts \
  src/games/warcraft3_wos/wos2-bot-report-roster.test.ts \
  src/games/warcraft3_wos/index.ts
git commit -m "feat(wos): map WOS2 bot report players to lobby slots"
```

---

### Task 2: Winner inference helper

**Files:**

- Create: `src/games/warcraft3_wos/wos2-bot-report-winner.ts`
- Create: `src/games/warcraft3_wos/wos2-bot-report-winner.test.ts`
- Modify: `src/games/warcraft3_wos/index.ts`

**Interfaces:**

- Produces:

  ```typescript
  export type SuggestedWinner = { team: 1 | 2; source: 'rounds' | 'win_flags' };
  export function inferSuggestedWinner(report: Wos2BotReport): SuggestedWinner | null;
  ```

- [ ] **Step 1: Write failing tests** (rounds from sample → team 2; win_flags-only case; tie → null)

- [ ] **Step 2: Run tests — expect FAIL**

- [ ] **Step 3: Implement**

```typescript
import { winningTeamFromWos2Rounds, type Wos2BotReport } from './wos2-bot-report-parser.js';

export type SuggestedWinner = { team: 1 | 2; source: 'rounds' | 'win_flags' };

export function inferSuggestedWinner(report: Wos2BotReport): SuggestedWinner | null {
  const fromRounds = winningTeamFromWos2Rounds(report);
  if (fromRounds !== null) {
    return { team: fromRounds, source: 'rounds' };
  }

  const team1Winners = report.players.filter((p) => p.team === 1 && p.win).length;
  const team2Winners = report.players.filter((p) => p.team === 2 && p.win).length;
  if (team1Winners > 0 && team2Winners === 0) {
    return { team: 1, source: 'win_flags' };
  }
  if (team2Winners > 0 && team1Winners === 0) {
    return { team: 2, source: 'win_flags' };
  }
  return null;
}
```

- [ ] **Step 4: Run tests — expect PASS**

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(wos): infer suggested winner from WOS2 bot report"
```

---

### Task 3: Extract stats persistence for reuse

**Files:**

- Modify: `src/services/match/match-stats-upload.ts`
- Modify: `src/services/match/match-stats-upload.test.ts` (if exists) or add test

**Interfaces:**

- Produces:

  ```typescript
  export async function persistWos2MatchStats(input: {
    matchId: string;
    actorDiscordId: string;
    rawText: string;
    report: Wos2BotReport;
  }): Promise<{ summaryLines: string[]; warnings: string[] }>;
  ```

- [ ] **Step 1: Refactor** — move roster-match + transaction create from `uploadMatchStatsReport` into `persistWos2MatchStats`; keep public `uploadMatchStatsReport` calling it after auth/status checks.

- [ ] **Step 2: Run existing match-stats-upload tests**

Run: `npm test -- src/services/match/match-stats-upload`
Expected: PASS (no behavior change)

- [ ] **Step 3: Commit**

```bash
git commit -m "refactor(match): extract persistWos2MatchStats for reuse"
```

---

### Task 4: `submitWos2ReportForLobby` use-case

**Files:**

- Create: `src/services/match/match-from-wos-report.ts`
- Create: `src/services/match/match-from-wos-report.test.ts`

**Interfaces:**

- Consumes: Task 1–3 exports, `createPendingMatch`, `replaceMatchRoster`, `startMatch`, `getMatchById`, `canStartLobby`
- Produces:

  ```typescript
  export type Wos2ReportConfirmPayload = {
    matchId: string;
    match: MatchWithPlayers;
    report: Wos2BotReport;
    suggestedWinner: SuggestedWinner | null;
    summaryLines: string[];
    warnings: string[];
    duplicateExternalIdWarning: string | null;
    profile: GameProfile;
    newPlayerSuggestions: NewPlayerSuggestion[];
  };

  export async function submitWos2ReportForLobby(input: {
    guildId: string;
    leagueId?: string;
    eventId?: string;
    hostDiscordId: string;
    discordChannelId: string;
    memberRoleIds: string[];
    rawText: string;
    existingMatchId?: string;
    bypassHostLobbyCap?: boolean;
  }): Promise<Wos2ReportConfirmPayload>;
  ```

- [ ] **Step 1: Write failing tests** with mocked prisma/match functions (vitest `vi.mock`):
  - Creates match when no `existingMatchId`
  - Calls `replaceMatchRoster` when `existingMatchId` set
  - Throws `MatchServiceError` on parse error
  - Returns `suggestedWinner: { team: 2, source: 'rounds' }` for sample fixture

- [ ] **Step 2: Run tests — expect FAIL**

- [ ] **Step 3: Implement use-case**

Core sequence:

1. `assertCanCreateMatch` (or manage match auth when `existingMatchId`)
2. Load profile; reject if `postMatchStats !== 'wos2_bot_v1'`
3. `parseWos2BotReport(rawText)`
4. `lobbyPlayersFromWos2Report(report, profile)`
5. `canStartLobby(players, profile)` — throw if false
6. Create or replace roster
7. `startMatch(matchId)`
8. `persistWos2MatchStats(...)`
9. Query duplicate `externalId` on completed matches → warning string
10. `collectNewPlayerSuggestionsForPendingCreate` for new-player prompts
11. Return confirm payload

- [ ] **Step 4: Run tests — expect PASS**

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(wos): add submitWos2ReportForLobby use-case"
```

---

### Task 5: Register lobby source + command

**Files:**

- Modify: `src/services/lobby/register-lobby-source.ts`
- Create/extend: `src/services/lobby/register-lobby-source.test.ts`
- Modify: `src/commands/lobby/register-lobby.ts`

**Interfaces:**

- Produces:

  ```typescript
  export type RegisterLobbySource =
    | { kind: 'empty' }
    | { kind: 'screenshot'; url: string; mimeType: string }
    | { kind: 'wc3stats'; wc3statsId?: number }
    | { kind: 'wos2_report'; url: string };

  export function assertRegisterLobbyReportAllowed(
    profile: GameProfile,
    input: { hasReport: boolean; hasScreenshot: boolean },
  ): void;

  export function resolveRegisterLobbySource(input: {
    attachmentUrl?: string | null;
    mimeType?: string | null;
    attachmentName?: string | null;
    wc3statsEnabled?: boolean;
    wc3statsId?: number | null;
    isTextReport?: boolean;
  }): RegisterLobbySource;
  ```

- [ ] **Step 1: Write failing tests**
  - WOS + text report → `wos2_report`
  - WOS + image → screenshot (then blocked by existing assert)
  - UDBR + text report → error
  - Both print + report → error at command level

- [ ] **Step 2: Implement source resolver** — if `isTextReport`, return `wos2_report` before screenshot branch.

- [ ] **Step 3: Extend `register-lobby.ts`**
  - Add `.addAttachmentOption` for `report` (optional `.txt`)
  - Detect text vs image: use `isTextReportAttachment()` from `match-stats-upload.ts`
  - Reject both attachments
  - When `source.kind === 'wos2_report'`:
    - Fetch text via `fetchTextAttachment`
    - Call `submitWos2ReportForLobby`
    - Sync lobby Discord message to IN_PROGRESS embed
    - Show confirm UI (Task 6) via `showWos2ReportConfirm(interaction, payload)`

- [ ] **Step 4: Run tests**

Run: `npm test -- src/services/lobby/register-lobby-source`
Run: `npm run typecheck`

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(lobby): register WOS match from report attachment"
```

---

### Task 6: Confirm UI + completion handlers

**Files:**

- Create: `src/discord/interactions/wos-report-confirm.ts`
- Modify: `src/discord/interactions/match-interactions.ts` (route custom ids)
- Modify: `src/discord/interactions/lobby-interactions.ts` (import show helper after modal)

**Custom id scheme:**

- `match:fr:confirm:{matchId}:{team}:{grieferCsv}:{quitterCsv}` — complete
- `match:fr:winpick:{matchId}:{team}:{grieferCsv}:{quitterCsv}` — change winner (re-render)
- `match:fr:cancel:{matchId}` — dismiss ephemeral
- `match:fr:g:{matchId}` — griefer select (stores in custom id chain like existing `match:rw:*`)

**Interfaces:**

- Produces:

  ```typescript
  export async function showWos2ReportConfirm(
    interaction: MessageComponentInteraction | CommandInteraction,
    payload: Wos2ReportConfirmPayload,
  ): Promise<void>;

  export async function handleWos2ReportConfirmButton(
    interaction: ButtonInteraction,
  ): Promise<void>;

  export async function handleWos2ReportConfirmSelect(
    interaction: StringSelectMenuInteraction,
  ): Promise<void>;
  ```

- [ ] **Step 1: Implement `showWos2ReportConfirm`**
  - Ephemeral content: roster, stats lines, suggested winner text, warnings
  - Reuse `buildGrieferSelectRow` / quitter select patterns from `match-interactions.ts` (export or duplicate minimally)
  - Primary button: **Confirm {teamName} won** when `suggestedWinner` set
  - Secondary: **Change winner** → Team 1 / Team 2 buttons
  - **Cancel** button

- [ ] **Step 2: Implement confirm handler**
  - Parse custom id → `completeMatch(matchId, team, quitterSlots, grieferSlots)`
  - `syncLobbyDiscordMessage(..., 'completed')`
  - `sendNewPlayerSuggestPrompts` if suggestions present
  - `refreshAllLeaderboardChannels`

- [ ] **Step 3: Wire routes** in match-interactions `handleButton` / select handlers for `match:fr:*`

- [ ] **Step 4: Manual test checklist** (document in commit message body if no automated UI tests)

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(wos): add match-file report confirm UI"
```

---

### Task 7: PENDING lobby button + modal

**Files:**

- Modify: `src/services/lobby/lobby-preview.ts`
- Modify: `src/services/lobby/lobby-preview.test.ts`
- Modify: `src/discord/interactions/lobby-interactions.ts`

- [ ] **Step 1: Add `LOBBY_CUSTOM_IDS.reportFromFile = 'lobby:report_file'`**

- [ ] **Step 2: Update `buildLobbyButtons`**
  - When `profile.postMatchStats !== 'none'` and not locked, add row with **Report from file** button

- [ ] **Step 3: Test** — WOS profile shows button; UDBR does not

- [ ] **Step 4: Handle button in `lobby-interactions.ts`**
  - Auth: host/mod on PENDING match
  - Show modal `lobby:modal:report_file:{messageId}`
  - TextInput `report_text`, Paragraph, max 4000, label "Paste WOS2 bot report"

- [ ] **Step 5: Handle modal submit**
  - Fetch match by message id
  - Call `submitWos2ReportForLobby({ existingMatchId, rawText: fields... })`
  - Sync lobby message to IN_PROGRESS
  - `showWos2ReportConfirm`

- [ ] **Step 6: Run tests + typecheck**

- [ ] **Step 7: Commit**

```bash
git commit -m "feat(wos): add Report from file lobby button and modal"
```

---

### Task 8: Deploy commands + final verification

**Files:**

- Modify: `src/commands/lobby/register-lobby.ts` (already has new option — verify deploy)

- [ ] **Step 1: Copy or symlink `.env` into worktree** for local dev tests

- [ ] **Step 2: Run full test suite**

Run: `npm test`
Expected: all pass (with `.env` present)

- [ ] **Step 3: Run format + typecheck**

Run: `npm run format:check && npm run typecheck`

- [ ] **Step 4: Deploy commands locally** (optional)

Run: `npm run deploy-commands`

- [ ] **Step 5: Commit any format fixes**

```bash
git commit -m "chore: format WOS match-file report changes"
```

---

## Spec coverage checklist

| Spec requirement                     | Task          |
| ------------------------------------ | ------------- |
| `/register_lobby report:` attachment | Task 5        |
| PENDING lobby button + modal         | Task 7        |
| Confirm step with suggested winner   | Task 6        |
| Optional quitter/griefer on confirm  | Task 6        |
| Roster from pid → slot               | Task 1        |
| Winner inference order               | Task 2        |
| Partial lobbies                      | Task 1        |
| persist stats                        | Task 3 + 4    |
| Duplicate externalId warning         | Task 4 + 6    |
| UDBR unchanged                       | Task 5 guards |
| English copy                         | Tasks 6–7     |

## Manual test plan

1. WOS league: `/register_lobby report:<sample.txt>` → confirm UI → complete → ratings applied
2. Empty lobby → **Report from file** → paste sample → same confirm flow
3. Inconclusive winner fixture → must pick team before confirm
4. UDBR league: `report` attachment → clear rejection
5. WOS: both `print` and `report` → rejection
6. Cancel confirm → match stays IN_PROGRESS; `/match cancel` works
