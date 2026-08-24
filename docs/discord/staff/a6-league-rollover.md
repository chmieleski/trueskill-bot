🏁 **League season rollover** _(Manage Server)_

Archive a season and open a **successor**. Old league becomes read-only history.

**S1 → break → S2:** freeze S1 with `reset:continue` (e.g. `Season 1.5`). Later `reset:soft` from that break league — S2 uses **end of 1.5**, not frozen S1.

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
• Deferred **griefer season tax** hits the **archived ending board**
• Successor may **inherit** season end / crunch timestamps — clear if unwanted
• `continue` successors have **decay off** by default (see decay guide)

**Moves:** wc3stats maps, leaderboard/lobby channel, claim, rank-reset, host prompts, bindings, live board (reposted).
**Stays archived:** match history, per-player rank-reset cooldown history.

**After:** `/league list` shows Active / Archived. Live board reposts on confirm. Archived leagues cannot register lobbies, import, `/rank_reset`, correct matches, or `/leaderboard setup`.

**Player paste**

> **Continue:** **{old}** archived. Play continues in **{new}** with the same ki.
> **Soft/hard:** New season in **{new}**. Ki was {hard: reset ~1000 | soft: adjusted}. History stays via `/match list`.
