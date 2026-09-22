import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { Match } from '../play/src/engine/index.js';
import type { Color, ConfigInput, TurnEvent, ViewBody } from '../play/src/engine/index.js';
import {
  describe as describeBody, frontText, keyHolders, motionBetween, nameOf, plural,
  relativeDirection, sceneAt, shade
} from '../play/src/scene.js';
import type { NamedView, Scene } from '../play/src/scene.js';

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

function named(m: MatchInstance, color: string, names: Partial<Record<Color, string>> = {}): NamedView {
  return { ...m.view(color), names };
}

function eventsOn(m: MatchInstance, color: string, turn: number): TurnEvent[] {
  return m.view(color).events.filter((e) => e.turn === turn);
}

function bodyOf(view: NamedView, color: string, p: number): ViewBody {
  const b = view.bodies.find((o) => o.color === color && o.p === p);
  assert.ok(b, `${color} has no body p${p}`);
  return b;
}

function stackKeys(scene: Scene): string[] {
  return scene.stacks.map((s) => s.key).sort();
}

function stackAt(scene: Scene, x: number, y: number): Scene['stacks'][number] {
  const s = scene.byTile.get(x + ',' + y);
  assert.ok(s, `no stack at ${x},${y}`);
  return s;
}

describe('scene helpers', () => {
  it('pluralizes on the count', () => {
    assert.equal(plural(1, 'turn'), '1 turn');
    assert.equal(plural(0, 'turn'), '0 turns');
    assert.equal(plural(3, 'turn'), '3 turns');
  });

  it('prefers a given name over the palette name', () => {
    const v = named(match(), 'C', { C: 'Ana' });
    assert.equal(nameOf(v, 'C'), 'Ana');
    assert.equal(nameOf(v, 'P'), 'Purple', 'unnamed colours fall back to the palette');
  });

  it('reads direction relative to the viewer', () => {
    const m = match();
    run(m, { C: 'DI', P: 'HH' });
    const v = named(m, 'C');
    assert.equal(v.me.dir, -1);
    assert.equal(relativeDirection(v, { dir: -1 }), 'matching');
    assert.equal(relativeDirection(v, { dir: 1 }), 'opposing');
  });

  it('describes a body with its clocks, direction and liveness', () => {
    const m = match();
    run(m, { C: 'DD', P: 'HH' });
    const v = named(m, 'C', { C: 'Ana' });
    assert.equal(
      describeBody(v, bodyOf(v, 'C', 2)),
      'Ana, index 2, world turn 2, walking forward, same direction as you, current'
    );
    assert.equal(
      describeBody(v, bodyOf(v, 'C', 1)),
      'Ana, index 1, world turn 1, walking forward, same direction as you'
    );
  });

  it('maps a held key to its side by colour and index', () => {
    const m = match({ mode: 'bootstrap' });
    run(m, { C: 'DSS', P: 'HHH' });
    const v = named(m, 'C');
    assert.deepEqual([...keyHolders(v)], [['C:3', [1, 0]]]);
    assert.deepEqual([...keyHolders(named(match(), 'C'))], [], 'sandbox holds no keys');
  });
});

describe('sceneAt: tokens', () => {
  it('takes one token per body at the focus turn', () => {
    const m = match();
    run(m, { C: 'DD', P: 'HH' });
    const v = named(m, 'C');
    const scene = sceneAt(v, 2, 3, false);

    assert.deepEqual(
      scene.tokens.map((t) => t.key).sort(),
      ['C:2', 'P:2'],
      'the key is the colour and the personal index'
    );
    assert.ok(scene.tokens.every((t) => t.keySide === null), 'sandbox tokens hold no key');
    const c = scene.tokens.find((t) => t.color === 'C');
    assert.deepEqual(
      { p: c?.p, x: c?.x, y: c?.y, dir: c?.dir, live: c?.live },
      { p: 2, x: 3, y: 1, dir: 1, live: true }
    );
    assert.equal(scene.focusT, 2);
    assert.deepEqual(scene.center, v.center);
  });

  it('carries the key side of a holding body only', () => {
    const m = match({ mode: 'bootstrap' });
    run(m, { C: 'DSS', P: 'HHH' });
    const scene = sceneAt(named(m, 'C'), 3, 3, false);

    const holder = scene.tokens.find((t) => t.key === 'C:3');
    const other = scene.tokens.find((t) => t.key === 'P:3');
    assert.deepEqual(holder?.keySide, [1, 0], 'the side points at the center');
    assert.equal(other?.keySide, null);
  });
});

