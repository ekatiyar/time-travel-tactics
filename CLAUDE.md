# tbtt

Turn-based time travel tactics. A design-stage game project: two design documents and two
prototypes, no engine or build system.

```
time-travel-tactics-design-doc.md    The main design doc. Mechanics, clocks, erasure
                                     fronts, win condition, v0 scope.
prototypes/
  prototypes.md                      What is built and what is not, by prototype.
                                     Start here.
  run_tests.py                       Shared test harness. Runs a prototype's tests.js
                                     against its HTML in headless Chromium.
  time_travel/
    time_travel_inversion.md         How to run and play this prototype.
    tbtt_prototype_time_travel_only.html   The playable engine. One static file.
    tests.js                         Engine tests. Run via run_tests.py.
  turn_transport/
    turn-transport-handoff.md        Investigation and decisions for moving turns
                                     between players. Start here.
    tbtt_prototype_turn_transport.html     The engine plus a transport block.
                                     Same engine, byte-identical.
    tests.js                         Transport tests. Run via run_tests.py.
    live_check.py                    Two-phase handshake against real nostr
                                     relays. Slow, networked, run on its own.
  ui/
    prototype-ui.md                  UI design doc. View model, visual encoding,
                                     open questions.
    prototype-ui.html                Static mockup. Hardcoded bodies, no engine.
```

Run the tests with `uv run --with playwright python prototypes/run_tests.py`.

Prose in the design docs is worked prose, not notes. Match its register when editing.
