# Discord Lobby Fill (Identity) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let hosts seat linked Discord users without typing nicks, and let linked players claim a hero/slot on the PENDING embed — unless the guild turns player claim off.

**Architecture:** Reuse `addLobbyPlayer` / `removeLobbyPlayer`. Resolve Discord id → `Player.username` via existing `/link`. Player Claim/Leave checks `GuildConfig.lobbyPlayerClaimEnabled` (default true). Host `/lobby add user:` is not gated. Hero is slot: select labels include hero name when the catalog has it.

**Tech Stack:** Node.js + TypeScript ESM, discord.js v14, Vitest

**Spec:** [docs/superpowers/specs/2026-08-14-screenshotless-lobby-design.md](../specs/2026-08-14-screenshotless-lobby-design.md) — Phase 1b

**Depends on:** Phase 1 optional screenshot is nice-to-have but not required (empty PENDING already exists after OCR fail).

## Global Constraints

- English UI
- Create-role still required to **create** the match; claiming a slot is the **player**, host can still add/remove
- Player Claim/Leave is **guild-toggleable** (`lobbyPlayerClaimEnabled`, default on). Host `/lobby add user:` ignores that flag.
- Unlinked users get a clear “Ask a moderator to /link” (or self `/link` if first-time is allowed)
- Occupied slot: reject with who holds it (no silent overwrite)
- No new privileged intents
- Commits only when the user asks

## File structure

| File                                                 | Responsibility                                                  |
| ---------------------------------------------------- | --------------------------------------------------------------- |
| `prisma/schema.prisma`                               | `GuildConfig.lobbyPlayerClaimEnabled Boolean @default(true)`    |
| `src/services/guild-config.ts`                       | Resolve + `setLobbyPlayerClaimEnabled`                          |
| `src/commands/config/config.ts`                      | `/config set player_claim` + view line                          |
| `src/services/player-link.ts` or `player-profile.ts` | `findPlayerByDiscordId` (may already exist)                     |
| `src/services/lobby-identity.ts`                     | Discord id → nick                                               |
| `src/services/lobby-actions.ts`                      | `addLobbyPlayerFromDiscord`, `claimLobbySlot`, `leaveLobbySlot` |
| `src/commands/lobby/lobby.ts`                        | Optional `user` on `/lobby add`                                 |
| `src/services/lobby-preview.ts`                      | Claim/Leave only when flag on                                   |
| `src/handlers/lobby-interactions.ts`                 | `lobby:claim` / `lobby:leave`; reject if flag off               |

Discord allows 5 buttons × 5 rows = 25, so 12 claim buttons fit. Existing roster controls already use a row. Prefer a **second action row group**: keep current ✏️🔀🗑️➕, add claim rows only when `playerCount < 12`. If the message would exceed 5 rows, put claims on a follow-up message or a “Claim a slot” button that opens a select (12 options).

**Lock:** If Start + 4 roster + claim cannot fit, use **one “Claim slot” button → string select of empty slots** (≤25 options). That always fits. Prefer this if row math is tight. Omit Claim/Leave entirely when `playerClaimEnabled` is false.

---

### Task 1: Guild toggle (default on)

**Files:**

- Modify: `prisma/schema.prisma`
- Create: Prisma migration `guild_lobby_player_claim`
- Modify: `src/services/guild-config.ts`
- Modify: `src/services/guild-config.test.ts`
- Modify: `src/commands/config/config.ts`

**Interfaces:**

- Produces:
  - `ResolvedGuildConfig.lobbyPlayerClaimEnabled: boolean` (default `true` when row missing or field unused)
  - `setLobbyPlayerClaimEnabled(guildId: string, enabled: boolean): Promise<void>`

- [ ] **Step 1: Schema**

```prisma
model GuildConfig {
  // existing fields…
  lobbyPlayerClaimEnabled Boolean @default(true)
}
```

Migration must set existing rows to `true`.

- [ ] **Step 2: Tests**

```ts
it('defaults player claim to on when no guild row exists', async () => {
  findUnique.mockResolvedValue(null);
  const resolved = await resolveGuildConfig('guild-1');
  expect(resolved.lobbyPlayerClaimEnabled).toBe(true);
});

it('returns false when the guild disabled player claim', async () => {
  findUnique.mockResolvedValue({
    guildId: 'guild-1',
    matchCreateRoleId: null,
    matchModRoleId: null,
    leaderboardChannelId: null,
    leaderboardMessageId: null,
    lobbyPlayerClaimEnabled: false,
  });
  const resolved = await resolveGuildConfig('guild-1');
  expect(resolved.lobbyPlayerClaimEnabled).toBe(false);
});
```

Treat `null` (if the column is ever nullable) as `true`. Prefer a non-null boolean with `@default(true)`.

- [ ] **Step 3: Setter**

