# Open questions

## Game rules

- Is two indices per meta-turn the right front rate? It gives an index gap that matches turns remaining and a six-index cycle rhythm.
- Should two players be the default? Three players give cycles an outside attacker.
- Do cycle windows create useful defense or stall games?
- How should time charges branch the timeline? Does it need a cap on branches?
- What rules govern mines and grenades when their owner is erased?
- Should players see an opponent's horizon?
- Should a player see their own known future?
- Should the first boards be corridors, small grids, or both?
- A grab overtaken by an older front keeps a real key until that front arrives. That is about half the world-turn gap in meta-turns: a grab at `t9` against a front started at `t3` on the same meta-turn holds for 4 meta-turns. Is that intended?
- Bootstrap ends in a draw at the cap. [Winning](time-travel-tactics-design-doc.md#winning) says the player with more surviving bodies wins at the cap. Which rule should modes with weapons use?
- A steal with facing victims on several neighbouring tiles takes from the highest personal index. Should the thief choose instead?
- On even boards the center (floor(w/2), floor(h/2)) is one tile closer to Purple's corner than to Coral's. Should boards be odd only?
- Should walls be mirrored so every route to the center has the same length?
- On a 5x5 board the protected tiles (spawns, their neighbours, the center) leave few tiles for walls, so the wall percentage saturates well below its setting. Is the minimum size worth keeping?

## UI

- How should erasure and restoration fronts read on the board and strip?
- An opponent front readout counts turns to their last body you can see, not their present. Is that clear enough at a glance?
- What visual treatment distinguishes urgent threats without overloading player colours?
- How should touch users inspect a history body?
- Is a personal-index colour ramp needed for target value at a glance?
- How should shooting and placed objects work in the controls?

## Product

- What does a solo puzzle need to ask the player to achieve?
- When is matchmaking worth building?
- Which time mechanics and weapons should players be allowed to combine?

## Technical

- When should an authoritative server replace horizon trust?
- What match format supports branching mechanics without losing deterministic replay?
