🧩 **Step 3 — Fix the lobby**

The lobby message has buttons. Use them like toys that fix the board.

**Host tools**
• ➕ **Add** a player
• ✏️ **Edit** a nick
• 🔀 **Move** / swap seats
• 🗑️ **Remove** a player
• 🔄 Refresh from wc3stats (when available)
• ▶️ **Start Match** (only when the lobby is valid)

**Players (if claim is on)**
• **Claim slot** — sit in an empty hero seat (you must be linked)
• **Leave** — leave your seat

**Same things as slash commands (host)**
```
/lobby add slot:3 nick:SomeNick
/lobby add slot:3 user:@Someone
/lobby remove nick:SomeNick
/lobby remove slot:3
/lobby swap slot_a:1 slot_b:7
/lobby screenshot print:<attach lobby image>
/lobby sync
/lobby start
/lobby cancel
```

**Update from screenshot**
• `/lobby screenshot` with a lobby image replaces the whole roster (like registering with a print)
• If OCR reads nothing, your current roster is kept

A **match moderator** can also `/lobby screenshot` or `/lobby cancel` with `match_id` if the host is gone.

**Start rules**
• Both teams need ≥1 human
• No duplicate slots / broken roster
• Unbalanced is OK (example: 4v6)

If you have more than one lobby, add `match_id`.
