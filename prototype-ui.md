# Prototype UI — Turn-Based Time Travel Tactics

*Companion to `time-travel-tactics-design-doc.md`. Covers the visual and interaction layer only. Status: explored in mockup, unbuilt.*

---

## 1. What this settles

The main doc's §9 lists what the UI must convey but not what it looks like. This document records the decisions taken while mocking it up, the reasoning behind them, and the rules that surfaced as a result — several of which are new mechanics, not presentation choices, and should be folded back into the main doc (see §8).

---

## 2. View model

**Combined view, not split.** One board showing history and present together, per the original vision in §1 of the main doc. A split view — where you only ever see one world turn — falls out of this for free by setting look-back to 0, so it doesn't need to be a separate mode. That leaves the default tunable rather than architectural.

**Top-down orthographic, not isometric.** Multiple bodies can occupy one tile. A square subdivides and fans cleanly; an isometric rhombus produces genuine occlusion, where a body behind another is hidden rather than merely crowded. Isometric photographs better and performs worse.

**Two controls:**

| Control | Does |
|---|---|
| **World turn** (`T`) | Selects the focus slice. Capped at your horizon (§3). |
| **Look back** (`R`) | How many turns of history stay visible behind `T`. |

Visible window is `[T − R, T]`. Nothing after `T` is drawn.

**Board size.** 10×10 with interspersed walls acting as cover and forcing navigation. Wall density untested.

---

## 3. Horizon

**You can only view world turns up to the furthest one you have personally reached.**

This is the single most important rule to come out of the mockup, because it is the only part of the view model that hides real information. A player who inverted at t7 and is now walking back cannot see t8 onward; a forward opponent at t11 can. The timeline strip renders beyond-horizon turns as dashed outlines, and the world-turn slider will not travel past them.

This lands the main doc's §4 asymmetry directly and visually: forward players own the unknown, inverted players own the known. Before this rule the asymmetry existed only in prose.

**Note the distinction.** Hiding turns *after* your selected slice is a viewing convention — you already lived through them, so nothing is concealed. Hiding turns beyond your horizon is genuine hidden information. Only the second is a mechanic. Whether the first should exist at all is open (§7).

---

## 4. Visual encoding

Deliberately few channels. An earlier pass carried five simultaneously — player, personal index by colour depth, world distance by opacity, forward/inverted by outline, live by ring — and was unreadable.

| Channel | Carries |
|---|---|
| Hue | Player identity (coral / purple) |
| Opacity | Distance back from the focus slice |
| Size | Focus slice = large token with index; history = small dot |
| Number | Personal index |

**Dropped: the forward/inverted marker.** The index number is strictly more information than the binary flag was, and the flag was the noisiest element on the board. Where two of a player's bodies sit on one tile, the gap between their indices tells you which is the expensive target — per §5 of the main doc — with no extra symbol.

**Dropped: the personal-index colour ramp** (main doc §9.4). Superseded by the number. Worth revisiting if playtesting shows target valuation needs to be readable at a glance rather than on inspection.

**Overlaps** render as a single pill containing both indices (`7·8`) rather than two crowded circles. Because two different players can never share a tile at the same world turn (§5), a pill is always one colour. Full detail on hover.

**Palette** is pastel and flat. This works for identity and age. It probably cannot carry threat, which matters for §6.

---

## 5. Movement rules

These emerged from the mockup and are mechanics, not UI.

1. **Two different players can never occupy the same tile at the same world turn.**
2. **Two instances of the same player may.** This happens naturally at the turnstile: inverting is an action, not a move, so your inverted instance begins on the same tile your forward self occupied.
3. **But they must diverge immediately.** Having shared a tile, your next step cannot land on the tile your other instance occupies at that world turn.

**Consequence worth stating plainly:** a forward player moving into a world turn that does not yet exist can only ever be blocked by walls. Every other kind of block applies to someone moving backward through already-occupied history. Inverting costs mobility as well as visibility.

**Presentation:** illegal moves are greyed out when a move is being made. No colour-coding by reason — the reason goes in the tooltip. Three reasons exist (wall, opponent present, your other self present) but the player only needs to know the tile is unavailable.

---

## 6. Not yet designed

**Erasure and restoration fronts have no visual at all.** This is the largest gap. The main doc's §9 ranks phase countdowns and front visualisation as the top two UI requirements, and neither is prototyped. Two known problems:

- A front is currently only representable as absence, which reads as nothing rather than as threat.
- The pastel palette has no headroom for urgency. Fronts likely need one reserved non-pastel accent, used for nothing else.

**Also unaddressed:** the personal-index gap readout (§9.2 of the main doc), the hairpin worldline shape (§9.3), phase countdowns on strobing bodies (§9.1), mines and deployed objects, and any shooting interaction.

---

## 7. Open questions

- **Should the look-back window hide your own known future?** It currently does, and it's the reason the board can look sparse. Since you lived those turns, hiding them conceals nothing and may just cost legibility.
- **Should you be able to see your opponent's horizon?** The mockup displays it as a readout. That is a real strategic disclosure — it tells you exactly how blind they are — and may need to be earned rather than given.
- **Hover is the only route to a history dot's index.** Fine on desktop, unavailable on touch. Needs a tap-to-inspect equivalent, or history dots need to carry numbers, which reintroduces noise.
- **Stacks larger than two.** The pill handles two. Three or more, at 10×10 tile size, does not obviously fit.
- **Wall density and grid size.** Both picked by eye.
- **Does the colour ramp need to come back** for at-a-glance target valuation, and can pastel carry it alongside a front accent.

---

## 8. Changes to fold into the main design doc

- §5 movement rules above are new and belong in the mechanics, not here.
- The horizon rule (§3) belongs in the main doc's §4 as the concrete expression of the forward/inverted asymmetry.
- §9 of the main doc should gain a tenth requirement: move legality display.
- The main doc's §12 v0 scope says "small grid or single corridor." A corridor would make the board and the timeline strip the same picture — one spatial axis plus time. That option is now closed; 10×10 forces a separate timeline panel.

---

## 9. Files

- `prototype-ui.html` — standalone interactive mockup. Two-sided view, world-turn scrubber, look-back control, legal-move display. Open in any browser.
