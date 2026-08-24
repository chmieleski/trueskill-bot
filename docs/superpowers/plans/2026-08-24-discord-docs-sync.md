# Discord docs channel sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `/sync_docs public|staff` so staff can wipe a chosen channel and post the repo Discord guides in order.

**Architecture:** Shared use-cases under `src/services/docs/` (load → validate → wipe → post). Thin slash adapter in `src/commands/docs/sync-docs.ts`. No database. Auth is Manage Server **or** configured match mod role.

**Tech Stack:** Node.js + TypeScript (ESM), discord.js v14 Slash Commands, Vitest, `fs` / `path` (same cwd root pattern as changelog)

**Spec:** `docs/superpowers/specs/2026-08-24-discord-docs-sync-design.md`

## Global Constraints

- Scope: `general` (no WC3-only imports in core path)
- Auth: Manage Server **or** match mod role (`canConfigureBot` OR `hasMatchModRole`)
- Channel: required `channel:` (GuildText or GuildAnnouncement)
- Order: **load + validate → wipe → post** (never wipe before docs validate)
- Message shape: plain `content` (no embeds); one message per `.md` file
- Skip: `README.md` and non-`.md` files
- Discord limit: reject any body with length > 2000 after trim
- Language: English user-facing strings
- Conventional Commits for every commit
- No new env vars / SSM keys / Prisma models

---

## File map

| File | Responsibility |
| --- | --- |
| `src/services/docs/load-discord-docs.ts` | Read/sort/validate markdown under `docs/discord/{kind}` |
| `src/services/docs/load-discord-docs.test.ts` | Unit tests for load/validate |
| `src/services/docs/wipe-channel-messages.ts` | Empty a text-based channel (bulk + single deletes) |
| `src/services/docs/wipe-channel-messages.test.ts` | Mocked channel wipe tests |
| `src/services/docs/sync-discord-docs.ts` | Orchestrate load → wipe → post |
| `src/services/docs/sync-discord-docs.test.ts` | Orchestration + validate-before-wipe |
| `src/services/docs/docs-auth.ts` | `canSyncDocs` / `assertCanSyncDocs` |
| `src/services/docs/docs-auth.test.ts` | Auth gate unit tests |
| `src/services/docs/docs-errors.ts` | `DocsServiceError` |
| `src/services/docs/index.ts` | Barrel exports |
| `src/commands/docs/sync-docs.ts` | `/sync_docs` slash command |
| `src/commands/docs/sync-docs.test.ts` | Subcommand registration smoke + auth wiring smoke if cheap |
| `docs/discord/README.md` | Document `/sync_docs` usage |

---

### Task 1: Load + validate Discord guide files

**Files:**

- Create: `src/services/docs/docs-errors.ts`
- Create: `src/services/docs/load-discord-docs.ts`
- Create: `src/services/docs/load-discord-docs.test.ts`
- Create: `src/services/docs/index.ts` (partial — export load + error)

**Interfaces:**

- Consumes: `node:fs`, `node:path`, `process.cwd()` (injectable `rootDir`)
- Produces:

```ts
export class DocsServiceError extends Error {
  constructor(message: string);
}

export type DiscordDocsKind = 'public' | 'staff';

export type DiscordDocPost = {
  filename: string;
  content: string;
};

export function loadDiscordDocs(
  kind: DiscordDocsKind,
  rootDir?: string,
): DiscordDocPost[];
```

- [ ] **Step 1: Write the failing tests**

Create `src/services/docs/load-discord-docs.test.ts`:

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DocsServiceError, loadDiscordDocs } from './load-discord-docs.js';

