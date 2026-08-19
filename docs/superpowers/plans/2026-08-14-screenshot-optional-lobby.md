# Screenshot-Optional Empty Lobby Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a create-role host run `/register_lobby` without a screenshot and get an empty PENDING match they can fill with existing buttons and `/lobby add`.

**Architecture:** Make the `print` attachment optional. If missing, skip OCR and pass `[]` into `createPendingMatch` (already allowed). Keep Gemini OCR when an image is attached. No wc3stats in this plan.

**Tech Stack:** Node.js + TypeScript ESM, discord.js v14, Vitest

**Spec:** [docs/superpowers/specs/2026-08-14-screenshotless-lobby-design.md](../specs/2026-08-14-screenshotless-lobby-design.md) — Phase 1 (route C)

## Global Constraints

- User-facing strings in **English**
- Create-role gate stays before any OCR
- `GEMINI_API_KEY` stays required (OCR path still exists)
- Empty roster is valid; Start still needs both teams (`canStartLobby`)
- ESM imports use `.js` extensions
- Commits only when the user asks (skip commit steps unless requested)

## File structure

| File                                         | Responsibility                                       |
| -------------------------------------------- | ---------------------------------------------------- |
| `src/commands/lobby/register-lobby.ts`       | Optional `print`; empty players when omitted         |
| `src/services/lobby-ocr.ts`                  | Unchanged                                            |
| `src/services/match-service.ts`              | Unchanged (`createPendingMatch` already allows `[]`) |
| `src/services/register-lobby-source.ts`      | Pure helper: decide OCR vs empty (testable)          |
| `src/services/register-lobby-source.test.ts` | Unit tests for the helper                            |

---

### Task 1: Source helper (OCR vs empty)

**Files:**

- Create: `src/services/register-lobby-source.ts`
- Create: `src/services/register-lobby-source.test.ts`

**Interfaces:**

- Produces:
  - `export type RegisterLobbySource = { kind: 'empty' } | { kind: 'screenshot'; url: string; mimeType: string }`
  - `export function resolveRegisterLobbySource(input: { attachmentUrl?: string | null; mimeType?: string | null }): RegisterLobbySource`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest';
import { resolveRegisterLobbySource } from './register-lobby-source.js';

describe('resolveRegisterLobbySource', () => {
  it('returns empty when no attachment url is given', () => {
    expect(resolveRegisterLobbySource({})).toEqual({ kind: 'empty' });
    expect(resolveRegisterLobbySource({ attachmentUrl: null })).toEqual({ kind: 'empty' });
    expect(resolveRegisterLobbySource({ attachmentUrl: '' })).toEqual({ kind: 'empty' });
  });

  it('returns screenshot when url and mime are present', () => {
    expect(
      resolveRegisterLobbySource({
        attachmentUrl: 'https://cdn.discordapp.com/a.png',
        mimeType: 'image/png',
      }),
    ).toEqual({
      kind: 'screenshot',
      url: 'https://cdn.discordapp.com/a.png',
      mimeType: 'image/png',
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/services/register-lobby-source.test.ts`

Expected: FAIL — module not found

- [ ] **Step 3: Implement the helper**

```ts
export type RegisterLobbySource =
  { kind: 'empty' } | { kind: 'screenshot'; url: string; mimeType: string };

/**
 * Decide whether /register_lobby should OCR a screenshot or start empty.
 * wc3stats import is out of scope for Phase 1.
 */
export function resolveRegisterLobbySource(input: {
  attachmentUrl?: string | null;
  mimeType?: string | null;
}): RegisterLobbySource {
  const url = input.attachmentUrl?.trim() ?? '';
  if (url === '') {
    return { kind: 'empty' };
  }

  return {
    kind: 'screenshot',
    url,
    mimeType: input.mimeType?.trim() || 'image/png',
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/services/register-lobby-source.test.ts`

Expected: PASS

---

### Task 2: Make `print` optional and skip OCR when omitted

**Files:**

- Modify: `src/commands/lobby/register-lobby.ts`

**Interfaces:**

- Consumes: `resolveRegisterLobbySource`
- Produces: `/register_lobby` works with zero options besides the implicit create-role check

- [ ] **Step 1: Change the slash option**

In `data`, set the attachment optional and update copy:

```ts
export const data = new SlashCommandBuilder()
  .setName('register_lobby')
  .setDescription('Register a DBZ match lobby (up to 6v6). Screenshot is optional.')
  .addAttachmentOption((option) =>
    option.setName('print').setDescription('Lobby screenshot (optional)').setRequired(false),
  );
```

- [ ] **Step 2: Resolve source after auth, before OCR**

Replace the required `getAttachment('print', true)` block with:

```ts
import { resolveRegisterLobbySource } from '../../services/register-lobby-source.js';

const attachment = interaction.options.getAttachment('print');

if (attachment && !isImageAttachment(attachment)) {
  log.warn(
    { userId: interaction.user.id, contentType: attachment.contentType, name: attachment.name },
    'Rejected non-image attachment',
  );
  await interaction.editReply(
    'Please attach a valid lobby screenshot image (PNG, JPG, WEBP, or GIF).',
  );
  return;
}

if (!interaction.channelId) {
  await interaction.editReply('Could not determine the channel for this lobby.');
  return;
}

const source = resolveRegisterLobbySource({
  attachmentUrl: attachment?.url,
  mimeType: attachment ? resolveMimeType(attachment) : null,
});

const players =
  source.kind === 'screenshot' ? await tryExtractLobbyPlayers(source.url, source.mimeType) : [];
```

Keep `createPendingMatch` / embed / `attachDiscordMessage` as they are.

When `source.kind === 'empty'`, after a successful create, if `players.length === 0`, the existing embed already says to add humans to each team. Optionally append a one-line editReply description via the embed (no new banner required in Phase 1).

- [ ] **Step 3: Log the source**

In the existing `Register lobby started` log object, add `hasScreenshot: Boolean(attachment)`.

- [ ] **Step 4: Run the suite**

Run: `npx vitest run`

Expected: PASS (no command execute tests exist; helper tests cover the branch)

---

### Task 3: Operator-facing copy

**Files:**

- Modify: `.cursor/rules/slash-commands.mdc` example description if it still says screenshot-required
- Modify: `.cursor/rules/scripts-and-env.mdc` only if it claims screenshot is required (do not change env vars)

- [ ] **Step 1: Update the slash-commands example description to match Task 2**

```ts
  .setDescription('Register a DBZ match lobby (up to 6v6). Screenshot is optional.');
```

- [ ] **Step 2: Sanity-check Discord deploy is still auto in dev**

No code change. `AUTO_DEPLOY_COMMANDS` already re-registers on restart.

---

## Rollback

Revert the command option to `setRequired(true)` and always OCR. Matches created empty remain valid.

## Done when

- `/register_lobby` with no attachment creates a PENDING embed with empty teams.
- `/register_lobby` with a valid image still OCRs.
- Invalid non-image attachment still rejected.
- Create-role failures still happen before OCR.
