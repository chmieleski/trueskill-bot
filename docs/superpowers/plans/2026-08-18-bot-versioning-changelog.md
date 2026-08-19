# Bot versioning and Discord changelogs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Conventional Commits on `main` cut semver GitHub Releases; the production bot opens a staff draft per version; Publish fans player notes to every guild changelog channel.

**Architecture:** CI runs commitlint on PR titles, then on `main` `test` → semantic-release (tag, `CHANGELOG.md`, `package.json`, GitHub Release, `[skip ci]` commit) → existing SSM deploy. The bot reads `package.json` + `CHANGELOG.md` on disk (no GitHub token). `src/services/release/` owns parse, draft upsert, publish/dismiss, and draft-channel uniqueness. Discord adapters stay thin.

**Tech Stack:** TypeScript ESM, Prisma, discord.js v14, Vitest, commitlint, semantic-release

**Spec:** `docs/superpowers/specs/2026-08-18-bot-versioning-changelog-design.md`

**Scope:** `general` (process-wide product version, not `leagueId`)

## Global Constraints

- Scope: `general` — `BotRelease` is process-global; ratings/matches stay keyed by `leagueId`
- English-only user-facing strings, logs, command names/descriptions, and errors
- ESM imports use the `.js` extension; named exports only
- Prisma singleton from `src/lib/prisma.ts`
- No Commitizen, no Husky, no `npm publish`, no `/version`, no `/changelog` command
- No new bot env vars or AWS SSM keys
- No GitHub API token in the running bot
- Draft auto-sync on production `ready` only (`env.isDev === false`)
- Skip creating a release row for placeholder version `0.1.0`
- First public tag is **1.0.0** (do not tag `v0.1.0`)
- Edit / Publish / Dismiss use `assertCanConfigureBot` (bot owner or Manage Server on the **staff** guild)
- Player notes max 4000 characters (Discord modal); Publish refuses empty notes
- `config.ts` is already ~1283 lines (1600 max). Keep new logic in `src/services/release/`; the command file only wires options and replies

## File map

| File                                                                   | Role                                                        |
| ---------------------------------------------------------------------- | ----------------------------------------------------------- |
| `src/services/release/changelog.ts`                                    | Parse `CHANGELOG.md` section; read `package.json` version   |
| `src/services/release/changelog.test.ts`                               | Parser + placeholder skip helpers                           |
| `src/services/release/errors.ts`                                       | `ReleaseServiceError`                                       |
| `src/services/release/release-config.ts`                               | Guild changelog / draft channel get/set/clear + uniqueness  |
| `src/services/release/release-config.test.ts`                          | Draft-channel uniqueness                                    |
| `src/services/release/release-draft.ts`                                | Ensure draft row; post/re-post staff cards                  |
| `src/services/release/release-draft.test.ts`                           | Skip `0.1.0`; insert once; missing changelog                |
| `src/services/release/release-publish.ts`                              | Publish / dismiss / record posts                            |
| `src/services/release/release-publish.test.ts`                         | Empty notes, retry skip, dismiss                            |
| `src/services/release/release-embed.ts`                                | Staff + player embeds, buttons, custom ids                  |
| `src/services/release/release-embed.test.ts`                           | Custom-id parse; field truncate                             |
| `src/services/release/index.ts`                                        | Barrel                                                      |
| `prisma/schema.prisma`                                                 | `GuildConfig` columns, `BotRelease`, `BotReleasePost`, enum |
| `prisma/migrations/20260818200000_bot_release_changelog/migration.sql` | SQL                                                         |
| `src/services/guild/guild-config.ts`                                   | `ResolvedGuildConfig` changelog fields                      |
| `src/commands/config/config.ts`                                        | set/clear/view wiring only                                  |
| `src/discord/interactions/release-interactions.ts`                     | Buttons + modal                                             |
| `src/events/interaction-create.ts`                                     | Dispatch                                                    |
| `src/events/ready.ts`                                                  | Production draft sync                                       |
| `commitlint.config.js`                                                 | Conventional commits                                        |
| `.releaserc.json`                                                      | semantic-release                                            |
| `.github/workflows/ci-cd.yml`                                          | commitlint + release jobs                                   |
| `package.json`                                                         | DevDependencies only                                        |
| `.cursor/rules/conventional-commits.mdc`                               | Agent/human commit format                                   |
| `.cursor/rules/database-domain.mdc`                                    | Mention `BotRelease`                                        |
| `docs/discord/staff/a5-admin-cheat-sheet.md`                           | Config + draft buttons                                      |

---

### Task 1: Changelog parser (TDD)

**Files:**

- Create: `src/services/release/changelog.ts`
- Create: `src/services/release/changelog.test.ts`
- Create: `src/services/release/errors.ts`
- Create: `src/services/release/index.ts`

**Interfaces:**

- Consumes: `node:fs`, `node:path`
- Produces:
  - `PLACEHOLDER_VERSION = '0.1.0'`
  - `extractChangelogSection(markdown: string, version: string): string | null`
  - `readAppVersion(rootDir?: string): string`
  - `readChangelogMarkdown(rootDir?: string): string`
  - `isPlaceholderVersion(version: string): boolean`
  - `class ReleaseServiceError extends Error`

- [ ] **Step 1: Write the failing tests**

Create `src/services/release/changelog.test.ts`:

