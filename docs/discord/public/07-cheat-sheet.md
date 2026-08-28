🧾 **Player cheat sheet**

**Account**
• `/link nick:` — connect your in-game nick
• `/unlink` — disconnect yourself
• `/rank` — your {{ratingLabel}} / look someone up
• `/settings view` — personal prefs{{#hostPrompts}} (e.g. host lobby pings){{/hostPrompts}}
{{#hostPrompts}}• `/settings set host_prompt_pings` — on/off when wc3stats finds your lobby
{{/hostPrompts}}
**Lobby (create role)**
• `/register_lobby` — open a lobby
• `/lobby add` / `remove` / `swap` / `screenshot`{{#wc3stats}} / `sync`{{/wc3stats}} / `start` / `cancel`

**Match (anyone)**
• `/match history` — completed matches (optional user/nick/page/`griefers_only`)
{{#sideWinLoss}}• `/match list` — league matches + side win rate (optional page)
{{/sideWinLoss}}• `/match show` — open a completed match by id

**Match (host or mod)**
• `/lobby cancel` — cancel a pending lobby (`match_id` if not host)
• `/match complete` — winner (+ optional `quitters` / `griefers`)
• `/match quitters` / `/match griefers` — mark slots
• `/match cancel` — cancel in-progress (+ optional `griefers`)

**Boards**
• Same {{ratingLabel}} ≠ same points — who was in the lobby matters
• `/leaderboard show` — overall
{{#heroLeaderboards}}• `/leaderboard heroes` / `hero` — heroes
{{/heroLeaderboards}}{{#wosMatchStats}}
**WOS stats** (uploaded match reports)
• `/hero hero:` — hero averages + top players (`user`/`nick`, `window`)
• `/items` — item buy rate & WR (`hero:`, `window`)
{{/wosMatchStats}}• `/leaderboard quitters` / `griefers` — if the server set them up

**Teams**
• Slots {{team1Slots}} = **{{team1}}**
• Slots {{team2Slots}} = **{{team2}}**

**Buttons on the lobby / match message** do the same job as many of these commands.

Stuck? Ping a match moderator.
