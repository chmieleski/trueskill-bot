🛠️ **Staff — roles & first setup**

Need **Manage Server** (or Administrator) for `/config` and `/league`.

**0) Leagues**

```
/league create game:UDBR name:UDBR
/league list
/league bind target:#lobby-channel league:UDBR
```

One league → bind optional. Multiple → bind or pass `league:`.

**1) Create role**

```
/config set create_role role:@YourCreatorRole
```

Required for `/register_lobby`.

**2) Mod role**

```
/config set mod_role role:@YourModRole
```

Report / cancel matches; help with links.

**3) Player claim**

```
/config set player_claim enabled:True
/config set player_claim enabled:False
```

Default on. Off = hosts only seat players.

**4) Dedicated lobby channel (optional, per league)**
Default **off**. When on, `/register_lobby` and wc3stats **Open lobby** only in that channel. `/lobby` works anywhere.

```
/config set lobby_channel enabled:True channel:#lobbies
/config set lobby_channel enabled:False
/config clear lobby_channel
```

When the lobby channel is on, only `/register_lobby`, `/lobby`, and `/match complete|cancel|quitters` work in that channel; other slash commands are refused there.
Host prompts (if on) **must** use this channel. `/league bind` separately for auto league pick.

**5) Live overall leaderboard**
`/config set leaderboard_channel channel:#ranks` or `/leaderboard setup`. Only that bot message in-channel.
Size (default 10, max 100): `/config set|clear leaderboard_size`

**6) Rank reset (optional)**
Default **off**. `/config set rank_reset enabled:True` (optional `cooldown_days`, default 30). Off: `enabled:False`. Days only: `/config set rank_reset_cooldown days:30`. Mods: `/rank_reset user:@Player`.

**7) Live quitter leaderboard**
`/config set quitter_leaderboard_channel channel:#quitters` or `/leaderboard setup_quitters`. Guild-wide. Size / display (`count`/`rate`/`both`) / sort — see `/config view`. Browse: `/leaderboard quitters`.

**See everything:** `/config view`
Clear boards: `/config clear leaderboard_channel` · `/config clear quitter_leaderboard_channel`
