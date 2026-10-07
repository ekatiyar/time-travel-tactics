# Prototype status

This is the current capability ledger. Rules and intended features live in the [design document](time-travel-tactics-design-doc.md).

## Built

- Three clocks, playheads, inversion, and the player horizon. See [Clocks and playheads](time-travel-tactics-design-doc.md#clocks-and-playheads) and [Inversion](time-travel-tactics-design-doc.md#inversion).
- Grid movement, walls, occupancy rules, simultaneous collision resolution, and stuck turns. See [Board rules](time-travel-tactics-design-doc.md#board-rules) and [Collisions](time-travel-tactics-design-doc.md#collisions).
- Two modes chosen on the create form. Sandbox has no winner or turn limit. Bootstrap adds one key, pickups and steals, fronts along the key's timeline, a win at `t0` beside your spawn. It has no turn limit. See [Bootstrap](time-travel-tactics-design-doc.md#bootstrap).
- Key markers on every holder side with counts for duplicate incarnations, a key on the center tile while unheld, dashed spawn outlines, and front markers on the board and strip with turns-until-reached readouts.
- A combined board and timeline strip with focus and look-back controls, body identity, personal indices, and move legality.
- Board and seed previews, size presets, and a ready-up lobby for 2–4 players. See [Start a match](playing.md#start-a-match).
- WebRTC play over Trystero/Nostr with agreed seat ownership, transferable hosting, SHA-256 snapshot checks, and commit/reveal turns. See [Disconnecting and resuming](playing.md#disconnecting-and-resuming).
- Always-visible commitment status, Enter/Space commit shortcuts, relative-direction markers, and compact index stacks.
- A full-screen play view with collapsible rails, on-board move targets, priority status, a timeline chart, and staged turn animations.

## Planned

- Weapons, erasure and restoration fronts, moving holes, loss by erasure, and cycles. See [Death and fronts](time-travel-tactics-design-doc.md#death-and-fronts), [Death as a moving hole](time-travel-tactics-design-doc.md#death-as-a-moving-hole), [Winning](time-travel-tactics-design-doc.md#winning), and [Cycles](time-travel-tactics-design-doc.md#cycles).
- Hole and cycle UI, including countdowns. See [UI requirements](time-travel-tactics-design-doc.md#ui-requirements).
- Time charges, Loop, more weapons, and solo puzzles. See [Future mechanics](time-travel-tactics-design-doc.md#future-mechanics).
