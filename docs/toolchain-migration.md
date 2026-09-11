# Toolchain migration

A plan, not a record. Nothing here is built yet. When it lands, fold the outcome into
[`hosting.md`](hosting.md) and [`prototypes.md`](prototypes.md) and delete this file.

`play/index.html` is one file of 1947 lines because the old rule said a prototype had to be one
file that opened from `file://`. [`hosting.md`](hosting.md) dropped that rule. This plan spends
that freedom: split the file, declare dependencies in `package.json` instead of loading them
from a CDN, convert the source to TypeScript, and move the test harness onto standard runners.
No gameplay changes. The gun and erasure fronts are the next feature and are out of scope here.

## Decisions

Each of these was chosen over a named alternative. The alternative is listed so a later reader
knows it was considered.

**ES modules, not a single file.** Four seams already exist in `play/index.html`: styles at
7 to 122, engine at 294 to 851, transport at 854 to 1388, UI at 1391 to 1945. The split follows
them exactly.

**The split is mechanical.** It lands before the TypeScript conversion, as its own commit, with
no behaviour change. The engine and transport tests gate it.

**Trystero comes from `package.json`, not a vendored file and not esm.sh.** A vendored bundle
would freeze correctly but cannot be reviewed or patched. The CDN import makes every released
version depend on a live third-party URL forever. `turn-transport.md` section 4 explains the
CDN as a `file://` CORS workaround, which no longer applies.

**Full TypeScript, not JSDoc with `checkJs`.** JSDoc would keep the source runnable in a browser
with no build. Full TypeScript was chosen for the stronger type system. The cost is that running
the game locally now requires a build.

**esbuild, not Vite.** Vite's advantages are hot module replacement and asset handling, neither
of which this project needs with one HTML file and one stylesheet. The deciding constraint is
that `build_site.py` rebuilds every exported tag at deploy time, possibly years from now. One
pinned binary keeps working for longer than a plugin chain does.

**Build at deploy, for every ref that declares one.** `build_site.py` builds any exported tree
that has a `package.json`. Building at release time instead would keep tags self-contained, but
it would make cutting a release require a local build, which this project does not want.

**lit-html for the UI, not hand-written DOM updates.** Rebuilding the view wholesale on each
render is fast enough at this scale, but it discards element identity, so an erasure front
cannot animate as a sweep across the timeline. lit-html gives a keyed `repeat()` in about 5 kB
with no component model and no shadow DOM. Preact is the alternative if writing React is worth
more than 2 kB. Pick one before commit 8; see the open question.

**Engine tests run in Node, not in a browser.** The engine touches no DOM, so Chromium buys
nothing and costs seconds per run. The gun needs generated cases in the hundreds: random shot
sequences, cycle periodicity, liveness as a pure function of the log. Tests that slow are tests
that do not get written.

**Browser tests use `@playwright/test`, not `run_tests.py`.** The harness hand-rolls a server
thread, port selection, script injection and file ordering. The official runner does all four,
with `webServer` starting the server and test ordering replacing `tests.include`. It also adds
traces and retries, and it drops Python from the test job.

**`build_site.py` stays in Python.** It is a release script, not a build tool: archive each tag,
unpack it, assemble `_site`, read tag messages into `releases.json`. Node would shell out to git
the same way. More importantly, it runs outside the trees it builds, and tags v0.1 through v0.3
have no `package.json` at all. A site builder that shares the app's toolchain breaks when the
app's toolchain changes. GitHub runners ship Python, so keeping it costs nothing.

**`live_check.py` is deleted, not ported.** It is a manual diagnostic against live nostr relays.
It never ran in CI and it tests the relays more than it tests the game.

**A derived-state hash goes on the wire.** Each client hashes its derived state every meta-turn
and compares. Desync is the failure this project cannot reproduce locally, and retrofitting a
hash later means auditing every path for `Math.random`, `Date.now` and iteration-order
dependence. It lands with the transport conversion, while the wire format is already open.

**`.gitattributes` becomes an allowlist.** Today a forgotten line leaks a file to the site.
Inverted, a forgotten line means the site is missing a file, which fails loudly.

## Layout

```
package.json  package-lock.json  tsconfig.json  playwright.config.ts
play/
  index.html            markup, plus <script type="module" src="./dist/main.js">
  style.css             from index.html 7 to 122
  src/engine.ts         from 294 to 851
  src/transport.ts      from 854 to 1388
  src/ui.ts             from 1391 to 1945
  src/main.ts           imports the three in order
  dist/                 built output, gitignored
tests/
  engine.test.ts        Node, imports engine.ts directly
  transport.spec.ts     Playwright, from play/tests.js
tools/
  build_site.py         unchanged
```

Gone: `run_tests.py`, `play/tests.include`, `play/live_check.py`, `play/tests.engine.js`.

## Scripts

esbuild covers the build and the dev server, so the toolchain is one tool plus `tsc` and the two
test runners.

- `build`: `esbuild play/src/main.ts --bundle --splitting --format=esm --outdir=play/dist
  --sourcemap`
- `dev`: the same, plus `--servedir=play --watch`. One command runs the game locally.
- `typecheck`: `tsc --noEmit`. esbuild strips types without checking them, so this is separate
  and must run in CI.
- `test:engine`: `node --test`, with tsx for TypeScript. Not vitest, which pulls Vite in
  transitively and quietly undoes the esbuild decision.
