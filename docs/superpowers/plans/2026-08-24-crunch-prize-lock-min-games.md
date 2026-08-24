# Crunch prize-lock min games & strict_crunch preset — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace daily prize-lock attendance with a tunable min finished-game count in the fixed crunch window, and add `/config decay preset name:strict_crunch` (grace 3, flat −100 ki/day, 7 games / 7-day window).

**Architecture:** Extend `League` + `resolveDecaySettings` with `prizeLockMinGames`. Rewrite prize eligibility in `rating-decay.ts` to count qualifying matches in `[crunchStart, min(now, seasonEndsAt)]`. Wire leaderboard load to a batch count query. Add setters/preset in `league-decay.ts` and Discord subcommands under `/config decay`. Update staff/public docs.

**Tech Stack:** TypeScript ESM, Prisma, discord.js v14, Vitest

**Spec:** [`docs/superpowers/specs/2026-08-24-crunch-prize-lock-min-games-design.md`](../specs/2026-08-24-crunch-prize-lock-min-games-design.md)

## Global Constraints

- Scope: `general` (league-scoped; no WC3-only imports in decay/prize core)
- English-only user-facing strings
- Mid-season decay math/defaults unchanged
- Qualifying game = `COMPLETED` + `isQuitter = false`
- Count replaces “game every UTC day”; default `prizeLockMinGames = 1`
- No new production env / SSM keys
- ESM imports use `.js` extension; named exports
- Conventional Commits
- Run `npm run format:check` before claiming a PR-ready branch

## File map

| File                                                        | Role                                     |
| ----------------------------------------------------------- | ---------------------------------------- |
| `prisma/schema.prisma`                                      | `decayPrizeLockMinGames Int?`            |
| `prisma/migrations/<ts>_prize_lock_min_games/migration.sql` | Additive column                          |
| `src/services/rating/decay-settings.ts`                     | Default, resolve, bounds, select         |
| `src/services/rating/decay-settings.test.ts`                | Coalesce + bounds tests                  |
| `src/services/rating/rating-decay.ts`                       | Window + count eligibility + loader      |
| `src/services/rating/rating-decay.test.ts`                  | Eligibility unit tests                   |
| `src/services/rating/index.ts`                              | Re-exports                               |
| `src/services/leaderboard/leaderboard.ts`                   | Use count loader + minGames eligibility  |
| `src/services/leaderboard/leaderboard-embed.ts`             | Footnote uses min games                  |
| `src/services/leaderboard/leaderboard-embed.test.ts`        | Footnote copy                            |
| `src/services/league/league-decay.ts`                       | Set/clear min games + `applyDecayPreset` |
| `src/services/league/league-decay.test.ts`                  | Preset column writes (extend or add)     |
| `src/services/league/league-rollover.ts`                    | Copy `decayPrizeLockMinGames`            |
| `src/services/league/index.ts`                              | Export new helpers                       |
| `src/commands/config/config.ts`                             | Subcommands + view line                  |
| Docs (`a7`, `06`, `a5`, related specs)                      | Player/staff wording                     |

---

### Task 1: Schema — `decayPrizeLockMinGames`

**Files:**

- Modify: `prisma/schema.prisma` (`League`, after `decayPrizeLockEnabled`)
- Create: `prisma/migrations/20260824150000_prize_lock_min_games/migration.sql`

**Interfaces:**

- Produces: `League.decayPrizeLockMinGames Int?` (`NULL` = code default 1)

- [ ] **Step 1: Add column to schema**

```prisma
  decayPrizeLockEnabled         Boolean?
  decayPrizeLockMinGames        Int?
```

- [ ] **Step 2: Add migration SQL**

```sql
-- AlterTable
ALTER TABLE "League" ADD COLUMN "decayPrizeLockMinGames" INTEGER;
```

- [ ] **Step 3: Generate client**

Run: `npx prisma generate`  
Expected: success

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260824150000_prize_lock_min_games/migration.sql
git commit -m "$(cat <<'EOF'
feat(rating): add league prize-lock min-games column

