📋 **Staff cheat sheet**

**Leagues (Manage Server)**
• `/league create` / `/league list`
• `/league bind` / `/league unbind` — tie channels/categories to a league

**Config (Manage Server)**
• `/config view`
• `/config set create_role`
• `/config set mod_role`
• `/config set player_claim`
• `/config set leaderboard_channel` / `/leaderboard setup`
• `/config clear leaderboard_channel`
• `/config set leaderboard_size` / `/config clear leaderboard_size`
• `/config set rank_reset` (optional `cooldown_days`) / `/config set rank_reset_cooldown`
• `/config set wc3stats_map_preset` (UDBR)
• `/config clear wc3stats`
• `/config set|clear wc3stats_slot` / `wc3stats_map`
• `/config set|clear wc3stats_host_prompt` — ping linked hosts for live matching lobbies

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
