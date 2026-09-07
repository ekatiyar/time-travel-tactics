# Prototype UI — Turn-Based Time Travel Tactics

*The visual and interaction layer. The game's design is
[`../../time-travel-tactics-design-doc.md`](../../time-travel-tactics-design-doc.md); its §9
lists what the UI must convey. This document is what it looks like and why.*

---

## 1. View model

**Combined view, not split.** One board showing history and present together. A split view —
where you only ever see one world turn — falls out of this for free by setting look-back to 0,
so it doesn't need to be a separate mode. That leaves the default tunable rather than
architectural.

**Top-down orthographic, not isometric.** Multiple bodies can occupy one tile. A square
subdivides and fans cleanly; an isometric rhombus produces genuine occlusion, where a body
behind another is hidden rather than merely crowded. Isometric photographs better and performs
worse.

**Two controls:**

| Control | Does |
|---|---|
| **World turn** (`T`) | Selects the focus slice. Capped at your horizon. |
| **Look back** (`R`) | How many turns of history stay visible behind `T`. |

Visible window is `[T − R, T]`. Nothing after `T` is drawn.

**Horizon.** Beyond-horizon world turns render as dashed outlines on the timeline strip, and
the world-turn slider will not travel past them.

---

## 2. Visual encoding

Deliberately few channels. An earlier pass carried five simultaneously — player, personal
index by colour depth, world distance by opacity, forward/inverted by outline, live by ring —
and was unreadable.

| Channel | Carries |
|---|---|
| Hue | Player identity (coral / purple / teal / amber, for 2–4 players) |
| Opacity | Distance back from the focus slice |
| Size | Focus slice = large token with index; history = small dot |
| Number | Personal index |

**Dropped: the forward/inverted marker.** The index number is strictly more information than
the binary flag was, and the flag was the noisiest element on the board. Where two of a
player's bodies sit on one tile, the gap between their indices tells you which is the
expensive target with no extra symbol.

**Dropped: the personal-index colour ramp.** Superseded by the number. Worth revisiting if
playtesting shows target valuation needs to be readable at a glance rather than on inspection.

**Overlaps** render as a single pill containing both indices (`7·8`) rather than two crowded
circles. Because two different players can never share a tile at the same world turn (design
doc §4), a pill is always one colour. Full detail on hover.

**Palette** is pastel and flat. This works for identity and age. It probably cannot carry
threat, which matters for §3.

**Move legality** is shown by greying illegal tiles while a move is being made. No
colour-coding by reason — the reason goes in the tooltip. Three reasons exist, but the player
only needs to know the tile is unavailable.

---

## 3. Not yet designed

**Erasure and restoration fronts have no visual at all.** This is the largest gap. The design
doc ranks phase countdowns and front visualisation as its top two UI requirements, and neither
is prototyped. Two known problems:

- A front is currently only representable as absence, which reads as nothing rather than as
  threat.
- The pastel palette has no headroom for urgency. Fronts likely need one reserved non-pastel
  accent, used for nothing else.

**Also unaddressed:** the personal-index gap readout, the hairpin worldline shape, phase
countdowns on strobing bodies, mines and deployed objects, and any shooting interaction.

---

## 4. Open questions

- **Hover is the only route to a history dot's index.** Fine on desktop, unavailable on touch.
  Needs a tap-to-inspect equivalent, or history dots need to carry numbers, which reintroduces
  noise.
- **Stacks larger than two.** The pill handles two. Three or more, at default tile size, does
  not obviously fit.
- **Does the colour ramp need to come back** for at-a-glance target valuation, and can pastel
  carry it alongside a front accent.
