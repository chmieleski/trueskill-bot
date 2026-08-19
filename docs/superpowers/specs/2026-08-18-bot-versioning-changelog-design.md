# Bot versioning and Discord changelogs — Design

**Date:** 2026-08-18  
**Status:** Approved (Approach A — semantic-release on `main`)  
**Scope:** `general` (process-wide product version, not `leagueId`)  
**Plan:** `docs/superpowers/plans/2026-08-18-bot-versioning-changelog.md`

## Goal

Give the bot **real semver releases** and **player-facing patch notes**.

- Conventional Commits on `main` infer **patch / minor / major**.
- CI cuts a GitHub Release + `CHANGELOG.md` whenever a merge is releasable.
- After deploy, the bot opens **one staff draft** per new version. Staff rewrite a short player summary, then **Publish** fans out to every guild that set a changelog channel.

Production **still deploys every `main` merge**. A version exists only when that merge contains `feat`, `fix`, or a breaking change.

## Non-goals

- Commitizen (interactive; agents and `git commit -m` skip it)
- Husky git hooks
- Deploy-on-tag only (stopping CD)
- `npm publish`
- Player `/version` command
- Per-league or per-game notes
- Auto-posting raw conventional-commit text to player channels
- New bot env vars or AWS SSM keys
- GitHub API token in the running bot

## Locked decisions

| Topic                     | Choice                                                                   |
| ------------------------- | ------------------------------------------------------------------------ |
| Approach                  | **A** — semantic-release on `main` after tests, then existing SSM deploy |
| Version source at runtime | `package.json` `version` on disk after `git pull`                        |
| Engineering notes         | Generated `CHANGELOG.md` + GitHub Release                                |
| Player notes              | Staff rewrite on a Discord draft; Publish sends **player** text only     |
| Draft location            | **One** staff channel (`/config set changelog_draft_channel`)            |
| Player destination        | Every guild with `/config set changelog_channel`                         |
| Draft auth                | Same as `/config`: bot owner or **Manage Server**                        |
| First public version      | **1.0.0** (skip placeholder `0.1.0`)                                     |
| Merge style               | **Squash** so the PR title is the `main` commit                          |
| Lint                      | commitlint **PR title** (`@commitlint/config-conventional`)              |
| Draft sync                | Production `ready` only, not `npm run dev`                               |
| No releasable commits     | Deploy still runs; no tag, no draft                                      |
| Release job failure       | **Blocks** that workflow’s deploy                                        |

## Architecture

```text
PR (squash)
  title: feat(lobby): …     ← commitlint
  merge to main
        │
        ▼
CI  test → semantic-release → SSM deploy (git pull)
              │
              ├─ bump package.json (+ lockfile)
              ├─ CHANGELOG.md
              ├─ commit chore(release): 1.4.0 [skip ci]
              ├─ tag v1.4.0
              └─ GitHub Release
        │
        ▼
EC2 host  git pull (includes release commit)
        │
        ▼
Bot production ready
  read package.json version
  skip 0.1.0
  if no BotRelease row:
    parse that version’s CHANGELOG.md section
    insert draft (playerNotes = engineeringNotes)
    post staff card (if draft channel set)
        │
        ▼
Staff  Edit (modal) → Publish | Dismiss
        │
        ▼
Publish  player embed → every changelog_channel
         BotReleasePost per guild (retry-safe)
```

`chore` / `docs` / `test` / `style` / `refactor` / `perf` without `BREAKING CHANGE` do not bump a version.

This feature is **process-global** on purpose. Ratings and matches stay keyed by `leagueId`. `BotRelease` is not.

### CI jobs

| Job          | When                                  | Notes                                                   |
| ------------ | ------------------------------------- | ------------------------------------------------------- |
| `test`       | PR + `main`                           | Unchanged                                               |
| `commitlint` | PR only                               | Lint `github.event.pull_request.title`                  |
| `release`    | push `main`, needs `test`             | `fetch-depth: 0`, `contents: write`, **no** npm publish |
| `deploy`     | push `main`, needs `test` + `release` | Existing SSM path                                       |

semantic-release git plugin assets: `CHANGELOG.md`, `package.json`, `package-lock.json`. Commit message must include `[skip ci]` so the version commit does not start a second workflow.

If `main` requires PRs, grant GitHub Actions permission to push the release commit (or exempt that commit). Otherwise `release` fails and deploy does not run.

### Conventional Commits

Cursor rule (agents + humans):

- `feat:` → minor
- `fix:` → patch
- `feat!:` / `fix!:` / footer `BREAKING CHANGE:` → major
- `docs:`, `chore:`, `refactor:`, `test:`, `perf:`, `style:` → no bump
- Optional scope: `feat(lobby): …`

Do not add Commitizen.

### Runtime modules

| Area                                               | Role                                                                        |
| -------------------------------------------------- | --------------------------------------------------------------------------- |
| `src/services/release/`                            | Parse changelog, upsert draft, publish/dismiss, draft-channel uniqueness    |
| `src/events/ready.ts`                              | Production-only `syncCurrentReleaseDraft(client)` — must not fail bootstrap |
| `src/commands/config/config.ts`                    | `changelog_channel`, `changelog_draft_channel` set/clear + view lines       |
| `src/discord/interactions/release-interactions.ts` | Edit modal, Publish, Dismiss                                                |
| `docs/discord/staff/a5-admin-cheat-sheet.md`       | Config + draft buttons                                                      |

