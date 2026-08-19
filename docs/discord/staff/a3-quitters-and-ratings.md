⚠️ **Staff — quitters & ratings (simple)**

**Quitters** = players who left early / abandoned.

Mark them **before** or **with** the final report:

```
/match quitters slots:2,8
/match complete winner:Evil quitters:2,8
```

Slots are **1–12**, comma-separated.

**What happens**
• Quitters get a **penalty** to their ki (they are treated like they lost a small solo fight)
• They are **not** counted in the normal team rating update for that match
• Everyone else still gets a normal win/loss update when you complete

**Cancel**

```
/match cancel
```

If quitters were already marked, cancel can still apply those penalties.
Use cancel for broken lobbies / wrong starts — not to hide a real loss.

**Tips**
• Agree on the server’s quitter rules and stick to them
• Prefer marking quitters with the buttons on the match message when possible
• Double-check slot numbers before completing

**Public board**
Some servers expose a guild-wide quitter leaderboard via `/leaderboard quitters` or a live channel set up with `/leaderboard setup_quitters` (see setup guide).
