# Screenshotless Lobby Creation — Design

**Date:** 2026-08-14  
**Status:** Draft for review (not approved)  
**Scope:** Make ranked lobby/match creation easier by dropping the screenshot as the happy path. wc3stats is an importer, not the match authority.

## Goal

A host with the create role can open a Discord PENDING match **without** taking a Warcraft III lobby screenshot. When wc3stats can see Ultimate Dragon Ball Reborn players, prefill `{slot, nick}`. When it cannot, the host still gets a usable empty lobby and fills it with the existing add/edit/move/remove buttons.

## Non-goals (this feature)

- Auto-creating ranked matches when a WC3 lobby appears (no human click)
- Replacing OpenSkill / report / quitters
- Changing `Player.username` to full BattleTag (`Name#1234`)
- Using wc3stats `team` / `teamName` / forces as bot Team A/B
- Deprecating Gemini OCR in v1 (it becomes fallback, not the default)
- Persistent lobby-announce channel (Phase 3)
- A Windows helper that reads WC3 memory / local WebSocket (not a cloud bot)
- Changing the UDBR map to send HTTP/W3MMD (map authors, not this repo)
- Ghost++ / ENT / Eurobattle hosting (wrong network for Reforged Battle.net)

## Problem

Today `/register_lobby` **requires** a screenshot. Gemini OCR extracts nicks; empty roster is already allowed if OCR fails. The screenshot is the friction. wc3stats can list live games and *sometimes* return per-slot players — but the list/WebSocket **never** includes a roster, and the detail endpoint often returns `slots: []` even when `slotsTaken` is high.

