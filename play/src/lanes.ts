import type { Color, Dir, View, ViewBody } from './engine/index.js';

// A gap in personal indices means the joining inversion is beyond the viewer's horizon.
export type Leg = { lane: number; bodies: ViewBody[]; brokenBefore: boolean };
export type PlayerLanes = {
  color: Color; live: ViewBody | null; legs: Leg[]; scrolledOff: number;
};

export const MAX_LANES = 4;

function byColour(view: View): Map<Color, ViewBody[]> {
  const out = new Map<Color, ViewBody[]>();
  for (const c of view.roster) out.set(c, []);
  for (const b of view.bodies) out.get(b.color)?.push(b);
  for (const bodies of out.values()) bodies.sort((a, b) => a.p - b.p);
  return out;
}

// Which leg each body belongs to, keyed `color:p`. Counts every leg, unlike `Leg.lane`: a row
// scrolls to its latest MAX_LANES, so only this number identifies a leg on its own.
export function legIndexes(view: View): Map<string, number> {
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

export function lanesOf(view: View): PlayerLanes[] {
  const bodiesOf = byColour(view);

  return view.roster.map((color) => {
    const bodies = bodiesOf.get(color) ?? [];
    const all: Leg[] = [];
    for (const b of bodies) {
      const last = all[all.length - 1];
      if (last && last.bodies[0]!.dir === b.dir) last.bodies.push(b);
      else {
        const prev = last?.bodies[last.bodies.length - 1];
        all.push({ lane: 0, bodies: [b], brokenBefore: prev ? b.p !== prev.p + 1 : false });
      }
    }

    const scrolledOff = Math.max(0, all.length - MAX_LANES);
    const legs = all.slice(scrolledOff);
    legs.forEach((leg, i) => { leg.lane = i; });

    return {
      color,
      live: bodies.find((b) => b.live) ?? null,
      legs,
      scrolledOff
    };
  });
}
