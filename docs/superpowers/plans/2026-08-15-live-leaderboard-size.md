# Live Leaderboard Size Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let operators set per-league live overall leaderboard size (10–100); render the permanent message as multiple embeds of 25 rows each.

**Architecture:** Store `League.leaderboardSize` (default 10). Live setup/refresh loads that size, fetches top-N, chunks by 25, and edits one Discord message with an embeds array. `/config set|clear leaderboard_size` persists and refreshes. Slash `/leaderboard show` stays at 10/page.

**Tech Stack:** TypeScript ESM, Prisma, discord.js v14, Vitest

**Spec:** `docs/superpowers/specs/2026-08-15-live-leaderboard-size-design.md`

## Global Constraints

- Scope: `general` (per-league; not game-specific)
- English-only user-facing strings and errors
- Live size min **10**, max **100**, default **10**, chunk **25**
- Reject out-of-range `/config set` (do not silently clamp)
- `/leaderboard show` page size remains **10**
- ESM imports use `.js` extension; named exports
- No new production env / SSM keys

## File map

| File                                                   | Role                                                                                                                                 |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `prisma/schema.prisma`                                 | Add `League.leaderboardSize Int @default(10)`                                                                                        |
| `prisma/migrations/…_add_league_leaderboard_size/`     | Migration SQL                                                                                                                        |
| `src/services/leaderboard/leaderboard.ts`              | Replace fixed `LIVE_LEADERBOARD_SIZE` with min/max/default/chunk constants + `assertLiveLeaderboardSize` + `chunkLeaderboardEntries` |
| `src/services/leaderboard/leaderboard.test.ts`         | Tests for assert + chunk                                                                                                             |
| `src/services/leaderboard/leaderboard-embed.ts`        | `buildOverallLiveLeaderboardEmbeds`                                                                                                  |
| `src/services/leaderboard/leaderboard-embed.test.ts`   | Multi-embed / timestamp / empty tests                                                                                                |
| `src/services/leaderboard/leaderboard-channel.ts`      | Read size; send/edit embeds array                                                                                                    |
| `src/services/leaderboard/leaderboard-channel.test.ts` | Mock size; assert `embeds` passed                                                                                                    |
| `src/services/leaderboard/index.ts`                    | Re-export new symbols as needed                                                                                                      |
| `src/services/league/league-wc3stats.ts`               | Resolve + set/clear size                                                                                                             |
| `src/services/league/index.ts`                         | Re-export setters                                                                                                                    |
| `src/commands/config/config.ts`                        | set/clear/view `leaderboard_size`                                                                                                    |
| `docs/discord/staff/a1-roles-and-setup.md`             | Document size config                                                                                                                 |
| `docs/discord/staff/a5-admin-cheat-sheet.md`           | One-line cheat                                                                                                                       |

---

### Task 1: Schema + size constants + league setters

**Files:**

- Modify: `prisma/schema.prisma`
- Create: migration via `npm run db:migrate`
- Modify: `src/services/leaderboard/leaderboard.ts`
- Modify: `src/services/leaderboard/leaderboard.test.ts` (or create if helpers need a home)
- Modify: `src/services/league/league-wc3stats.ts`
- Modify: `src/services/league/index.ts`
- Modify: `src/services/leaderboard/index.ts` (export new constants/helpers)

**Interfaces:**

- Produces:
  - `LIVE_LEADERBOARD_MIN_SIZE = 10`
  - `LIVE_LEADERBOARD_MAX_SIZE = 100`
  - `LIVE_LEADERBOARD_DEFAULT_SIZE = 10`
  - `LIVE_LEADERBOARD_CHUNK_SIZE = 25`
  - `assertLiveLeaderboardSize(size: number): number` — throws `LeaderboardServiceError` with `Live leaderboard size must be between 10 and 100.` if not an integer in range; returns size
  - `chunkLeaderboardEntries<T>(entries: T[], chunkSize?: number): T[][]`
  - `ResolvedLeagueConfig.leaderboardSize: number`
  - `setLeagueLeaderboardSize(leagueId: string, size: number): Promise<void>`
  - `clearLeagueLeaderboardSize(leagueId: string): Promise<void>` — sets to 10
- Removes: sole use of `LIVE_LEADERBOARD_SIZE = 10` as the live limit (delete constant after Task 3 wires size; in this task replace the export with the four new constants)

- [ ] **Step 1: Write failing tests for assert + chunk**

