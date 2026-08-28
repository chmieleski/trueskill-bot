# Discord bot guides — how to post

Use `/sync_docs public channel:#…` or `/sync_docs staff channel:#…` (Manage Server or match mod role).

The command **deletes all messages** in that channel, then posts these files in order. Guides are **personalized per league** — team names, rating label, slot layout, and optional features come from that league's settings when you sync.

Bind the target channel to a league (or pass `league:` when the server has more than one). Re-sync after changing league config so players see up-to-date commands and labels.

## Template syntax (repo authors)

Markdown files use simple placeholders and flags resolved at sync time:

- `{{team1}}`, `{{team2}}`, `{{team1Slots}}`, `{{team2Slots}}`, `{{ratingLabel}}`, `{{gameName}}`, `{{slotCount}}`
- `{{#wc3stats}}…{{/wc3stats}}`, `{{#playerClaim}}…{{/playerClaim}}`, `{{#rankReset}}…{{/rankReset}}`, `{{#sideWinLoss}}…{{/sideWinLoss}}`, `{{#heroLeaderboards}}…{{/heroLeaderboards}}`, `{{#slotBound}}…{{/slotBound}}`, `{{#hostPrompts}}…{{/hostPrompts}}`

Rendered posts must stay under Discord's 2000-character limit.

## Public channel (everyone)

1. `public/01-welcome.md`
2. `public/02-link-your-nick.md`
3. `public/03-start-a-lobby.md`
4. `public/04-fix-the-lobby.md`
5. `public/05-play-and-finish.md`
6. `public/06-rank-and-boards.md`
7. `public/06a-how-ki-works.md`
8. `public/07-cheat-sheet.md`

## Staff channel (mods / admins only)

1. `staff/a1-roles-and-setup.md`
2. `staff/a2-mod-powers.md`
3. `staff/a3-quitters-and-ratings.md`
4. `staff/a4-wc3stats-mapping.md`
5. `staff/a5-admin-cheat-sheet.md`
6. `staff/a6-league-rollover.md`
7. `staff/a7-rating-decay.md`

## Tips

- Discord message limit is 2000 characters — these posts stay under that.
- Prefer a read-only / announcements-style channel so the guide stays clean.
- Do **not** put staff posts in the public channel.
- The bot needs **View Channel**, **Manage Messages**, and **Send Messages** in the target channel.
