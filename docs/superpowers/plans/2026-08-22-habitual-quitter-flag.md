# Habitual Quitter Flag Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show ⚠️ next to a roster nick when that league’s `/rank` quit rate is 50% or more, so players do not have to look people up.

**Architecture:** Pure `isHabitualQuitter(quits, games)` next to existing display-stats helpers. Lobby and completed preview builders already load `loadMatchDisplayStatsByPlayer`; they set `LobbyRatingPlayerLine.habitualQuitter`. `formatTeamLinesFromPreview` appends ⚠️ outside the code span (before 🚪 / 🐛). Footer adds ` · ⚠️ quit 50%+` only when at least one line is flagged. No schema, no rating-math change.

**Tech Stack:** TypeScript ESM, discord.js v14, Vitest

**Spec:** `docs/superpowers/specs/2026-08-22-habitual-quitter-flag-design.md`

## Global Constraints

- Scope: `general` (league-keyed display; all games)
- English-only user-facing strings
- Same `games` / `quits` as `/rank` (`PlayerMatchDisplayStats`, post–rank-reset)
- Rule: `quits ≥ 1 AND (games = 0 OR quits / games ≥ 0.5)`
- Marker: ⚠️ outside the code span; order ⚠️ then 🚪 then 🐛
- 🚪 still means quit **this** match; 🐛 unchanged
- Footer suffix only when any line is flagged: ` · ⚠️ quit 50%+`
- Surfaces: PENDING / IN_PROGRESS / completed **match roster** (ki preview formatter)
- Not in v1: `/rank`, leaderboards, match history list, denormalized counters, games floor
- ESM imports use `.js` extension; named exports
- No new production env / SSM keys
- Do not persist the flag

## File map

| File | Role |
| ---- | ---- |
| `src/services/rating/rank-reset-display.ts` | `isHabitualQuitter`, `habitualQuitterFromStats` |
| `src/services/rating/rank-reset-display.test.ts` | Predicate unit tests |
| `src/services/rating/rating-preview.ts` | `habitualQuitter` on DTO; set it in lobby + completed builders |
| `src/services/lobby/lobby-preview.ts` | ⚠️ on roster lines; footer legend |
| `src/services/lobby/lobby-preview.test.ts` | Formatter, footer, completed-preview mapping |
| `src/services/match/match-report.ts` | Pass display stats into completed preview |
| `src/services/match/match-correction.ts` | Same on flip |
| `src/services/match/match-history-preview.ts` | Set flag on stored/rebuild completed preview (`/match show`) |
| `src/services/match/match-history-preview.test.ts` | Stored preview includes `habitualQuitter` |

Work from the isolated worktree: `.worktrees/feat-habitual-quitter-flag` on `feat/habitual-quitter-flag`.

---

### Task 1: Predicate helpers

**Files:**

- Modify: `src/services/rating/rank-reset-display.ts`
- Modify: `src/services/rating/rank-reset-display.test.ts`

**Interfaces:**

- Consumes: existing `PlayerMatchDisplayStats` (`games`, `quits`)
- Produces:
  - `isHabitualQuitter(quits: number, games: number): boolean`
  - `habitualQuitterFromStats(stats: Map<string, PlayerMatchDisplayStats>, playerId: string): boolean`

- [ ] **Step 1: Write the failing tests**

Add to `src/services/rating/rank-reset-display.test.ts` (extend the existing import list):

```typescript
import {
  aggregateHeroMatchDisplayStats,
  aggregateMatchDisplayStats,
  countCompletedGamesThrough,
  gamesByPlayerFromStats,
  habitualQuitterFromStats,
  heroStatsFor,
  isHabitualQuitter,
  isMatchCountedAfterRankReset,
  winRatePercent,
} from './rank-reset-display.js';
```

Append:

```typescript
describe('isHabitualQuitter', () => {
  it('is false when there are no quits', () => {
    expect(isHabitualQuitter(0, 0)).toBe(false);
    expect(isHabitualQuitter(0, 10)).toBe(false);
  });

  it('is true when there is at least one quit and zero completed games', () => {
    expect(isHabitualQuitter(1, 0)).toBe(true);
  });

  it('flags at 50% inclusive and above', () => {
    expect(isHabitualQuitter(1, 1)).toBe(true);
    expect(isHabitualQuitter(1, 2)).toBe(true);
    expect(isHabitualQuitter(3, 5)).toBe(true);
  });

  it('does not flag below 50%', () => {
    expect(isHabitualQuitter(1, 3)).toBe(false);
    expect(isHabitualQuitter(2, 5)).toBe(false);
  });
});

describe('habitualQuitterFromStats', () => {
  it('uses zeros when the player has no stats row', () => {
    expect(habitualQuitterFromStats(new Map(), 'p1')).toBe(false);
  });

  it('reads quits and games from the stats map', () => {
    const stats = new Map([
      ['p1', { games: 2, wins: 1, losses: 1, quits: 1 }],
      ['p2', { games: 3, wins: 2, losses: 1, quits: 1 }],
    ]);
    expect(habitualQuitterFromStats(stats, 'p1')).toBe(true);
    expect(habitualQuitterFromStats(stats, 'p2')).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/services/rating/rank-reset-display.test.ts`

Expected: FAIL — `isHabitualQuitter` / `habitualQuitterFromStats` are not exported.

- [ ] **Step 3: Write minimal implementation**

In `src/services/rating/rank-reset-display.ts`, after `PlayerMatchDisplayStats` (around the `gamesByPlayerFromStats` export), add:

```typescript
/** True when league quit rate is 50%+ (same W/L/Q window as `/rank`). */
export function isHabitualQuitter(quits: number, games: number): boolean {
  if (quits < 1) {
    return false;
  }
  if (games === 0) {
    return true;
  }
  return quits / games >= 0.5;
}

/** Look up display stats for one player; missing row is 0/0 (not flagged). */
export function habitualQuitterFromStats(
  stats: Map<string, PlayerMatchDisplayStats>,
  playerId: string,
): boolean {
  const row = stats.get(playerId);
  return isHabitualQuitter(row?.quits ?? 0, row?.games ?? 0);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/services/rating/rank-reset-display.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/rating/rank-reset-display.ts src/services/rating/rank-reset-display.test.ts
git commit -m "$(cat <<'EOF'
feat(rating): add habitual quitter predicate

EOF
)"
```

---

### Task 2: Roster marker and footer legend

**Files:**

- Modify: `src/services/rating/rating-preview.ts` (`LobbyRatingPlayerLine` only)
- Modify: `src/services/lobby/lobby-preview.ts`
- Modify: `src/services/lobby/lobby-preview.test.ts`

**Interfaces:**

- Consumes: `LobbyRatingPlayerLine.habitualQuitter?: boolean`
- Produces: ⚠️ outside the code span; footer suffix ` · ⚠️ quit 50%+` when any preview line has the flag

- [ ] **Step 1: Write the failing tests**

In `src/services/lobby/lobby-preview.test.ts`, inside `describe('formatTeamLinesFromPreview'…)` after the existing quitter-marker test, add:

```typescript
  it('appends the habitual-quitter marker outside the code span before 🚪', () => {
    const value = formatTeamLinesFromPreview([
      {
        slot: 1,
        nick: 'goku',
        globalOrdinal: 1100,
        heroOrdinal: 2200,
        habitualQuitter: true,
        isQuitter: true,
        leagueGames: 8,
      },
      {
        slot: 2,
        nick: 'vegeta',
        globalOrdinal: 3300,
        heroOrdinal: 4400,
        habitualQuitter: true,
        isGriffer: true,
        leagueGames: 8,
      },
      { slot: 3, nick: 'piccolo', globalOrdinal: 2100, heroOrdinal: 1800, leagueGames: 8 },
    ]);
    const [first, second, third] = value.split('\n');

    expect(first).toMatch(/`\s*1\s+goku\s+1100 \/ 2200`\s+⚠️ 🚪$/);
    expect(second).toMatch(/`\s*2\s+vegeta\s+3300 \/ 4400`\s+⚠️ 🐛$/);
    expect(third).not.toContain('⚠️');
    expect(third).not.toContain('🚪');
  });

  it('keeps ⚠️ next to Calibrating', () => {
    const value = formatTeamLinesFromPreview([
      {
        slot: 1,
        nick: 'goku',
        globalOrdinal: 1186,
        heroOrdinal: 1200,
        habitualQuitter: true,
        leagueGames: 4,
      },
    ]);
    expect(value).toContain('Calibrating');
    expect(value).toMatch(/`[^`]+`\s+⚠️$/);
  });
