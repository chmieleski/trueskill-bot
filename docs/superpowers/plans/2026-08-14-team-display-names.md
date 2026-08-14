# Team Display Names Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace every user-facing “Team A” / “Team B” string with **Z Fighters** / **Evil** via a single `teamDisplayName` helper.

**Architecture:** Add `src/services/team-names.ts` with hardcoded display constants and helpers. Call sites (embeds, buttons, slash choice labels, select menus, OCR errors) import the helper. Internal team IDs stay `1` / `2`; slash values stay `A` / `B`. Future map/guild names only change this module.

**Tech Stack:** TypeScript ESM, Vitest, discord.js v14

**Spec:** `docs/superpowers/specs/2026-08-14-team-display-names-design.md`

## Global Constraints

- User-facing English only; display names exactly `Z Fighters` (team 1) and `Evil` (team 2)
- Do not change slash option values (`A` / `B`), custom IDs, DB, or env/SSM
- Do not rename internal identifiers (`teamA`, `teamB`, `winningTeam`)
- Leave developer comments that are not user-facing (e.g. `rating-math.ts` JSDoc) as-is
- ESM imports use `.js` extension; named exports only
- After slash label changes, commands must be redeployed (dev: `AUTO_DEPLOY_COMMANDS`; prod: deploy path)

## File map

| File | Role |
|------|------|
| `src/services/team-names.ts` | **Create** — constants + `teamDisplayName` / `teamDisplayNameForSlot` |
| `src/services/team-names.test.ts` | **Create** — unit tests |
| `src/services/lobby-preview.ts` | Embed field names + winner description |
| `src/services/lobby-preview.test.ts` | Assert new winner copy |
| `src/handlers/match-interactions.ts` | Remove local `teamLabel`; buttons + winner text |
| `src/handlers/lobby-interactions.ts` | Slot select labels / descriptions |
| `src/commands/match/match.ts` | Slash winner choice **names** only |
| `src/services/lobby-ocr.ts` | User-facing “both teams” validation error |

---

### Task 1: `team-names` helper + tests

**Files:**
- Create: `src/services/team-names.ts`
- Create: `src/services/team-names.test.ts`

**Interfaces:**
- Produces:
  - `teamDisplayName(team: 1 | 2): string`
  - `teamDisplayNameForSlot(slot: number): string` — slot ≤ 6 → team 1, else team 2

- [ ] **Step 1: Write the failing test**

Create `src/services/team-names.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { teamDisplayName, teamDisplayNameForSlot } from './team-names.js';

describe('teamDisplayName', () => {
  it('maps team 1 to Z Fighters and team 2 to Evil', () => {
    expect(teamDisplayName(1)).toBe('Z Fighters');
    expect(teamDisplayName(2)).toBe('Evil');
  });
});

describe('teamDisplayNameForSlot', () => {
  it('uses team 1 for slots 1-6 and team 2 for 7-12', () => {
    expect(teamDisplayNameForSlot(1)).toBe('Z Fighters');
    expect(teamDisplayNameForSlot(6)).toBe('Z Fighters');
    expect(teamDisplayNameForSlot(7)).toBe('Evil');
    expect(teamDisplayNameForSlot(12)).toBe('Evil');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/services/team-names.test.ts`

Expected: FAIL (module not found / cannot resolve `./team-names.js`)

- [ ] **Step 3: Write minimal implementation**

Create `src/services/team-names.ts`:

```typescript
/** Slots 1–6 = team 1; 7–12 = team 2 (same split as rating-math / lobby). */
const TEAM_A_MAX_SLOT = 6;

const TEAM_DISPLAY_NAMES = {
  1: 'Z Fighters',
  2: 'Evil',
} as const;

/** User-facing team label (hardcoded; later map/guild can swap this map). */
export function teamDisplayName(team: 1 | 2): string {
  return TEAM_DISPLAY_NAMES[team];
}

/** Display name for a lobby slot. */
export function teamDisplayNameForSlot(slot: number): string {
  return teamDisplayName(slot <= TEAM_A_MAX_SLOT ? 1 : 2);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/services/team-names.test.ts`

