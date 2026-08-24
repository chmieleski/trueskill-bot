⏳ **Rating decay & season crunch** _(Manage Server)_

Keeps boards honest when players go idle. **Overall ki only** — hero ratings unchanged. This is **live**. Defaults match a fresh league. Override with `/decay_config …`.

**Mid-season** (default: on for new leagues)

• **10 days** after last **finished** non-quit game → decay starts
• Days 11–19: **−50 ki/day** · Day 20+: **−100 ki/day**
• Max **−1000 ki** per idle streak, then stops until they play again
• Joining a lobby does **not** reset the timer
• Calibrating & New players are exempt

**Season crunch** (last ~7 days by default)

`/league set season_end` · `/league crunch start|clear`

Crunch: **2-day** grace, then **−100** / **−200 ki/day**. **No streak cap** — floor ~1000 ki.

**Prize lock:** 🥇🥈🥉 need at least **N** finished non-quit games in the **crunch window** (default **N = 1**). Rank `#n` stays. Off: `/decay_config prize_lock enabled:false`.

`/decay_config prize_lock_min_games games:7` · `clear_prize_lock_min_games` · `preset name:strict_crunch`

**`strict_crunch`:** grace **3**, flat **−100/−100 ki/day**, window **7**, min games **7**.

**Toggle:** `/league_config set decay enabled:true|false`

**Tune (optional):** `/decay_config grace` / `tier1_ki` / `streak_cap` / `crunch_window` (`clear_*` resets defaults). `/config view` shows rates + crunch.

**Rollover:** `reset:continue` copies overrides; decay **off** until re-enabled.

**Player paste**

> Inactive players lose ki after **10 days** without a finished game (defaults — your league may differ). During **crunch**, decay is faster; medals need enough finished games (default ≥ **1**; some leagues require more).
