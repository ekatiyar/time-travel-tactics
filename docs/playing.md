# Playing

Run `npm run dev` and open the printed address, or use the [published game](https://ekatiyar.github.io/time-travel-tactics/).

[`prototypes.md`](prototypes.md) lists what the prototype supports. The [design document](time-travel-tactics-design-doc.md) explains the rules.

## Start a match

Create a match, then use **Copy join link** in the lobby to share it. Opening the link goes straight to that match's lobby.

Choose a colour and enter a name in the shared Name field. Your draft follows you between free colours. Selecting a saved or occupied colour shows its fixed name. If two players claim one colour, the loser returns to the lobby and sees the winner's name. Disconnected seats become free again.

After you click Play, the browser address becomes a resume link and updates after each completed turn. Use it to reopen or share the current match.

**New match** starts over with a new seed. It asks for confirmation during play.

## Take a turn

Choose an action with the D-pad, arrow keys, or `W` `A` `S` `D`, then commit with Enter or Space. Shortcuts do nothing while a control has focus. Your choice stays private until every player commits, and you can change it until the turn opens.

Hold advances through world time without moving. Invert changes your direction without advancing world time. **Still choosing** lists everyone who has not committed, including you.

Body markers are filled when moving in your direction and outlined when moving in the opposite direction. A half-filled stack contains both directions. Trail and timeline dots use the same filled or outlined style.

Stacks show up to two personal indices. Larger stacks show the first and last, such as `16 … 18`; hover text lists them all.

The world-turn and look-back controls change what history you see. They do not change the match.

A move into unexplored time may collide with a body you could not see when choosing it. The recorded body wins as a holder, and your move falls back normally.

## Limits

This prototype has no weapons or win condition. It ends at the turn cap.

The client hides events beyond your horizon, but another client can be modified to reveal them. Play with people you trust.
