### Task 5: Embeds + in-progress buttons

**Branch:** `feature/match-report`  
**Worktree:** `/home/lesk/www/bot/.worktrees/match-report`

**Done:**
- Added match report custom IDs and the `buildMatchReportButtons()` action row.
- Added `buildMatchCompletedEmbed()` with winner-aware color, roster fields, and quitter markers.
- Propagated `isQuitter` through rating preview lines and appended `🚪` in roster output.
- Updated lobby sync to render report buttons for `started` mode and the completed embed for `completed` mode.

**Verification:**
- `npm test`
- `npx tsc --noEmit`
- `ReadLints` on touched service files: clean

**Commit:** `246df8e` `Implement match report use-cases`

**Concerns:**
- None for this task. Interaction handlers will be added in Task 6.