```typescript
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PLACEHOLDER_VERSION,
  extractChangelogSection,
  isPlaceholderVersion,
  readAppVersion,
  readChangelogMarkdown,
} from './changelog.js';

const SAMPLE = `# Changelog

# [1.2.0](https://github.com/example/bot/compare/v1.1.1...v1.2.0) (2026-08-18)

### Features

* **lobby:** always show balance hint

## [1.1.1](https://github.com/example/bot/compare/v1.1.0...v1.1.1) (2026-08-17)

### Bug Fixes

* calibrating gate
`;

describe('extractChangelogSection', () => {
  it('returns the 1.2.0 body and ignores other versions', () => {
    expect(extractChangelogSection(SAMPLE, '1.2.0')).toBe(
      '### Features\n\n* **lobby:** always show balance hint',
    );
  });

  it('returns the 1.1.1 body', () => {
    expect(extractChangelogSection(SAMPLE, '1.1.1')).toBe('### Bug Fixes\n\n* calibrating gate');
  });

  it('returns null when the version heading is missing', () => {
    expect(extractChangelogSection(SAMPLE, '9.9.9')).toBeNull();
  });
});

describe('isPlaceholderVersion', () => {
  it('is true only for 0.1.0', () => {
    expect(isPlaceholderVersion(PLACEHOLDER_VERSION)).toBe(true);
    expect(isPlaceholderVersion('1.0.0')).toBe(false);
  });
});

describe('readAppVersion / readChangelogMarkdown', () => {
  it('reads version and changelog from a root dir', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bot-release-'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '1.2.0' }));
    writeFileSync(join(dir, 'CHANGELOG.md'), SAMPLE);
    expect(readAppVersion(dir)).toBe('1.2.0');
    expect(readChangelogMarkdown(dir)).toContain('1.2.0');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/services/release/changelog.test.ts`

Expected: FAIL — cannot find module `./changelog.js`

- [ ] **Step 3: Write minimal implementation**

Create `src/services/release/errors.ts`:

```typescript
export class ReleaseServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReleaseServiceError';
  }
}
```

Create `src/services/release/changelog.ts`:

```typescript
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const PLACEHOLDER_VERSION = '0.1.0';

/** True for the historical package.json placeholder that must never open a Discord draft. */
export function isPlaceholderVersion(version: string): boolean {
  return version === PLACEHOLDER_VERSION;
}

/**
 * Return the markdown body under the heading for `version` (semver without `v`).
 * Matches semantic-release headings like `# [1.2.0](...)` or `## [1.1.1](...)`.
 */
