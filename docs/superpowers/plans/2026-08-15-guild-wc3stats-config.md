# Guild wc3stats Config (env → DB) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move `WC3STATS_ENABLED` / `WC3STATS_MAP_PATTERN` / `WC3STATS_MAP_SHA1` from process env into per-guild `GuildConfig`, writable only via the UDBR `/config` preset, with a full-package clear and no env fallback.

**Architecture:** Three new columns on `GuildConfig`. UDBR filter constants live next to the existing slot map. Preset upserts enabled+pattern+sha1 and replaces slots; `clear wc3stats` resets the package. Call sites `resolveGuildConfig(guildId)` and pass filter into `importWc3statsLobby`. Process keeps only `WC3STATS_TIMEOUT_MS`; AWS SSM drops the three keys.

**Tech Stack:** Node.js + TypeScript ESM, discord.js v14, Prisma + PostgreSQL, Vitest, OpenTofu/Terraform SSM

**Spec:** [docs/superpowers/specs/2026-08-15-guild-wc3stats-config-design.md](../specs/2026-08-15-guild-wc3stats-config-design.md)

## Global Constraints

- User-facing strings in **English**
- No env fallback for the three migrated keys (default: import off, filter unset)
- Empty pattern must never compile to “match everything”; fail closed / treat as not ready
- Only `set wc3stats_map_preset` turns import on in this slice
- `clear wc3stats_map` / `wc3stats_slot` remain layout-only
- Resolve by `interaction.guildId` (not deploy `GUILD_ID`); missing guild → import off
- ESM imports use `.js` extensions
- Use Prisma singleton from `src/lib/prisma.ts`
- Prefer `MatchServiceError` for user-facing failures
- New production env keys follow `env-aws-sync.mdc` — here we **remove** keys (same checklist inverted)
- Commits only when the user asks (skip commit steps unless requested)
- Part 2 fat presets (heroes, team names) stay out of this plan — see spec **Deferred — Part 2**

## File structure

| File                                                         | Responsibility                                                             |
| ------------------------------------------------------------ | -------------------------------------------------------------------------- |
| `prisma/schema.prisma` + migration                           | `wc3statsEnabled`, `wc3statsMapPattern`, `wc3statsMapSha1`                 |
| `src/services/wc3stats/wc3stats-slot-map.ts`                 | UDBR pattern/sha1 constants + `parseWc3statsMapSha1`                       |
| `src/services/guild/guild-config.ts`                         | Resolve new fields; `applyUdbrWc3statsPreset`; `clearGuildWc3statsPackage` |
| `src/services/guild/guild-config.test.ts`                    | Resolve defaults, preset, clear                                            |
| `src/services/wc3stats/wc3stats-resolve.ts`                  | Accept map filter args; stop reading env pattern/sha1                      |
| `src/commands/config/config.ts`                              | Preset package write; `clear wc3stats`; view lines                         |
| `src/commands/lobby/register-lobby.ts`                       | Resolve guild; pass enabled/filter                                         |
| `src/services/lobby/wc3stats-refresh.ts`                     | Guild-resolved enable + filter                                             |
| `src/services/lobby/discord-sync.ts`                         | Guild-resolved enable for buttons                                          |
| `src/config/env.ts` + `.env.example` + `scripts-and-env.mdc` | Drop three keys; keep timeout                                              |
| `infra/aws/*` + `deploy/aws/refresh-env.sh`                  | Drop three SSM/env writer lines                                            |
| `docs/discord/staff/a4-wc3stats-mapping.md`                  | Preset-only enable (not ops `.env`)                                        |

---

### Task 1: Prisma columns + migration

**Files:**

- Modify: `prisma/schema.prisma` (`GuildConfig` model)
- Create: `prisma/migrations/<timestamp>_guild_wc3stats_config/migration.sql`

**Interfaces:**

- Produces: `GuildConfig.wc3statsEnabled Boolean @default(false)`, `wc3statsMapPattern String?`, `wc3statsMapSha1 String?`

