# Time-travel prototype

A playable prototype of the time-travel layer alone. Open
`tbtt_prototype_time_travel_only.html` in any browser straight off the filesystem. One
static file, no build step, no server.

The rules it implements are §3 and §4 of
[`../../time-travel-tactics-design-doc.md`](../../time-travel-tactics-design-doc.md); this
file covers how to run and use it.

## Running a match

There is no server, so players pass strings.

1. One player sets up the board and copies the **match code**, which encodes the whole
   config: `M1:16x9:11:19f4:43:CPTA` is version, size, wall density, seed, meta-turn cap,
   roster.
2. Everyone else pastes that code and gets a byte-identical board.
3. On the setup screen each player claims a colour and types a **name** beside it, then
   presses Play. A name is 1 to 12 characters of letters, digits, `-` and `_`. Space is
   not among them, because an action string carries the name after a `~` and the paste box
   splits what you paste on whitespace, so a name with a space in it tore in half and
   silently renamed you to its first word. Anything outside the set is refused at the input
   rather than quietly stripped, so nobody types a tilde and ends up called something else.
   Duplicates are allowed: uniqueness is unenforceable without a server.
4. Each turn, the acting player copies one **action string** and sends it on:
   `12C:D#a3f1` is turn, colour, action, hash. Actions are `W` `A` `S` `D` to step up,
   left, down and right on screen, `H` to hold, and `I` to invert. A turn-0 string carries
   the sender's name as well, `0C:D#a3f2~Rook`; turns after that do not, because by then
   everyone has it.

The hash is of the pre-turn state. A string whose hash does not match is refused rather
than applied, so a desync is caught the moment it happens instead of drifting. Names sit
outside all of that. They are display-only, and the wire, the state hash and every internal
identifier stay on colour codes, so until a player's turn-0 string reaches you their colour
name stands in.

`X1:` codes export a whole match in progress. They carry every name they know in a third
`|`-delimited section, as in `X1:<match code>|<actions>|C~Rook,P~Vale`. Two-section exports
from before names existed still load.

## Holding and inverting

Neither action changes your (x, y). They differ in what they spend.

**Hold** spends the world turn without the step. Your playhead advances by your direction,
your personal index goes up by one, and you stay where you are. It is a holder under §4's
collision rules, so it keeps the square against any mover arriving on it, whatever the
public priority order says. It can still be refused: the tile you are holding into may
already be recorded to another colour, and for an inverted player at t0 it is off the start
of time.

**Invert** spends no world turn at all. Your direction flips and your personal index goes
up by one, but `t` does not move, so you finish stacked on your own forward body at a single
`(t, x, y)`. That is the turnstile, and the board draws it as both indices joined, `1·2`.
Its target is a tile you already occupy, so bounds, walls and the same-colour occupancy
exemption all pass and inverting can never be blocked. Which is why the prototype has no
pass action: there is no state in which a player has nothing legal to do.

It follows that inverting twice running is a legal stall. You sit at the same world turn
with three bodies stacked and your personal index up by two. This is deliberate. Stalling
freezes your own horizon while everyone else pushes the frontier forward, and personal
index is what erasure fronts eat in later versions, so the stall buys time at a price.

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

Both defaults for board size and wall density were picked by eye and are untested. The
match config refuses anything outside the ranges above. They used to live only on the setup
form's `max` attributes, where nothing checked them, so a typed 999 built a 998001-cell board
and froze the tab. The seed is bounded for a different reason: it travels inside the match
code between colons, so a seed carrying a colon would make the code ambiguous to split.

## The interface

Three columns. The running log and the export box on the left, the board in the centre, the
turn panel on the right.

Actions are a D-pad: four arrows around a centre hold button, with invert on its own below.
Arrows or `W` `A` `S` `D` aim, Enter commits, Escape drops the aim and returns to the
default, which is hold when hold is legal and invert when it is not. Invert is the fallback
because a player walking backwards who has reached turn 0 can neither move nor hold, and
Commit used to sit dead there with nothing pointing at it. Inverting has no key on purpose.
It flips your direction, and that should not sit one keystroke from a movement key. Once
you have committed, Enter applies whatever is in the paste box instead, so long as the
cursor is not inside the box itself, where Enter has to stay a newline because several
strings can go in at once.

You can take an action back before you send it. The share panel has a **Change my action**
button, and Escape does the same from there, because Escape means undo the last step of this
turn in both phases. You land back in the picking phase with nothing committed, and neither
the turn number nor the state hash moves. It only works while the turn is still open, which
in practice is always: the paste box is hidden until you commit, so you can never be the last
player in. Like the horizon, it is honour-system. If you have already sent the string and
somebody pasted it, they keep the action you took back: your replacement is refused as a
repeat, and neither of you finds out until your next string carries a hash they disagree
with. The prototype does not try to stop you, it just tells you afterwards.

The log accumulates across the whole match rather than showing only the last turn.

Look back sets how many world turns of history the board and the strip draw behind your
focus turn. Running it to the full turn cap put every dot ever recorded into one cell, so it
caps at a quarter of the cap instead, and starts there.

## What it does not do

No weapons and no win condition. It is a sandbox with no objective that runs until the
meta-turn cap. See [`../prototypes.md`](../prototypes.md) for the full split.

**The horizon is honour-system.** The UI hides beyond-horizon information, but a
beyond-horizon move is present in the action string regardless, so a modified client can read
it. Play with people you trust.

## Tests

`tests.js` holds the assertions. The harness is shared and lives one level up:

```
uv run --with playwright python ../run_tests.py time_travel
```

It loads the page in headless Chromium, injects `tests.js`, and calls `runTests()`, because
there is no node on this machine. Run it from anywhere with the path adjusted; the argument
is resolved against the harness's own directory and defaults to `time_travel`.
