# WOS HTTP match ingest + mod approval — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Accept a raw WOS2 bot report over HTTP with a league API token, create a `WAITING_FOR_APPROVAL` match, post it for match-mod review, and complete or cancel ratings only after Approve / Reject.

**Architecture:** Same Node process as the Discord bot listens on `API_PORT` when `API_ENABLED=true`. A thin `src/api/` layer authenticates the bearer token and calls `ingestWosReportForApproval`. Discord approval buttons call shared use-cases in `match-approval.ts`. `completeMatch` is extended to lock `WAITING_FOR_APPROVAL` (no fake `IN_PROGRESS` hop). OpenTofu opens SG ingress + SSM env for the listen port.

**Tech Stack:** Node.js ESM (`node:http`), TypeScript, discord.js v14, Prisma/PostgreSQL, Vitest, OpenTofu/AWS SSM.

**Spec:** `docs/superpowers/specs/2026-09-07-api-wos-match-approval-design.md`

## Global Constraints

- Scope labels: ingest parser/roster/winner/stats = `game:warcraft3_wos` (reuse); HTTP, status, tokens, approval channel, Discord approval UI, approve/reject = `general`.
- User-facing strings and API error messages: English only.
- League tenancy: every match write keyed by `leagueId` from the API token; no cross-league.
- Events: not supported on this endpoint (league-only).
- No new npm HTTP framework (use `node:http`).
- ESM imports use `.js` extensions; named exports; Prisma singleton from `src/lib/prisma.ts`.
- Conventional Commits; run `npm run format:check` before PR.
- Work in worktree `/home/leski/www/bot/.worktrees/feat-api-wos-match-approval` on branch `feat/api-wos-match-approval`.

---

## File map

| File                                                                      | Responsibility                                                                                                                         |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `prisma/schema.prisma` + migration                                        | `WAITING_FOR_APPROVAL`, `Match.approvalWinnerTeam`, `League.matchApprovalChannelId`, `League.apiTokenHash`, `League.apiTokenCreatedAt` |
| `src/config/env.ts`                                                       | `apiEnabled`, `apiPort`, `apiBind`                                                                                                     |
| `.env.example`, `.cursor/rules/scripts-and-env.mdc`                       | Document new env vars                                                                                                                  |
| `infra/aws/variables.tf`, `ssm.tf`, `main.tf`, `terraform.tfvars.example` | SSM + SG ingress                                                                                                                       |
| `deploy/aws/refresh-env.sh`                                               | Write `API_*` into host `.env`                                                                                                         |
| `src/services/league/league-api-token.ts`                                 | Hash, create/rotate/revoke, resolve bearer → league                                                                                    |
| `src/services/league/league-api-token.test.ts`                            | Token unit tests                                                                                                                       |
| `src/services/league/league-match-approval-channel.ts`                    | Set/clear approval channel                                                                                                             |
| `src/commands/config/league-config.ts`                                    | Subcommands: approval channel + api_token                                                                                              |
| `src/commands/config/config-shared.ts`                                    | Show new settings in config view                                                                                                       |
| `src/services/match/match-waiting-approval.ts`                            | Create waiting match + ingest orchestration                                                                                            |
| `src/services/match/match-waiting-approval.test.ts`                       | Ingest unit tests                                                                                                                      |
| `src/services/match/match-approval.ts`                                    | setApprovalWinner, approve, reject; waiting-status edits                                                                               |
| `src/services/match/match-approval.test.ts`                               | Approve/reject tests                                                                                                                   |
| `src/services/match/match-report.ts`                                      | Allow complete/setQuitters/setGriefers from `WAITING_FOR_APPROVAL`                                                                     |
| `src/services/match/index.ts`                                             | Re-exports                                                                                                                             |
| `src/api/http-server.ts`                                                  | Listen / close                                                                                                                         |
| `src/api/auth.ts`                                                         | Bearer → league                                                                                                                        |
| `src/api/routes/wos-report.ts`                                            | `POST /v1/matches/wos-report`                                                                                                          |
| `src/api/index.ts`                                                        | `startApiServer` / `stopApiServer`                                                                                                     |
| `src/api/*.test.ts`                                                       | HTTP handler tests (mocked ingest)                                                                                                     |
| `src/discord/interactions/match-approval-interactions.ts`                 | Button/select adapters                                                                                                                 |
| `src/services/match/match-approval-preview.ts`                            | Embed + button builders (`match:ap:*`)                                                                                                 |
| `src/events/interaction-create.ts`                                        | Route `match:ap:`                                                                                                                      |
| `src/index.ts`                                                            | Start/stop HTTP with Discord client                                                                                                    |

