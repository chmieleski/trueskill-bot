# wc3stats Lobby Watcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Post live Ultimate Dragon Ball Reborn lobby cards in a Discord channel and let a create-role member Claim them into a PENDING ranked match using the Phase 2 importer.

**Architecture:** Optional WebSocket subscriber (`GameListCreate/Update/Delete`) plus REST detail fetch for map-matched games. Cards are announcements, not ranked matches. Claim calls the same resolve/extract/`createPendingMatch` path as `/register_lobby`. No auto-create.

**Tech Stack:** Node.js + TypeScript ESM, discord.js v14, `ws`, Vitest

**Spec:** [docs/superpowers/specs/2026-08-14-screenshotless-lobby-design.md](../specs/2026-08-14-screenshotless-lobby-design.md) — Phase 3 (route F)

**Depends on:** Phase 2 ([wc3stats-lobby-import](./2026-08-14-wc3stats-lobby-import.md)) must already import by `wc3stats_id`.

**Do not implement this plan until Phase 2 is proven against a real UDBR lobby.**

## Global Constraints

- English UI
- Create-role on Claim (same as `/register_lobby`)
- Never create a Match from WS metadata alone (no players there)
- Closed lobbies edit/delete the **card**, not an existing ranked match
- t3.micro: one socket, exponential reconnect, detail-fetch only for UDBR-matching list events
- Commits only when the user asks

## File structure

| File                               | Responsibility                                 |
| ---------------------------------- | ---------------------------------------------- |
| `src/services/wc3stats-watcher.ts` | WS subscribe, reconnect, event dispatch        |
| `src/services/lobby-announce.ts`   | Create/edit/delete Discord cards; Claim wiring |
| `src/services/guild-config.ts`     | Optional `lobbyAnnounceChannelId`              |
| `src/events/ready.ts`              | Start/stop watcher with the Discord client     |
| `src/index.ts`                     | Shutdown stops watcher                         |

## What this plan does not build

- Auto-create PENDING when a linked host appears (route E — rejected)
- Using WS `slotsTaken` as a roster
- Cross-guild shared cache beyond one process

---

### Task 1: Guild announce channel

**Files:**

- Modify: `prisma/schema.prisma` (`GuildConfig.lobbyAnnounceChannelId String?`)
- Modify: `src/commands/config/config.ts` — `/config set lobby_channel`
- Modify: `src/services/guild-config.ts`

- [ ] **Step 1: Migration** `lobby_announce_channel`

- [ ] **Step 2: Config setter** (Administrator / existing config permission)

Copy: `Live UDBR lobby cards will be posted in that channel.`

- [ ] **Step 3: Unset** clears the channel id; watcher no-ops for that guild

---

### Task 2: WebSocket client (no Discord yet)

**Files:**

- Add dependency: `ws` (+ `@types/ws`)
- Create: `src/services/wc3stats-watcher.ts`
- Create: `src/services/wc3stats-watcher.test.ts` (parse message types with fixtures; no live socket)

**Interfaces:**

- Produces:
  - `startWc3statsWatcher(handlers: { onCreate; onUpdate; onDelete }): void`
  - `stopWc3statsWatcher(): void`
  - Payload type matching scantron: `{ messageType, message: { id, name, host, map, slotsTaken, slotsTotal, server, created, started? } }`

- [ ] **Step 1: Fixture tests for JSON parse / ignore unknown types**

- [ ] **Step 2: Implement connect to `ws://ws.wc3stats.com`**

On open send:

```json
{ "messageType": "Subscribe", "message": ["GameList"] }
```

On close: wait `10000 + random*5000` ms and reconnect (same as [scantron](https://github.com/wc3stats/scantron-9000/blob/master/plugins/monitor-lobbies.js)).

On error: log, do not crash the bot.

- [ ] **Step 3: Filter with `isUdbrMap` before calling handlers**

---

### Task 3: Card embed (metadata only)

**Files:**

- Create: `src/services/lobby-announce.ts`
- Create: `src/services/lobby-announce.test.ts`

**Interfaces:**

- Card fields: game name, host, map, `slotsTaken / slotsTotal`, server, wc3stats id
- Buttons: **Claim** (`lobby:claim:{wc3statsId}`) — create-role later
- Color: green if `slotsTaken/slotsTotal < 0.6`, yellow otherwise (scantron heuristic)

- [ ] **Step 1: Unit-test embed field names (no Discord network)**

- [ ] **Step 2: In-memory `Map<wc3statsId, { messageId, channelId, guildId }>`**

---

### Task 4: Post / edit / clean

**Files:**

- Modify: `src/services/lobby-announce.ts`
- Modify: `src/events/ready.ts`
- Modify: `src/index.ts` shutdown

For each guild with `lobbyAnnounceChannelId`:

- Create → send card
- Update → edit card
- Delete → delete message if `clean` (default true) else edit to “closed/started”

If Claim already created a ranked match, **do not** cancel that match.

Start watcher from `ready` only when `WC3STATS_ENABLED` is true.

---

### Task 5: Claim button

**Files:**

- Modify: `src/handlers/lobby-interactions.ts`
- Reuse Phase 2 import (`fetchGameDetail` + `extractWc3statsRoster` + `createPendingMatch`)

- [ ] **Step 1: Claim flow**

```text
assert guild + create-role
fetch detail
reject if not UDBR
duplicate active wc3statsGameId → point at existing match (ephemeral)
else createPendingMatch in the Claim interaction channel (or a configured match channel — default: current channel)
reply with the same lobby embed as /register_lobby
attachDiscordMessage
```

If roster unusable: still create empty PENDING bound to the id (Phase 2 rule) and tell the host to Refresh.

- [ ] **Step 2: First-claim-wins** via the duplicate game-id check (no extra lock table)

- [ ] **Step 3: Disable Claim on the announce card after success** (edit buttons off) so others do not click a dead control; ranked embed is the source of truth

---

### Task 6: Shutdown and tests

- [ ] Stop watcher on SIGINT/SIGTERM before `client.destroy()`
- [ ] Vitest: map filter still rejects Tribute cards
- [ ] Vitest: Claim without create-role throws the existing create-role `MatchServiceError`

---

## Rollback

Unset `lobby_channel` and/or `WC3STATS_ENABLED=false`. Watcher must not start. Phase 2 `/register_lobby` remains.

## Done when

- UDBR lobbies appear as cards and vanish when closed.
- Non-UDBR games never post.
- Claim creates one PENDING match through the Phase 2 importer.
- Linked or unlinked in-game host does not bypass create-role.