Add to `src/services/leaderboard/leaderboard.test.ts` (create file if missing):

```typescript
import { describe, expect, it } from 'vitest';
import {
  LeaderboardServiceError,
  LIVE_LEADERBOARD_CHUNK_SIZE,
  assertLiveLeaderboardSize,
  chunkLeaderboardEntries,
} from './leaderboard.js';

describe('assertLiveLeaderboardSize', () => {
  it('accepts bounds and mid values', () => {
    expect(assertLiveLeaderboardSize(10)).toBe(10);
    expect(assertLiveLeaderboardSize(50)).toBe(50);
    expect(assertLiveLeaderboardSize(100)).toBe(100);
  });

  it('rejects out of range and non-integers', () => {
    expect(() => assertLiveLeaderboardSize(9)).toThrow(LeaderboardServiceError);
    expect(() => assertLiveLeaderboardSize(101)).toThrow(LeaderboardServiceError);
    expect(() => assertLiveLeaderboardSize(10.5)).toThrow(LeaderboardServiceError);
    expect(() => assertLiveLeaderboardSize(9)).toThrow(
      /Live leaderboard size must be between 10 and 100/,
    );
  });
});

describe('chunkLeaderboardEntries', () => {
  it('chunks by 25', () => {
    const entries = Array.from({ length: 26 }, (_, i) => i);
    expect(chunkLeaderboardEntries(entries)).toEqual([entries.slice(0, 25), entries.slice(25)]);
    expect(chunkLeaderboardEntries(entries.slice(0, 10))).toEqual([entries.slice(0, 10)]);
    expect(chunkLeaderboardEntries(Array.from({ length: 100 }, (_, i) => i))).toHaveLength(4);
    expect(LIVE_LEADERBOARD_CHUNK_SIZE).toBe(25);
  });

  it('returns empty array for empty input', () => {
    expect(chunkLeaderboardEntries([])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL**

Run: `npm test -- src/services/leaderboard/leaderboard.test.ts`

Expected: FAIL — `assertLiveLeaderboardSize` / `chunkLeaderboardEntries` not exported (or existing file fails on new imports).

- [ ] **Step 3: Add Prisma field + migrate**

In `prisma/schema.prisma` on `League`, after `leaderboardMessageId`:

```prisma
  leaderboardSize         Int      @default(10)
```

Run: `npm run db:migrate -- --name add_league_leaderboard_size`

Expected: migration created and applied to local DB; client regenerated.

- [ ] **Step 4: Implement constants + helpers in `leaderboard.ts`**

Replace:

```typescript
export const LIVE_LEADERBOARD_SIZE = 10;
```

With:

```typescript
export const LIVE_LEADERBOARD_MIN_SIZE = 10;
export const LIVE_LEADERBOARD_MAX_SIZE = 100;
export const LIVE_LEADERBOARD_DEFAULT_SIZE = 10;
export const LIVE_LEADERBOARD_CHUNK_SIZE = 25;

/** Validate live board size; throws LeaderboardServiceError if invalid. */
export function assertLiveLeaderboardSize(size: number): number {
  if (
    !Number.isInteger(size) ||
    size < LIVE_LEADERBOARD_MIN_SIZE ||
    size > LIVE_LEADERBOARD_MAX_SIZE
  ) {
    throw new LeaderboardServiceError('Live leaderboard size must be between 10 and 100.');
  }
  return size;
}

/** Split entries into fixed-size chunks (default 25). Empty input → []. */
export function chunkLeaderboardEntries<T>(
  entries: T[],
  chunkSize: number = LIVE_LEADERBOARD_CHUNK_SIZE,
): T[][] {
  if (entries.length === 0) {
    return [];
  }
  const chunks: T[][] = [];
  for (let i = 0; i < entries.length; i += chunkSize) {
    chunks.push(entries.slice(i, i + chunkSize));
  }
  return chunks;
}
```

Temporarily keep a deprecated alias if needed for compile until Task 3:

```typescript
/** @deprecated Use league leaderboardSize; default only. */
export const LIVE_LEADERBOARD_SIZE = LIVE_LEADERBOARD_DEFAULT_SIZE;
```

Remove the alias in Task 3 once channel code no longer imports it.

Export new symbols from `src/services/leaderboard/index.ts`.

- [ ] **Step 5: League resolve + set/clear**

In `league-wc3stats.ts`:

```typescript
import {
  LIVE_LEADERBOARD_DEFAULT_SIZE,
  assertLiveLeaderboardSize,
} from '../leaderboard/leaderboard.js';
```

Extend `ResolvedLeagueConfig`:

```typescript
leaderboardSize: number;
```

In `resolveLeagueConfig`:

```typescript
    leaderboardSize:
      row?.leaderboardSize != null
        ? row.leaderboardSize
        : LIVE_LEADERBOARD_DEFAULT_SIZE,