---

### Task 1: Schema — waiting status, approval fields, league token + channel

**Files:**

- Modify: `prisma/schema.prisma`
- Create: migration via `npm run db:migrate`

**Interfaces:**

- Produces:

```prisma
enum MatchStatus {
  PENDING
  IN_PROGRESS
  WAITING_FOR_APPROVAL
  COMPLETED
  CANCELLED
}

// on Match:
approvalWinnerTeam Int? // 1 | 2

// on League:
matchApprovalChannelId String?
apiTokenHash           String?
apiTokenCreatedAt      DateTime?
```

- [ ] **Step 1: Edit schema**

Add `WAITING_FOR_APPROVAL` to `MatchStatus` (after `IN_PROGRESS`).

On `Match`, after `isManualSanction`:

```prisma
  /// Proposed/selected winning team while WAITING_FOR_APPROVAL (1 or 2).
  approvalWinnerTeam Int?
```

On `League`, after `lobbyChannelId`:

```prisma
  matchApprovalChannelId String?
  apiTokenHash           String?
  apiTokenCreatedAt      DateTime?
```

- [ ] **Step 2: Migrate**

Run from worktree (with local DB up if needed):

```bash
npm install
npm run db:migrate -- --name add_waiting_for_approval_and_league_api
```

Expected: migration adds enum value + columns; `prisma generate` succeeds.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`  
Expected: PASS (or only pre-existing unrelated errors — fix if this migration broke generated client usage).

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "$(cat <<'EOF'
feat(db): add WAITING_FOR_APPROVAL and league API token fields

EOF
)"
```

---

### Task 2: Env + OpenTofu + refresh-env

**Files:**

- Modify: `src/config/env.ts`
- Modify: `.env.example`
- Modify: `.cursor/rules/scripts-and-env.mdc`
- Modify: `infra/aws/variables.tf`, `infra/aws/ssm.tf`, `infra/aws/main.tf`, `infra/aws/terraform.tfvars.example`
- Modify: `deploy/aws/refresh-env.sh`

**Interfaces:**

- Produces on `env`:

```typescript
apiEnabled: boolean; // parseBoolean(process.env.API_ENABLED, false)
apiPort: number; // Number.parseInt(process.env.API_PORT ?? '8787', 10) || 8787
apiBind: string; // process.env.API_BIND?.trim() || '0.0.0.0'
```

- [ ] **Step 1: Extend `env.ts`**

Add the three fields to `EnvConfig` and `env` export using the patterns above.

- [ ] **Step 2: Document**

Add to `.env.example`:

```bash
# HTTP API (WOS match ingest). Off by default.
API_ENABLED=false
API_PORT=8787
API_BIND=0.0.0.0
```

Add the same three rows to `.cursor/rules/scripts-and-env.mdc` env table.

- [ ] **Step 3: OpenTofu variables + SSM**

In `variables.tf`:

```hcl
variable "api_enabled" {
  description = "API_ENABLED — start HTTP listener in the bot process"
  type        = string
  default     = "false"
}

variable "api_port" {
  description = "API_PORT listen port"
  type        = string
  default     = "8787"
}

variable "api_bind" {
  description = "API_BIND address"
  type        = string
  default     = "0.0.0.0"
}

variable "enable_api_ingress" {
  description = "Open security-group ingress for API_PORT"
  type        = bool
  default     = false
}

variable "api_ingress_cidr" {
  description = "CIDR allowed to reach API_PORT when enable_api_ingress is true"
  type        = string
  default     = "127.0.0.1/32"
}
```

