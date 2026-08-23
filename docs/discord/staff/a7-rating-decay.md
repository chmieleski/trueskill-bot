⏳ **Rating decay & season crunch** _(Manage Server)_

Keeps leaderboards honest when players stop playing. **League-global ki only** — hero ratings unchanged.

---

**Mid-season (default: on)**

• **10 days** after a player’s last **finished** non-quit game → decay starts  
• Days 11–19: **−50 ki/day** · Day 20+: **−100 ki/day**  
• Max **−1000 ki** per idle streak, then stops until they play again  
• Joining a lobby does **not** reset the timer  
• Calibrating & New players are exempt

---

**Season crunch (last ~7 days)**

Set a season end date or start crunch early:

```
/league set season_end date:2026-03-31 league:YourLeague
/league clear season_end league:YourLeague
/league crunch start league:YourLeague
/league crunch clear league:YourLeague
```

Crunch: **2-day** grace, then **−100 ki/day** (days 3–9) and **−200 ki/day** (day 10+). **No streak cap** — floor ~1000 ki still applies.

**Prize lock:** during crunch, 🥇🥈🥉 on live boards skip players with **no finished non-quit game in the last 7 days**. Rank `#n` unchanged; medals go to the next eligible player. `/rank` is unaffected.

---

**Toggle decay**

```
/config set decay enabled:true league:YourLeague
/config set decay enabled:false league:YourLeague
```

Check `/config view` for decay status, season end, and crunch.

---

**Rollover note**

`reset:continue` successors have decay **off** by default (break leagues). Re-enable with `/config set decay enabled:true` when you want mid-season decay again.

---

**Player message you can paste**

> Inactive players lose ki after **10 days** without a finished game. During **crunch week**, decay is faster and top-board medals need a **recent finished game** in the last 7 days.
