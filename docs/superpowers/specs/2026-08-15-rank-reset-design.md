# League rank (ki) reset — Design

**Date:** 2026-08-15  
**Status:** Approved for implementation planning  
**Scope:** `general` (league-scoped OpenSkill ratings; not game-specific)

## Goal

Linked players can **fully reset** their league ki (overall + all hero ratings) when the league admin has enabled the feature, subject to a per-league cooldown in **days**. Match moderators can force-reset another linked player (bypassing cooldown; the reset still restarts that player’s cooldown). The `/rank_reset` command stays registered everywhere; if the resolved league has the feature off, the bot rejects with a clear ephemeral message (soft-hide — no per-guild command sync).

## Non-goals

- Per-guild (cross-league) enable/cooldown
- Dynamically registering/unregistering the slash command per guild
- Resetting only overall or only heroes (v1 is always full wipe)
- Reset by nick for unlinked players
- Public staff audit slash command (audit rows are stored for future use / ops)
- Changing OpenSkill defaults (μ `25` / σ `8.333`) or display ki formula

## Locked decisions

| Topic | Choice |
|-------|--------|
| What resets | League-global `PlayerRating` **and** all `PlayerHeroRating` rows for that `(leagueId, playerId)` |
| Config tenancy | Per **league** |
| Command visibility | Soft-hide: always deployed; reject when `rankResetEnabled=false` |
| Who may reset | Linked self; match mod may target another linked user |
| Staff cooldown | Bypass check; still insert audit row → player cooldown restarts |
| Confirmation | Ephemeral Confirm / Cancel for **all** resets (self and staff) |
| Cooldown unit | Days only (`1`–`365`) |
| Defaults | Feature **off**; `rankResetCooldownDays` schema default **30** so enable can be `enabled:True` alone |
| Active matches | Block if target is on any **PENDING** or **IN_PROGRESS** match in that league |
| Architecture | Approach **3**: league flags + `PlayerRankReset` audit table as cooldown source of truth |
| User-facing wording | **ki** / “rank”, not “Elo” |

## Data model

### `League` columns

```prisma
rankResetEnabled      Boolean @default(false)
rankResetCooldownDays Int     @default(30)
```

Config writes:

- Reject `cooldown_days` outside `1`–`365` with a clear English error (do not silently clamp).
- Enabling with omitted days keeps the current stored value (usually `30`).

### `PlayerRankReset` (audit + cooldown)

```prisma
model PlayerRankReset {
  id               String   @id @default(cuid())
  leagueId         String
  playerId         String
  actorDiscordId   String
  targetDiscordId  String?
  staffOverride    Boolean  @default(false)
  createdAt        DateTime @default(now())

  league League @relation(fields: [leagueId], references: [id], onDelete: Cascade)
  player Player @relation(fields: [playerId], references: [id], onDelete: Cascade)

  @@index([leagueId, playerId, createdAt])
  @@index([leagueId, createdAt])
}
```

Cooldown eligibility: load the latest `PlayerRankReset` for `(leagueId, playerId)` ordered by `createdAt` desc. If none → eligible. If `now < createdAt + rankResetCooldownDays` and the actor is not a staff override → reject with next-available Discord timestamp.

No `lastRankResetAt` on `PlayerRating` — audit table is the single source of truth.

## Reset effect (single transaction)

1. Upsert `PlayerRating` for `(leagueId, playerId)` to μ `25`, σ `8.333` (create if missing).
2. `deleteMany` all `PlayerHeroRating` for `(leagueId, playerId)` (next match cold-starts heroes via existing `ensurePlayerRatings`).
3. Insert `PlayerRankReset` with `actorDiscordId`, `targetDiscordId` (linked id at reset time), `staffOverride`.
4. After commit: `refreshLeagueLeaderboard(client, leagueId)` (no-op when live board unbound).

Match history (`Match` / `MatchPlayer`) is **not** deleted.