- [ ] **Step 1: Extend `GuildConfig` in schema**

In `prisma/schema.prisma`, add to `GuildConfig` (after `lobbyPlayerClaimEnabled`):

```prisma
  wc3statsEnabled     Boolean                @default(false)
  wc3statsMapPattern  String?
  wc3statsMapSha1     String?
```

- [ ] **Step 2: Create migration**

Run: `npm run db:migrate`

Name when prompted: `guild_wc3stats_config`

Expected: migration applied; Prisma client regenerated.

If CLI cannot reach DB, create SQL manually then `npx prisma generate`:

```sql
-- AlterTable
ALTER TABLE "GuildConfig" ADD COLUMN "wc3statsEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "GuildConfig" ADD COLUMN "wc3statsMapPattern" TEXT;
ALTER TABLE "GuildConfig" ADD COLUMN "wc3statsMapSha1" TEXT;
```

- [ ] **Step 3: Commit** (only if user asked)

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "$(cat <<'EOF'
Add GuildConfig columns for per-guild wc3stats filter.

EOF
)"
```

---

### Task 2: UDBR filter constants + sha1 parser

**Files:**

- Modify: `src/services/wc3stats/wc3stats-slot-map.ts`
- Modify: `src/services/wc3stats/wc3stats-slot-map.test.ts`
- Modify: `src/services/wc3stats/index.ts` (re-exports)

**Interfaces:**

- Produces:
  - `UDBR_WC3STATS_MAP_PATTERN = 'ultimate.?dragon.?ball.?reborn|udbr'`
  - `UDBR_WC3STATS_MAP_SHA1 = '19783c6259e86253a8c940ede63a87e18204bd94'`
  - `parseWc3statsMapSha1(raw: string | null | undefined): string[]` — split on `,`, trim, lowercase, drop empties (same as today’s env parser)

- [ ] **Step 1: Write failing tests**

Add to `src/services/wc3stats/wc3stats-slot-map.test.ts`:

```typescript
import {
  UDBR_WC3STATS_MAP_PATTERN,
  UDBR_WC3STATS_MAP_SHA1,
  parseWc3statsMapSha1,
} from './wc3stats-slot-map.js';

describe('parseWc3statsMapSha1', () => {
  it('returns empty for null/undefined/blank', () => {
    expect(parseWc3statsMapSha1(null)).toEqual([]);
    expect(parseWc3statsMapSha1(undefined)).toEqual([]);
    expect(parseWc3statsMapSha1('  ')).toEqual([]);
  });

  it('splits, trims, and lowercases', () => {
    expect(parseWc3statsMapSha1('ABC, def ,')).toEqual(['abc', 'def']);
  });
});