In `ssm.tf`, add String parameters for `API_ENABLED`, `API_PORT`, `API_BIND` under `local.ssm_prefix` (same style as `wc3stats_timeout_ms`).

In `main.tf` `aws_security_group.bot`, add a second dynamic ingress:

```hcl
  dynamic "ingress" {
    for_each = var.enable_api_ingress ? [1] : []
    content {
      description = "Bot HTTP API"
      from_port   = tonumber(var.api_port)
      to_port     = tonumber(var.api_port)
      protocol    = "tcp"
      cidr_blocks = [var.api_ingress_cidr]
    }
  }
```

Update `terraform.tfvars.example` with commented examples for the new vars.

- [ ] **Step 4: `refresh-env.sh`**

Add explicit echoes (and add keys to the `known` guard list):

```bash
echo "API_ENABLED=${PARAMS[API_ENABLED]:-false}"
echo "API_PORT=${PARAMS[API_PORT]:-8787}"
echo "API_BIND=${PARAMS[API_BIND]:-0.0.0.0}"
```

- [ ] **Step 5: Commit**

```bash
git add src/config/env.ts .env.example .cursor/rules/scripts-and-env.mdc \
  infra/aws/variables.tf infra/aws/ssm.tf infra/aws/main.tf infra/aws/terraform.tfvars.example \
  deploy/aws/refresh-env.sh
git commit -m "$(cat <<'EOF'
chore(infra): wire API_ENABLED port bind and SG ingress

EOF
)"
```

---

### Task 3: League API token service + `/league_config` token commands

**Files:**

- Create: `src/services/league/league-api-token.ts`
- Create: `src/services/league/league-api-token.test.ts`
- Modify: `src/services/league/index.ts` (re-export)
- Modify: `src/commands/config/league-config.ts`
- Modify: `src/commands/config/config-shared.ts` (token present / not present line; never show hash)

**Interfaces:**

```typescript
export function hashLeagueApiToken(plaintext: string): string;
// crypto.createHash('sha256').update(plaintext, 'utf8').digest('hex')

export async function createOrRotateLeagueApiToken(leagueId: string): Promise<{
  plaintext: string;
  createdAt: Date;
}>;
// randomBytes(32).toString('base64url'); store hash + now; return plaintext once

export async function revokeLeagueApiToken(leagueId: string): Promise<void>;
// set apiTokenHash=null, apiTokenCreatedAt=null

export async function resolveLeagueFromApiToken(plaintext: string): Promise<{
  leagueId: string;
  guildId: string;
  gameId: string;
  matchApprovalChannelId: string | undefined;
  status: 'ACTIVE' | 'ARCHIVED';
} | null>;
// findFirst where apiTokenHash = hash(plaintext); return null if missing
```

- [ ] **Step 1: Failing tests**

In `league-api-token.test.ts`, mock `prisma.league`:

1. `hashLeagueApiToken` is stable and hex length 64.
2. `createOrRotateLeagueApiToken` updates hash and returns plaintext ≠ hash.
3. `resolveLeagueFromApiToken` returns league for matching plaintext and `null` for wrong token.
4. `revokeLeagueApiToken` clears hash; resolve then returns null.

- [ ] **Step 2: Run tests — expect FAIL**

Run: `npx vitest run src/services/league/league-api-token.test.ts`  
Expected: FAIL (module missing).

- [ ] **Step 3: Implement `league-api-token.ts`**

Use `node:crypto`. Reject empty plaintext on resolve. Use `prisma.league.update` / `findFirst`.

- [ ] **Step 4: Run tests — expect PASS**

Run: `npx vitest run src/services/league/league-api-token.test.ts`  
Expected: PASS

- [ ] **Step 5: Slash commands**

Add to `league-config.ts` (same Manage Guild / league option pattern as `lobby_channel`):

