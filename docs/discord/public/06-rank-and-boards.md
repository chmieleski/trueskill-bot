📈 **Step 5 — Rank & leaderboards**

Your strength is shown as **{{ratingLabel}}**.
• New players start near **1000**
• Win → {{ratingLabel}} usually up · Lose → usually down · Big upsets move more
• The bot tracks **overall** skill{{#heroLeaderboards}} and skill **per hero**{{/heroLeaderboards}}
• Same {{ratingLabel}} does **not** mean the same swing — see the next post

**See a profile**

```
/rank
/rank user:@Friend
/rank nick:SomeNick
```

Profiles also show your **top teammates and opponents** when you have shared completed matches.
{{#wosMatchStats}}
WOS `/rank` lists **most-played heroes** from uploaded match reports.

```
/hero hero:<name>
/hero hero:<name> user:@Friend
/items
/items hero:<name>
```

`/hero` — hero averages (last 10 + overall) and top players; add `user:`/`nick:` for one player.
`/items` — item buy rate & WR; optional `hero:`.

{{/wosMatchStats}}
**Leaderboards**

```
/leaderboard show
/leaderboard show page:2
{{#heroLeaderboards}}/leaderboard heroes
/leaderboard hero name:Goku
{{/heroLeaderboards}}/leaderboard quitters
/leaderboard griefers
```

Some servers have a **live overall** message that updates after matches. Quitter / griefer boards are optional.

{{#rankReset}}Some leagues offer a full rank reset when staff enable it:

```
/rank_reset
```

Resets overall{{#heroLeaderboards}} and hero {{/heroLeaderboards}}{{ratingLabel}} (near **1000**); displayed W/L/quits restart. History stays. Cooldown between self-resets. Blocked in an active lobby or match.

{{/rankReset}}**New season (staff rollover)**
• **Continue** — freeze the old season; same {{ratingLabel}} on the new name (typical break / “Season 1.5”)
• **Hard reset** — everyone near **1000 {{ratingLabel}}** again
• **Soft reset** — {{ratingLabel}} moves toward the old average; hero **Calibrating** may return

The previous season is **archived**. New games only count in the active league.

**Idle decay & crunch**

Stop playing and **overall {{ratingLabel}}** drops after **10 days** without a **finished** game (quits don't count). One finished game resets it. Hero {{ratingLabel}} is unchanged.

Near season end, **crunch week** uses faster decay. Live board 🥇🥈🥉 need enough **finished games during crunch** (default at least **1**; some leagues require more, e.g. **7**); your rank `#` stays — medals go to the next eligible player.

Remember: {{ratingLabel}} is a score, not a trophy case. Play, learn, climb.
