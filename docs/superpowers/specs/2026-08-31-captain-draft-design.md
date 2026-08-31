# Captain draft — Design

**Date:** 2026-08-31  
**Status:** Approved  
**Scope:** `general` — standalone snake draft for tournament team picking; no lobby/match coupling in v1

## Goal

Moderators run a **captain snake draft** in a Discord channel: set captains and a member pool, shuffle pick order, draft players in public view, then publish **one beautiful embed per team** (leaderboard-style) that stays editable after the draft ends.

Spectators follow the live draft embed; captains pick via select menu or slash; linked nicks resolve to Discord mentions.

## Non-goals (v1)

- Tournament brackets, match creation, or lobby import
- Rating-based balance hints or auto-seed by ki
- Non-mod hosts (all setup and publish is mod-only)
- Per-guild configurable team name themes (defaults only)
- Event entity linkage

## Locked decisions

| Topic                 | Choice                                                                                                                                     |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Persistence           | **Postgres** — `CaptainDraft` + related rows; survives bot restart                                                                         |
| Entry                 | Standalone — not tied to `Match` / `/register_lobby`                                                                                       |
| Setup auth            | **Match moderators only** — `assertHasMatchModRole` + universal mod IDs (same as match mod / `/player link` relink)                        |
| Pick auth             | **Current captain only** (by `discordId`; text-only captains use slash pick only)                                                          |
| Input                 | `@mentions` and/or comma-separated text; text nicks resolved via league `gameId` → if `Player.discordId` set, store and display as mention |
| League context        | Channel-bound league when available (for nick lookup); optional `league` option on setup subcommands if channel unbound                    |
| Lifecycle             | `start` → `captains` → `members` → **`begin`** → snake picks → `COMPLETE`                                                                  |
| Pick UI               | **Select menu** (button on live embed → ephemeral select) **+** `/captain_draft pick` slash fallback                                       |
| Captain order shuffle | At **`begin`** (Fisher–Yates)                                                                                                              |
| One draft per channel | Reject `start` if an active draft exists in the same channel                                                                               |
| Post-draft roster     | Mod runs **`publish`** → posts/updates team embeds in target channel                                                                       |
| Team names            | Default `Team {CaptainLabel}`; **captain** may **`rename`** after `COMPLETE`                                                               |
| Live updates          | Stored `messageId`(s) re-edited on every roster/name change (and on republish)                                                             |
| Mod corrections       | Mods may add/remove/swap/move players and undo picks — refreshes live + published embeds                                                   |

## Commands

Single slash command `/captain_draft`:

| Subcommand | Who             | Description                                                                                     |
| ---------- | --------------- | ----------------------------------------------------------------------------------------------- |
| `start`    | Mod             | Create draft in this channel; caller recorded as host                                           |
| `captains` | Mod             | Set captain list (`players` string: mentions + comma names). Replaces prior captains in `SETUP` |
| `members`  | Mod             | Set member pool (`players` string). Excludes captains; replaces prior pool in `SETUP`           |
| `begin`    | Mod             | Requires ≥2 captains and ≥1 member; shuffles order; posts live draft embed; opens pick 1        |
| `pick`     | Current captain | `player` string with autocomplete from remaining pool                                           |
| `rename`   | Team captain    | `name` string — after `COMPLETE` only; updates DB + refreshes published team embeds             |
| `publish`  | Mod             | `channel` optional (default: current). Posts or **re-edits** team roster embed(s)               |
| `cancel`   | Mod             | Aborts draft; deletes live draft message if present                                             |

### Moderator management subcommands

All require match mod role. Operate on the **active draft in this channel** (SETUP, ACTIVE, or COMPLETE — not CANCELLED).

| Subcommand    | Valid when              | Description                                                                                                                                     |
| ------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `add`         | SETUP, ACTIVE, COMPLETE | `player` (+ optional `team` autocomplete). SETUP/ACTIVE: append to member pool. COMPLETE/ACTIVE with `team`: add directly to that team's roster |
| `remove`      | SETUP, ACTIVE, COMPLETE | `player` autocomplete. SETUP/ACTIVE: remove from pool. ACTIVE/COMPLETE: remove from a team roster (not captains)                                |
| `swap`        | ACTIVE, COMPLETE        | `player_a`, `player_b` autocomplete — exchange two players across teams or team↔pool                                                            |
| `move`        | ACTIVE, COMPLETE        | `player`, `team` — move drafted player to another team                                                                                          |
| `undo`        | ACTIVE                  | Revert the last pick: player returns to pool, `pickIndex` decrements, turn rewinds                                                              |
| `force_pick`  | ACTIVE                  | `player` — assign pick for the **current** captain (AFK captain)                                                                                |
| `rename_team` | COMPLETE                | `team`, `name` — mod rename any team (captains still use `rename` for their own)                                                                |

