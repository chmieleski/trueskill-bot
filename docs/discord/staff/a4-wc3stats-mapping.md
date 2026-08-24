🗺️ **Staff — wc3stats slot mapping**

Only needed if you import live lobbies from **wc3stats** and seats look wrong.

The bot maps wc3stats color indexes → hero slots **1–12**.

**Easiest (UDBR map)**

```
/config set wc3stats_map_preset preset:UDBR
```

Loads the built-in Z Fighters / Evil layout (referee unmapped).

**One seat**

```
/config set wc3stats_slot wc3_slot:0 hero_slot:1
```

`wc3_slot` is **0-based** in wc3stats `slots[]`.

**Bulk replace**

```
/config set wc3stats_map entries:0=1,1=2,4=7
```

**Clear**

```
/config clear wc3stats_slot wc3_slot:0
/config clear wc3stats_map
/config clear wc3stats
```

**Check:** `/config view`

Hosts can `/lobby sync` (or **Refresh**) to pull the live WC3 lobby when import is enabled.

**Optional: host lobby prompts**
Ping linked hosts when their matching Warcraft lobby appears:

```
/config set wc3stats_host_prompt enabled:True channel:#lobbies
/config clear wc3stats_host_prompt
```

If `/config set lobby_channel` is on, the prompt channel **must match**. Only the mentioned host can **Open lobby** / **Dismiss**. Open uses the same create-role rules as `/register_lobby`.

Players can opt out of pings (still linked):

```
/settings set host_prompt_pings enabled:False
/settings view
```
