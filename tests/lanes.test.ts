import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { Match } from '../play/src/engine/index.js';
import type { Color, ConfigInput } from '../play/src/engine/index.js';
import { lanesOf } from '../play/src/lanes.js';
import type { PlayerLanes } from '../play/src/lanes.js';
import type { NamedView } from '../play/src/scene.js';

type MatchInstance = ReturnType<typeof Match.fromConfig>;
type Script = Record<string, string>;

function cfg(over: Partial<ConfigInput> = {}): ConfigInput {
  return { mode: 'sandbox', w: 7, h: 7, wallPct: 0, seed: 'test', cap: 40, roster: ['C', 'P'], ...over };
}

function match(over: Partial<ConfigInput> = {}): MatchInstance {
  return Match.fromConfig(cfg(over));
}

function play(m: MatchInstance, actions: Record<string, string>): void {
  const turn = m.currentTurn();
  const hash = m.stateHash();
  for (const [color, action] of Object.entries(actions)) {
    const r = m.submit({ turn, color, action, hash });
    assert.ok(r.ok, `submit ${color} ${action} on turn ${turn}: ${r.error}`);
  }
  assert.equal(m.currentTurn(), turn + 1, 'a turn resolves once every colour has submitted');
}

// One column of actions per colour; turn i plays character i of every string.
function run(m: MatchInstance, script: Script): void {
  const n = Math.max(...Object.values(script).map((s) => s.length));
  for (let i = 0; i < n; i++) {
    const acts: Record<string, string> = {};
    for (const [color, s] of Object.entries(script)) {
      const a = s[i];
      assert.ok(a, `${color} has no action for turn ${i}`);
      acts[color] = a;
    }
    play(m, acts);
  }
}

function named(m: MatchInstance, color: string): NamedView {
  return { ...m.view(color), names: {} };
}

function lanesFor(view: NamedView, color: Color): PlayerLanes {
  const found = lanesOf(view).find((l) => l.color === color);
  assert.ok(found, `no lanes for ${color}`);
  return found;
}

// Personal indexes and direction per leg; enough to read the split without the coordinates.
function shape(lanes: PlayerLanes): Array<[number, number, number[]]> {
  return lanes.legs.map((leg) => [leg.lane, leg.bodies[0]!.dir, leg.bodies.map((b) => b.p)]);
}

describe('lanesOf: roster', () => {
  it('returns one entry per colour in roster order', () => {
    const m = match({ roster: ['P', 'C', 'T'] });
    run(m, { C: 'D', P: 'A', T: 'A' });

    assert.deepEqual(lanesOf(named(m, 'C')).map((l) => l.color), ['P', 'C', 'T']);
  });

  it('gives a colour one leg from its spawn body alone', () => {
    const m = match();
    const lanes = lanesOf(named(m, 'C'));

    assert.equal(lanes.length, 2);
    assert.deepEqual(lanes.map((l) => shape(l)), [
      [[0, 1, [0]]],
      [[0, 1, [0]]]
    ], 'before any turn resolves each colour has only its spawn body');
    assert.deepEqual(lanes.map((l) => l.laneCount), [1, 1]);
  });
});