describe('loadDiscordDocs', () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-docs-'));
  });

  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  function writePublic(name: string, body: string): void {
    const dir = path.join(rootDir, 'docs', 'discord', 'public');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), body, 'utf8');
  }

  it('loads .md files sorted by filename and skips README.md', () => {
    writePublic('README.md', 'skip me');
    writePublic('02-b.md', 'second');
    writePublic('01-a.md', 'first');
    writePublic('notes.txt', 'ignore');

    expect(loadDiscordDocs('public', rootDir)).toEqual([
      { filename: '01-a.md', content: 'first' },
      { filename: '02-b.md', content: 'second' },
    ]);
  });

  it('throws when the directory is missing', () => {
    expect(() => loadDiscordDocs('staff', rootDir)).toThrow(DocsServiceError);
    expect(() => loadDiscordDocs('staff', rootDir)).toThrow(/staff/i);
  });

  it('throws when a file is empty after trim', () => {
    writePublic('01-empty.md', '   \n');
    expect(() => loadDiscordDocs('public', rootDir)).toThrow(/01-empty\.md/);
  });

  it('throws when a file exceeds 2000 characters', () => {
    writePublic('01-big.md', 'x'.repeat(2001));
    expect(() => loadDiscordDocs('public', rootDir)).toThrow(/2000/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/services/docs/load-discord-docs.test.ts`

Expected: FAIL (module / exports missing)

- [ ] **Step 3: Implement load + error type**

`src/services/docs/docs-errors.ts`:

```ts
export class DocsServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DocsServiceError';
  }
}
```

`src/services/docs/load-discord-docs.ts`:

```ts
import fs from 'node:fs';
import path from 'node:path';
import { DocsServiceError } from './docs-errors.js';

export type DiscordDocsKind = 'public' | 'staff';

export type DiscordDocPost = {
  filename: string;
  content: string;
};

const DISCORD_MESSAGE_LIMIT = 2000;

export function loadDiscordDocs(
  kind: DiscordDocsKind,
  rootDir: string = process.cwd(),
): DiscordDocPost[] {
  const dir = path.join(rootDir, 'docs', 'discord', kind);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new DocsServiceError(`Discord docs folder not found: docs/discord/${kind}`);
  }

  const names = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.md') && name.toLowerCase() !== 'readme.md')
    .sort((a, b) => a.localeCompare(b));

  const posts: DiscordDocPost[] = [];
  for (const filename of names) {
    const raw = fs.readFileSync(path.join(dir, filename), 'utf8');
    const content = raw.trim();
    if (!content) {
      throw new DocsServiceError(`Discord doc is empty: ${filename}`);
    }
    if (content.length > DISCORD_MESSAGE_LIMIT) {
      throw new DocsServiceError(
        `Discord doc exceeds ${DISCORD_MESSAGE_LIMIT} characters: ${filename} (${content.length})`,
      );
    }
    posts.push({ filename, content });
  }

  if (posts.length === 0) {
    throw new DocsServiceError(`No Discord guide markdown files in docs/discord/${kind}`);
  }

  return posts;
}
```

`src/services/docs/index.ts`:

```ts
export { DocsServiceError } from './docs-errors.js';
export {
  loadDiscordDocs,
  type DiscordDocPost,
  type DiscordDocsKind,
} from './load-discord-docs.js';
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/services/docs/load-discord-docs.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/docs/docs-errors.ts src/services/docs/load-discord-docs.ts src/services/docs/load-discord-docs.test.ts src/services/docs/index.ts
git commit -m "$(cat <<'EOF'
feat(docs): load and validate Discord guide markdown

EOF
)"
```

---

### Task 2: Wipe channel messages

**Files:**

- Create: `src/services/docs/wipe-channel-messages.ts`
- Create: `src/services/docs/wipe-channel-messages.test.ts`
- Modify: `src/services/docs/index.ts`

**Interfaces:**

- Consumes: discord.js message collection APIs (narrow channel type)
- Produces:

```ts
export type WipeableTextChannel = {
  messages: {
    fetch: (options: { limit: number }) => Promise<Map<string, WipeableMessage> | CollectionLike>;
  };
  bulkDelete: (
    messages: Iterable<WipeableMessage> | ReadonlyArray<WipeableMessage>,
    filterOld?: boolean,
  ) => Promise<unknown>;
};

export type WipeableMessage = {
  id: string;
  createdTimestamp: number;
  delete: () => Promise<unknown>;
};

export async function wipeChannelMessages(channel: WipeableTextChannel): Promise<number>;
// returns total messages deleted
```

Use a practical type: accept `TextChannel | NewsChannel` from discord.js in the implementation, but keep the testable surface as the structural type above if preferred. Prefer importing `TextBasedChannel` helpers from discord.js and typing the parameter as:

```ts
import type { GuildTextBasedChannel } from 'discord.js';

