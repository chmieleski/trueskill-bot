📋 **Staff cheat sheet**

**Leagues (Manage Server)**
• `/league create` / `/league list`
• `/league bind` / `/league unbind` — tie channels/categories to a league
• `/league rollover` — archive a season and open a successor (`reset:continue|soft|hard`, optional `compression` for soft)

**Config (Manage Server)**
• `/config view`
• `/config set create_role`
• `/config set mod_role`
• `/config set player_claim`
• `/config set|clear lobby_channel` — optional per-league create-only channel; when on, also limits slash commands in that channel to lobby/match ops
• `/config set leaderboard_channel` / `/leaderboard setup`
• `/config clear leaderboard_channel`
• `/config set leaderboard_size` / `/config clear leaderboard_size`
• `/config set quitter_leaderboard_channel` / `/leaderboard setup_quitters`
• `/config clear quitter_leaderboard_channel`
• `/config set quitter_leaderboard_size` / `/config clear quitter_leaderboard_size`
• `/config set quitter_leaderboard_display` (`count` / `rate` / `both`) / `/config clear quitter_leaderboard_display`
• `/config set quitter_leaderboard_sort` (`count` / `rate`) / `/config clear quitter_leaderboard_sort`
• `/leaderboard quitters` — guild-wide paginated view (all leagues)
• `/config set rank_reset` (optional `cooldown_days`) / `/config set rank_reset_cooldown`
• `/config set wc3stats_map_preset` (UDBR)
• `/config clear wc3stats`
• `/config set|clear wc3stats_slot` / `wc3stats_map`
• `/config set|clear wc3stats_host_prompt` — ping linked hosts for live matching lobbies
• `/config set|clear changelog_channel` — player patch notes for this server
• `/config set|clear changelog_draft_channel` — one staff draft channel for the whole bot (second server is rejected)

**Releases (Manage Server on the draft server)**
• After a version deploys, a Draft card appears in the draft channel
• Edit the player summary, then Publish (all changelog channels) or Dismiss (no player post)

**Mod role**
• `/match complete|quitters|cancel` (+ `match_id`)
• `/match flip match_id:… winner:…` — fix wrong winner within 24h (optional `quitters`)
• `/match void match_id:…` — undo result and restore ki within 24h (mod only, not host)
• `/link nick: user:@…` (others + relink)
• `/unlink user:@…`
• `/rank_reset user:@…` (force reset another linked player; bypasses cooldown)

**Create role**
• `/register_lobby`
• `/lobby …` while hosting

**Remember**
• No create role configured → nobody can open lobbies
• Public guide stays in the player channel; keep this channel private
• Fair reports > fast reports
