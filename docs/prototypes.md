# Prototypes

What is built and what is not, against
[`time-travel-tactics-design-doc.md`](time-travel-tactics-design-doc.md). Section
numbers are that document's. The tag beside each item is the version it first appeared in, and
every version since carries it. v0.1 is the mockup, so the four items marked v0.1 were drawn
there before v0.2 made them real. Released versions are playable from the front page; how they get
there is in [`hosting.md`](hosting.md), which also has the hosting limits every prototype works
within.

## Built

- **The three clocks and inversion** (§3, §4). World time, meta time, personal index, and the
  playhead flip. Inversion is unlimited and spends no world turn, so it can never be blocked.
  *v0.2*
- **The horizon** (§4). The engine hides beyond-horizon turns and the strip draws them as
  dashed outlines. Nothing enforces it, which §4 says is unavoidable without a server. *v0.1*
- **Movement legality** (§4). The three occupancy rules, the t0 wall, and greyed illegal tiles
  with a reason on hover. *v0.1*
- **Collision resolution** (§4). Seed-derived public priority, holders beating movers, hold as
  an action that joins them, bounce cascades, and the stuck turn a loser takes when the square
  they fall back on is already written to another colour. *v0.2*
- **Timeline strip and body encoding** (§9). Playheads and direction on a world-time axis; hue
  for player, opacity for age, a number for personal index. *v0.1*
- **Combined view** (§9). One board for history and present, with world-turn and look-back
  controls and a configurable board and wall density. *v0.1*

### Beyond the design doc

No design document asked for anything below.

- **Serverless play.** A match code encodes the config, then each turn is one hashed action
  string, so a desync is refused rather than applied. *v0.2*
- **Turns that move themselves.** The same hashed action strings, sent over WebRTC instead of a
  chat window, behind a `Channel` interface. Works across NAT on two machines, in Chrome and in
  Firefox. *v0.3*
- **Commit-reveal.** You publish a hash of your move, everyone opens together once the last hash
  lands, and until then you can change your mind. *v0.3*

## Not built

Everything from §5 onward. No prototype implements any of it:

- Weapons of any kind, including the v0 gun (§12), and mines and grenades (§10).
- Erasure and restoration fronts (§5) and the objects that die with their body.
- Death as a moving hole (§6), the win condition, and the personal-index gap readout (§7, §9).
- Cycles (§8) and the phase countdowns they need (§9).
- Front visualisation (§9), which the UI prototype calls the largest gap in the view model.
- The other two time mechanics, time charges and Loop (§10).
- Solo puzzle mode (§2, §12).
