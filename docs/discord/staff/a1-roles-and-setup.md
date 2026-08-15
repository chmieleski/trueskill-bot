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

**See everything**
```
/config view
```

Clear live board: `/config clear leaderboard_channel`
