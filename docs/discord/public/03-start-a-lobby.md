🏁 **Step 2 — Start a lobby**

Only people with the **create role** can open a ranked lobby.
(If creation is not set up yet, nobody can — ask an admin.)

A host who is not a match moderator can have only **one** open lobby or in-progress match in that league at a time. Cancel or report it before opening another. Moderators can open more than one.

**Command**

```
/register_lobby
```

If the server turned on a **lobby channel**, run this there (the bot will tell you which channel).

Optional extras:
• `print` — a lobby screenshot (the bot tries to read names)
• `wc3stats_id` — a live lobby id from wc3stats (if that feature is on)

**What you get**
A message with the roster, win chances (when possible), and buttons.

Pending lobbies **auto-cancel after about 2 hours** if nobody starts them.

**Empty lobby?**
That’s OK. Add people with buttons or `/lobby` commands.
Or players can **Claim slot** if that is enabled.

If host prompts are on, wc3stats may ping you with **Open lobby** / **Dismiss** when it finds your live WC3 lobby.

**Who is the host?**
The person who ran `/register_lobby`. They own the lobby until the match starts.

Next post: how to fix seats and start the game.
