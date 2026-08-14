### Task 5: Wire call sites to `resolveGuildConfig`

**Branch:** `dev`  
**Worktree:** `/home/lesk/www/bot/.worktrees/guild-config-roles`

**Done:**
- Updated `src/commands/lobby/register-lobby.ts` to require a guild context, resolve guild config via `resolveGuildConfig(interaction.guildId)`, and pass `config.matchCreateRoleId` into `assertCanCreateMatch` alongside `memberRoleIds(interaction)`.
- Extended `src/services/lobby-actions.ts` `resolveInProgressMatchByMessageId` to accept an optional `matchModRoleId` and forward it into `assertCanManageMatch`, so button-driven in‑progress actions also respect guild-config-managed moderator roles.
- Updated `src/handlers/match-interactions.ts` to import `resolveGuildConfig`, require a guild for both `resolveByMessage` and `resolveById`, and pass `config.matchModRoleId` through to `resolveInProgressMatchByMessageId` and `assertCanManageMatch`.
- Refactored `src/commands/match/match.ts` to drop direct `env` access and `canManageMatch`, import `resolveGuildConfig`, require a guild in `resolveMatchForCommand`, use `config.matchModRoleId` in `assertCanManageMatch`, and pass it through `hasMatchModeratorRole(interaction, config.matchModRoleId)`.

**Verification:**
- `npm test` (vitest): 7 test files, 46 tests, all passing with dummy Discord/DB/Gemini env.
- `ReadLints` on the four touched files: clean.
- `rg 'env\\.match(Mod|Create)RoleId' src`: no remaining direct env-based role checks in match auth paths.

**Commit:** `a50677e8b28037ec6ff7de9e4ca08f709bfb434a` — `Resolve guild role config at match auth call sites.` (4 files, +43/−18)

**Test run (post-commit):**
- Command: `npm test` with dummy Discord/DB/Gemini env
- Result: **PASS** — 8 test files, 59 tests, 0 failures (~1.0s)

**Concerns:**
- Auth for any future match-related entry points should also go through `resolveGuildConfig` to keep behavior consistent.
