# Turn-Based Time Travel Tactics — Design Document

*Working draft. Digital (PC/web). This is the design of the game. What is built and what is not lives in [`prototypes/prototypes.md`](prototypes/prototypes.md).*

---

## 1. Vision

A turn-based tactics game for two or more players in which every player's entire history stays on the board as a playable, killable object.

Each turn you take one action: move, shoot, or manipulate time. You also leave a body behind on the tile you occupied. Bodies are colour-coded oldest to newest, so both players always see the full trail of everything either of them has done. None of it is a replay: every body is a real entity that can shoot and be shot.

The design pillar is that **the past is a battlefield, not a record.** Killing someone in the present is trivially decisive but nearly impossible to set up. Killing someone in their past is the actual game, and doing so starts a slow, visible unravelling of everything they built afterward.

The long-term ambition is **customisation as asymmetry**: players pick both a weapon (gun, mine, grenade) and a time-travel mechanic before the match. Three candidate mechanics have been sketched:

1. **Inversion** — Tenet-style. You reverse direction through world time and coexist with your own forward self.
2. **Time charges** — bank charges as an action, spend N to jump back N turns, creating a branching reality.
3. **Loop** — return to turn 0 at will.

This document specifies **inversion only**. The others are noted as future work in §10.

---

## 2. Positioning

Nothing on the market does this. The nearest neighbours:

