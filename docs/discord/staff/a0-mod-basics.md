📚 **Staff — mod basics** _(start here)_

You’re the safety net when a host is gone or stuck. Be fair — wrong reports break ranks and trust.

**Your job in one line**
Help with lobbies, report real results, fix bad links, and correct mistakes within 24h.

**1) Before the match starts (pending lobby)**
• Host normally handles their own lobby
• If they’re gone: cancel / edit with `match_id`
• `/lobby cancel match_id:…`
• `/lobby remove` or `/lobby screenshot` with `match_id` if needed

**2) After the game (in progress)**
Host or mod reports on the match message (buttons are easiest):

• **Report Winner** → griefers → quitters → pick the winning team → confirm
• **Quitters** = left early / abandoned
• **Griefers** = bug abuse / griefing
• **Cancel** = broken start / don’t finish as a normal win-loss

Commands if you prefer:
`/match complete winner:…`
`/match quitters slots:2,8`
`/match griefers slots:3`
`/match cancel`

**3) Someone linked wrong?**
• `/link nick:InGameNick user:@Player` — mods can relink
• `/unlink user:@Player`

**4) Wrong result? (within 24 hours)**
• `/match flip match_id:… winner:…` — swap the winner
• `/match void match_id:…` — undo the result and restore {{ratingLabel}}
• After void: `/lobby recreate match_id:…` if you need a fresh lobby

**Quick rules of thumb**
• Prefer the **buttons** on the match message
• Double-check **slot numbers** before you complete
• Cancel broken starts — don’t cancel to hide a real loss
• Quitters get a {{ratingLabel}} hit; everyone else still gets a normal win/loss when you complete
• Later matches are **not** recalculated after a flip/void

When in doubt: report what actually happened. Details → **a2** (mod powers) and **a3** (quitters).
