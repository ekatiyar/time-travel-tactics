// Splits each player's bodies into the lanes the timeline instrument draws.
// Pure so the leg split can be tested without a DOM.

import type { Color, Dir, ViewBody } from './engine/index.js';
import type { NamedView } from './scene.js';

export type Leg = { lane: number; bodies: ViewBody[] };
export type PlayerLanes = {
  color: Color; live: ViewBody | null; legs: Leg[]; laneCount: number;
};

export const MAX_LANES = 4;

function byColour(view: NamedView): Map<Color, ViewBody[]> {
  const out = new Map<Color, ViewBody[]>();
  for (const c of view.roster) out.set(c, []);
  for (const b of view.bodies) out.get(b.color)?.push(b);
  for (const bodies of out.values()) bodies.sort((a, b) => a.p - b.p);
  return out;
}

// Which leg each body belongs to, keyed `color:p`. Uncapped, unlike `Leg.lane`: legs past
// MAX_LANES share the last lane, so only this number identifies a leg on its own.
export function legIndexes(view: NamedView): Map<string, number> {
  const out = new Map<string, number>();
  for (const bodies of byColour(view).values()) {
    let leg = -1;
    let dir: Dir | null = null;
    for (const b of bodies) {
      if (b.dir !== dir) { leg++; dir = b.dir; }
      out.set(b.color + ':' + b.p, leg);
    }
  }
  return out;
}

export function lanesOf(view: NamedView): PlayerLanes[] {
  const bodiesOf = byColour(view);

  return view.roster.map((color) => {
    const bodies = bodiesOf.get(color) ?? [];
    const legs: Leg[] = [];
    for (const b of bodies) {
      const last = legs[legs.length - 1];
      // A direction change starts the next leg; later legs stack on the last lane.
      if (last && last.bodies[0]!.dir === b.dir) last.bodies.push(b);
      else legs.push({ lane: Math.min(legs.length, MAX_LANES - 1), bodies: [b] });
    }
    return {
      color,
      live: bodies.find((b) => b.live) ?? null,
      legs,
      laneCount: Math.max(1, Math.min(legs.length, MAX_LANES))
    };
  });
}
