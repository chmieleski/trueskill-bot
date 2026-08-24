⏳ **Rating decay & season crunch** _(Manage Server)_

Keeps boards honest when players go idle. **Overall ki only** — hero ratings unchanged. This is **live**.

Defaults match a fresh league. Override per league with `/decay_config …`.

---

**Mid-season** (default: on for new leagues)

• **10 days** after last **finished** non-quit game → decay starts
• Days 11–19: **−50 ki/day** · Day 20+: **−100 ki/day**
• Max **−1000 ki** per idle streak, then stops until they play again
• Joining a lobby does **not** reset the timer
• Calibrating & New players are exempt

---

**Season crunch** (last ~7 days by default)

```
/league set season_end date:2026-03-31 league:YourLeague
/league crunch start league:YourLeague
/league crunch clear league:YourLeague
```

Crunch: **2-day** grace, then **−100** / **−200 ki/day**. **No streak cap** — floor ~1000 ki.

**Prize lock:** 🥇🥈🥉 need at least **N** finished non-quit games in the **crunch window** (default **N = 1**). Rank `#n` stays. Off: `/decay_config prize_lock enabled:false`.

```
/decay_config prize_lock_min_games games:7 league:YourLeague
/decay_config clear_prize_lock_min_games
/decay_config preset name:strict_crunch league:YourLeague
```

**`strict_crunch`:** grace **3**, flat **−100/−100 ki/day**, window **7**, min games **7**.

---

**Toggle**

```
/league_config set decay enabled:true league:YourLeague
/league_config set decay enabled:false league:YourLeague
```

**Tune rates** (optional)

```
/decay_config grace mode:mid days:14 league:YourLeague
/decay_config tier1_ki mode:mid ki:40
/decay_config streak_cap ki:1500
/decay_config crunch_window days:10
/decay_config prize_lock enabled:true
/decay_config clear_grace mode:mid
```

`/config view` shows effective rates, season end, and crunch. **Rollover:** `reset:continue` copies overrides; decay **off** until re-enabled with `/league_config set decay enabled:true`.

---

**Player paste**

> Inactive players lose ki after **10 days** without a finished game (defaults — your league may differ). During **crunch**, decay is faster; medals need enough finished games (default ≥ **1**; some leagues require more).
