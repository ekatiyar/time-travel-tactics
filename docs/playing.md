# Playing

Run `npm run dev` and open the printed address, or use the [published game](https://ekatiyar.github.io/time-travel-tactics/).

[`prototypes.md`](prototypes.md) lists what the prototype supports. The [design document](time-travel-tactics-design-doc.md) explains the rules.

## Start a match

Create a match, then use **Copy join link** in the lobby to share it. **Bootstrap** places one key at the center and has a winner. **Sandbox** has no winner and ends at the turn cap. Boards are at least 5x5. Opening the link goes straight to that match's lobby.

Choose a colour and enter a name in the shared Name field. Your draft follows you between free colours. Selecting a saved or occupied colour shows its fixed name. If two players claim one colour, the loser returns to the lobby and sees the winner's name. Disconnected seats become free again.

After you click Play, the browser address becomes a resume link and updates after each completed turn. Use it to reopen or share the current match.

**New match** starts over with a new seed. It asks for confirmation during play.

## Take a turn

Choose an action with the D-pad, arrow keys, or `W` `A` `S` `D`, then commit with Enter or Space. Shortcuts do nothing while a control has focus. Your choice stays private until every player commits, and you can change it until the turn opens.

The board outlines your four legal moves as tiles, each labelled with the personal index and world turn it would produce. Click one to choose it. Hold and Turn around stay buttons in the actions rail.

Hold advances through world time without moving. Invert changes your direction without advancing world time. Moves and holds cannot enter a cell with any recorded body, including yours. Invert is the only action that can stack your bodies.

Dots under Commit show this turn's priority order from left to right. They fade as players commit. Hover for the order and who is still choosing.

Body markers are filled when moving in your direction and outlined when moving in the opposite direction. A half-filled stack contains both directions. Trail and timeline dots use the same filled or outlined style.

Stacks show up to two personal indices. Larger stacks show the first and last, such as `16 … 18`; hover text lists them all.

The world-turn scrub and history presets change what history you see, not the match. Presets are `0`, `2`, `4`, and the board maximum: a quarter of the turn cap, rounded up.

A move into unexplored time may collide with a body you could not see when choosing it. The recorded body wins as a holder, and your move falls back normally.

## The screen

The play screen fills the window. Your identity, position, direction, turn or outcome, connection, state hash, theme and **New match** controls are in the top bar. A chip appears beside your identity when a front is approaching.

The log is on the left and actions on the right. Fold either rail with its header arrow. The folded log shows its event count and the latest three events as fading toasts. The folded actions rail keeps the change-action and commit buttons, priority dots and waiting count. Both rails stay folded below 1120px wide.

The bottom dock holds the timeline strip, world-turn scrub and history presets. Hover the strip's dashed block to see which world turns you have not explored. Hover **?** for the legend and keyboard shortcuts.

Hold the world-turn scrub to open the timeline chart. Each player has a row split into legs at inversions, with body markers filled or hollow by direction. A hatched area marks turns beyond your horizon; hover it to see the range. Arcs connect legs at inversions, and a red line marks the turn cap. The chart scales to turns reached.

Rows show the latest four legs and label any hidden earlier legs. Each row shows the player's latest visible index and direction. If their present is beyond your horizon, the readout dims to show it is last known.

Legs joined by an inversion beyond your horizon end in dashed stubs at the hatch, without an arc. The inversion happened out of view.

The board dims and stops taking clicks while the chart is open. Release the scrub to close it.

## Animation

Resolved turns animate for about a second: bodies move or bounce, inversions and key changes play, then fronts advance. Legs split after an inversion and rejoin when you scrub back. Scrubbing one turn at a time slides bodies; longer jumps snap. Any key or click ends the animation, and the system **reduce motion** setting disables it.

## Bootstrap

The key sits on the center tile at `t0`. End an action on any tile beside the center to pick it up. You can pick up another incarnation while already carrying one. Each key attaches to the side it came from and shows as a small square on that side of your body. A number on the square counts incarnations when that side holds more than one. A key drawn on the center tile means nobody holds it at the focused world turn.

To steal, end an action on the tile beyond an opponent's key side at the same world turn. You take every incarnation exposed on that side; keys on its other sides stay put. Recorded bodies can be robbed too. The log reports each pickup, steal, and complete loss.

Each grabbed key index starts a front that walks the key's earlier holders, two indices per turn. A triangle in the grabber's colour marks a front on the board and in its own strip row, and slides to its new tile when a turn resolves. Hover it for the turns until it reaches you, or read the chip in the top bar when it is aimed at you. A front removes the incarnation it reaches; you lose the key only when none remain. Any grab it passes is undone.

Win by ending an action at `t0` on a tile next to your own spawn while holding the key. Your spawn tile has a dashed outline in your colour. A match with no winner at the cap is a draw.

## Limits

This prototype has no weapons. Sandbox matches end at the turn cap.

The client hides events beyond your horizon, but another client can be modified to reveal them. Play with people you trust.