```

In `describe('buildMatchCompletedEmbed'…)`, after the test that asserts

`expect(json.footer?.text).toBe('Per player: slot  nick  global / hero (ki)');`

add:

```typescript
  it('adds the ⚠️ footer legend only when a line is flagged', () => {
    const withFlag = buildMatchCompletedEmbed(
      'match-123',
      [
        { slot: 1, nick: 'goku' },
        { slot: 7, nick: 'vegeta' },
      ],
      {
        winningTeam: 1,
        ratingPreview: {
          players: [
            {
              slot: 1,
              nick: 'goku',
              globalOrdinal: 1186,
              heroOrdinal: 1200,
              habitualQuitter: true,
              leagueGames: 8,
            },
            {
              slot: 7,
              nick: 'vegeta',
              globalOrdinal: 3300,
              heroOrdinal: 4400,
              leagueGames: 8,
            },
          ],
        },
      },
    );
    expect(withFlag.toJSON().footer?.text).toBe(
      'Per player: slot  nick  global / hero (ki) · ⚠️ quit 50%+',
    );
    expect(withFlag.toJSON().fields?.[0]?.value).toContain('⚠️');
  });
```

The existing completed-embed test (no `habitualQuitter`) must keep footer `Per player: slot  nick  global / hero (ki)` with **no** suffix.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/services/lobby/lobby-preview.test.ts`

Expected: FAIL — lines have no ⚠️; footer has no suffix.

- [ ] **Step 3: Add the DTO field and render it**

In `src/services/rating/rating-preview.ts`, on `LobbyRatingPlayerLine` after `leagueGames`:

```typescript
  /** League `/rank` quit rate is 50%+ (post–rank-reset). */
  habitualQuitter?: boolean;
```

In `src/services/lobby/lobby-preview.ts`:

1. Constant next to the team emojis:

```typescript
const HABITUAL_QUITTER_FOOTER_SUFFIX = ' · ⚠️ quit 50%+';
```

2. Update `ordinalFooterText`:

```typescript
function ordinalFooterText(
  ratingLabel: string,
  hideHero: boolean,
  showHabitualQuitterLegend: boolean,
): string {
  const base = hideHero
    ? `Per player: slot  nick  global (${ratingLabel})`
    : `Per player: slot  nick  global / hero (${ratingLabel})`;
  return showHabitualQuitterLegend ? `${base}${HABITUAL_QUITTER_FOOTER_SUFFIX}` : base;
}
```

3. Update `ordinalFooter` to pass the flag:

```typescript
  return ordinalFooterText(
    profile.ratingLabel,
    hideHero,
    preview.players.some((player) => player.habitualQuitter === true),
  );
```

4. In `formatTeamLinesFromPreview`, replace the marker block:

```typescript
      const habitualMark = player.habitualQuitter ? ' ⚠️' : '';
      const quitterMark = player.isQuitter ? ' 🚪' : '';
      const grifferMark = !player.isQuitter && player.isGriffer ? ' 🐛' : '';
      const flagMark = `${habitualMark}${quitterMark}${grifferMark}`;
```

5. Extend the function JSDoc: habitual 50%+ lines get trailing ⚠️ outside the code span (before 🚪 / 🐛).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/services/lobby/lobby-preview.test.ts`

Expected: PASS (including existing 🚪 / Calibrating / padding tests).

- [ ] **Step 5: Commit**

```bash
git add src/services/rating/rating-preview.ts src/services/lobby/lobby-preview.ts src/services/lobby/lobby-preview.test.ts
git commit -m "$(cat <<'EOF'
feat(lobby): show ⚠️ on 50%+ quit roster lines

