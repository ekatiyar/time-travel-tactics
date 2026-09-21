// Splits each player's bodies into the lanes the timeline instrument draws.
// Pure so the leg split can be tested without a DOM.

import type { Color, Dir, ViewBody } from './engine/index.js';
import type { NamedView } from './scene.js';

// `brokenBefore` means this leg's first index does not follow the previous leg's last, so the
// inversion joining them happened past the viewer's horizon. Within a leg `dir` is constant and
// `t` monotone, so unseen bodies are always a prefix or a suffix and only boundaries need checking.
export type Leg = { lane: number; bodies: ViewBody[]; brokenBefore: boolean };
export type PlayerLanes = {
  color: Color; live: ViewBody | null; legs: Leg[]; laneCount: number; scrolledOff: number;
};

export const MAX_LANES = 4;

function byColour(view: NamedView): Map<Color, ViewBody[]> {
  const out = new Map<Color, ViewBody[]>();
  for (const c of view.roster) out.set(c, []);
  for (const b of view.bodies) out.get(b.color)?.push(b);
  for (const bodies of out.values()) bodies.sort((a, b) => a.p - b.p);
  return out;
}

// Which leg each body belongs to, keyed `color:p`. Counts every leg, unlike `Leg.lane`: a row
// scrolls to its latest MAX_LANES, so only this number identifies a leg on its own.
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
    const all: Leg[] = [];
    for (const b of bodies) {
      const last = all[all.length - 1];
      // A direction change starts the next leg.
      if (last && last.bodies[0]!.dir === b.dir) last.bodies.push(b);
      else {
        const prev = last?.bodies[last.bodies.length - 1];
        all.push({ lane: 0, bodies: [b], brokenBefore: prev ? b.p !== prev.p + 1 : false });
      }
    }

    // Only the latest MAX_LANES legs fit, so the window scrolls rather than stacking the rest
    // on the last lane on top of each other.
    const scrolledOff = Math.max(0, all.length - MAX_LANES);
    const legs = all.slice(scrolledOff);
    legs.forEach((leg, i) => { leg.lane = i; });

    return {
      color,
      live: bodies.find((b) => b.live) ?? null,
      legs,
      laneCount: Math.max(1, legs.length),
      scrolledOff
    };
  });
}
