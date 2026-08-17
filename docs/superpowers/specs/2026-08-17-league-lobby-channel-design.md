# League lobby channel — Design

**Date:** 2026-08-17  
**Status:** Approved  
**Scope:** `general` (per-league Discord channel gate for ranked lobby **creation**)

## Goal

A guild admin can **enable a dedicated lobby channel per league** so ranked lobby cards stay in one place and are not buried in a busy chat. When the gate is on, creating a Discord PENDING match is allowed **only in that channel**. When it is off, today’s behavior is unchanged: the card is the `/register_lobby` reply (or the host-prompt message) in whatever channel the user used.

## Non-goals

- Redirecting the lobby embed to another channel while the command is used elsewhere
- Restricting `/lobby add|remove|swap|start|cancel|sync` (or embed buttons / report) to that channel
- Auto-creating a `LeagueChannelBinding` for the lobby channel
- Moving or deleting existing PENDING/IN_PROGRESS messages in other channels
- Guild-wide (not per-league) lobby channel
- Forum channels
- Changing create-role / mod-role semantics
- New env vars or AWS SSM keys
- Blocking other slash commands or user chat in the lobby channel (admins use Discord channel permissions if they want a quiet channel)

## Locked decisions

| Topic | Choice |
|-------|--------|
| Tenancy | Per **league** (`League` row), not `GuildConfig` |
| Default | Off (`lobbyChannelEnabled = false`, `lobbyChannelId` null) — no behavior change |
| Create paths gated | `/register_lobby` and wc3stats **Open lobby** only |
| Not gated | `/lobby …`, claim/leave, start/report/cancel buttons, match correction |
| Posting | Still the interaction reply / prompt-message edit in **that** channel (no `channel.send` redirect) |
| `/config` auth | Existing: **Manage Guild** or hard-coded bot owner id |
| Channel types | Guild text or announcement (same as host prompt) |
| Host prompt vs lobby channel | If **both** are ready, they **must** share the same `channelId`. `/config` rejects a mismatch |
| Disable | `enabled: false` keeps `lobbyChannelId` so re-enable does not require picking the channel again |
| Clear | Disable **and** null `lobbyChannelId` |
| Ready | `lobbyChannelEnabled === true` **and** non-empty `lobbyChannelId` |
| League resolve | Unchanged; admins may `/league bind` the lobby channel separately if they want implicit league from channel |
| Same channel, several leagues | Allowed; `league` option still disambiguates |
| `/config` who | Not “guild owner only” — same as other `/config` keys |

## Data model

```prisma
model League {
  // existing fields…
  lobbyChannelEnabled Boolean @default(false)
  lobbyChannelId      String?
}
```

| State | Meaning |
|-------|---------|
| `enabled = false`, id null | Off, never configured |
| `enabled = false`, id set | Off, channel remembered |
| `enabled = true`, id set | **Ready** — create only in that channel |
| `enabled = true`, id null | Invalid; setters must not persist this. Runtime treats as not ready **and** `/config view` must not show `on` |

No env fallback. Missing league row → not ready.

## Commands

Single subcommand `/config set lobby_channel` with optional `enabled` (boolean) and optional `channel`. At least one option is required. League option via `withSubcommandLeagueOption` like other league keys.

| Input | Effect |
|-------|--------|
| `enabled:true` + `channel` | Set id, set enabled true. Reject if host-prompt **ready** and its channel differs |
| `enabled:true` only | Re-enable using stored id. Reject if no stored id (“choose a channel when enabling…”) |
| `enabled:false` (channel ignored if passed) | Set enabled false; **keep** `lobbyChannelId` |
| `channel` only | Update id **only if already enabled** (same host-prompt mismatch rule). If currently disabled, reject (“pass enabled:true to turn the lobby channel on”) |
| `/config clear lobby_channel` | `enabled false`, `lobbyChannelId` null |
| `/config view` | See copy below |

Existing `/config set wc3stats_host_prompt` / `clear`: when enabling or changing the prompt channel, if lobby channel is **ready**, the prompt `channelId` must equal `lobbyChannelId`. Disable/clear host prompt is unchanged (still clears prompt channel).

### `/config view` line

| State | Line |
|-------|------|
| Off, no id | `**Lobby channel:** \`off\`` |
| Off, id saved | `**Lobby channel:** \`off\` · saved <#id>` |
| Ready | `**Lobby channel:** \`on\` · <#id>` |

## Runtime

Shared helper (new module `src/services/league/league-lobby-channel.ts`):

```typescript
assertLeagueLobbyCreateChannel(leagueId: string, channelId: string): Promise<void>
```

