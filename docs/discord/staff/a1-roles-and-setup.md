🛠️ **Staff — roles & first setup**

Need **Manage Server** (or Administrator) for `/config` and `/league`.

**0) Leagues (multi-IHL)**
Each server can run one or more leagues (IHL instances). Create one, then bind lobby channels so `/register_lobby`, `/rank`, and `/leaderboard` know which league to use.
```
/league create game:UDBR name:UDBR
/league list
/league bind target:#lobby-channel league:UDBR
```
If the server has only one league, bind is optional for resolution; with multiple leagues, bind the lobby channel or pass `league:` on commands.

**1) Who may create lobbies**
```
/config set create_role role:@YourCreatorRole
```
Without this, `/register_lobby` is disabled for everyone.

**2) Who may act like the host on matches**
```
/config set mod_role role:@YourModRole
```
Mods can report / cancel in-progress matches and help with links.

**3) Player claim (Claim slot / Leave)**
```
/config set player_claim enabled:True
/config set player_claim enabled:False
```
Default is on. Off = only hosts seat players (by nick or Discord user).

**4) Live overall leaderboard channel**
```
/config set leaderboard_channel channel:#ranks
```
or in the channel:
```
/leaderboard setup
```
Keep **only** that bot message in that channel.

Optional size (default 10, max 100; Discord splits every 25 ranks into another embed):
```
/config set leaderboard_size size:50
```
Reset: `/config clear leaderboard_size`

**5) Player rank reset (optional)**
Default is **off**. When enabled, linked players can wipe their overall and hero ki back to defaults via `/rank_reset` (with a cooldown).
```
/config set rank_reset enabled:True
/config set rank_reset enabled:True cooldown_days:45
/config set rank_reset enabled:False
/config set rank_reset_cooldown days:30
```
Cooldown defaults to **30 days**; omit `cooldown_days` when enabling to keep that default. `rank_reset_cooldown` changes days without toggling on/off.

Match mods can force-reset a linked player (bypasses cooldown):
```
/rank_reset user:@Player
```

**6) Live quitter leaderboard channel**
```
/config set quitter_leaderboard_channel channel:#quitters
```
or in the channel:
```
/leaderboard setup_quitters
```
Keep **only** that bot message in that channel.

Guild-wide — counts quits across **all leagues** on this server (unlike the overall live board, which is per league).

Optional size (default 10, max 100; Discord splits every 25 ranks into another embed):
```
/config set quitter_leaderboard_size size:25
```
Reset: `/config clear quitter_leaderboard_size`

Columns and sort (defaults: display `both`, sort `count`):
```
/config set quitter_leaderboard_display display:count
/config set quitter_leaderboard_display display:rate
/config set quitter_leaderboard_display display:both
/config set quitter_leaderboard_sort sort:count
/config set quitter_leaderboard_sort sort:rate
```
Sort can differ from visible columns (e.g. sort by rate while only showing quit count).

Reset display/sort: `/config clear quitter_leaderboard_display` · `/config clear quitter_leaderboard_sort`

Players can also browse with `/leaderboard quitters`.

**See everything**
```
/config view
```

Clear live boards: `/config clear leaderboard_channel` · `/config clear quitter_leaderboard_channel`