EOF
)"
```

---

### Task 2: Decay settings — `prizeLockMinGames`

**Files:**

- Modify: `src/services/rating/decay-settings.ts`
- Modify: `src/services/rating/decay-settings.test.ts`

**Interfaces:**

- Produces:
  - `DEFAULT_PRIZE_LOCK_MIN_GAMES = 1`
  - `ResolvedDecaySettings.prizeLockMinGames: number`
  - `DecaySettingField` includes `'prizeLockMinGames'`
  - `assertDecaySettingBounds('prizeLockMinGames', value)` → `1..=50`
  - `DECAY_SETTINGS_SELECT.decayPrizeLockMinGames: true`

- [ ] **Step 1: Write failing tests**

In `decay-settings.test.ts`, add:

```typescript
it('defaults prizeLockMinGames to 1', () => {
  expect(resolveDecaySettings(null).prizeLockMinGames).toBe(1);
  expect(resolveDecaySettings({}).prizeLockMinGames).toBe(1);
});

it('uses league override for prizeLockMinGames', () => {
  expect(resolveDecaySettings({ decayPrizeLockMinGames: 7 }).prizeLockMinGames).toBe(7);
});

it('rejects prizeLockMinGames out of bounds', () => {
  expect(() => assertDecaySettingBounds('prizeLockMinGames', 0)).toThrow(/between 1 and 50/);
  expect(() => assertDecaySettingBounds('prizeLockMinGames', 51)).toThrow(/between 1 and 50/);
  expect(assertDecaySettingBounds('prizeLockMinGames', 7)).toBe(7);
});
```

- [ ] **Step 2: Run tests — expect FAIL**

Run: `npx vitest run src/services/rating/decay-settings.test.ts`  
Expected: FAIL (missing field / unknown assert case)

- [ ] **Step 3: Implement settings**

In `decay-settings.ts`:

```typescript
export const DEFAULT_PRIZE_LOCK_MIN_GAMES = 1;
```

Add `decayPrizeLockMinGames?: number | null` to `DecaySettingsSource`.  
Add `prizeLockMinGames: number` to `ResolvedDecaySettings` and `DEFAULT_DECAY_SETTINGS` (`DEFAULT_PRIZE_LOCK_MIN_GAMES`).  
In `resolveDecaySettings`, coalesce with `coalesceInt(league.decayPrizeLockMinGames, DEFAULT_PRIZE_LOCK_MIN_GAMES)`.  
Extend `DecaySettingField` with `'prizeLockMinGames'`.  
In `assertDecaySettingBounds`, case `'prizeLockMinGames'`: integer `1..50`.  
Add `decayPrizeLockMinGames: true` to `DECAY_SETTINGS_SELECT`.

- [ ] **Step 4: Run tests — expect PASS**

Run: `npx vitest run src/services/rating/decay-settings.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/rating/decay-settings.ts src/services/rating/decay-settings.test.ts
git commit -m "$(cat <<'EOF'
feat(rating): resolve prize-lock min games setting

EOF
)"
```

---

### Task 3: Prize-lock window + count eligibility

**Files:**

- Modify: `src/services/rating/rating-decay.ts`
- Modify: `src/services/rating/rating-decay.test.ts`
- Modify: `src/services/rating/index.ts` (re-exports)

**Interfaces:**

- Produces:
  - `resolvePrizeLockWindow(league, now): { start: Date; end: Date } | null`
  - `isPrizeEligibleFromGameCount(gameCount: number, league, now): boolean`
  - `loadQualifyingGameCountsByPlayer(leagueId, playerIds, start, end, db?): Promise<Map<string, number>>`
- Removes (or stops using for medals): `hasQualifyingActivityEveryUtcDay` as the medal rule; keep helpers only if still needed by tests — prefer delete dead day-based medal path:
  - Deprecate public use of `isPrizeEligibleFromActivityDays` → replace with count API
  - `loadQualifyingActivityUtcDaysByPlayer` → remove if unused after Task 4

**Window rules (exact):**

```text
if !prizeLockEnabled or !in crunch → null
crunchStart = resolveCrunchStart(league)  // existing; null → null window
end = league.seasonEndsAt != null
  ? new Date(Math.min(now.getTime(), league.seasonEndsAt.getTime()))
  : now