- Not ready → return.
- Ready and `channelId === lobbyChannelId` → return.
- Else throw `MatchServiceError` with:

  `Lobby creation for this league is limited to <#lobbyChannelId>.`

Call sites (after league id is known, **before** `createPendingMatch`):

1. `src/commands/lobby/register-lobby.ts`
2. `src/discord/interactions/wc3stats-host-prompt-interactions.ts` (`Open lobby`)

Do **not** put this in `createPendingMatch` (match service stays channel-policy-free). Do **not** call it from `/lobby` use-cases.

`/register_lobby` continues to `deferReply` + `editReply` with the embed when allowed. Open lobby continues to replace the prompt message when allowed.

### Host-prompt poller

No happy-path change: it already posts to `wc3statsHostPromptChannelId`, which equals the lobby channel when both are ready.

If both are ready and the stored prompt channel **differs** (invalid row): **skip posting** for that league that tick and `log.error`. Do not post to a guessed channel.

## Error copy (English)

| Case | Message |
|------|---------|
| Create in the wrong channel | `Lobby creation for this league is limited to <#id>.` |
| Enable true, no channel stored or passed | `Choose a channel when enabling the lobby channel.` |
| Channel-only while disabled | `Pass enabled:true to turn the lobby channel on.` |
| Channel type not text/announcement | `Choose a server text channel for lobbies.` |
| Mismatch vs host prompt | `The wc3stats host prompt channel must match the lobby channel while the lobby channel is enabled.` |
| Neither enabled nor channel on set | Discord required-option / `Provide enabled and/or channel.` |

Deleted Discord channel: no special handler; create/reply fails at the API; admin sets a new channel.

Bot missing send/edit permission: existing Discord/error path; no retry.

## Architecture

```text
/config set|clear lobby_channel
  → assertCanConfigureBot
  → setLeagueLobbyChannel / clearLeagueLobbyChannel
       ↳ reject host-prompt mismatch when lobby becomes/stays ready

/config set wc3stats_host_prompt (enable)
  → existing setter
       ↳ reject if lobby channel ready and channelIds differ

/register_lobby | Open lobby
  → resolve league
  → assertLeagueLobbyCreateChannel(leagueId, interaction.channelId)
  → createPendingMatch + attach Discord message (unchanged)
```

| File | Change |
|------|--------|
| `prisma/schema.prisma` + migration | Two `League` columns |
| `src/services/league/league-lobby-channel.ts` | Ready helper, assert, set/clear, mismatch helper |
| `src/services/league/league-lobby-channel.test.ts` | Unit tests |
| `src/services/league/league-wc3stats.ts` | Extend `ResolvedLeagueConfig`; host-prompt setter calls mismatch helper |
| `src/commands/config/config.ts` | set/clear/view |
| `src/commands/lobby/register-lobby.ts` | Assert before create |
| `src/discord/interactions/wc3stats-host-prompt-interactions.ts` | Assert before create |
| `src/services/wc3stats/wc3stats-host-prompt-poller.ts` | Skip + error log on ready+mismatch |
| `src/services/league/index.ts` | Re-export helpers if other league helpers are exported |

`src/commands/config/config.ts` is already large; this slice only adds one set/clear pair and a view line. Do not split the command file in this feature.

## Edge cases

| Case | Behavior |
|------|----------|
| DM / no guild | Existing reject |
| Two leagues, same lobby channel | Allowed |
| Host prompt off, lobby channel on | Create gated; no prompt posts |
| Host prompt on, lobby channel off | Prompt channel independent; Open lobby not gated by lobby channel |
| PENDING match created before enable, other channel | Embed stays there; `/lobby` and buttons still work |
| Re-enable after disable | Same stored channel; no new Discord message until next create |
| `/register_lobby` in lobby channel without league bind | Existing `resolveLeagueIdFromInteraction` (option / single league / bind) |

## Testing

1. Not ready → assert allows any `channelId`
2. Ready + matching channel → allow
3. Ready + other channel → `MatchServiceError` with the locked copy
4. Enable without channel and none stored → reject
5. Disable keeps `lobbyChannelId`
6. Clear sets enabled false and id null
7. Channel-only while disabled → reject
8. Set lobby channel ready while host prompt ready with different id → reject
9. Set host prompt enable with different id while lobby ready → reject
10. Same id on both → allow
11. Poller skip when both ready and ids differ (unit with mocked league row)

No Discord integration test required beyond existing command patterns.

## Out of scope / later

- Redirect mode (command anywhere, card always in `#lobbies`)
- Auto-bind lobby channel to the league
- Relocate live matches into the lobby channel when the gate is turned on
