# wc3stats Host Lobby Prompt — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-league optional wc3stats host lobby prompts (poll gamelist → ping linked host → Open/Dismiss), plus a global player setting to disable those pings.

**Architecture:** League config gates the feature; poller on ClientReady; shared `createMatchFromWc3statsLobby` for Open; Player flag filters who may be pinged; `/settings` for user preference.

**Tech Stack:** TypeScript ESM, Prisma, discord.js v14, Vitest

**Spec:** `docs/superpowers/specs/2026-08-15-wc3stats-host-lobby-prompt-design.md`

**Scope:** `general`

## Global Constraints

- English-only UI
- No ephemeral without an interaction
- Reuse create-role + import rules from `/register_lobby` (do not fork)
- Player preference is **global** (Player tenancy), default **true**
- ESM `.js` imports; named exports
- No new production env / SSM keys

## File map

| File | Role |
|------|------|
| `prisma/schema.prisma` | League prompt fields + `Player.wc3statsHostPromptPingsEnabled` |
| `prisma/migrations/20260815173000_league_wc3stats_host_prompt/` | League migration (done) |
| `prisma/migrations/…_player_host_prompt_pings/` | Player preference migration |
| `src/services/league/league-wc3stats.ts` | Resolve/set/clear + `isLeagueWc3statsHostPromptReady` |
| `src/services/wc3stats/wc3stats-host-prompt.ts` | Custom ids, message builders, map+host filter |
| `src/services/wc3stats/wc3stats-host-prompt-poller.ts` | Scheduler + tick |
| `src/services/lobby/create-from-wc3stats.ts` | Shared Open create path |
| `src/discord/interactions/wc3stats-host-prompt-interactions.ts` | Button adapter |
| `src/commands/config/config.ts` | League set/clear/view |
| `src/services/player/player-settings.ts` | Get/set ping preference |
| `src/commands/player/settings.ts` | `/settings view` + `/settings set host_prompt_pings` |
| `src/events/ready.ts` / `src/index.ts` / `interaction-create.ts` | Wire scheduler + buttons |

---

### Task 1: League feature (done on branch)

- [x] Schema + migration for League fields
- [x] Config set/clear/view + readiness
- [x] Poller, buttons, create-from-wc3stats, tests

---

### Task 2: Player ping preference (schema + service)

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260815180000_player_wc3stats_host_prompt_pings/migration.sql`
- Create: `src/services/player/player-settings.ts`
- Create: `src/services/player/player-settings.test.ts`
- Modify: `src/services/player/index.ts`

**Interfaces:**
- `Player.wc3statsHostPromptPingsEnabled Boolean @default(true)`
- `getPlayerHostPromptPingsEnabled(discordId): Promise<boolean | null>` — `null` if no linked player
- `setPlayerHostPromptPingsEnabled(discordId, enabled): Promise<{ username: string; enabled: boolean }>` — throws `PlayerServiceError` if not linked

- [x] **Step 1: Failing tests for set/get when linked / unlinked**

- [x] **Step 2: Migration + implement service**

- [x] **Step 3: Run tests — expect pass**

---

### Task 3: Poller respects opt-out

**Files:**
- Modify: `src/services/wc3stats/wc3stats-host-prompt-poller.ts`
- Modify: `src/services/wc3stats/wc3stats-host-prompt-poller.test.ts`

- [x] **Step 1: `loadLinkedPlayersByNick` only includes `wc3statsHostPromptPingsEnabled: true`**

- [x] **Step 2: Unit test that opted-out nicks are omitted from the map**

---

### Task 4: `/settings` slash command

**Files:**
- Create: `src/commands/player/settings.ts`
- Modify: public Discord docs briefly (`docs/discord/public/02-link-your-nick.md` or cheat sheet)

- [x] **Step 1: `/settings view` — ephemeral preference + link status**

- [x] **Step 2: `/settings set host_prompt_pings enabled:` — self only**

- [x] **Step 3: Commands auto-load from `commands/`; no register list change**

---

### Task 5: Spec/plan docs + PR update

- [x] Commit design + plan + implementation
- [x] Push and update PR description

## Verification

```bash
export DISCORD_TOKEN=ci CLIENT_ID=0 GUILD_ID=0 \
  DATABASE_URL='postgresql://ci:ci@127.0.0.1:5432/ci' \
  DIRECT_URL='postgresql://ci:ci@127.0.0.1:5432/ci' \
  GEMINI_API_KEY=ci
npx prisma generate && npm test && npx tsc --noEmit
```
