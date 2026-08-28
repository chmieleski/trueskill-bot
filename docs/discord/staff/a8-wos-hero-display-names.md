🏷️ **Staff — WOS hero display names**

WOS match reports store long in-game hero names (e.g. `Raiden Ei`). Players see shorter labels in `/hero`, `/items`, `/rank`, and match log stats.

**Who can rename**
• **Manage Server** (bot owner / admin)
• **Match mod role** (`/config set mod_role`)

**Rename a hero**

```
/hero_config rename hero:Raiden Ei display_name:Raiden
```

`hero:` autocomplete lists heroes seen in completed matches for the resolved league.

**What changes**
• Display name everywhere the bot shows that hero (stats, boards, logs)
• **Game history is not split** — rows stay grouped by `heroObjectId` from the report

**What does not change**
• Raw report text on disk (`MatchStatsReport`)
• UDBR lobby `Hero` table (slots 1–12) — WOS only

**How names are stored**
• First time a hero appears in an uploaded report, the bot adds it to the **GameHero** catalog (`gameId` + `objectId`)
• Renames update that catalog row; re-uploading a report does **not** overwrite a mod rename

**If a hero is missing from autocomplete**
• Upload at least one match report that includes the hero, or wait until a completed match has stats for that pick

**Check league:** `/config view` (set `league:` when the server has multiple IHLs)