export async function wipeChannelMessages(channel: GuildTextBasedChannel): Promise<number>;
```

In tests, pass a plain mock object that satisfies the methods used.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it, vi } from 'vitest';
import { wipeChannelMessages } from './wipe-channel-messages.js';

const TWO_WEEKS_MS = 14 * 24 * 60 * 60 * 1000;

function msg(id: string, ageMs: number) {
  return {
    id,
    createdTimestamp: Date.now() - ageMs,
    delete: vi.fn().mockResolvedValue(undefined),
  };
}

describe('wipeChannelMessages', () => {
  it('bulk-deletes recent messages and stops when empty', async () => {
    const a = msg('1', 1000);
    const b = msg('2', 2000);
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Map([['1', a], ['2', b]]))
      .mockResolvedValueOnce(new Map());
    const bulkDelete = vi.fn().mockResolvedValue(undefined);
    const channel = { messages: { fetch }, bulkDelete };

    const deleted = await wipeChannelMessages(channel as never);
    expect(deleted).toBe(2);
    expect(bulkDelete).toHaveBeenCalled();
    expect(a.delete).not.toHaveBeenCalled();
  });

  it('individually deletes messages older than 14 days', async () => {
    const old = msg('old', TWO_WEEKS_MS + 60_000);
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Map([['old', old]]))
      .mockResolvedValueOnce(new Map());
    const bulkDelete = vi.fn().mockResolvedValue(undefined);
    const channel = { messages: { fetch }, bulkDelete };

    const deleted = await wipeChannelMessages(channel as never);
    expect(deleted).toBe(1);
    expect(old.delete).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/services/docs/wipe-channel-messages.test.ts`

Expected: FAIL (module missing)

- [ ] **Step 3: Implement wipe**

```ts
import type { GuildTextBasedChannel, Message } from 'discord.js';
import { Collection } from 'discord.js';

const TWO_WEEKS_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Delete all messages in a guild text/announcement channel.
 * Uses bulkDelete for messages younger than 14 days; older messages are deleted one-by-one.
 * @returns Number of messages deleted.
 */
export async function wipeChannelMessages(channel: GuildTextBasedChannel): Promise<number> {
  let deleted = 0;

  for (;;) {
    const fetched = await channel.messages.fetch({ limit: 100 });
    if (fetched.size === 0) {
      break;
    }

    const cutoff = Date.now() - TWO_WEEKS_MS;
    const recent = fetched.filter((message) => message.createdTimestamp > cutoff);
    const old = fetched.filter((message) => message.createdTimestamp <= cutoff);

    if (recent.size >= 2) {
      await channel.bulkDelete(recent, true);
      deleted += recent.size;
    } else {
      for (const message of recent.values()) {
        await message.delete();
        deleted += 1;
      }
    }

    for (const message of old.values()) {
      await message.delete();
      deleted += 1;
    }
  }

  return deleted;
}
```

If TypeScript complains about `GuildTextBasedChannel` + `bulkDelete`, narrow to `TextChannel | NewsChannel` (announcement) and document that the command only accepts those channel types.

Re-export from `index.ts`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/services/docs/wipe-channel-messages.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/docs/wipe-channel-messages.ts src/services/docs/wipe-channel-messages.test.ts src/services/docs/index.ts
git commit -m "$(cat <<'EOF'
feat(docs): wipe guild channel messages for guide sync

EOF
)"
```

---

### Task 3: Sync orchestrator (load → wipe → post)

**Files:**

- Create: `src/services/docs/sync-discord-docs.ts`
- Create: `src/services/docs/sync-discord-docs.test.ts`
- Modify: `src/services/docs/index.ts`

**Interfaces:**

- Consumes: `loadDiscordDocs`, `wipeChannelMessages`, `DocsServiceError`
- Produces:

```ts
export type SyncDiscordDocsResult = {
  kind: DiscordDocsKind;
  deletedCount: number;
  postedCount: number;
  filenames: string[];
};

