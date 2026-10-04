# Playing

Run `npm run dev` and open the printed address, or use the [published game](https://ekatiyar.github.io/time-travel-tactics/).

[`prototypes.md`](prototypes.md) lists what the prototype supports. The [design document](time-travel-tactics-design-doc.md) explains the rules.

## Start a match

Choose **Bootstrap** (bring the key home) or **Sandbox** (movement and inversion with no winner), a board size, and 2, 3, or 4 players. Two players is the default. The preview shows the exact walls and fixed spawns. Choose one of three seed previews or **Reroll** for three new candidates.

**Advanced** contains exact dimensions (5–64 on each side), wall density (0–45%), turn cap (2–400), and seed. Changing size updates the suggested cap until you edit the cap yourself. Invalid settings disable creation and hide the preview.

Create a match, then use **Copy join link** to invite the other players. The creator receives Coral; joining players receive the next available colour. Colours have fixed spawns; there is no spawn picker. Edit your name in your own roster row, then press **Ready**. Names use 1–12 letters, digits, hyphens, or underscores.

The match starts when all configured seats are occupied, everyone is ready, and the browsers agree on the roster and saved game. Changing your name clears your readiness; another player's name change does not. There is no separate Start button or countdown.

At the start, including turn 0, the address becomes a resume link containing the frozen names and saved match. It updates after every completed turn. **Copy resume link** shares this saved game. No account or stored browser identity is needed.

**New match** starts over with fresh seeds and the default settings. It asks for confirmation when leaving a started or resumed match.

## Disconnecting and resuming

When someone disconnects, their seat becomes available and actions pause. Open the current resume link, choose an available historical colour, and press **Ready**. Its name and history stay fixed. Anyone with the link can take an available seat; connected players cannot be displaced.

The host coordinates seats and readiness. Hosting transfers when the host leaves; it is independent of colour. Opening a resume link alone makes you the provisional host, and you can choose any available colour. Play still waits for every configured player.

Every browser calculates completed turns locally. The resume link is the saved game; browsers do not send each other saved histories or automatically catch up. If snapshots differ—even by one completed turn—play pauses. Use **Copy my resume link**, agree which link the group wants to use, and have everyone open that same link. The game does not choose or overwrite a history for you. A stale visitor does not interrupt an already playing group.

An interrupted, incomplete turn may need new choices. Choices already revealed before the interruption cannot become secret again. If disconnected groups continue separately and later meet with different histories, use the same shared-link recovery.

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
