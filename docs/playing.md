# Playing

Run `npm run dev` and open the printed address, or use the [published game](https://ekatiyar.github.io/time-travel-tactics/).

[`prototypes.md`](prototypes.md) lists what the prototype supports. The [design document](time-travel-tactics-design-doc.md) explains the rules.

## Start a match

One player creates a match and shares its code. Each player chooses a colour and a name. Play opens when every colour in the roster has a player.

Copy the export before reloading or leaving. Import it to resume the match elsewhere.
Exported names stay fixed. Choose your saved seat to rejoin; enter a name only for an unnamed seat. A seat frees when its player disconnects; connected seats stay taken.

## Take a turn

Choose an action with the D-pad, arrow keys, or `W` `A` `S` `D`, then commit it with Enter. Your choice stays private until every player commits. You can change it until the turn opens.

Hold advances through world time without moving. Invert changes your direction without advancing world time. The board shows your current action and which players are still deciding.

The world-turn and look-back controls change what history you see. They do not change the match.

A move into unexplored time may collide with a body you could not see when choosing it. The recorded body wins as a holder, and your move falls back normally.

## Limits

This prototype has no weapons or win condition. It ends at the turn cap.

The client hides events beyond your horizon, but another client can be modified to reveal them. Play with people you trust.