EOF
)"
```

---

### Task 3: Set the flag on rating previews

**Files:**

- Modify: `src/services/rating/rating-preview.ts` (`loadLobbyRatingPreview`, `buildCompletedRatingPreview`)
- Modify: `src/services/lobby/lobby-preview.test.ts` (`buildCompletedRatingPreview` expects)
- Modify: `src/services/match/match-report.ts`
- Modify: `src/services/match/match-correction.ts`
- Modify: `src/services/match/match-history-preview.ts`
- Modify: `src/services/match/match-history-preview.test.ts`

**Interfaces:**

- Consumes: `habitualQuitterFromStats`, `loadMatchDisplayStatsByPlayer`
- Produces:
  - `buildCompletedRatingPreview(entries, beforeBySlot, afterBySlot, leagueGamesByPlayer, displayStatsByPlayer, winChance?)`
  - `ratingPreviewFromStoredMatchPlayers(match, leagueGamesByPlayer, displayStatsByPlayer)`
  - Every `LobbyRatingPlayerLine` from those builders has `habitualQuitter: boolean`

**Signature change:** insert `displayStatsByPlayer: Map<string, PlayerMatchDisplayStats>` as the **5th** argument of `buildCompletedRatingPreview`. Move optional `winChance` to **6th**. Update every call site in the same task (do not leave a compile break).

`leagueGames` on the line stays the existing games map (point-in-time after-match for `/match show` Calibrating). The **flag** uses `habitualQuitterFromStats(displayStatsByPlayer, playerId)` so `quits` and `games` for the rate always come from the same `/rank` stats object.

On complete/flip, `displayStats` is loaded after the match is written, so this match’s quit is included.

- [ ] **Step 1: Write the failing tests**

Update `describe('buildCompletedRatingPreview'…)` in `src/services/lobby/lobby-preview.test.ts`.

Add import:

```typescript
import type { PlayerMatchDisplayStats } from '../rating/rank-reset-display.js';
```

Helper in that describe (or file-level):

```typescript
function displayStats(
  entries: Array<[string, { games: number; quits: number }]>,
): Map<string, PlayerMatchDisplayStats> {
  return new Map(
    entries.map(([playerId, row]) => [
      playerId,
      { games: row.games, wins: 0, losses: 0, quits: row.quits },
    ]),
  );
}
```

Change both existing `buildCompletedRatingPreview(...)` calls: after the games `Map`, pass `displayStats([['p1', { games: 5, quits: 0 }], ['p2', { games: 8, quits: 0 }]])` (or matching games) **before** optional `winChance`.

Update `toEqual` players to include `habitualQuitter: false`.

Add:

```typescript
  it('sets habitualQuitter from display stats including a just-completed quit', () => {
    const preview = buildCompletedRatingPreview(
      [
        { playerId: 'p1', slot: 1, team: 1, heroId: 1, nick: 'goku', isQuitter: false },
        { playerId: 'p2', slot: 7, team: 2, heroId: 7, nick: 'vegeta', isQuitter: true },
      ],
      new Map([
        [1, { global: 1000, hero: 1000 }],
        [7, { global: 1000, hero: 1000 }],
      ]),
      new Map([
        [1, { global: 1186, hero: 1200 }],
        [7, { global: 900, hero: 850 }],
      ]),
      new Map([
        ['p1', 5],
        ['p2', 1],
      ]),
      displayStats([
        ['p1', { games: 5, quits: 0 }],
        ['p2', { games: 1, quits: 1 }],
      ]),
    );

    expect(preview.players[0]?.habitualQuitter).toBe(false);
    expect(preview.players[1]?.habitualQuitter).toBe(true);
  });