- Subcommand `api_token` with option `action`: choices `rotate` | `revoke`
  - `rotate` → ephemeral reply with plaintext + warning it is shown once
  - `revoke` → confirm revoked
- Subcommand `match_approval_channel`:
  - Option `channel` (Channel, GuildText | GuildAnnouncement) to set
  - Option `clear` (boolean) — when true, sets `matchApprovalChannelId` to null (ignore channel)

Implement channel setter in `league-match-approval-channel.ts`:

```typescript
export async function setLeagueMatchApprovalChannel(
  leagueId: string,
  channelId: string | null,
): Promise<void>;
```

Show in `config-shared` view:

- `Match approval channel: #name | (not set)`
- `API token: set (rotated <relative>) | (not set)` — never print hash

- [ ] **Step 6: Commit**

```bash
git add src/services/league/league-api-token.ts src/services/league/league-api-token.test.ts \
  src/services/league/league-match-approval-channel.ts src/services/league/index.ts \
  src/commands/config/league-config.ts src/commands/config/config-shared.ts
git commit -m "$(cat <<'EOF'
feat(league): add API token and match approval channel config

EOF
)"
```

---

### Task 4: Create waiting match + ingest use-case

**Files:**

- Create: `src/services/match/match-waiting-approval.ts`
- Create: `src/services/match/match-waiting-approval.test.ts`
- Modify: `src/services/match/index.ts`
- Possibly small helper in `match-service.ts` if roster createMany logic must be reused — prefer calling existing internal patterns via new `createWaitingApprovalMatch` colocated in `match-waiting-approval.ts` that mirrors `createPendingMatch` player createMany + match create, but `status: 'WAITING_FOR_APPROVAL'`.

**Interfaces:**

```typescript
export type IngestWosReportForApprovalInput = {
  leagueId: string;
  guildId: string;
  gameId: string;
  matchApprovalChannelId: string;
  hostDiscordId: string; // bot user id / clientId
  reportText: string;
};

export type IngestWosReportForApprovalResult = {
  matchId: string;
  status: 'WAITING_FOR_APPROVAL';
  externalId: string;
  suggestedWinner: 1 | 2 | null;
  /** Set by caller after Discord post, or null if post skipped/failed */
  discordMessageUrl: string | null;
};

export async function ingestWosReportForApproval(
  input: IngestWosReportForApprovalInput,
): Promise<IngestWosReportForApprovalResult>;
```

**Behavior (must match spec):**

1. `isLeagueWritable` — else `MatchServiceError(LEAGUE_ARCHIVED_MESSAGE)`.
2. `getGameProfileForLeague` — require `postMatchStats === 'wos2_bot_v1'`.
3. Require `matchApprovalChannelId` non-empty (caller may pass resolved channel; also double-check).
4. `parseWos2BotReport` / `lobbyPlayersFromWos2Report` — map parse/roster errors to `MatchServiceError`.
5. `inferSuggestedWinner(report)` → `approvalWinnerTeam`.
6. Create match: `status: 'WAITING_FOR_APPROVAL'`, `leagueId`, `hostDiscordId`, `discordChannelId: matchApprovalChannelId`, `discordMessageId: null`, `approvalWinnerTeam`, players with teams/slots from profile; set `isQuitter: true` when the corresponding report player has `left === true` (match by normalized nick after roster resolve).
7. `persistWos2MatchStats({ matchId, actorDiscordId: hostDiscordId, rawText, report, matchPlayers })` — this helper does **not** gate on `IN_PROGRESS` (unlike `uploadMatchStatsReport`). Duplicate `externalId` becomes `MatchServiceError` (HTTP layer maps to 409).
8. Return result **without** posting Discord (post is Task 7). Export:

```typescript
export async function attachApprovalDiscordMessage(
  matchId: string,
  discordMessageId: string,
): Promise<void>;
```

- [ ] **Step 1: Failing tests**

Mock prisma + `persistWos2MatchStats` + profile:

1. Happy path creates waiting match and returns `externalId` + suggested winner.
2. Prefills quitter when report player `left: true`.
3. Non-WOS profile → error.
4. Empty approval channel → error.
5. `persistWos2MatchStats` throwing duplicate-report `MatchServiceError` propagates.

