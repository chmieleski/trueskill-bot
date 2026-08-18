# Host one active lobby — Design

**Date:** 2026-08-18  
**Status:** Approved  
**Scope:** `general` (match create path; keyed by `leagueId`)  
**Plan:** `docs/superpowers/plans/2026-08-18-host-one-active-lobby.md`

## Goal

Several ranked lobbies may exist in a league at once. A **host** (create role, not match mod) may have only **one** active hosted match in that league. They must cancel or complete it before opening another. **Match moderators** (and universal mods) may host several. Create role remains required for everyone.

## Non-goals

- Auto-cancel or replace the existing match
- Blocking a player who is **seated** in two lobbies (this cap is host-only)
- A Prisma unique index on host + league (mods must be allowed multiple active rows)
- Letting mods skip the create-role gate
- Changing `/lobby` resolve when a host already has more than one pending card
- New env vars or AWS SSM keys
- Cross-league or cross-guild caps

## Locked decisions

| Topic | Choice |
|-------|--------|
| What counts as active | `PENDING` or `IN_PROGRESS` |
| Tenancy | Per **league** (`hostDiscordId` + `leagueId`) |
| Second create | **Refuse** and name the existing match id |
| Who skips the cap | `hasMatchModRole` (guild match-mod role **or** universal mod) |
| Create role | Unchanged; still required, including for mods |
| Enforcement | Inside `createPendingMatch` transaction |
| Bypass default | `bypassHostLobbyCap` defaults to **false** |

## Architecture

Create role stays the first gate. The one-lobby cap is a second gate on insert.

```text
/register_lobby  or  wc3stats Open
  → assertCanCreateMatch (create role)     // unchanged
  → createPendingMatch({
        leagueId, hostDiscordId, …,
        bypassHostLobbyCap: hasMatchModRole(...)
     })
       transaction:
         if !bypassHostLobbyCap:
           existing = newest PENDING|IN_PROGRESS for this host + league
           if existing → refuse, name that match id
         (existing wc3stats duplicate check)
         insert PENDING
```

No schema change. `COMPLETED` and `CANCELLED` do not count.

### Modules

| File | Change |
|------|--------|
| `src/services/match/match-service.ts` | `bypassHostLobbyCap` on `CreatePendingMatchInput`; message helper; assert inside the create transaction |
| `src/commands/lobby/register-lobby.ts` | Pass `hasMatchModRole({ actorDiscordId, memberRoleIds, matchModRoleId })` |
| `src/services/lobby/create-from-wc3stats.ts` | Same bypass flag |
| `src/services/match/host-lobby-cap.test.ts` | Unit tests for message + cap helper |
| `docs/discord/public/03-start-a-lobby.md` | One line: non-mod hosts close the current match before opening another |

Extract a small helper the transaction calls (do not mock hero catalog + roster create to test the cap):

```text
hostLobbyCapMessage(status, matchId)
assertHostLobbyCapInTx(tx, { leagueId, hostDiscordId, bypassHostLobbyCap })
```

`assertHostLobbyCapInTx`:

- If `bypassHostLobbyCap` is true, return.
- `findFirst` where `leagueId`, `hostDiscordId`, `status in [PENDING, IN_PROGRESS]`, `orderBy createdAt desc`, select `id` + `status`.
- If a row exists, throw `MatchServiceError` with `hostLobbyCapMessage`.

## Refuse copy (English)

| Existing status | Message |
|-----------------|--------|
| `PENDING` | `You already have a pending lobby ({id}). Cancel it before opening another.` |
| `IN_PROGRESS` | `You already have a match in progress ({id}). Report or cancel it before opening another lobby.` |

If several leftover actives exist (pre-feature), name the **newest**. After they close it, the next create names the one that remains. They cannot open a new lobby until this league has **zero** active matches they host.

Callers already map `MatchServiceError` to the Discord reply. No new user-facing types.

## Edge cases

| Case | Result |
|------|--------|
| Create role, pending in this league | Refuse, pending copy |
| Create role, in progress in this league | Refuse, in-progress copy |
| Same host, only completed/cancelled in this league | Allow |
| Same host, active match in **another** league | Allow |
| Match mod or universal mod (has create role) | Allow, no cap |
| Member with **both** create and mod roles | Bypass (mod exception) |
| Mod **without** create role | Still blocked by create role |
| Player sitting in someone else’s lobby | Irrelevant |
| wc3stats Open | Same `createPendingMatch` check |
| Double-click race | Check is in the insert transaction; no unique index. A rare double insert is acceptable. |

## Testing

| Test | Expect |
|------|--------|
| Message helper, pending | Names id, says cancel |
| Message helper, in progress | Names id, says report or cancel |
| Cap helper, no active row | No throw |
| Cap helper, pending same league | Throw pending copy |
| Cap helper, in progress same league | Throw in-progress copy |
| Cap helper, `bypassHostLobbyCap: true` | No throw even if a row exists |
| Cap helper query | `findFirst` uses this `leagueId` + `hostDiscordId` + active statuses |
| `/register_lobby` / wc3stats Open | Pass `hasMatchModRole(...)` as the bypass flag |

Manual: create-role host opens one lobby, second `/register_lobby` refuses; cancel; third succeeds. Mod opens two in the same league.

## Success criteria

- A non-mod host cannot have two `PENDING`/`IN_PROGRESS` matches they host in the same league.
- A match mod (with create role) can.
- The refuse reply names the blocking match id.
- Other leagues are unaffected.
- Create role behavior is unchanged.
