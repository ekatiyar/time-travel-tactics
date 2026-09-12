# Playing

How to run and use `play/index.html`. It loads an ES module bundle, so it needs a server;
`file://` cannot load one. Run `npm run dev` and open the printed address, or visit the
published site.

The rules come from §3 and §4 of
[`time-travel-tactics-design-doc.md`](time-travel-tactics-design-doc.md). How turns cross the
network is [`turn-transport.md`](turn-transport.md).

## Starting a match

One player creates, everyone else joins with a code.

1. The host picks board size, wall density, seed, turn cap and player count, then presses
   **Create match**.
2. The host copies the **match code** and sends it out. `M1:16x9:11:19f4:43:CPTA` is version,
   size, wall density, seed, meta-turn cap, roster. Anyone who pastes it under **Join a match**
   builds a byte-identical board.
3. Each player claims a colour and types a name. Claims cross as they happen, so a colour
   someone else took greys out under your cursor. When two players claim the same colour at
   once, the lower client id keeps it and both clients work that out on their own.
4. **Play** unlocks once every seat in the roster is filled, and until then it says how many
   players are missing. Nothing can open a turn until everyone is in, so starting early would
   only hang.

**Import a match** takes a full export instead of a match code. Use it after a reload, or to
pull someone back in step who dropped.

Nothing is saved and there is no reconnect, so copy the export box on the left if you might
reload. `X1:<match code>|<actions>|C~Rook,P~Vale` carries the config, every action so far, and
the names. Two-section exports with no name section still load.

## Taking a turn

Everyone moves at once, and nobody gets to see a move before making theirs.

1. Aim with the D-pad, the arrow keys or `W` `A` `S` `D`. Press **Commit**, or Enter.
2. Your client publishes a hash of your action rather than the action. The panel names whoever
   it is still waiting on.
3. When the last hash lands, every client opens together and the turn resolves.

Until that last hash lands you can change your mind. **Change my action** and Escape both put
you back in the picking phase with nothing committed, and neither the turn number nor the state
hash moves. Once your action is out in the open the button leaves, because there is nothing
left to take back.

No copying, no pasting, no chat window on the side. What the handshake does and does not
protect against is [`turn-transport.md`](turn-transport.md) §5.

Every action carries a hash of the state before it. A client that has drifted is refused rather
than applied, so you find out the moment it happens instead of quietly playing a different game.

### Names

A name is 1 to 12 characters of letters, digits, `-` and `_`. Anything outside the set is
refused at the input rather than quietly stripped, so nobody types a tilde and ends up called
something else. Duplicates are allowed. Uniqueness needs a server.

Names are display-only. The wire, the state hash and every internal identifier stay on colour
codes, so two players who disagree about a name still agree about the game.

## Holding and inverting

Neither action changes your (x, y). They differ in what they spend.

**Hold** spends the world turn without the step. Your playhead advances by your direction, your
personal index goes up by one, and you stay where you are. It is a holder under §4's collision
rules, so it keeps the square against any mover arriving on it, whatever the public priority
order says. A hold can still be refused. The tile you are holding into may already be recorded
to another colour, and an inverted player at t0 is holding into a turn that does not exist.

**Invert** spends no world turn at all. Your direction flips and your personal index goes up by
one, but `t` does not move, so you finish stacked on your own forward body at a single
`(t, x, y)`. That is the turnstile, and the board draws it as both indices joined, `1·2`. Its
target is a tile you already occupy, so bounds, walls and the same-colour occupancy exemption
all pass, and inverting can never be blocked. That is why the prototype has no pass action.
There is no state in which a player has nothing legal to do.

Inverting twice running is therefore a legal stall. You sit at the same world turn with three
bodies stacked and your personal index up by two. This is deliberate. Stalling freezes your own
horizon while everyone else pushes the frontier forward. Personal index is what erasure fronts
eat in later versions, so the stall buys time at a price.

## Defaults

| Setting | Default |
|---|---|
| Board | 16 × 9, configurable from 2 to 64 per side |
| Wall density | 11%, configurable up to 45% |
| Players | 4 (coral, purple, teal, amber), 2 minimum, spawning at fixed corners in palette order |
| Meta-turn cap | `ceil(1.7 × (w + h))`, so 43 on the default board, configurable from 2 to 400 |
| Seed | Six random base-36 characters, editable; 1 to 24 of letters, digits, `-` and `_` |
| Inversion | Unlimited |
| Look back | `ceil(cap / 4)`, so 11 turns on the default board, and it starts at its cap |
| Names | 1 to 12 characters, letters, digits, `-` and `_` |

Board size and wall density were picked by eye and are untested. The engine refuses a config
outside the ranges above, checked there and not just on the setup form. Without the bound, a
typed 999 builds a 998001-cell board and freezes the tab. The seed is bounded for a different
reason. It travels inside the match code between colons, so a seed carrying a colon would make
the code ambiguous to split.

## The interface

Three columns. Log and export on the left, board in the centre, turn panel on the right.

Actions are a D-pad: four arrows around a centre hold button, with invert on its own below.
Arrows or `W` `A` `S` `D` aim, Enter commits, Escape drops the aim and returns to the default.
The default is hold when hold is legal and invert when it is not. Invert is the fallback
because a player walking backwards who has reached turn 0 can neither move nor hold, so Commit
would otherwise sit dead with nothing pointing at it. Inverting has no key on purpose. It flips
your direction, and that should not sit one keystroke from a movement key.

The line at the top of the turn panel is the transport: connected or not, how many peers you
can see, and how many players are still missing. Watch it when a turn stops resolving.

The log accumulates across the whole match rather than showing only the last turn.

Look back sets how many world turns of history the board and the strip draw behind your focus
turn. At the full turn cap every dot ever recorded lands in one cell, so look-back maxes out at
a quarter of the turn cap, and starts there.

## What it does not do

No weapons and no win condition. It is a sandbox with no objective that runs until the
meta-turn cap. See [`prototypes.md`](prototypes.md) for the full split.

**The horizon is honour-system.** The UI hides beyond-horizon information, but a beyond-horizon
move is present in the action string regardless, so a modified client can read it. Play with
people you trust.

## Tests

`tests/engine.test.ts`, `tests/transport.test.ts` and `tests/peer-channel.test.ts` run under
`node --test`. `tests/ui.spec.ts` drives the built page in Chromium with `@playwright/test`.
`npm test` runs the node suites then the UI suite; `npm run test:node` and `npm run test:ui` run
them separately. `tests/live.spec.ts` opens two real pages against real nostr relays; it is slow,
networked, and run by hand with `npm run test:live`, never in CI.