| Game | Relationship |
|---|---|
| **Lemnis Gate** (2021) | Closest existing design. Turn-based FPS; each round's actions loop forever while the opponent counters. Real-time within turns, first-person, no personal-timeline model. **Servers shut down July 2023** after failing to sustain a playerbase — cited causes were thin mode variety and no single-player content. |
| **Quantum League** (2020) | Real-time 1v1/2v2 loops. Source of the "potential actions" idea (actions after death retroactively count if you're later saved). |
| **5D Chess With Multiverse Time Travel** (2020) | Turn-based PvP with branching timelines. Elegant self-balancing cap: you may branch at most one timeline more than your opponent has. |
| **Achron** (2011) | RTS with free-form time travel. Source of *meta-time* (§3). Its timewaves and chronoenergy are rejected here (§5). |
| **Braid, Cursor\*10, Super Time Force** | Single-player ancestry for ghost-recording and co-op-with-yourself. |
| **Anachrony, Tragedy Looper** | Tabletop: borrowing from your future self; hidden-information loops. |

**Lesson taken from Lemnis Gate:** local/hotseat play and a solo puzzle mode must ship in v0, not be bolted on. A novel-mechanic PvP-only game with matchmaking dependency dies of loneliness regardless of review scores.

---

## 3. The three clocks

Everything else in the design follows from these three.

**World time (`t`)** — positions on the shared timeline: t0, t1, t2… A persistent record of what happened where.

**Meta time (`m`)** — whose turn it is. Increments once per round of play, forever. It is the only clock you cannot travel through, which is why it can settle any dispute.

**Personal index (`p`)** — how many turns an individual player has lived. Increments by 1 every meta-turn that player acts, **regardless of which direction they are moving through world time.**

Each player has a *playhead*: a position in world time plus a direction (+1 or −1). Every meta-turn, each player takes one action at their own playhead, then the playhead moves one step in their direction and their personal index increments.

There is no single "present." Each player has their own.

---

## 4. Inversion

*These rules are implemented and playable. For how to run them, the board defaults and the string protocol, see [`prototypes/time_travel/time_travel_inversion.md`](prototypes/time_travel/time_travel_inversion.md).*

**Inverting** is an action. Taking it flips your playhead direction.

The critical property: **your recorded forward self does not vanish when you invert.** It remains on the board as live entities. So after inverting at t7, you are physically present twice across t0–t7 — once as the forward record, once as the live inverted body walking back through it. Reach t0 and invert again and you're present three times.

This is self-balancing without tuning. Each inversion buys presence, but each copy is another target, and killing any copy has consequences proportional to how early in your personal timeline it sits (§5).

### The asymmetry

- **Forward players own the unknown.** Only a forward playhead can extend the timeline into world-turns that don't exist yet. They set the frontier.
- **Inverted players own the known.** They act with perfect information, but are confined to already-written history and are heading toward a fixed, known start state. Diminishing returns as they approach t0.

### Presents separate

You can only shoot another player's **live** body if your playhead is at the same world-turn as theirs. Before anyone inverts, both presents coincide every turn. After an inversion they diverge and present-on-present duels become rare and special.

This makes inversion a **pursuit tool**, not just a utility: you invert in order to chase someone into their own past. Close to Tenet's pincer structure.

### The horizon

**You can only view world turns up to the furthest one you have personally reached.** A player who inverted at t7 and is now walking back cannot see t8 onward; a forward opponent at t11 can.

This is the only rule that hides real information, and it is what makes the asymmetry above real rather than rhetorical. Hiding turns *after* your selected view slice is only a viewing convention: you lived through them, so nothing is concealed. Hiding turns beyond your horizon conceals something.

Which is why it is the one rule a client cannot enforce. A client can decline to draw what you should not see, but if players exchange their own moves then a beyond-horizon move is in the exchange regardless and a modified client reads it. Enforcing the horizon needs an authoritative server. That is a cost the rule puts on the architecture, not a hole to patch in the client.

### Movement

The board is a grid with walls scattered through it. Walls block movement and act as cover, so the shape of the board is a tactical constraint and not just a container.

1. **Two different players can never occupy the same tile at the same world turn.**
2. **Two instances of the same player may.** This is the turnstile. Inverting spends no world turn: your playhead stays at the (t, x, y) you already hold and only your direction flips, so the inverted instance begins stacked on the forward one.
3. **A move may not.** Once you have shared a tile with your other instance, your next *step* cannot land on the tile that instance occupies at that world turn.

The move/invert distinction in 2 and 3 does real work. Inverting asks for the tile you are already standing on, so nothing can refuse it: not the edge of the board, not a wall, not rule 1. No player is ever left without a legal action.

One consequence is that inverting twice running is a legal stall: the same world turn, three bodies stacked, personal index up by two. That is allowed on purpose. Stalling freezes your own horizon while every other player pushes the frontier forward, and each body it stacks is one more target (§5). It costs what presence always costs.

**One more consequence:** a forward player moving into a world turn that does not yet exist can only be blocked by walls and by other forward players. Every other kind of block applies to someone moving backward through already-written history. Inverting costs mobility as well as visibility.

### The t0 wall

An inverted player at world turn 0 cannot step further back, and cannot hold their ground either — both spend a world turn, and there is no t−1 to spend it into. Inverting is the only thing left, because it is the one action that spends no world turn at all. The approach to t0 ends in a wall, not merely in the diminishing returns described above.

### Collisions

Actions resolve **simultaneously**. A per-turn priority order is derived from the match seed and is **public**, so players can work out in advance who wins a contested tile.

Two classes of action matter here. A **move** changes your (x, y). **Holding** does not: standing your ground is an action in its own right, and so is being bounced out of a tile you lost. A holder still travels through time, just not through space, so their playhead and personal index advance as a mover's would. You lose the ground, not the turn.

Inverting sits outside the contest altogether. It asks for the (t, x, y) already recorded to you, and nobody else can be standing there, so it never competes with anyone for anything.

1. **Two movers after one tile** — the higher-priority one takes it. The loser holds instead.
2. **A mover against a holder** — the holder keeps the square, whatever the priority order says. Standing still cannot be pushed out of the way by someone arriving.
3. **A bounced mover is now a holder**, so it can bounce the next player, who can bounce the one after. Resolution repeats until nobody else moves. The set of holders only grows, so this settles in at most one round per player.
4. **Two holders after one tile** — rare, but reachable, because two players standing on one square at different world turns can hold it into the same (t, x, y) from opposite directions. Priority breaks it and the loser is stuck.
5. **A holder's tile is already recorded to another colour** — nothing can be overridden, because that history is already written. The holder is stuck.

Rule 2 is the one that surprises people. A player far down the priority order who happens to be standing where you wanted to go beats you outright, and nothing you can read off the public order predicts it, because you cannot see whether they are about to lose their own contest somewhere else.

### Stuck turns

Every player always has at least one legal action, because inverting cannot be refused. Being stuck is therefore never a matter of having nothing to choose from. It is an outcome rather than a choice: collision rule 5, where a player loses a contest, falls back on the square they were already standing on, and finds that square recorded to another colour at the world turn they were about to spend. The turn is skipped and their playhead and personal index both freeze. This is the shape of §6's moving hole with the death taken out.

Only an inverted player can end up there. A forward player's fallback is their own tile one world turn further into a future nobody has written yet, so there is nothing there to collide with. Getting stuck takes walking backward through a crowded past.

A stuck player still participates in the turn exchange like everyone else. They chose an action and submitted it; the resolver is what took it away from them.

### Rejected: the oxygen meter

A draining resource for inverted players, on the Tenet fiction. Staying inverted already limits itself, because you run out of timeline heading toward t0. A second timer would tax a decision the geometry already handles.

---

## 5. Death: erasure fronts

**The timeline is never re-simulated.** The record is fixed. Only death propagates. This is the single most important simplification in the design.

### The rule

Shoot a body at personal index `j`. That body is erased, and an **erasure front** spawns at `j` on the victim's personal timeline, advancing **+2 personal indices per meta-turn**.

The front travels along **personal** time, not world time. If the victim inverted, the erasure runs forward through their forward leg, rounds the turnstile, and then chases *backward* through world time along their inverted leg. It follows them wherever they went.

### Blast radius

Because erasure runs forward from the hit point, **the earlier in someone's personal timeline you hit them, the more you delete.** The same tile at the same world-turn may hold both a player's forward body (low `p`, high value) and their inverted body (high `p`, low value). These are worth wildly different amounts.

### Objects

Anything a body placed — mines, deployed cover — is attached to that body's tape entry and vanishes when the body is erased. No re-simulation needed, and erasing a body also disarms the field it built.

### Restoration

If a shot's *shooter* is itself erased, the shot un-fires. This spawns a **restoration front** on the original victim, at the original kill index, advancing at the same +2 rate.

Restoration is **full**, not blank. Bodies come back exactly as they were, with their mines and their shots intact, and those shots fire again. This is deliberate: chains of consequence replaying is the point of the game, and each new link in a chain requires a player to spend a real action, so chains terminate on their own.

**Fronts never reverse direction.** Killing a killer does not turn their front around; it creates a new, separate front travelling the same way. Because every front only ever moves one way, nothing in the system needs reversal logic, an oscillation guard or a lock-out rule.

### Rejected: timewaves

Achron's model: a global wave sweeping forward, re-simulating each world-turn against stored *intents*. It needs re-simulation, an intent/outcome distinction and stale-state rendering, and it spreads along world time rather than personal time, which is both less thematic and less interesting.

---

## 6. Death as a moving hole

Death is not a state you enter and leave. It is a **fixed-width hole sliding along your worldline**, with the erasure front as its leading edge and the restoration front as its trailing edge, both moving at +2.

The width of the hole is the lag between the two fronts, which is exactly how many meta-turns you took to land the counter-kill. **Your coma lasts as long as you spent undoing it.** Fast counter, brief blackout. Slow counter, long one. Proportional punishment with no tuning constant.

While the hole covers your present:

- You are skipped. You take no turns.
- Your present body doesn't exist, so nobody can shoot it.
- Meta time keeps running, so opponents advance ahead of you.

When the trailing edge arrives you resume at **the same personal index** where you dropped out. Everything behind the trailing edge is already back.

Coming back is a real decision. If you were moving forward, your opponent is now several world-turns into your future and everything they did during your coma is sitting in the turns between you and them, as a record you have to walk through. Your coma became their fortification. Alternatively, invert — and chase them from behind instead.

---

## 7. Win condition

**You lose when an erasure front reaches your present with no restoration front behind it.**

You cannot act while the hole covers your present, so you cannot counter from inside it. The counter must already be in flight when the front arrives. Miss that window and there is nothing behind the leading edge and never will be.

### The closure arithmetic

Fronts advance +2 per meta-turn. A living player advances +1. Net closure while alive is therefore exactly **1 per meta-turn**, so:

> **turns until the front reaches you = the raw personal-index gap**

No arithmetic on screen. Just a number that means what it looks like. This falls out of the 2:1 ratio and is lost if the rate changes, which is worth knowing before tuning it.

While in a coma you advance 0, so a restoration front closes at **2 per meta-turn**.

### Two uses for one action

The win condition flips the value gradient from §5, productively:

- **Hit them deep in their past** — wipes out huge amounts of their built field (mines, cover, past shots), but hands them a long, visible countdown. This is *pressure and board control*.
- **Hit them close to their present** — erases almost nothing, but barely gives them time to react. This is *the kill*.
- **Hit their live body** — ends it outright, and requires sharing a world-turn with them.

One action, three distinct strategic uses, none of them designed in.

### Backstop

A meta-turn cap, with the player holding more surviving bodies taking the win, covers stalls. Needed because of §8.

---

## 8. Cycles

A **cycle** occurs when two shots each depend on the other's shooter being dead.

**Detection rule:** a cycle can exist between two shots only where each shooter's personal index is greater than the index the other shot targets. Check that pair condition on declaration; no other cycle-hunting is ever needed.

**Cycles are legal.** They are not a bug and need no tiebreak rule, because the state a cycle costs is bounded — see *State cost* below. Rejected: stamping every shot with its meta-turn and resolving cycles in favour of the earlier stamp.

### Behaviour

Because fronts never reverse, an unresolved cycle emits a steady train of alternating erasure and restoration fronts. At the +2 front rate the period is 6 meta-turns, alternating every 3. The victim's timeline becomes a barcode: 6 indices dead, 6 alive, repeating.

For a moving present, the closure rates from §7 apply asymmetrically:

- Alive, next erasure edge 6 behind → closes at 1/turn → **6 turns of play**
- In coma, restoration edge 6 behind → closes at 2/turn → **3 turns skipped**

**Effective tempo drops to two-thirds.** But during dead windows your present body doesn't exist and cannot be shot. You are intermittently untouchable in exchange for intermittently mute.

### State cost

O(1). Store an origin index, a period, and a phase; evaluate on demand. Unresolved cycles do not accumulate.

### Strategic role

**A cycle cannot kill anyone**, because there is always a restoration behind the erasure. It is a stalemate engine. Which makes it a genuine defensive resource: a losing player can force one, become invulnerable on a schedule, and stall. The player ahead on board position wants it broken; the player behind will spend turns protecting the phase. That is a comeback mechanic arising from the rules.

### Escaping a cycle

1. **Strike below the floor.** The cycle only touches indices above its lowest kill point. Land a front below that and it swallows both the cycle's coverage and the shooter body driving it. Depth beats phase.
2. **Counter-phase strike.** At a fixed past index the cycle alternates 3 dead / 3 alive. A second erasure on the same body offset by 3 meta-turns unions with the first to cover it continuously — the shot never gets a live window to fire from. Same action as the original, different timing.
3. **Third party.** Anyone outside the loop is unaffected and their shots win immediately. **This route does not exist in a two-player game**, which makes cycles much stickier at 2P and is the strongest argument for supporting 3P.

Does *not* work: inverting (personal index climbs regardless of direction, fronts chase either way), and in-phase repeat shots (redundant coverage during already-dead windows).

---

## 9. UI requirements

What the UI must convey, ranked by how much the design depends on it. *For what it looks like, see [`prototypes/ui/prototype-ui.md`](prototypes/ui/prototype-ui.md).*

1. **Phase countdown on strobing bodies.** Two of the three cycle escapes are timing plays and are invisible without it. Every body inside a cycle needs a visible "flickers in N."
2. **Personal-index gap readout.** Since turns-to-death equals the raw gap, surface it directly on any player with an inbound front.
3. **Timeline strip.** World time along an axis, with every player's playhead and direction. The hairpin shape of an inverted player's worldline should be legible at a glance.
4. **Body identity and age.** Every body reads as its player and as its personal index. The index is the half that matters: where a forward and an inverted body of the same player share a tile, the gap between their indices is the whole difference between a cheap target and an expensive one.
5. **Front visualisation.** Erasure and restoration edges as marching markers on the timeline strip, with the hole between them shown as a hole.
6. **Move legality.** Illegal tiles read as unavailable while a move is being made. Three reasons exist — wall, opponent present, your other self present — but only the reason for a specific tile ever needs surfacing, and only on inspection.

---

## 10. Open questions

- **Front rate.** +2 is provisional. It currently buys the clean "gap = turns" property and the 6-on/3-off cycle rhythm. Anything else must be justified against losing those.
- **Player count.** 3P makes cycles escapable and adds sacrifice plays; 2P makes them sticky. Does the game want 2P as the default at all?
- **Cycle stalling.** Are alive windows long enough for an opponent to land a clean kill? This is what the 6:3 ratio actually controls, and it decides whether stalling is a valid strategy or a degenerate one.
- **The other two time mechanics.** Time charges (branching) and Loop are unspecified. Note that branching probably needs 5D Chess's timeline cap, and that mixing mechanics across players in one match is unexplored and possibly incoherent.
- **Grenades and mines** are named in the vision but not specced against the erasure model beyond "objects die with their body."
- **Solo mode.** Required per §2, but its shape is undefined. Puzzle-style — reach a win condition against a fixed opponent record — is the obvious candidate.
- **Should you see the opponent's horizon?** It tells you exactly how blind they are, which is a real strategic disclosure. It may need to be earned rather than given.
- **Should a player's view hide their own known future?** They lived those turns, so hiding them conceals nothing and may only cost legibility. This is the one place where the viewing convention and the horizon rule could reasonably diverge.
- **Board shape.** A single corridor collapses the board and the timeline strip into one picture: one spatial axis plus time. A wider grid needs them as separate panels. §12 leaves both open, but the choice decides how much screen the game spends explaining itself.

---

## 11. Implementation notes

- Store a match as **initial state + per-entity tapes indexed by personal index**. Each tape entry: world-turn, position, action, attached objects.
- An erasure or restoration front is **a single integer index** advancing +2 per meta-turn, plus an owner and an origin. That is the entire propagation system.
- **No re-simulation anywhere.**
- **Fully deterministic. No RNG**, not even in tie-breaking. Cycles mean a replay has to come out the same way every time.
- Cycles stored as (origin, period, phase), evaluated lazily.

---

## 12. v0 scope

Deliberately small, aimed at proving the erasure-front chase is fun before anything else.

- Small grid or single corridor
- One weapon (gun)
- Two players, **hotseat only — no netcode**
- Full front visualisation and phase countdowns (these are not polish; they are the mechanic)
- A handful of solo puzzles

Cut from v0: multiple weapons, mines and grenades, the other two time mechanics, 3P, matchmaking.

The time-travel layer is built and playable, without weapons or a win condition: a sandbox whose only job is to show the three-clock model is coherent and readable before anything is built on top of it. Everything from §5 onward is a later version, not a cancelled feature. The split is tracked in [`prototypes/prototypes.md`](prototypes/prototypes.md).
