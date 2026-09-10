# Hosting

Read this before building a new prototype. What's built and what isn't is in
[`prototypes.md`](prototypes.md).

## Where this runs

GitHub Pages, publishing from `master` at the repo root, served at
`https://ekatiyar.github.io/time-travel-tactics/`. Anything Pages can serve is fair game. Don't
assume tighter limits than that.

## You can

- Split a prototype across as many files as you want. ES modules import by relative path.
- `fetch` JSON, images, anything else sitting beside the page.
- Add a build step. Pages publishes the branch as-is today, so you'd switch the Pages source to
  a GitHub Actions workflow.
- Use `crypto.subtle`, service workers, WebRTC. The origin is HTTPS, so they all work.
- Use `localStorage`. One store, shared by every prototype, so prefix your keys unless you want
  the sharing. `tbtt-theme` wants it.

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

## Three things that bite

- Paths are case-sensitive on the server and usually aren't on your machine. A link that works
  locally can 404 once published.
- The site lives at `/time-travel-tactics/`, not a domain root. Links and imports must be
  relative. A leading `/` points outside the site.
- Branch publishing runs everything through Jekyll, which skips names starting with `_` or `.`,
  so a directory called `_engine` silently doesn't publish. A `.nojekyll` file at the repo root
  turns it off. Worth doing before it costs someone an afternoon.

## Two rules that no longer apply

**One self-contained HTML file per prototype.** It bought a file you could hand someone, and no
toolchain to install before editing. The published site covers both.

**Running from `file://`.** That was the dev loop, never a hosting requirement. It's also why
the transport prototype loads Trystero from esm.sh instead of vendoring a copy: CORS blocks a
local `.js` module on a `file://` page but allows the same file from a CDN
([`turn_transport/turn-transport.md`](turn_transport/turn-transport.md) §4). Over http, a local
module loads fine.

Dropping these costs the double-click dev loop. Serve the repo root instead:

```
python3 -m http.server
```

The three existing prototypes still open from `file://`, and should keep working that way.
