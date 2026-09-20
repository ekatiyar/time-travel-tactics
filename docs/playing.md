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

The board draws your four legal moves as outlined tiles, each labelled with the personal index and world turn it would produce. Click one to choose it. Hold and Turn around stay buttons in the actions rail.

Hold advances through world time without moving. Invert changes your direction without advancing world time.

A row of dots under Commit shows every player in this turn's priority order, leftmost first. A dot stays solid while that player is still choosing and fades once they commit. Hover it for the priority order and who has not committed.

Body markers are filled when moving in your direction and outlined when moving in the opposite direction. A half-filled stack contains both directions. Trail and timeline dots use the same filled or outlined style.

Stacks show up to two personal indices. Larger stacks show the first and last, such as `16 … 18`; hover text lists them all.

The world-turn scrub and the history presets change what history you see. They do not change the match. History offers `0`, `2`, `4`, and the maximum for this board, which is a quarter of the turn cap rounded up.

A move into unexplored time may collide with a body you could not see when choosing it. The recorded body wins as a holder, and your move falls back normally.

## The screen

The play screen fills the window. A 46px bar across the top carries your colour, personal index, world turn, direction and tile, then the turn counter or the outcome, the connection and its dot, the state hash, and the theme and **New match** buttons. A chip appears beside your identity only when a front is walking toward you.

The log sits in the left rail and the actions in the right rail. Either folds to a 52px strip with the arrow button in its header; the folded actions strip carries a change-action button, a commit button, the priority dots stacked top to bottom, and a count of who is still choosing. The folded log strip counts the events it holds. While the log is folded, the last three events ride over the board as fading toasts. Below 1120px wide both rails stay folded.

The bottom dock holds the timeline strip, the world-turn scrub, and the history presets. Hover the strip's dashed block for the range of world turns you have not explored yet. The **?** button opens the legend on hover; it also lists the keyboard shortcuts.

Press and hold the world-turn scrub to raise the timeline instrument: one row per player, each row split into legs between inversions, beads for bodies filled or hollow by direction, and hatching beyond your horizon captioned with the turns it covers. An arc folds each leg into the next at the inversion that split them, and a red line marks the turn cap. Every row is the same height whatever its lane count, and carries that player's live index and direction, such as `p17 · back`, which is the only readout of a player whose present is past your horizon. The board dims and stops taking clicks while it is up. Release to drop back to the strip.

## Animation

A resolved turn plays over about a second as a sequence: bodies slide, then inversions and key changes, then fronts. A body slides to its new tile, a blocked move lunges a third of the way and springs back, an inversion widens the round token into the two-index pill while an arc over the tile doubles back into the new direction, a grab slides the key square across under a yellow ring that pulses once, and a lost key fades. When your colour holds two tiles, each leg slides on its own. Scrubbing one world turn at a time slides bodies the same way; longer jumps snap. Any key or click ends the animation, and the system **reduce motion** setting disables it.

## Bootstrap

The key sits on the center tile at `t0`. End an action on any tile beside the center to pick it up. The key attaches to the side you came from and shows as a small square on that side of your body. A key drawn on the center tile means nobody holds it at the focused world turn.

To steal, end an action on the tile beyond an opponent's key side at the same world turn. Recorded bodies can be robbed too. The log reports every pickup, steal, and loss.

Each grab starts a front that walks the key's earlier holders, two indices per turn. A triangle in the grabber's colour marks a front on the board and in its own strip row, and slides to its new tile when a turn resolves. Hover it for the turns until it reaches you, or read the chip in the top bar when it is aimed at you. When it reaches your present you lose the key, and any grab it passes is undone.

Win by ending an action at `t0` on a tile next to your own spawn while holding the key. Your spawn tile has a dashed outline in your colour. A match with no winner at the cap is a draw.

## Limits

This prototype has no weapons. Sandbox matches end at the turn cap.

The client hides events beyond your horizon, but another client can be modified to reveal them. Play with people you trust.