After every mod mutation during ACTIVE: refresh live draft embed. During ACTIVE or COMPLETE when published: refresh published team embeds via `draft-display-sync`.

**Rules:**

- Cannot remove a captain from their team.
- `add` to pool during ACTIVE does not change whose turn it is.
- `undo` only when `pickIndex > 0`.
- `swap`/`move` cannot duplicate a player on one team.
- Mod `rename_team` accepts `team` autocomplete (team display names).

All user-facing strings in **English**.

### Mod role resolution

Reuse existing guild config:

- `GuildConfig.matchModRoleId` (fallback env `MATCH_MOD_ROLE_ID`)
- `isUniversalMatchMod(discordId)` bypass

Same pattern as `assertHasMatchModRole` in `src/services/match/match-auth.ts`.

## Snake draft logic

- **Teams** = one per captain; captain is always on their roster (not in member pool).
- **Pick order** at `begin`: shuffle captain indices `[0..N-1]`.
- **Snake**: round 1 forward, round 2 reverse, … until member pool empty.
- **Pick index → captain**: `round = floor(pickIndex / N)`, `posInRound = pickIndex % N`, direction alternates per round.
- **Completion**: when pool empty → status `COMPLETE`, live draft embed shows final summary; remove pick button.

Shared use-case: `applyCaptainDraftPick({ draftId, actorDiscordId, participantKey })` — used by select handler and slash `pick`.

## Live draft embed (during `ACTIVE`)

Public message in draft channel (stored `draftMessageId`), edited after each pick:

```text
Captain Draft — Pick 7 of 20
Round 2 · reversing

🎯 ON THE CLOCK — Team Alice (Captain)
  👑 Alice
  • Bob
  • …

Team Carol
  👑 Carol
  • …

Available (13)
  Dave, Eve, …

[ Pick player ]   ← only meaningful for current captain
```

- Linked players render as `<@discordId>`; others as plain label.
- Select menu: ephemeral, ≤25 options per page; paginate with follow-up select if pool >25 (same pattern as other wizards).

## Post-draft team embeds (`publish`)

Inspired by live leaderboard embeds (`leaderboard-embed.ts`): monospace roster block, medal-style accents, timestamp footer.

**Layout:** one `EmbedBuilder` per team; up to 10 embeds per Discord message — single message when `teams.length ≤ 10`, else chunk into multiple messages (same channel, ordered).

Per-team embed:

| Field       | Content                                                              |
| ----------- | -------------------------------------------------------------------- |
| Color       | Rotating palette (gold / blue / red / green / purple … by pick slot) |
| Title       | `{displayName}`                                                      |
| Description | `Captain` line with 👑 + mention/label                               |
| Body        | Code-block roster table: `#`, `Player` columns; captain row marked   |
| Footer      | `Captain draft · {date} · Pick order #{n}` on last embed in batch    |

**Publish behavior:**

1. If `CaptainDraftDisplay` exists and messages still reachable → **edit** all stored messages with fresh embeds.
2. If missing or messages deleted → send new message(s), persist ids on `CaptainDraftDisplay`.
3. Republish always reflects latest `displayName` and roster.

**Rename behavior:**

1. Captain calls `rename` → validate actor is that team’s captain (`discordId` match; text captains cannot rename via Discord — mod could add `rename` with team option later; v1: discord-linked captains only for rename).
2. Update team `displayName` in DB.
3. Call same refresh helper as `publish` (no new messages if ids valid).

## Data model

