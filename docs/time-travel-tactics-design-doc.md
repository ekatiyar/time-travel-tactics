# Time Travel Tactics design

The game is turn-based tactics where every action leaves a body in history. Bodies are real targets. Time travel creates more of your bodies, giving you more presence and more risk.

[`prototypes.md`](prototypes.md) tracks what exists. [`open-questions.md`](open-questions.md) tracks decisions still needed.

## Direction

Players choose a weapon and a time mechanic. Inversion is the first time mechanic. Time charges and Loop are future options.

The first complete game should support a networked two-player match, a gun, erasure and restoration fronts, clear front visualisation, and solo puzzles. Mines, grenades, three or more players, matchmaking, and other time mechanics come later.

## Clocks and playheads

- World time (`t`) records positions on the shared timeline.
- Meta time (`m`) advances once per round. Players cannot travel through it.
- Personal index (`p`) counts actions taken by one player. It advances each time that player acts, regardless of their direction through world time.

Each player has a playhead: a world turn and a direction. On an action, their playhead moves one world turn in that direction unless the action is inversion. Their personal index always advances.

Players have separate presents after an inversion. A player can shoot another player's live body only when their playheads share a world turn.

## Inversion

Inversion flips a playhead's direction without spending a world turn. The forward body remains in history. An inverted player can therefore overlap their own earlier body and may invert again at `t0`.

Forward players can extend the timeline. Inverted players move through known history toward `t0`.

### Horizon

A player may view world turns up to the furthest turn they have reached. A client can hide later turns but cannot keep a modified client from reading exchanged moves. Enforcing this rule requires an authoritative server.

Recorded opponents beyond the horizon do not block move selection. If a blind move reaches an occupied tile, the recorded body holds it.

### Board rules

Walls block movement. At a world turn:

1. Different players cannot occupy the same tile.
2. One player's bodies may occupy the same tile.
3. After overlapping one of their bodies, a player's next step cannot land on that body's tile.

Inversion is always legal because it keeps the player on their recorded tile. Repeated inversions are legal. They freeze the player's horizon while adding targets to their timeline.

At `t0`, an inverted player cannot move or hold into an earlier world turn. They can invert.

### Collisions

Players choose actions simultaneously. A public, seed-derived priority order resolves contested tiles.

- A holder keeps its tile against an arriving mover.
- When movers contest a tile, the highest-priority mover takes it. Other movers hold instead.
- A bounced mover becomes a holder. Resolve again until no mover contests a holder.
- If holders converge on a tile, priority decides.
- A player whose fallback tile is already recorded to another player is stuck. Their playhead and personal index do not advance.

## Death and fronts

The timeline is not re-simulated. Death propagates along a player's personal timeline.

Shooting a body at personal index `j` erases it and creates an erasure front at `j`. The front advances two personal indices per meta-turn. It erases later bodies and objects placed by them, including mines and cover.

If an erased shooter would have fired a shot, that shot unfires. The original victim gains a restoration front at the kill index. It advances at the same rate and restores bodies, objects, and shots exactly as recorded.

Fronts always move forward through personal time. An inverted player's front follows their forward path, turns at inversion, then travels backward through world time along their inverted path.

## Death as a moving hole

An erasure front and a restoration front define a hole in a player's personal timeline. While the hole covers their present, they take no turns and cannot be shot. Meta time continues.

The delay before a counter-kill determines the hole's width. A fast counter restores the victim quickly. A slow counter leaves them inactive longer. When restoration reaches the present, the player resumes at the personal index where they stopped.

## Winning

A player loses when an erasure front reaches their present without a restoration front behind it. A live-body shot ends the match immediately.

With fronts advancing by two indices and living players by one, an inbound front reaches a living player after a number of turns equal to the personal-index gap. Show that gap in the UI.

A meta-turn cap resolves stalls. The player with more surviving bodies wins.

## Cycles

A cycle occurs when each of two shots depends on the other shooter's death. It is possible when each shooter has a higher personal index than the body targeted by the other shot.

Cycles are legal. Alternating erasure and restoration fronts create repeated dead and alive windows. The planned two-index front rate yields six active indices followed by six erased indices. A cycle cannot kill because restoration always follows erasure.

Players can break a cycle by:

1. Hitting below its earliest kill point.
2. Covering its live window with a second, offset erasure front.
3. Using a third player who is outside the cycle.

## UI requirements

The UI must make these facts easy to read:

- A timeline strip with each playhead and direction.
- Player identity and personal index on every body.
- The personal-index gap for an inbound front.
- Erasure and restoration fronts, with the hole between them.
- A countdown on bodies inside a cycle.
- Illegal moves and their reason on inspection.

Use one combined board for present and history. The player chooses a focus world turn and how much earlier history to show. Beyond-horizon turns remain visible only as unavailable timeline outlines.

## Future mechanics

- Time charges: players bank actions, then spend charges to jump back and branch reality.
- Loop: players return to world turn zero.
- Weapons: gun first, then mines and grenades.
- Solo puzzles: beat a fixed opponent record.

Different time mechanics in one match need a separate design.

## Implementation constraints

- Resolve matches deterministically.
- Store initial state and each player's actions by personal index.
- Represent a front by its personal index, owner, and origin.
- Evaluate cycles from their origin, period, and phase instead of growing stored state.
