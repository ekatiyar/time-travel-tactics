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
3. Each turn, the acting player copies one **action string** and sends it on:
   `12C:E#a3f1` is turn, colour, action, hash. Actions are `N` `S` `E` `W` to move, `I` to
   invert, `X` to pass when stuck.

The hash is of the pre-turn state. A string whose hash does not match is refused rather
than applied, so a desync is caught the moment it happens instead of drifting. `X1:` codes
export a whole match in progress.

## Defaults

| Setting | Default |
|---|---|
| Board | 16 × 9, configurable from 2 to 64 per side |
| Wall density | 11%, configurable up to 45% |
| Players | 4 (coral, purple, teal, amber), 2 minimum, spawning at fixed corners in palette order |
| Meta-turn cap | `ceil(1.7 × (w + h))`, so 43 on the default board |
| Inversion | Unlimited |

Both defaults for board size and wall density were picked by eye and are untested.

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