describe('sceneAt: stacks', () => {
  it('buckets bodies by tile with tokens ascending by index', () => {
    const m = match();
    // Coral walks out, inverts on (4,1), and steps down: p3 and p4 share the t3 tile.
    run(m, { C: 'DDDI', P: 'HHHH' });
    const scene = sceneAt(named(m, 'C'), 3, 3, false);

    assert.deepEqual(stackKeys(scene), ['C/0', 'P/0']);
    const c = stackAt(scene, 4, 1);
    assert.deepEqual(c.tokens.map((t) => t.p), [3, 4], 'ascending by personal index');
    assert.equal(c.color, 'C');
    assert.equal(scene.byTile.size, 2);
    assert.equal(scene.tokens.length, 3, 'two coral bodies and one purple body at t3');
  });

  it('keys a stack by its colour and leg', () => {
    const m = match();
    run(m, { C: 'DDDIS', P: 'HHHHH' });
    const scene = sceneAt(named(m, 'C'), 3, 3, false);

    assert.equal(stackAt(scene, 4, 1).key, 'C/0', 'the forward leg, even though p4 shares the tile');
    assert.equal(stackAt(scene, 5, 5).key, 'P/0');
    assert.deepEqual(
      stackAt(scene, 4, 1).tokens.map((t) => [t.p, t.leg]), [[3, 0], [4, 1]],
      'each token carries its own leg, so the merged stack still names both'
    );
  });

  it('gives each leg its own key when a colour splits across two tiles', () => {
    const m = match();
    // The inversion puts coral back on t2 at (4,2) while its p2 body still sits on (3,1).
    run(m, { C: 'DDDIS', P: 'HHHHH' });
    const scene = sceneAt(named(m, 'C'), 2, 3, false);

    assert.deepEqual(stackKeys(scene), ['C/0', 'C/1', 'P/0']);
    assert.equal(stackAt(scene, 3, 1).key, 'C/0', 'the leg walking forward');
    assert.equal(stackAt(scene, 4, 2).key, 'C/1', 'the leg walking back');
  });
});

describe('sceneAt: trails', () => {
  it('keeps only bodies inside the look-back window, newest first', () => {
    const m = match();
    // Coral steps once then holds, so (2,1) carries its t1..t4 bodies.
    run(m, { C: 'DHHH', P: 'HHHH' });
    const scene = sceneAt(named(m, 'C'), 4, 2, false);

    assert.deepEqual(scene.trails.get('2,1')?.map((b) => b.t), [3, 2], 'lo is 2, focusT is excluded');
    const all = [...scene.trails.values()].flat();
    assert.ok(all.every((b) => b.t >= 2 && b.t < 4), 'nothing outside [lo, focusT)');
    assert.ok(all.some((b) => b.t === 2), 'a body exactly at lo is drawn');
    assert.ok(!all.some((b) => b.t === 1), 'a body at lo - 1 is not');
    assert.deepEqual([...scene.trails.keys()].sort(), ['2,1', '5,5']);
  });

  it('clamps the window at turn zero', () => {
    const m = match();
    run(m, { C: 'DHHH', P: 'HHHH' });
    const scene = sceneAt(named(m, 'C'), 2, 10, false);

    assert.deepEqual(scene.trails.get('1,1')?.map((b) => b.t), [0], 'lo never goes below 0');
    assert.deepEqual(scene.trails.get('2,1')?.map((b) => b.t), [1]);
  });
});