describe('lanesOf: legs', () => {
  it('puts a colour that only walked forward in one lane', () => {
    const m = match();
    run(m, { C: 'DDD', P: 'HHH' });
    const lanes = lanesFor(named(m, 'C'), 'C');

    assert.deepEqual(shape(lanes), [[0, 1, [0, 1, 2, 3]]]);
    assert.equal(lanes.laneCount, 1);
    assert.equal(lanes.live?.p, 3);
  });

  it('starts a new leg on every inversion, alternating direction', () => {
    const m = match();
    // Forward to (2,1) at t1, invert, step back to (3,1) at t0, invert, hold forward to t1.
    run(m, { C: 'DIDIH', P: 'HHHHH' });
    const lanes = lanesFor(named(m, 'C'), 'C');

    assert.deepEqual(shape(lanes), [
      [0, 1, [0, 1]],
      [1, -1, [2, 3]],
      [2, 1, [4, 5]]
    ]);
    assert.equal(lanes.laneCount, 3);
  });

  it('scrolls to the latest four legs once a colour has more', () => {
    const m = match();
    // Six legs: the spawn body walking forward, then one per inversion.
    run(m, { C: 'IIIII', P: 'HHHHH' });
    const lanes = lanesFor(named(m, 'C'), 'C');

    assert.deepEqual(shape(lanes), [
      [0, 1, [2]],
      [1, -1, [3]],
      [2, 1, [4]],
      [3, -1, [5]]
    ], 'the two oldest legs are dropped and the rest slide up to lane 0');
    assert.equal(lanes.scrolledOff, 2, 'two legs sit off the top of the window');
    assert.equal(lanes.laneCount, 4);
  });

  it('reports nothing scrolled off while a colour fits in four lanes', () => {
    const m = match();
    run(m, { C: 'III', P: 'HHH' });
    const lanes = lanesFor(named(m, 'C'), 'C');

    assert.equal(lanes.legs.length, 4);
    assert.equal(lanes.scrolledOff, 0);
    assert.deepEqual(shape(lanes).map((s) => s[0]), [0, 1, 2, 3]);
  });
});

describe('lanesOf: broken boundaries', () => {
  it('leaves a boundary unbroken when the two legs are adjacent indexes', () => {
    const m = match();
    run(m, { C: 'DIDIH', P: 'HHHHH' });
    const lanes = lanesFor(named(m, 'C'), 'C');

    assert.deepEqual(lanes.legs.map((l) => l.brokenBefore), [false, false, false],
      'the viewer saw every inversion, so no boundary is broken');
  });

  it('marks a boundary broken when the inversion joining it is past the horizon', () => {
    const m = match();
    // Purple bounces between t0 and t1 so its horizon stops at t1. Coral walks out to t4,
    // inverts there, and holds its way back, so purple sees the two ends and not the turn.
    run(m, { C: 'DDDDIHHHH', P: 'DIHIHIHIH' });
    const view = named(m, 'P');

    assert.equal(view.me.horizon, 1);
    const lanes = lanesFor(view, 'C');
    assert.deepEqual(shape(lanes), [
      [0, 1, [0, 1]],
      [1, -1, [8, 9]]
    ], 'coral p2 to p7 sit past t1');
    assert.deepEqual(lanes.legs.map((l) => l.brokenBefore), [false, true]);
    assert.equal(lanes.live?.p, 9, 'coral walked back into view, so its live body is on screen');
  });
});

describe('lanesOf: ordering', () => {
  it('sorts the bodies of every leg by personal index', () => {
    const m = match();
    run(m, { C: 'DDIHH', P: 'HHHHH' });
    const lanes = lanesFor(named(m, 'C'), 'C');

    for (const leg of lanes.legs) {
      const ps = leg.bodies.map((b) => b.p);
      assert.deepEqual(ps, ps.slice().sort((a, b) => a - b), 'ascending within a leg');
    }
    assert.deepEqual(lanes.legs.flatMap((l) => l.bodies.map((b) => b.p)), [0, 1, 2, 3, 4, 5]);
  });
});

describe('lanesOf: live body', () => {
  it('finds the live body of each colour the viewer can see', () => {
    const m = match();
    run(m, { C: 'DDD', P: 'HHH' });
    const view = named(m, 'C');

    assert.equal(lanesFor(view, 'C').live?.p, 3);
    assert.equal(lanesFor(view, 'P').live?.p, 3);
    assert.ok(lanesFor(view, 'C').live?.live, 'the body is the one flagged live');
  });

  it('reports no live body for a colour whose present is past the viewer horizon', () => {
    const m = match();
    // Purple inverts twice then holds, so its horizon stops at t1 while coral reaches t3.
    run(m, { C: 'DDD', P: 'IIH' });
    const view = named(m, 'P');

    assert.equal(view.me.horizon, 1);
    assert.equal(lanesFor(view, 'C').live, null, 'coral p3 sits at t3, beyond the horizon');
    assert.deepEqual(lanesFor(view, 'C').legs.flatMap((l) => l.bodies.map((b) => b.p)), [0, 1]);
    assert.equal(lanesFor(view, 'P').live?.p, 3);
  });
});
