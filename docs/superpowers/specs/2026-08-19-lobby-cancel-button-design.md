# Pending lobby Cancel button — Design

**Date:** 2026-08-19  
**Status:** Approved  
**Scope:** `general` (pending lobby cancel; same for every game/league)  
**Plan:** `docs/superpowers/plans/2026-08-19-lobby-cancel-button.md`

## Goal

Hosts and match mods can cancel a **pending** lobby from the public lobby card, with a private confirm step, instead of typing `/lobby cancel`.

## Non-goals

- Changing in-progress Cancel (`match:cancel`) or its quitter-penalty copy
- Removing `/lobby cancel`
- Host-only (mods stay allowed, same as the slash command)
- Letting seated players cancel
- Confirming on the public card
- Auto-cancel / replace when a host opens a second lobby
- Prisma, env, or AWS SSM changes

## Locked decisions

| Topic | Choice |
|-------|--------|
| Who | Host, match-mod role, or universal match mod (`assertCanManageMatch`) |
| Confirm | Ephemeral Confirm / Keep before cancel |
| Placement | Own last row on the pending card (not on Start / Refresh) |
| Visibility | Always on unlocked pending cards, including when Start is hidden |
| Public style | Label `Cancel`, `ButtonStyle.Secondary` (same as in-progress) |
| Confirm labels | `Cancel Lobby` (Danger), `Keep Lobby` (Secondary) |
| Use-case | Existing `cancelLobbyMatch` with `matchId` from the card |
| Slash command | Unchanged |

## Architecture

```text
public Cancel (lobby:cancel)
  → resolve PENDING match from this message
  → assertCanManageMatch (host / match mod / universal mod)
  → ephemeral: "Cancel lobby `{id}`?"  [Cancel Lobby] [Keep Lobby]
  → Confirm → cancelLobbyMatch({ matchId }) → public card cancelled
  → Keep → ephemeral “was not cancelled”; public card unchanged
```

Custom ids stay in the lobby namespace so they never collide with in-progress `match:cancel`:

| Step | customId |
|------|----------|
| Public button | `lobby:cancel` |
| Confirm | `lobby:cancel:ok:{matchId}` |
| Keep | `lobby:cancel:no:{matchId}` |

Pending cancel never applies quitter penalties. Confirm copy must not mention them. `cancelLobbyMatch` already sets `cancelReason` to `by the host` or `by a moderator`.

Everyone can see the public button. Unauthorized clicks get `Only the match host or a match moderator can do that.` and never see the confirm.

## Components

| Piece | Role |
|-------|------|
| `src/services/lobby/lobby-preview.ts` | `LOBBY_CUSTOM_IDS.cancel = 'lobby:cancel'`. `buildLobbyButtons` always appends a last row with Cancel when the card is not `locked`. |
| `src/discord/interactions/lobby-interactions.ts` | Thin adapter: resolve pending match, auth, ephemeral confirm, then `cancelLobbyMatch`. Uses existing `replyEphemeral` / `updateEphemeral` (delete-previous on new public→private open). |
| `src/services/lobby/lifecycle.ts` | `cancelLobbyMatch` unchanged. Confirm passes `matchId`. |
| `docs/discord/public/04-fix-the-lobby.md` | List Cancel with the other host tools. |

`/lobby cancel` continues to call `cancelLobbyMatch`. Do not fork cancel logic into the button handler.

Public click (message id is the **lobby card**):

1. Resolve PENDING match from `interaction.message.id` (same as Start).
2. Require a guild; load `matchModRoleId`; `assertCanManageMatch`.
3. `replyEphemeral` with Confirm / Keep. Put `matchId` on those buttons.

Confirm / Keep run on the **ephemeral**, so `interaction.message.id` is not the lobby card. Always take `matchId` from the custom id.

Confirm:

1. `cancelLobbyMatch({ matchId, actorDiscordId, memberRoleIds, matchModRoleId })` re-asserts host/mod and PENDING via `resolvePendingMatchForManage`.
2. `syncLobbyDiscordMessage(..., 'cancelled')` replaces the public card and drops buttons.
3. Ephemeral: `Match \`{id}\` cancelled.`

Keep: do **not** resolve PENDING and do **not** call `cancelLobbyMatch`. Update the ephemeral to `Match \`{id}\` was not cancelled.` If the lobby was already cancelled, still use that copy; do not restore the lobby.

## Error handling

| Case | Behavior |
|------|----------|
| Not host / not match mod | Ephemeral: `Only the match host or a match moderator can do that.` No confirm. |
| Not in a guild | Server-only error; no confirm. |
| Message has no PENDING match / already started or cancelled | Existing resolve copy: not found or `This match can no longer be edited.` |
| Confirm after someone else cancelled or started | Re-resolve by `matchId`; same not-editable / not-found errors. Public card already updated. |
| Keep after it was already cancelled | Still “was not cancelled” for this click; do not restore the lobby. |
| Two people confirm at once | `cancelMatch` refuses non-PENDING. Second click gets the not-editable message. |
| Stale 2h auto-cancel | Same as today; button gone once the card is locked. |

Row budget: pending cards already use at most three rows (Start/Refresh, roster, claim). Cancel adds a fourth. Discord’s max is five.

## Testing

Automated:

- `buildLobbyButtons`: last row is a single `lobby:cancel`; present when Start is hidden; present with Refresh; omitted when `locked`; never on the Start/Refresh row.
- New `lobby-interactions` tests (same style as match-correction): host/mod get the confirm ephemeral; outsider gets the manage-match error and `cancelLobbyMatch` is not called; Confirm calls `cancelLobbyMatch` with that `matchId`; Keep does not cancel.

Manual:

1. Host: Cancel → Keep → public card still pending.
2. Host: Cancel → Confirm → cancelled embed, buttons gone.
3. Seated player (not host): Cancel → error, lobby unchanged.
4. Match mod: Confirm → cancelled (`by a moderator`).
5. `/lobby cancel` still works.

## Rejected alternatives

| Option | Why not |
|--------|---------|
| Reuse `match:cancel` in match-interactions | Mixes pending void with in-progress cancel (quitter penalties) |
| Confirm on the public card | Other players see it; Start/Refresh can race with it |
| Immediate cancel (no confirm) | Easy to misclick a public button |
| Anyone who can see the lobby | Roster buttons are open; cancel is destructive and already host/mod on the slash path |
