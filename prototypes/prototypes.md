# Prototypes

What is built and what is not, against
[`../time-travel-tactics-design-doc.md`](../time-travel-tactics-design-doc.md). Section
numbers are that document's. Detail about any one prototype lives in its own folder.

## Built

- **The three clocks and inversion** (§3, §4). World time, meta time, personal index, and the
  playhead flip. Inversion is unlimited and spends no world turn, so it can never be blocked.
  *time_travel*
- **The horizon** (§4). Enforced in the engine, drawn as dashed outlines on the strip.
  Honour-system only, as §4 says it must be without a server. *both*
- **Movement legality** (§4). The three occupancy rules, the t0 wall, and greyed illegal tiles
  with a reason on hover. *both*
- **Collision resolution** (§4). Seed-derived public priority, holders beating movers, hold as
  an action that joins them, bounce cascades, and the stuck turn a loser takes when the square
  they fall back on is already written to another colour. *time_travel*
- **Timeline strip and body encoding** (§9). Playheads and direction on a world-time axis; hue
  for player, opacity for age, a number for personal index. *both*
- **Combined view** (§9). One board for history and present, with world-turn and look-back
  controls and a configurable board and wall density. *both*
- **Serverless play**, which no design doc asked for. A match code encodes the config, then
  each turn is one hashed action string, so a desync is refused rather than applied.
  *time_travel*

## Not built

Everything from §5 onward. No prototype implements any of it:

- Weapons of any kind, including the v0 gun (§12), and mines and grenades (§10).
- Erasure and restoration fronts (§5) and the objects that die with their body.
- Death as a moving hole (§6), the win condition, and the personal-index gap readout (§7, §9).
- Cycles (§8) and the phase countdowns they need (§9).
- Front visualisation (§9), which the UI prototype calls the largest gap in the view model.
- The other two time mechanics, time charges and Loop (§10).
- Solo puzzle mode (§2, §12) and netcode, both cut from the current scope.