export function extractChangelogSection(markdown: string, version: string): string | null {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const heading = new RegExp(`^#{1,2} \\[?${escaped}\\]?\\b.*$`, 'm');
  const match = heading.exec(markdown);
  if (!match) {
    return null;
  }

  const start = match.index + match[0].length;
  const rest = markdown.slice(start);
  const next = rest.search(/^#{1,2} /m);
  const body = (next === -1 ? rest : rest.slice(0, next)).trim();
  return body.length > 0 ? body : null;
}

export function readAppVersion(rootDir = process.cwd()): string {
  const raw = readFileSync(resolve(rootDir, 'package.json'), 'utf8');
  const parsed = JSON.parse(raw) as { version?: string };
  if (typeof parsed.version !== 'string' || parsed.version.trim() === '') {
    throw new Error('package.json is missing version');
  }
  return parsed.version.trim();
}

export function readChangelogMarkdown(rootDir = process.cwd()): string {
  return readFileSync(resolve(rootDir, 'CHANGELOG.md'), 'utf8');
}
```

Create `src/services/release/index.ts`:

```typescript
export { ReleaseServiceError } from './errors.js';
export {
  PLACEHOLDER_VERSION,
  extractChangelogSection,
  isPlaceholderVersion,
  readAppVersion,
  readChangelogMarkdown,
} from './changelog.js';
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/services/release/changelog.test.ts`

Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/services/release/changelog.ts src/services/release/changelog.test.ts src/services/release/errors.ts src/services/release/index.ts
git commit -m "$(cat <<'EOF'
feat(release): parse CHANGELOG.md sections by semver

EOF
)"
```

---

### Task 2: Prisma schema and migration

**Files:**

- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260818200000_bot_release_changelog/migration.sql`
- Modify: `.cursor/rules/database-domain.mdc`

**Interfaces:**

- Consumes: existing `GuildConfig` model
- Produces: `BotReleaseStatus` enum; `BotRelease`; `BotReleasePost`; `GuildConfig.changelogChannelId`; `GuildConfig.changelogDraftChannelId`

- [ ] **Step 1: Extend `prisma/schema.prisma`**

Add on `GuildConfig` (before `createdAt`):

```prisma
  changelogChannelId           String?
  changelogDraftChannelId      String?
```

Update the `GuildConfig` comment to: per-server bot settings (roles, quitter leaderboard, changelog channels). IHL fields stay on League.

Append after `GuildConfig`:

```prisma
enum BotReleaseStatus {
  draft
  published
  skipped
}

// Process-wide product version (not league-scoped). Staff draft → player fan-out.
model BotRelease {
  version           String           @id
  engineeringNotes  String
  playerNotes       String
  status            BotReleaseStatus @default(draft)
  draftGuildId      String?
  draftChannelId    String?
  draftMessageId    String?
  publishedAt       DateTime?
  createdAt         DateTime         @default(now())
  updatedAt         DateTime         @updatedAt
  posts             BotReleasePost[]
}

model BotReleasePost {
  version   String
  guildId   String
  channelId String
  messageId String
  release   BotRelease @relation(fields: [version], references: [version], onDelete: Cascade)

  @@id([version, guildId])
  @@index([guildId])
}
```

- [ ] **Step 2: Write the migration SQL**

Create `prisma/migrations/20260818200000_bot_release_changelog/migration.sql`:

```sql
-- AlterTable
ALTER TABLE "GuildConfig" ADD COLUMN "changelogChannelId" TEXT;
ALTER TABLE "GuildConfig" ADD COLUMN "changelogDraftChannelId" TEXT;

-- CreateEnum
CREATE TYPE "BotReleaseStatus" AS ENUM ('draft', 'published', 'skipped');

-- CreateTable
CREATE TABLE "BotRelease" (
    "version" TEXT NOT NULL,
    "engineeringNotes" TEXT NOT NULL,
    "playerNotes" TEXT NOT NULL,
    "status" "BotReleaseStatus" NOT NULL DEFAULT 'draft',
    "draftGuildId" TEXT,
    "draftChannelId" TEXT,
    "draftMessageId" TEXT,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BotRelease_pkey" PRIMARY KEY ("version")
);

-- CreateTable
CREATE TABLE "BotReleasePost" (
    "version" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,

    CONSTRAINT "BotReleasePost_pkey" PRIMARY KEY ("version","guildId")
);

-- AddForeignKey
ALTER TABLE "BotReleasePost" ADD CONSTRAINT "BotReleasePost_version_fkey" FOREIGN KEY ("version") REFERENCES "BotRelease"("version") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "BotReleasePost_guildId_idx" ON "BotReleasePost"("guildId");
```

- [ ] **Step 3: Generate client and note tenancy**

Run: `npx prisma generate`

Expected: client includes `botRelease`, `botReleasePost`, `BotReleaseStatus`.

In `.cursor/rules/database-domain.mdc` under Tenancy, add one bullet:

```text
- **BotRelease / BotReleasePost** — process-wide product versioning and changelog fan-out. Not keyed by `leagueId`.
```

Under Tables, add:

```text
- **BotRelease** — semver PK; staff draft vs published/skipped player notes
- **BotReleasePost** — one posted player message per `(version, guildId)`
```

- [ ] **Step 4: Apply locally if Docker Postgres is up**

Run: `npx prisma migrate deploy`

Expected: migration applied (or skip if local DB is down — CI does not need it; do not leave the SQL uncommitted).

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260818200000_bot_release_changelog .cursor/rules/database-domain.mdc
git commit -m "$(cat <<'EOF'
feat(release): add BotRelease schema and changelog channel columns

EOF
)"
```

---

### Task 3: Guild changelog channel config (TDD)

**Files:**

- Create: `src/services/release/release-config.ts`
- Create: `src/services/release/release-config.test.ts`
- Modify: `src/services/release/index.ts`
- Modify: `src/services/guild/guild-config.ts`
- Modify: `src/services/guild/guild-config.test.ts`

**Interfaces:**

- Consumes: `prisma`, `ReleaseServiceError`
- Produces:
  - `DRAFT_CHANNEL_TAKEN = 'A changelog draft channel is already set in another server. Clear it there first.'`
  - `setChangelogChannel(guildId: string, channelId: string): Promise<void>`
  - `clearChangelogChannel(guildId: string): Promise<void>`
  - `setChangelogDraftChannel(guildId: string, channelId: string): Promise<void>`
  - `clearChangelogDraftChannel(guildId: string): Promise<void>`
  - `findChangelogDraftChannel(): Promise<{ guildId: string; channelId: string } | null>`
  - `listPlayerChangelogChannels(): Promise<{ guildId: string; channelId: string }[]>`
  - `ResolvedGuildConfig.changelogChannelId` / `changelogDraftChannelId`

- [ ] **Step 1: Write the failing uniqueness tests**

Create `src/services/release/release-config.test.ts` with prisma mocked (same `vi.hoisted` + `vi.mock('../../lib/prisma.js')` pattern as `src/services/guild/guild-config.test.ts`):

```typescript
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { findFirst, findMany, upsert } = vi.hoisted(() => ({
  findFirst: vi.fn(),
  findMany: vi.fn(),
  upsert: vi.fn(),
}));

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    guildConfig: { findFirst, findMany, upsert },
  },
}));

import { DRAFT_CHANNEL_TAKEN, setChangelogDraftChannel } from './release-config.js';
import { ReleaseServiceError } from './errors.js';

describe('setChangelogDraftChannel', () => {
  beforeEach(() => {
    findFirst.mockReset();
    upsert.mockReset();
  });

  it('rejects when another guild already has a draft channel', async () => {
    findFirst.mockResolvedValue({ guildId: 'other', changelogDraftChannelId: 'ch-1' });
    await expect(setChangelogDraftChannel('guild-2', 'ch-2')).rejects.toBeInstanceOf(
      ReleaseServiceError,
    );
    await expect(setChangelogDraftChannel('guild-2', 'ch-2')).rejects.toThrow(DRAFT_CHANNEL_TAKEN);
    expect(upsert).not.toHaveBeenCalled();
  });

  it('allows the same guild to change its draft channel', async () => {
    findFirst.mockResolvedValue(null);
    upsert.mockResolvedValue({});
    await setChangelogDraftChannel('guild-1', 'ch-9');
    expect(upsert).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/services/release/release-config.test.ts`

Expected: FAIL — cannot find `./release-config.js`

- [ ] **Step 3: Implement `release-config.ts` and wire `ResolvedGuildConfig`**

```typescript
import { prisma } from '../../lib/prisma.js';
import { ReleaseServiceError } from './errors.js';

export const DRAFT_CHANNEL_TAKEN =
  'A changelog draft channel is already set in another server. Clear it there first.';

export async function setChangelogChannel(guildId: string, channelId: string): Promise<void> {
  await prisma.guildConfig.upsert({
    where: { guildId },
    create: { guildId, changelogChannelId: channelId },
    update: { changelogChannelId: channelId },
  });
}

export async function clearChangelogChannel(guildId: string): Promise<void> {
  await prisma.guildConfig.upsert({
    where: { guildId },
    create: { guildId },
    update: { changelogChannelId: null },
  });
}

export async function setChangelogDraftChannel(guildId: string, channelId: string): Promise<void> {
  const other = await prisma.guildConfig.findFirst({
    where: {
      changelogDraftChannelId: { not: null },
      NOT: { guildId },
    },
    select: { guildId: true },
  });
  if (other) {
    throw new ReleaseServiceError(DRAFT_CHANNEL_TAKEN);
  }

  await prisma.guildConfig.upsert({
    where: { guildId },
    create: { guildId, changelogDraftChannelId: channelId },
    update: { changelogDraftChannelId: channelId },
  });
}

export async function clearChangelogDraftChannel(guildId: string): Promise<void> {
  await prisma.guildConfig.upsert({
    where: { guildId },
    create: { guildId },
    update: { changelogDraftChannelId: null },
  });
}

export async function findChangelogDraftChannel(): Promise<{
  guildId: string;
  channelId: string;
} | null> {
  const row = await prisma.guildConfig.findFirst({
    where: { changelogDraftChannelId: { not: null } },
    select: { guildId: true, changelogDraftChannelId: true },
  });
  if (!row?.changelogDraftChannelId) {
    return null;
  }
  return { guildId: row.guildId, channelId: row.changelogDraftChannelId };
}

export async function listPlayerChangelogChannels(): Promise<
  { guildId: string; channelId: string }[]
> {
  const rows = await prisma.guildConfig.findMany({
    where: { changelogChannelId: { not: null } },
    select: { guildId: true, changelogChannelId: true },
  });
  return rows.flatMap((row) =>
    row.changelogChannelId ? [{ guildId: row.guildId, channelId: row.changelogChannelId }] : [],
  );
}
```

On `ResolvedGuildConfig` add:

```typescript
changelogChannelId: string | undefined;
changelogDraftChannelId: string | undefined;
```

In `resolveGuildConfig` return `trimOptionalId(row?.changelogChannelId)` and `trimOptionalId(row?.changelogDraftChannelId)`.

Update `quitterDefaults` (or equivalent expected objects) in `guild-config.test.ts` to include `changelogChannelId: undefined` and `changelogDraftChannelId: undefined`.

Export the new functions from `src/services/release/index.ts`.

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/services/release/release-config.test.ts src/services/guild/guild-config.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/release/release-config.ts src/services/release/release-config.test.ts src/services/release/index.ts src/services/guild/guild-config.ts src/services/guild/guild-config.test.ts
git commit -m "$(cat <<'EOF'
feat(release): store per-guild changelog channels with one draft channel

EOF
)"
```

---

### Task 4: Ensure draft row (TDD)

**Files:**

- Create: `src/services/release/release-draft.ts`
- Create: `src/services/release/release-draft.test.ts`
- Modify: `src/services/release/index.ts`

**Interfaces:**

- Consumes: `extractChangelogSection`, `isPlaceholderVersion`, `prisma.botRelease`
- Produces:
  - `ensureDraftForVersion(input: { version: string; changelogMarkdown: string }): Promise<'skipped_placeholder' | 'missing_notes' | 'exists' | 'created'>`
  - Does **not** post Discord here (Task 6/8)

- [ ] **Step 1: Write the failing tests**

Create `src/services/release/release-draft.test.ts`:

```typescript
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { findUnique, create } = vi.hoisted(() => ({
  findUnique: vi.fn(),
  create: vi.fn(),
}));

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    botRelease: { findUnique, create },
  },
}));

