# WOS hero ban/pick draft — Design

**Date:** 2026-09-20  
**Status:** Approved (UX revision — panel + action log)  
**Scope:**

- `game:warcraft3_wos` — dynamic `GameHero` pool, application emoji naming
- `general` — `hero-draft` domain (turn engine, Discord thread UX); **not** an extension of captain team draft

## Goal

With **teams already formed**, moderators start a **hero ban/pick** for one match. Each draft gets its own **public Discord thread**. Captains take timed ban/pick actions from a **snapshotted WOS hero catalog**.

The thread always has:

1. A **pinned live panel** (full state + controls) — dual-column “duel” layout
2. An **append-only action log** — every ban / pick / skip / timeout / cancel / complete is a new message that pings the next captain when applicable

## Non-goals (v1 / this revision)

- Prefill or create a lobby/`Match` from the draft result (**tech debt — see below**)
- Force-pick / mod undo during ACTIVE
- UDBR fixed hero IDs 1–12 as the pool
- Extending `/captain_draft` lifecycle or state machine
- Empty / null picks (every pick slot always receives a hero)
- Mirroring the action log to the parent channel
- Slash skip-ban (Skip ban remains a panel button only)

## Tech debt (deferred)

**Lobby prefill button (product option B):** after `COMPLETE`, offer a Discord button that creates or prefills a lobby/`Match` from the two teams and their picked heroes. v1 only posts a summary embed on the pinned panel. Track as follow-up work; do not implement in this change set.

## Locked decisions

| Topic                     | Choice                                                                                                                           |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Relation to captain draft | Separate feature; teams may be **imported** from a completed captain draft **and/or** entered manually                           |
| Who starts / cancels      | Match moderators (`assertHasMatchModRole` + universal mods)                                                                      |
| Who acts on turn          | **Team captain only** (Discord-linked)                                                                                           |
| Isolation                 | One **public thread** per draft; ping both rosters + match-mod role on start                                                     |
| Live panel                | One **edited** message, **pinned** best-effort; holds full state + select/Skip controls                                          |
| Panel layout              | **Dual-column duel** — two inline team fields; 🚫 BANS / ✅ PICKS rows; hero application emoji on each hero when available       |
| Action log                | New message in the **same thread** after every successful action; includes **next captain mention** + BAN/PICK emoji             |
| Hero selection            | **Hybrid:** paginated StringSelect on panel (25/page) **and** `/hero_draft select hero:…` autocomplete                           |
| Select slash              | One subcommand; applies **ban or pick** based on current turn; resolves ACTIVE draft by **thread id**                            |
| Timer                     | Default **30s per action**; overridable on `/hero_draft start`; double-pick phases = **two sequential** actions with timer reset |
| Ban timeout               | Ban is **lost** (same as Skip ban)                                                                                               |
| Pick timeout              | **Random** remaining available hero                                                                                              |
| Skip                      | **Skip ban only** (panel button); picks cannot be empty                                                                          |
| Pool                      | Snapshot all `GameHero` rows for the league’s `gameId` at start                                                                  |
| Emoji                     | Discord **application emoji** named `wos_{objectId}`; missing → text only                                                        |
| Turn / kind labels        | Always show **🚫 BAN** / **✅ PICK** (panel description, log lines, select placeholders)                                         |
| Completion                | Pinned panel becomes summary (components cleared); final log line; pin left in place                                             |
| Minimum pool              | Refuse start if catalog has fewer than **16** heroes (6 bans + 10 picks worst case)                                              |
| Game gate                 | League `gameId` must be `warcraft3_wos`                                                                                          |

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

| Subcommand | Who     | Description                                                                                                                                            |
| ---------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `start`    | Mod     | Resolve teams (captain-draft id and/or manual captains/rosters), `team1`, `timer` (optional), create public thread, post + pin live card, start turn 0 |
| `cancel`   | Mod     | Cancel ACTIVE draft in this thread (or by draft id if provided)                                                                                        |
| `select`   | Captain | Autocomplete `hero:` over **available** pool for ACTIVE draft in this thread; applies current turn kind (ban or pick)                                  |

Team sources on `start` (at least one path per team):

- Import a team from a **COMPLETED** `CaptainDraft` (captain + roster)
- Manual: captain user + roster mentions/names

## Channel UX detail

### Pinned panel

- Title: `Hero ban / pick` while ACTIVE; `Hero draft complete` when done
- Description: on-clock captain, **🚫 BAN** or **✅ PICK**, relative deadline (`<t:…:R>`)
- Two **inline** fields (Team 1 | Team 2), each:

  ```text
  Captain: @…
  🚫 Bans
  <:wos_…:…> Name
  …
  ✅ Picks
  <:wos_…:…> Name
  …
  ```

- Footer / extra field: remaining hero count + tip (`Select below or /hero_draft select`)
- Components on the same message: StringSelect (page of available heroes + page nav values) + Skip ban on ban turns
- Embed field overflow (>1024 chars): truncate with `… +N more` (unlikely at 3 bans / 5 picks)

### Action log

After each successful state change, post one thread message, English, e.g.:

- `🚫 **Team Alpha** banned <:…> Piccolo → ✅ <@cap2> **PICK**`
- `✅ **Team Bravo** picked <:…> Gohan → 🚫 <@cap1> **BAN**`
- `⏭️ **Team Alpha** skipped ban → …`
- Timeout variants use the same shape with a timeout note
- Complete / cancel: terminal log line, no next-captain ping when draft ends

Log messages are the audit trail; **not** persisted separately in the DB.

### Pinning

- Attempt `message.pin()` after posting the live panel
- If pin fails (missing permission): draft continues; mention in the ephemeral/start reply that pin failed
- Do not unpin on complete/cancel (history + Pins list stay useful)

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
  → pin live message (best-effort)
  → schedule actionDeadlineAt

Captain interaction (select menu | /hero_draft select | timeout)
  → pure turn logic (ban | skip | pick | random)
  → save state
  → edit pinned panel (+ components)
  → post action log (next captain mention when still ACTIVE)
  → if complete → summary panel, clear components, final log

Bot boot
  → load ACTIVE HeroDraft → schedule remaining deadlines
```

Services under `src/services/hero-draft/` (sibling to `captain-draft`, not a fork). Interaction handler parallel to `captain-draft-interactions`.

## Edge cases

- Empty / &lt;16 catalog → refuse start
- Stale select after turn advance → ephemeral deny
- `/hero_draft select` outside draft thread or no ACTIVE draft → clear error
- Autocomplete: filter available heroes by query; return ≤ Discord autocomplete max; empty query → first page of available
- Text-only captain (no Discord id) → cannot self-act; mod must cancel/restart with linked captain (v1: no force)
- Missing `wos_{objectId}` emoji → label without emoji (name only)
- Pin permission missing → warn; continue

## Testing

Unit tests: sequence length, skip ban, timeout ban/pick, availability, pagination bounds, team import from captain-draft state shape.  
UI builder: dual-column fields; BAN/PICK emoji labels; hero emoji when map has entry; log line format with next mention; field truncation.  
Select slash: resolves by thread; applies correct turn kind; autocomplete filter.  
Pin: mocked success and permission failure (draft still ACTIVE).

## English UI

All user-facing strings, command names/descriptions, and errors in **English**.
