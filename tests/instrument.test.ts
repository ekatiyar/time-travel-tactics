import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { Match } from '../play/src/engine/index.js';
import type { ConfigInput } from '../play/src/engine/index.js';
import { instrumentAt } from '../play/src/instrument.js';
import { MAX_LANES } from '../play/src/lanes.js';

type MatchInstance = ReturnType<typeof Match.fromConfig>;

const WIDTH = 900;

function cfg(over: Partial<ConfigInput> = {}): ConfigInput {
  return { mode: 'sandbox', w: 7, h: 7, wallPct: 0, seed: 'test', roster: ['C', 'P'], ...over };
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

describe('instrumentAt: columns', () => {
  it('draws one column per turn reached and nothing further', () => {
    const inst = instrumentAt(held(3).view('C'), WIDTH);
    const fog = inst.fog;
    assert.ok(fog, 'a running match always has unexplored turns');

    assert.equal(inst.x(0) - inst.colW / 2, inst.left, 'turn 0 starts at the gutter');
    assert.equal(inst.x(3) + inst.colW / 2, fog.x, 'the last turn reached meets the hatch');
    assert.equal(inst.colW, (inst.right - inst.left - 80) / 4, 'four columns share the rest');
  });

  it('keeps the hatch the same width however far the horizon reaches', () => {
    for (const turns of [1, 3, 12, 30]) {
      const inst = instrumentAt(held(turns).view('C'), WIDTH);
      assert.equal(inst.fog?.w, 80, `horizon ${turns}`);
      assert.equal(inst.fog?.x, inst.right - 80);
    }
  });

  it('reports where unexplored turns begin without an endpoint', () => {
    const inst = instrumentAt(held(3).view('C'), WIDTH);
    assert.equal(inst.horizon, 3);
    assert.equal(inst.fog?.from, 4);
    assert.ok(!('to' in inst.fog!));
  });

  it('drops the fog and takes the whole width once the match is won', () => {
    const view = held(4).view('C');
    view.outcome = { status: 'won', color: 'C' };
    const inst = instrumentAt(view, WIDTH);
    assert.equal(inst.fog, null);
    assert.equal(inst.colW, (inst.right - inst.left) / 5);
  });
});

describe('instrumentAt: ticks', () => {
  it('labels every turn over a short run', () => {
    const inst = instrumentAt(held(12).view('C'), WIDTH);

    assert.deepEqual(inst.ticks, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it('thins out over a long one', () => {
    const inst = instrumentAt(held(20).view('C'), WIDTH);

    assert.deepEqual(inst.ticks, [0, 5, 10, 15, 20]);
  });

  it('keeps labels sparse beyond the former turn limit', () => {
    const view = held(1).view('C');
    view.me.horizon = 10000 as typeof view.me.horizon;
    const inst = instrumentAt(view, WIDTH);
    assert.ok(inst.ticks.length <= 13);
    assert.equal(inst.ticks[0], 0);
    assert.equal(inst.fog?.from, 10001);
  });
});

describe('instrumentAt: rows', () => {
  it('gives every roster colour a row of the same height', () => {
    const inst = instrumentAt(held(3, { roster: ['P', 'C', 'T'] }).view('C'), WIDTH);

    assert.deepEqual(inst.rows.map((r) => r.color), ['P', 'C', 'T'], 'roster order');
    const tops = inst.rows.map((r) => r.top);
    assert.equal(tops[1]! - tops[0]!, tops[2]! - tops[1]!, 'rows are evenly spaced');
    assert.ok(inst.rows[0]!.legs.length, 'each row carries its lanes');
  });

  it('spaces lanes evenly inside a row', () => {
    const inst = instrumentAt(held(3).view('C'), WIDTH);
    const row = inst.rows[0]!;
    const pitch = row.laneY(1) - row.laneY(0);

    assert.ok(pitch > 0, 'lanes are stacked, not collapsed on each other');
    assert.equal(row.laneY(2) - row.laneY(1), pitch, 'evenly');
    assert.ok(row.laneY(0) > row.top, 'lane 0 sits below the row divider');
    assert.ok(row.laneY(MAX_LANES - 1) < row.top + inst.rows[1]!.top - row.top,
      'four lanes fit inside one row');
  });

  it('is tall enough for every row plus the axis', () => {
    const two = instrumentAt(held(3).view('C'), WIDTH);
    const three = instrumentAt(held(3, { roster: ['C', 'P', 'T'] }).view('C'), WIDTH);
    const rowH = three.height - two.height;

    assert.equal(three.rows[1]!.top - three.rows[0]!.top, rowH, 'one more row is one row taller');
    assert.ok(two.bottom < two.height, 'the axis sits under the plot');
    assert.ok(two.top < two.rows[0]!.top);
  });
});
