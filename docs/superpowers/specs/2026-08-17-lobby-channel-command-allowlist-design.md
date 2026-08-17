# Lobby channel command allowlist — Design

**Date:** 2026-08-17  
**Status:** Approved  
**Scope:** `general` (per-guild channel gate: which slash commands may run inside a ready league `lobby_channel`)

**Related:** Extends [league lobby channel](./2026-08-17-league-lobby-channel-design.md). That spec’s non-goal “blocking other slash commands in the lobby channel” is **superseded** by this design for slash commands only.

## Goal

When a Discord channel is a **ready** lobby channel for **any** league in the guild, keep that channel focused on live lobby/match ops. Unrelated slash commands are refused with an ephemeral error. Lobby **creation** remains gated *into* that channel by the existing create assert; this feature only restricts what else can run *inside* it.

## Non-goals

- Restricting `/lobby`, `/register_lobby`, or allowed `/match` subcommands **outside** the lobby channel
- Blocking message components / modals (claim, leave, start, report, host prompt, correction, etc.)
- Discord channel permission overrides or Application Command Permissions API
- Schema, env, or AWS SSM changes
- Changing `/config set|clear lobby_channel` semantics
- Auto-binding the lobby channel to a league
- Forum channels

## Locked decisions

| Topic | Choice |
|-------|--------|
| Trigger | Channel is a ready lobby channel if **any** `League` in the guild has `lobbyChannelEnabled === true` and trimmed `lobbyChannelId === interaction.channelId` |
| Gate off | If no such league → no allowlist (unchanged behavior) |
| Enforcement | Central gate in `interaction-create.ts` before slash `execute` **and** before command autocomplete |
| Components | **Not** gated |
| Create gate | Unchanged (`assertLeagueLobbyCreateChannel`) |
| Allowlist roots | `/register_lobby`, `/lobby` (all subcommands) |
| `/match` allowlist | Subcommands **only**: `complete`, `cancel`, `quitters` |
| `/match` blocked | `history`, `show`, `flip`, `void` (and any future subcommand not on the allowlist) |
| All other slash commands | Blocked in that channel (`/rank`, `/link`, `/leaderboard`, `/config`, `/league`, `/settings`, …) |
| New commands | Default **blocked** in lobby channel unless added to the allowlist |
| Error copy | `Only lobby and match commands can be used in <#lobbyChannelId>.` |
| Tenancy | Lookup by `guildId` + `channelId` across leagues; no change to match/rating isolation |

## Allowlist

```text
register_lobby
lobby          → any subcommand
match          → complete | cancel | quitters
```

Deny when the channel is a ready lobby channel and the interaction is not on this list.

## Runtime

```text
ChatInputCommand | Autocomplete
  → if guildId + channelId present
       and isGuildLobbyChannel(guildId, channelId)
       and not isLobbyChannelAllowedCommand(commandName, subcommand?)
         → ephemeral deny (slash) / empty or silent fail (autocomplete)
  → else existing dispatch
```

| Helper | Role |
|--------|------|
| `isGuildLobbyChannel(guildId, channelId)` | DB: any ready league in guild with that `lobbyChannelId` |
| `isLobbyChannelAllowedCommand(commandName, subcommand?)` | Pure allowlist |
| Optional thin wrapper | Resolve deny message for callers |

Prefer colocating these next to existing lobby-channel helpers (`src/services/league/league-lobby-channel.ts` or a small sibling module re-exported from `src/services/league/index.ts`).

Do **not** sprinkle checks into every command file. Do **not** put this inside match/lobby use-cases.

### Autocomplete

Same channel + allowlist rules. If blocked: return no choices (do not run the command’s autocomplete handler). No user-visible error is required for autocomplete.

### Subcommand resolution

For `/match`, read `interaction.options.getSubcommand(false)` (or equivalent). Missing/unknown subcommand while in a lobby channel → deny (fail closed).

## Architecture

```text
interaction-create (slash / autocomplete)
  → isGuildLobbyChannel?
       → allowlist?
            → command.execute / autocomplete
            → ephemeral: Only lobby and match commands…
  → (components unchanged — no gate)
```

| File | Change |
|------|--------|
| `src/services/league/league-lobby-channel.ts` (or sibling) | `isGuildLobbyChannel`, allowlist helper, deny message |
| `src/services/league/league-lobby-channel.test.ts` (or sibling test) | Unit tests for ready lookup + allowlist |
| `src/services/league/index.ts` | Re-export if needed |
| `src/events/interaction-create.ts` | Gate before autocomplete and `execute` |

No Prisma migration. No `/config` copy change required (optional later: staff docs note that the lobby channel also limits slash commands).

## Edge cases

| Case | Behavior |
|------|----------|
| Lobby channel not ready / disabled | No allowlist |
| Same channel ready for two leagues | Still gated once (any-league trigger) |
| DM / no `channelId` | Skip gate (existing command handling) |
| `/match history` in lobby channel | Deny |
| `/match complete` in lobby channel | Allow (subject to existing auth) |
| `/config view` in lobby channel | Deny |
| Button on lobby embed in lobby channel | Allow (no gate) |
| Leaderboard pagination button in lobby channel | Allow (no gate; rare if message was posted there) |
| Autocomplete for `/rank` in lobby channel | No choices; do not execute underlying autocomplete |
| Command used outside lobby channel | Unchanged (create still limited *to* lobby when ready) |

## Error copy (English)

| Case | Message |
|------|---------|
| Slash command blocked in lobby channel | `Only lobby and match commands can be used in <#id>.` |

Use the interaction’s `channelId` (the ready lobby channel) in the mention.

## Testing

1. `isLobbyChannelAllowedCommand`: `register_lobby` / `lobby` / `match`+`complete|cancel|quitters` → true; `match`+`history` / `rank` / `config` → false; `match` with missing subcommand → false
2. `isGuildLobbyChannel`: ready matching id → true; disabled / wrong channel / other guild → false
3. Interaction gate (unit or thin test of helper composition): blocked command yields the locked English copy
4. Gate off → allowlist not applied

No Discord integration test required beyond existing patterns.

## Out of scope / later

- Staff doc line on `/config` lobby channel behavior
- Narrowing which **components** may run in the lobby channel
- Per-league allowlists or admin-configurable command lists
