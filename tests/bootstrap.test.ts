import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { Match, metaTurn } from '../play/src/engine/index.js';
import type { Color, ConfigInput, LogEntry, TurnEvent, View } from '../play/src/engine/index.js';

type MatchInstance = ReturnType<typeof Match.fromConfig>;
type Script = Record<string, string>;
type Key = { color: Color; p: number; side: [number, number] };

// 7x7: C spawns (1,1), P spawns (5,5), center (3,3), grab tiles (2,3) (4,3) (3,2) (3,4).
function cfg(over: Partial<ConfigInput> = {}): ConfigInput {
  return { mode: 'bootstrap', w: 7, h: 7, wallPct: 0, seed: 'test', cap: 40, roster: ['C', 'P'], ...over };
}

function match(over: Partial<ConfigInput> = {}): MatchInstance {
  return Match.fromConfig(cfg(over));
}

function view(m: MatchInstance, color: string): View {
  return m.view(color);
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

function logOf(script: Script): LogEntry[] {
  const log: LogEntry[] = [];
  const n = Math.max(...Object.values(script).map((s) => s.length));
  for (let i = 0; i < n; i++) {
    for (const [color, s] of Object.entries(script)) {
      log.push({ turn: metaTurn(i), color: color as Color, action: s[i] as LogEntry['action'] });
    }
  }
  return log;
}

function keys(m: MatchInstance, viewer: string): Key[] {
  return view(m, viewer).keys.map((k) => ({ color: k.color, p: k.p, side: [k.side[0], k.side[1]] }));
}

function keysOf(m: MatchInstance, viewer: string, color: string): number[] {
  return keys(m, viewer).filter((k) => k.color === color).map((k) => k.p);
}

function events(m: MatchInstance, viewer: string, kind: TurnEvent['kind']): TurnEvent[] {
  return view(m, viewer).events.filter((e) => e.kind === kind);
}

function brief(e: TurnEvent): { turn: number; color: Color; t: number; x: number; y: number; by: Color | null } {
  return { turn: e.turn, color: e.color, t: e.t, x: e.x, y: e.y, by: e.by };
}

function fronts(m: MatchInstance, viewer: string): { t: number; x: number; y: number; target: Color | null; gap: number }[] {
  return view(m, viewer).fronts.map((f) => ({ t: f.t, x: f.x, y: f.y, target: f.target, gap: f.gap }));
}

function frontsNoGap(m: MatchInstance, viewer: string): { t: number; x: number; y: number; target: Color | null }[] {
  return view(m, viewer).fronts.map((f) => ({ t: f.t, x: f.x, y: f.y, target: f.target }));
}

function errorText(r: object): string {
  return 'error' in r && typeof r.error === 'string' ? r.error : '';
}

function assertOver(m: MatchInstance, color: string): void {
  const r = m.submit({ turn: m.currentTurn(), color, action: 'I', hash: m.stateHash() });
  assert.equal(r.ok, false, 'submit after the match ends');
  assert.equal(errorText(r), 'the match is over');
  assert.deepEqual(view(m, color).actions, [], 'no actions offered');
  assert.deepEqual(view(m, color).priority, [], 'no priority order');
}

// Purple picks up at (4,3) on turn 2 with side [-1,0]; its p4 body sits at (4,2) at t4, so the
// steal tile for that body is (3,2) at t4. Coral loops back in time and lands there on turn 8.
const EXAMPLE3: Script = { C: 'DDHHDHIAS', P: 'WWAWDDSSS' };
const MIXED_SIDES = { C: 'DSSIDWIH', P: 'WWWIAHII' } satisfies Script;

describe('bootstrap: pickup', () => {
  it('picks the key up by walking next to the center', () => {
    const m = match();
    run(m, { C: 'DSS', P: 'HHH' });

    assert.deepEqual(view(m, 'C').me, { color: 'C', p: 3, t: 3, x: 2, y: 3, dir: 1, horizon: 3, stuck: false });
    assert.deepEqual(keys(m, 'C'), [{ color: 'C', p: 3, side: [1, 0] }], 'side points at the center');
    assert.deepEqual(keys(m, 'P'), keys(m, 'C'), 'purple sees the same key');
    assert.deepEqual(view(m, 'C').keyAtCenter, [0, 1, 2], 'index 3 no longer reads center');
    assert.deepEqual(events(m, 'C', 'grab').map(brief), [{ turn: 2, color: 'C', t: 3, x: 2, y: 3, by: null }]);

    run(m, { C: 'HH', P: 'HH' });
    assert.equal(view(m, 'C').me.horizon, 5);
    assert.deepEqual(view(m, 'C').keyAtCenter, [0, 1, 2], 'the wave covers 3, 4 and 5; earlier turns still read center');
    assert.deepEqual(keysOf(m, 'C', 'C'), [3, 4, 5], 'every body the wave maps to holds');
    assert.equal(events(m, 'C', 'grab').length, 1, 'holding does not grab again');
  });

  it('does nothing on the center itself, and a holder can pick up an earlier incarnation', () => {
    const m = match();
    // Grab at (2,3) t3, invert, step onto the center at t2, then back onto (2,3) at t1.
    run(m, { C: 'DSSIDA', P: 'HHHHHH' });

    assert.deepEqual([view(m, 'C').me.t, view(m, 'C').me.x, view(m, 'C').me.y], [1, 2, 3]);
    assert.deepEqual(view(m, 'C').keyAtCenter, [0], 'the second front covers indices 1 and 2');
    assert.equal(events(m, 'C', 'grab').length, 2, 'both grabs are recorded');
    assert.deepEqual(keysOf(m, 'C', 'C'), [4, 5, 6, 6], 'p6 carries two incarnations');
  });

  it('never picks up in sandbox mode', () => {
    const m = match({ mode: 'sandbox' });
    run(m, { C: 'DSSH', P: 'HHHH' });
    assert.deepEqual(keys(m, 'C'), []);
    assert.deepEqual(view(m, 'C').keyAtCenter, []);
    assert.deepEqual(view(m, 'C').fronts, []);
    assert.equal(events(m, 'C', 'grab').length, 0);
  });

  it('grabs an earlier incarnation while a front removes a later one', () => {
    const m = match({
      w: 16, h: 9, wallPct: 11, seed: '1dzex3', cap: 50, roster: ['C', 'P', 'T']
    });
    run(m, {
      C: 'DDDDDDDISSAASD',
      P: 'AAAAWWIWWASSID',
      T: 'SAAASASAIIDIWD'
    });

    assert.ok(events(m, 'C', 'grab').map(brief).some((e) =>
      e.turn === 13 && e.color === 'C' && e.t === 1 && e.x === 7 && e.y === 4 && e.by === null
    ), 'coral picks up the earlier incarnation');
    assert.ok(keys(m, 'C').some((k) => k.color === 'C' && k.p === 14 && k.side[0] === 1 && k.side[1] === 0));
    assert.ok(!view(m, 'C').keyAtCenter.some((t) => t === 1), 'index 1 no longer reads the center');
    assert.ok(!events(m, 'C', 'lost').some((e) => e.turn === 13 && e.color === 'C'), 'coral keeps a key');
    assert.deepEqual(view(m, 'C').fronts.map((f) => f.color), ['C'], 'the earlier coral front breaks purple');
  });
});

describe('bootstrap: key side and steal', () => {
  it('steals by stepping onto the key side of the holder at its world turn', () => {
    const m = match();
    // Coral grabs at (2,3) t3 with side [1,0] and holds there; index 6 maps to coral p6 at (2,3),
    // so the grab tile at t6 is the center. Purple arrives there at t6 on turn 5.
    run(m, { C: 'DSSHHH', P: 'HHWWAA' });

    assert.deepEqual([view(m, 'P').me.t, view(m, 'P').me.x, view(m, 'P').me.y], [6, 3, 3]);
    assert.deepEqual(events(m, 'C', 'grab').map(brief), [
      { turn: 2, color: 'C', t: 3, x: 2, y: 3, by: null },
      { turn: 5, color: 'P', t: 6, x: 3, y: 3, by: 'C' }
    ]);
    assert.deepEqual(keys(m, 'C'), [
      { color: 'C', p: 3, side: [1, 0] },
      { color: 'C', p: 4, side: [1, 0] },
      { color: 'C', p: 5, side: [1, 0] },
      { color: 'P', p: 6, side: [-1, 0] }
    ], 'the key on purple faces coral; coral bodies before index 6 still hold');
    assert.deepEqual(events(m, 'C', 'lost').map(brief), [{ turn: 5, color: 'C', t: 6, x: 2, y: 3, by: 'P' }]);
  });

  it('does not steal from any other side', () => {
    const m = match();
    // Purple reaches (2,4) at t6, directly below coral's holding body at (2,3).
    run(m, { C: 'DSSHHH', P: 'HHAAAW' });

    assert.deepEqual([view(m, 'P').me.t, view(m, 'P').me.x, view(m, 'P').me.y], [6, 2, 4]);
    assert.equal(events(m, 'C', 'grab').length, 1);
    assert.deepEqual(keysOf(m, 'C', 'P'), []);
    assert.deepEqual(keysOf(m, 'C', 'C'), [3, 4, 5, 6], 'coral keeps its key');
  });

  it('cannot steal from its own bodies', () => {
    const m = match();
    // Coral holds at (2,3) through t5, inverts, and steps onto its own grab tile (3,3) at t4.
    run(m, { C: 'DSSHHID', P: 'HHHHHHH' });

    assert.deepEqual([view(m, 'C').me.t, view(m, 'C').me.x, view(m, 'C').me.y], [4, 3, 3]);
    assert.equal(events(m, 'C', 'grab').length, 1);
    assert.deepEqual(keysOf(m, 'C', 'C'), [3, 4, 5, 6, 7]);
  });

  it('can steal while already holding', () => {
    const m = match();
    run(m, EXAMPLE3);
    assert.equal(events(m, 'P', 'grab').length, 2, 'purple picked up, coral stole');
    // Coral, holding, steps onto the center at t3: purple's p3 at (4,3) faces it with side [-1,0].
    play(m, { C: 'S', P: 'A' });

    assert.deepEqual([view(m, 'C').me.t, view(m, 'C').me.x, view(m, 'C').me.y], [3, 3, 3]);
    assert.equal(events(m, 'P', 'grab').length, 3, 'coral records the steal while holding');
    assert.ok(!keysOf(m, 'P', 'P').includes(3), 'coral takes purple p3 on the exposed side');
    assert.ok(keysOf(m, 'P', 'C').includes(10), 'coral still holds');
  });

  it('steals every incarnation exposed on the matching side', () => {
    const m = match({ seed: 's0' });
    run(m, { C: 'DSSIDAI', P: 'WWAAIWH' });
    assert.equal(keysOf(m, 'C', 'C').filter((p) => p === 7).length, 2,
      'the recorded victim carries two keys on its center-facing side');

    play(m, { C: 'H', P: 'S' });

    assert.deepEqual(events(m, 'C', 'grab').map(brief).filter((e) => e.turn === 7), [
      { turn: 7, color: 'P', t: 1, x: 3, y: 3, by: 'C' }
    ], 'one action produces one player-facing grab');
    assert.equal(keysOf(m, 'C', 'C').filter((p) => p === 7).length, 0,
      'both matching incarnations leave the victim');
    assert.ok(keysOf(m, 'C', 'P').includes(8), 'the thief receives the surviving incarnation');
  });

  it('steals one stacked body’s exposed side and leaves its other side', () => {
    const m = match();
    run(m, { C: MIXED_SIDES.C.slice(0, 7), P: MIXED_SIDES.P.slice(0, 7) });
    assert.deepEqual(keys(m, 'C').filter((k) => k.color === 'C' && k.p === 7), [
      { color: 'C', p: 7, side: [0, 1] },
      { color: 'C', p: 7, side: [1, 0] }
    ]);

    play(m, { C: 'H', P: 'I' });

    assert.deepEqual(events(m, 'C', 'grab').map(brief).filter((e) => e.turn === 7), [
      { turn: 7, color: 'P', t: 1, x: 4, y: 2, by: 'C' }
    ]);
    assert.deepEqual(keys(m, 'C').filter((k) => k.color === 'C' && k.p === 7), [
      { color: 'C', p: 7, side: [0, 1] }
    ], 'the recorded body keeps its south-side incarnation');
    assert.deepEqual(keys(m, 'C').filter((k) => k.color === 'C' && k.p === 6), [
      { color: 'C', p: 6, side: [0, 1] }
    ], 'the older body on the same tile is untouched');
    assert.deepEqual(events(m, 'C', 'lost').filter((e) => e.turn === 7 && e.color === 'C'), []);
  });

  it('replays a multi-incarnation steal with both causal records', () => {
    const m = match({ seed: 's0' });
    run(m, { C: 'DSSIDAIH', P: 'WWAAIWHS' });

    // The steal records origins 2 and 7. The older front overtakes 7 in this sweep.
    assert.equal(m.stateHash(), '9e5d');
    const imported = Match.fromExport(m.export());
    assert.ok(imported.ok);
    assert.equal(imported.value.match.stateHash(), m.stateHash());
    assert.deepEqual(imported.value.match.view('C'), m.view('C'));
    assert.deepEqual(imported.value.match.view('P'), m.view('P'));
  });
});

describe('bootstrap: steal from a recorded body (example 3)', () => {
  it('leaves both live bodies holding until the wave reaches the victim', () => {
    const m = match();
    run(m, EXAMPLE3);

    assert.deepEqual(view(m, 'C').me, { color: 'C', p: 9, t: 4, x: 3, y: 2, dir: -1, horizon: 6, stuck: false });
    assert.deepEqual(events(m, 'P', 'grab').map(brief), [
      { turn: 2, color: 'P', t: 3, x: 4, y: 3, by: null },
      { turn: 8, color: 'C', t: 4, x: 3, y: 2, by: 'P' }
    ]);
    assert.deepEqual(keys(m, 'P'), [
      { color: 'C', p: 9, side: [1, 0] },
      { color: 'P', p: 3, side: [-1, 0] },
      { color: 'P', p: 7, side: [-1, 0] },
      { color: 'P', p: 8, side: [-1, 0] },
      { color: 'P', p: 9, side: [-1, 0] }
    ], 'two keys: coral p9 and purple p9 both hold; purple p4..p6 were taken');
    assert.deepEqual(keys(m, 'C'), [
      { color: 'C', p: 9, side: [1, 0] },
      { color: 'P', p: 3, side: [-1, 0] }
    ], 'coral only sees bodies within its horizon');
    assert.deepEqual(events(m, 'P', 'lost'), [], 'nothing lost yet');
    assert.deepEqual(fronts(m, 'P'), [{ t: 6, x: 6, y: 2, target: 'P', gap: 3 }], 'coral wave sits on purple p6, 3 turns from the live body');
    assert.equal(view(m, 'P').fronts[0]!.color, 'C', 'the wave belongs to the grabber');
    assert.deepEqual(fronts(m, 'C'), [{ t: 6, x: 6, y: 2, target: 'P', gap: 0 }], 'coral measures against the newest purple body it can see');

    play(m, { C: 'I', P: 'A' });
    assert.deepEqual(fronts(m, 'P'), [{ t: 8, x: 6, y: 4, target: 'P', gap: 2 }]);
    assert.ok(keysOf(m, 'P', 'P').includes(10), 'purple live p10 still holds');
    assert.deepEqual(events(m, 'P', 'lost'), []);

    play(m, { C: 'H', P: 'W' });
    assert.deepEqual(fronts(m, 'P'), [{ t: 10, x: 5, y: 5, target: 'P', gap: 1 }]);
    assert.ok(keysOf(m, 'P', 'P').includes(11), 'purple live p11 still holds');
    assert.deepEqual(events(m, 'P', 'lost'), []);

    play(m, { C: 'H', P: 'W' });
    assert.deepEqual(view(m, 'P').me, { color: 'P', p: 12, t: 12, x: 5, y: 3, dir: 1, horizon: 12, stuck: false });
    assert.deepEqual(events(m, 'P', 'lost').map(brief), [{ turn: 11, color: 'P', t: 12, x: 5, y: 3, by: 'C' }], 'lost on turn 8 + gap 3');
    assert.deepEqual(keysOf(m, 'P', 'P'), [3], 'only purple p3 holds now');
    assert.deepEqual(keysOf(m, 'P', 'C'), [9, 10, 11, 12]);
  });
});

describe('bootstrap: older wave breaks a later grab (example 1)', () => {
  // 9x9: center (4,4). Coral grabs at (3,4) t5 on turn 4. Purple inverts and grabs at (5,4) t3 on turn 5.
  const big = { w: 9, h: 9 };

  it('breaks the later event while its holder keeps the key until the wave passes', () => {
    const m = match(big);
    run(m, { C: 'DDSSS', P: 'WWAAI' });
    assert.deepEqual(events(m, 'C', 'grab').map(brief), [{ turn: 4, color: 'C', t: 5, x: 3, y: 4, by: null }]);
    assert.deepEqual(keys(m, 'C'), [{ color: 'C', p: 5, side: [1, 0] }]);

    play(m, { C: 'S', P: 'W' });
    assert.deepEqual([view(m, 'P').me.t, view(m, 'P').me.x, view(m, 'P').me.y, view(m, 'P').me.dir], [3, 5, 4, -1]);
    assert.deepEqual(events(m, 'C', 'grab').map(brief)[1], { turn: 5, color: 'P', t: 3, x: 5, y: 4, by: null });
    assert.deepEqual(keys(m, 'C'), [
      { color: 'C', p: 6, side: [1, 0] },
      { color: 'P', p: 6, side: [-1, 0] }
    ], 'purple wave covers 4 and 5; coral p5 is gone, coral p6 still reads the frozen event');
    assert.deepEqual(view(m, 'C').keyAtCenter, [0, 1, 2]);
    assert.deepEqual(fronts(m, 'C'), [{ t: 5, x: 3, y: 4, target: 'C', gap: 1 }]);
    assert.deepEqual(fronts(m, 'P'), [], 'coral p5 at t5 is beyond purple horizon 4');
    assert.deepEqual(events(m, 'C', 'lost'), []);

    play(m, { C: 'S', P: 'H' });
    assert.deepEqual(events(m, 'C', 'lost').map(brief), [{ turn: 6, color: 'C', t: 7, x: 3, y: 6, by: 'P' }]);
    assert.deepEqual(keys(m, 'C'), [{ color: 'P', p: 7, side: [-1, 0] }],
      'purple picks up the earlier t2 incarnation while holding the later one');
  });
});

describe('bootstrap: two grabs on one turn at different world turns (example 2)', () => {
  it('records both and the later one loses on the fourth turn after', () => {
    const m = match();
    // Turn 8: coral steps onto (3,2) at t9; purple, after two inversions, steps onto (4,3) at t3.
    run(m, { C: 'DDHHHHHHS', P: 'WWHHISAIW' });

    assert.deepEqual([view(m, 'C').me.t, view(m, 'C').me.p], [9, 9]);
    assert.deepEqual([view(m, 'P').me.t, view(m, 'P').me.p], [3, 9]);
    assert.deepEqual(events(m, 'C', 'grab').map(brief).sort((a, b) => a.color.localeCompare(b.color)), [
      { turn: 8, color: 'C', t: 9, x: 3, y: 2, by: null },
      { turn: 8, color: 'P', t: 3, x: 4, y: 3, by: null }
    ]);
    assert.deepEqual(keys(m, 'C'), [{ color: 'C', p: 9, side: [0, 1] }, { color: 'P', p: 9, side: [-1, 0] }]);

    play(m, { C: 'H', P: 'H' });
    assert.ok(keysOf(m, 'C', 'C').includes(10), 'turn 9: purple front 7, coral live p10 holds');
    assert.deepEqual(events(m, 'C', 'lost'), []);

    play(m, { C: 'H', P: 'H' });
    assert.deepEqual(keysOf(m, 'C', 'C'), [10, 11], 'turn 10: purple front 9 breaks coral; frozen coverage still maps p10 and p11');
    assert.deepEqual(fronts(m, 'C'), [{ t: 9, x: 3, y: 2, target: 'C', gap: 2 }]);
    assert.deepEqual(events(m, 'C', 'lost'), []);

    play(m, { C: 'H', P: 'H' });
    assert.deepEqual(keysOf(m, 'C', 'C'), [12], 'turn 11: purple front 11');
    assert.deepEqual(fronts(m, 'C'), [{ t: 11, x: 3, y: 2, target: 'C', gap: 1 }]);
    assert.deepEqual(events(m, 'C', 'lost'), []);

    play(m, { C: 'H', P: 'H' });
    assert.deepEqual(keysOf(m, 'C', 'C'), [], 'turn 12: purple front 13 passes coral live p13');
    assert.deepEqual(events(m, 'C', 'lost').map(brief), [{ turn: 12, color: 'C', t: 13, x: 3, y: 2, by: 'P' }]);
    assert.deepEqual(keysOf(m, 'C', 'P'), [9, 10, 11, 12, 13]);
  });
});

describe('bootstrap: partial key loss', () => {
  it('reports loss only after the final incarnation leaves the live body', () => {
    const m = match();
    run(m, {
      C: MIXED_SIDES.C + 'H',
      P: MIXED_SIDES.P + 'S'
    });
    assert.deepEqual(keys(m, 'C').filter((k) => k.color === 'C' && k.p === 9).map((k) => k.side),
      [[0, 1], [1, 0]], 'the live body begins with two sides');

    play(m, { C: 'H', P: 'I' });
    assert.deepEqual(keys(m, 'C').filter((k) => k.color === 'C' && k.p === 10).map((k) => k.side),
      [[0, 1]], 'the first front removes one incarnation');
    assert.deepEqual(events(m, 'C', 'lost').filter((e) => e.color === 'C'), [],
      'partial loss has no lost event');

    play(m, { C: 'H', P: 'H' });
    assert.deepEqual(keys(m, 'C').filter((k) => k.color === 'C' && k.p === 11), []);
    assert.deepEqual(events(m, 'C', 'lost').map(brief).filter((e) => e.color === 'C'), [
      { turn: 10, color: 'C', t: 5, x: 3, y: 2, by: 'P' }
    ], 'the final incarnation produces one loss');
  });
});

describe('bootstrap: same-turn overtaking', () => {
  it('breaks a grab inside the advancing wave in the same sweep', () => {
    const m = match();
    // Purple grabs at t3 on turn 4 (front 5). Coral grabs at t6 on turn 5: purple front moves to 7.
    run(m, { C: 'DDHHHS', P: 'IIWWAH' });

    assert.deepEqual(events(m, 'C', 'grab').map(brief), [
      { turn: 4, color: 'P', t: 3, x: 4, y: 3, by: null },
      { turn: 5, color: 'C', t: 6, x: 3, y: 2, by: null }
    ]);
    assert.deepEqual(keysOf(m, 'C', 'C'), [], 'coral never holds');
    assert.deepEqual(keysOf(m, 'C', 'P'), [5, 6]);

    play(m, { C: 'H', P: 'H' });
    assert.deepEqual(keysOf(m, 'C', 'C'), []);
    assert.deepEqual(keysOf(m, 'C', 'P'), [5, 6, 7]);
  });

  it('lets a grab just ahead of the wave hold for one turn', () => {
    const m = match();
    // Purple grabs at t3 on turn 6 (front 5). Coral grabs at t8 on turn 7: purple front 7.
    run(m, { C: 'DDHHHHHS', P: 'IIIIWWAH' });

    assert.deepEqual(events(m, 'C', 'grab').map(brief)[1], { turn: 7, color: 'C', t: 8, x: 3, y: 2, by: null });
    assert.deepEqual(keysOf(m, 'C', 'C'), [8]);
    assert.deepEqual(fronts(m, 'C'), [{ t: 8, x: 3, y: 2, target: 'C', gap: 1 }], 'marker sits on the body where the grab began');
    assert.deepEqual(events(m, 'C', 'lost'), []);

    play(m, { C: 'H', P: 'H' });
    assert.deepEqual(keysOf(m, 'C', 'C'), [], 'purple front 9 passes origin 8 and coral live p9');
    assert.deepEqual(events(m, 'C', 'lost').map(brief), [{ turn: 8, color: 'C', t: 9, x: 3, y: 2, by: 'P' }]);
  });
});

describe('bootstrap: pickup contest', () => {
  it('records only the priority winner', () => {
    const winners: Color[] = [];
    for (const seed of ['test', 's0']) {
      const m = match({ seed });
      run(m, { C: 'DS', P: 'WW' });
      const prio = view(m, 'C').priority;
      assert.equal(prio.length, 2);
      const [win, lose] = prio as [Color, Color];
      winners.push(win);

      play(m, { C: 'S', P: 'A' });
      assert.deepEqual([view(m, 'C').me.t, view(m, 'C').me.x, view(m, 'C').me.y], [3, 2, 3], seed);
      assert.deepEqual([view(m, 'P').me.t, view(m, 'P').me.x, view(m, 'P').me.y], [3, 4, 3], seed);

      const tile = win === 'C' ? { x: 2, y: 3 } : { x: 4, y: 3 };
      assert.deepEqual(events(m, 'C', 'grab').map(brief), [{ turn: 2, color: win, t: 3, ...tile, by: null }], seed);
      assert.deepEqual(keys(m, 'C'), [{ color: win, p: 3, side: win === 'C' ? [1, 0] : [-1, 0] }], seed);
      assert.deepEqual(keysOf(m, 'C', lose), [], `${seed}: the loser never recorded`);
    }
    assert.equal(new Set(winners).size, 2, 'the two seeds should give different winners');
  });
});

describe('bootstrap: win', () => {
  it('wins by bringing the key to t0 next to your own spawn', () => {
    const m = match();
    // Grab at (2,3) t3, invert, walk (1,3) t2, (1,2) t1, hold to (1,2) t0.
    run(m, { C: 'DSSIAW', P: 'HHHHHH' });
    assert.deepEqual(m.outcome(), { status: 'running' });
    play(m, { C: 'H', P: 'H' });

    assert.deepEqual([view(m, 'C').me.t, view(m, 'C').me.x, view(m, 'C').me.y], [0, 1, 2]);
    assert.deepEqual(m.outcome(), { status: 'won', color: 'C' });
    assert.deepEqual(view(m, 'P').outcome, { status: 'won', color: 'C' });
    assert.equal(m.currentTurn(), 7);
    assert.ok(keysOf(m, 'C', 'C').includes(7), 'the winning body holds');
    // The wave sits at front 13 of a 40 turn tape: the match ends anyway.
    assertOver(m, 'C');
    assertOver(m, 'P');
  });

  it('does not win on the spawn tile itself', () => {
    const m = match();
    // Coral stays at its spawn by inverting while purple returns the key to t0 beside it.
    // Coral steals there, but standing on its spawn is not a win.
    run(m, { C: 'IIIIIIIIIIIII', P: 'WAADWHIAAWHAH' });
    assert.deepEqual([view(m, 'C').me.t, view(m, 'C').me.x, view(m, 'C').me.y], [0, 1, 1]);
    assert.ok(keysOf(m, 'C', 'C').includes(13), 'coral holds');
    assert.deepEqual(m.outcome(), { status: 'running' });
  });

  it('does not win at t0 next to spawn without the key', () => {
    const m = match();
    run(m, { C: 'DIH', P: 'HHH' });
    assert.deepEqual([view(m, 'C').me.t, view(m, 'C').me.x, view(m, 'C').me.y], [0, 2, 1]);
    assert.deepEqual(keys(m, 'C'), []);
    assert.deepEqual(m.outcome(), { status: 'running' });
  });

  it('resolves a simultaneous win by that turn priority', () => {
    // Purple picks up on turn 2; coral steals from purple p4 on turn 10 with gap 5; both reach t0
    // next to their spawns on turn 14 while still holding.
    const script: Script = { C: 'DDHHDHAIHHSAAH', P: 'WWAWDDSISSHHHH' };
    const winners: Color[] = [];
    for (const seed of ['test', 's2']) {
      const m = match({ seed });
      run(m, script);
      assert.deepEqual(events(m, 'C', 'grab').map(brief).map((e) => [e.turn, e.color, e.by]), [[2, 'P', null], [10, 'C', 'P']], seed);
      assert.deepEqual(m.outcome(), { status: 'running' }, seed);
      const prio = view(m, 'C').priority;
      play(m, { C: 'H', P: 'H' });

      assert.deepEqual([view(m, 'C').me.t, view(m, 'C').me.x, view(m, 'C').me.y], [0, 1, 2], seed);
      assert.deepEqual([view(m, 'P').me.t, view(m, 'P').me.x, view(m, 'P').me.y], [0, 6, 5], seed);
      assert.ok(keysOf(m, 'P', 'C').includes(15) && keysOf(m, 'P', 'P').includes(15), `${seed}: both hold`);
      assert.deepEqual(m.outcome(), { status: 'won', color: prio[0] }, seed);
      winners.push(prio[0] as Color);
      assertOver(m, 'C');
    }
    assert.equal(new Set(winners).size, 2, 'the two seeds should give different winners');
  });
});

describe('bootstrap: draw', () => {
  it('draws at the cap with no winner', () => {
    const m = match({ cap: 4 });
    run(m, { C: 'HHH', P: 'HHH' });
    assert.deepEqual(m.outcome(), { status: 'running' });
    play(m, { C: 'H', P: 'H' });
    assert.deepEqual(m.outcome(), { status: 'draw' });
    assert.deepEqual(view(m, 'C').outcome, { status: 'draw' });
    assertOver(m, 'C');
  });
});

describe('bootstrap: determinism', () => {
  it('survives export and import with equal hash and views', () => {
    const m = match();
    run(m, EXAMPLE3);
    const r = Match.fromExport(m.export());
    assert.ok(r.ok, r.error);
    const copy = r.value.match;
    assert.equal(copy.stateHash(), m.stateHash());
    for (const c of ['C', 'P']) assert.deepEqual(copy.view(c), m.view(c), c);
  });

  it('gives two matches built from the same log the same hash', () => {
    const a = new Match(cfg(), logOf(EXAMPLE3));
    const b = new Match(cfg(), logOf(EXAMPLE3));
    const c = match();
    run(c, EXAMPLE3);
    assert.equal(a.stateHash(), b.stateHash());
    assert.equal(a.stateHash(), c.stateHash());
    assert.equal(events(a, 'P', 'grab').length, 2);
  });

  it('folds the recorded grab into the hash even when bodies are identical', () => {
    // Same log, different contest winner: bodies match, the tape does not.
    const a = match({ seed: 'test' });
    const b = match({ seed: 's0' });
    run(a, { C: 'DSS', P: 'WWA' });
    run(b, { C: 'DSS', P: 'WWA' });
    const sorted = (m: MatchInstance) => view(m, 'C').bodies.slice()
      .sort((x, y) => x.color.localeCompare(y.color) || x.p - y.p);
    assert.deepEqual(sorted(a), sorted(b), 'identical bodies');
    assert.notEqual(events(a, 'C', 'grab')[0]?.color, events(b, 'C', 'grab')[0]?.color);
    assert.notEqual(a.stateHash(), b.stateHash());

    const before = match();
    run(before, { C: 'DS', P: 'HH' });
    const h2 = before.stateHash();
    play(before, { C: 'S', P: 'H' });
    assert.notEqual(before.stateHash(), h2);
  });

  it('separates the modes in the hash', () => {
    const a = match({ mode: 'sandbox' });
    const b = match({ mode: 'bootstrap' });
    assert.notEqual(a.stateHash(), b.stateHash());
  });
});

describe('bootstrap: horizon', () => {
  it('hides keys, fronts and grab events beyond the viewer horizon', () => {
    const m = match();
    // Purple inverts twice then holds: horizon 1 when coral grabs at t3 on turn 2.
    run(m, { C: 'DSS', P: 'IIH' });
    assert.equal(view(m, 'P').me.horizon, 1);
    assert.deepEqual(keys(m, 'P'), []);
    assert.deepEqual(view(m, 'P').fronts, []);
    assert.deepEqual(events(m, 'P', 'grab'), []);
    assert.deepEqual(view(m, 'P').keyAtCenter, [0, 1]);
    assert.deepEqual(keys(m, 'C'), [{ color: 'C', p: 3, side: [1, 0] }]);
    assert.equal(events(m, 'C', 'grab').length, 1);

    play(m, { C: 'D', P: 'H' });
    assert.equal(view(m, 'P').me.horizon, 2);
    assert.deepEqual(keys(m, 'P'), []);
    assert.deepEqual(events(m, 'P', 'grab'), []);
    assert.deepEqual(view(m, 'P').keyAtCenter, [0, 1, 2]);

    play(m, { C: 'D', P: 'H' });
    assert.equal(view(m, 'P').me.horizon, 3);
    assert.deepEqual(keys(m, 'P'), [{ color: 'C', p: 3, side: [1, 0] }], 'coral p4 and p5 are still beyond purple');
    assert.deepEqual(events(m, 'P', 'grab').map(brief), [{ turn: 2, color: 'C', t: 3, x: 2, y: 3, by: null }]);
    assert.deepEqual(view(m, 'P').keyAtCenter, [0, 1, 2]);
    assert.deepEqual(keysOf(m, 'C', 'C'), [3, 4, 5]);
  });

  it('shows a wave sitting on the center only when its front is within the horizon', () => {
    // Example 2 setup: purple front 5 on turn 8 with nothing beyond; coral horizon 9, purple 4.
    const m = match();
    run(m, { C: 'DDHHHHHHS', P: 'WWHHISAIW' });
    assert.deepEqual(frontsNoGap(m, 'C'), [{ t: 5, x: 3, y: 3, target: null }]);
    assert.deepEqual(frontsNoGap(m, 'P'), []);
  });
});

describe('bootstrap: stacked victims', () => {
  it('takes from the highest personal index on the victim tile', () => {
    const m = match();
    // Purple picks up at t3, holds t4, inverts (p5 at t4), then walks away.
    // Coral reaches the center at t5, inverts, and holds back onto t4.
    run(m, { C: 'HDDSSI', P: 'WWAHIS' });
    assert.deepEqual(view(m, 'C').bodies.filter((b) => b.t === 4 && b.x === 4 && b.y === 3).map((b) => b.color + b.p), ['P4', 'P5']);
    assert.deepEqual(keysOf(m, 'C', 'P'), [3, 4, 5, 6]);

    play(m, { C: 'H', P: 'H' });
    assert.deepEqual(events(m, 'C', 'grab').map(brief)[1], { turn: 6, color: 'C', t: 4, x: 3, y: 3, by: 'P' });
    assert.deepEqual(keysOf(m, 'C', 'C'), [7]);
    assert.deepEqual(keysOf(m, 'C', 'P'), [3, 4], 'purple p5 lost its key, p4 below it did not');
  });
});

describe('bootstrap: three-way pickup contest', () => {
  it('gives the key to the first of three adjacent colours in priority order', () => {
    const winners = new Set<string>();
    for (const seed of ['tst', 'a', 'd']) {
      const m = match({ seed, roster: ['C', 'P', 'T'] });
      run(m, { C: 'DD', P: 'AA', T: 'AS' });
      const prio = view(m, 'C').priority;
      play(m, { C: 'S', P: 'W', T: 'S' });
      for (const c of ['C', 'P', 'T']) assert.equal(view(m, c).me.t, 3, c + ' stands next to the center at t3');
      assert.deepEqual(events(m, 'C', 'grab').map((e) => e.color), [prio[0]]);
      assert.deepEqual(keys(m, 'C').map((k) => k.color), [prio[0]]);
      winners.add(prio[0]!);
    }
    assert.equal(winners.size, 3, 'the seeds cover every colour winning');
  });
});
