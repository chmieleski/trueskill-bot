⏳ **Rating decay & season crunch** _(Manage Server)_

Keeps leaderboards honest when players stop playing. **League-global ki only** — hero ratings unchanged.

Defaults below match a fresh league. Staff can override per league with `/config decay …` (see **Tune rates**).

---

**Mid-season (default: on)**

• **10 days** after a player’s last **finished** non-quit game → decay starts  
• Days 11–19: **−50 ki/day** · Day 20+: **−100 ki/day**  
• Max **−1000 ki** per idle streak, then stops until they play again  
• Joining a lobby does **not** reset the timer  
• Calibrating & New players are exempt

---

**Season crunch (last ~7 days by default)**

Set a season end date or start crunch early:

```
/league set season_end date:2026-03-31 league:YourLeague
/league clear season_end league:YourLeague
/league crunch start league:YourLeague
/league crunch clear league:YourLeague
```

Crunch: **2-day** grace, then **−100 ki/day** (days 3–9) and **−200 ki/day** (day 10+). **No streak cap** — floor ~1000 ki still applies.

**Prize lock:** during crunch, 🥇🥈🥉 on live boards require a finished non-quit game on **each UTC day** of crunch so far. Rank `#n` unchanged; medals go to the next eligible player. `/rank` is unaffected. Disable with `/config decay prize_lock enabled:false`.

---

**Toggle decay**

```
/config set decay enabled:true league:YourLeague
/config set decay enabled:false league:YourLeague
```

---

**Tune rates** _(optional)_

```
/config decay grace mode:mid days:14 league:YourLeague
/config decay tier1_ki mode:mid ki:40
/config decay tier2_ki mode:crunch ki:250
/config decay tier1_span mode:mid days:7
/config decay streak_cap ki:1500
/config decay crunch_window days:10
/config decay prize_lock enabled:true
```

Reset any override to the code default:

```
/config decay clear_grace mode:mid
/config decay clear_streak_cap
/config decay clear_crunch_window
/config decay clear_prize_lock
```

Check `/config view` for effective rates, season end, and crunch.

---

**Rollover note**

`reset:continue` successors have decay **off** by default (break leagues). Rate overrides are copied. Re-enable with `/config set decay enabled:true` when you want mid-season decay again.

---

**Player message you can paste**

> Inactive players lose ki after **10 days** without a finished game (defaults — your league may differ). During **crunch**, decay is faster and top-board medals need a finished game on each crunch day so far.