Use a minimal valid WOS report fixture from `wos2-bot-report-parser.test.ts` / roster tests.

- [ ] **Step 2: Run — expect FAIL**

`npx vitest run src/services/match/match-waiting-approval.test.ts`

- [ ] **Step 3: Implement**

Reuse player nick normalization / createMany approach from `createPendingMatch` (read that function and copy the minimum needed; do **not** call `createPendingMatch` then flip status).

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add src/services/match/match-waiting-approval.ts src/services/match/match-waiting-approval.test.ts src/services/match/index.ts
git commit -m "$(cat <<'EOF'
feat(match): ingest WOS report into WAITING_FOR_APPROVAL

EOF
)"
```

---

### Task 5: Approval use-cases + extend `completeMatch` / flag editors

**Files:**

- Create: `src/services/match/match-approval.ts`
- Create: `src/services/match/match-approval.test.ts`
- Modify: `src/services/match/match-report.ts` (`lockInProgressMatch` / `requireInProgress` / `setQuitters` / `setGriefers`)
- Modify: `src/services/match/index.ts`

**Interfaces:**

```typescript
export async function setApprovalWinner(
  matchId: string,
  winningTeam: 1 | 2,
): Promise<MatchWithPlayers>;

export async function approveWaitingMatch(matchId: string): Promise<CompleteMatchResult>;
// reads approvalWinnerTeam + current quitter/griefer flags; calls completeMatch(...)

export async function rejectWaitingMatch(matchId: string): Promise<MatchWithPlayers>;
// lock WAITING_FOR_APPROVAL → CANCELLED; no rating writes; no quitter penalties
```

**`match-report.ts` changes:**

- Rename conceptually to “lock for report actions”: allow status `IN_PROGRESS` **or** `WAITING_FOR_APPROVAL` for `setQuitters`, `setGriefers`, and `completeMatch`.
- SQL `FOR UPDATE` clause: `status IN ('IN_PROGRESS', 'WAITING_FOR_APPROVAL')`.
- Error copy when wrong status: keep “This match is not in progress.” for pure in-progress-only flows if any remain; for shared lock use: `This match is not awaiting approval or in progress.` where both are valid — prefer one clear English string used by the shared lock helper.
- `completeMatch` must work when status was `WAITING_FOR_APPROVAL` (same rating path).

**`approveWaitingMatch`:**

1. Load match; must be `WAITING_FOR_APPROVAL`.
2. If `approvalWinnerTeam` not 1|2 → `MatchServiceError('Set a winning team before approving this match.')`.
3. Collect quitter/griefer slots from current flags.
4. `return completeMatch(matchId, approvalWinnerTeam, quitterSlots, grieferSlots)`.

**`rejectWaitingMatch`:**

1. Transaction lock where status = `WAITING_FOR_APPROVAL`.
2. Update `status: 'CANCELLED'` (no player result writes required beyond leaving null).
3. Return refreshed match.

- [ ] **Step 1: Failing tests**

1. `setApprovalWinner` persists team.
2. `approveWaitingMatch` without winner throws.
3. `approveWaitingMatch` with winner calls through to complete — mock `completeMatch` via `vi.mock('./match-report.js')` and assert it was called with `(matchId, winningTeam, quitterSlots, grieferSlots)`.
4. `rejectWaitingMatch` → `CANCELLED`.
5. `setQuitters` on waiting match succeeds (new test in `match-approval.test.ts` or `match-report` tests with status `WAITING_FOR_APPROVAL`).

- [ ] **Step 2–4: Implement until PASS**

- [ ] **Step 5: Commit**

```bash
git add src/services/match/match-approval.ts src/services/match/match-approval.test.ts \
  src/services/match/match-report.ts src/services/match/index.ts
git commit -m "$(cat <<'EOF'
feat(match): approve or reject WAITING_FOR_APPROVAL matches