```

In `src/services/match/match-history-preview.test.ts`, change `ratingPreviewFromStoredMatchPlayers` to pass a stats map and assert the flag:

```typescript
    const displayStatsByPlayer = new Map([
      ['P1', { games: 2, wins: 1, losses: 1, quits: 1 }],
      ['P2', { games: 4, wins: 3, losses: 1, quits: 0 }],
    ]);

    const preview = ratingPreviewFromStoredMatchPlayers(
      storedMatchFixture(),
      leagueGamesByPlayer,
      displayStatsByPlayer,
    );

    expect(preview?.players).toEqual([
      expect.objectContaining({ slot: 3, leagueGames: 2, habitualQuitter: true }),
      expect.objectContaining({ slot: 8, leagueGames: 4, habitualQuitter: false }),
    ]);
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
npx vitest run src/services/lobby/lobby-preview.test.ts src/services/match/match-history-preview.test.ts
```

Expected: FAIL — `buildCompletedRatingPreview` still takes `winChance` as 5th arg / does not set `habitualQuitter`; stored preview helper has the old arity.

- [ ] **Step 3: Implement builders and call sites**

**`src/services/rating/rating-preview.ts`**

Import:

```typescript
import {
  gamesByPlayerFromStats,
  habitualQuitterFromStats,
  loadMatchDisplayStatsByPlayer,
  type PlayerMatchDisplayStats,
} from './rank-reset-display.js';
```

(`gamesByPlayerFromStats` / `loadMatchDisplayStatsByPlayer` are already imported — add the two new names.)

Change `buildCompletedRatingPreview` to:

```typescript
export function buildCompletedRatingPreview(
  entries: RatingPreviewRosterEntry[],
  beforeBySlot: Map<number, PlayerKiPair>,
  afterBySlot: Map<number, PlayerKiPair>,
  leagueGamesByPlayer: Map<string, number>,
  displayStatsByPlayer: Map<string, PlayerMatchDisplayStats>,
  winChance?: WinChancePercents,
): LobbyRatingPreview {
  const players: LobbyRatingPlayerLine[] = [...entries]
    .sort((a, b) => a.slot - b.slot)
    .map((entry) => {
      const after = afterBySlot.get(entry.slot) ?? {
        global: displayOrdinal(DEFAULT_MU, DEFAULT_SIGMA),
        hero: displayOrdinal(DEFAULT_MU, DEFAULT_SIGMA),
      };
      const before = beforeBySlot.get(entry.slot) ?? after;
      return {
        slot: entry.slot,
        nick: entry.nick,
        globalOrdinal: after.global,
        heroOrdinal: after.hero,
        globalDelta: after.global - before.global,
        heroDelta: after.hero - before.hero,
        isQuitter: entry.isQuitter,
        isGriffer: entry.isGriffer,
        showHero: entry.heroId != null,
        leagueGames: leagueGamesByPlayer.get(entry.playerId) ?? 0,
        habitualQuitter: habitualQuitterFromStats(displayStatsByPlayer, entry.playerId),
      };
    });

  return winChance ? { players, winChance } : { players };
}
```

In `loadLobbyRatingPreview`, on **both** player-line return objects (hero `null` and hero set), add:

```typescript
        habitualQuitter: habitualQuitterFromStats(displayStatsByPlayer, entry.playerId),
```

`displayStatsByPlayer` is already loaded in that function.

**`src/services/match/match-report.ts`** — completed preview call:

```typescript
    ratingPreview = buildCompletedRatingPreview(
      previewEntries,
      beforeBySlot,
      afterBySlot,
      gamesByPlayerFromStats(displayStats),
      displayStats,
      winChance,
    );
```

**`src/services/match/match-correction.ts`** — same argument order on the flip call.

**`src/services/match/match-history-preview.ts`**

Import `habitualQuitterFromStats`, `loadMatchDisplayStatsByPlayer`, and `PlayerMatchDisplayStats`.

`rebuildCompletedRatingPreview`: after `leagueGamesByPlayer` is loaded, also:

```typescript
  const displayStatsByPlayer = await loadMatchDisplayStatsByPlayer(
    match.leagueId,
    match.players.map((player) => player.playerId),
  );
