🗺️ **Staff — wc3stats slot mapping**

Only needed if you import live lobbies from **wc3stats** and seats look wrong.

The bot maps wc3stats color indexes → hero slots **1–12**.

**Easiest (UDBR map)**
```
/config set wc3stats_map_preset preset:UDBR
```
This loads the built-in Z Fighters / Evil layout (referee unmapped).

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

**Check**
```
/config view
```

Hosts can also `/lobby sync` (or Refresh) to pull the live WC3 lobby when the feature is enabled.
- Enable (and load UDBR defaults): `/config set wc3stats_map_preset preset:UDBR`
- Full reset: `/config clear wc3stats`
- Layout-only clear commands unchanged