describe('sceneAt: shade', () => {
  it('spreads opacity from one at the newest turn to the floor at the oldest', () => {
    const m = match();
    run(m, { C: 'DHHH', P: 'HHHH' });
    const v = named(m, 'C');
    const scene = sceneAt(v, 4, 3, false, 0.25);

    assert.deepEqual([...scene.shade.keys()].sort(), [1, 2, 3], 'exactly the turns in the window');
    assert.equal(scene.shade.get(3), 1, 'newest');
    assert.equal(scene.shade.get(2), 0.625);
    assert.equal(scene.shade.get(1), 0.25, 'oldest sits on the floor');
    assert.deepEqual(scene.shade, shade(v.bodies, 4, 3, 0.25));
  });

  it('gives a single visible turn full opacity', () => {
    const m = match();
    run(m, { C: 'DHHH', P: 'HHHH' });
    const scene = sceneAt(named(m, 'C'), 4, 1, false, 0.25);

    assert.deepEqual([...scene.shade], [[3, 1]]);
  });

  it('is empty when nothing precedes the focus turn', () => {
    const m = match();
    run(m, { C: 'D', P: 'H' });
    assert.equal(sceneAt(named(m, 'C'), 0, 3, false).shade.size, 0);
  });
});

describe('sceneAt: targets', () => {
  it('offers the four moves at the current turn while choosing', () => {
    const m = match();
    run(m, { C: 'W', P: 'H' });
    const v = named(m, 'C');
    const scene = sceneAt(v, 1, 3, true);

    assert.equal(v.me.t, 1);
    assert.deepEqual([...scene.targets.keys()].sort(), ['0,0', '1,-1', '1,1', '2,0']);
    assert.ok([...scene.targets.values()].every((a) => a.move), 'holds and inversions are not targets');
    assert.ok(!scene.targets.has(v.me.x + ',' + v.me.y), 'the tile you stand on is not a target');
    assert.equal(scene.targets.get('0,0')?.reason, null, 'a legal offer');
    assert.equal(scene.targets.get('1,-1')?.reason, 'off the board', 'an illegal offer is still keyed');
    assert.equal(scene.targets.get('1,-1')?.action, 'W');
  });

  it('offers nothing when not choosing or when the focus turn is not the current one', () => {
    const m = match();
    run(m, { C: 'W', P: 'H' });
    const v = named(m, 'C');

    assert.equal(sceneAt(v, 1, 3, false).targets.size, 0, 'not choosing');
    assert.equal(sceneAt(v, 0, 3, true).targets.size, 0, 'an earlier turn');
  });
});

describe('sceneAt: key at center', () => {
  it('is true only on the turns the view still reads as center', () => {
    const m = match({ mode: 'bootstrap' });
    run(m, { C: 'DSS', P: 'HHH' });
    const v = named(m, 'C');

    assert.deepEqual(v.keyAtCenter, [0, 1, 2]);
    assert.deepEqual([0, 1, 2, 3].map((t) => sceneAt(v, t, 3, false).keyAtCenter), [true, true, true, false]);
  });

  it('is never true in sandbox mode', () => {
    const m = match();
    run(m, { C: 'DD', P: 'HH' });
    const v = named(m, 'C');
    assert.deepEqual([0, 1, 2].map((t) => sceneAt(v, t, 3, false).keyAtCenter), [false, false, false]);
  });
});

describe('sceneAt: fronts', () => {
  // Purple picks up at (4,3) on turn 2; coral steals from its p4 body on turn 8.
  const EXAMPLE3: Script = { C: 'DDHHHHIHS', P: 'WWAWDDSSS' };

  it('keys a front by its tape event rather than the world turn it sits on', () => {
    const m = match({ mode: 'bootstrap' });
    run(m, EXAMPLE3);
    const v = named(m, 'P');
    const front = v.fronts[0];
    assert.ok(front, 'the coral wave is visible to purple');
    assert.equal(front.t, 6);

    assert.deepEqual(sceneAt(v, 6, 9, false).fronts, [
      { key: 'C#0', color: 'C', x: front.x, y: front.y, nth: 0, text: frontText(v, front) }
    ]);
    assert.equal(sceneAt(v, 7, 9, false).fronts[0]?.key, 'C#0', 'the key is the same element');
    assert.equal(sceneAt(v, 9, 9, false).fronts[0]?.text, 'reaches you in 3 turns');
  });

  it('slides a front to the tile its tape event reached', () => {
    const m = match({ mode: 'bootstrap' });
    run(m, EXAMPLE3);
    const prev = sceneAt(named(m, 'P'), 9, 9, false);
    const turn = m.currentTurn();
    run(m, { C: 'H', P: 'H' });
    const next = sceneAt(named(m, 'P'), 10, 9, false);

    assert.deepEqual(prev.fronts.map((f) => [f.key, f.x, f.y]), [['C#0', 6, 2]]);
    assert.deepEqual(next.fronts.map((f) => [f.key, f.x, f.y]), [['C#0', 6, 4]]);
    assert.deepEqual(
      motionBetween(prev, next, eventsOn(m, 'P', turn)),
      [{ kind: 'slide', key: 'C#0' }],
      'nobody moved at the focus turn, so the front is the only motion'
    );
  });

  it('drops fronts outside the window', () => {
    const m = match({ mode: 'bootstrap' });
    run(m, EXAMPLE3);
    const v = named(m, 'P');

    assert.deepEqual(sceneAt(v, 5, 9, false).fronts, [], 'later than the focus turn');
    assert.deepEqual(sceneAt(v, 7, 0, false).fronts, [], 'older than lo');
  });

  it('gives every drawn front a unique key', () => {
    const m = match({ mode: 'bootstrap' });
    run(m, EXAMPLE3);
    const v = named(m, 'P');

    for (const focusT of [6, 7, 8, 9]) {
      const keys = sceneAt(v, focusT, 9, false).fronts.map((f) => f.key);
      assert.equal(new Set(keys).size, keys.length, 'focus ' + focusT);
    }
  });
});