Verified against [wc3stats gamelist](https://wc3stats.com/docs/api#/gamelist) and [scantron monitor-lobbies.js](https://github.com/wc3stats/scantron-9000/blob/master/plugins/monitor-lobbies.js):

| Source | Map / host / slotsTaken | Per-player roster |
|--------|-------------------------|-------------------|
| `GET /gamelist` | Yes | No |
| `ws://ws.wc3stats.com` `GameList*` | Yes | No |
| `GET /gamelist/{id}` | Yes | **Sometimes** (`rosterObservedAt` may be null, `slots` empty) |

Map to detect: **Ultimate Dragon Ball Reborn** (not DBZ Tribute). Exact `.w3x` filename / sha1 still unknown until a live lobby is observed.

## Expanded research (other eyes)

The first design pass followed the wc3stats links you shared. That was too narrow. A second pass looked at **other remote APIs**, **Discord-native seating**, **replays / map hooks**, and **identity the bot already has**. This is additive, not a fight with the first debate.

### Remote sources (live lobby)

There is **no official Blizzard custom-lobby API**. Anything remote is a community tracker watching the public game list.

| Source | What you get | Per-slot nicks | Network | For this bot |
|--------|----------------|----------------|---------|--------------|
| [wc3stats `/gamelist/{id}`](https://wc3stats.com/docs/api#/gamelist) | Map, host, sometimes `slots[]` | **Sometimes** | Battle.net | Only importer that *might* fill nicks |
| [WC3Tracker `/api/lobbies`](https://wc3tracker.com/api/lobbies) | `mapFile`, `host`, `slotsTaken/Total`, `players` as `"4/6"` | **No** | Battle.net | Better **uptime** for map+host detect; built because wc3stats is often down ([Hive note](https://www.hiveworkshop.com/threads/dual-api-system-added.372006/)) |
| [ENT `/allgames`](https://host.entgaming.net/allgames) | Name, map, slot counts | **No** | WC3Connect, not Reforged Bnet | Wrong network |
| W3Champions | Ladder queue / MMR | No custom UDBR roster | Their stack | Irrelevant |
| GHost++ / Eurobattle / iCCup | Full roster **if that bot hosts** | Yes on *their* games | Legacy / PvPGN | Dead or wrong network on Reforged |
| Local WC3 WebSocket / [wc3MultiTool](https://github.com/kgallimore/wc3MultiTool) | True lobby the client can see | Yes, on that PC | Local | Needs software on the host; not the AWS Discord bot |

**Ceiling:** no public remote API reliably returns 12 Battle.net nicks + slots. Trackers see the **game list** (name, map, host, counts). Slot names need a client that **joined** the lobby (wc3stats detail is opportunistic), a local helper, or humans in Discord.

WC3Tracker is the best **metadata** fallback if Phase 2 map-detect should not depend on wc3stats alone. It does not replace a roster importer.

### Discord-native seating (no WC3 read)

The bot already knows Discord users and `/link`. Filling a lobby does not require parsing Warcraft at all.

| Pattern | Idea | Keep? |
|---------|------|--------|
| Self-claim buttons | 12 slot buttons on the PENDING embed; linked player clicks their hero/slot | **Yes — best complement** |
| Host user-select | Host picks Discord members; bot maps via `/link` | Yes, small `/lobby add user:` |
| `/lobby claim slot:N` | Each player slashes in | Overlaps buttons |
| Join code | Code in WC3 lobby name → `/lobby join` | Optional if many concurrent matches |
| Color reactions | React with color emojis | **No** — not 12 distinct, no team |
| Voice occupancy | Prefill from team VCs | Hint only; extra intent; skip for now |
| Queue then seat | Players opt in; host assigns heroes | Later, pickup nights |
| Recall last 6v6 | Replay last ranked group | Later QoL |

Hero **is** slot in this map. Copy should say “seat as Goku (slot 1)”, not only a number.

Unlinked / Discord-less guests still need host nick entry, screenshot, or a lucky wc3stats pull. Self-claim **does not block** those paths.

### After the game / inside the map

| Path | Create a lobby? | Verify roster? | Notes |
|------|-----------------|----------------|-------|
| Attach `LastReplay.w3g` | No (file exists after play) | **Yes**, high quality | Path is awkward vs a screenshot; good **dispute** tool later |
| W3MMD in the map | No | Winner/stats if authors add it | Out of scope — we do not ship the map |
| Map HTTP webhook | No | Would be live | Reforged has **no** native HTTP; Blizzard rejected it |
| networkio / Preload proxy | Live if a helper runs | Yes | Every host must install an exe |

Replay verification is a **future integrity** phase, not a create-path. Screenshot-before is still easier than hunting `Documents/Warcraft III/.../LastReplay.w3g` after every game.

### Companion app (honest, deferred)

A small host-side app (local WebSocket, no injection required if the official webui socket is enough) could POST a roster to the bot. That is the only way to get **live 12-slot accuracy** without screenshots or flaky public APIs. It is a **new product** (Windows install, trust, Defender). Do not mix it into this Discord bot’s first screenshotless work.

## Debate (four independent reviews)

Approaches scored:

| ID | Approach |
|----|----------|
| A | Pull roster once on `/register_lobby` |
| B | Always-on WebSocket watcher + Register button |
| C | Empty lobby first (no wc3stats); fill by buttons/slash |
| D | Hybrid: pull + Refresh while PENDING + OCR/manual fallback |
| E | Auto-create PENDING when a linked host appears |
| F | Watcher posts lobby cards; host claims |

### Player ease (product)

1. **D** — same magic as A when roster exists; recovery when it does not  
2. **F** — one click if a card is already posted  
3. **A** — no retry if the first pull is empty  
4. **B** — extra channel + greyed Register until roster exists  
5. **C** — always works, most typing  
6. **E** — false positives (scrims, tests) force dismiss/claim anyway  

### Engineering fit (architecture)

1. **D** — reuses `createPendingMatch` / `replaceMatchRoster` / embeds  
2. **A** — simpler, but empty-roster is a known case that needs retry  
3. **C** — almost already shipped; does not import players  
4. **F** then **B** — extra process (WS, cache, channel config)  
5. **E** — fights create-role + identity model  

### Ranked safety (reliability)

1. **C** — human-entered, no API hallucination  
2. **D** — degrades; never overwrite a good roster with `slots: []`  
3. **A** — user-initiated, still one-shot  
4. **F** / **B** — extra staleness  
5. **E** — kill; no human-in-the-loop  

### Incremental delivery

1. **C first** — screenshot optional is a small change; empty lobby already works  
2. **Then D** — REST import + Refresh once map filter is known  
3. **Then F** — announce/claim only if discovery is still painful  
4. Do **not** build E  

### Consensus

Ship **C then D**. Keep OCR. Never auto-create. Treat wc3stats as optional convenience. Store `wc3statsGameId` on the match so Refresh and duplicate-prevention work.

## Recommended route

```text
Phase 1 (C)   /register_lobby print optional
              → empty PENDING if no screenshot
              → existing Add / Edit / Move / Remove / Start

Phase 1b      Discord-native fill (does not wait on wc3stats)
              → /lobby add user:@member (resolve /link) — always host-only
              → player Claim slot / Leave — **guild can disable**

Phase 2 (D)   optional wc3stats_id or unique host+map lookup
              → metadata fallback: WC3Tracker list if wc3stats list is down
              → import roster when wc3stats slots[] is usable
              → Refresh while PENDING
              → screenshot still accepted

Phase 3 (F)   optional: live UDBR cards + Claim

Later         replay attach to verify/correct roster (not create)
```

**Do not build:** auto-create (E), reaction-color seating, Ghost++/ENT as Bnet roster, a memory-reading helper in this repo.

### Why this order

- Phase 1 removes the screenshot **tonight** with no third-party dependency.  
- Phase 1b is often **more** work-reducing than wc3stats if regulars are `/link`ed: the host stops typing nicks. It does not depend on a flaky public API.  
- Phase 2 is opportunistic map detect + extract. WC3Tracker can back the **list**; only wc3stats (sometimes) has **names**. Empty `slots[]` means “try again,” not “lobby is empty.”  
- Phase 3 is discovery, not ranked safety.  
- Replay verify is later integrity, not how you open a match.

## Phase 1b — discussion (kept on the plan)

Phase 1b is **not** another WC3 importer. It uses `/link` so Discord identity fills `{slot, nick}`. Two surfaces, different trust:

| Surface | Who | Trust | Guild toggle |
|---------|-----|-------|----------------|
| `/lobby add user:@member slot:N` | Host (or whoever already may edit the PENDING roster) | Same as typing a nick | **Stays on.** Host is already trusted. |
| **Claim slot** / **Leave** on the embed | Any linked member | Weaker: they assert they are in that WC3 slot/hero | **Can be disabled per guild.** |

### Why keep it

- Regulars who `/link` stop making the host type 12 nicks.
- Complements screenshot/wc3stats: unclaimed slots stay fillable by host/OCR/import.
- Hero = slot: the select should read `Slot 1 · Goku`, not only `1`.

### Why a guild disable (player claim only)

Self-claim is the risky half: wrong hero, griefing an open PENDING message, claiming without being in the WC3 lobby. A test-wave server (or a strict ranked night) may want **host-only seating**. Host `@mention` add does not have that problem.

`/config` today has no boolean toggles (roles + leaderboard only). This is the first explicit on/off flag. Same auth as other `/config`: Manage Guild or bot owner.

### Locked toggle behavior

| Topic | Choice |
|-------|--------|
| Command | `/config set player_claim` with required boolean `enabled` |
| View | `/config view` line **Player claim:** `on` or `off` |
| Prisma | `GuildConfig.lobbyPlayerClaimEnabled Boolean @default(true)` |
| Missing row / never set | **On** (default true) |
| What turns off | Claim slot, Leave-self, and hiding those controls on the embed |
| What stays | Host ✏️🔀🗑️➕, `/lobby add nick`, `/lobby add user:`, screenshot, later wc3stats |
| Stale button | Ephemeral: `Player slot claim is disabled on this server.` |
| Check | `resolveGuildConfig(interaction.guildId)` at claim/leave time (no `Match.guildId` required) |
| Buttons | Omit Claim/Leave when the flag is off so new embeds stay clean |

Default **on** so screenshotless fill works without extra config. Operators who do not want it run `/config set player_claim enabled:False` once.

### Player journeys (1b)

**Host mention (always):** `/lobby add user:@Alice slot:1` → nick from `/link` → same `addLobbyPlayer` as today.

**Player claim (if enabled):** Claim slot → select empty `Slot N · Hero` → PENDING updated. Occupied slot rejected. Already in another slot → leave first. Unlinked → ask `/link`.

**Disabled:** Claim/Leave hidden; host still adds by nick or user.

## Locked decisions (proposed defaults)

| Topic | Choice |
|-------|--------|
| Match authority | Discord PENDING match. wc3stats is an importer. |
| Happy path | No screenshot required. |
| OCR | Keep. Optional `print` attachment. Never remove in Phase 1–2. |
| Create-role | Unchanged. Every create path (`/register_lobby`, Claim, Refresh-create) asserts it. |
| Phase 1b player claim | On by default. Guilds can turn it off with `/config set player_claim`. Host `/lobby add user:` is **not** gated (host-only, same trust as typing a nick). |
| Nick identity | `player.name` (or battleTag with `#NNNN` stripped) → existing `normalizeNick`. Do **not** store `Name#1234` as `Player.username`. |
| Slot mapping | Per-guild map: wc3stats `slots[i]` index → hero/slot 1–12 (`GuildWc3statsSlotMap`). Unmapped indices skipped (Referee). Empty guild map → legacy `i + 1` for 0–11. Configure via `/config set wc3stats_slot` / `wc3stats_map` / `wc3stats_map_preset:udbr`. |
| Empty API roster | If `slotsTaken > 0` and `slots` empty/unusable: **do not** replace an existing non-empty Discord roster. Create/keep PENDING; tell the host to Refresh, screenshot, or add manually. |
| Ambiguous lobbies | Fail closed. Explicit `wc3stats_id` or exactly one live UDBR candidate after filters. Else ephemeral chooser / error listing candidates. |
| Duplicate imports | At most one PENDING/IN_PROGRESS match per `wc3statsGameId`. |
| Refresh | Host/mod, PENDING only, debounce (~15s). Overwrites roster from a **usable** snapshot. Copy must say it replaces manual edits. |
| Start | Does **not** silently re-pull. Host reviews the Discord roster and clicks Start. (Late WC3 swaps are the same honesty problem as OCR today.) |
| Auto-cancel | Closed wc3stats lobby does **not** auto-cancel the Discord match. |
| Map filter | Env regex + optional sha1 allowlist. Default regex targets Ultimate Dragon Ball Reborn. Unknown-but-matching names allowed with a warning in the embed. |
| Feature flag | `WC3STATS_ENABLED` (default false until map pattern is confirmed against a live lobby). Phase 1 does not need this. |
| Watcher / auto-create | Phase 3 claim only. No auto-create. |
| Infra | Phase 1–2: on-demand `fetch` only (fits t3.micro). No `ws` until Phase 3. |

## Player journeys

### Phase 1 — no screenshot

1. Host runs `/register_lobby` (no attachment).  
2. Empty PENDING embed appears.  
3. Host uses ➕ / `/lobby add` for each human.  
4. Ratings/balance fill in as nicks land.  
5. Start when both teams have ≥1 human.

Optional: still attach `print` for OCR as today.

### Phase 2 — wc3stats hit

1. Host (linked or not) runs `/register_lobby` with optional `wc3stats_id`, or the bot finds exactly one live UDBR lobby for their linked nick/host.  
2. If roster is usable → embed filled. If not → empty embed + “roster not published yet.”  
3. Host clicks **Refresh** until slots appear, or screenshot/manual.  
4. Host reviews nicks/slots, Start.

### Phase 2 — miss / API down

Create the Discord PENDING lobby anyway (wc3stats is optional). API down adds: `Could not read the Warcraft lobby. Add players or attach a screenshot.` No live UDBR / ambiguous / not UDBR: empty lobby + Refresh so the host can attach later.

## Architecture (Phase 1b)

```text
/config set player_claim enabled:true|false
  → assertCanConfigureBot
  → GuildConfig.lobbyPlayerClaimEnabled

Claim / Leave
  → resolveGuildConfig(guildId)
  → if !lobbyPlayerClaimEnabled → English error, no roster write
  → else nickForDiscordId → add/remove on PENDING
  → syncLobbyDiscordMessage (omit claim controls when off)

/lobby add user:@member
  → host path only; does not read the claim flag
```

`buildLobbyButtons` / claim select take `playerClaimEnabled` from resolved guild config. `syncLobbyDiscordMessage` loads it via the channel's `guildId`.

## Architecture (Phase 2)

```text
/register_lobby
  → assertCanCreateMatch
  → if print: OCR (existing)
  → else if WC3STATS_ENABLED:
        try import (explicit id, or host nick seated in a live UDBR lobby)
        miss / API down → continue empty, no game id
  → createPendingMatch({ players, wc3statsGameId? }) always
  → embed + buttons (Refresh if game id stored **or** WC3STATS_ENABLED)

Refresh button / `/lobby sync`
  → host/mod + PENDING
  → if Match.wc3statsGameId: fetchDetail(id)
  → else: require host Discord `/link`, find that nick as WC3 host or occupied human in a live UDBR lobby, store wc3statsGameId
  → optional `/lobby sync wc3stats_id:` binds even if the host nick is not in the roster
  → if usable roster: replaceMatchRoster
  → if empty-full: keep roster, ephemeral warning
  → syncLobbyDiscordMessage
```

### Modules

| File | Responsibility |
|------|----------------|
| `src/services/wc3stats-client.ts` | `fetchGamelist`, `fetchGameDetail`, timeouts |
| `src/services/wc3stats-map.ts` | Regex + sha1 allowlist |
| `src/services/wc3stats-roster.ts` | Detail → `LobbyPlayer[]`; empty-full detection; nick strip |
| `src/services/wc3stats-resolve.ts` | Pick the lobby or fail closed |
| `src/services/lobby-actions.ts` | `refreshLobbyFromWc3stats` use-case |
| `src/commands/lobby/register-lobby.ts` | Optional `print`, optional `wc3stats_id` |
| `src/services/lobby-preview.ts` | Refresh button + source footer |
| `src/handlers/lobby-interactions.ts` | Route Refresh |
| `prisma/schema.prisma` | `Match.wc3statsGameId` (nullable) |

Commands stay thin. Roster math stays in services.

## Data

### Nick

```text
raw = slot.player.name || slot.player.battleTag
if raw matches /^(.*)#\d+$/ → use capture 1
nick = normalizeNick(raw)   // existing trim + lowercase
```

Rationale: the ladder already keys on OCR-style names without `#tag`. Importing `goku#1234` as a new `Player` would split ratings.

### Slots

12 entries, index 0 = Red = bot slot 1. Computers/observers/open skipped. Unbalanced human fills remain valid.

### Schema

```prisma
model Match {
  // existing fields…
  wc3statsGameId String?
  @@index([wc3statsGameId])
}
```

Uniqueness: enforce in application for `status in (PENDING, IN_PROGRESS)`, not a global unique (ids recycle / history).

### Env (Phase 2)

| Var | Purpose |
|-----|---------|
| `WC3STATS_ENABLED` | `true` to attempt REST import |
| `WC3STATS_MAP_PATTERN` | Regex vs `map` filename / `normalizedName` / `path` (default UDBR) |
| `WC3STATS_MAP_SHA1` | Comma-separated `map.sha1` allowlist from game detail (not list `hash`). UDBR 2.4f: `19783c6259e86253a8c940ede63a87e18204bd94` |
| `WC3STATS_TIMEOUT_MS` | Default `4000` |

No new Discord intents.

## Security / ranked integrity

- Create-role on every create path.  
- Refresh is host or match-mod only.  
- Do not auto-link Discord from wc3stats names.  
- Do not treat “in-game host battleTag” as Discord permission.  
- Refresh must not blank a filled roster when the API returns empty `slots`.  
- Start uses the Discord roster the host last confirmed (same trust model as OCR). Slot-smuggling (change WC3 after import, before Start) already exists with screenshots; Refresh right before Start is the mitigation, not silent re-pull.

## Failure copy (English)

| Case | Message |
|------|---------|
| Screenshot omitted, wc3stats off/unavailable | `Lobby created empty. Add players or attach a screenshot.` |
| No live UDBR lobby | `No Ultimate Dragon Ball Reborn lobby found. Pass wc3stats_id or add players manually.` |
| Multiple candidates | `Several matching lobbies are live. Pass wc3stats_id to choose one.` |
| Map not UDBR | `That lobby is not Ultimate Dragon Ball Reborn.` |
| Roster unpublished | `wc3stats has not published the player list yet. Use Refresh, a screenshot, or add players.` |
| Refresh empty-full | `wc3stats still has no player list. Your current roster was kept.` |
| Duplicate game id | `That Warcraft lobby is already registered as match {id}.` |
| Refresh too soon | `Wait a few seconds before refreshing again.` |
| Player claim disabled | `Player slot claim is disabled on this server.` |
| Unlinked claim / add user | `Your Discord is not linked to an in-game nick. Run /link or ask a moderator.` |
| Host nick not in live lobby | `No Ultimate Dragon Ball Reborn lobby found with your linked nick. Sit in the Warcraft lobby or pass wc3stats_id.` |
| Import disabled | `Warcraft lobby import is disabled.` |

## Testing

Phase 1: `/register_lobby` with no attachment creates empty PENDING (command-level or extracted helper). OCR path unchanged when `print` is set.

Phase 1b: claim allowed when `lobbyPlayerClaimEnabled` is true (default); rejected when false. Host `/lobby add user:` still works when claim is off. Claim controls omitted from the embed when off.

Phase 2 (must exist before enabling the flag):

- Map regex accepts UDBR-like names; rejects Tribute / other maps.  
- `slotsTaken > 0` + `slots: []` → unusable, not empty lobby overwrite.  
- Occupied humans map to slot = index + 1; computers skipped.  
- `Goku#1234` → `goku`.  
- Ambiguous list → error, no silent pick.  
- Duplicate PENDING for same `wc3statsGameId` rejected.

## Open questions (defaults if unanswered)

1. **Exact UDBR `.w3x` / sha1?** Confirmed live 2026-08-14: `Ultimate Dragonball Reborn V2.4f.w3x`, `map.sha1` `19783c6259e86253a8c940ede63a87e18204bd94`, `normalizedName` `UDBR`. List `hash` is a different field — do not allowlist it.  
2. **Should Start re-pull?** Default: **no**. Host clicks Refresh if the WC3 lobby changed.  
3. **Unlinked nicks block Start?** Default: **no** (today they do not). Ghost profiles stay.  
4. **Who may pass `wc3stats_id` for a lobby they do not host in-game?** Default: anyone with create-role (Discord host ≠ WC3 host, already true).  
5. **Public watcher channel?** Default: Phase 3 only, dedicated channel, auto-clean on GameListDelete.

## Alternative route cards

Use these if the recommended path is rejected. Each has its own implementation plan.

| Route | When to pick | Plan |
|-------|----------------|------|
| C only | Want screenshot gone this week; do not trust any WC3 API | [screenshot-optional-lobby](../plans/2026-08-14-screenshot-optional-lobby.md) |
| 1b Discord fill | Regulars are `/link`ed; host should not type nicks. Player claim is guild-toggleable | [discord-lobby-self-claim](../plans/2026-08-14-discord-lobby-self-claim.md) |
| D (after C) | Want map detect + opportunistic player extract | [wc3stats-lobby-import](../plans/2026-08-14-wc3stats-lobby-import.md) |
| F | Hosts cannot find lobby ids; want a live board | [wc3stats-lobby-watcher](../plans/2026-08-14-wc3stats-lobby-watcher.md) |
| Replay verify | Disputes / wrong OCR after the game | Future; not a create-path |
| Host companion app | Need guaranteed live 12-slot accuracy | Separate product; not this bot |
| A without Refresh | Never. Empty-full is too common. | — |
| E auto-create | Never. | — |

## Success metrics

- Phase 1: hosts can create a ranked lobby with zero attachments; Start still requires both teams.  
- Phase 1b: a linked regular can sit without the host typing their nick.  
- Phase 2: on a night wc3stats publishes slots, `/register_lobby` without `print` yields a filled roster more often than empty. Empty-full never wipes a manual roster.  
- Integrity: no `Player.username` values containing `#` from importers.

## Spec self-review

- No TBD in behavior: unknowns have defaults.  
- C vs D vs F are sequenced, not mixed in one release.  
- Slot mapping, nick rule, empty-full, and create-role are unambiguous.  
- Scope is one product (screenshotless create); watcher is a later sub-project.