return { start: crunchStart, end }
```

**Eligible:** `gameCount >= leagueDecaySettings(league).prizeLockMinGames` when window non-null.

**Loader:** `matchPlayer.findMany` where `isQuitter: false`, match `COMPLETED`, `leagueId`, `completedAt: { gte: start, lte: end }`, then count rows per `playerId` (or `groupBy` if available).

- [ ] **Step 1: Write failing eligibility tests**

Replace / rewrite `describe('isPrizeEligibleFromActivityDays')` in `rating-decay.test.ts`:

```typescript
describe('isPrizeEligibleFromGameCount', () => {
  const seasonLeague = {
    status: 'ACTIVE' as const,
    decayEnabled: true,
    seasonEndsAt: new Date('2026-08-23T00:00:00.000Z'),
    crunchStartedAt: null,
    archivedAt: null,
    settings: { ...DEFAULT_DECAY_SETTINGS, prizeLockMinGames: 7 },
  };
  const now = new Date('2026-08-20T12:00:00.000Z');

  it('requires at least prizeLockMinGames in the crunch window', () => {
    expect(isPrizeEligibleFromGameCount(7, seasonLeague, now)).toBe(true);
    expect(isPrizeEligibleFromGameCount(6, seasonLeague, now)).toBe(false);
  });

  it('defaults to min 1 when settings omit override', () => {
    const league = {
      ...seasonLeague,
      settings: { ...DEFAULT_DECAY_SETTINGS, prizeLockMinGames: 1 },
    };
    expect(isPrizeEligibleFromGameCount(1, league, now)).toBe(true);
    expect(isPrizeEligibleFromGameCount(0, league, now)).toBe(false);
  });

  it('returns false when prize lock disabled', () => {
    const league = {
      ...seasonLeague,
      settings: { ...DEFAULT_DECAY_SETTINGS, prizeLockEnabled: false, prizeLockMinGames: 1 },
    };
    expect(isPrizeEligibleFromGameCount(99, league, now)).toBe(false);
  });
});

describe('resolvePrizeLockWindow', () => {
  it('caps end at seasonEndsAt when now is later', () => {
    const league = {
      status: 'ACTIVE' as const,
      decayEnabled: true,
      seasonEndsAt: new Date('2026-08-23T00:00:00.000Z'),
      crunchStartedAt: null,
      archivedAt: null,
    };
    const afterEnd = new Date('2026-08-24T12:00:00.000Z');
    // still in crunch only if isLeagueInCrunch true — use a now inside crunch:
    const now = new Date('2026-08-20T12:00:00.000Z');
    const window = resolvePrizeLockWindow(league, now);
    expect(window?.start.toISOString()).toBe(resolveCrunchStart(league)!.toISOString());
    expect(window?.end.getTime()).toBe(now.getTime());
  });
});
```

Also update `resolvePrizeLockWindowDays` tests: either migrate them to `resolvePrizeLockWindow` or keep `resolvePrizeLockWindowDays` as a thin adapter only if something still needs day indices — **prefer removing day-index window** once leaderboard no longer uses it (Task 4). In this task, implement Date window + count eligibility; leave old functions exporting temporarily if needed to avoid breaking compile until Task 4.

- [ ] **Step 2: Run tests — expect FAIL**

Run: `npx vitest run src/services/rating/rating-decay.test.ts`  
Expected: FAIL (missing symbols)

- [ ] **Step 3: Implement**

Add `resolvePrizeLockWindow`, `isPrizeEligibleFromGameCount`, `loadQualifyingGameCountsByPlayer`.  
Implement `isPrizeEligibleFromGameCount` as:

```typescript
export function isPrizeEligibleFromGameCount(
  gameCount: number,
  league: DecayLeagueContext,
  now: Date,
): boolean {
  const window = resolvePrizeLockWindow(league, now);
  if (!window) return false;
  return gameCount >= leagueDecaySettings(league).prizeLockMinGames;
}
```

Re-export new symbols from `src/services/rating/index.ts`.

- [ ] **Step 4: Run tests — expect PASS**

Run: `npx vitest run src/services/rating/rating-decay.test.ts`  
Expected: PASS (update/remove obsolete day-based medal tests in this commit if they conflict)

- [ ] **Step 5: Commit**

```bash
git add src/services/rating/rating-decay.ts src/services/rating/rating-decay.test.ts src/services/rating/index.ts
git commit -m "$(cat <<'EOF'
feat(rating): count games for crunch prize-lock eligibility

