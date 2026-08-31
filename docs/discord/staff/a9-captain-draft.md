🎯 **Captain draft** _(mod role)_

Standalone **snake draft** for tournament teams — not tied to `/register_lobby`. Run it in any text channel (one active draft per channel).

**Setup**

```
/captain_draft start
/captain_draft captains players:@Cap1, Cap2, @Cap3
/captain_draft members players:Alice, Bob, Carol, …
/captain_draft begin
```

• Optional `league:` on setup if the channel is not league-bound (nick → Discord link lookup)
• `players` accepts **@mentions** and comma-separated nicks; linked nicks show as tags in embeds
• `begin` shuffles captain pick order and posts the **live draft** message

**During the draft**
• Captains with Discord links: **Pick player** button or `/captain_draft pick player:…`
• Text-only captains: you **`force_pick`** for them
• Mod fixes: `add` · `remove` · `swap` · `move` · `undo` · `force_pick` · `cancel`

**After the draft**

```
/captain_draft publish
```

Posts one **team roster embed per team** (leaderboard-style). Re-run `publish` to refresh; edits update the same messages.

• Captains: `/captain_draft rename name:Team Name`
• Mods: `/captain_draft rename_team team:… name:…` · roster `add` / `remove` / `swap` / `move`

**Tips**
• At least **2 captains** and **1 member** before `begin`
• Cannot remove a captain from their team — use `swap` / `move` for roster fixes
• Fair pick order uses a random snake; use `undo` if someone mis-clicks

See **a5** cheat sheet for a one-line command list.
