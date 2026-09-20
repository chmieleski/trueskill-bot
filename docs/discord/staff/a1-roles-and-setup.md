🛠️ **Staff — roles & first setup**

Need **Manage Server** (or Administrator) for `/config` and `/league`.

**0) Leagues**

```
/league create game:UDBR name:UDBR
/league list
/league bind target:#lobby-channel league:UDBR
```

One league → bind optional. Multiple → bind or pass `league:`.

**1) Create role** — required for `/register_lobby`

```
/config set create_role role:@YourCreatorRole
```

**2) Mod role** — report / cancel / link help / corrections

```
/config set mod_role role:@YourModRole
```

**3) Player claim** (default on). Off = hosts only seat players.

```
/league_config set player_claim enabled:True
/league_config set player_claim enabled:False
```

**4) Dedicated lobby channel** (optional, per league)
Default **off**. When on, `/register_lobby` and wc3stats **Open lobby** only in that channel. `/lobby` works anywhere.

```
/league_config set lobby_channel enabled:True channel:#lobbies
/league_config clear lobby_channel
```

In that channel, only `/register_lobby`, `/lobby`, and `/match complete|cancel|quitters|griefers|upload_report` are allowed.
Host prompts (if on) **must** use this channel. `/league bind` separately for auto league pick.

**5) Live overall board** — `/league_config set leaderboard_channel` or `/leaderboard setup`. Size: `/league_config set|clear leaderboard_size` (default 10, max 100).

**6) Rank reset** (default off) — `/league_config set rank_reset enabled:True` (optional `cooldown_days`, default 30). Mods: `/rank_reset user:@Player`.

**7) Quitter / griefer boards** (guild-wide)
• `/config set quitter_leaderboard_channel` or `/leaderboard setup_quitters`
• `/config set griefer_leaderboard_channel` or `/leaderboard setup_griefers`
• Size / display (`count`/`rate`/`both`) / sort — see `/config view`
• Browse: `/leaderboard quitters` · `/leaderboard griefers`

**8) Decay** — `/league_config set decay enabled:true|false` (see rating-decay guide).

**9) Hero champion roles (UDBR)** — create Discord roles → `/league_config set hero_champion_role` → enable with `/league_config set hero_champion_roles`. See **a10-hero-champion-roles**.

**See everything:** `/config view`