Expected: PASS (2 describes / 2 tests)

- [ ] **Step 5: Commit**

```bash
git add src/services/team-names.ts src/services/team-names.test.ts
git commit -m "$(cat <<'EOF'
feat: add team display name helper

Centralize Z Fighters / Evil labels for user-facing copy.
EOF
)"
```

---

### Task 2: Lobby / match embeds (`lobby-preview`)

**Files:**
- Modify: `src/services/lobby-preview.ts`
- Modify: `src/services/lobby-preview.test.ts` (winner description assertion ~line 388)

**Interfaces:**
- Consumes: `teamDisplayName` from `./team-names.js`

- [ ] **Step 1: Update the failing assertion**

In `src/services/lobby-preview.test.ts`, change:

```typescript
expect(json.description).toBe('Team A won the match.');
```

to:

```typescript
expect(json.description).toBe('Z Fighters won the match.');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/services/lobby-preview.test.ts`

Expected: FAIL — description still `Team A won the match.`

- [ ] **Step 3: Wire `teamDisplayName` into embeds**

In `src/services/lobby-preview.ts`:

1. Add import:

```typescript
import { teamDisplayName } from './team-names.js';
```

2. In `ratingPreviewFields`, replace field names:

```typescript
name: `${TEAM_A_EMOJI} ${teamDisplayName(1)} win`,
// ...
name: `${TEAM_B_EMOJI} ${teamDisplayName(2)} win`,
```

3. In `buildLobbyEmbed`, `buildMatchInProgressEmbed`, and `buildMatchCompletedEmbed`, replace team field names:

```typescript
name: `${TEAM_A_EMOJI} ${teamDisplayName(1)} (${teamACount})`,
// ...
name: `${TEAM_B_EMOJI} ${teamDisplayName(2)} (${teamBCount})`,
```

4. In `buildMatchCompletedEmbed`, replace:

```typescript
const winnerLabel = options.winningTeam === 1 ? 'Team A' : 'Team B';
```

with:

```typescript
const winnerLabel = teamDisplayName(options.winningTeam);
```

There must be **no** remaining user-facing `"Team A"` / `"Team B"` string literals in this file.

- [ ] **Step 4: Run tests**

Run: `npm test -- src/services/lobby-preview.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/lobby-preview.ts src/services/lobby-preview.test.ts
git commit -m "$(cat <<'EOF'
feat: use themed team names on lobby embeds

Show Z Fighters / Evil on roster and win-chance fields.
EOF
)"
```

---

### Task 3: Match report UI (`match-interactions`)

**Files:**
- Modify: `src/handlers/match-interactions.ts`

**Interfaces:**
- Consumes: `teamDisplayName` from `../services/team-names.js`
- Removes local `teamLabel` function

- [ ] **Step 1: Import helper and delete local `teamLabel`**

Add:

```typescript
import { teamDisplayName } from '../services/team-names.js';
```

Delete:

```typescript
function teamLabel(team: 1 | 2): string {
  return team === 1 ? 'Team A' : 'Team B';
}
```

- [ ] **Step 2: Update buttons and winner copy**

In `buildWinnerRow`:

```typescript
.setLabel(`${teamDisplayName(1)} Won`)
// ...
.setLabel(`${teamDisplayName(2)} Won`)
```

Replace every `teamLabel(...)` call with `teamDisplayName(...)` (confirm/complete messages that say `Winner: **…**`).

Grep the file: no remaining `Team A`, `Team B`, or `teamLabel`.

- [ ] **Step 3: Typecheck / related tests**

Run: `npm test -- src/services/match-report.test.ts src/commands/match/match.test.ts`

Expected: PASS (no string assertions on old labels required; confirms no import breakage)

- [ ] **Step 4: Commit**

