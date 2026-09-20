🛡️ **Staff — match mod powers**

People with the **mod role** help when the host is gone or stuck.

**Pending lobbies**
• `/lobby cancel match_id:…` — cancel before start
• `/lobby remove` / `/lobby screenshot` with `match_id` if the host is gone
• Pass `match_id` whenever you are not the host

**Matches in progress**
• `/match complete` — report winner (+ optional quitters/griefers + optional **mitigation** 25/35/50%)
• Host soft-result (**mitigation** on Report Winner / `/match complete`) posts Approve/Reject in the lobby channel — mods only
• `/match quitters` / `/match griefers` — mark slots
• `/match cancel` — cancel (+ optional griefers)

**After a finished match**
• `/match flip match_id:… winner:…` — fix wrong winner within **24h** (optional `quitters`)
• `/match void match_id:…` — undo result and restore ki within **24h** (mod only)
• `/lobby recreate match_id:…` — open a new pending lobby from a **voided** match
• `/match ungrief match_id:…` — clear griefer flags / deferred tax (`slots:` optional)
• `/match unquit match_id:…` — clear quitter flags (`slots:` optional); restores ki when the match is still within the **24h** correction window
• If players already played more ranked games, later matches are **not** recalculated

**Captain draft (tournaments)**
• `/captain_draft start` → `captains` → `members` → `begin` — snake team draft (see **a9**)
• Mod tools: `add` · `remove` · `swap` · `move` · `undo` · `force_pick` · `publish` · `cancel`

**Season rollover**
• `/league rollover` — archive a season and open a successor (see **a6**)

**Accounts & New players**
• `/link nick:X user:@Player` — link others; mods can **relink**
• `/unlink user:@Player`
• `/player_new set` / `/player_new clear` — New-player isolation (excluded from team rate until 5 games; quit still hurts)
• `/rank_reset user:@Player` — force reset (bypasses cooldown when enabled)
{{#wosMatchStats}}
• `/hero_config rename` — shorter WOS hero display names (see **a8**)
{{/wosMatchStats}}

Players still host their own lobbies with the create role.
Mods are the safety net for reporting and account fixes.

Be fair. Wrong reports break trust and ranks.