export async function syncDiscordDocsToChannel(input: {
  kind: DiscordDocsKind;
  channel: GuildTextBasedChannel; // or TextChannel | NewsChannel
  rootDir?: string;
}): Promise<SyncDiscordDocsResult>;
```

- [ ] **Step 1: Write the failing tests**

Use `vi.mock` for `./load-discord-docs.js` and `./wipe-channel-messages.js` **or** inject by testing with a real temp dir + mocked channel (prefer real load + mocked channel for validate-before-wipe):

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DocsServiceError } from './docs-errors.js';
import { syncDiscordDocsToChannel } from './sync-discord-docs.js';

describe('syncDiscordDocsToChannel', () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-docs-'));
  });

  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  function writePublic(name: string, body: string): void {
    const dir = path.join(rootDir, 'docs', 'discord', 'public');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), body, 'utf8');
  }

  it('does not wipe when a doc is invalid', async () => {
    writePublic('01-big.md', 'x'.repeat(2001));
    const wipe = vi.fn();
    const send = vi.fn();
    const channel = {
      messages: { fetch: vi.fn() },
      bulkDelete: wipe,
      send,
    };

    // Prefer mocking wipeChannelMessages module if channel shape is awkward:
    // see Step 3 — if using real wipe, mock the module instead.
    await expect(
      syncDiscordDocsToChannel({ kind: 'public', channel: channel as never, rootDir }),
    ).rejects.toThrow(DocsServiceError);
  });

  it('wipes then posts each file in order', async () => {
    writePublic('02-b.md', 'second');
    writePublic('01-a.md', 'first');

    // Implement with vi.mock('./wipe-channel-messages.js') returning deletedCount 3
    // and channel.send resolving; assert send call order first then second.
  });
});
```

Flesh out the second test with an explicit mock of `wipeChannelMessages`:

```ts
const wipeChannelMessages = vi.fn();
vi.mock('./wipe-channel-messages.js', () => ({
  wipeChannelMessages: (...args: unknown[]) => wipeChannelMessages(...args),
}));
```

Place `vi.mock` before imports per Vitest hoisting, or use `vi.hoisted`.

Second test expectations:

```ts
wipeChannelMessages.mockResolvedValue(3);
const send = vi.fn().mockResolvedValue({});
const channel = { send } as never;

const result = await syncDiscordDocsToChannel({
  kind: 'public',
  channel,
  rootDir,
});

expect(wipeChannelMessages).toHaveBeenCalledOnce();
expect(send.mock.calls.map((c) => c[0])).toEqual([
  { content: 'first' },
  { content: 'second' },
]);
expect(result).toEqual({
  kind: 'public',
  deletedCount: 3,
  postedCount: 2,
  filenames: ['01-a.md', '02-b.md'],
});
```

Invalid-doc test: `wipeChannelMessages` must **not** be called.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/services/docs/sync-discord-docs.test.ts`

Expected: FAIL

- [ ] **Step 3: Implement orchestrator**

```ts
import type { GuildTextBasedChannel } from 'discord.js';
import { loadDiscordDocs, type DiscordDocsKind } from './load-discord-docs.js';
import { wipeChannelMessages } from './wipe-channel-messages.js';

export type SyncDiscordDocsResult = {
  kind: DiscordDocsKind;
  deletedCount: number;
  postedCount: number;
  filenames: string[];
};

/**
 * Validate docs, wipe the channel, then post each guide message in filename order.
 */
export async function syncDiscordDocsToChannel(input: {
  kind: DiscordDocsKind;
  channel: GuildTextBasedChannel;
  rootDir?: string;
}): Promise<SyncDiscordDocsResult> {
  const posts = loadDiscordDocs(input.kind, input.rootDir);
  const deletedCount = await wipeChannelMessages(input.channel);

  let postedCount = 0;
  for (const post of posts) {
    await input.channel.send({ content: post.content });
    postedCount += 1;
  }

  return {
    kind: input.kind,
    deletedCount,
    postedCount,
    filenames: posts.map((p) => p.filename),
  };
}
```

If a later `send` throws, let it propagate (command maps to “posted k of n” if desired later — for v1, simple throw after partial posts is acceptable; optionally wrap to attach `postedCount` — **keep v1 simple: rethrow**).

Export from barrel.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/services/docs/sync-discord-docs.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/docs/sync-discord-docs.ts src/services/docs/sync-discord-docs.test.ts src/services/docs/index.ts
git commit -m "$(cat <<'EOF'
feat(docs): sync Discord guides to a channel

EOF
)"
```