import { ensureDraftForVersion } from './release-draft.js';

const CHANGELOG = `# [1.0.0](https://example.com) (2026-08-18)

### Features

* first public release
`;

describe('ensureDraftForVersion', () => {
  beforeEach(() => {
    findUnique.mockReset();
    create.mockReset();
  });

  it('skips placeholder 0.1.0 without writing', async () => {
    await expect(
      ensureDraftForVersion({ version: '0.1.0', changelogMarkdown: CHANGELOG }),
    ).resolves.toBe('skipped_placeholder');
    expect(findUnique).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('returns missing_notes when the section is absent', async () => {
    findUnique.mockResolvedValue(null);
    await expect(
      ensureDraftForVersion({ version: '1.0.0', changelogMarkdown: '# Changelog\n' }),
    ).resolves.toBe('missing_notes');
    expect(create).not.toHaveBeenCalled();
  });

  it('returns exists when a row is already present', async () => {
    findUnique.mockResolvedValue({ version: '1.0.0' });
    await expect(
      ensureDraftForVersion({ version: '1.0.0', changelogMarkdown: CHANGELOG }),
    ).resolves.toBe('exists');
    expect(create).not.toHaveBeenCalled();
  });

  it('creates a draft with playerNotes copied from engineering notes', async () => {
    findUnique.mockResolvedValue(null);
    create.mockResolvedValue({});
    await expect(
      ensureDraftForVersion({ version: '1.0.0', changelogMarkdown: CHANGELOG }),
    ).resolves.toBe('created');
    expect(create).toHaveBeenCalledWith({
      data: {
        version: '1.0.0',
        engineeringNotes: '### Features\n\n* first public release',
        playerNotes: '### Features\n\n* first public release',
        status: 'draft',
      },
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/services/release/release-draft.test.ts`

Expected: FAIL — module missing

- [ ] **Step 3: Implement**

```typescript
import { prisma } from '../../lib/prisma.js';
import { extractChangelogSection, isPlaceholderVersion } from './changelog.js';

export async function ensureDraftForVersion(input: {
  version: string;
  changelogMarkdown: string;
}): Promise<'skipped_placeholder' | 'missing_notes' | 'exists' | 'created'> {
  if (isPlaceholderVersion(input.version)) {
    return 'skipped_placeholder';
  }

  const existing = await prisma.botRelease.findUnique({
    where: { version: input.version },
    select: { version: true },
  });
  if (existing) {
    return 'exists';
  }

  const notes = extractChangelogSection(input.changelogMarkdown, input.version);
  if (!notes) {
    return 'missing_notes';
  }

  await prisma.botRelease.create({
    data: {
      version: input.version,
      engineeringNotes: notes,
      playerNotes: notes,
      status: 'draft',
    },
  });
  return 'created';
}
```

Export from the barrel.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/services/release/release-draft.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/release/release-draft.ts src/services/release/release-draft.test.ts src/services/release/index.ts
git commit -m "$(cat <<'EOF'
feat(release): upsert draft BotRelease from changelog notes

EOF
)"
```

---

### Task 5: Publish and dismiss (TDD)

**Files:**

- Create: `src/services/release/release-publish.ts`
- Create: `src/services/release/release-publish.test.ts`
- Modify: `src/services/release/index.ts`

**Interfaces:**

- Consumes: `prisma.botRelease`, `prisma.botReleasePost`, `ReleaseServiceError`, `listPlayerChangelogChannels`
- Produces:
  - `EMPTY_PLAYER_NOTES = 'Write player notes before publishing. Use Dismiss if this version should not be announced.'`
  - `ALREADY_PUBLISHED = 'This version is already published.'`
  - `ALREADY_SKIPPED = 'This version was dismissed.'`
  - `assertCanPublish(release: { status: 'draft' | 'published' | 'skipped'; playerNotes: string }): void`
  - `savePlayerNotes(version: string, playerNotes: string): Promise<void>`
  - `recordReleasePost(input: { version: string; guildId: string; channelId: string; messageId: string }): Promise<'inserted' | 'exists'>`
  - `markReleasePublished(version: string): Promise<void>`
  - `dismissRelease(version: string): Promise<void>`

- [ ] **Step 1: Write the failing tests**

1. `assertCanPublish` with `playerNotes: '  '` throws `EMPTY_PLAYER_NOTES`
2. `assertCanPublish` with `status: 'published'` throws `ALREADY_PUBLISHED`
3. `assertCanPublish` with `status: 'skipped'` throws `ALREADY_SKIPPED`
4. `assertCanPublish` with draft + notes does not throw
5. `recordReleasePost` first call `'inserted'`; second call (unique conflict or prior find) `'exists'`
6. `dismissRelease` updates `status: 'skipped'` and does not create posts

For unique conflict, mock `create` to throw a Prisma `P2002` **or** `findUnique` then `create` — prefer `findUnique` first then `create` so tests do not need Prisma error codes:

```typescript
export async function recordReleasePost(input: {
  version: string;
  guildId: string;
  channelId: string;
  messageId: string;
}): Promise<'inserted' | 'exists'> {
  const existing = await prisma.botReleasePost.findUnique({
    where: { version_guildId: { version: input.version, guildId: input.guildId } },
    select: { version: true },
  });
  if (existing) {
    return 'exists';
  }
  await prisma.botReleasePost.create({ data: input });
  return 'inserted';
}
```

`dismissRelease`: load row; if not `draft`, throw already published/skipped; else `update({ status: 'skipped' })`.

`savePlayerNotes`: trim; allow empty string (Dismiss still works; Publish will refuse). Cap at 4000.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/services/release/release-publish.test.ts`

Expected: FAIL — module missing

- [ ] **Step 3: Implement `release-publish.ts`** using the exact strings above. `markReleasePublished` sets `status: 'published'` and `publishedAt: new Date()`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/services/release/release-publish.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/release/release-publish.ts src/services/release/release-publish.test.ts src/services/release/index.ts
git commit -m "$(cat <<'EOF'
feat(release): publish and dismiss BotRelease with retry-safe posts

EOF
)"
```

---

### Task 6: Embeds and custom ids (TDD)

**Files:**

- Create: `src/services/release/release-embed.ts`
- Create: `src/services/release/release-embed.test.ts`
- Modify: `src/services/release/index.ts`

**Interfaces:**

- Consumes: discord.js `EmbedBuilder`, `ActionRowBuilder`, `ButtonBuilder`, `ButtonStyle`
- Produces:
  - `RELEASE_CUSTOM_PREFIX = 'changelog:'`
  - `parseReleaseCustomId(customId: string): { action: 'edit' | 'publish' | 'dismiss' | 'modal'; version: string } | null`
  - `releaseButtonCustomId(action: 'edit' | 'publish' | 'dismiss', version: string): string`
  - `releaseModalCustomId(version: string): string`
  - `truncateDiscordField(text: string, max?: number): string` — default max `1024`; if truncated, suffix `…`
  - `buildStaffReleaseEmbed(input: { version: string; playerNotes: string; engineeringNotes: string; status: 'draft' | 'published' | 'skipped'; publishedCount?: number; failures?: string[] }): EmbedBuilder`
  - `buildPlayerReleaseEmbed(input: { version: string; playerNotes: string }): EmbedBuilder`
  - `buildStaffReleaseButtons(version: string): ActionRowBuilder<ButtonBuilder>[]` — Edit / Publish / Dismiss; **empty array** when not `draft` (caller passes status)

Staff title: `Draft · v1.4.0` / `Published · v1.4.0` / `Dismissed · v1.4.0`

Published description line: `Posted to N servers.` when `publishedCount` is a number.

Failures: field `Failed` listing reasons if `failures?.length`.

Player embed title: `v1.4.0`, description: `playerNotes` (already ≤4000).

- [ ] **Step 1: Write failing tests** for parse/build custom ids (`changelog:edit:1.4.0`), reject garbage, truncate 1024, staff title for draft.

- [ ] **Step 2: Run tests — expect FAIL**

Run: `npx vitest run src/services/release/release-embed.test.ts`

- [ ] **Step 3: Implement** with `version` matching `/^\d+\.\d+\.\d+$/` in the parser (no prerelease in v1).

- [ ] **Step 4: Run tests — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add src/services/release/release-embed.ts src/services/release/release-embed.test.ts src/services/release/index.ts
git commit -m "$(cat <<'EOF'
feat(release): build changelog staff and player Discord embeds

EOF
)"
```

---

### Task 7: `/config` changelog channels

**Files:**

- Modify: `src/commands/config/config.ts`

**Interfaces:**

- Consumes: `setChangelogChannel`, `clearChangelogChannel`, `setChangelogDraftChannel`, `clearChangelogDraftChannel`, `findChangelogDraftChannel`, `ReleaseServiceError`, plus `postPendingStaffCards` from Task 8 — **if Task 8 is not done yet**, set/clear only; call `postPendingStaffCards` in Task 8 after it exists.
- Produces: subcommands `changelog_channel` and `changelog_draft_channel` under `set` and `clear`; view lines

`config.ts` is large. Add **guild-level** subcommands (no `withSubcommandLeagueOption`) next to `quitter_leaderboard_*`.

Channel types: `ChannelType.GuildText` or `ChannelType.GuildAnnouncement` only.

Refuse copy:

- `Choose a server text or announcement channel for changelogs.`
- `Choose a server text or announcement channel for changelog drafts.`

Success copy:

- `Changelog channel set to <#id>.`
- `Changelog channel cleared.`
- `Changelog draft channel set to <#id>. Pending drafts will post there.`
- `Changelog draft channel cleared.`

View helpers:

```typescript
function formatChangelogChannelLine(channelId: string | undefined): string {
  return channelId ? `**Changelog channel:** <#${channelId}>` : '**Changelog channel:** `unset`';
}

function formatChangelogDraftLine(channelId: string | undefined): string {
  return channelId
    ? `**Changelog draft channel:** <#${channelId}>`
    : '**Changelog draft channel:** `unset`';
}
```

Catch `ReleaseServiceError` the same way as `MatchServiceError` (ephemeral `error.message`). Easiest: `if (error instanceof MatchServiceError || error instanceof ReleaseServiceError)` in the existing execute `catch`.

- [ ] **Step 1: Add builder options + view lines + execute branches** (set/clear). Do not post staff cards yet if Task 8 is incomplete.

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`

Expected: PASS (or only pre-existing errors unrelated to this file)

- [ ] **Step 3: Commit**

```bash
git add src/commands/config/config.ts
git commit -m "$(cat <<'EOF'
feat(config): add changelog and draft channel settings

EOF
)"
```

---

### Task 8: Discord cards, interactions, production `ready`

**Files:**

- Create: `src/discord/interactions/release-interactions.ts`
- Modify: `src/services/release/release-draft.ts` — add `syncCurrentReleaseDraft` + `postPendingStaffCards`
- Modify: `src/events/interaction-create.ts`
- Modify: `src/events/ready.ts`
- Modify: `src/commands/config/config.ts` — after successful `set changelog_draft_channel`, `await postPendingStaffCards(interaction.client)`
- Modify: `src/services/release/index.ts`

**Interfaces:**

- Consumes: all prior release exports; `assertCanConfigureBot`; `env.isDev`; discord.js `Client`
- Produces:
  - `postPendingStaffCards(client: Client): Promise<void>`
  - `syncCurrentReleaseDraft(client: Client, rootDir?: string): Promise<void>`
  - `handleReleaseInteraction(interaction: Interaction): Promise<boolean>`

`syncCurrentReleaseDraft`:

1. `readAppVersion` / `readChangelogMarkdown` (wrap in try/catch; log; return)
2. `ensureDraftForVersion`
3. if result is `missing_notes`, log error and continue to step 4 (other drafts may still need cards)
4. `await postPendingStaffCards(client)`

`postPendingStaffCards`:

1. `findChangelogDraftChannel()` — if null, return
2. `client.channels.fetch(channelId)` — must be text-based; else log and return
3. Load all `botRelease` rows with `status: 'draft'`
4. For each: if `draftMessageId`, `messages.fetch`; on failure send a new message
5. New/updated message: staff embed + buttons
6. `update` draft guild/channel/message ids on the row

`handleReleaseInteraction`:

- Buttons `changelog:edit|publish|dismiss:` and modal `changelog:modal:`
- Return `false` if prefix does not match
- `assertCanConfigureBot` using `interaction.memberPermissions` / `interaction.user.id`; on fail ephemeral `You do not have permission to configure this bot.`
- **Edit:** `showModal` with one paragraph `player_notes`, value = current `playerNotes` sliced to 4000, custom id `changelog:modal:1.4.0`
- **Modal submit:** `savePlayerNotes`, edit the staff message embed
- **Publish:** load release; `assertCanPublish`; `listPlayerChangelogChannels`; for each, skip `recordReleasePost === 'exists'`; else `channel.send` player embed; on success `recordReleasePost`; collect failures (`Missing access`, unknown channel) as English `Could not post in guild \`id\`: reason`
- Then `markReleasePublished`; edit staff message to published embed, `components: []`
- **Dismiss:** `dismissRelease`; edit staff message, `components: []`
- Guild-only; if no `guildId`, return true after ephemeral `This action can only be used in a server.`

`ready.ts` — after existing startup, **production only**:

```typescript
if (!env.isDev) {
  void syncCurrentReleaseDraft(client).catch((error) => {
    log.warn({ err: error }, 'Release draft sync failed');
  });
}
```

Bootstrap must not throw. Import `env` from `../config/env.js`.

`interaction-create.ts`: call `handleReleaseInteraction` **before** lobby/match handlers (same `if (await …) return` pattern).

- [ ] **Step 1: Implement posting + interaction handler + ready + config backfill**

- [ ] **Step 2: Run unit tests + tsc**

Run: `npx vitest run src/services/release && npx tsc --noEmit`

Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/discord/interactions/release-interactions.ts src/services/release/release-draft.ts src/events/interaction-create.ts src/events/ready.ts src/commands/config/config.ts src/services/release/index.ts
git commit -m "$(cat <<'EOF'
feat(release): post staff drafts and publish player changelogs

EOF
)"
```

---

### Task 9: commitlint and Cursor rule

**Files:**

- Create: `commitlint.config.js`
- Create: `.cursor/rules/conventional-commits.mdc`
- Modify: `package.json` (devDependencies)
- Modify: `.github/workflows/ci-cd.yml` (commitlint job only in this task)

**Interfaces:**

- Consumes: `@commitlint/cli`, `@commitlint/config-conventional`
- Produces: PR-title lint; agent rule

- [ ] **Step 1: Add devDependencies**

Run:

```bash
npm install -D @commitlint/cli @commitlint/config-conventional
```

Create `commitlint.config.js`:

```javascript
export default {
  extends: ['@commitlint/config-conventional'],
};
```

Create `.cursor/rules/conventional-commits.mdc`:

````markdown
---
description: Conventional Commits for version bumps and CHANGELOG.md
alwaysApply: true
---

# Conventional Commits

Every commit message and **squash PR title** must follow Conventional Commits. CI lints the PR title. `main` squash-merge is required so the merge commit is releasable.

## Format

```text
type(optional-scope): short summary
```
````

Types:

| Type                                                 | Version bump |
| ---------------------------------------------------- | ------------ |
| `feat`                                               | minor        |
| `fix`                                                | patch        |
| `feat!` / `fix!` / footer `BREAKING CHANGE:`         | major        |
| `docs`, `chore`, `refactor`, `test`, `perf`, `style` | none         |

Examples: `feat(lobby): always show the balance hint`, `fix: hide ki while calibrating`, `docs: add changelog spec`.

Do not use Commitizen. Do not use a subject of `.` or untyped prose on `main`.

````

- [ ] **Step 2: Add the `commitlint` job** to `.github/workflows/ci-cd.yml` **before** `deploy`, PR only:

```yaml
  commitlint:
    name: Commitlint
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "22"
          cache: npm
      - run: npm ci
      - name: Lint PR title
        env:
          TITLE: ${{ github.event.pull_request.title }}
        run: printf '%s\n' "$TITLE" | npx commitlint
````

Do not change `deploy` in this task.

- [ ] **Step 3: Sanity-check commitlint locally**

Run: `printf '%s\n' 'feat(release): parse CHANGELOG.md sections by semver' | npx commitlint`

Expected: exit 0

Run: `printf '%s\n' 'not conventional' | npx commitlint`

Expected: exit 1

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json commitlint.config.js .cursor/rules/conventional-commits.mdc .github/workflows/ci-cd.yml
git commit -m "$(cat <<'EOF'
ci: lint PR titles with commitlint conventional config

EOF
)"
```

---

### Task 10: semantic-release on `main`

**Files:**

- Create: `.releaserc.json`
- Modify: `package.json` (devDependencies)
- Modify: `.github/workflows/ci-cd.yml`

**Interfaces:**

- Consumes: semantic-release plugins listed below
- Produces: release job; deploy `needs: [test, release]`

- [ ] **Step 1: Install plugins**

Run:

```bash
npm install -D semantic-release @semantic-release/changelog @semantic-release/git @semantic-release/github @semantic-release/npm @semantic-release/commit-analyzer @semantic-release/release-notes-generator
```

Create `.releaserc.json`:

```json
{
  "branches": ["main"],
  "tagFormat": "v${version}",
  "plugins": [
    "@semantic-release/commit-analyzer",
    "@semantic-release/release-notes-generator",
    ["@semantic-release/changelog", { "changelogFile": "CHANGELOG.md" }],
    ["@semantic-release/npm", { "npmPublish": false }],
    [
      "@semantic-release/git",
      {
        "assets": ["CHANGELOG.md", "package.json", "package-lock.json"],
        "message": "chore(release): ${nextRelease.version} [skip ci]\n\n${nextRelease.notes}"
      }
    ],
    "@semantic-release/github"
  ]
}
```

Do **not** add a `v0.1.0` tag. First releasable `main` commit becomes **1.0.0**.

- [ ] **Step 2: Insert `release` job; point `deploy` at it**

After `test` / `commitlint`, add:

```yaml
release:
  name: Release
  needs: test
  if: github.event_name == 'push' && github.ref == 'refs/heads/main'
  runs-on: ubuntu-latest
  permissions:
    contents: write
    issues: write
    pull-requests: write
  steps:
    - uses: actions/checkout@v4
      with:
        fetch-depth: 0
        persist-credentials: true
    - uses: actions/setup-node@v4
      with:
        node-version: '22'
        cache: npm
    - run: npm ci
    - run: npx semantic-release
      env:
        GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        GIT_AUTHOR_NAME: github-actions[bot]
        GIT_AUTHOR_EMAIL: 41898282+github-actions[bot]@users.noreply.github.com
        GIT_COMMITTER_NAME: github-actions[bot]
        GIT_COMMITTER_EMAIL: 41898282+github-actions[bot]@users.noreply.github.com
```

Change deploy:

```yaml
deploy:
  name: Deploy
  needs: [test, release]
  if: github.event_name == 'push' && github.ref == 'refs/heads/main'
```

Keep the rest of deploy as-is. `release` must **not** use `[skip ci]` on the triggering push; only the version commit semantic-release pushes includes `[skip ci]`.

Ops (document in the commit body, not a new env var): if `main` requires PRs, allow GitHub Actions to push the release commit.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json .releaserc.json .github/workflows/ci-cd.yml
git commit -m "$(cat <<'EOF'
ci: cut semver GitHub releases with semantic-release on main

EOF
)"
```

---

### Task 11: Staff cheat sheet

**Files:**

- Modify: `docs/discord/staff/a5-admin-cheat-sheet.md`

**Interfaces:**

- Consumes: locked `/config` names from the spec
- Produces: staff copy

- [ ] **Step 1: Add under Config (Manage Server)**

```text
• `/config set|clear changelog_channel` — player patch notes for this server
• `/config set|clear changelog_draft_channel` — one staff draft channel for the whole bot (second server is rejected)
```

Add a short **Releases** section:

```text
**Releases (Manage Server on the draft server)**
• After a version deploys, a Draft card appears in the draft channel
• Edit the player summary, then Publish (all changelog channels) or Dismiss (no player post)
```

- [ ] **Step 2: Commit**

```bash
git add docs/discord/staff/a5-admin-cheat-sheet.md
git commit -m "$(cat <<'EOF'
docs: document changelog channel config and draft publish

EOF
)"
```

---

## Self-review

**Spec coverage**

| Spec item                                                        | Task          |
| ---------------------------------------------------------------- | ------------- |
| semantic-release on `main` after tests, then deploy              | 10            |
| commitlint PR title; squash; no Commitizen/Husky                 | 9             |
| `CHANGELOG.md` + `package.json` + GitHub Release; no npm publish | 10            |
| Runtime version from `package.json`; notes from `CHANGELOG.md`   | 1, 4, 8       |
| Skip `0.1.0`; first tag 1.0.0                                    | 4, 10         |
| `GuildConfig` channels; one draft channel                        | 2, 3, 7       |
| `BotRelease` / `BotReleasePost`                                  | 2, 4, 5       |
| Staff Edit / Publish / Dismiss; fan-out; retry-safe posts        | 5, 6, 8       |
| Production `ready` only; bootstrap must not fail                 | 8             |
| Empty notes cannot Publish; Dismiss → `skipped`                  | 5, 8          |
| No new env/SSM; no GitHub token in bot                           | all           |
| Staff cheat sheet                                                | 11            |
| Tests listed in spec                                             | 1, 3, 4, 5, 6 |

**Placeholders:** none.

**Types:** `ensureDraftForVersion` result union, `recordReleasePost` `'inserted' | 'exists'`, custom-id actions, and `ReleaseServiceError` are named the same in every later task.
