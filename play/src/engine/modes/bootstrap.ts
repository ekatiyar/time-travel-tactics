import { DIRS, MOVES } from '../types.js';
import type {
  Body, Color, Mode, ModeView, Outcome, PersonalIndex, TurnContext, Vec, WorldTurn
} from '../types.js';
import { Timeline } from '../timeline.js';
import type { TimelineEvent } from '../timeline.js';

type Holder = { color: Color; p: PersonalIndex; side: Vec };
type Hold = { color: Color; p: number; index: number; side: Vec };
type State = { cap: number; tape: Timeline<Holder> };

const showHolder = (h: Holder): string => h.color + h.p + ':' + h.side[0] + ',' + h.side[1];
const bodyKey = (c: Color, p: number): string => c + ':' + p;

function bodyOf(ev: TimelineEvent<Holder>, index: number): { color: Color; p: number } {
  return { color: ev.value.color, p: ev.value.p + (index - ev.origin) };
}

// Every key occurrence, per the tape right now. Several indices may name the same body.
function holdings(s: State): Hold[] {
  const out: Hold[] = [];
  let top = 0;
  for (const e of s.tape.events()) top = Math.max(top, e.front);
  for (let i = 0; i <= top; i++) {
    const r = s.tape.at(i);
    if (!r) continue;
    const b = bodyOf(r.event, i);
    out.push({ color: b.color, p: b.p, index: i, side: r.event.value.side });
  }
  return out;
}

function holdingsByBody(held: readonly Hold[]): Map<string, Hold[]> {
  const out = new Map<string, Hold[]>();
  for (const h of held) {
    const key = bodyKey(h.color, h.p), list = out.get(key);
    if (list) list.push(h); else out.set(key, [h]);
  }
  return out;
}

function adjacentDir(from: Vec, to: Vec): Vec | null {
  for (const m of MOVES) {
    const d = DIRS[m];
    if (from[0] + d[0] === to[0] && from[1] + d[1] === to[1]) return d;
  }
  return null;
}

function findBody(bodies: readonly Body[], color: Color, p: number): Body | null {
  for (const b of bodies) if (b.color === color && b.p === p) return b;
  return null;
}

function grabs(s: State, turn: TurnContext): void {
  const held = holdings(s);
  const byBody = holdingsByBody(held);
  const taken = new Set<number>();
  for (const actor of turn.actors) {
    const here: Vec = [actor.x, actor.y];

    const toCenter = adjacentDir(here, turn.center);
    if (toCenter && s.tape.at(actor.t) === null && !taken.has(actor.t)) {
      s.tape.record(actor.t, { color: actor.color, p: actor.p, side: [toCenter[0], toCenter[1]] }, turn.turn);
      taken.add(actor.t);
      turn.events.push({ turn: turn.turn, color: actor.color, kind: 'grab', t: actor.t, x: actor.x, y: actor.y, by: null, dir: actor.dir });
      continue;
    }

    let victim: Body | null = null, at: Hold[] = [], toward: Vec = [0, 0];
    for (const m of MOVES) {
      const d = DIRS[m];
      for (const b of turn.bodiesAt(actor.t, actor.x + d[0], actor.y + d[1])) {
        if (b.color === actor.color) continue;
        const found = (byBody.get(bodyKey(b.color, b.p)) ?? []).filter((h) =>
          h.side[0] === -d[0] && h.side[1] === -d[1] && !taken.has(h.index)
        );
        if (!found.length) continue;
        if (victim && b.p <= victim.p) continue;
        victim = b; at = found; toward = d;
      }
    }
    if (!victim) continue;
    for (const h of at) {
      s.tape.record(h.index, { color: actor.color, p: actor.p, side: [toward[0], toward[1]] }, turn.turn);
      taken.add(h.index);
    }
    turn.events.push({ turn: turn.turn, color: actor.color, kind: 'grab', t: actor.t, x: actor.x, y: actor.y, by: victim.color, dir: actor.dir });
  }
}

function liveHolds(s: State, turn: TurnContext): Map<Color, Hold> {
  const held = holdings(s);
  const out = new Map<Color, Hold>();
  for (const h of held) {
    const pl = turn.players[h.color];
    if (pl?.p === h.p) out.set(h.color, h);
  }
  return out;
}

export const bootstrap: Mode<State> = {
  id: 'bootstrap',
  init: (cfg) => ({ cap: cfg.cap, tape: new Timeline<Holder>(showHolder) }),

  afterTurn(s, turn) {
    const before = liveHolds(s, turn);
    grabs(s, turn);
    s.tape.advance(2, s.cap);
    const after = liveHolds(s, turn);
    for (const [c, h] of before) {
      if (after.has(c)) continue;
      const pl = turn.players[c]!;
      const r = s.tape.at(h.index);
      turn.events.push({
        turn: turn.turn, color: c, kind: 'lost', t: pl.t, x: pl.x, y: pl.y,
        by: r ? r.event.value.color : null, dir: pl.dir
      });
    }
  },

  outcome(s, turn): Outcome {
    const live = liveHolds(s, turn);
    for (const c of turn.prio) {
      const pl = turn.players[c], spawn = turn.spawns[c];
      if (!pl || !spawn || pl.t !== 0 || !live.has(c)) continue;
      if (adjacentDir([pl.x, pl.y], spawn)) return { status: 'won', color: c };
    }
    return { status: 'running' };
  },

  digest: (s) => s.tape.digest(),

  view(s, turn, horizon): ModeView {
    const out: ModeView = { keys: [], keyAtCenter: [], fronts: [] };
    for (const h of holdings(s)) {
      const b = findBody(turn.bodies, h.color, h.p);
      if (b && b.t <= horizon) out.keys.push({ color: h.color, p: b.p, side: [h.side[0], h.side[1]] });
    }
    out.keys.sort((a, b) => a.color === b.color ? a.p - b.p : (a.color < b.color ? -1 : 1));
    for (let t = 0; t <= horizon; t++) if (s.tape.at(t) === null) out.keyAtCenter.push(t as WorldTurn);
    for (const e of s.tape.events()) {
      if (!e.counts) continue;
      const f = e.front, next = s.tape.at(f + 1);
      if (!next) {
        if (f <= horizon) out.fronts.push({ color: e.value.color, t: f as WorldTurn, x: turn.center[0], y: turn.center[1], target: null, gap: 0 });
        continue;
      }
      const x = next.event, target = x.value.color;
      // Never point before the body where the displaced grab began.
      const idx = x.value.p + Math.max(0, f - x.origin);
      const b = findBody(turn.bodies, target, idx);
      if (!b || b.t > horizon) continue;
      // Measure against the newest body the viewer can see, not the live one.
      let seen = -1;
      for (const o of turn.bodies) if (o.color === target && o.p > seen) seen = o.p;
      const gap = x.origin + (seen - x.value.p) - f;
      out.fronts.push({ color: e.value.color, t: b.t, x: b.x, y: b.y, target, gap });
    }
    return out;
  }
};