Shared use-cases live in `src/services/release/`. Buttons and any later slash wrapper call the same functions.

## Data model

### `GuildConfig` additions

- `changelogChannelId String?` — player channel for this guild.
- `changelogDraftChannelId String?` — staff draft channel. **At most one row** in the table may have this set. A second guild’s set is rejected until the first is cleared.

Draft **message** ids are not on `GuildConfig`.

Channel types: guild text or announcement (not forum).

### `BotRelease`

| Field                                                | Role                                                           |
| ---------------------------------------------------- | -------------------------------------------------------------- |
| `version`                                            | PK, semver **without** `v` (`1.4.0`)                           |
| `engineeringNotes`                                   | `CHANGELOG.md` section at create time; not edited after insert |
| `playerNotes`                                        | Publish body; pre-filled from `engineeringNotes`               |
| `status`                                             | `draft` \| `published` \| `skipped`                            |
| `draftGuildId` / `draftChannelId` / `draftMessageId` | Staff card; null if no draft channel yet                       |
| `publishedAt`                                        | Set on first successful Publish                                |
| `createdAt` / `updatedAt`                            | Standard                                                       |

### `BotReleasePost`

`@@id([version, guildId])` plus `channelId`, `messageId`. `onDelete: Cascade` from `BotRelease`. Retry Publish skips rows that already exist.

### Draft backfill

If a `draft` row has no `draftMessageId` (channel was unset, post failed, or message deleted): production `ready` or `set changelog_draft_channel` posts/re-posts the staff card.

Skip creating a row for version `0.1.0`.

Multiple unpublished versions → multiple staff cards. No queue.

## Discord UX

All user-facing copy in **English**.

### `/config`

- `set\|clear changelog_channel`
- `set\|clear changelog_draft_channel`
- `/config view` lists both

No `/changelog` command in v1.

### Staff card

- Title: `Draft · v1.4.0`
- Player notes (what Publish will send)
- Engineering notes (truncate to Discord field limits; full text remains on GitHub / `CHANGELOG.md`)
- Buttons: **Edit** · **Publish** · **Dismiss** — all three use `assertCanConfigureBot` (bot owner or Manage Server **on the staff guild** that holds the card). Publish does not require Manage Server on destination guilds.

**Edit** — modal, paragraph, max 4000 characters. Empty player notes: Publish refused (Dismiss still allowed).

**Publish** — player embed title `v1.4.0`, description = `playerNotes`. Fan-out to every `changelogChannelId`. Staff card becomes `Published · v1.4.0` (`N` servers), buttons removed. Status `published`.

**Dismiss** — no player posts. Status `skipped`. Buttons removed. For versions you do not want to announce.

Failed guilds (missing channel, missing Send Messages, unknown channel) are listed on the staff card. Already-posted guilds are not duplicated.

## Error handling

| Case                                     | Behavior                                                                                                |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Changelog parse miss for current version | Log error; no row; bootstrap continues                                                                  |
| Discord post of staff card fails         | Row stays `draft` with null message ids; retry on next `ready` or draft-channel set                     |
| `ready` in development                   | Do **not** auto-sync drafts                                                                             |
| Publish with empty `playerNotes`         | Ephemeral refuse                                                                                        |
| Publish while `published` / `skipped`    | Ephemeral refuse                                                                                        |
| One guild fails during Publish           | Continue; report failures on staff card; successes recorded in `BotReleasePost`                         |
| No player changelog channels             | Publish still marks `published` if at least the staff update succeeds; `N` may be `0`; warn on the card |
| Reconnect / second `ready`               | Idempotent: existing row is not duplicated; missing staff message is re-posted                          |

## Tests

Vitest, no Discord live calls:

- Parse a semantic-release `CHANGELOG.md` section by version; ignore other sections
- Skip placeholder `0.1.0`
- Draft-channel uniqueness (second guild rejected)
- Publish retry skips existing `BotReleasePost`
- Empty `playerNotes` cannot Publish
- `assertCanConfigureBot` still gates Edit/Publish/Dismiss
- Dismiss sets `skipped` and does not insert posts

## Ops

1. Prefer squash-merge on `main`.
2. Allow the `release` job to push the `[skip ci]` commit if branch protection would block it.
3. After deploy of this feature, set `changelog_draft_channel` on the home guild, then `changelog_channel` on each IHL that should get notes.
4. First releasable merge (`feat` / `fix` / breaking) creates **v1.0.0**. There is no `v0.1.0` tag.

## Edge cases

- Direct push to `main` bypasses PR-title lint; semantic-release only releases conventional subjects. Do not rely on direct pushes.
- A `.` or prose commit on `main` (if squash is skipped) will not bump; the code still deploys.
- Local `package.json` already at `1.x` against a cloned prod DB: dev must not post drafts (production `ready` only).
- Embed description max 4096; modal max 4000. Player notes are capped by the modal.
- Custom button ids include the version (`changelog:edit:1.4.0`); stay under Discord’s 100-character custom-id limit.