describe('motionBetween: scrubbing and jumps', () => {
  it('snaps when the focus jumps more than one turn', () => {
    const m = match();
    run(m, { C: 'DD', P: 'AA' });
    const v = named(m, 'C');

    assert.deepEqual(motionBetween(sceneAt(v, 0, 3, false), sceneAt(v, 2, 3, false), eventsOn(m, 'C', 1)), []);
  });

  it('reads a direction change as an inversion when there are no events', () => {
    const m = match();
    // Coral steps to (2,1), holds onto t2, then inverts in place: t2 keeps both bodies.
    run(m, { C: 'DHI', P: 'HHH' });
    const v = named(m, 'C');

    assert.deepEqual(motionBetween(sceneAt(v, 1, 3, false), sceneAt(v, 2, 3, false), []), [
      { kind: 'invert', key: 'C/0' }
    ]);
    assert.deepEqual(motionBetween(sceneAt(v, 2, 3, false), sceneAt(v, 1, 3, false), []), [
      { kind: 'invert', key: 'C/0' }
    ], 'scrubbing the other way reads the same');
  });

  it('reads no motion while scrubbing across turns with the same direction', () => {
    const m = match();
    run(m, { C: 'DH', P: 'HH' });
    const v = named(m, 'C');

    assert.deepEqual(motionBetween(sceneAt(v, 1, 3, false), sceneAt(v, 2, 3, false), []), [],
      'coral held, so its stack neither moved nor turned');
  });
});