EOF
)"
```

---

### Task 4: Leaderboard wiring + footnote copy

**Files:**

- Modify: `src/services/leaderboard/leaderboard.ts`
- Modify: `src/services/leaderboard/leaderboard-embed.ts`
- Modify: `src/services/leaderboard/leaderboard-embed.test.ts`
- Modify: `src/services/leaderboard/leaderboard-channel.ts` (if it passes footnote args)
- Clean up unused day-loader exports from `rating-decay.ts` / `index.ts` if unused

**Interfaces:**

- Consumes: `resolvePrizeLockWindow`, `loadQualifyingGameCountsByPlayer`, `isPrizeEligibleFromGameCount`, `prizeLockMinGames`
- Produces: embeds that show min-games footnote

**Footnote API change:**

```typescript
export function formatPrizeLockFootnote(options: {
  minGames: number;
  crunchWindowDays: number;
}): string {
  const { minGames, crunchWindowDays } = options;
  if (minGames === 1) {
    return crunchWindowDays === 7
      ? 'Medals require at least 1 finished game during the season crunch week.'
      : `Medals require at least 1 finished game during the ${crunchWindowDays}-day season crunch.`;
  }
  return crunchWindowDays === 7
    ? `Medals require at least ${minGames} finished games during the season crunch week.`
    : `Medals require at least ${minGames} finished games during the ${crunchWindowDays}-day season crunch.`;
}
```

Update `PRIZE_LOCK_FOOTNOTE` constant to match default (min 1 / 7d) or remove if unused.

Pass `prizeLockMinGames` through page/live embed options alongside `crunchWindowDays` (add optional `prizeLockMinGames?: number` on page type / live options; default `DEFAULT_DECAY_SETTINGS.prizeLockMinGames`).

- [ ] **Step 1: Write failing embed test**

```typescript
it('mentions min finished games in prize-lock footnote', () => {
  expect(formatPrizeLockFootnote({ minGames: 7, crunchWindowDays: 7 })).toContain(
    'at least 7 finished games',
  );
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `npx vitest run src/services/leaderboard/leaderboard-embed.test.ts`

- [ ] **Step 3: Wire leaderboard load**

In `loadEligibleOverallRows`, replace day-set load with:

```typescript
const prizeLockWindow =
  prizeLockActive && leagueCtx ? resolvePrizeLockWindow(leagueCtx, now) : null;
const gameCountsByPlayer =
  prizeLockWindow != null
    ? await loadQualifyingGameCountsByPlayer(
        leagueId,
        ratings.map((row) => row.playerId),
        prizeLockWindow.start,
        prizeLockWindow.end,
      )
    : null;
// ...
const gameCount = gameCountsByPlayer?.get(row.playerId) ?? 0;
const prizeEligible = isPrizeEligibleFromGameCount(gameCount, leagueCtx, now);
```

Thread `prizeLockMinGames` into return value / page / live embeds. Update all `formatPrizeLockFootnote` call sites.

- [ ] **Step 4: Run related tests**

Run: `npx vitest run src/services/leaderboard/ src/services/rating/rating-decay.test.ts`  
Expected: PASS

- [ ] **Step 5: Delete dead day-based medal helpers** if nothing imports them; fix exports.

- [ ] **Step 6: Commit**

```bash
git add src/services/leaderboard/ src/services/rating/rating-decay.ts src/services/rating/index.ts
git commit -m "$(cat <<'EOF'
feat(leaderboard): use min-games prize lock for crunch medals

EOF
)"
```

---

### Task 5: League service — set/clear min games + `strict_crunch` preset + rollover

**Files:**

- Modify: `src/services/league/league-decay.ts`
- Create or modify: `src/services/league/league-decay.test.ts`
- Modify: `src/services/league/league-rollover.ts` (`buildSuccessorLeagueData` copy list)
- Modify: `src/services/league/league-rollover.test.ts` (fixture includes new field)
- Modify: `src/services/league/index.ts` (exports)

**Interfaces:**

- Produces:
  - `setDecayPrizeLockMinGames(leagueId, games: number): Promise<void>`
  - `clearDecayPrizeLockMinGames(leagueId): Promise<void>`
  - `DECAY_PRESET_STRICT_CRUNCH = 'strict_crunch'`
  - `applyDecayPreset(leagueId, name: string): Promise<void>`
  - Throws `Error('Unknown decay preset. Known: strict_crunch.')` for bad names

**Preset write (exact columns):**

```typescript
export const STRICT_CRUNCH_PRESET_DATA = {
  decayCrunchGraceDays: 3,
  decayCrunchTier1Ki: 100,
  decayCrunchTier2Ki: 100,
  decayCrunchWindowDays: 7,
  decayPrizeLockMinGames: 7,
} as const;

export async function applyDecayPreset(leagueId: string, name: string): Promise<void> {
  if (name !== 'strict_crunch') {
    throw new Error('Unknown decay preset. Known: strict_crunch.');
  }
  await prisma.league.update({
    where: { id: leagueId },
    data: { ...STRICT_CRUNCH_PRESET_DATA },
  });
}
```

Do **not** write `decayEnabled`, mid-season fields, or season/crunch timestamps.

- [ ] **Step 1: Write failing preset test**

```typescript
it('applyDecayPreset strict_crunch writes crunch overrides', async () => {
  // mock prisma.league.update — assert data equals STRICT_CRUNCH_PRESET_DATA
});

it('applyDecayPreset rejects unknown names', async () => {
  await expect(applyDecayPreset('league-1', 'nope')).rejects.toThrow(/Unknown decay preset/);
});
```

Follow existing vitest mock style in `league-decay.test.ts` / `league-rollover.test.ts` if present; otherwise add a small mock of `prisma.league.update`.

- [ ] **Step 2: Implement setters + preset + rollover copy `decayPrizeLockMinGames: source.decayPrizeLockMinGames`**

- [ ] **Step 3: Run tests**

Run: `npx vitest run src/services/league/league-decay.test.ts src/services/league/league-rollover.test.ts`  
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/services/league/
git commit -m "$(cat <<'EOF'
feat(league): add prize-lock min games and strict_crunch preset

EOF
)"
```

---

### Task 6: `/config decay` commands + view line

**Files:**

- Modify: `src/commands/config/config.ts`

**Interfaces:**

- Consumes: `setDecayPrizeLockMinGames`, `clearDecayPrizeLockMinGames`, `applyDecayPreset`
- Slash:
  - `/config decay prize_lock_min_games games:1–50`
  - `/config decay clear_prize_lock_min_games`
  - `/config decay preset name:strict_crunch` (string choice)

- [ ] **Step 1: Extend `formatDecayLine`**

Add after prize lock on/off:

```typescript
`prize min games \`${settings.prizeLockMinGames}\``,
```

- [ ] **Step 2: Add subcommands** (same permissions / `withSubcommandLeagueOption` as siblings)

```typescript
.addSubcommand((subcommand) =>
  withSubcommandLeagueOption(
    subcommand
      .setName('prize_lock_min_games')
      .setDescription('Set finished games required for crunch medals')
      .addIntegerOption((option) =>
        option
          .setName('games')
          .setDescription('Minimum finished non-quit games in the crunch window (1–50)')
          .setRequired(true)
          .setMinValue(1)
          .setMaxValue(50),
      ),
  ),
)
.addSubcommand((subcommand) =>
  withSubcommandLeagueOption(
    subcommand
      .setName('clear_prize_lock_min_games')
      .setDescription('Reset prize-lock min games to the code default (1)'),
  ),
)
.addSubcommand((subcommand) =>
  withSubcommandLeagueOption(
    subcommand
      .setName('preset')
      .setDescription('Apply a named decay/crunch preset')
      .addStringOption((option) =>
        option
          .setName('name')
          .setDescription('Preset to apply')
          .setRequired(true)
          .addChoices({ name: 'Strict crunch (3d/−100ki / 7 games)', value: 'strict_crunch' }),
      ),
  ),
)
```

Update `prize_lock` option description from “daily games” to “finished-game minimum during crunch”.

- [ ] **Step 3: Handle execute branches** (mirror `streak_cap` / `prize_lock` error handling)

Reply examples:

- `Prize-lock minimum set to \`7\` finished games.`
- `Prize-lock minimum reset to the code default (1).`
- `Applied decay preset \`strict_crunch\` (crunch grace 3d, −100/−100 ki/day, window 7d, medals need 7 games).`

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/commands/config/config.ts src/services/league/index.ts
git commit -m "$(cat <<'EOF'
feat(config): expose prize-lock min games and decay preset

EOF
)"
```

---

### Task 7: Docs + related specs

**Files:**

- Modify: `docs/discord/staff/a7-rating-decay.md`
- Modify: `docs/discord/public/06-rank-and-boards.md`
- Modify: `docs/discord/staff/a5-admin-cheat-sheet.md` (mention `preset` if space)
- Modify: `docs/superpowers/specs/2026-08-23-rating-decay-design.md` (short note: prize lock superseded by count + min games)
- Modify: `docs/superpowers/specs/2026-08-24-league-decay-config-design.md` (add rows for min games + preset)

**Staff a7 — prize lock + preset block (replace daily wording):**

```markdown
**Prize lock:** 🥇🥈🥉 need at least **N** finished non-quit games in the **crunch window** (default **N = 1**). Rank `#n` stays.
```

/config decay prize_lock_min_games games:7 league:YourLeague
/config decay clear_prize_lock_min_games
/config decay preset name:strict_crunch league:YourLeague

```

