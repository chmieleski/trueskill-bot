# wc3stats host lobby prompt — Design

**Date:** 2026-08-15  
**Status:** Approved (implemented on branch; user opt-out in progress)  
**Scope:** `general` (league config + Discord UX + poller + player preference)

## Goal

When a league enables the feature, periodically poll `https://api.wc3stats.com/gamelist`. If a live lobby matches that league’s existing wc3stats map filter **and** the Warcraft host nick matches a linked Player (`/link`) who has not opted out of pings, post a public message in a configured league channel that pings that host and asks whether to open a Discord match lobby.

Buttons: **Open lobby** / **Dismiss**. Ephemeral replies only for button interactions (never push ephemeral without an interaction).

## Non-goals

- WebSocket live gamelist (REST poll only)
- Auto-creating PENDING matches without host consent
- Guild-wide announce cards for every lobby (host-linked only)
- Per-league player preferences (Player is global; preference is global)
- Changing translation keys

## Locked decisions

| Topic             | Choice                                                                                                                              |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Map filter        | Reuse each league’s wc3stats map pattern/sha1 (same as import)                                                                      |
| Host match        | `nickFromWc3statsPlayer` / `normalizeNick` vs linked `Player.username`                                                              |
| Channel           | Per-league `wc3statsHostPromptChannelId`                                                                                            |
| League gate       | `wc3statsHostPromptEnabled` default **false**                                                                                       |
| Runtime readiness | Import ready (enabled + map pattern) **and** prompt enabled **and** channel set                                                     |
| Poll interval     | ~45s; one gamelist fetch per tick                                                                                                   |
| Dedupe            | In-memory `leagueId:wc3statsId`; also skip if active match exists for that id                                                       |
| Open path         | Shared create-role + `importWc3statsLobby` + `createPendingMatch`; replace prompt message with lobby embed + `attachDiscordMessage` |
| Button auth       | Only mentioned host; others get ephemeral denial                                                                                    |
| User opt-out      | On **Player** (global): `wc3statsHostPromptPingsEnabled` default **true**                                                           |
| User UX           | `/settings` — view + set host prompt pings                                                                                          |

## Data model

### League

```prisma
wc3statsHostPromptEnabled   Boolean  @default(false)
wc3statsHostPromptChannelId String?
```

### Player

```prisma
wc3statsHostPromptPingsEnabled Boolean @default(true)
```

Default **true** preserves current behavior for all existing linked players. Setting **false** excludes the player from poller pings (still can `/register_lobby` manually).

## Commands

### League (admin) — already specified

- `/config set wc3stats_host_prompt` — `enabled` + `channel` (channel required when enabling)
- `/config clear wc3stats_host_prompt` — disable and clear channel
- `/config view` — show on/off and channel

### Player settings (new)

#### `/settings view`

Ephemeral. Shows linked nick (if any) and host-prompt ping preference (`on`/`off`). If not linked, still show preference once a Player row exists; if no Player row, say they must `/link` first for host prompts to apply (preference stored when they link or when they set it after link).

**Locked:** Preference requires an existing Player with `discordId` (must be linked). Setting while unlinked replies: link first.

#### `/settings set host_prompt_pings`

| Option    | Type    | Notes                                                        |
| --------- | ------- | ------------------------------------------------------------ |
| `enabled` | boolean | Required. `false` = do not ping me for wc3stats host prompts |

Auth: any guild member acting on **themselves** (no mod override needed for this preference).

**Status:** Implemented.

## Poller behavior (updated)

1. Fetch gamelist once.
2. Load linked players with `discordId` set **and** `wc3statsHostPromptPingsEnabled === true`.
3. For each prompt-ready league, filter map matches ∩ linked hosts.
4. Dedupe / active-match skip / cap per tick.
5. Post with `allowedMentions: { users: [hostDiscordId] }`.

## Discord UX

Prompt copy (approx):

> @host — wc3stats found your lobby **name** (`id`). Open a Discord match lobby from that Warcraft lobby?

Open → PENDING match like `/register_lobby` with that `wc3stats_id`.  
Dismiss → short dismissed state, clear components.

## Testing

- Custom-id build/parse
- Map filter + host nick matching
- League readiness helper
- Linked-player load excludes `wc3statsHostPromptPingsEnabled: false`
- Settings command service helpers (set/get preference)

## Architecture notes

- Domain in `services/wc3stats` + `services/lobby/create-from-wc3stats`; thin Discord adapters
- Scheduler mirrors match-cleanup / leaderboard (ready start, shutdown stop)
- English-only user-facing strings