EOF
)"
```

---

### Task 6: HTTP server + `POST /v1/matches/wos-report`

**Files:**

- Create: `src/api/http-server.ts`
- Create: `src/api/auth.ts`
- Create: `src/api/routes/wos-report.ts`
- Create: `src/api/index.ts`
- Create: `src/api/wos-report.route.test.ts`
- Modify: `src/index.ts` (start/stop — full Discord post wiring can land in Task 7 if needed; here start server with injectable `onWosReport` / Discord poster callback)

**Interfaces:**

```typescript
export type ApiServerDeps = {
  ingest: typeof ingestWosReportForApproval;
  resolveToken: typeof resolveLeagueFromApiToken;
  postApprovalMessage: (input: {
    guildId: string;
    channelId: string;
    matchId: string;
  }) => Promise<{ messageId: string; messageUrl: string } | null>;
  hostDiscordId: string;
};

export function startApiServer(deps: ApiServerDeps): Promise<import('node:http').Server>;
export function stopApiServer(server: import('node:http').Server | undefined): Promise<void>;
```

**Route behavior:**

- Only `POST /v1/matches/wos-report` in v1 (404 else).
- Auth: `Authorization: Bearer <token>` → `resolveLeagueFromApiToken`; null → 401 JSON `{ "error": "Unauthorized" }`.
- Archived league / non-WOS / missing channel / parse errors → 400 `{ "error": "<english>" }` from `MatchServiceError.message`.
- Duplicate report message containing `already uploaded` → 409.
- Body must be JSON with string `reportText`.
- On success: call `postApprovalMessage`; if it returns null, still 201 with `discordMessageUrl: null` and update nothing (or leave message id null). If it returns ids, `prisma.match.update` message id.
- 201 body per spec.

Use `node:http`; read body with size limit (e.g. 1 MiB) — reject larger with 400.

- [ ] **Step 1: Failing route tests**

Export `handleApiRequest(req, res, deps)` and unit-test that function (do not bind a real port in CI):

1. Missing auth → 401
2. Valid token + ingest success → 201 shape
3. `MatchServiceError` duplicate → 409
4. Bad JSON → 400

- [ ] **Step 2–4: Implement until PASS**

- [ ] **Step 5: Wire `src/index.ts`**

Find where `startMatchCleanupScheduler` / other schedulers start (typically on Discord `ClientReady`). Start the API in the **same** place so `client.user.id` is available:

```typescript
let apiServer: Server | undefined;
if (env.apiEnabled) {
  apiServer = await startApiServer({
    ingest: ingestWosReportForApproval,
    resolveToken: resolveLeagueFromApiToken,
    hostDiscordId: client.user!.id,
    postApprovalMessage: async () => null, // replaced in Task 7
  });
}
```

In `shutdown`, `await stopApiServer(apiServer)`.

- [ ] **Step 6: Commit**

```bash
git add src/api src/index.ts
git commit -m "$(cat <<'EOF'
feat(api): add POST /v1/matches/wos-report HTTP ingest

EOF
)"
```

---

### Task 7: Discord approval embed, buttons, interactions

**Files:**

- Create: `src/services/match/match-approval-preview.ts` (embed + buttons)
- Create: `src/discord/interactions/match-approval-interactions.ts`
- Modify: `src/events/interaction-create.ts`
- Modify: `src/api/index.ts` / `src/index.ts` — real `postApprovalMessage` using discord.js
- Optional tests for customId builders / auth deny

**customId prefix:** `match:ap:` (routed before or inside match interactions — prefer dedicated handler called from `interaction-create` when `customId.startsWith('match:ap:')`).

| customId                          | Action                                                                      |
| --------------------------------- | --------------------------------------------------------------------------- |
| `match:ap:quitters:<matchId>`     | Open quitter select (reuse select patterns from report wizard if practical) |
| `match:ap:griefers:<matchId>`     | Griefer select                                                              |
| `match:ap:winner:<matchId>`       | Winner buttons / select team 1\|2                                           |
| `match:ap:win:<matchId>:1` / `:2` | `setApprovalWinner`                                                         |
| `match:ap:approve:<matchId>`      | `approveWaitingMatch` + refresh embed terminal                              |
| `match:ap:reject:<matchId>`       | `rejectWaitingMatch` + refresh                                              |

**Auth:** `assertHasMatchModRole` with `resolveGuildConfig(guildId).matchModRoleId` (not host). Ephemeral deny on failure.

**Embed:** teams, nicks, quitters/griefers markers, winner (selected or “not set”), `externalId` from stats report if loaded, match id.

**`postApprovalMessage`:** fetch channel by `matchApprovalChannelId`, send embed+buttons, return message id + URL `https://discord.com/channels/{guildId}/{channelId}/{messageId}`.