```ts
export async function setLobbyPlayerClaimEnabled(guildId: string, enabled: boolean): Promise<void> {
  await prisma.guildConfig.upsert({
    where: { guildId },
    create: { guildId, lobbyPlayerClaimEnabled: enabled },
    update: { lobbyPlayerClaimEnabled: enabled },
  });
}
```

- [ ] **Step 4: `/config`**

Add under `set`:

```ts
.addSubcommand((subcommand) =>
  subcommand
    .setName('player_claim')
    .setDescription('Allow linked players to claim a lobby slot')
    .addBooleanOption((option) =>
      option
        .setName('enabled')
        .setDescription('On: players can claim/leave slots. Off: host seats only.')
        .setRequired(true),
    ),
)
```

View line: `**Player claim:** \`on\``or`\`off\``.

Set reply: `Player slot claim enabled.` / `Player slot claim disabled. Hosts can still add players by nick or Discord user.`

Auth: existing `assertCanConfigureBot`.

- [ ] **Step 5: Run** `npx prisma migrate dev --name guild_lobby_player_claim` then `npx vitest run src/services/guild-config.test.ts`

---

### Task 2: Resolve Discord → nick

**Files:**

- Modify: `src/services/player-profile.ts` (export if needed)
- Create: `src/services/lobby-identity.ts`
- Create: `src/services/lobby-identity.test.ts`

**Interfaces:**

- `export async function nickForDiscordId(discordId: string): Promise<string>`
- Throws `MatchServiceError` / `PlayerServiceError`: `Your Discord is not linked to an in-game nick. Run /link or ask a moderator.`

- [ ] **Step 1: Tests** — linked returns normalized username; missing throws

- [ ] **Step 2: Implement** using `prisma.player.findUnique({ where: { discordId } })`

---

### Task 3: `/lobby add` optional user

**Files:**

- Modify: `src/commands/lobby/lobby.ts`

**Interfaces:**

- `nick` **or** `user` required (not both). Slot still required.

- [ ] **Step 1:** If both set → `Provide either a nick or a Discord user, not both.`
- [ ] **Step 2:** If `user` → `nickForDiscordId` then existing `addLobbyPlayer`
- [ ] **Step 3:** If unlinked → English error, no roster write

---

### Task 4: Claim use-case

**Files:**

- Modify: `src/services/lobby-actions.ts`
- Create tests for occupied-slot reject (pure `addPlayer` already throws? check)

If `addPlayer` already rejects occupied slots, wrap with identity resolve + `assertCanManageMatch` is **wrong** for claim — **any linked player** may claim an **empty** slot on a PENDING match. Host/mod may still remove them.

**Lock:** Claim is allowed for any guild member with a `/link` **and** `lobbyPlayerClaimEnabled`. Host can kick via 🗑️. Create-role is not required to claim. Host `/lobby add user:` does **not** check this flag.

- [ ] **Step 1:** `claimLobbySlot({ client, matchMessageId, discordId, guildId, slot })`
- [ ] **Step 2:** If `!(await resolveGuildConfig(guildId)).lobbyPlayerClaimEnabled` throw `MatchServiceError('Player slot claim is disabled on this server.')`
- [ ] **Step 3:** Match must be PENDING
- [ ] **Step 4:** Same discord already in another slot → **Reject** (“Leave first”)
- [ ] **Step 5:** `syncLobbyDiscordMessage`

Add a unit test: disabled flag → throw before roster mutate.

---

### Task 5: Claim UI

**Files:**

- Modify: `src/services/lobby-preview.ts` — `LOBBY_CUSTOM_IDS.claim = 'lobby:claim'`
- Modify: `src/handlers/lobby-interactions.ts`

**Lock:** One button “Claim slot” → select empty slots labeled `Slot N · {heroName}`. Host-only controls stay as they are. **Omit Claim and Leave when `playerClaimEnabled` is false.**

- [ ] **Step 1:** Select options from empty slots 1–12 with `getHeroDisplayName`
- [ ] **Step 2:** Ephemeral errors; public embed updates on success
- [ ] **Step 3:** Leave: `leaveLobbySlot({ discordId, guildId })` — same flag check as claim
- [ ] **Step 4:** `syncLobbyDiscordMessage` resolves guild config from the channel `guildId` so edited messages drop Claim/Leave after `/config set player_claim enabled:False` (next roster sync; stale buttons still hit the use-case error)

---

## Rollback

Set `/config set player_claim enabled:False` (no deploy needed). Or remove the user option and claim button. Manual nick add remains.

## Done when

- Host can `/lobby add user:@x slot:1` when x is linked, even if player claim is off.
- Linked player can claim an empty slot from the embed when the guild flag is on.
- When the flag is off: Claim/Leave hidden; claim/leave interactions error in English; no roster write.
- Unlinked claim/add-user fails in English without writing a ghost nick from a Discord tag.
- Occupied slots cannot be stolen by claim.
