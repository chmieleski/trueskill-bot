🏁 **League season rollover** _(Manage Server or match mod role)_

Archive a season and open a **successor**. Old league becomes read-only history.

**Before**
• Finish/cancel every active lobby or match in that league
• Pick a name and `continue` / `soft` / `hard`
• Bindings move to the new league automatically

```
/league rollover name:Season 1.5 reset:continue
/league rollover name:UDBR Season 2 reset:soft compression:0.5
/league rollover name:Fresh Start reset:hard league:YourLeague
```

• `compression` — soft only, `0`–`1`, default `0.5` (higher = stronger pull to average)
• `league` — when more than one **active** league
• Confirm / Cancel — only you can press

**Modes**
• **Continue** — copy overall + hero ki exactly; no Calibrating reset
• **Hard** — everyone ~**1000 ki**; heroes rebuild; Calibrating until 5 games
• **Soft** — compress toward old averages; σ up; hero Calibrating resets

**Also on rollover**
• Deferred **griefer / quitter / DC season tax** hits the **archived ending board** only — `continue` / `soft` successors start from pre-tax ki
• Successor may **inherit** season end / crunch timestamps — clear if unwanted
• `continue` successors have **decay off** by default (see decay guide)

**No rollover:** once `/league set season_end` passes, the league **soft-pauses** (no new ranked lobbies; decay off). Clear/extend season end to resume.

**Moves:** wc3stats maps, channels, claim, rank-reset, host prompts, bindings, live board.
**Stays archived:** match history, rank-reset cooldown history.

**After:** `/league list` shows Active / Archived. Live board reposts on confirm. Archived leagues cannot register lobbies, import, `/rank_reset`, correct matches, or `/leaderboard setup`.

**Player paste**

> **Continue:** **{old}** archived. Play continues in **{new}** with the same ki.
> **Soft/hard:** New season in **{new}**. Ki was {hard: reset ~1000 | soft: adjusted}. History stays via `/match list`.
