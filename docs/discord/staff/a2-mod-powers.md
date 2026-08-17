🛡️ **Staff — match mod powers**

People with the **mod role** can help when the host is gone or stuck.

**Pending lobbies**
• `/lobby cancel match_id:…` — cancel a lobby that has not started yet
• Pass `match_id` when you are not the host

**Matches in progress**
• `/match complete` — report winner (pass `match_id` if needed)
• `/match quitters` — mark leavers
• `/match cancel` — cancel the match

**Correcting a finished match** (within 24 hours)
• `/match flip match_id:… winner:…` — fix wrong winner (optional `quitters`)
• `/match void match_id:…` — undo the result and restore ki
• Hosts cannot do this — mod role only
• If players already played more ranked games, later matches are not recalculated

Mods should **always pass `match_id`** when they are not the host (the bot will ask for it).

**Linking accounts**
• `/link nick:X user:@Player` — link someone else
• Mods can **relink** a nick that was already bound
• `/unlink user:@Player` — unlink someone else
• Players can only unlink themselves

**What mods do *not* need for everyday play**
Players still host their own lobbies if they have the create role.
Mods are the safety net for reporting and account fixes.

Be fair. Wrong reports break trust and ranks.