---

### Task 4: Auth helper + `/sync_docs` command

**Files:**

- Create: `src/services/docs/docs-auth.ts`
- Create: `src/services/docs/docs-auth.test.ts`
- Create: `src/commands/docs/sync-docs.ts`
- Create: `src/commands/docs/sync-docs.test.ts`
- Modify: `src/services/docs/index.ts`
- Modify: `docs/discord/README.md`

**Interfaces:**

- Consumes: `canConfigureBot` from guild-config; `hasMatchModRole` from match-auth; `resolveGuildConfig`; `syncDiscordDocsToChannel`; `DocsServiceError`
- Produces:

```ts
export const SYNC_DOCS_FORBIDDEN =
  'Only server managers or match moderators can sync Discord docs.';

export function canSyncDocs(input: {
  userId: string;
  memberPermissions: /* same as canConfigureBot */;
  memberRoleIds: string[];
  matchModRoleId?: string;
}): boolean;

export function assertCanSyncDocs(input: /* same */): void; // throws DocsServiceError
```

Command:

```ts
export const data = new SlashCommandBuilder()
  .setName('sync_docs')
  .setDescription('Wipe a channel and post the bot Discord guides')
  .addSubcommand((sub) =>
    sub
      .setName('public')
      .setDescription('Post public player guides into a channel')
      .addChannelOption((opt) =>
        opt
          .setName('channel')
          .setDescription('Channel to clear and fill')
          .setRequired(true)
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('staff')
      .setDescription('Post staff guides into a channel')
      .addChannelOption((opt) =>
        opt
          .setName('channel')
          .setDescription('Channel to clear and fill')
          .setRequired(true)
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
      ),
  );
```

- [ ] **Step 1: Write failing auth tests**

```ts
import { PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { assertCanSyncDocs, canSyncDocs, SYNC_DOCS_FORBIDDEN } from './docs-auth.js';
import { DocsServiceError } from './docs-errors.js';

describe('canSyncDocs', () => {
  it('allows Manage Server', () => {
    const perms = new PermissionsBitField(PermissionFlagsBits.ManageGuild);
    expect(
      canSyncDocs({
        userId: 'u1',
        memberPermissions: perms,
        memberRoleIds: [],
      }),
    ).toBe(true);
  });

  it('allows configured mod role', () => {
    expect(
      canSyncDocs({
        userId: 'u1',
        memberPermissions: 0n,
        memberRoleIds: ['mod'],
        matchModRoleId: 'mod',
      }),
    ).toBe(true);
  });

  it('rejects everyone else', () => {
    expect(
      canSyncDocs({
        userId: 'u1',
        memberPermissions: 0n,
        memberRoleIds: ['other'],
        matchModRoleId: 'mod',
      }),
    ).toBe(false);
  });
});

describe('assertCanSyncDocs', () => {
  it('throws DocsServiceError when forbidden', () => {
    expect(() =>
      assertCanSyncDocs({
        userId: 'u1',
        memberPermissions: null,
        memberRoleIds: [],
      }),
    ).toThrow(DocsServiceError);
    expect(() =>
      assertCanSyncDocs({
        userId: 'u1',
        memberPermissions: null,
        memberRoleIds: [],
      }),
    ).toThrow(SYNC_DOCS_FORBIDDEN);
  });
});
```

Command smoke test (`sync-docs.test.ts`):

```ts
import { describe, expect, it } from 'vitest';
import { data } from './sync-docs.js';

describe('sync_docs command', () => {
  it('registers public and staff subcommands with required channel', () => {
    const json = data.toJSON();
    expect(json.name).toBe('sync_docs');
    const names = (json.options ?? []).map((o) => o.name);
    expect(names).toEqual(expect.arrayContaining(['public', 'staff']));
  });
});
```