describe('motionBetween: resolved turns', () => {
  it('slides a stack that kept its key and changed tile', () => {
    const m = match();
    run(m, { C: 'D', P: 'A' });
    const prev = sceneAt(named(m, 'C'), 1, 3, false);
    run(m, { C: 'D', P: 'A' });
    const next = sceneAt(named(m, 'C'), 2, 3, false);

    assert.deepEqual(motionBetween(prev, next, eventsOn(m, 'C', 1)), [
      { kind: 'slide', key: 'C/0' },
      { kind: 'slide', key: 'P/0' }
    ]);
    assert.equal(stackAt(prev, 2, 1).key, 'C/0');
    assert.equal(stackAt(next, 3, 1).key, 'C/0', 'a leg keeps its key across the turn');
  });

  it('inverts in place and claims the colour away from a slide', () => {
    const m = match();
    run(m, { C: 'DD', P: 'HH' });
    const prev = sceneAt(named(m, 'C'), 2, 3, false);
    run(m, { C: 'I', P: 'H' });
    const next = sceneAt(named(m, 'C'), 2, 3, false);

    assert.deepEqual(motionBetween(prev, next, eventsOn(m, 'C', 2)), [{ kind: 'invert', key: 'C/0' }]);
    assert.equal(stackAt(next, 3, 1).tokens.length, 2, 'the inverted body lands on the same tile');
    assert.equal(stackAt(next, 3, 1).key, 'C/0', 'the older leg names the merged tile, so the element survives');
  });

  it('bounces toward the blocker', () => {
    const m = match({ w: 5, h: 5, roster: ['C', 'P', 'T'] });
    // Coral (1,1), teal (2,1) and purple (3,1) line up at t2; both movers bounce right.
    run(m, { C: 'HH', T: 'AH', P: 'WW' });
    const prev = sceneAt(named(m, 'C'), 2, 3, false);
    run(m, { C: 'D', T: 'D', P: 'H' });
    const v = named(m, 'C');
    const next = sceneAt(v, 3, 3, false);
    const events = eventsOn(m, 'C', 2);

    assert.deepEqual(
      events.filter((e) => e.kind === 'blocked').map((e) => [e.color, e.by, e.x, e.y]),
      [['T', 'P', 2, 1], ['C', 'T', 1, 1]]
    );
    assert.deepEqual(motionBetween(prev, next, events), [
      { kind: 'bounce', key: 'T/0', toward: [3, 1] },
      { kind: 'bounce', key: 'C/0', toward: [2, 1] }
    ], 'each bounce points at the adjacent body that stopped it');
  });

  it('drops a bounce whose blocker has no single adjacent body', () => {
    const m = match();
    // Purple doubles back so t5 carries a body on (3,4) and one on (2,3); coral, standing on
    // (2,4), is blocked walking into (3,4) and both purple tiles touch it.
    run(m, { C: 'SSSDIIII', P: 'HHAAWWIA' });
    const prev = sceneAt(named(m, 'C'), 4, 3, false);
    const turn = m.currentTurn();
    run(m, { C: 'D', P: 'I' });
    const v = named(m, 'C');
    const next = sceneAt(v, 5, 3, false);
    const events = eventsOn(m, 'C', turn);

    assert.deepEqual(
      events.filter((e) => e.kind === 'blocked').map((e) => [e.color, e.by, e.x, e.y]),
      [['C', 'P', 2, 4]]
    );
    assert.deepEqual(stackKeys(next), ['C/4', 'P/0', 'P/1'], 'purple holds two tiles at t5');
    assert.deepEqual(next.byTile.get('3,4')?.color, 'P');
    assert.deepEqual(next.byTile.get('2,3')?.color, 'P');
    const motions = motionBetween(prev, next, events);
    assert.deepEqual(
      motions.filter((m) => m.kind === 'bounce'), [], 'the ambiguous bounce reads as a hold'
    );
    assert.deepEqual(
      motions,
      [{ kind: 'invert', key: 'P/1' }, { kind: 'slide', key: 'P/0' }],
      'a colour holding two tiles animates its inversion and still slides its other leg'
    );
  });

  it('slides both legs of a split colour independently', () => {
    const m = match();
    // Coral inverts on (4,1) and walks back down, so its forward and backward legs sit on
    // separate tiles and each steps once as the focus turn moves from t1 to t0.
    run(m, { C: 'DDIS', P: 'HHHH' });
    const prev = sceneAt(named(m, 'C'), 1, 4, false);
    const turn = m.currentTurn();
    run(m, { C: 'S', P: 'H' });
    const next = sceneAt(named(m, 'C'), 0, 4, false);

    assert.deepEqual(
      prev.stacks.filter((s) => s.color === 'C').map((s) => [s.key, s.x, s.y]),
      [['C/0', 2, 1], ['C/1', 3, 2]]
    );
    assert.deepEqual(
      next.stacks.filter((s) => s.color === 'C').map((s) => [s.key, s.x, s.y]),
      [['C/0', 1, 1], ['C/1', 3, 3]]
    );
    assert.deepEqual(motionBetween(prev, next, eventsOn(m, 'C', turn)), [
      { kind: 'slide', key: 'C/0' },
      { kind: 'slide', key: 'C/1' }
    ]);
  });
});

