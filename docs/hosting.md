# Hosting

Read this before building a new prototype. What's built and what isn't is in
[`prototypes.md`](prototypes.md).

## Where this runs

GitHub Pages, served at `https://ekatiyar.github.io/time-travel-tactics/`. Anything Pages can
serve is fair game. Don't assume tighter limits than that.

`.github/workflows/pages.yml` builds the site and deploys the result, so nothing about the
repo's layout has to match the site's. `tools/build_site.py` does the work: `master`'s tip goes
to the root, and every annotated `v*` tag is exported to `/v/<tag>/`. That is how old versions
stay playable without living in the working tree. To release, tag and push:

```
git tag -a v0.4 -m "Title" -m "One sentence for the card."
git push origin master v0.4
```

The tag's subject becomes the card title and its body the blurb. An `entry: <path>` line in the
body points at the playable file inside that tag's tree; without one the build looks for
`play/index.html` and fails the deploy if it isn't there. Build the site locally the same way CI
does:

```
python tools/build_site.py --root-ref HEAD
python3 -m http.server -d _site
```

## You can

- Split a prototype across as many files as you want. ES modules import by relative path.
- `fetch` JSON, images, anything else sitting beside the page.
- Add a build step. The workflow already runs one, so extend `tools/build_site.py` or add a step
  ahead of it.
- Use `crypto.subtle`, service workers, WebRTC. The origin is HTTPS, so they all work.
- Use `localStorage`. One store, shared by every version, so prefix your keys unless you want the
  sharing. `tbtt-theme` wants it; it's the only key stored today. Anything a version persists
  about a match in progress needs its version in the key, or a released copy and the tip will
  read each other's state.

## You can't

- **Run code outside the browser.** No request handler, no database, no cron.
- **Put an API key anywhere.** Everything the page loads is public, so services that need one
  are out. This is what rules out TURN servers, Firebase and friends.
- **Set response headers.** So no `SharedArrayBuffer`, which needs cross-origin isolation.
- **Route.** A URL that isn't a file 404s. Client-side routing has to live in the hash.

## No server means no shared truth

Every client works out the game state on its own. Anything two clients could disagree about
needs a rule they both run to the same answer:

- **Contested colours.** Two players pick coral. Lower client id keeps it, and both clients
  work that out independently.
- **Simultaneous moves.** Nothing can hold turn N until everyone has submitted, so players
  publish a hash of their move first, then open together.
- **Drift.** Every move carries a hash of the state before it, and a mismatch is refused. It's
  how you find out two clients have diverged instead of quietly playing different games.

The horizon (design doc §4) is honour-system for the same reason. The client hides turns past
it; nothing enforces it. Fine for a prototype.

## Four things that bite

- Paths are case-sensitive on the server and usually aren't on your machine. A link that works
  locally can 404 once published.
- The site lives at `/time-travel-tactics/`, not a domain root, and a released copy sits deeper
  still at `/time-travel-tactics/v/v0.3/`. Links and imports must be relative. A leading `/`
  points outside the site, and `../` walks out of the version.
- A tag is frozen. Fixing a released version means moving the tag, which rewrites what that URL
  serves. Cut a new tag instead unless the old one was outright broken.
- `.gitattributes` marks everything that isn't the site `export-ignore`, so the published root
  is `index.html` and `play/` and nothing else. Split the prototype across files and the new
  ones publish fine, but a new top-level directory does not until you check that list.

## Two rules that no longer apply

**One self-contained HTML file per prototype.** It bought a file you could hand someone, and no
toolchain to install before editing. The published site covers both.

**Running from `file://`.** That was the dev loop, never a hosting requirement. `play/index.html`
loads an ES module bundle from `play/dist/`, and `file://` cannot load a module. Use
`npm run dev`, which rebuilds on change and serves `play/`. For the whole repo, including the
front page:

```
python3 -m http.server
```

The front page never opened from `file://` anyway, because it reads `releases.json` over
`fetch`, which `file://` blocks.
