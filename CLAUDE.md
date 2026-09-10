# tbtt

Turn-based time travel tactics. A design-stage game project: design docs and playable
prototypes, no game engine or build system.

```
README.md                            The repo landing page. Pitch and a link to the
                                     published prototypes.
index.html                           The GitHub Pages index. Links to the three
                                     prototypes, nothing else.
time-travel-tactics-design-doc.md    The main design doc. Mechanics, clocks, erasure
                                     fronts, win condition, v0 scope.
prototypes/
  prototypes.md                      What is built and what is not, by prototype.
                                     Start here.
  hosting.md                         What GitHub Pages can and can't serve. The
                                     limits every prototype works within.
  run_tests.py                       Shared test harness. Runs a prototype's tests.js
                                     against its HTML in headless Chromium.
  time_travel/
    time_travel_inversion.md         How to run and play this prototype.
    tbtt_prototype_time_travel_only.html   The playable engine, in one file.
    tests.js                         Engine tests. Run via run_tests.py.
  turn_transport/
    turn-transport.md                How turns move between players: the transport,
                                     commit-reveal, the seam. Start here for
                                     this prototype.
    tbtt_prototype_turn_transport.html     The engine plus a transport block.
                                     Same engine, byte-identical.
    tests.js                         Transport tests. Run via run_tests.py.
    tests.include                    Makes run_tests.py run the engine suite
                                     against this page too, before tests.js.
    live_check.py                    Two-phase handshake against real nostr
                                     relays. Slow, networked, run on its own.
  ui/
    prototype-ui.md                  UI design doc. View model, visual encoding,
                                     open questions.
    prototype-ui.html                Static mockup. Hardcoded bodies, no engine.
```

Run the tests with `uv run --with playwright python prototypes/run_tests.py`.

Write plainly. One idea per sentence, active voice, no em dashes, no filler. State mechanisms
and numbers, not impressions. Comment only non-obvious "why".
