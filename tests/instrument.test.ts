import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { Match } from '../play/src/engine/index.js';
import type { ConfigInput } from '../play/src/engine/index.js';
import { instrumentAt, maxLookBack } from '../play/src/instrument.js';
import { MAX_LANES } from '../play/src/lanes.js';
import type { NamedView } from '../play/src/scene.js';

type MatchInstance = ReturnType<typeof Match.fromConfig>;

const WIDTH = 900;

function cfg(over: Partial<ConfigInput> = {}): ConfigInput {
  return { mode: 'sandbox', w: 7, h: 7, wallPct: 0, seed: 'test', cap: 40, roster: ['C', 'P'], ...over };
}

// Everyone holds, so every colour's world turn climbs by one and nobody blocks anybody.
function held(turns: number, over: Partial<ConfigInput> = {}): MatchInstance {
  const m = Match.fromConfig(cfg(over));
  for (let i = 0; i < turns; i++) {
    const turn = m.currentTurn(), hash = m.stateHash();
    for (const color of cfg(over).roster) {
      const r = m.submit({ turn, color, action: 'H', hash });
      assert.ok(r.ok, `hold ${color} on turn ${turn}: ${r.error}`);
    }
  }
  return m;
}

function view(m: MatchInstance, color: string): NamedView {
  return { ...m.view(color), names: {} };
}

describe('maxLookBack', () => {
  it('is a quarter of the turn cap, never less than one', () => {
    assert.equal(maxLookBack(40), 10);
    assert.equal(maxLookBack(41), 11);
    assert.equal(maxLookBack(2), 1);
  });
});

describe('instrumentAt: columns', () => {
  it('draws one column per turn reached and nothing further', () => {
    const inst = instrumentAt(view(held(3), 'C'), WIDTH);
    const fog = inst.fog;
    assert.ok(fog, 'four of forty turns played leaves something unexplored');

    assert.equal(inst.horizon, 3);
    assert.equal(inst.x(0) - inst.colW / 2, inst.left, 'turn 0 starts at the gutter');
    assert.equal(inst.x(3) + inst.colW / 2, fog.x, 'the last turn reached meets the hatch');
    assert.equal(inst.colW, (inst.right - inst.left - 80) / 4, 'four columns share the rest');
  });

  it('keeps the hatch the same width however far the horizon reaches', () => {
    for (const turns of [1, 3, 12, 30]) {
      const inst = instrumentAt(view(held(turns), 'C'), WIDTH);
      assert.equal(inst.fog?.w, 80, `horizon ${turns}`);
      assert.equal(inst.fog?.x, inst.right - 80);
    }
  });

  it('never scales to the cap', () => {
    const small = instrumentAt(view(held(12, { cap: 40 }), 'C'), WIDTH);
    const huge = instrumentAt(view(held(12, { cap: 400 }), 'C'), WIDTH);

    assert.equal(huge.colW, small.colW, 'the same twelve turns draw the same however far the cap is');
  });

  it('reports the unexplored range on the fog', () => {
    const inst = instrumentAt(view(held(3), 'C'), WIDTH);

    assert.equal(inst.fog?.from, 4);
    assert.equal(inst.fog?.to, 40);
  });

  it('drops the fog and takes the whole width once the horizon reaches the cap', () => {
    const inst = instrumentAt(view(held(4, { cap: 4 }), 'C'), WIDTH);

    assert.equal(inst.horizon, 4);
    assert.equal(inst.fog, null);
    assert.equal(inst.colW, (inst.right - inst.left) / 5);
    assert.equal(inst.capX, inst.x(4) + inst.colW / 2, 'the cap line lands on the last column');
  });

  it('puts the cap line at the right edge while anything is unexplored', () => {
    const inst = instrumentAt(view(held(3), 'C'), WIDTH);

    assert.equal(inst.capX, inst.right);
  });
});

describe('instrumentAt: ticks', () => {
  it('labels every turn over a short run', () => {
    const inst = instrumentAt(view(held(12), 'C'), WIDTH);

    assert.deepEqual(inst.ticks, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it('thins out over a long one', () => {
    const inst = instrumentAt(view(held(20), 'C'), WIDTH);

    assert.deepEqual(inst.ticks, [0, 5, 10, 15, 20]);
  });
});

describe('instrumentAt: rows', () => {
  it('gives every roster colour a row of the same height', () => {
    const inst = instrumentAt(view(held(3, { roster: ['P', 'C', 'T'] }), 'C'), WIDTH);

    assert.deepEqual(inst.rows.map((r) => r.color), ['P', 'C', 'T'], 'roster order');
    const tops = inst.rows.map((r) => r.top);
    assert.equal(tops[1]! - tops[0]!, tops[2]! - tops[1]!, 'rows are evenly spaced');
    assert.ok(inst.rows[0]!.legs.length, 'each row carries its lanes');
  });

  it('spaces lanes evenly inside a row', () => {
    const inst = instrumentAt(view(held(3), 'C'), WIDTH);
    const row = inst.rows[0]!;
    const pitch = row.laneY(1) - row.laneY(0);

    assert.ok(pitch > 0, 'lanes are stacked, not collapsed on each other');
    assert.equal(row.laneY(2) - row.laneY(1), pitch, 'evenly');
    assert.ok(row.laneY(0) > row.top, 'lane 0 sits below the row divider');
    assert.ok(row.laneY(MAX_LANES - 1) < row.top + inst.rows[1]!.top - row.top,
      'four lanes fit inside one row');
  });

  it('is tall enough for every row plus the axis', () => {
    const two = instrumentAt(view(held(3), 'C'), WIDTH);
    const three = instrumentAt(view(held(3, { roster: ['C', 'P', 'T'] }), 'C'), WIDTH);
    const rowH = three.height - two.height;

    assert.equal(three.rows[1]!.top - three.rows[0]!.top, rowH, 'one more row is one row taller');
    assert.ok(two.bottom < two.height, 'the axis sits under the plot');
    assert.ok(two.top < two.rows[0]!.top);
  });
});