```

Pass `displayStatsByPlayer` into `buildCompletedRatingPreview` before `winChanceFromSnapshots(...)`.

`ratingPreviewFromStoredMatchPlayers`:

```typescript
export function ratingPreviewFromStoredMatchPlayers(
  match: MatchWithPlayers,
  leagueGamesByPlayer: Map<string, number>,
  displayStatsByPlayer: Map<string, PlayerMatchDisplayStats>,
): LobbyRatingPreview | undefined {
  if (match.players.some((player) => player.globalKi == null)) {
    return undefined;
  }

  return {
    players: match.players.map((player) => ({
      slot: player.slot,
      nick: player.player.username,
      globalOrdinal: player.globalKi!,
      heroOrdinal: player.heroKi ?? player.globalKi!,
      globalDelta: player.globalKiDelta ?? undefined,
      heroDelta: player.heroKiDelta ?? undefined,
      isQuitter: player.isQuitter,
      showHero: player.heroId != null && player.heroKi != null,
      leagueGames: leagueGamesByPlayer.get(player.playerId) ?? 0,
      habitualQuitter: habitualQuitterFromStats(displayStatsByPlayer, player.playerId),
    })),
  };
}
```

`resolveCompletedRatingPreview`: load stats in parallel with games:

```typescript
  const playerIds = match.players.map((player) => player.playerId);
  const [leagueGamesByPlayer, displayStatsByPlayer] = await Promise.all([
    loadLeagueGamesAfterMatch(match),
    loadMatchDisplayStatsByPlayer(match.leagueId, playerIds),
  ]);
  const stored = ratingPreviewFromStoredMatchPlayers(
    match,
    leagueGamesByPlayer,
    displayStatsByPlayer,
  );
```

`matchPlayer.findMany` will run twice (point-in-time games + display stats). Existing history tests mock `findMany` with one `mockResolvedValue`; that array is reused. Rows without `isQuitter` count as 0 quits — the point-in-time games test must still pass. If a test fails because the mock row shape lacks `match.completedAt` for the display-stats mapper, add `isQuitter: false` and `match: { completedAt, status: 'COMPLETED' }` on the fixture rows — do **not** change the Calibrating games source (`loadLeagueGamesAfterMatch`).

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
npx vitest run src/services/lobby/lobby-preview.test.ts src/services/match/match-history-preview.test.ts src/services/rating/rank-reset-display.test.ts
npx tsc --noEmit
```

Expected: PASS / no type errors.

Then:

```bash
npx vitest run
```

Expected: PASS (full suite).

- [ ] **Step 5: Commit**

```bash
git add src/services/rating/rating-preview.ts src/services/lobby/lobby-preview.test.ts src/services/match/match-report.ts src/services/match/match-correction.ts src/services/match/match-history-preview.ts src/services/match/match-history-preview.test.ts
git commit -m "$(cat <<'EOF'
feat(match): flag habitual quitters on rating previews

EOF
)"
```

---

## Spec coverage (self-review)

| Spec requirement | Task |
| ---------------- | ---- |
| `isHabitualQuitter` rule + examples | 1 |
| Cancelled-only (`games = 0`, `quits ≥ 1`) | 1 |
| Same stats as `/rank` / rank reset | 1 + 3 (`loadMatchDisplayStatsByPlayer`) |
| DTO `habitualQuitter` | 2 (field) + 3 (set) |
| ⚠️ outside span; order ⚠️ 🚪 🐛 | 2 |
| Calibrating + ⚠️ | 2 |
| Footer legend only when flagged | 2 |
| PENDING / IN_PROGRESS via `loadLobbyRatingPreview` | 3 |
| Completed via `buildCompletedRatingPreview` + complete/flip | 3 |
| After-match quit can newly cross 50% | 3 (stats loaded after write) |
| `/match show` completed roster | 3 (`resolveCompletedRatingPreview`) |
| Nick-only fallback unflagged | 2 (no DTO field) |
| No schema / no `/rank` / no leaderboard | none (intentionally omitted) |