On approve/reject success, edit message to completed/cancelled view **without** action buttons (mirror completed match embed style lightly — reuse pieces from lobby/match embeds where possible without a large refactor).

- [ ] **Step 1: Implement preview builders + interaction handler**

- [ ] **Step 2: Wire `interaction-create.ts`**

```typescript
if (await handleMatchApprovalInteraction(interaction)) return;
```

(before or after `handleMatchInteraction` — approval prefix must not be swallowed incorrectly).

- [ ] **Step 3: Connect API poster to Discord client**

- [ ] **Step 4: Manual sanity (optional)** — skip in CI; ensure unit tests for mod deny if added.

- [ ] **Step 5: Commit**

```bash
git add src/services/match/match-approval-preview.ts \
  src/discord/interactions/match-approval-interactions.ts \
  src/events/interaction-create.ts src/api src/index.ts
git commit -m "$(cat <<'EOF'
feat(discord): add match approval channel UI for API ingest

EOF
)"
```

---

### Task 8: Format, typecheck, full test pass

**Files:** any touched by Prettier

- [ ] **Step 1: Format**

```bash
npm run format
npm run format:check
```

Expected: PASS

- [ ] **Step 2: Typecheck + tests**

```bash
npm run typecheck
npm test
```

Expected: PASS (fix any regressions from status enum exhaustiveness — search for `MatchStatus` switches / `satisfies` / if-chains that need `WAITING_FOR_APPROVAL`).

- [ ] **Step 3: Fix exhaustiveness gaps**

Grep for `IN_PROGRESS` / `COMPLETED` / `CANCELLED` status switches in match cleanup, list filters, history — ensure waiting matches:

- Appear in approval channel only (not as joinable lobbies)
- Are not started via lobby buttons
- Are excluded from “active lobby” host caps if those query `PENDING`/`IN_PROGRESS` only (verify; waiting should **not** count as a host lobby)

- [ ] **Step 4: Final commit if needed**

```bash
git add -A
git commit -m "$(cat <<'EOF'
chore: format and fix WAITING_FOR_APPROVAL exhaustiveness

EOF
)"
```

---

## Spec coverage checklist

| Spec requirement                                                    | Task |
| ------------------------------------------------------------------- | ---- |
| `WAITING_FOR_APPROVAL` status                                       | 1    |
| League approval channel + API token hash                            | 1, 3 |
| Env + tofu SG/SSM/refresh-env                                       | 2    |
| Raw WOS report ingest, nick players, left→quitter, suggested winner | 4    |
| Duplicate `externalId` → 409                                        | 4, 6 |
| Approve → ratings / Reject → cancel                                 | 5    |
| `completeMatch` without IN_PROGRESS hop                             | 5    |
| HTTP `POST /v1/matches/wos-report` + bearer                         | 6    |
| Discord embed + mod edit/approve/reject                             | 7    |
| Same process as bot                                                 | 6    |
| English errors, WOS-only, league token targeting                    | 3–6  |

## Plan self-review notes

- No separate `MatchSubmission` table (per spec).
- Reject does **not** apply quitter penalties (unlike `cancelInProgressMatch`).
- Default API off (`API_ENABLED=false`); SG ingress off until `enable_api_ingress=true`.
- `API_BIND` default `0.0.0.0` per locked design; exposure via CIDR.
