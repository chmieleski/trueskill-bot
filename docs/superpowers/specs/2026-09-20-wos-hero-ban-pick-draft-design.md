# WOS hero ban/pick draft — Design

**Date:** 2026-09-20  
**Status:** Approved for implementation  
**Scope:**

- `game:warcraft3_wos` — dynamic `GameHero` pool, application emoji naming
- `general` — new `hero-draft` domain (turn engine, Discord thread UX); **not** an extension of captain team draft

## Goal

With **teams already formed**, moderators start a **hero ban/pick** for one match. Each draft gets its own **public Discord thread** so concurrent matches do not flood a channel. Captains take timed ban/pick actions from a **snapshotted WOS hero catalog**; the bot posts a final summary when complete.

## Non-goals (v1)

- Prefill or create a lobby/`Match` from the draft result (**tech debt — see below**)
- Force-pick / mod undo during ACTIVE
- UDBR fixed hero IDs 1–12 as the pool
- Extending `/captain_draft` lifecycle or state machine
- Empty / null picks (every pick slot always receives a hero)

## Tech debt (deferred)

**Lobby prefill button (product option B):** after `COMPLETE`, offer a Discord button that creates or prefills a lobby/`Match` from the two teams and their picked heroes. v1 only posts a summary embed. Track as follow-up work; do not implement in this change set.

## Locked decisions

| Topic | Choice |
| --- | --- |
| Relation to captain draft | Separate feature; teams may be **imported** from a completed captain draft **and/or** entered manually |
| Who starts / cancels | Match moderators (`assertHasMatchModRole` + universal mods) |
| Who acts on turn | **Team captain only** (Discord-linked) |
| Isolation | One **public thread** per draft; ping both rosters + match-mod role |
| Timer | Default **30s per action**; overridable on `/hero_draft start`; double-pick phases = **two sequential** actions with timer reset |
| Ban timeout | Ban is **lost** (same as Skip ban) |
| Pick timeout | **Random** remaining available hero |
| Skip | **Skip ban only**; picks cannot be empty |
| Pool | Snapshot all `GameHero` rows for the league’s `gameId` at start |
| Hero UI | Paginated StringSelect (25/page) + Skip ban button on ban turns |
| Emoji | Discord **application emoji** named `wos_{objectId}`; missing → text only |
| Completion | Final summary embed in the thread only |
| Minimum pool | Refuse start if catalog has fewer than **16** heroes (6 bans + 10 picks worst case) |
| Game gate | League `gameId` must be `warcraft3_wos` |

## Turn sequence

Team 1 = first-ban side (chosen at start). Each line is one timed captain action:

1. T1 ban → T2 ban → T1 ban → T2 ban  
2. T1 pick → T2 pick → T2 pick → T1 pick → T1 pick → T2 pick  
3. T1 ban → T2 ban  
4. T2 pick → T1 pick → T1 pick → T2 pick  

Per team: **3 bans + 5 picks**.

Banned and picked heroes leave the available pool (a hero cannot be selected twice).

## Commands

`/hero_draft`:

| Subcommand | Who | Description |
| --- | --- | --- |
| `start` | Mod | Resolve teams (captain-draft id and/or manual captains/rosters), `team1`, `timer` (optional), create public thread, post live card, start turn 0 |
| `cancel` | Mod | Cancel ACTIVE draft in this thread (or by draft id if provided) |

Team sources on `start` (at least one path per team):

- Import a team from a **COMPLETED** `CaptainDraft` (captain + roster)
- Manual: captain user + roster mentions/names

## Persistence

`HeroDraft` row:

- `guildId`, `leagueId`, `threadId`, `parentChannelId`, `hostDiscordId`
- `status`: `ACTIVE` \| `COMPLETE` \| `CANCELLED`
- `timerSeconds`, `liveMessageId`, optional `sourceCaptainDraftId`
- `state` JSON: teams, pool snapshot, bans/picks, turn index, `actionDeadlineAt`, UI page

Deadlines live in JSON so timers survive restart; on boot, rehydrate ACTIVE drafts and fire overdue actions immediately.

## Architecture

```text
/hero_draft start
  → resolve teams + snapshot GameHero
  → create public thread + ping rosters + mods
  → persist HeroDraft ACTIVE + live message
  → schedule actionDeadlineAt

Captain interaction / timeout
  → pure turn logic (ban | skip | pick | random)
  → save state + refresh live embed
  → if complete → summary embed, clear components

Bot boot
  → load ACTIVE HeroDraft → schedule remaining deadlines
```

Services under `src/services/hero-draft/` (sibling to `captain-draft`, not a fork). Interaction handler parallel to `captain-draft-interactions`.

## Edge cases

- Empty / &lt;16 catalog → refuse start  
- Stale select after turn advance → ephemeral deny  
- Text-only captain (no Discord id) → cannot self-act; mod must cancel/restart with linked captain (v1: no force)  
- Missing `wos_{objectId}` emoji → label without emoji  

## Testing

Unit tests: sequence length, skip ban, timeout ban/pick, availability, pagination bounds, team import from captain-draft state shape. UI builder: emoji attached when map has entry.

## English UI

All user-facing strings, command names/descriptions, and errors in **English**.
