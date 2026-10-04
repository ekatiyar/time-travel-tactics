# tbtt

Turn-based tactics with a Preact prototype in `play/`.

Read the relevant document before changing game rules, planned scope, player instructions, or
prototype status:

- [`docs/time-travel-tactics-design-doc.md`](docs/time-travel-tactics-design-doc.md) for game rules and intended scope.
- [`docs/prototypes.md`](docs/prototypes.md) for what the prototype supports.
- [`docs/open-questions.md`](docs/open-questions.md) for unresolved decisions.
- [`docs/playing.md`](docs/playing.md) for player-facing behavior.

`engine/` owns deterministic rules. `session.ts` coordinates peers through `transport.ts`
channels. `ui.tsx` renders a session view. `scene.ts` maps views to board draws and motions.
`lanes.ts` splits bodies into timeline legs; `instrument.ts` lays them out as a chart;
`board.tsx` renders scenes. Keep `scene.ts`, `lanes.ts` and `instrument.ts` DOM-free so they
run under `node --test`.

Use `package.json` for commands and configuration files for their settings.

Write plainly. State mechanisms and numbers. Keep comments to non-obvious reasons.
