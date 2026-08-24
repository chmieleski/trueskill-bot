⏳ **Rating decay & season crunch** _(Manage Server)_

Keeps boards honest when players go idle. **Overall ki only** — hero ratings unchanged. This is **live**.

Defaults below match a fresh league. Override per league with `/config decay …`.

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
/league clear season_end league:YourLeague
/league crunch start league:YourLeague
/league crunch clear league:YourLeague
```

Crunch: **2-day** grace, then **−100 ki/day** (days 3–9) and **−200 ki/day** (day 10+). **No streak cap** — floor ~1000 ki still applies.

**Prize lock:** during crunch, 🥇🥈🥉 need a finished non-quit game on **each UTC day** of crunch so far. Rank `#n` stays; medals go to the next eligible player. `/rank` is unaffected. Off: `/config decay prize_lock enabled:false`.

---

**Toggle**

```
/config set decay enabled:true league:YourLeague
/config set decay enabled:false league:YourLeague
```

**Tune rates** (optional)

```
/config decay grace mode:mid days:14 league:YourLeague
/config decay tier1_ki mode:mid ki:40
/config decay streak_cap ki:1500
/config decay crunch_window days:10
/config decay prize_lock enabled:true
/config decay clear_grace mode:mid
```

Check `/config view` for effective rates, season end, and crunch.

**Rollover:** `reset:continue` successors have decay **off** by default (rate overrides are copied). Re-enable with `/config set decay enabled:true` when needed.

---

**Player message you can paste**

> Inactive players lose ki after **10 days** without a finished game (defaults — your league may differ). During **crunch**, decay is faster and top-board medals need a finished game on each crunch day so far.
