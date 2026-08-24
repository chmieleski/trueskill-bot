⏳ **Rating decay & season crunch** _(Manage Server)_

Keeps boards honest when players go idle. **Overall ki only** — hero ratings unchanged. This is **live**.

Defaults match a fresh league. Override per league with `/config decay …`.

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

**Prize lock:** 🥇🥈🥉 need at least **N** finished non-quit games in the **crunch window** (default **N = 1**). Rank `#n` stays. Off: `/config decay prize_lock enabled:false`.

```
/config decay prize_lock_min_games games:7 league:YourLeague
/config decay clear_prize_lock_min_games
/config decay preset name:strict_crunch league:YourLeague
```

**`strict_crunch`:** grace **3**, flat **−100/−100 ki/day**, window **7**, min games **7**.

---

**Toggle**

```
/config set decay enabled:true league:YourLeague
/config set decay enabled:false league:YourLeague
```

Tune via `/config decay grace` / `tier1_ki` / `streak_cap` / `crunch_window` / `prize_lock_min_games` (`clear_*` resets defaults). `/config view` shows rates + crunch. **Rollover:** `reset:continue` copies overrides; decay **off** until re-enabled.

---

**Player paste**

> Inactive players lose ki after **10 days** without a finished game (defaults — your league may differ). During **crunch**, decay is faster; medals need enough finished games (default ≥ **1**; some leagues require more).