## Commands

### `/rank_reset`

| Option | Type | Notes |
|--------|------|-------|
| `league` | string (autocomplete) | Optional; same resolve as `/rank` |
| `user` | user | Optional; omit = self; set ≠ self requires match mod role |

Auth / validation (command **and** Confirm button, re-checked at confirm time):

1. Guild only.
2. Resolve league; fail with existing league-resolve messages.
3. `rankResetEnabled` must be true.
4. Resolve target player via Discord link (`user` or actor). Unlinked → clear error.
5. If targeting another user → `assertHasMatchModRole` (same pattern as `/link` for others).
6. If target appears on any match in that league with status `PENDING` or `IN_PROGRESS` → reject.
7. If not staff override → enforce cooldown from latest audit row.

Then send ephemeral warning (overall + all hero ki wiped; irreversible) + Confirm / Cancel.

Button `customId` must bind `leagueId`, `playerId`, and `actorDiscordId` (and reject clicks from other users). On Confirm: re-run checks → apply transaction → success reply. On Cancel: dismiss / “Cancelled.”

### `/config set rank_reset`

| Option | Type | Notes |
|--------|------|-------|
| `enabled` | boolean | Required |
| `cooldown_days` | integer | Optional `1`–`365`; if omitted, leave existing days |
| `league` | existing option | Required resolve path like other league config |

Auth: `assertCanConfigureBot`.

### `/config set rank_reset_cooldown`

| Option | Type | Notes |
|--------|------|-------|
| `days` | integer | Required `1`–`365` |
| `league` | existing option | Same resolve |

Changes days without toggling enabled.

### `/config view`

Show e.g. `**Rank reset:** \`off\` · cooldown \`30d\`` or `\`on\` · cooldown \`30d\``.

## Services / module layout

| Unit | Responsibility |
|------|----------------|
| `src/services/rating/rank-reset.ts` | Eligibility checks, wipe transaction, audit insert |
| `src/services/league/*` (resolve helpers) | Read/write `rankResetEnabled` / `rankResetCooldownDays` on League; surface in `resolveLeagueConfig` |
| `src/commands/player/rank-reset.ts` | Slash adapter |
| `src/discord/interactions/*` | Confirm/Cancel button adapter calling the same use-case |
| `src/commands/config/config.ts` | set/view wiring |

Keep Discord I/O thin; all rules live in the rating use-case (shared-domain-logic).

## Error copy (English)

Examples (exact strings may be refined in implementation):

- Feature off: `Rank reset is disabled for this league.`
- Unlinked: `Link your Discord with /link before resetting your rank.` (staff targeting another: analogous)
- On active roster: `You can't reset rank while that player is in an active lobby or match.`
- Cooldown: `You can reset again <t:UNIX:R>.`
- Not mod: existing match-mod forbidden string.

## Testing

- Cooldown: eligible / blocked / staff bypass inserts audit and restarts clock for the player
- Feature flag off → reject at preview and at confirm
- PENDING / IN_PROGRESS roster membership → reject
- Wipe: rating defaults; hero rows deleted; audit row present
- Config: enable/disable; reject days outside 1–365; omit days keeps default/current
- Confirm after admin disables or player joins lobby → reject

## Docs

- Staff: `docs/discord/staff/a1-roles-and-setup.md` + `a5-admin-cheat-sheet.md`
- Public: short note in `docs/discord/public/06-rank-and-boards.md` that some leagues offer `/rank_reset` with a cooldown

## Migration / rollout

1. Prisma migration adding League columns + `PlayerRankReset`.
2. Deploy bot + commands (new slash command).
3. Leagues remain **off** until staff run `/config set rank_reset enabled:True` (optionally with `cooldown_days`).

## Deferred

- Slash command to list recent resets for mods
- Guild-level command registration hide when zero leagues enable the feature
- Partial resets (overall-only / hero-only)
