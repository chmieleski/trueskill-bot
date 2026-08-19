---
name: drafting-player-changelog
description: >-
  Use when drafting Discord player changelog or patch notes, rewriting a GitHub
  Release or CHANGELOG.md for players, filling the staff changelog Edit modal,
  or when the user names a release tag such as v1.2.0.
---

# Drafting player changelog

Rewrite **engineering** release notes into **player** Discord notes. Staff paste **raw** Discord markdown into the changelog Edit modal. Publish puts that text in an embed description titled `vX.Y.Z`.

Staff cannot copy source from rendered chat. The notes exist only inside a ` ```text ` fence. If the notes are rendered markdown with no fence, the task is not done — wrap them before sending.

Gold samples: [examples.md](examples.md)

## Workflow

1. **Resolve the tag.** User named `v1.2.0` / `1.2.0` → use it (accept with or without `v`). Else `latest`. Else `gh release list --limit 5` and take the newest.
2. **Fetch GitHub first.** Do not start from local `CHANGELOG.md` when a tag exists.

```bash
gh release view v1.2.0 --repo OWNER/REPO --json tagName,name,body,url
```

`OWNER/REPO` from `git remote get-url origin`. First `gh` call: `required_permissions: ["all"]` (sandbox GraphQL is `Forbidden`). GitHub MCP `get_release_by_tag` is equivalent if authenticated.

Tag 404 → try the other of `v1.2.0` / `1.2.0`. Still missing → `CHANGELOG.md` heading for that version, and say GitHub missed.

3. **Collapse to what players see.** Many `feat(scope):` commits are one feature. Drop hashes, PR numbers, `customId`, pagination internals, CI/infra unless players feel it.
4. **Check real UX** before claiming a command or button (slash `setDescription`, `docs/discord/public/`). English only.
5. **Draft inner notes** (Discord embed markdown). Cap **4000** characters (modal / `PLAYER_NOTES_MAX`).
6. **Write the fence first, then fill it.** Final message parts, in order:

   1. One sentence: GitHub tag + url + “Paste into the staff Edit modal:”
   2. A line that is exactly ` ```text `
   3. Inner player notes (raw Discord markdown)
   4. A line that is exactly ` ``` `

````
Fetched [GitHub v1.2.0](https://github.com/OWNER/REPO/releases/tag/v1.2.0). Paste into the staff Edit modal:

```text
🎉 **What's new in v1.2.0**

Hook and sections go here.
```
````

Do not send part 3 without parts 2 and 4. Do not add a second copy of the notes as rendered markdown.

## Inner notes recipe

```text
EMOJI **What's new in vX.Y.Z**

One-sentence hook (what players can do now).

EMOJI **Name players would say**
What it does, in lobby/match words.

• How to use it (`/command` in backticks)
• Who can use it, if it is not everyone
• One gotcha if it would surprise them
```

- Emoji + `**bold**` section titles. No `#` headings (embeds ignore them).
- Inline `` `/match list` `` for commands. No nested ` ``` ` fences inside the notes (they break the copy wrapper and the embed).
- `•` bullets. Numbered emoji steps (`1️⃣`) when order matters.
- Skip a version line if the user is pasting into a card that already shows `vX.Y.Z` **and** they ask to omit it; default is keep the What's-new line.

## Red flags — fix before sending

| Thought | Do this |
|---------|---------|
| Local CHANGELOG is enough | Fetch `gh release view` first |
| User already pasted commits | GitHub body is still source of truth; paste is a hint |
| Rendered markdown is nicer / user didn’t say codeblock | Invalid without ` ```text `. Wrap, then send. |
| List every commit | Collapse to player-visible features |
| `gh` Forbidden | Retry once with `required_permissions: ["all"]` |

## Common mistakes

- Notes only as rendered Discord markdown, no copy fence
- `### Features` / conventional-commit subjects / hashes in player text
- Inventing command syntax without reading the command
- Inner notes over 4000 characters
- Tables (embeds do not render markdown tables)
