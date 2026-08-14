🛠️ **Staff — roles & first setup**

Need **Manage Server** (or Administrator) for `/config`.

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

**See everything**
```
/config view
```

Clear live board: `/config clear leaderboard_channel`
