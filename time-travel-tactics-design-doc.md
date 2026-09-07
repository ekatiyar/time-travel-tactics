# Turn-Based Time Travel Tactics — Design Document

*Working draft. Digital (PC/web). Status: mechanics workshopped, unbuilt.*

---

## 1. Vision

A turn-based tactics game for two or more players in which every player's entire history stays on the board as a playable, killable object.

Each turn you take one action: move, shoot, or manipulate time. Each turn you also leave a body behind on the tile you occupied. Those bodies are colour-coded oldest to newest, so at any moment both players are looking at the full visible trail of everything either of them has ever done. Nothing is a replay or a decoration — every one of those bodies is a real entity that can shoot and be shot.

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
| **Achron** (2011) | RTS with free-form time travel. Source of *meta-time* (§3) and of timewaves and chronoenergy, both of which we evaluated and rejected. |
| **Braid, Cursor\*10, Super Time Force** | Single-player ancestry for ghost-recording and co-op-with-yourself. |
| **Anachrony, Tragedy Looper** | Tabletop: borrowing from your future self; hidden-information loops. |

**Lesson taken from Lemnis Gate:** local/hotseat play and a solo puzzle mode must ship in v0, not be bolted on. A novel-mechanic PvP-only game with matchmaking dependency dies of loneliness regardless of review scores.

---

## 3. The three clocks

This is the load-bearing structure. Everything else follows from it.

**World time (`t`)** — positions on the shared timeline: t0, t1, t2… A persistent record of what happened where.

**Meta time (`m`)** — whose turn it is. Increments once per round of play, monotonically, forever. It cannot be travelled through. This is the only clock with that property, which is why it can arbitrate anything.

**Personal index (`p`)** — how many turns an individual player has lived. Increments by 1 every meta-turn that player acts, **regardless of which direction they are moving through world time.**

Each player has a *playhead*: a position in world time plus a direction (+1 or −1). Every meta-turn, each player takes one action at their own playhead, then the playhead moves one step in their direction and their personal index increments.

There is no single "present." Each player has their own.

---

## 4. Inversion

**Inverting** is an action. Taking it flips your playhead direction.

The critical property: **your recorded forward self does not vanish when you invert.** It remains on the board as live entities. So after inverting at t7, you are physically present twice across t0–t7 — once as the forward record, once as the live inverted body walking back through it. Reach t0 and invert again and you're present three times.

This is self-balancing without tuning. Each inversion buys presence, but each copy is another target, and killing any copy has consequences proportional to how early in your personal timeline it sits (§5).

### The asymmetry

- **Forward players own the unknown.** Only a forward playhead can extend the timeline into world-turns that don't exist yet. They set the frontier.
- **Inverted players own the known.** They act with perfect information, but are confined to already-written history and are heading toward a fixed, known start state. Diminishing returns as they approach t0.

### Presents separate

You can only shoot another player's **live** body if your playhead is at the same world-turn as theirs. Before anyone inverts, both presents coincide every turn. After an inversion they diverge and present-on-present duels become rare and special.

This makes inversion a **pursuit tool**, not just a utility: you invert in order to chase someone into their own past. Close to Tenet's pincer structure.

### Rejected: the oxygen meter

An earlier draft gave inverted players a draining resource, on the Tenet fiction. Cut. Staying inverted already self-limits because you run out of timeline heading toward t0. A second timer taxes a decision the geometry already handles.

---

## 5. Death: erasure fronts

**The timeline is never re-simulated.** The record is fixed. Only death propagates. This is the single most important simplification in the design.

### The rule

Shoot a body at personal index `j`. That body is erased, and an **erasure front** spawns at `j` on the victim's personal timeline, advancing **+2 personal indices per meta-turn**.

Crucially, the front travels along **personal** time, not world time. If the victim inverted, the erasure runs forward through their forward leg, rounds the turnstile, and then chases *backward* through world time along their inverted leg. It follows them wherever they went.

### Blast radius

Because erasure runs forward from the hit point, **the earlier in someone's personal timeline you hit them, the more you delete.** The same tile at the same world-turn may hold both a player's forward body (low `p`, high value) and their inverted body (high `p`, low value). These are worth wildly different amounts.

### Objects

Anything a body placed — mines, deployed cover — is attached to that body's tape entry and vanishes when the body is erased. No re-simulation needed, and erasing a body also disarms the field it built.

### Restoration

If a shot's *shooter* is itself erased, the shot un-fires. This spawns a **restoration front** on the original victim, at the original kill index, advancing at the same +2 rate.

Restoration is **full**, not blank. Bodies come back exactly as they were, with their mines and their shots intact, and those shots fire again. This is deliberate: chains of consequence replaying is the point of the game, and each new link in a chain requires a player to spend a real action, so chains terminate on their own.

**Fronts never reverse direction.** Killing a killer does not turn their front around; it creates a new, separate front travelling the same way. Because everything is monotonic, no reversal logic, oscillation guard, or lock-out rule is needed anywhere in the system.

### Rejected: timewaves

