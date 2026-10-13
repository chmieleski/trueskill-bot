# Lobby captain draft — design

**Date:** 2026-10-13
**Scope:** `game:warcraft3_udbr` (gated to `slot_bound` profiles). The phase engine itself is game-agnostic: sides and heroes come from `GameProfile` and `Hero` rows, no WC3 constants.

## Goal

Let a lobby run a self-service captain draft in a dedicated thread: players vote two captains, captains snake-draft the lobby, a side is chosen, players simultaneously pick heroes, and the bot **rewrites the existing PENDING lobby roster** so slot = hero. Mid-draft leavers are fixed in place (replace/remove) so nobody has to cancel and recreate lobbies.

## Decisions (agreed)

| Topic              | Decision                                                                                                                         |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| Outcome            | Rewrite the lobby (`MatchPlayer.slot/team/heroId`) on finish; host starts the match normally                                     |
| Entry point        | "Captain draft" button on the lobby embed; host or mod only                                                                      |
| Enablement         | `League.lobbyCaptainDraftEnabled`, default `false`, via `/league_config set`; copied on rollover                                 |
| Lobby during draft | Roster frozen. To change it: cancel draft, edit lobby, start a new draft                                                         |
| Unlinked players   | Draftable; cannot vote or pick heroes; receive random leftover heroes; shown by nick (linked players are @-mentioned)            |
| Captain candidates | Linked lobby players only                                                                                                        |
| Ballot             | Blind, simultaneous; each linked player selects 1–2 candidates; self-vote allowed; changeable until deadline                     |
| First pick         | Coin flip between captains; winner chooses **First pick** or **Side choice**; the other captain gets the remaining option        |
| Draft              | Snake (A, B, B, A, …) via `captainIndexForPick`                                                                                  |
| Hero pick          | Simultaneous; each linked player selects 0–2 heroes of their side (unordered, optional); resolved by randomized maximum matching |
| Leavers            | Host/mod Replace / Remove inside the draft; progress kept                                                                        |
| Thread             | Everything happens in one public thread on the lobby message                                                                     |

## Timers

| Phase        | Deadline     | Early close                  | Timeout behaviour                                                                    |
| ------------ | ------------ | ---------------------------- | ------------------------------------------------------------------------------------ |
| Captain vote | 60s          | All linked players voted     | Missing votes not counted; ties broken randomly; zero votes → random linked captains |
| Coin choice  | 30s          | —                            | Random option                                                                        |
| Captain pick | 45s per pick | —                            | Random pool player (marked ⏱️ auto)                                                  |
| Side choice  | 30s          | —                            | Random side                                                                          |
| Hero pick    | 120s         | All linked players locked in | Treated as no preference                                                             |

Timers are fixed constants (not configurable).

## Data model

```prisma
model LobbyDraft {
  id              String   @id @default(cuid())
  guildId         String
  leagueId        String
  matchId         String
  parentChannelId String
  threadId        String
  hostDiscordId   String
  status          String   // ACTIVE | COMPLETE | CANCELLED
  state           Json
  liveMessageId   String?
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  @@index([matchId, status])
  @@index([guildId, status])
  @@index([threadId])
}
```

`League.lobbyCaptainDraftEnabled Boolean @default(false)` — copied in `league-rollover.ts` alongside `balanceKiStrengthEnabled`.

One ACTIVE draft per match is enforced in code (checked inside the create transaction).

### State (`LobbyDraftState`)

- `phase`: `VOTE | COIN_CHOICE | PICK | SIDE | HERO` (terminal status lives on the row)
- `participants`: `{ key, nick, discordId? }[]` snapshot of the lobby at start
- `votes`: `Record<voterDiscordId, participantKey[]>` (max 2)
- `captains`: `[key, key]` after vote
- `coinWinner`, `firstPicker`, `sideChooser`: captain keys
- `pickIndex`, `pool`, `teams` (`{ captainKey, roster: key[], side: 1|2|null }[2]`)
- `heroPrefs`: `Record<participantKey, heroId[]>` (0–2), `heroLockedIn: participantKey[]`
- `heroResult`: `Record<participantKey, { heroId, how: 'wanted' | 'contested' | 'random' }>`
- `deadlineAt`: ISO string or null
- `log`: short human-readable entries (picks, auto-actions, replacements)

## Module layout — `apps/bot/src/services/lobby-draft/`

| File               | Responsibility                                                                                                                                      |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `draft-types.ts`   | State types, phase constants, timer constants, `LobbyDraftError`                                                                                    |
| `draft-logic.ts`   | Pure: `tallyVotes`, `resolveCoinChoice`, `applyPick`, `applySide`, `resolveHeroes(rng)`, `replaceParticipant`, `removeParticipant`, `timeoutAction` |
| `draft-state.ts`   | Load/parse/save with optimistic `updatedAt` check                                                                                                   |
| `draft-actions.ts` | Use-cases: start, vote, coinChoice, pick, side, heroPrefs, lockIn, manage, cancel                                                                   |
| `finalize.ts`      | Transactional roster rewrite + lobby embed sync                                                                                                     |
| `draft-ui.ts`      | Live embed, phase posts, components                                                                                                                 |
| `draft-timer.ts`   | `setTimeout` per deadline + boot rehydrate (copy of `hero-draft/draft-timer.ts`)                                                                    |
| `index.ts`         | Barrel                                                                                                                                              |

Discord `customId`s use the `ldraft:` prefix and route through the existing interaction handler. Snake math reuses `captainIndexForPick` from `services/captain-draft/draft-logic.ts`.