- [ ] **Step 2: Run auth tests to verify they fail**

Run: `npm test -- src/services/docs/docs-auth.test.ts`

Expected: FAIL

- [ ] **Step 3: Implement auth**

```ts
import type { PermissionsBitField, PermissionsString } from 'discord.js';
import { canConfigureBot } from '../guild/guild-config.js';
import { hasMatchModRole } from '../match/match-auth.js';
import { DocsServiceError } from './docs-errors.js';

export const SYNC_DOCS_FORBIDDEN =
  'Only server managers or match moderators can sync Discord docs.';

export function canSyncDocs(input: {
  userId: string;
  memberPermissions:
    | PermissionsBitField
    | bigint
    | string
    | ReadonlyArray<PermissionsString>
    | null
    | undefined;
  memberRoleIds: string[];
  matchModRoleId?: string;
}): boolean {
  if (canConfigureBot({ userId: input.userId, memberPermissions: input.memberPermissions })) {
    return true;
  }
  return hasMatchModRole({
    actorDiscordId: input.userId,
    memberRoleIds: input.memberRoleIds,
    matchModRoleId: input.matchModRoleId,
  });
}

export function assertCanSyncDocs(input: Parameters<typeof canSyncDocs>[0]): void {
  if (!canSyncDocs(input)) {
    throw new DocsServiceError(SYNC_DOCS_FORBIDDEN);
  }
}
```

- [ ] **Step 4: Implement command**

Mirror `memberRoleIds` / `memberPermissions` helpers from `player-new.ts` / `leaderboard.ts`.

`execute` outline:

1. `await interaction.deferReply({ flags: MessageFlags.Ephemeral })`
2. Reject missing `guildId`
3. `resolveGuildConfig` → `assertCanSyncDocs({ userId, memberPermissions, memberRoleIds, matchModRoleId })`
4. `const kind = interaction.options.getSubcommand(true)` as `'public' | 'staff'`
5. `const channel = interaction.options.getChannel('channel', true)` — ensure it is sendable text (`isTextBased()` + `guild` + has `.send` / cast to `TextChannel | NewsChannel`). If wrong type: editReply error.
6. `const result = await syncDiscordDocsToChannel({ kind, channel })`
7. Success: `Cleared #${channel.name} and posted ${result.postedCount} ${kind} guide messages.`
8. Catch `DocsServiceError` / Discord API errors → English `editReply`

Also catch permission failures from wipe/send and reply with guidance to grant **Manage Messages** and **Send Messages**.

- [ ] **Step 5: Update `docs/discord/README.md`**

Replace/augment the manual copy-paste intro with:

```markdown
# Discord bot guides — how to post

Use `/sync_docs public channel:#…` or `/sync_docs staff channel:#…` (Manage Server or match mod role).

The command **deletes all messages** in that channel, then posts these files in order.

…
```

Keep the file order lists.

- [ ] **Step 6: Run all related tests + typecheck**

Run:

```bash
npm test -- src/services/docs src/commands/docs
npm run typecheck
```

Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/services/docs/docs-auth.ts src/services/docs/docs-auth.test.ts src/services/docs/index.ts src/commands/docs/sync-docs.ts src/commands/docs/sync-docs.test.ts docs/discord/README.md
git commit -m "$(cat <<'EOF'
feat(docs): add /sync_docs public and staff command

EOF
)"
```

---

## Self-review (plan vs spec)

| Spec requirement | Task |
| --- | --- |
| `/sync_docs` + `public` / `staff` | Task 4 |
| Required channel (text/announcement) | Task 4 |
| Wipe all messages then post | Tasks 2–3 |
| Auth Manage Server OR mod role | Task 4 |
| Load from `docs/discord/{kind}`, sort, skip README | Task 1 |
| Validate before wipe | Task 3 |
| Plain content messages | Task 3 |
| No DB / no env | All |
| Update README | Task 4 |
| Tests for load, wipe, sync, auth | Tasks 1–4 |

No placeholders left; signatures consistent (`DiscordDocsKind`, `loadDiscordDocs`, `wipeChannelMessages`, `syncDiscordDocsToChannel`, `assertCanSyncDocs`).
