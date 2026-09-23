# Prototype status

This is the current capability ledger. Rules and intended features live in the [design document](time-travel-tactics-design-doc.md).

## Built

- Three clocks, playheads, inversion, and the player horizon. See [Clocks and playheads](time-travel-tactics-design-doc.md#clocks-and-playheads) and [Inversion](time-travel-tactics-design-doc.md#inversion).
- Grid movement, walls, occupancy rules, simultaneous collision resolution, and stuck turns. See [Board rules](time-travel-tactics-design-doc.md#board-rules) and [Collisions](time-travel-tactics-design-doc.md#collisions).
- Two modes chosen on the create form. Sandbox has no winner and ends at the cap. Bootstrap adds one key, pickups and steals, fronts along the key's timeline, a win at `t0` beside your spawn, and a draw at the cap. See [Bootstrap](time-travel-tactics-design-doc.md#bootstrap).
- Key markers on every holder side with counts for duplicate incarnations, a key on the center tile while unheld, dashed spawn outlines, and front markers on the board and strip with turns-until-reached readouts.
- A combined board and timeline strip with focus and look-back controls, body identity, personal indices, and move legality.
- Join and resume links, a shared-name lobby, WebRTC play, state-hash checks, and commit-reveal turns.
- Always-visible commitment status, Enter/Space commit shortcuts, relative-direction markers, and compact index stacks.
- A full-viewport play screen with a status bar, collapsible log and action rails, toasts over a folded log, on-board move targets labelled with the index and world turn they produce, and priority dots that fade on commit.
- A timeline instrument raised while the world-turn scrub is held: one row per player, scaled to the furthest turn reached, legs between inversions joined by fold arcs, an index and direction per row, and hatching beyond the horizon. A row scrolls to its latest four legs, and legs joined past the horizon are drawn apart.
- Staged turn animations for moves, bounces, inversions, legs parting from and rejoining a shared tile, grabs, key loss, and fronts, skippable by any input and off under `prefers-reduced-motion`.

## Planned

- Weapons, erasure and restoration fronts, moving holes, loss by erasure, and cycles. See [Death and fronts](time-travel-tactics-design-doc.md#death-and-fronts), [Death as a moving hole](time-travel-tactics-design-doc.md#death-as-a-moving-hole), [Winning](time-travel-tactics-design-doc.md#winning), and [Cycles](time-travel-tactics-design-doc.md#cycles).
- Hole and cycle UI, including countdowns. See [UI requirements](time-travel-tactics-design-doc.md#ui-requirements).
- Time charges, Loop, more weapons, and solo puzzles. See [Future mechanics](time-travel-tactics-design-doc.md#future-mechanics).
