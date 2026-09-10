# tbtt

Turn-based time travel tactics. A design-stage game project: design docs and a playable
prototype, no game engine or build system.

One line of development. `play/` is the current prototype; older ones are git tags, published
at `/v/<tag>/` on the site rather than kept as folders here.

```
README.md                  The repo landing page. Pitch and a link to the published site.
index.html                 The GitHub Pages front page. A card for the tip of master, then
                           one per release, read from the built releases.json.
run_tests.py               Test harness. Runs a prototype's tests against its HTML in
                           headless Chromium. Defaults to play/.
tools/
  build_site.py            Builds _site: master's tip at the root, every v* tag under v/.
                           Cards come from the tag messages.
.github/workflows/
  pages.yml                Runs build_site.py and deploys to Pages, on a push to master or
                           a v* tag.
play/
  index.html               The prototype, in one file. Engine plus transport.
  tests.engine.js          Engine tests.
  tests.js                 Transport tests.
  tests.include            Makes run_tests.py run tests.engine.js first.
  live_check.py            Two-phase handshake against real nostr relays. Slow, networked,
                           run on its own.
docs/
  time-travel-tactics-design-doc.md   The main design doc. Mechanics, clocks, erasure
                                      fronts, win condition, v0 scope.
  prototypes.md            What is built and what is not, and which version it landed in.
                           Start here.
  playing.md               How to run and play the prototype.
  turn-transport.md        How turns move between players: the transport, commit-reveal,
                           the seam.
  hosting.md               What Pages can and can't serve, and how to cut a release.
  prototype-ui.md          UI design doc. View model, visual encoding, open questions.
```

Run the tests with `uv run --with playwright python run_tests.py`.

Preview the site with `python tools/build_site.py --root-ref HEAD` then
`python3 -m http.server -d _site`.

Write plainly. One idea per sentence, active voice, no em dashes, no filler. State mechanisms
and numbers, not impressions. Comment only non-obvious "why".