```bash
git add src/handlers/match-interactions.ts
git commit -m "$(cat <<'EOF'
feat: themed team names on match report UI

Winner buttons and confirm copy use shared display names.
EOF
)"
```

---

### Task 4: Lobby slot selects + slash choices + OCR error

**Files:**
- Modify: `src/handlers/lobby-interactions.ts`
- Modify: `src/commands/match/match.ts`
- Modify: `src/services/lobby-ocr.ts`

**Interfaces:**
- Consumes: `teamDisplayName` / `teamDisplayNameForSlot` from `team-names.js`

- [ ] **Step 1: Lobby slot select labels**

In `src/handlers/lobby-interactions.ts`, import:

```typescript
import { teamDisplayNameForSlot } from '../services/team-names.js';
```

In `emptySlotSelectOptions` and `destinationSlotSelectOptions`, replace:

```typescript
const team = slot <= 6 ? 'Team A' : 'Team B';
```

with:

```typescript
const team = teamDisplayNameForSlot(slot);
```

(Keep using `team` in `label` / `description` as today.)

- [ ] **Step 2: Slash winner choice labels**

In `src/commands/match/match.ts`, import:

```typescript
import { teamDisplayName } from '../../services/team-names.js';
```

Replace choices with:

```typescript
.addChoices(
  { name: teamDisplayName(1), value: 'A' },
  { name: teamDisplayName(2), value: 'B' },
)
```

Do **not** change `value: 'A'` / `'B'`.

- [ ] **Step 3: OCR validation error**

In `src/services/lobby-ocr.ts`, import:

```typescript
import { teamDisplayName } from './team-names.js';
```

Replace the throw at the empty-team check with:

```typescript
throw new LobbyOcrError(
  `Both ${teamDisplayName(1)} and ${teamDisplayName(2)} need at least one human player.`,
);
```

Leave the non-user-facing JSDoc (“Team A = slots 1–6…”) unchanged.

- [ ] **Step 4: Repo-wide string check + tests**

Run:

```bash
rg 'Team A|Team B' src --glob '*.ts'
npm test
```

Expected:
- `rg`: only non-user-facing hits (e.g. `rating-math.ts` JSDoc, `lobby-ocr.ts` JSDoc) — **zero** string literals in handlers/commands/embeds/errors
- `npm test`: all PASS

- [ ] **Step 5: Commit**

```bash
git add src/handlers/lobby-interactions.ts src/commands/match/match.ts src/services/lobby-ocr.ts
git commit -m "$(cat <<'EOF'
feat: themed team names in selects, slash, OCR

Finish wiring display names across remaining user-facing surfaces.
EOF
)"
```

---

### Task 5: Manual smoke (dev)

**Files:** none (ops)

- [ ] **Step 1: Ensure slash commands refresh**

With `AUTO_DEPLOY_COMMANDS` enabled, restart `npm run dev` (or run `npm run deploy-commands`) so Discord shows `Z Fighters` / `Evil` on `/match complete` winner choices.

- [ ] **Step 2: Spot-check in Discord**

- Lobby embed: team headers and win % field names
- Slot add/move selects: themed team in labels
- Report Winner buttons: `Z Fighters Won` / `Evil Won`
- Completed embed: `Z Fighters won the match.` (or Evil)

- [ ] **Step 3: Done** — no code commit unless smoke found a miss; if a miss, fix and commit with message `fix: …`

---

## Spec coverage checklist

| Spec requirement | Task |
|------------------|------|
| `team-names.ts` + `teamDisplayName` | Task 1 |
| `teamDisplayNameForSlot` | Task 1, used in Task 4 |
| Hardcoded Z Fighters / Evil | Task 1 |
| Lobby embeds / win % | Task 2 |
| Completed winner description | Task 2 |
| Report buttons & winner copy | Task 3 |
| Lobby slot messages/selects | Task 4 |
| Slash choice labels only | Task 4 |
| OCR error | Task 4 |
| Tests + command redeploy note | Tasks 1–2, 5 |
| No env/guild/DB | All tasks respect non-goals |
