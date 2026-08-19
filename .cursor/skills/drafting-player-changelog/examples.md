# Player changelog examples

Copy the **inner** `text` block style. Do not copy engineering commit lists.

## Output shape (required)

Wrong — rendered markdown, nothing to copy:

```
🎉 **What's new in v1.1.0**

Two host tools got easier...
```

Right — same bytes inside a `text` fence so staff can copy:

````
Fetched [GitHub v1.1.0](https://github.com/chmieleski/trueskill-bot/releases/tag/v1.1.0). Paste into the staff Edit modal:

```text
🎉 **What's new in v1.1.0**

Two host tools got easier...
```
````

## v1.1.0 — several commits, two player features

Source was conventional commits (`lobby: add /lobby swap pairs`, cancel-button commits, parsers, xor classic swap). Collapse to **swap pairs** + **pending Cancel button**.

````text
Fetched [GitHub v1.1.0](https://github.com/chmieleski/trueskill-bot/releases/tag/v1.1.0). Paste into the staff Edit modal:

```text
🎉 **What's new in v1.1.0**

Two host tools got easier: **swap a bunch of seats in one command**, and **cancel a pending lobby from the card**.

🔀 **Swap several seats at once**
Hosts can still swap two seats the old way:

`/lobby swap slot_a:1 slot_b:7`

Or move **only the people you name**, in one go, with `pairs`:

`/lobby swap pairs:1-7,5-Gohan`

• Each pair is `from-to` — slot **or** nick (`1-7`, `Gohan-4`, `Vegeta-Piccolo`)
• If the destination is taken, they **swap**. If it's empty, they **move**.
• Several pairs run **left to right**, so later pairs see the new seats.
• Use **either** two slots **or** `pairs` — not both in the same command.

Tip: `1-7, 5-Gohan` means "swap slot 1 with slot 7, then put slot 5 where Gohan is sitting."

🚫 **Cancel a pending lobby from the card**
Pending lobbies now have a **Cancel** button.

• Host or match mod taps **Cancel**
• You get a private **Cancel Lobby** / **Keep Lobby** confirm (so a misclick doesn't kill the lobby)
• `/lobby cancel` still works if you prefer slash commands

This is only for **pending** lobbies (before the match starts). In-progress cancel is unchanged.
```
````

## v1.2.0 — compact (one player feature)

Four engineering commits (`/match list`, format helpers, pagination, invoker-only buttons) → one command.

````text
Fetched [GitHub v1.2.0](https://github.com/chmieleski/trueskill-bot/releases/tag/v1.2.0). Paste into the staff Edit modal:

```text
📋 **v1.2.0**

**New: `/match list`** 📜
Browse all completed matches in your league — winner, format (`4v6`), date, and match ID.

➡️ **Previous / Next** to page through *(only you can click them)*
➡️ Copy an ID → **`/match show`** for full match details

No **`/link`** required.
For *your* stats (hero, W/L, ki), use **`/match history`**.
```
````
