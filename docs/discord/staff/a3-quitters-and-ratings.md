⚠️ **Staff — quitters, griefers & ratings**

Slots are **1–{{slotCount}}**, comma-separated.

**Quitters** = left early / abandoned.

```
/match quitters slots:2,8
/match complete winner:{{team2}} quitters:2,8
```

• Quitters have no immediate rating penalty; each quitter-marked game adds a **10% compounded {{ratingLabel}} tax** at season rollover
• They are **not** in the normal team rating update
• Everyone else still gets a normal win/loss when you complete
• Quitter flags on cancelled matches count toward the season rollover tax

**Griefers** = bug abuse / griefing.

```
/match griefers slots:3
/match complete winner:{{team1}} griefers:3
/match cancel griefers:3
```

• No instant {{ratingLabel}} hit — bot accrues **min(25% of {{ratingLabel}}, 500)** per incident
• Tax applies to the **archived ending board** on **season rollover**
• If someone is both quitter and griefer, **quit wins** (no griefer accrual)
• Mods can `/match ungrief match_id:…` to clear flags/tax
• Mods can `/match unquit match_id:…` to clear quitter flags; completed-match ratings are recalculated when still correctable within 24h

**Report Winner** flow: griefers → quitters → pick team → confirm.

**New players**
`/player_new set` marks isolation — they don’t move the team OpenSkill until 5 finished games. Quitter flags still count toward rollover tax.

**Boards**
• `/leaderboard quitters` / `setup_quitters`
• `/leaderboard griefers` / `setup_griefers`

**Tips**
• Prefer match-message buttons when possible
• Double-check slot numbers before completing
• Use cancel for broken starts — not to hide a real loss
