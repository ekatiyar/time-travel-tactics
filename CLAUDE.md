# tbtt

Turn-based time travel tactics. A design-stage game project: design docs and a playable
prototype, no game engine or build system.

One line of development. `play/` is the current prototype; older ones are git tags, published
at `/v/<tag>/` on the site rather than kept as folders here.

```
README.md                  The repo landing page. Pitch and a link to the published site.
index.html                 The GitHub Pages front page. A card for the tip of master, then
                           one per release, read from the built releases.json.
package.json               Dependencies and npm scripts.
package-lock.json
tsconfig.json              TypeScript settings. esbuild reads the JSX ones from here too.
playwright.config.ts       The ui and live projects, and the server they run against.
.node-version              Node 22. actions/setup-node reads it in CI.
play/
  index.html               Markup only: a head, <div id="app">, and a module script
                           pointing at dist/main.js.
  style.css
  src/
    engine.ts              Rules. Pure, no DOM.
    transport.ts           Session, match codes, PeerChannel, LoopbackChannel.
    ui.tsx                 Preact components.
    main.ts                Composition root. Applies the theme, passes the room loader
                           to App, renders.
  dist/                    esbuild output. Gitignored.
tests/
  engine.test.ts           node --test
  transport.test.ts        node --test
  peer-channel.test.ts     node --test. PeerChannel against a fake room.
  ui.spec.ts               @playwright/test. The UI in Chromium.
  live.spec.ts             @playwright/test. Two real pages over real nostr relays.
                           Manual only.
tools/
  build_site.py            Builds _site: master's tip at the root, every v* tag under
                           v/. Cards come from the tag messages. Any exported ref with
                           a package.json gets built first.
  serve.mjs                Static server for the Playwright tests.
.github/workflows/
  pages.yml                Three jobs: test, build, deploy. test runs on pull requests
                           too and does not deploy.
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

Install with `npm ci`. `npm run dev` rebuilds on change and serves `play/`. `npm run build`
writes `play/dist/`. `npm run typecheck` runs `tsc --noEmit`. `npm test` runs the node suites
then the UI suite; `npm run test:node`, `npm run test:ui` and `npm run test:live` run them
separately. `test:live` is slow and networked and never runs in CI.

Preview the site with `python tools/build_site.py --root-ref HEAD` then
`python3 -m http.server -d _site`.

Write plainly. One idea per sentence, active voice, no em dashes, no filler. State mechanisms
and numbers, not impressions. Comment only non-obvious "why".