describe('UDBR filter constants', () => {
  it('matches the historical env defaults', () => {
    expect(UDBR_WC3STATS_MAP_PATTERN).toBe('ultimate.?dragon.?ball.?reborn|udbr');
    expect(UDBR_WC3STATS_MAP_SHA1).toBe('19783c6259e86253a8c940ede63a87e18204bd94');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/services/wc3stats/wc3stats-slot-map.test.ts`

Expected: FAIL — exports missing

- [ ] **Step 3: Implement constants + parser**

In `wc3stats-slot-map.ts`, after `UDBR_WC3STATS_SLOT_MAP`:

```typescript
/** Regex source copied into GuildConfig by the UDBR preset (not a process env default). */
export const UDBR_WC3STATS_MAP_PATTERN = 'ultimate.?dragon.?ball.?reborn|udbr';

/** Comma-separated map.sha1 allowlist for UDBR 2.4f (gamelist detail, not list hash). */
export const UDBR_WC3STATS_MAP_SHA1 = '19783c6259e86253a8c940ede63a87e18204bd94';

export function parseWc3statsMapSha1(raw: string | null | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}
```

Re-export from `src/services/wc3stats/index.ts`.

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/services/wc3stats/wc3stats-slot-map.test.ts`

Expected: PASS

- [ ] **Step 5: Commit** (only if user asked)

```bash
git add src/services/wc3stats/wc3stats-slot-map.ts src/services/wc3stats/wc3stats-slot-map.test.ts src/services/wc3stats/index.ts
git commit -m "$(cat <<'EOF'
Add UDBR wc3stats filter constants for guild presets.

EOF
)"
```

---

### Task 3: Resolve + apply preset + clear package

**Files:**

- Modify: `src/services/guild/guild-config.ts`
- Modify: `src/services/guild/guild-config.test.ts`
- Modify: `src/services/guild/index.ts`

**Interfaces:**

- Consumes: `UDBR_WC3STATS_*`, `parseWc3statsMapSha1`, `replaceGuildWc3statsSlotMaps`, `clearAllGuildWc3statsSlotMaps`, `UDBR_WC3STATS_SLOT_MAP`
- Produces (extend `ResolvedGuildConfig`):
  - `wc3statsEnabled: boolean`
  - `wc3statsMapPattern: string | undefined`
  - `wc3statsMapSha1: string[]`
- Produces:
  - `applyUdbrWc3statsPreset(guildId: string): Promise<void>`
  - `clearGuildWc3statsPackage(guildId: string): Promise<void>`
  - `isGuildWc3statsImportReady(resolved: Pick<ResolvedGuildConfig, 'wc3statsEnabled' | 'wc3statsMapPattern'>): boolean` — `enabled && Boolean(pattern)`

**Resolution rules (no env):**

- `wc3statsEnabled` → `row?.wc3statsEnabled === true` else `false`
- pattern → trimmed non-empty DB string else `undefined`
- sha1 → `parseWc3statsMapSha1(row?.wc3statsMapSha1)`

**`applyUdbrWc3statsPreset`:** upsert `enabled=true`, pattern/sha1 constants, then `replaceGuildWc3statsSlotMaps(guildId, [...UDBR_WC3STATS_SLOT_MAP])`.

**`clearGuildWc3statsPackage`:** upsert `enabled=false`, pattern/sha1 `null`, then `clearAllGuildWc3statsSlotMaps(guildId)`.

- [ ] **Step 1: Write failing tests**

Update existing `resolveGuildConfig` expectations to include the three new fields (`false`, `undefined`, `[]` when no row).

Add:

```typescript
describe('guild wc3stats package', () => {
  beforeEach(() => {
    findUnique.mockReset();
    upsert.mockReset();
    upsert.mockResolvedValue({});
  });

  it('defaults wc3stats off with empty filter when no row', async () => {
    findUnique.mockResolvedValue(null);
    const resolved = await resolveGuildConfig('guild-1');
    expect(resolved.wc3statsEnabled).toBe(false);
    expect(resolved.wc3statsMapPattern).toBeUndefined();
    expect(resolved.wc3statsMapSha1).toEqual([]);
  });

  it('reads enabled and filter from the database only', async () => {
    findUnique.mockResolvedValue({
      guildId: 'guild-1',
      matchCreateRoleId: null,
      matchModRoleId: null,
      leaderboardChannelId: null,
      leaderboardMessageId: null,
      lobbyPlayerClaimEnabled: true,
      wc3statsEnabled: true,
      wc3statsMapPattern: 'udbr',
      wc3statsMapSha1: 'Aa, Bb',
    });
    const resolved = await resolveGuildConfig('guild-1');
    expect(resolved.wc3statsEnabled).toBe(true);
    expect(resolved.wc3statsMapPattern).toBe('udbr');
    expect(resolved.wc3statsMapSha1).toEqual(['aa', 'bb']);
  });

  it('isGuildWc3statsImportReady requires enabled and pattern', () => {
    expect(
      isGuildWc3statsImportReady({
        wc3statsEnabled: true,
        wc3statsMapPattern: 'x',
      }),
    ).toBe(true);
    expect(
      isGuildWc3statsImportReady({
        wc3statsEnabled: true,
        wc3statsMapPattern: undefined,
      }),
    ).toBe(false);
    expect(
      isGuildWc3statsImportReady({
        wc3statsEnabled: false,
        wc3statsMapPattern: 'x',
      }),
    ).toBe(false);
  });
});
```

Mock `../wc3stats/wc3stats-slot-map.js` in this file (or test apply/clear via upsert + a vi.mock of replace/clear). Prefer unit-testing apply/clear by mocking:

```typescript
const { replaceGuildWc3statsSlotMaps, clearAllGuildWc3statsSlotMaps } = vi.hoisted(() => ({
  replaceGuildWc3statsSlotMaps: vi.fn(),
  clearAllGuildWc3statsSlotMaps: vi.fn(),
}));

vi.mock('../wc3stats/wc3stats-slot-map.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../wc3stats/wc3stats-slot-map.js')>();
  return {
    ...actual,
    replaceGuildWc3statsSlotMaps,
    clearAllGuildWc3statsSlotMaps,
  };
});
```

Then assert `applyUdbrWc3statsPreset` upserts UDBR constants + calls replace with slot map; `clearGuildWc3statsPackage` upserts false/null/null + clearAll.

- [ ] **Step 2: Run tests — expect FAIL**

Run: `npx vitest run src/services/guild/guild-config.test.ts`

- [ ] **Step 3: Implement**

1. Import slot-map helpers into `guild-config.ts`.
2. Extend `ResolvedGuildConfig` and `resolveGuildConfig` return.
3. Add `isGuildWc3statsImportReady`, `applyUdbrWc3statsPreset`, `clearGuildWc3statsPackage`.
4. Export from `src/services/guild/index.ts`.

Apply upsert shape:

```typescript
await prisma.guildConfig.upsert({
  where: { guildId },
  create: {
    guildId,
    wc3statsEnabled: true,
    wc3statsMapPattern: UDBR_WC3STATS_MAP_PATTERN,
    wc3statsMapSha1: UDBR_WC3STATS_MAP_SHA1,
  },
  update: {
    wc3statsEnabled: true,
    wc3statsMapPattern: UDBR_WC3STATS_MAP_PATTERN,
    wc3statsMapSha1: UDBR_WC3STATS_MAP_SHA1,
  },
});
await replaceGuildWc3statsSlotMaps(guildId, [...UDBR_WC3STATS_SLOT_MAP]);
```

Clear upsert: `wc3statsEnabled: false`, both strings `null`, then `clearAllGuildWc3statsSlotMaps`.

- [ ] **Step 4: Run tests — expect PASS**

Run: `npx vitest run src/services/guild/guild-config.test.ts`

- [ ] **Step 5: Commit** (only if user asked)

```bash
git add src/services/guild/guild-config.ts src/services/guild/guild-config.test.ts src/services/guild/index.ts
git commit -m "$(cat <<'EOF'
Resolve and apply per-guild wc3stats preset package.

EOF
)"
```

---

### Task 4: `/config` command — preset, clear, view

**Files:**

- Modify: `src/commands/config/config.ts`
- Modify: `docs/discord/staff/a4-wc3stats-mapping.md`

**Interfaces:**

- Consumes: `applyUdbrWc3statsPreset`, `clearGuildWc3statsPackage`, `resolveGuildConfig`
- Produces: slash `clear wc3stats`; preset no longer only replaces slots

- [ ] **Step 1: Extend slash builder**

Under `clear` group, add:

```typescript
.addSubcommand((subcommand) =>
  subcommand
    .setName('wc3stats')
    .setDescription('Disable wc3stats import and clear filter + slot map for this server'),
)
```

- [ ] **Step 2: View formatting**

Add helpers:

```typescript
function formatWc3statsEnabledLine(enabled: boolean): string {
  return `**wc3stats import:** \`${enabled ? 'on' : 'off'}\``;
}

function formatWc3statsFilterLines(pattern: string | undefined, sha1: string[]): string[] {
  return [
    `**wc3stats map pattern:** ${pattern ? `\`${pattern}\`` : '`unset`'}`,
    `**wc3stats map sha1:** ${
      sha1.length > 0 ? sha1.map((s) => `\`${s}\``).join(', ') : '`unset`'
    }`,
  ];
}
```

Include them in `view` reply (before the slot section).

- [ ] **Step 3: Preset handler**

Replace the body of `wc3stats_map_preset` for `udbr` with:

```typescript
await applyUdbrWc3statsPreset(interaction.guildId);
// reply: Applied UDBR preset: import enabled, map filter set, slot layout applied.
```

Remove direct `replaceGuildWc3statsSlotMaps` / unused `UDBR_WC3STATS_SLOT_MAP` import if no longer needed (keep `formatWc3statsSlotMapLines` for view/other paths).

- [ ] **Step 4: Clear package handler**

In `clear` group:

```typescript
if (subcommand === 'wc3stats') {
  await clearGuildWc3statsPackage(interaction.guildId);
  await interaction.reply({
    content: 'wc3stats import disabled. Map filter and slot mappings cleared for this server.',
    flags: MessageFlags.Ephemeral,
  });
  return;
}
```

Leave `clear wc3stats_map` / `wc3stats_slot` unchanged.

- [ ] **Step 5: Update staff doc `a4-wc3stats-mapping.md`**

Replace the closing note about enabling in the bot environment with:

- Enable (and load UDBR defaults): `/config set wc3stats_map_preset preset:UDBR`
- Full reset: `/config clear wc3stats`
- Layout-only clear commands unchanged

Also update `a5-admin-cheat-sheet.md` if it still implies env enable.

- [ ] **Step 6: Manual sanity**

Redeploy commands (dev auto-deploy). Run `/config view` (off/unset), preset, view (on + filter + slots), `clear wc3stats`, view again.

- [ ] **Step 7: Commit** (only if user asked)

```bash
git add src/commands/config/config.ts docs/discord/staff/a4-wc3stats-mapping.md docs/discord/staff/a5-admin-cheat-sheet.md
git commit -m "$(cat <<'EOF'
Wire /config preset and clear for guild wc3stats package.

EOF
)"
```

---

### Task 5: `importWc3statsLobby` takes filter from caller

**Files:**

- Modify: `src/services/wc3stats/wc3stats-resolve.ts`
- Modify: `src/services/wc3stats/wc3stats-resolve.test.ts` (any tests that call import)

**Interfaces:**

- Consumes: still `env.wc3statsTimeoutMs` only
- Produces: `importWc3statsLobby` input adds required:
  - `mapPattern: string`
  - `mapSha1: string[]`
- Error message for invalid regex may stay the same English string, or become `Map pattern is not a valid regular expression.` (prefer user-facing without env var name)

- [ ] **Step 1: Change signature**

```typescript
export async function importWc3statsLobby(input: {
  wc3statsId?: number | null;
  hostNick?: string | null;
  requireNickInLobby?: boolean;
  slotMap?: Wc3statsHeroSlotMap | null;
  mapPattern: string;
  mapSha1: string[];
}): Promise<ImportWc3statsLobbyResult> {
  const timeoutMs = env.wc3statsTimeoutMs;
  if (!input.mapPattern.trim()) {
    throw new MatchServiceError('Warcraft lobby import is not configured for this server.');
  }
  let mapConfig: ReturnType<typeof compileWc3statsMapConfig>;
  try {
    mapConfig = compileWc3statsMapConfig(input.mapPattern, input.mapSha1);
  } catch {
    throw new MatchServiceError('Map pattern is not a valid regular expression.');
  }
  // …rest unchanged, using mapConfig…
}
```

Remove all uses of `env.wc3statsMapPattern` / `env.wc3statsMapSha1` in this file.

- [ ] **Step 2: Fix unit tests**

Pass `mapPattern: 'udbr'` (or UDBR constant) and `mapSha1: []` / fixture sha1 into every `importWc3statsLobby` call in tests.

- [ ] **Step 3: Run tests**

Run: `npx vitest run src/services/wc3stats/wc3stats-resolve.test.ts`

Expected: PASS

- [ ] **Step 4: Commit** (only if user asked)

```bash
git add src/services/wc3stats/wc3stats-resolve.ts src/services/wc3stats/wc3stats-resolve.test.ts
git commit -m "$(cat <<'EOF'
Pass guild map filter into wc3stats lobby import.

EOF
)"
```

---

### Task 6: Wire register / refresh / discord-sync

**Files:**

- Modify: `src/commands/lobby/register-lobby.ts`
- Modify: `src/services/lobby/wc3stats-refresh.ts`
- Modify: `src/services/lobby/discord-sync.ts`

**Interfaces:**

- Consumes: `resolveGuildConfig`, `isGuildWc3statsImportReady`
- Pattern: resolve once per guild interaction; pass `wc3statsEnabled: isGuildWc3statsImportReady(resolved)` into source/preview; pass pattern/sha1 into `importWc3statsLobby`

- [ ] **Step 1: `register-lobby.ts`**

Near start (after guildId known):

```typescript
const guildConfig = interaction.guildId ? await resolveGuildConfig(interaction.guildId) : null;
const wc3statsReady = guildConfig ? isGuildWc3statsImportReady(guildConfig) : false;
```

Replace every `env.wc3statsEnabled` with `wc3statsReady`.

When calling `importWc3statsLobby`, pass:

```typescript
mapPattern: guildConfig!.wc3statsMapPattern!,
mapSha1: guildConfig!.wc3statsMapSha1,
```

Only call import when `wc3statsReady` (existing `if (env.wc3statsEnabled && …)` becomes `if (wc3statsReady && …)`).

Remove `env` import if unused.

- [ ] **Step 2: `wc3stats-refresh.ts`**

Replace `env.wc3statsEnabled` checks with resolve on `input.guildId` / channel-derived guild:

```typescript
async function assertWc3statsImportReady(
  guildId: string | null | undefined,
): Promise<ResolvedGuildConfig> {
  if (!guildId) {
    throw new MatchServiceError(WC3STATS_IMPORT_DISABLED_MESSAGE);
  }
  const resolved = await resolveGuildConfig(guildId);
  if (!isGuildWc3statsImportReady(resolved)) {
    throw new MatchServiceError(WC3STATS_IMPORT_DISABLED_MESSAGE);
  }
  return resolved;
}
```

Pass `mapPattern` / `mapSha1` from that resolved config into every `importWc3statsLobby` call in this file. Remove `env` import if unused.

- [ ] **Step 3: `discord-sync.ts`**

`syncLobbyDiscordMessage` already has guild context via channel — resolve config for `wc3statsLinkAvailable` / `wc3statsEnabled` preview flags using `isGuildWc3statsImportReady`. If guildId missing → false.

- [ ] **Step 4: Run related tests**

Run:

```bash
npx vitest run src/services/lobby/register-lobby-source.test.ts src/services/lobby/lobby-preview.test.ts src/services/guild/guild-config.test.ts src/services/wc3stats/
```

Expected: PASS (preview/source tests already take boolean; no env dependency)

- [ ] **Step 5: Commit** (only if user asked)

```bash
git add src/commands/lobby/register-lobby.ts src/services/lobby/wc3stats-refresh.ts src/services/lobby/discord-sync.ts
git commit -m "$(cat <<'EOF'
Use guild-resolved wc3stats settings in lobby flows.

EOF
)"
```

---

### Task 7: Remove process env + AWS SSM keys

**Files:**

- Modify: `src/config/env.ts`
- Modify: `.env.example`
- Modify: `.cursor/rules/scripts-and-env.mdc`
- Modify: `deploy/aws/refresh-env.sh`
- Modify: `infra/aws/variables.tf`
- Modify: `infra/aws/ssm.tf`
- Modify: `infra/aws/main.tf` (`depends_on` list)
- Modify: `infra/aws/terraform.tfvars.example`
- Modify: `infra/aws/README.md` if it documents the three keys

**Keep:** `WC3STATS_TIMEOUT_MS` everywhere it already exists.

- [ ] **Step 1: Strip `env.ts`**

Remove from `EnvConfig` and `env` object:

- `wc3statsEnabled`
- `wc3statsMapPattern`
- `wc3statsMapSha1`

Keep `wc3statsTimeoutMs`.

Grep to confirm no remaining `env.wc3statsEnabled` / `MapPattern` / `MapSha1` in `src/`:

```bash
rg 'env\.wc3stats(Enabled|MapPattern|MapSha1)|WC3STATS_ENABLED|WC3STATS_MAP_' src/
```

Expected: no matches (except possibly comments — remove those too).

- [ ] **Step 2: Docs / example**

`.env.example` — delete the three commented keys; keep timeout + a short note that import is enabled per server via `/config set wc3stats_map_preset`.

`scripts-and-env.mdc` — same: remove the three bullets; document guild preset; keep timeout.

- [ ] **Step 3: Host writer**

In `deploy/aws/refresh-env.sh`, remove the three `echo WC3STATS_ENABLED|MAP_PATTERN|MAP_SHA1` lines and remove those names from the `known=` list. Keep `WC3STATS_TIMEOUT_MS`.

- [ ] **Step 4: Terraform**

- Delete variables `wc3stats_enabled`, `wc3stats_map_pattern`, `wc3stats_map_sha1`
- Delete SSM resources for those three
- Remove them from `main.tf` `depends_on`
- Remove from `terraform.tfvars.example`
- Note in plan ops: after apply, orphaned SSM params may need manual delete if state no longer manages them (tofu destroy of those resources on apply)

- [ ] **Step 5: Full test + typecheck**

```bash
npx vitest run
npm run build
```

Expected: tests PASS; `tsc` clean.

- [ ] **Step 6: Commit** (only if user asked)

```bash
git add src/config/env.ts .env.example .cursor/rules/scripts-and-env.mdc deploy/aws/refresh-env.sh infra/aws
git commit -m "$(cat <<'EOF'
Remove process-wide WC3STATS enable/filter env and SSM keys.

EOF
)"
```

---

### Task 8: Ops checklist (no code)

**Files:** none required (optional one-line in `infra/aws/README.md` deploy notes)

- [ ] **Step 1: Document post-deploy steps** (in the PR description or README)

1. Deploy app + run migration
2. In each guild that needs import: `/config set wc3stats_map_preset preset:UDBR`
3. `tofu apply` to drop the three SSM parameters from tfvars/state
4. Host `refresh-env` / next deploy rewrites `.env` without those keys

- [ ] **Step 2: Confirm Part 2 remains deferred**

Do not implement team names, hero catalogs, or extra presets in this plan. Spec section **Deferred — Part 2** is the backlog.

---

## Self-review (plan vs spec)

| Spec requirement                                       | Task                                                            |
| ------------------------------------------------------ | --------------------------------------------------------------- |
| Three `GuildConfig` columns                            | Task 1                                                          |
| No env fallback; default off/empty                     | Tasks 3, 7                                                      |
| UDBR constants copied by preset                        | Tasks 2–4                                                       |
| `clear wc3stats` full package; layout clears unchanged | Task 4                                                          |
| `view` shows enabled/pattern/sha1                      | Task 4                                                          |
| Call sites use resolve, not env                        | Tasks 5–6                                                       |
| Empty filter fail-closed                               | Tasks 3 (`isGuildWc3statsImportReady`), 5 (empty pattern throw) |
| Remove three env/SSM keys; keep timeout                | Task 7                                                          |
| Staff docs                                             | Task 4                                                          |
| Post-deploy preset once                                | Task 8                                                          |
| Part 2 fat presets documented, not built               | Global Constraints + Task 8                                     |

No intentional placeholders. Type names: `applyUdbrWc3statsPreset`, `clearGuildWc3statsPackage`, `isGuildWc3statsImportReady`, `parseWc3statsMapSha1` consistent across tasks.
