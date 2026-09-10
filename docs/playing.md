# Playing

How to run and use the prototype in `play/index.html`. Open it in any browser straight off
the filesystem. One static file, no build step, no server.

The rules it implements are §3 and §4 of
[`time-travel-tactics-design-doc.md`](time-travel-tactics-design-doc.md).

## Running a match

There is no server, so players pass strings.

1. One player sets up the board and copies the **match code**, which encodes the whole
   config: `M1:16x9:11:19f4:43:CPTA` is version, size, wall density, seed, meta-turn cap,
   roster.
2. Everyone else pastes that code and gets a byte-identical board.
3. On the setup screen each player claims a colour and types a **name** beside it, then
   presses Play.
4. Each turn, the acting player copies one **action string** and sends it on:
   `12C:D#a3f1` is turn, colour, action, hash. Actions are `W` `A` `S` `D` to step up,
   left, down and right on screen, `H` to hold, and `I` to invert. A turn-0 string carries
   the sender's name as well, `0C:D#a3f2~Rook`; turns after that do not, because by then
   everyone has it.

A name is 1 to 12 characters of letters, digits, `-` and `_`. The paste box splits on
whitespace and an action string carries the name after a `~`, so a name with a space in it
would tear in half. Anything outside the set is refused at the input rather than quietly
stripped, so nobody types a tilde and ends up called something else. Duplicates are allowed.
Uniqueness needs a server.

The hash is of the pre-turn state. A string whose hash does not match is refused rather
than applied, so a desync is caught the moment it happens instead of drifting. Names sit
outside all of that. They are display-only. The wire, the state hash and every internal
identifier stay on colour codes. Until a player's turn-0 string reaches you, their colour
name stands in.

`X1:` codes export a whole match in progress. They carry every name they know in a third
`|`-delimited section, as in `X1:<match code>|<actions>|C~Rook,P~Vale`. Two-section exports
with no name section still load.

## Holding and inverting

Neither action changes your (x, y). They differ in what they spend.

**Hold** spends the world turn without the step. Your playhead advances by your direction,
your personal index goes up by one, and you stay where you are. It is a holder under §4's
collision rules, so it keeps the square against any mover arriving on it, whatever the
public priority order says. A hold can still be refused. The tile you are holding into may
already be recorded to another colour, and an inverted player at t0 is holding into a turn
that does not exist.

**Invert** spends no world turn at all. Your direction flips and your personal index goes
up by one, but `t` does not move, so you finish stacked on your own forward body at a single
`(t, x, y)`. That is the turnstile, and the board draws it as both indices joined, `1·2`.
Its target is a tile you already occupy, so bounds, walls and the same-colour occupancy
exemption all pass and inverting can never be blocked. That is why the prototype has no
pass action. There is no state in which a player has nothing legal to do.

Inverting twice running is therefore a legal stall. You sit at the same world turn
with three bodies stacked and your personal index up by two. This is deliberate. Stalling
freezes your own horizon while everyone else pushes the frontier forward. Personal
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

The defaults for board size and wall density were picked by eye and are untested. The match
config refuses anything outside the ranges above, checked in the engine and not just on the
setup form. Without the bound, a typed 999 builds a 998001-cell board and freezes the tab.
The seed is bounded for a different reason. It travels inside the match code between
colons, so a seed carrying a colon would make the code ambiguous to split.

## The interface

Three columns. The running log and the export box on the left, the board in the centre, the
turn panel on the right.

Actions are a D-pad: four arrows around a centre hold button, with invert on its own below.
Arrows or `W` `A` `S` `D` aim, Enter commits, and Escape drops the aim and returns to the
default. The default is hold when hold is legal and invert when it is not. Invert is the
fallback because a player walking backwards who has reached turn 0 can neither move nor
hold, so Commit would otherwise sit dead with nothing pointing at it. Inverting has no key
on purpose. It flips your direction, and that should not sit one keystroke from a movement
key. Once you have committed, Enter applies whatever is in the paste box. The exception is
when the cursor sits inside the box, where Enter stays a newline, since several strings can
go in at once.

You can take an action back before you send it. The share panel has a **Change my action**
button, and Escape does the same, because Escape means undo the last step of this turn in
both phases. You land back in the picking phase with nothing committed, and neither the turn
number nor the state hash moves. It only works while the turn is still open, which in
practice is always. The paste box is hidden until you commit, so you can never be the last
player in. Like the horizon, it is honour-system. If you have already sent the string and
somebody pasted it, they keep the action you took back. Your replacement is refused as a
repeat, and neither of you finds out until your next string carries a hash they disagree
with.

The log accumulates across the whole match rather than showing only the last turn.

Look back sets how many world turns of history the board and the strip draw behind your
focus turn. At the full turn cap every dot ever recorded lands in one cell, so look-back
maxes out at a quarter of the turn cap, and starts there.

## What it does not do

No weapons and no win condition. It is a sandbox with no objective that runs until the
meta-turn cap. See [`prototypes.md`](prototypes.md) for the full split.

**The horizon is honour-system.** The UI hides beyond-horizon information, but a
beyond-horizon move is present in the action string regardless, so a modified client can read
it. Play with people you trust.

## Tests

`play/tests.engine.js` holds the engine assertions and `play/tests.js` the transport ones.
The harness runs both, from the repo root:

```
uv run --with playwright python run_tests.py
```

It loads the page in headless Chromium, injects each test file, and calls `runTests()`,
because there is no node on this machine. Run it from anywhere with the path adjusted; the
harness resolves its argument against its own directory and defaults to `play`.
