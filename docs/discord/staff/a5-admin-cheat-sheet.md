📋 **Staff cheat sheet**

**Leagues (Manage Server)**
• `/league create` / `list` / `bind` / `unbind`
• `/league rollover` — `reset:continue|soft|hard` (+ `compression` for soft)
• `/league set|clear season_end` · `/league crunch start|clear`

**Config (Manage Server)** — guild-wide
• `/config view` (includes league settings when `league:` is set)
• `create_role` · `mod_role`
• Quitter board: `quitter_leaderboard_*` · `/leaderboard setup_quitters` · `/leaderboard quitters`
• Griefer board: `griefer_leaderboard_*` · `/leaderboard setup_griefers` · `/leaderboard griefers`
• `changelog_channel` · `changelog_draft_channel` (one draft channel bot-wide)

**League config (Manage Server)**
• `player_claim` · `lobby_channel` — when on, channel allows `/register_lobby`, `/lobby`, `/match complete|cancel|quitters|griefers|upload_report`
• Overall board: `leaderboard_channel` / `size` · `/leaderboard setup`
• `rank_reset` / `rank_reset_cooldown`
• `wc3stats_map_preset` (UDBR) · `wc3stats_slot` / `map` · `wc3stats_host_prompt` · `wc3stats_host_prompt_pings`
• `decay` (`enabled:true|false`)

**Decay config (Manage Server)**
• `/decay_config …` — grace/rates/cap/crunch/prize lock/min games · `preset name:strict_crunch` (`clear_*` resets defaults)

**Releases (draft server)**
Draft card → edit summary → **Publish** (all changelog channels) or **Dismiss**

**Mod role**
• `/match complete|quitters|griefers|cancel` (+ `match_id`)
• `/match flip` / `void` (24h) · `/match ungrief` · `/match unquit`
• `/lobby recreate` after void · `/lobby remove` / `screenshot` with `match_id`
• `/link` / `/unlink` others · `/player_new set|clear` · `/rank_reset user:`
• `/captain_draft` — tournament snake draft (see **a9**)
{{#wosMatchStats}}• `/hero_config rename` — WOS hero display names (mods + admins)
{{/wosMatchStats}}

**Create role**
• `/register_lobby` · `/lobby …` while hosting

**Remember**
• No create role → nobody opens lobbies
• Keep this channel private; public guide stays in the player channel
• Fair reports > fast reports
