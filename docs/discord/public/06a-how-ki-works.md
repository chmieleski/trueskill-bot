🤔 **How {{ratingLabel}} actually moves**

{{ratingLabel}} is **not** “everyone on the winning team gets the same +X.” Two players with almost the same {{ratingLabel}} can still swing differently after the **same** game.

**1) It was a fair fight — or it wasn't**

The bot looks at **both teams** in that lobby, not just your number.

• Your side was **favored** → a win is expected → **small** gain. A loss is an upset → **bigger** drop.
• Your side was the **underdog** → a win is a surprise → **bigger** gain. A loss was likely → **smaller** drop.

A 4v6 win is a bigger surprise than a stacked 6v6.

**2) You vs this lobby (even at similar {{ratingLabel}})**

After the result, the bot also looks at **you vs the room**.

• You were **one of the stronger** players in that lobby → win pays **less**, loss hurts **more**.
• You were **one of the weaker** players in that lobby → win pays **more**, loss hurts **less**.

That's why two ~4000 {{ratingLabel}} players can split: one was the high man in a 3500 lobby, the other was the low man in a 4500 lobby.

**3) How “settled” you are**

• **Calibrating** (first games){{#heroLeaderboards}} and **off-main heroes**{{/heroLeaderboards}} move a lot — the bot is still learning.
• A **veteran on their main** barely moves unless the result was a real upset.
{{#heroLeaderboards}}• **Overall** and **hero** {{ratingLabel}} are separate. A Goku main on Vegeta can see a big hero swing and a small overall swing.
{{/heroLeaderboards}}
**4) Special cases**

• **Quitters** are scored apart (about **three** solo losses). Everyone else still gets a normal team result.
• **New player** marks don't drag teammates' {{ratingLabel}} until they finish calibration. Quits still hurt them.
• First **5** finished games hide public {{ratingLabel}} (`Calibrating`) so early wild swings don't look like a rank.

Same {{ratingLabel}} ≠ same stake. Who you played with, who you played against, and how proven you are all change the swing.
