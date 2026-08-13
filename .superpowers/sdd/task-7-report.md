### Task 7: Slash `/match` mirrors

**Branch:** `feature/match-report`  
**Worktree:** `/home/lesk/www/bot/.worktrees/match-report`

**Done:**
- Added `src/commands/match/match.ts` with `/match quitters`, `/match complete`, and `/match cancel` subcommands.
- Resolved matches by explicit `match_id` first, otherwise by the host’s sole in-progress match, with moderator role handling via `MATCH_MOD_ROLE_ID`.
- Synced the lobby Discord message after each mutation using `interaction.client`.
- Added a focused test for quitter-slot parsing and command registration shape.

**Verification:**
- `npm test`
- `npm run build`
- `ReadLints` on the new command files: clean

**Concerns:**
- I did not manually confirm the guild command propagation here, but the command is included in slash-command loading and build checks passed.