```

(Prisma default means row always has a number after migrate; still fall back to 10.)

Add:

```typescript
export async function setLeagueLeaderboardSize(leagueId: string, size: number): Promise<void> {
  const safe = assertLiveLeaderboardSize(size);
  await prisma.league.update({
    where: { id: leagueId },
    data: { leaderboardSize: safe },
  });
}

export async function clearLeagueLeaderboardSize(leagueId: string): Promise<void> {
  await prisma.league.update({
    where: { id: leagueId },
    data: { leaderboardSize: LIVE_LEADERBOARD_DEFAULT_SIZE },
  });
}
```

Re-export from `src/services/league/index.ts`.

Avoid circular imports: if `league-wc3stats` → `leaderboard` → `league` becomes a cycle, move `assertLiveLeaderboardSize` + constants into a tiny `src/services/leaderboard/live-size.ts` and import from both. Prefer no cycle; only split if the bundler/tests show one.

- [ ] **Step 6: Run tests — expect PASS**

Run: `npm test -- src/services/leaderboard/leaderboard.test.ts`

Expected: PASS for assert + chunk (other existing tests in that file still pass).

- [ ] **Step 7: Commit**

```bash
git add prisma/schema.prisma prisma/migrations src/services/leaderboard src/services/league
git commit -m "$(cat <<'EOF'
feat: add per-league live leaderboard size field

Store size on League with validation helpers and 25-row chunking.
EOF
)"
```

---

### Task 2: Multi-embed live builder

**Files:**

- Modify: `src/services/leaderboard/leaderboard-embed.ts`
- Modify: `src/services/leaderboard/leaderboard-embed.test.ts`
- Modify: `src/services/leaderboard/index.ts`

**Interfaces:**

- Consumes: `formatOverallTable`, `chunkLeaderboardEntries`, `OverallLeaderboardEntry`
- Produces:
  - `buildOverallLiveLeaderboardEmbeds(entries: OverallLeaderboardEntry[], updatedAt: Date): EmbedBuilder[]`

Behavior:

- Empty entries → one embed, title `Global Leaderboard`, description empty-table copy + timestamp
- Non-empty → chunk by 25; first title `Global Leaderboard`; later `Global Leaderboard (continued)`; timestamp only on last embed description
- Color `0xf0b232`
- Do not change `buildOverallLeaderboardEmbed` command path (keep existing `live?:` option working for tests until Task 3 switches channel to the new builder; then leave `live` option for backward-compatible tests or migrate the live-mode unit test to the new function)

- [ ] **Step 1: Write failing tests**

Append to `leaderboard-embed.test.ts`:

```typescript
import { buildOverallLiveLeaderboardEmbeds } from './leaderboard-embed.js';
import type { OverallLeaderboardEntry } from './leaderboard.js';

function fakeEntry(rank: number): OverallLeaderboardEntry {
  return {
    rank,
    playerId: `p${rank}`,
    username: `Player${rank}`,
    ki: 1000 + rank,
    games: rank,
    discordId: null,
  };
}