An earlier draft used Achron's model — a global wave sweeping forward, re-simulating each world-turn against stored *intents*. Cut as overcomplicated. It required re-simulation, an intent/outcome distinction, and stale-state rendering, and it propagated along world time rather than personal time, which is both less thematic and less interesting.

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

No arithmetic on screen. Just a number that means what it looks like. This property is a direct consequence of the 2:1 ratio and would be lost if the rate changed — worth knowing before tuning it.

While in a coma you advance 0, so a restoration front closes at **2 per meta-turn**.

### Two uses for one action

The win condition flips the value gradient from §5, productively:

- **Hit them deep in their past** — wipes out huge amounts of their built field (mines, cover, past shots), but hands them a long, visible countdown. This is *pressure and board control*.
- **Hit them close to their present** — erases almost nothing, but barely gives them time to react. This is *the kill*.
- **Hit their live body** — ends it outright, and requires sharing a world-turn with them.

One action, three completely distinct strategic uses. This falls out of the rules rather than being designed in.

### Backstop

A meta-turn cap, with the player holding more surviving bodies taking the win, covers stalls. Needed because of §8.

---

## 8. Cycles

A **cycle** occurs when two shots each depend on the other's shooter being dead.

**Detection rule:** a cycle can exist between two shots only where each shooter's personal index is greater than the index the other shot targets. Check that pair condition on declaration; no other cycle-hunting is ever needed.

**Cycles are legal.** They are not a bug and do not require a tiebreak rule. An earlier draft stamped every shot with its meta-turn and resolved cycles in favour of the earlier stamp; this was dropped once we established that cycle state is bounded.

### Behaviour

Because fronts never reverse, an unresolved cycle emits a *periodic train* of alternating erasure and restoration fronts. With the worked example's timings the period is 6 meta-turns, alternating every 3. The victim's timeline becomes a barcode: 6 indices dead, 6 alive, repeating.

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
3. **Third party.** Anyone outside the loop is unaffected and their shots dominate immediately. **This route does not exist in a two-player game**, which makes cycles significantly stickier at 2P and is the strongest argument for supporting 3P.

Does *not* work: inverting (personal index climbs regardless of direction, fronts chase either way), and in-phase repeat shots (redundant coverage during already-dead windows).

---

## 9. UI requirements

Ranked by how much the design depends on them.

1. **Phase countdown on strobing bodies.** Two of the three cycle escapes are timing plays and are invisible without it. Every body inside a cycle needs a visible "flickers in N."
2. **Personal-index gap readout.** Since turns-to-death equals the raw gap, surface it directly on any player with an inbound front.
3. **Timeline strip.** World time along an axis, with every player's playhead and direction. The hairpin shape of an inverted player's worldline should be legible at a glance.
4. **Body colour-coding.** Oldest to newest per player, per the original vision. Inverted bodies need a distinct treatment (reversed/outlined) from forward ones, since they are worth radically different amounts as targets.
5. **Front visualisation.** Erasure and restoration edges as marching markers on the timeline strip, with the hole between them shown as a hole.

---

## 10. Open questions

- **Front rate.** +2 is provisional. It currently buys the clean "gap = turns" property and the 6-on/3-off cycle rhythm. Anything else must be justified against losing those.
- **Player count.** 3P makes cycles escapable and adds sacrifice plays; 2P makes them sticky. Does the game want 2P as the default at all?
- **Cycle stalling.** Are alive windows long enough for an opponent to land a clean kill? This is what the 6:3 ratio actually controls, and it decides whether stalling is a valid strategy or a degenerate one.
- **The other two time mechanics.** Time charges (branching) and Loop are unspecified. Note that branching probably needs 5D Chess's timeline cap, and that mixing mechanics across players in one match is unexplored and possibly incoherent.
- **Grenades and mines** are named in the vision but not specced against the erasure model beyond "objects die with their body."
- **Solo mode.** Required per §2, but its shape is undefined. Puzzle-style — reach a win condition against a fixed opponent record — is the obvious candidate.

---

## 11. Implementation notes

- Store a match as **initial state + per-entity tapes indexed by personal index**. Each tape entry: world-turn, position, action, attached objects.
- An erasure or restoration front is **a single integer index** advancing +2 per meta-turn, plus an owner and an origin. That is the entire propagation system.
- **No re-simulation anywhere.** This was the biggest cost saved by rejecting timewaves.
- **Fully deterministic. No RNG**, not even in tie-breaking. Cycles make replay-determinism load-bearing.
- Cycles stored as (origin, period, phase), evaluated lazily.

---

## 12. v0 scope

Deliberately small, aimed at proving the erasure-front chase is fun before anything else.

- Small grid or single corridor
- One weapon (gun)
- One inversion allowed per player, per match
- Two players, **hotseat only — no netcode**
- Full front visualisation and phase countdowns (these are not polish; they are the mechanic)
- A handful of solo puzzles

Cut from v0: multiple weapons, mines and grenades, the other two time mechanics, 3P, matchmaking, repeated inversion.
