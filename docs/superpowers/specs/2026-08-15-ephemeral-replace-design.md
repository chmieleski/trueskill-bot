# Ephemeral Replace on Public Buttons — Design

**Date:** 2026-08-15  
**Status:** Approved  
**Scope:** Lobby Fix Reading + match report/cancel private UIs that open from public message buttons

## Goal

When a user opens a **new** private (ephemeral) UI from a **public** lobby or match button, delete their previous ephemeral in that channel (best-effort), then send the new one. Stops stacked “Only you can see this” messages from forcing scroll to reach the public buttons again.

## Non-goals

- Changing public lobby/match embeds or button layouts
- Persisting ephemeral sessions across bot restarts (in-memory only)
- Guaranteeing delete after Discord’s interaction-token lifetime (~15 minutes)
- Reworking unrelated slash-command ephemerals (`/config`, `/link`, `/rank`, etc.) in this change
- Adding a separate “Done” collapse pass (optional later; not required for A)

## Locked decisions

| Topic          | Choice                                                                                 |
| -------------- | -------------------------------------------------------------------------------------- |
| Approach       | Track previous ephemeral → delete → reply new                                          |
| Key            | `userId:channelId` — one active private UI per user per channel                        |
| Storage        | In-memory map (lost on restart; acceptable)                                            |
| Wizard steps   | Keep `interaction.update` / `editReply` — do **not** delete or create a second message |
| Delete failure | Ignore (expired token, unknown message, post-restart); still send the new ephemeral    |
| Surfaces       | Lobby Fix Reading entry + match Report / Quitters / Cancel entry                       |

## Architecture

```text
src/lib/ephemeral-session.ts
  sessionKey(userId, channelId) → string
  remember(key, { applicationId, token, messageId })
  takePrevious(key) → entry | null
  deletePrevious(client/rest, userId, channelId) → Promise<void>  // best-effort

lobby-interactions / match-interactions
  replyEphemeral(...) when creating a NEW ephemeral from a public click:
    1. await deletePrevious(...)
    2. reply / followUp (ephemeral)
    3. remember new token + message id
  updateEphemeral(...) unchanged (in-place wizard)
```

Delete uses Discord’s webhook message delete for the stored interaction (`applicationId` + `token` + message id / `@original`), not a channel message delete (ephemerals are not normal channel messages).

## Call sites

| Surface                                                                    | File                    | Behavior after                                                                              |
| -------------------------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------- |
| Edit nick / Move / Remove / Add (and other public → new ephemeral entry)   | `lobby-interactions.ts` | `replyEphemeral` (and equivalent direct `reply` entry points) delete-previous then remember |
| Report Winner / Quitters / Cancel entry                                    | `match-interactions.ts` | Same via shared `replyEphemeral`                                                            |
| Select/button steps on the ephemeral                                       | both                    | `updateEphemeral` only — no session delete                                                  |
| Errors that `replyEphemeral` after `deferUpdate` on the **public** message | both                    | Also replace previous private UI so error toasts don’t stack forever                        |

## Edge cases

- User A never deletes or overwrites user B’s ephemeral (key includes `userId`).
- After bot restart, the first reopen may leave one orphaned ephemeral; subsequent opens stay clean.
- If `followUp` is used after `deferUpdate` on the public message, remember the **followUp** message id (not the public message).
- Modal flows that edit the deferred ephemeral stay on the same message; do not treat modal submit as a “new open” unless it creates a separate followUp.

## Testing & ops

- Unit-test the session map: remember → takePrevious returns and clears; deletePrevious no-ops when empty; key isolation by user/channel.
- Manual: open Fix Reading twice → only one ephemeral visible; step through match report wizard → still single message updating in place; second Report Winner replaces the first private UI.
- No env / SSM / Prisma changes.

## Rejected alternatives

| Option                                          | Why not                                            |
| ----------------------------------------------- | -------------------------------------------------- |
| B — Only update when already on ephemeral       | Does not fix reopen-from-public stacking           |
| C — Collapse to “Done” without delete-on-reopen | Still clutters; full A already clears on next open |
