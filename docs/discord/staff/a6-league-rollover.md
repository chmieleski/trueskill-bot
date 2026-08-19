🏁 **League season rollover** _(Manage Server)_

Use this when a league season ends and you want a **new** league for the next season. The old league becomes **read-only history**; play moves to the successor.

---

**Before you start**

• Every **active lobby or match** in that league must be **completed or cancelled** — rollover is blocked otherwise.  
• Pick a **display name** for the new league (e.g. `UDBR Winter 2026`).  
• Decide **hard** vs **soft** reset (see below).  
• Channel/category **bindings move automatically** to the new league.

---

**Command**

```
/league rollover name:UDBR Season 2 reset:soft
/league rollover name:UDBR Season 2 reset:soft compression:0.5
/league rollover name:Fresh Start reset:hard league:YourLeagueName
```

| Option | Meaning |
|--------|---------|
| `name` | Display name for the **new** league (required) |
| `reset` | `hard` — everyone back to ~1000 ki · `soft` — ratings shrink toward the old average |
| `compression` | Only for `soft`. `0.0`–`1.0`, default `0.5`. **Higher = stronger pull toward average** |
| `league` | Required when the server has more than one **active** league |

You get a **Confirm / Cancel** prompt. Only you can press the buttons.

---

**Hard reset**

• Every player who had a rating in the old season starts at default skill (~**1000 ki**).  
• Hero-specific ratings are cleared — they rebuild when players pick heroes again.  
• Public **Calibrating** label until 5 completed games (same as new players).  
• Old season matches and leaderboards stay in the archive.

**When to use:** full fresh start, big rule changes, or you want everyone equal again.

---

**Soft reset**

• **Overall ki** moves toward the old season’s **average** — strong players drop, weaker players rise.  
• **Each hero** rating is compressed toward that hero’s old-season average separately.  
• **Uncertainty (σ)** goes up so early-season games move ki more (like ranked resets in other games).  
• Hero **Calibrating** resets (`matchesPlayed` back to 0) even though skill carries over partially.

**Compression guide**

| Value | Feel |
|-------|------|
| `0.3` | Gentle — keep most of last season’s spread |
| `0.5` | Default — halfway to the old average |
| `0.7` | Aggressive — tight cluster near the old average |

Example: a 5000 ki player and a 1200 ki player with `compression:0.5` both move toward the league average (often ~2500–3500 depending on your population).

---

**What moves with you**

✅ wc3stats map preset & slot maps  
✅ Leaderboard / lobby channel settings  
✅ Rank-reset enable & cooldown  
✅ Host-prompt settings  
✅ Channel & category bindings  

❌ Match history (stays on archived league)  
❌ Live leaderboard message (re-run `/leaderboard setup` on the new league or wait for post-match refresh)  
❌ Per-player rank-reset cooldown history  

---

**After rollover**

• `/league list` shows **Active** and **Archived** sections.  
• Players use the same channels — bindings already point at the new league.  
• View old season: `/match list` or `/leaderboard` with the **archived** league selected.  
• Archived leagues **cannot** register lobbies, import wc3stats, or run `/rank_reset`.

---

**Player message you can paste**

> A new season started in **{new name}**. Your ki was {hard: reset to ~1000 | soft: adjusted toward the league average}. Last season is archived — history still visible with `/match list`. Have fun climbing again!