- `test:browser`: `playwright test`. Its `webServer` config runs `npm run build` and serves
  `play/`.

`--splitting` keeps Trystero in its own chunk. The transport imports it dynamically at line 979
today so it loads when a match starts, not on page load. Preserve that.

## The test seam

`tests.engine.js` and `tests.js` reach only `window.TBTT` and `window.TBTT_TRANSPORT`, assigned
at lines 844 and 1382. That seam splits in two.

Engine tests stop using it. They import `engine.ts` directly in Node and get types, fast runs
and generated cases. `tests.engine.js` is deleted and rewritten as `tests/engine.test.ts`. This
is the one place in the migration where test code changes, and it gets its own commit so a
regression is attributable.

Transport and UI tests keep it. They need a real browser for WebRTC and for the DOM, so they
still reach the globals from a Playwright page. `main.ts` keeps both assignments alongside real
exports, which costs nothing and keeps `tests.js` a mechanical port rather than a rewrite.

## CI

`pages.yml` gains `actions/setup-node` with a pinned version, then `npm ci`, `npm run
typecheck`, `npm run test:engine`, and `npm run test:browser`, which needs a Chromium install.
Engine tests run first because they are fast and catch the most. Only then does
`tools/build_site.py` run, using the Python that GitHub runners already provide. A failing test
blocks the deploy. Tests run against the pushed ref only, never against old tags.

## build_site.py

After `export()` unpacks a ref, check the tree for `package.json`. If it has one, run
`npm ci && npm run build` in it. Tags v0.1 through v0.3 have none and publish exactly as they do
now. That `npm ci` installs test tooling the deploy does not use. Accept it rather than split
the manifest, because esbuild is a devDependency too.

Wrap each tag's build in `try`/`except`: log the failure and publish that tag's tree unbuilt.
A tag that stops building years from now must not take the whole site down.

The existing entry check only tests that the entry file exists. One file became six, so add a
check that the entry's local `src`, `href`, and relative imports resolve inside the exported
tree. A missing module is a silent 404 otherwise.

## .gitattributes

`git archive` reads attributes from the tree of the ref it archives, so this affects future tags
only. Negating a directory is not enough on its own, and yields an empty directory. The
recursive line is required.

```
* export-ignore
/index.html           -export-ignore
/play                 -export-ignore
/play/**              -export-ignore
/package.json         -export-ignore
/package-lock.json    -export-ignore
/tsconfig.json        -export-ignore
```

The three config files must stay in the export. The deploy build runs inside the exported tree
and needs them. `tests/` and `playwright.config.ts` need no lines of their own now that the
allowlist is inverted. `play/dist/` never appears here because it is gitignored and never
committed.

## Types worth designing

Two type designs carry most of the value. Without them the conversion is ceremony.

A discriminated union for the action log, so the wire encoder in `transport.ts` and `_derive` in
`engine.ts` cannot drift. A desync is not a crash. It appears only between two machines and is
hard to reproduce. The state hash checks the same boundary at runtime; the union is what makes
the check rarely fire.

Branded number types for the three index spaces section 11 of the design doc keeps separate:
world turn, personal index, playhead. All three are bare `number` today. Mixing them is the bug
class the design doc warns about, and it is the bug class erasure fronts will walk straight
into, since front arithmetic combines a personal index and a meta-turn in one expression.

## Commit order

Conversion follows the dependency order. `transport` reads `root.TBTT` and `ui` depends on both,
so engine goes first. Converting transport first would type the engine's surface as `any` and
require redoing it.

1. `.gitattributes` allowlist. Verify with `git archive --format=tar HEAD | tar -t`.
2. Toolchain: `package.json`, `package-lock.json`, `tsconfig.json`, `.gitignore` for
   `play/dist/` and `node_modules/`, esbuild scripts, `build_site.py`, `pages.yml`.
3. Mechanical split into modules, still `.js`. No behaviour change.
4. Browser tests to `@playwright/test`. Delete `run_tests.py`, `tests.include` and
   `live_check.py`. Tests into CI.
5. `engine.js` to TypeScript.
6. Engine tests to Node. Delete `tests.engine.js`.
7. `transport.js` to TypeScript. Drop the esm.sh URL at line 958 for the package import. Add the
   state hash to the wire.
8. `ui.js` to TypeScript, rendering through lit-html.
9. Docs: `hosting.md`, `turn-transport.md` section 4, `CLAUDE.md` file map, `playing.md`.

No tag until the gun lands. A refactor release ships nothing playable.

## Known cost

`play/dist/` is gitignored, so a tag is playable only if it still builds at deploy time. The
`try`/`except` degrades a broken tag instead of breaking the site, but "an old version stays
playable" is now best effort rather than guaranteed. That is the price of never building locally
to cut a release.

lit-html is a second runtime dependency after Trystero. The project had one on purpose.

Engine tests no longer run in a browser. The engine touches no DOM today, so the risk is small,
but nothing enforces that. If the engine ever reaches for a browser API, Node tests will catch
it as a crash rather than as a silent difference, which is the acceptable failure mode.

## Open question

lit-html or Preact for commit 8. lit-html is smaller and needs no compiler step. Preact is the
React API in 3 kB, which matters only if reading React answers while stuck is worth more than
the size difference. Both give the keyed rendering the erasure animation needs. Decide on
familiarity, not on merit, because the merits are close.
