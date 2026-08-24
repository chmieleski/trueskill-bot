# Discord docs channel sync — Design

**Date:** 2026-08-24  
**Status:** Approved for implementation  
**Scope:** `general` (guild admin tooling; not game-specific rating/lobby logic)  
**Plan:** [`docs/superpowers/plans/2026-08-24-discord-docs-sync.md`](../plans/2026-08-24-discord-docs-sync.md)  
**Related:** `docs/discord/README.md`, `docs/discord/public/*`, `docs/discord/staff/*`

## Goal

Let staff publish the repo Discord guides into guild channels with one slash command:

- `/sync_docs public` → wipe target channel, post `docs/discord/public/*.md` in order  
- `/sync_docs staff` → wipe target channel, post `docs/discord/staff/*.md` in order  

Re-running the same subcommand on a channel replaces the channel contents (full wipe, then new posts). No automatic update on deploy; operators re-run the command when docs change.

## Non-goals (v1)

- Separate top-level commands (`/sync_docs_public`, `/sync_docs_staff`)
- Persisting posted message IDs in the database
- Deleting only previous bot posts (tracked or “bot messages only”)
- Auto-sync on bot startup or deploy
- Pinning the first message
- Embeds / rich formatting beyond the markdown already in the files
- Splitting files over Discord’s 2000-character limit
- New env vars or AWS SSM keys
- Per-league channel config for docs (channel is always chosen at command time)

## Locked decisions

| Topic | Choice |
| --- | --- |
| Surface | One command `/sync_docs` with subcommands `public` and `staff` |
| Channel | Required `channel:` option (guild text or announcement) |
| Re-sync | Wipe **all** messages in the target channel, then post |
| Auth | Manage Server **or** configured match mod role |
| Content source | Files under `docs/discord/{public\|staff}/`, sorted by filename |
| Skip | Non-`.md` files and `README.md` |
| Message shape | Plain `content` messages (Discord markdown as written in files) |
| Persistence | None (no Prisma / GuildConfig fields) |
| Language | English user-facing strings |

## Architecture

```text
/sync_docs public|staff channel:#…
        │
        ▼
  sync-docs command (thin)
        │  defer ephemeral reply
        │  auth: Manage Server OR match mod role
        │  resolve Text/Announcement channel
        ▼
  syncDiscordDocsToChannel({ kind, channel })
        │
        ├─ loadDiscordDocs(kind)  ← docs/discord/{kind}/*.md (validate first)
        ├─ wipeChannelMessages(channel)
        └─ channel.send({ content }) per file in order
```

### Modules

| Piece | Path | Responsibility |
| --- | --- | --- |
| Command | `src/commands/docs/sync-docs.ts` | Slash definition, defer, auth, channel resolve, call use-case, ephemeral summary |
| Load | `src/services/docs/load-discord-docs.ts` | Resolve `docs/discord/{kind}` from `process.cwd()`, list/sort `.md`, read bodies, enforce ≤2000 chars |
| Wipe | `src/services/docs/wipe-channel-messages.ts` | Fetch in batches; bulk-delete (&lt;14d); single-delete older; stop when empty |
| Sync | `src/services/docs/sync-discord-docs.ts` | Orchestrate load → wipe → post |
| Barrel | `src/services/docs/index.ts` | Public exports |

Root path resolution matches changelog helpers: default `process.cwd()` (works for `tsx` watch and production `dist/` when the process cwd is the app root).

### Auth details

- Guild-only command (reject DMs).
- **Manage Server:** reuse `canConfigureBot` / `assertCanConfigureBot` patterns from guild config.
- **Mod role:** resolve `matchModRoleId` via `resolveGuildConfig(guildId)`; allow if the member has that role (same concept as `hasMatchModRole` in match auth).
- Either condition is enough. If no mod role is configured, only Manage Server (or Administrator via that bit) may run the command.

### Wipe details

- Bot must be able to **Manage Messages** (and View Channel / Send Messages) in the target channel; fail with a clear ephemeral error if wipe or send fails for permissions.
- Loop: fetch up to 100 messages → `bulkDelete` eligible set → individually delete any remaining (e.g. older than 14 days) → repeat until a fetch returns empty.
- Do not delete messages in other channels. Do not store IDs.

### Post details

- One message per markdown file, filename order (`01-…` before `07-…`, `a1-…` before `a7-…`).
- Trim trailing whitespace; reject empty bodies.
- If any file exceeds 2000 characters **before** wipe completes posting, fail the sync early after load validation (prefer validate load **before** wipe so a bad doc does not empty the channel). Order: **load + validate → wipe → post**.

### Interaction UX

1. `deferReply({ ephemeral: true })` immediately.
2. On success: `Cleared #<channel> and posted N public|staff guide messages.`
3. On auth / channel / load / permission failure: ephemeral English error; no partial wipe if load validation failed first.
4. If wipe succeeds and a later `send` fails: report how many messages were posted; no automatic restore of deleted messages.

## Error cases

| Condition | Behavior |
| --- | --- |
| Not in a guild | Ephemeral reject |
| Caller lacks Manage Server and mod role | Ephemeral permission error |
| Channel not text/announcement or not in guild | Ephemeral reject |
| Docs directory missing / unreadable | Fail before wipe |
| Any doc empty or &gt; 2000 chars | Fail before wipe with filename |
| Missing Manage Messages / Send Messages | Fail with Discord permission guidance |
| Mid-post send failure | Partial success message (posted k of n) |

## Testing

- **loadDiscordDocs:** sorts by name; skips `README.md` / non-md; throws on oversize / empty (temp fixture dir).
- **wipeChannelMessages:** mocked channel — bulk path for young messages, individual path for old; loops until empty.
- **syncDiscordDocsToChannel:** validate-before-wipe (oversized fixture must not call wipe); happy path wipe then N sends.
- **Command auth:** Manage Server alone OK; mod role alone OK; neither rejected (unit/integration style consistent with other commands).

## Docs / ops follow-up (implementation)

- Update `docs/discord/README.md` to mention `/sync_docs` instead of (or in addition to) manual copy-paste.
- Optionally mention the command on the staff cheat sheet (`a5`) — only if editing that guide in the same change set is desired; not required for v1 of the feature code.

## Out of scope reminders

Staff must keep public and staff guides in **separate** Discord channels. The command does not enforce that; wrong channel choice will wipe and replace whatever is there.