describe('motionBetween: legs parting and rejoining', () => {
  // Coral inverts on (3,1) at t2, so t2 carries p2 walking forward and p3 walking back on one
  // tile. The next step parts them: t1 holds p1 on (2,1) and p4 on (3,2).
  function parted(): { m: MatchInstance; prev: Scene; next: Scene; turn: number } {
    const m = match();
    run(m, { C: 'DDI', P: 'HHH' });
    const prev = sceneAt(named(m, 'C'), 2, 4, false);
    const turn = m.currentTurn();
    run(m, { C: 'S', P: 'H' });
    return { m, prev, next: sceneAt(named(m, 'C'), 1, 4, false), turn };
  }

  it('splits the newer leg off the tile it shared', () => {
    const { m, prev, next, turn } = parted();

    assert.deepEqual(prev.stacks.map((s) => [s.key, s.x, s.y]), [['C/0', 3, 1], ['P/0', 5, 5]]);
    assert.deepEqual(
      next.stacks.map((s) => [s.key, s.x, s.y]), [['C/0', 2, 1], ['C/1', 3, 2], ['P/0', 5, 5]]
    );
    assert.deepEqual(motionBetween(prev, next, eventsOn(m, 'C', turn)), [
      { kind: 'slide', key: 'C/0' },
      { kind: 'split', key: 'C/1', from: [3, 1] }
    ], 'the older leg slides and the leg that just got its own element comes from the shared tile');
  });

  it('splits under a scrub too, with no events to read', () => {
    const { prev, next } = parted();

    assert.deepEqual(
      motionBetween(prev, next, []).filter((m) => m.kind === 'split'),
      [{ kind: 'split', key: 'C/1', from: [3, 1] }]
    );
  });

  it('merges the newer leg back onto the shared tile when scrubbing the other way', () => {
    const { prev, next } = parted();

    assert.deepEqual(motionBetween(next, prev, []), [
      { kind: 'slide', key: 'C/0' },
      { kind: 'invert', key: 'C/0' },
      { kind: 'merge', key: 'C/1', from: [3, 2], to: [3, 1] }
    ], 'the survivor slides and settles; the leg losing its element still travels to the tile');
  });

  it('leaves a leg with no previous home to just land', () => {
    const m = match();
    // Coral inverts at t2 and walks back, so t3 is past everything its view can see.
    run(m, { C: 'DDI', P: 'HHH' });
    run(m, { C: 'S', P: 'H' });
    const prev = sceneAt(named(m, 'C'), 3, 4, false);
    const next = sceneAt(named(m, 'C'), 2, 4, false);

    assert.deepEqual(prev.stacks.map((s) => s.key), [], 'nothing is drawn at t3');
    assert.deepEqual(next.stacks.map((s) => s.key), ['C/0', 'P/0']);
    assert.deepEqual(
      motionBetween(prev, next, []).filter((m) => m.kind === 'split' || m.kind === 'merge'), []
    );
  });
});

describe('motionBetween: the key', () => {
  it('draws a pickup coming from the center', () => {
    const m = match({ mode: 'bootstrap' });
    run(m, { C: 'DS', P: 'HH' });
    const prev = sceneAt(named(m, 'C'), 2, 3, false);
    run(m, { C: 'S', P: 'H' });
    const v = named(m, 'C');
    const motions = motionBetween(prev, sceneAt(v, 3, 3, false), eventsOn(m, 'C', 2));

    assert.deepEqual(v.center, [3, 3]);
    assert.deepEqual(motions[0], { kind: 'grab', key: 'C/0', from: [3, 3] });
    assert.deepEqual(motions, [{ kind: 'grab', key: 'C/0', from: [3, 3] }, { kind: 'slide', key: 'C/0' }],
      'a grab does not claim the leg, so the step still slides');
  });

  it('draws a steal coming from the victim, and the loss on the victim', () => {
    const m = match({ mode: 'bootstrap' });
    // Coral grabs at (2,3) t3 and holds; purple steps onto the center at t6 and takes it.
    run(m, { C: 'DSSHH', P: 'HHWWA' });
    const prev = sceneAt(named(m, 'C'), 5, 4, false);
    run(m, { C: 'H', P: 'A' });
    const v = named(m, 'C');
    const events = eventsOn(m, 'C', 5);

    assert.deepEqual(
      events.filter((e) => e.kind === 'grab' || e.kind === 'lost').map((e) => [e.kind, e.color, e.by]),
      [['grab', 'P', 'C'], ['lost', 'C', 'P']]
    );
    assert.deepEqual(motionBetween(prev, sceneAt(v, 6, 4, false), events), [
      { kind: 'grab', key: 'P/0', from: [2, 3] },
      { kind: 'lost', key: 'C/0' },
      { kind: 'slide', key: 'P/0' }
    ]);
  });
});
