⚠️ **Staff — quitters, griefers & ratings**

Slots are **1–{{slotCount}}**, comma-separated.

**Quitters** = left early / abandoned.

```
/match quitters slots:2,8
/match complete winner:{{team2}} quitters:2,8
```

• Quitters take a **{{ratingLabel}} penalty** (about **three** solo losses)
• They are **not** in the normal team rating update
• Everyone else still gets a normal win/loss when you complete
• Cancel can still apply quitter penalties if already marked

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
• Mods can `/match unquit match_id:…` to clear quitters (restores {{ratingLabel}} when still correctable within 24h)

**Report Winner** flow: griefers → quitters → pick team → confirm.

**New players**
`/player_new set` marks isolation — they don’t move the team OpenSkill until 5 finished games. Quits still hurt.

**Boards**
• `/leaderboard quitters` / `setup_quitters`
• `/leaderboard griefers` / `setup_griefers`

**Tips**
• Prefer match-message buttons when possible
• Double-check slot numbers before completing
• Use cancel for broken starts — not to hide a real loss
