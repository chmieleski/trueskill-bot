🧩 **Step 3 — Fix the lobby**

The lobby message has buttons. Use them to fix the board.

**On the message**
• ➕ **Add** · ✏️ **Edit** · 🔀 **Move** · 🗑️ **Remove**
• 🔄 **Refresh** — pull from wc3stats when that feature is on (**host or mod**)
• ▶️ **Start Match** — only when the lobby is valid
• **Cancel** — close a pending lobby (**host or mod**; asks **Cancel Lobby** / **Keep Lobby**)

**Players (if claim is on)**
• **Claim slot** — sit in an empty hero seat (you must be linked)
• **Leave** — leave your seat

**Slash commands (host; mods can help with `match_id`)**

```
/lobby add slot:3 nick:SomeNick
/lobby add slot:3 user:@Someone
/lobby remove nick:SomeNick
/lobby remove slot:3
/lobby swap slot_a:1 slot_b:7
/lobby swap pairs:1-7,5-Gohan
/lobby screenshot print:<attach lobby image>
/lobby sync
/lobby start
/lobby cancel
```

**Swap pairs:** each side is a slot or a nick (`1-7`, `Gohan-4`). Comma-separated. Occupied dest swaps; empty dest moves.

**Screenshot:** `/lobby screenshot` replaces the whole roster. If OCR reads nothing, the current roster is kept. Mods can screenshot or cancel with `match_id` if the host is gone.

**Start rules**
• Both teams need ≥1 human
• No duplicate nicks / broken roster
• Unbalanced is OK (example: 4v6)

If you have more than one lobby, add `match_id`.