**`strict_crunch` preset:** crunch grace **3**, flat **−100/−100 ki/day**, window **7**, min games **7**. Does not toggle decay on/off or set season end.
```

**Public 06:**

Replace “completed game on each day of crunch so far” with: finished games during crunch (default at least **1**; some leagues require more, e.g. **7**).

Keep Discord message length limits in mind for a7 (trim if over limit — prefer cutting mid-season examples before dropping the preset recipe).

- [ ] **Step 1: Edit the docs listed above**

- [ ] **Step 2: Format check**

Run: `npm run format:check`  
Expected: PASS (run `npm run format` if needed)

- [ ] **Step 3: Commit**

```bash
git add docs/
git commit -m "$(cat <<'EOF'
docs: document crunch min-games prize lock and strict_crunch

EOF
)"
```

---

### Task 8: Verification sweep

- [ ] **Step 1: Run focused + broader tests**

```bash
npx vitest run src/services/rating/decay-settings.test.ts \
  src/services/rating/rating-decay.test.ts \
  src/services/leaderboard/ \
  src/services/league/league-rollover.test.ts \
  src/services/league/league-decay.test.ts
npm run typecheck
npm run format:check
```

Expected: all PASS

- [ ] **Step 2: Manual checklist (staff)**

1. `/config decay preset name:strict_crunch`
2. `/config view` shows crunch grace 3, −100/−100, prize min games 7
3. During crunch, medals skip players with &lt; 7 qualifying finishes in window
4. `/config decay clear_prize_lock_min_games` → min games back to 1

- [ ] **Step 3: No further commit unless fixes were needed**

---

## Spec coverage (self-review)

| Spec requirement                         | Task                 |
| ---------------------------------------- | -------------------- |
| `decayPrizeLockMinGames` column          | 1                    |
| Default 1 via resolve                    | 2                    |
| Count eligibility in fixed crunch window | 3–4                  |
| Cap end at `seasonEndsAt`                | 3                    |
| Batch count loader                       | 3–4                  |
| Embed footnote N games                   | 4                    |
| Set/clear commands                       | 5–6                  |
| `strict_crunch` preset fields            | 5–6                  |
| Rollover copy                            | 5                    |
| `/config view`                           | 6                    |
| Staff/public docs + related specs        | 7                    |
| Mid-season unchanged / no env keys       | Global + preset data |

No dual daily/count mode (intentionally omitted). No mid-season preset.