```prisma
model CaptainDraft {
  id              String   @id @default(cuid())
  guildId         String
  channelId       String   // draft channel
  hostDiscordId   String
  leagueId        String?  // nick resolution; from channel binding when set
  status          String   // SETUP | ACTIVE | COMPLETE | CANCELLED
  state           Json     // serialized DraftState (see below)
  draftMessageId  String?
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  display CaptainDraftDisplay?

  @@index([guildId, channelId, status])
  @@index([guildId, status])
}

model CaptainDraftDisplay {
  id         String   @id @default(cuid())
  draftId    String   @unique
  channelId  String
  messageIds Json     // string[] — Discord message ids for published team embeds
  updatedAt  DateTime @updatedAt

  draft CaptainDraft @relation(fields: [draftId], references: [id], onDelete: Cascade)
}
```

### `DraftState` JSON shape

```typescript
type DraftParticipant = {
  key: string; // stable id (cuid) for picks/autocomplete
  label: string; // display label
  discordId?: string;
};

type DraftTeam = {
  captainKey: string;
  displayName: string; // editable after COMPLETE
  roster: DraftParticipant[]; // includes captain as first entry
  pickOrderIndex: number; // 0-based slot in shuffled order
};

type DraftState = {
  captains: DraftParticipant[];
  memberPool: DraftParticipant[];
  pickOrder: number[]; // indices into captains at begin
  teams: DraftTeam[]; // populated at begin
  pickIndex: number; // 0-based global pick count during ACTIVE
};
```

TTL: optional cleanup job deletes `CANCELLED` / old `COMPLETE` drafts after 7 days (non-blocking for v1; can be follow-up).

## Architecture

```text
src/commands/captain-draft/captain-draft.ts
src/services/captain-draft/
  draft-auth.ts           # assertDraftMod, assertCurrentCaptain, assertTeamCaptain
  draft-state.ts          # load/save, create, cancel
  draft-resolve.ts        # parse players string, nick → Player.discordId
  draft-logic.ts          # shuffle, snake index, applyPick, undo, swap, move, add, remove
  draft-mod-actions.ts    # mod use-cases wrapping draft-logic + embed refresh
  draft-live-embed.ts     # live ACTIVE embed + pick button
  draft-team-embed.ts     # post-draft per-team embeds (leaderboard aesthetic)
  draft-display-sync.ts   # publish / refresh Discord messages
src/discord/interactions/captain-draft-interactions.ts
```

Register in `interaction-create.ts` with prefix `cdraft:` (pick button, select).

Nick resolution (`draft-resolve.ts`):

1. Split input on commas; trim; parse leading `<@id>` mentions.
2. For text tokens: `Player.findFirst` where `gameId` from league and `username` equals (insensitive).
3. If row with `discordId` → participant with mention; else plain label.
4. Dedupe by `discordId` or normalized label; error on overlap between captains and members.

## Error handling

| Case                            | Response                               |
| ------------------------------- | -------------------------------------- |
| Not mod on setup/publish/cancel | Ephemeral: mod-only message            |
| Draft already active in channel | Ephemeral: finish or cancel first      |
| Wrong turn on pick              | Ephemeral: whose turn it is            |
| Player not in pool              | Ephemeral: not available               |
| begin without captains/members  | Ephemeral: what's missing              |
| rename before COMPLETE          | Ephemeral: draft not finished          |
| rename by non-captain           | Ephemeral: captains only               |
| publish with no COMPLETE draft  | Ephemeral: complete draft first        |
| undo with no picks yet          | Ephemeral: nothing to undo             |
| remove captain                  | Ephemeral: cannot remove a captain     |
| swap/move duplicates            | Ephemeral: player already on that team |

## Testing

- Unit: snake index math, shuffle determinism (injected RNG), pick application, pool exhaustion, nick resolution
- Unit: team embed builder snapshot (title, roster lines)
- Integration: mod gate, turn enforcement, publish → rename → message ids updated
- Unit: mod undo, swap, move, add/remove pool and roster

## Rejected alternatives

| Alternative                  | Why not                                            |
| ---------------------------- | -------------------------------------------------- |
| In-memory only               | Bot restart mid-tournament loses state             |
| Auto-start on `members`      | Staff wanted review step (`begin`)                 |
| Host = any user              | User requested mod-only                            |
| Single combined roster embed | User asked one embed per team, leaderboard quality |
| Lobby-integrated v1          | Explicit standalone scope                          |

## Future (not v1)

- Import draft rosters into `/register_lobby` or Event matches
- Text-captain self-rename (captains without `discordId`)
- `league`-less nick resolution across all guild games
- Bulk mod edit via button wizard (v1 is slash-only)
