📋 **Staff cheat sheet**

**Leagues (Manage Server)**
• `/league create` / `list` / `bind` / `unbind`
• `/league rollover` — `reset:continue|soft|hard` (+ `compression` for soft)
• `/league set|clear season_end` · `/league crunch start|clear`

**Config (Manage Server)**
• `/config view`
• `create_role` · `mod_role` · `player_claim`
• `lobby_channel` — when on, channel allows `/register_lobby`, `/lobby`, `/match complete|cancel|quitters|griefers`
• Overall board: `leaderboard_channel` / `size` · `/leaderboard setup`
• Quitter board: `quitter_leaderboard_*` · `/leaderboard setup_quitters` · `/leaderboard quitters`
• Griefer board: `griefer_leaderboard_*` · `/leaderboard setup_griefers` · `/leaderboard griefers`
• `rank_reset` / `rank_reset_cooldown`
• `wc3stats_map_preset` (UDBR) · `wc3stats_slot` / `map` · `wc3stats_host_prompt`
• `changelog_channel` · `changelog_draft_channel` (one draft channel bot-wide)
• `decay` (`enabled:true|false`) · `/config decay …` grace/rates/cap/crunch/prize lock/min games · `preset name:strict_crunch` (`clear_*` resets defaults)

**Releases (draft server)**
Draft card → edit summary → **Publish** (all changelog channels) or **Dismiss**

**Mod role**
• `/match complete|quitters|griefers|cancel` (+ `match_id`)
• `/match flip` / `void` (24h) · `/match ungrief`
• `/lobby recreate` after void · `/lobby remove` / `screenshot` with `match_id`
• `/link` / `/unlink` others · `/player_new set|clear` · `/rank_reset user:`

**Create role**
• `/register_lobby` · `/lobby …` while hosting

**Remember**
• No create role → nobody opens lobbies
• Keep this channel private; public guide stays in the player channel
• Fair reports > fast reports