## Flow

### Start

Host/mod clicks **Captain draft** (button visible when flag on, profile `slot_bound`, match PENDING). Validation: no ACTIVE draft for match, ≥2 linked players, ≥2 players total. Bot creates a public thread on the lobby message (`Draft – <lobby #>`), persists the draft, posts:

> ⚔️ Captain draft for this lobby. @A @B @C … Unlinked: `Nick1`, `Nick2`. The lobby is frozen until the draft ends or is cancelled.

One live embed is edited in place (phase, `<t:…:R>` countdown, teams so far, host/mod manage row). Each phase transition also posts a short message for history.

### 1. Vote

**Vote captains** → ephemeral multi-select (1–2) of linked participants. Embed shows "N/M voted" only. Reveal posts counts per candidate; top 2 become captains; random tie-breaks marked 🎲.

### 2. Coin choice

"🪙 Coin flip: @CaptA wins". CaptA-only buttons **First pick** / **Side choice**. If Side choice: CaptA chooses side immediately (phase 4 rules), CaptB picks first.

### 3. Snake pick

Current captain gets a select of pool players (nick + 🔗 if linked); the other sees it disabled. Each pick posts "CaptA picked Bob". When the pool is empty → phase 4 if side unset, else phase 5.

### 4. Side choice

Side chooser sees `profile.teamNames[1]` (slots 1–6) / `teamNames[2]` (slots 7–12).

### 5. Hero pick

**Pick heroes** → ephemeral multi-select, min 0 max 2, of the player's side heroes, with text: _"Pick up to 2 heroes you'd play. Optional — pick none and you'll get a random hero."_ Plus **Lock in**. Choices hidden until reveal; changeable until deadline.

**Resolution per team (`resolveHeroes`)**: shuffle players and heroes with the injected rng, then compute a maximum bipartite matching (Kuhn's augmenting paths, ≤6×6) between players and their wanted heroes. Matched players get their hero (`wanted`, or `contested` if another player also wanted it and lost). Remaining players (no prefs, prefs taken, unlinked, AFK) get random free side heroes (`random`). Reveal post lists results with 🎲 on contested outcomes.

### 6. Finalize

In one Prisma transaction: re-check match is PENDING, rewrite `MatchPlayer` rows to `slot = heroId`, `team = teamForSlot`, `heroId = rosterHeroId`. Set draft COMPLETE. Then `syncLobbyDiscordMessage` (swap commands update automatically), post "✅ Lobby updated" with a link. Thread is left to Discord auto-archive (not deleted).

### Cancel

Host/mod **Cancel draft**, or the lobby is cancelled/started → draft CANCELLED, thread notice + lock, timer cleared, lobby unfrozen with roster untouched.

## Leavers — Manage (host/mod)

- **Replace player**: new person (linked Discord user or typed nick) takes the seat as-is — pool, team, captaincy, chosen hero. Linked newcomer is pinged. Refused if newcomer is already in the draft.
- **Remove player**: seat dropped. Unbalanced teams allowed while each team keeps ≥1 player.
  - Removed captain → team's earliest-drafted player becomes captain; if none, a random linked pool player.
  - Their votes are dropped, and votes for them are ignored.
  - If removal empties a team, or leaves <2 linked players before captains are set, the draft is cancelled with a notice.
- Phase and timer continue; if the affected person is the one on the clock, the deadline restarts for the replacement/successor.
- Every change is logged in the thread ("🔁 Goku_BR replaced Vegeta77 (Team Goku)").

## Permissions

| Action                   | Who                                                              |
| ------------------------ | ---------------------------------------------------------------- |
| Start, Manage, Cancel    | Lobby host or mod (same check as `resolvePendingMatchForManage`) |
| Vote, Hero pick, Lock in | Linked participants; others get "You're not in this draft."      |
| Coin choice, Pick, Side  | The captain whose turn it is                                     |

## Lobby freeze

A guard in `services/lobby/actions.ts` rejects roster mutations while an ACTIVE `LobbyDraft` exists for the match: claim, leave, add, remove, move, swap, remap, edit nick, lock/unlock, balance, `applyRosterUpdateForMessage`, wc3stats refresh, screenshot refresh. Message: _"A captain draft is running for this lobby. Cancel the draft to edit the roster."_ Lobby start/cancel cancel the draft instead of being blocked.

## Errors & robustness

- Each action: load → validate phase/turn/actor → save with `updatedAt` check. Stale or duplicate clicks get an ephemeral "That action is no longer valid."
- Timer callbacks use the same path; a timeout losing the race to a real action is a no-op.
- Thread creation failure → ephemeral error, nothing persisted.
- Deleted live message → re-posted on next sync, id stored.
- Bot restart → timers rehydrated; overdue deadlines fire immediately.
- Finalize finds match no longer PENDING → draft cancelled with notice.

## Testing (vitest)

- `draft-logic.test.ts`: tallyVotes (ties, zero votes, removed candidates); coin choice both branches; snake order; side; `resolveHeroes` with seeded rng (no clash, true clash, A{G,V}/B{G} → both satisfied, empty prefs, unlinked); replace/remove incl. captain succession and empty-team abort; `timeoutAction` per phase.
- `finalize.test.ts`: roster → slot mapping per side; refuses non-PENDING match.
- Freeze guard case in existing lobby action tests.
- UI builder tests in the style of `hero-draft/draft-ui.test.ts`.

## Out of scope

Configurable timers, draft history/stats, WOS / `optional_in_game` support, auto-detecting leavers from wc3stats, late "add player" without replacement.