describe('buildOverallLiveLeaderboardEmbeds', () => {
  const updatedAt = new Date('2026-08-15T12:00:00Z');
  const unix = Math.floor(updatedAt.getTime() / 1000);

  it('returns one embed for empty ladder with timestamp', () => {
    const embeds = buildOverallLiveLeaderboardEmbeds([], updatedAt);
    expect(embeds).toHaveLength(1);
    expect(embeds[0]!.data.title).toBe('Global Leaderboard');
    expect(embeds[0]!.data.description).toContain('No ranked players yet');
    expect(embeds[0]!.data.description).toContain(`Updated <t:${unix}:R>`);
  });

  it('returns one embed for 25 or fewer entries', () => {
    const embeds = buildOverallLiveLeaderboardEmbeds(
      Array.from({ length: 10 }, (_, i) => fakeEntry(i + 1)),
      updatedAt,
    );
    expect(embeds).toHaveLength(1);
    expect(embeds[0]!.data.title).toBe('Global Leaderboard');
    expect(embeds[0]!.data.description).toContain(`Updated <t:${unix}:R>`);
  });

  it('splits at 26 into two embeds; timestamp only on last', () => {
    const embeds = buildOverallLiveLeaderboardEmbeds(
      Array.from({ length: 26 }, (_, i) => fakeEntry(i + 1)),
      updatedAt,
    );
    expect(embeds).toHaveLength(2);
    expect(embeds[0]!.data.title).toBe('Global Leaderboard');
    expect(embeds[1]!.data.title).toBe('Global Leaderboard (continued)');
    expect(embeds[0]!.data.description).not.toContain('Updated <t:');
    expect(embeds[1]!.data.description).toContain(`Updated <t:${unix}:R>`);
  });

  it('uses four embeds for 100 entries', () => {
    const embeds = buildOverallLiveLeaderboardEmbeds(
      Array.from({ length: 100 }, (_, i) => fakeEntry(i + 1)),
      updatedAt,
    );
    expect(embeds).toHaveLength(4);
    expect(embeds[3]!.data.description).toContain(`Updated <t:${unix}:R>`);
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

Run: `npm test -- src/services/leaderboard/leaderboard-embed.test.ts`

Expected: FAIL — `buildOverallLiveLeaderboardEmbeds` not found.

- [ ] **Step 3: Implement builder**

In `leaderboard-embed.ts`:

```typescript
import { chunkLeaderboardEntries } from './leaderboard.js';

export function buildOverallLiveLeaderboardEmbeds(
  entries: OverallLeaderboardEntry[],
  updatedAt: Date,
): EmbedBuilder[] {
  const unix = Math.floor(updatedAt.getTime() / 1000);
  const stamp = `\n\nUpdated <t:${unix}:R>`;
  const chunks = entries.length === 0 ? [[]] : chunkLeaderboardEntries(entries);

  return chunks.map((chunk, index) => {
    const isLast = index === chunks.length - 1;
    const title = index === 0 ? 'Global Leaderboard' : 'Global Leaderboard (continued)';
    let description = formatOverallTable(chunk);
    if (isLast) {
      description += stamp;
    }
    return new EmbedBuilder().setColor(RANK_GOLD).setTitle(title).setDescription(description);
  });
}
```

Export from `index.ts`.

- [ ] **Step 4: Run tests — expect PASS**

Run: `npm test -- src/services/leaderboard/leaderboard-embed.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/leaderboard/leaderboard-embed.ts src/services/leaderboard/leaderboard-embed.test.ts src/services/leaderboard/index.ts
git commit -m "$(cat <<'EOF'
feat: build live leaderboard as chunked embeds

Split overall live tables into 25-row embeds with timestamp on the last.
EOF
)"
```

---

### Task 3: Wire setup / refresh to league size

**Files:**

- Modify: `src/services/leaderboard/leaderboard-channel.ts`
- Modify: `src/services/leaderboard/leaderboard-channel.test.ts`
- Modify: `src/services/leaderboard/leaderboard.ts` (remove `LIVE_LEADERBOARD_SIZE` alias if still present)

**Interfaces:**

- Consumes: `buildOverallLiveLeaderboardEmbeds`, `loadOverallLeaderboardTop`, `LIVE_LEADERBOARD_DEFAULT_SIZE`
- Changes: `buildLiveOverallEmbed` → returns `EmbedBuilder[]`; `send`/`edit` use `{ embeds }`

- [ ] **Step 1: Update channel tests (fail until wire-up)**

Replace the `./leaderboard.js` mock and add assertions:

```typescript
vi.mock('./leaderboard.js', () => ({
  loadOverallLeaderboardTop: vi.fn().mockResolvedValue([]),
  LIVE_LEADERBOARD_DEFAULT_SIZE: 10,
}));

vi.mock('./leaderboard-embed.js', () => ({
  buildOverallLiveLeaderboardEmbeds: vi.fn().mockReturnValue([{ fake: true }]),
}));
```

Extend the “has channel” path: add a test that when both IDs exist, fetch is called and edit receives `embeds` (mock a text channel). Minimal version:

```typescript
it('edits message with embeds array when bound', async () => {
  leagueFindUnique.mockResolvedValue({
    leaderboardChannelId: 'channel-1',
    leaderboardMessageId: 'msg-1',
    leaderboardSize: 50,
  });
  const edit = vi.fn().mockResolvedValue(undefined);
  const client = {
    channels: {
      fetch: vi.fn().mockResolvedValue({
        isTextBased: () => true,
        isDMBased: () => false,
        messages: { edit, delete: vi.fn() },
      }),
    },
  } as never;

  await refreshLeagueLeaderboard(client, 'league-1');

  expect(edit).toHaveBeenCalledWith('msg-1', {
    embeds: [{ fake: true }],
  });
});
```

Import `buildOverallLiveLeaderboardEmbeds` / `loadOverallLeaderboardTop` from mocks if asserting call args (`loadOverallLeaderboardTop` called with `'league-1', 50`).

- [ ] **Step 2: Run test — expect FAIL**

Run: `npm test -- src/services/leaderboard/leaderboard-channel.test.ts`

Expected: FAIL until channel uses multi-embed path / selects `leaderboardSize`.

- [ ] **Step 3: Implement channel wiring**

In `leaderboard-channel.ts`:

```typescript
import { LIVE_LEADERBOARD_DEFAULT_SIZE, loadOverallLeaderboardTop } from './leaderboard.js';
import { buildOverallLiveLeaderboardEmbeds } from './leaderboard-embed.js';

async function buildLiveOverallEmbeds(leagueId: string) {
  const row = await prisma.league.findUnique({
    where: { id: leagueId },
    select: { leaderboardSize: true },
  });
  const size = row?.leaderboardSize ?? LIVE_LEADERBOARD_DEFAULT_SIZE;
  const entries = await loadOverallLeaderboardTop(leagueId, size);
  return buildOverallLiveLeaderboardEmbeds(entries, new Date());
}
```

Update `setupLiveLeaderboard` / `refreshLeagueLeaderboard` to:

```typescript
const embeds = await buildLiveOverallEmbeds(leagueId);
// send / edit:
await channel.send({ embeds });
await channel.messages.edit(row.leaderboardMessageId, { embeds });
```

Include `leaderboardSize` in existing `findUnique` selects where the same query already loads the league (optional merge to avoid double fetch in refresh).

Remove `LIVE_LEADERBOARD_SIZE` from `leaderboard.ts` and any remaining imports.

- [ ] **Step 4: Run tests — expect PASS**

Run: `npm test -- src/services/leaderboard/`

Expected: all leaderboard unit tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/leaderboard
git commit -m "$(cat <<'EOF'
feat: refresh live leaderboard using league size

Load per-league size and post/edit multi-embed permanent messages.
EOF
)"
```

---

### Task 4: `/config` set · clear · view + staff docs

**Files:**

- Modify: `src/commands/config/config.ts`
- Modify: `docs/discord/staff/a1-roles-and-setup.md`
- Modify: `docs/discord/staff/a5-admin-cheat-sheet.md`

**Interfaces:**

- Consumes: `setLeagueLeaderboardSize`, `clearLeagueLeaderboardSize`, `refreshLeagueLeaderboard`, `resolveLeagueConfig.leaderboardSize`, `LeaderboardServiceError`
- Discord options: `size` integer `setMinValue(10)` `setMaxValue(100)`

- [ ] **Step 1: Extend `formatLeaderboardLine`**

```typescript
function formatLeaderboardLine(
  channelId: string | undefined,
  messageId: string | undefined,
  size: number,
): string {
  if (!channelId || !messageId) {
    return `**Live leaderboard:** \`unset\` · size \`${size}\``;
  }
  return `**Live leaderboard:** <#${channelId}> · message \`${messageId}\` · size \`${size}\``;
}
```

Pass `leagueConfig.leaderboardSize` from `view`.

- [ ] **Step 2: Add slash subcommands**

Under `set` group, after `leaderboard_channel`:

```typescript
.addSubcommand((subcommand) =>
  withSubcommandLeagueOption(
    subcommand
      .setName('leaderboard_size')
      .setDescription('How many players appear on the live overall leaderboard')
      .addIntegerOption((option) =>
        option
          .setName('size')
          .setDescription('Number of ranks to show (10–100)')
          .setRequired(true)
          .setMinValue(10)
          .setMaxValue(100),
      ),
  ),
),
```

Under `clear` group, after `leaderboard_channel`:

```typescript
.addSubcommand((subcommand) =>
  withSubcommandLeagueOption(
    subcommand
      .setName('leaderboard_size')
      .setDescription('Reset live leaderboard size to 10'),
  ),
),
```

- [ ] **Step 3: Handlers**

Imports:

```typescript
import {
  clearLiveLeaderboard,
  setupLiveLeaderboard,
  refreshLeagueLeaderboard,
} from '../../services/leaderboard/index.js';
import {
  // existing +
  setLeagueLeaderboardSize,
  clearLeagueLeaderboardSize,
} from '../../services/league/index.js';
import { LeaderboardServiceError } from '../../services/leaderboard/index.js';
```

(Export `LeaderboardServiceError` from leaderboard index if not already.)

Set handler (after `leaderboard_channel` block):

```typescript
if (subcommand === 'leaderboard_size') {
  const leagueId = await requireLeagueId(interaction);
  if (!leagueId) return;

  const size = interaction.options.getInteger('size', true);
  try {
    await setLeagueLeaderboardSize(leagueId, size);
  } catch (error) {
    if (error instanceof LeaderboardServiceError) {
      await interaction.reply({
        content: error.message,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    throw error;
  }

  await refreshLeagueLeaderboard(interaction.client, leagueId);
  log.info(
    { guildId: interaction.guildId, leagueId, size, userId: interaction.user.id },
    'Live leaderboard size updated',
  );
  await interaction.reply({
    content: `Live leaderboard size set to \`${size}\`.`,
    flags: MessageFlags.Ephemeral,
  });
  return;
}
```

Clear handler:

```typescript
if (subcommand === 'leaderboard_size') {
  const leagueId = await requireLeagueId(interaction);
  if (!leagueId) return;

  await clearLeagueLeaderboardSize(leagueId);
  await refreshLeagueLeaderboard(interaction.client, leagueId);
  log.info(
    { guildId: interaction.guildId, leagueId, userId: interaction.user.id },
    'Live leaderboard size cleared',
  );
  await interaction.reply({
    content: 'Live leaderboard size reset to `10`.',
    flags: MessageFlags.Ephemeral,
  });
  return;
}
```

`refreshLeagueLeaderboard` no-ops when channel unset — that is fine.

- [ ] **Step 4: Staff docs**

In `a1-roles-and-setup.md`, after the live channel section:

```markdown
Optional size (default 10, max 100; Discord splits every 25 ranks into another embed):
```

/config set leaderboard_size size:50

```
Reset: `/config clear leaderboard_size`
```

In `a5-admin-cheat-sheet.md`, add:

```markdown
• `/config set leaderboard_size` / `/config clear leaderboard_size`
```

near the existing leaderboard_channel lines.

- [ ] **Step 5: Typecheck / tests**

Run:

```bash
npm test -- src/services/leaderboard/
npx tsc --noEmit
```

Expected: PASS / no errors.

- [ ] **Step 6: Commit**

```bash
git add src/commands/config/config.ts docs/discord/staff src/services/leaderboard/index.ts src/services/league
git commit -m "$(cat <<'EOF'
feat: configure live leaderboard size via /config

Add set/clear/view for per-league size and document for staff.
EOF
)"
```

---

### Task 5: Manual smoke checklist (no code)

- [ ] **Step 1: Local verify**

1. `npm run db:migrate` if another env needs the column
2. Restart bot (`npm run dev`) so commands redeploy
3. `/config set leaderboard_size size:50` → ephemeral confirms; live message shows up to 50 ranks / 2 embeds when enough players
4. `/config view` shows `size 50`
5. `/config clear leaderboard_size` → size 10; message shrinks
6. `/leaderboard show` still paginates 10

- [ ] **Step 2: Final commit only if docs/tests tweaked during smoke**

Otherwise done — no empty commit.

---

## Spec coverage checklist

| Spec item                                       | Task                          |
| ----------------------------------------------- | ----------------------------- |
| `League.leaderboardSize` default 10             | 1                             |
| Min 10 / max 100 / reject invalid               | 1, 4                          |
| Chunk every 25 / multi-embed                    | 2, 3                          |
| Timestamp on last embed                         | 2                             |
| Setup/refresh/edit embeds array                 | 3                             |
| `/config set\|clear leaderboard_size` + refresh | 4                             |
| `/config view` shows size                       | 4                             |
| Slash page size unchanged                       | 3–4 (no changes to show path) |
| Staff docs                                      | 4                             |
| Tests for chunk/assert/embeds                   | 1–3                           |

## Placeholder / consistency self-review

- No TBD steps; signatures match across tasks (`buildOverallLiveLeaderboardEmbeds`, `setLeagueLeaderboardSize`, constants).
- `LIVE_LEADERBOARD_SIZE` removed by end of Task 3.
- Circular import escape hatch documented in Task 1.
