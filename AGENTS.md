# tbtt

Turn-based tactics with a Preact prototype in `play/`.

Read the relevant document before changing game rules, planned scope, player instructions, or
prototype status:

- [`docs/time-travel-tactics-design-doc.md`](docs/time-travel-tactics-design-doc.md) for game rules and intended scope.
- [`docs/prototypes.md`](docs/prototypes.md) for what the prototype supports.
- [`docs/open-questions.md`](docs/open-questions.md) for unresolved decisions.
- [`docs/playing.md`](docs/playing.md) for player-facing behavior.

`engine.ts` owns deterministic rules. `transport.ts` owns peer coordination. `ui.tsx` renders a
session view. `scene.ts` turns a view into what the board draws and diffs two draws into motions.
`lanes.ts` splits each player's bodies into timeline legs. `instrument.ts` lays those legs out as
the timeline chart: columns, rows, lanes and the hatch. `board.tsx` renders a scene. Preserve those
boundaries, and keep `scene.ts`, `lanes.ts` and `instrument.ts` free of the DOM so they run under
`node --test`.

Use `package.json` for commands and configuration files for their settings.

Write plainly. State mechanisms and numbers. Keep comments to non-obvious reasons.
