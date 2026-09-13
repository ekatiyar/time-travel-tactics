import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ACTIONS, Match, Wire, metaTurn, spawnFor } from '../play/src/engine.js';
import type { Config, ConfigInput, TurnEvent, View, ViewBody } from '../play/src/engine.js';

type MatchInstance = ReturnType<typeof Match.fromConfig>;

function cfg(over: Partial<ConfigInput> = {}): ConfigInput {
  return { w: 16, h: 9, wallPct: 0, seed: 'test', cap: 40, roster: ['C', 'P'], ...over };
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

function at(m: MatchInstance, color: string): [number, number] {
  const me = view(m, color).me;
  return [me.x, me.y];
}

function bodiesAt(m: MatchInstance, color: string, t: number): ViewBody[] {
  return view(m, color).bodies.filter((b) => b.color === color && b.t === t);
}

function eventsOn(m: MatchInstance, color: string, turn: number): TurnEvent[] {
  return view(m, color).events.filter((e) => e.turn === turn);
}

function legalNow(m: MatchInstance, color: string): Record<string, string | null> {
  return m.legalActions(color);
}

function freeActions(m: MatchInstance, color: string): string[] {
  const legal = legalNow(m, color);
  const free = Object.keys(legal).filter((a) => legal[a] === null);
  assert.ok(free.length, `${color} has no legal action`);
  return free;
}

function errorText(r: object): string {
  return 'error' in r && typeof r.error === 'string' ? r.error : '';
}

const DELTAS: Array<[number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1]];

function mulberry32(a: number): () => number {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('clocks', () => {
  it('advances world turn and personal index together while moving forward', () => {
    const m = match();
    play(m, { C: 'D', P: 'A' });
    play(m, { C: 'D', P: 'A' });

    const me = view(m, 'C').me;
    assert.equal(me.t, 2, 'world turn');
    assert.equal(me.p, 2, 'personal index');
    assert.equal(me.dir, 1, 'direction');
    assert.deepEqual([me.x, me.y], [2, 0]);
    assert.equal(m.currentTurn(), 2);
  });

  it('keeps incrementing the personal index while moving backward', () => {
    const m = match({ w: 8, h: 2 });
    play(m, { C: 'D', P: 'A' });
    play(m, { C: 'D', P: 'A' });
    play(m, { C: 'I', P: 'A' });
    play(m, { C: 'S', P: 'A' });

    const me = view(m, 'C').me;
    assert.equal(me.p, 4, 'personal index');
    assert.equal(me.t, 1, 'world turn');
    assert.equal(me.dir, -1);
    assert.deepEqual([me.x, me.y], [2, 1]);
  });

  it('maps palette order to fixed corners', () => {
    const m = match({ roster: ['C', 'P', 'T', 'A'] });
    assert.deepEqual(at(m, 'C'), [0, 0], 'coral top-left');
    assert.deepEqual(at(m, 'P'), [15, 8], 'purple bottom-right');
    assert.deepEqual(at(m, 'T'), [15, 0], 'teal top-right');
    assert.deepEqual(at(m, 'A'), [0, 8], 'amber bottom-left');
  });

  it('gives every colour its own corner on the smallest legal board', () => {
    const corners = (['C', 'P', 'T', 'A'] as const).map((c) => spawnFor(c, 2, 2).join(','));
    assert.equal(new Set(corners).size, 4);
  });
});

describe('inversion', () => {
  it('flips direction and spends no world turn', () => {
    const m = match({ w: 8, h: 2 });
    play(m, { C: 'D', P: 'A' });
    play(m, { C: 'D', P: 'A' });
    play(m, { C: 'D', P: 'A' });

    const before = view(m, 'C').me;
    assert.equal(before.t, 3);
    assert.deepEqual([before.x, before.y], [3, 0]);

    play(m, { C: 'I', P: 'A' });

    const after = view(m, 'C').me;
    assert.equal(after.dir, -1, 'direction flipped');
    assert.equal(after.t, 3, 'world turn unchanged, the flip costs no world time');
    assert.deepEqual([after.x, after.y], [3, 0], 'position unchanged');
    assert.equal(after.p, 4, 'personal index still incremented');

    const stack = bodiesAt(m, 'C', 3).filter((b) => b.x === 3 && b.y === 0);
    assert.equal(stack.length, 2, 'the turnstile: both instances share one (t,x,y)');
    assert.deepEqual(stack.map((b) => b.p).sort((a, b) => a - b), [3, 4]);
  });

  it('stacks three bodies when done twice, and is a legal stall', () => {
    const m = match({ w: 8, h: 2 });
    play(m, { C: 'D', P: 'A' });
    play(m, { C: 'I', P: 'A' });
    play(m, { C: 'I', P: 'A' });

    const me = view(m, 'C').me;
    assert.equal(me.t, 1, 'world turn never moved');
    assert.equal(me.p, 3);
    assert.equal(me.dir, 1);
    assert.equal(
      bodiesAt(m, 'C', 1).filter((b) => b.x === 1 && b.y === 0).length, 3,
      'p1, p2 and p3 all sit on (1,0) at t1',
    );
  });

  it('can never be blocked', () => {
    const m = match({ w: 3, h: 2 });
    play(m, { C: 'D', P: 'W' });
    play(m, { C: 'D', P: 'A' });
    assert.equal(legalNow(m, 'C').I, null, 'coral');
    assert.equal(legalNow(m, 'P').I, null, 'purple');
  });

  it('is the only legal action for a backward player at t0', () => {
    const m = match({ w: 8, h: 2 });
    play(m, { C: 'D', P: 'A' });
    play(m, { C: 'I', P: 'A' });
    play(m, { C: 'S', P: 'A' });

    const me = view(m, 'C').me;
    assert.equal(me.t, 0);
    assert.equal(me.dir, -1);
    assert.deepEqual(legalNow(m, 'C'), {
      W: 'that is before the start of time',
      A: 'that is before the start of time',
      S: 'that is before the start of time',
      D: 'that is before the start of time',
      H: 'that is before the start of time',
      I: null,
    });
  });
});

describe('movement and blocking', () => {
  it('spends a world turn on a hold but not a step', () => {
    const m = match({ w: 8, h: 2 });
    play(m, { C: 'D', P: 'A' });
    play(m, { C: 'H', P: 'A' });

    const me = view(m, 'C').me;
    assert.equal(me.t, 2, 'world turn advanced');
    assert.equal(me.p, 2, 'personal index advanced');
    assert.deepEqual([me.x, me.y], [1, 0], 'position unchanged');
    assert.equal(bodiesAt(m, 'C', 2).length, 1, 'a held turn still records a body');
  });

  it('blocks a move off the board', () => {
    const m = match();
    const legal = legalNow(m, 'C');
    assert.equal(legal.W, 'off the board');
    assert.equal(legal.A, 'off the board');
    assert.equal(legal.D, null);
    assert.equal(legal.S, null);
  });

  it('blocks a move into a generated wall', () => {
    let found: string | null = null;
    for (let s = 0; s < 80 && found === null; s++) {
      const legal = legalNow(match({ wallPct: 30, seed: `w${s}` }), 'C');
      found = legal.D === 'wall' || legal.S === 'wall' ? `w${s}` : null;
    }
    assert.ok(found, 'no seed in 0..79 put a wall next to the coral spawn at 30% density');
  });

  it('blocks a backward move onto your own earlier instance', () => {
    const m = match({ w: 8, h: 2 });
    play(m, { C: 'D', P: 'A' });
    play(m, { C: 'D', P: 'A' });
    play(m, { C: 'D', P: 'A' });
    play(m, { C: 'I', P: 'A' });
    const legal = legalNow(m, 'C');
    assert.equal(legal.A, 'occupied', 'the tile you came from holds your own instance');
    assert.equal(legal.S, null, 'down is free');
    assert.equal(legal.D, null, 'right is free');
    assert.equal(legal.H, null, 'nobody recorded (3,0) at t2');
  });

  it("blocks a backward move onto another colour's recorded body", () => {
    const m = match({ w: 4, h: 2 });
    play(m, { C: 'D', P: 'W' });
    play(m, { C: 'S', P: 'A' });
    play(m, { C: 'D', P: 'A' });
    play(m, { C: 'W', P: 'S' });
    play(m, { C: 'I', P: 'D' });
    const legal = legalNow(m, 'C');
    assert.equal(legal.A, 'occupied', "left is where purple's p3 already is");
    assert.equal(legal.S, 'occupied', "down is coral's own p3");
    assert.equal(legal.D, null, 'right is free');
  });

  it('refuses a hold when that tile is already written to another colour', () => {
    const m = match({ w: 4, h: 2 });
    play(m, { C: 'D', P: 'A' });
    play(m, { C: 'S', P: 'W' });
    play(m, { C: 'D', P: 'H' });
    play(m, { C: 'W', P: 'D' });
    play(m, { C: 'I', P: 'S' });
    const legal = legalNow(m, 'C');
    assert.equal(legal.H, 'occupied', 'holding would walk back onto purple');
    assert.equal(legal.I, null, 'inverting is still available, as it always is');
    assert.equal(legal.A, null, 'left is free');
  });

  it('has no pass action: X is gone from the alphabet', () => {
    const m = match({ w: 8, h: 2, seed: 'nox' });
    const alphabet: readonly string[] = ACTIONS;
    assert.ok(!alphabet.includes('X'), 'X is still in the alphabet');
    assert.equal(legalNow(m, 'C').X, undefined, 'X is still offered');
    assert.ok(!Wire.decodeAction('0C:X#a3f2').ok, 'X still decodes');
    assert.ok(!Match.fromExport('X1:M1:8x2:0:nox:9:CP|CXPA').ok, 'X still imports');

    const r = m.submit({ turn: 0, color: 'C', action: 'X', hash: m.stateHash() });
    assert.equal(r.ok, false);
    assert.equal(r.error, '"X" is not an action');
  });
});

describe('priority and contests', () => {
  it('derives a deterministic order from the seed, varying by turn and by seed', () => {
    const a = match({ roster: ['C', 'P', 'T', 'A'], seed: 'prio' });
    const b = match({ roster: ['C', 'P', 'T', 'A'], seed: 'prio' });
    for (let i = 0; i < 5; i++) {
      assert.deepEqual(view(a, 'C').priority, view(b, 'C').priority, `turn ${i}`);
      play(a, { C: 'D', P: 'A', T: 'A', A: 'D' });
      play(b, { C: 'D', P: 'A', T: 'A', A: 'D' });
    }

    const acrossTurns = new Set<string>();
    const m = match({ roster: ['C', 'P', 'T', 'A'], seed: 'prio' });
    for (let i = 0; i < 12; i++) {
      acrossTurns.add(view(m, 'C').priority.join(''));
      play(m, { C: 'D', P: 'A', T: 'A', A: 'D' });
    }
    assert.ok(acrossTurns.size > 1, `order should vary across turns, saw ${[...acrossTurns]}`);

    const acrossSeeds = new Set<string>();
    for (const seed of ['s0', 's1', 's2', 's3', 's4', 's5']) {
      acrossSeeds.add(view(match({ roster: ['C', 'P', 'T', 'A'], seed }), 'C').priority.join(''));
    }
    assert.ok(acrossSeeds.size > 1, 'order should vary across seeds');
  });

  it('gives a contested tile to the priority winner and leaves the loser put', () => {
    const m = match({ w: 4, h: 2, seed: 'collide' });
    play(m, { C: 'D', P: 'W' });

    const prio = view(m, 'C').priority;
    assert.equal(prio.length, 2);
    const [win, lose] = prio;
    assert.ok(win && lose);
    const stay: Record<string, number[]> = { C: [1, 0], P: [3, 0] };

    play(m, { C: 'D', P: 'A' });

    const w = view(m, win).me;
    const l = view(m, lose).me;
    assert.deepEqual([w.x, w.y], [2, 0], 'winner took the tile');
    assert.deepEqual([l.x, l.y], stay[lose], 'loser did not move');
    assert.equal(w.t, 2, 'winner playhead advanced');
    assert.equal(l.t, 2, 'loser playhead advanced too');
    assert.equal(w.p, 2, 'winner index');
    assert.equal(l.p, 2, 'loser index advanced too');
    assert.ok(
      view(m, lose).events.some((e) => e.color === lose && e.kind === 'blocked'),
      'the loser gets a blocked event',
    );
  });

  it('lets a holder keep its square against a higher-priority mover', () => {
    let m: MatchInstance | null = null;
    for (let s = 0; s < 200 && !m; s++) {
      const c = match({ w: 3, h: 2, seed: `hold${s}` });
      play(c, { C: 'D', P: 'W' });
      if (view(c, 'C').priority[0] === 'P') m = c;
    }
    assert.ok(m, 'no seed in 0..199 gave purple priority on turn 1');

    play(m, { C: 'H', P: 'A' });

    const c = view(m, 'C').me;
    assert.deepEqual([c.x, c.y], [1, 0], 'coral kept its square');
    assert.equal(c.t, 2, 'and still spent the world turn');
    assert.equal(c.p, 2);

    const p = view(m, 'P').me;
    assert.deepEqual([p.x, p.y], [2, 0], 'purple bounced');
    assert.equal(p.t, 2, 'a bounced mover still travels in time');
    assert.equal(p.p, 2);

    const blocked = view(m, 'P').events.filter((e) => e.color === 'P' && e.kind === 'blocked');
    assert.equal(blocked.length, 1, 'purple gets one blocked event');
    assert.equal(blocked[0]?.by, 'C', 'blocked by the holder');
  });

  it('lets a stayer beat a higher-priority mover', (t) => {
    const roster = ['C', 'P', 'T', 'A'];
    let bounces = 0;
    let upsets = 0;
    let first: { seed: string; turn: number; winnerKind: string } | null = null;
    const kindsSeen = new Set<string>();

    for (let s = 0; s < 600; s++) {
      const seed = `hold${s}`;
      const m = match({ w: 5, h: 4, wallPct: 10, seed, cap: 14, roster });
      let step = 0;
      while (!view(m, 'C').over) {
        const turn = m.currentTurn();
        const hash = m.stateHash();
        const prio = view(m, 'C').priority.slice();
        for (const color of roster) {
          const opts = freeActions(m, color);
          const action = opts[(s * 13 + step++) % opts.length];
          assert.ok(action);
          assert.ok(m.submit({ turn, color, action, hash }).ok, `${seed}: ${color} ${action}`);
        }

        const here = eventsOn(m, 'C', turn);
        const kindOf: Record<string, string> = {};
        for (const e of here) {
          kindOf[e.color] = e.kind;
          kindsSeen.add(e.kind);
        }
        for (const e of here) {
          if (e.kind !== 'blocked' || e.by === null) continue;
          const winnerKind = kindOf[e.by] ?? '';
          if (!/^(held|inverted|blocked|moved)$/.test(winnerKind)) continue;
          bounces++;
          if (prio.indexOf(e.by) > prio.indexOf(e.color)) {
            upsets++;
            first ??= { seed, turn, winnerKind };
          }
        }
      }
    }

    assert.ok(upsets > 0, 'never saw a stayer beat a higher-priority mover in 600 matches');
    assert.notEqual(first?.winnerKind, 'moved', 'a lower-priority winner must have stayed, not moved');
    assert.ok(kindsSeen.has('held'), 'the search never picked hold, so it is untested here');
    t.diagnostic(
      `${bounces} bounces, ${upsets} beat higher priority, first at ${first?.seed} turn ${first?.turn}`,
    );
  });

  it('bounces the next player in turn when a mover is bounced', () => {
    const m = match({ w: 3, h: 2, roster: ['C', 'P', 'T'] });
    play(m, { C: 'H', P: 'W', T: 'A' });

    const lineUp: Array<[string, number[]]> = [['C', [0, 0]], ['T', [1, 0]], ['P', [2, 0]]];
    for (const [color, xy] of lineUp) {
      const me = view(m, color).me;
      assert.deepEqual([me.x, me.y, me.t], [...xy, 1], `${color} lines up at t1`);
    }

    play(m, { P: 'H', T: 'D', C: 'D' });

    const byColor: Record<string, TurnEvent> = {};
    for (const e of eventsOn(m, 'C', 1)) byColor[e.color] = e;
    assert.equal(byColor.P?.kind, 'held', 'purple stood its ground');
    assert.equal(byColor.T?.kind, 'blocked', 'teal lost the contest');
    assert.equal(byColor.T?.by, 'P', 'to purple');
    assert.equal(byColor.C?.kind, 'blocked', 'coral lost too');
    assert.equal(byColor.C?.by, 'T', 'to the player who had just been bounced');

    for (const [color, xy] of lineUp) {
      const me = view(m, color).me;
      assert.deepEqual([me.x, me.y, me.t], [...xy, 2], `${color} spent the world turn without the step`);
      assert.equal(me.p, 2, `${color} personal index still advanced`);
    }
  });
});

describe('the horizon and view()', () => {
  function runPastHorizon(): MatchInstance {
    const m = match({ w: 8, h: 2 });
    play(m, { C: 'D', P: 'A' });
    play(m, { C: 'D', P: 'A' });
    play(m, { C: 'D', P: 'A' });
    play(m, { C: 'I', P: 'A' });
    play(m, { C: 'S', P: 'A' });
    return m;
  }

  it('reports the furthest world turn you personally reached', () => {
    const m = runPastHorizon();
    assert.equal(view(m, 'C').me.horizon, 3, 'coral inverted at t3');
    assert.equal(view(m, 'P').me.horizon, 5, 'purple stayed forward');
  });

  it('hides every body past your horizon, including your own', () => {
    const m = runPastHorizon();
    play(m, { C: 'A', P: 'A' });

    const v = view(m, 'C');
    assert.ok(v.bodies.every((b) => b.t <= 3), 'nothing past the coral horizon');
    assert.ok(v.bodies.some((b) => b.color === 'P'), 'the purple trail inside the horizon is visible');
    assert.ok(!v.bodies.some((b) => b.color === 'P' && b.t > 3), 'purple past the horizon is hidden');

    const vp = view(m, 'P');
    assert.ok(vp.bodies.some((b) => b.color === 'P' && b.t > 3), 'purple sees its own later turns');
    assert.equal(typeof v.me.horizon, 'number');
    assert.equal(typeof vp.me.horizon, 'number');
    assert.ok(!('opponents' in v), 'opponent horizons are not disclosed');
  });

  it('offers every action with a verdict', () => {
    const v = view(match({ w: 8, h: 2 }), 'C');
    assert.deepEqual(v.actions.map((a) => a.action), ACTIONS);
    assert.ok(v.actions.some((a) => a.reason === null), 'at least one action is legal');
  });

  it('never names a colour or a world turn in a block reason', () => {
    const allowed = new Set([
      null, 'occupied', 'wall', 'off the board', 'unknown action',
      'that is before the start of time', 'the match is over',
    ]);
    const names = ['Coral', 'Purple', 'Teal', 'Amber'];

    for (let s = 0; s < 60; s++) {
      const roster = ['C', 'P', 'T', 'A'];
      const m = match({ w: 6, h: 5, wallPct: 14, seed: `reason${s}`, cap: 14, roster });
      while (!view(m, 'C').over) {
        const turn = m.currentTurn();
        const hash = m.stateHash();
        for (const color of roster) {
          const legal = legalNow(m, color);
          for (const reason of Object.values(legal)) {
            assert.ok(allowed.has(reason), `reason "${reason}" is not in the safe vocabulary`);
            if (reason === null) continue;
            assert.doesNotMatch(reason, /t\d/, `reason "${reason}" leaks a world turn`);
            for (const n of names) assert.ok(!reason.includes(n), `reason "${reason}" leaks a colour`);
          }
          const opts = freeActions(m, color);
          const action = opts[(s + color.charCodeAt(0)) % opts.length];
          assert.ok(action);
          const r = m.submit({ turn, color, action, hash });
          assert.ok(r.ok, `reason${s}: ${color} ${action}: ${r.error}`);
        }
      }
    }
  });

  it('never names a body past your horizon in a blocked direction', () => {
    const m = match({ w: 4, h: 2, seed: 'leak' });
    play(m, { C: 'D', P: 'A' });
    play(m, { C: 'D', P: 'I' });

    const v = view(m, 'P');
    assert.equal(v.me.horizon, 1, 'purple never reached past t1');
    assert.ok(v.bodies.every((b) => b.t <= 1), 'and sees nothing past it');
    for (const a of v.actions) {
      if (a.reason === null) continue;
      assert.ok(!a.reason.includes('Coral'), `leak via ${a.action}: ${a.reason}`);
      assert.doesNotMatch(a.reason, /t\d/, `leak via ${a.action}: ${a.reason}`);
    }
    assert.equal(v.actions.length, 6, 'every action is offered with a verdict');
    assert.ok(v.actions.some((a) => a.reason === null), 'at least one is legal');
  });

  it('offers a blind move, then bounces it off the hidden recorded body', () => {
    const m = match({ w: 2, h: 2, seed: 'blind' });
    play(m, { C: 'I', P: 'A' });
    play(m, { C: 'I', P: 'D' });

    const before = view(m, 'C');
    assert.equal(before.me.horizon, 0);
    assert.ok(!before.bodies.some((b) => b.color === 'P' && b.t === 1));
    assert.equal(before.actions.find((a) => a.action === 'S')?.reason, null,
      'the hidden body must not disable the move');

    const turn = m.currentTurn(), hash = m.stateHash();
    assert.ok(m.submit({ turn, color: 'C', action: 'S', hash }).ok);
    assert.ok(m.submit({ turn, color: 'P', action: 'H', hash }).ok);

    const after = view(m, 'C');
    assert.deepEqual([after.me.t, after.me.p, after.me.x, after.me.y], [1, 3, 0, 0]);
    const event = eventsOn(m, 'C', turn).find((e) => e.color === 'C');
    assert.deepEqual([event?.kind, event?.by], ['blocked', 'P']);

    const imported = Match.fromExport(m.export());
    assert.ok(imported.ok);
    assert.equal(imported.value.match.stateHash(), m.stateHash());
  });

  it('sticks a blind mover when its fallback is also recorded', () => {
    const m = match({ w: 2, h: 2, seed: 'blind-stuck', roster: ['C', 'P', 'T'] });
    play(m, { C: 'I', P: 'A', T: 'A' });
    play(m, { C: 'I', P: 'D', T: 'D' });

    const before = view(m, 'C').me;
    const turn = m.currentTurn(), hash = m.stateHash();
    assert.equal(view(m, 'C').actions.find((a) => a.action === 'S')?.reason, null);
    assert.ok(m.submit({ turn, color: 'C', action: 'S', hash }).ok);
    assert.ok(m.submit({ turn, color: 'P', action: 'H', hash }).ok);
    assert.ok(m.submit({ turn, color: 'T', action: 'H', hash }).ok);

    const after = view(m, 'C').me;
    assert.deepEqual(
      [after.t, after.p, after.x, after.y, after.dir, after.horizon],
      [before.t, before.p, before.x, before.y, before.dir, before.horizon],
      'a stuck turn does not advance the player',
    );
    assert.equal(after.stuck, true);
    assert.equal(eventsOn(m, 'C', turn).find((e) => e.color === 'C')?.kind, 'stuck');
  });

  it('never hands out the same event object twice', () => {
    const m = match({ w: 8, h: 2, seed: 'iso' });
    play(m, { C: 'D', P: 'A' });

    const first = view(m, 'C').events;
    const second = view(m, 'C').events;
    assert.ok(first.length > 0, 'a resolved turn should have produced events');
    assert.notEqual(first[0], second[0], 'the two views share one event object');
    assert.deepEqual(first[0], second[0], 'but they say the same thing');
  });

  it('rejects a colour that is not in the match', () => {
    const m = match({ w: 8, h: 2 });
    assert.throws(() => m.view('Z'), { message: 'unknown colour Z' });
    assert.throws(() => m.view('T'), { message: 'unknown colour T' }, 'a palette colour outside the roster');
    assert.throws(() => m.legalActions('Z'), { message: 'unknown colour Z' });
  });
});

describe('wall generation', () => {
  it('lays the same walls for the same seed', () => {
    for (let s = 0; s < 40; s++) {
      const c = cfg({ wallPct: 30, seed: `gen${s}`, roster: ['C', 'P', 'T', 'A'] });
      assert.deepEqual(
        Match.fromConfig(c).view('C').walls,
        Match.fromConfig(c).view('C').walls,
        `seed gen${s}`,
      );
    }
  });

  it('leaves every spawn clear and reachable from every other', () => {
    for (let s = 0; s < 40; s++) {
      const roster = ['C', 'P', 'T', 'A'];
      const m = match({ wallPct: 30, seed: `gen${s}`, roster });
      const v = view(m, 'C');
      const wall = new Set(v.walls.map((p) => p.join(',')));
      const spawns = roster.map((c) => at(m, c));

      for (const sp of spawns) assert.ok(!wall.has(sp.join(',')), `wall on a spawn, seed gen${s}`);

      const start = spawns[0];
      assert.ok(start);
      const seen = new Set([start.join(',')]);
      const queue = [start];
      while (queue.length) {
        const p = queue.pop();
        assert.ok(p);
        const [x, y] = p;
        for (const [dx, dy] of DELTAS) {
          const nx = x + dx;
          const ny = y + dy;
          const k = `${nx},${ny}`;
          if (nx < 0 || ny < 0 || nx >= v.w || ny >= v.h || wall.has(k) || seen.has(k)) continue;
          seen.add(k);
          queue.push([nx, ny]);
        }
      }
      for (const sp of spawns) assert.ok(seen.has(sp.join(',')), `spawn unreachable, seed gen${s}`);
    }
  });
});

describe('config validation', () => {
  it('accepts both edges of every range', () => {
    for (const over of [
      { w: 2, h: 2 }, { w: 64, h: 64 },
      { cap: 2 }, { cap: 400 },
      { wallPct: 0 }, { wallPct: 45 },
      { seed: 'a' }, { seed: 'x'.repeat(24) }, { seed: 'A-z_0' },
      { roster: ['C'] }, { roster: ['C', 'P', 'T', 'A'] },
    ]) {
      assert.doesNotThrow(() => match(over), `rejected ${JSON.stringify(over)}`);
    }
  });

  it('rejects one step past every edge', () => {
    const bad: Array<[Partial<Config>, string]> = [
      [{ w: 1 }, 'board must be between 2x2 and 64x64'],
      [{ w: 65 }, 'board must be between 2x2 and 64x64'],
      [{ h: 1 }, 'board must be between 2x2 and 64x64'],
      [{ h: 65 }, 'board must be between 2x2 and 64x64'],
      [{ wallPct: -1 }, 'wall density must be 0-45'],
      [{ wallPct: 46 }, 'wall density must be 0-45'],
      [{ cap: 1 }, 'turn cap must be 2-400'],
      [{ cap: 401 }, 'turn cap must be 2-400'],
    ];
    for (const [over, message] of bad) {
      assert.throws(() => match(over), { message }, `accepted ${JSON.stringify(over)}`);
    }
  });

  it('floors a fractional size rather than rejecting it', () => {
    const v = view(match({ w: 16.9, h: 9.9 }), 'C');
    assert.deepEqual([v.w, v.h], [16, 9]);
  });

  it('rejects a seed that is empty, too long, or not a word', () => {
    for (const seed of ['', 'x'.repeat(25), 'has space', 'has:colon', 'has|bar', 'has~tilde']) {
      assert.throws(
        () => match({ seed }),
        { message: 'seed must be 1-24 letters, digits, - or _' },
        `accepted seed ${JSON.stringify(seed)}`,
      );
    }
  });

  it('rejects a roster that is empty, oversized, repeated, or off the palette', () => {
    assert.throws(() => match({ roster: [] }), { message: 'need 1-4 players' });
    assert.throws(() => match({ roster: ['C', 'P', 'T', 'A', 'C'] }), { message: 'need 1-4 players' });
    assert.throws(() => match({ roster: ['C', 'C'] }), { message: 'duplicate colour C' });
    assert.throws(() => match({ roster: ['C', 'Z'] }), { message: 'unknown colour Z' });
  });
});

describe('the Wire codec', () => {
  it('round-trips an action string', () => {
    const s = Wire.encodeAction({ turn: metaTurn(7), color: 'C', action: 'W', hash: 'a3f2' });
    assert.equal(s, '7C:W#a3f2');

    const r = Wire.decodeAction(s);
    assert.ok(r.value, r.error);
    assert.deepEqual(r.value, { turn: 7, color: 'C', action: 'W', hash: 'a3f2', name: null });
  });

  it('round-trips a match code', () => {
    const c: Config = { w: 16, h: 9, wallPct: 11, seed: '19f4', cap: 43, roster: ['C', 'P', 'T', 'A'] };
    const r = Wire.decodeMatchCode(Wire.encodeMatchCode(c));
    assert.ok(r.value, r.error);
    assert.deepEqual(r.value, c);
  });

  it('rejects a match code that repeats a colour', () => {
    const r = Wire.decodeMatchCode('M1:16x9:11:19f4:43:CPC');
    assert.equal(r.ok, false);
    assert.equal(r.error, 'match code repeats a colour');
  });

  it('carries a name on a turn-0 action string and nowhere else', () => {
    assert.equal(
      Wire.encodeAction({ turn: metaTurn(0), color: 'C', action: 'D', hash: 'a3f2', name: 'Rook' }),
      '0C:D#a3f2~Rook',
    );
    assert.equal(
      Wire.encodeAction({ turn: metaTurn(4), color: 'C', action: 'D', hash: 'a3f2', name: 'Rook' }),
      '4C:D#a3f2',
      'the name only rides the opening string',
    );

    const r = Wire.decodeAction('0C:D#a3f2~Rook');
    assert.ok(r.value, r.error);
    assert.equal(r.value.name, 'Rook');

    const plain = Wire.decodeAction('7C:W#a3f2');
    assert.ok(plain.value, plain.error);
    assert.equal(plain.value.name, null, 'a nameless string is not an error');
  });

  it('rejects a name that is empty, overlong, or carries a delimiter', () => {
    for (const s of [
      '0C:D#a3f2~', '0C:D#a3f2~has~tilde', '0C:D#a3f2~has|bar',
      '0C:D#a3f2~thirteenchars', '0P:W#00cb~Bo Vale',
    ]) {
      const r = Wire.decodeAction(s);
      assert.equal(r.ok, false, `accepted ${s}`);
      assert.ok(r.error?.length, 'a rejection carries error text');
    }

    const r = Wire.decodeAction('0P:W#00cb~Bo_Vale');
    assert.ok(r.value, r.error);
    assert.equal(r.value.name, 'Bo_Vale', 'an underscore reads as the separator');
  });

  it('decodes an export that has no name section', () => {
    const r = Wire.decodeExport('X1:M1:8x2:0:exp:9:CP|CDPA');
    assert.ok(r.value, r.error);
    assert.deepEqual(r.value.names, {});
    assert.deepEqual(r.value.log, [
      { turn: 0, color: 'C', action: 'D' },
      { turn: 0, color: 'P', action: 'A' },
    ]);
  });

  it('rejects a spaced name in an export', () => {
    const r = Wire.decodeExport('X1:M1:8x2:0:exp:9:CP|CDPA|C~Bo Vale');
    assert.equal(r.ok, false);
    assert.equal(r.error, 'bad name entry "C~Bo Vale" in export');
  });

  it('rejects a malformed action group', () => {
    const odd = Wire.decodeExport('X1:M1:8x2:0:exp:9:CP|CDP');
    assert.equal(odd.ok, false);
    assert.equal(odd.error, 'malformed action group at turn 0');

    const unknown = Wire.decodeExport('X1:M1:8x2:0:exp:9:CP|CDZA');
    assert.equal(unknown.ok, false);
    assert.equal(unknown.error, 'bad action "ZA" at turn 0');
  });

  it('rejects malformed strings rather than swallowing them', () => {
    for (const bad of ['', 'nonsense', '7C:Q#a3f2', 'xC:W#a3f2', '7Z:W#a3f2', '7C:W', 'M1:bad', 'X1:']) {
      const results = [Wire.decodeAction(bad), Wire.decodeMatchCode(bad), Wire.decodeExport(bad)];
      assert.ok(results.every((r) => !r.ok), `something accepted ${JSON.stringify(bad)}`);
      for (const r of results) assert.ok(r.error?.length, `no error text for ${JSON.stringify(bad)}`);
    }
  });
});

describe('submit', () => {
  it('rejects a stale hash, a wrong turn, a repeat, and an illegal action', () => {
    const m = match({ w: 8, h: 2, seed: 'guard' });
    const turn = m.currentTurn();
    const hash = m.stateHash();

    const stale = m.submit({ turn, color: 'C', action: 'D', hash: 'dead' });
    assert.equal(stale.ok, false);
    assert.match(stale.error, /^state dead does not match this match's state \w{4}/);

    const wrongTurn = m.submit({ turn: turn + 3, color: 'C', action: 'D', hash });
    assert.equal(wrongTurn.ok, false);
    assert.equal(wrongTurn.error, 'action is for turn 3; match is on turn 0');

    const offBoard = m.submit({ turn, color: 'C', action: 'W', hash });
    assert.equal(offBoard.ok, false);
    assert.equal(offBoard.error, 'illegal: off the board');

    const stray = m.submit({ turn, color: 'Z', action: 'D', hash });
    assert.equal(stray.ok, false);
    assert.equal(stray.error, 'colour Z is not in this match');

    assert.equal(m.currentTurn(), turn, 'rejected submits do not advance the turn');

    assert.ok(m.submit({ turn, color: 'C', action: 'D', hash }).ok, 'a valid submit lands');

    const repeat = m.submit({ turn, color: 'C', action: 'S', hash });
    assert.equal(repeat.ok, false);
    assert.equal(repeat.error, 'Coral has already acted this turn');
    assert.deepEqual(m.pendingColors(), ['P'], 'purple is still pending');
  });

  it('stops at the turn cap', () => {
    const m = match({ w: 8, h: 2, cap: 3, seed: 'cap' });
    for (let i = 0; i < 3; i++) play(m, { C: i % 2 ? 'A' : 'D', P: i % 2 ? 'D' : 'A' });

    assert.ok(view(m, 'C').over, 'the match reports over');
    const r = m.submit({ turn: 3, color: 'C', action: 'D', hash: m.stateHash() });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'the match is over');

    const legal = legalNow(m, 'C');
    assert.deepEqual(Object.values(legal), ACTIONS.map(() => 'the match is over'));
    const v = view(m, 'C');
    assert.deepEqual(v.actions, [], 'a finished match offers nothing');
    assert.deepEqual(v.priority, [], 'and has no priority order');
  });
});

describe('withdraw', () => {
  it('returns you to pending and lets you act differently', () => {
    const m = match({ w: 8, h: 2, seed: 'wd1' });
    const turn = m.currentTurn();
    const hash = m.stateHash();

    assert.ok(m.submit({ turn, color: 'C', action: 'D', hash }).ok, 'first commit');
    assert.deepEqual(m.pendingColors(), ['P'], 'coral is committed');

    assert.deepEqual(m.withdraw('C'), { ok: true });
    assert.deepEqual(m.pendingColors(), ['C', 'P'], 'coral is pending again');
    assert.equal(m.currentTurn(), turn, 'taking an action back does not move the turn');
    assert.equal(m.stateHash(), hash, 'nor the state everyone agreed on');

    play(m, { C: 'S', P: 'A' });
    assert.deepEqual(at(m, 'C'), [0, 1], 'coral went down, not right');
  });

  it('refuses when you have not acted this turn', () => {
    const m = match({ w: 8, h: 2, seed: 'wd2' });
    assert.deepEqual(m.withdraw('C'), { ok: false, error: 'you have not acted this turn' });
  });

  it('refuses once the turn has resolved', () => {
    const m = match({ w: 8, h: 2, seed: 'wd3' });
    play(m, { C: 'D', P: 'A' });
    assert.deepEqual(m.withdraw('C'), { ok: false, error: 'you have not acted this turn' });
    assert.equal(m.currentTurn(), 1, 'and the turn stands');
  });

  it('refuses a second time', () => {
    const m = match({ w: 8, h: 2, seed: 'wd4' });
    assert.ok(m.submit({ turn: 0, color: 'C', action: 'D', hash: m.stateHash() }).ok);
    assert.deepEqual(m.withdraw('C'), { ok: true });
    assert.deepEqual(m.withdraw('C'), { ok: false, error: 'you have not acted this turn' });
  });

  it('refuses a colour that is not in the match', () => {
    const m = match({ w: 8, h: 2, seed: 'wd5' });
    assert.deepEqual(m.withdraw('Z'), { ok: false, error: 'colour Z is not in this match' });
    assert.deepEqual(m.withdraw('T'), { ok: false, error: 'colour T is not in this match' });
  });

  it('refuses once the match is over', () => {
    const m = match({ w: 8, h: 2, cap: 2, seed: 'wd7' });
    play(m, { C: 'D', P: 'A' });
    play(m, { C: 'D', P: 'A' });
    assert.deepEqual(m.withdraw('C'), { ok: false, error: 'the match is over' });
  });
});

describe('export and import', () => {
  it('round-trips a played match', () => {
    const m = match({ w: 8, h: 2, seed: 'exp' });
    play(m, { C: 'D', P: 'A' });
    play(m, { C: 'D', P: 'A' });
    play(m, { C: 'I', P: 'A' });

    const r = Match.fromExport(m.export());
    assert.ok(r.value, errorText(r));
    assert.equal(r.value.match.stateHash(), m.stateHash(), 'the hash survives');
    assert.equal(r.value.match.currentTurn(), m.currentTurn());
    assert.deepEqual(r.value.match.view('C'), m.view('C'), 'the whole view survives');
    assert.deepEqual(r.value.match.config(), m.config());
  });

  it('carries the names it is handed, and hands them back beside the match', () => {
    const m = match({ w: 8, h: 2, seed: 'exp2' });
    play(m, { C: 'D', P: 'A' });

    const r = Match.fromExport(m.export({ C: 'Rook', P: 'Vale' }));
    assert.ok(r.value, errorText(r));
    assert.deepEqual(r.value.names, { C: 'Rook', P: 'Vale' });
    assert.equal(r.value.match.stateHash(), m.stateHash(), 'the hash still survives');
  });

  it('drops a name for a colour outside the roster', () => {
    const m = match({ w: 8, h: 2, seed: 'exp3', roster: ['C', 'P'] });
    const r = Match.fromExport(m.export({ C: 'Rook', T: 'Nim' }));
    assert.ok(r.value, errorText(r));
    assert.deepEqual(r.value.names, { C: 'Rook' }, 'teal is not in this match');
  });

  it('writes a two-section export when it is handed no names', () => {
    const m = match({ w: 8, h: 2, seed: 'exp4' });
    play(m, { C: 'D', P: 'A' });
    assert.ok(m.export().endsWith('|'), 'the name section is empty');
    const r = Match.fromExport(m.export());
    assert.ok(r.value, errorText(r));
    assert.deepEqual(r.value.names, {});
  });

  it('loses an action that was withdrawn', () => {
    const m = match({ w: 8, h: 2, seed: 'wd6' });
    assert.ok(m.submit({ turn: 0, color: 'C', action: 'D', hash: m.stateHash() }).ok);
    const before = m.export();
    assert.deepEqual(m.withdraw('C'), { ok: true });
    const after = m.export();

    assert.notEqual(before, after, 'the export still carries the action it was told to forget');
    const r = Match.fromExport(after);
    assert.ok(r.value, errorText(r));
    assert.deepEqual(r.value.match.pendingColors(), ['C', 'P']);
  });

  it('refuses an export whose config is out of range', () => {
    const r = Match.fromExport('X1:M1:1x9:0:exp:9:CP|');
    assert.equal(r.ok, false);
    assert.ok(errorText(r).length, 'a rejection carries error text');
  });
});

describe('soak', () => {
  it('replays 200 random matches identically and holds every invariant', { timeout: 300_000 }, (t) => {
    let stuckSeen = 0;
    let invertSeen = 0;
    let heldSeen = 0;
    let blockedSeen = 0;

    for (let s = 0; s < 200; s++) {
      const rnd = mulberry32(s * 2654435761);
      const roster = ['C', 'P', 'T', 'A'].slice(0, 2 + Math.floor(rnd() * 3));
      const c = cfg({
        w: 4 + Math.floor(rnd() * 10),
        h: 3 + Math.floor(rnd() * 6),
        wallPct: Math.floor(rnd() * 25),
        seed: `soak${s}`,
        cap: 14,
        roster,
      });
      const m = Match.fromConfig(c);
      const log: Array<{ turn: number; color: string; action: string }> = [];
      const lead = roster[0];
      assert.ok(lead);

      while (!view(m, lead).over) {
        const turn = m.currentTurn();
        const hash = m.stateHash();

        for (const color of roster) {
          assert.equal(legalNow(m, color).I, null, `soak ${s}: ${color} cannot invert`);
          const opts = freeActions(m, color);
          const action = opts[Math.floor(rnd() * opts.length)];
          assert.ok(action);
          if (action === 'I') invertSeen++;
          if (action === 'H') heldSeen++;

          const r = m.submit({ turn, color, action, hash });
          assert.ok(r.ok, `soak ${s} turn ${turn} ${color}: ${r.error}`);
          log.push({ turn, color, action });
        }
        assert.equal(m.currentTurn(), turn + 1, `soak ${s}: the turn must advance`);

        blockedSeen += eventsOn(m, lead, turn).filter((e) => e.kind === 'blocked').length;

        for (const color of roster) {
          if (eventsOn(m, color, turn).some((e) => e.color === color && e.kind === 'stuck')) {
            stuckSeen++;
          }

          const occ = new Map<string, string>();
          for (const b of view(m, color).bodies) {
            const k = `${b.t},${b.x},${b.y}`;
            const held = occ.get(k);
            assert.ok(held === undefined || held === b.color, `soak ${s}: ${held} and ${b.color} share ${k}`);
            occ.set(k, b.color);
          }
        }
      }

      const replay = Match.fromConfig(c);
      for (const e of log) {
        const r = replay.submit({ turn: e.turn, color: e.color, action: e.action, hash: replay.stateHash() });
        assert.ok(r.ok, `soak replay ${s}: ${r.error}`);
      }
      assert.equal(replay.stateHash(), m.stateHash(), `soak ${s}: replay hash`);

      const imported = Match.fromExport(m.export());
      assert.ok(imported.value, `soak ${s} import: ${errorText(imported)}`);
      assert.equal(imported.value.match.stateHash(), m.stateHash(), `soak ${s}: export hash`);
    }

    assert.ok(invertSeen > 0, 'the soak never exercised inversion');
    assert.ok(heldSeen > 0, 'the soak never exercised holding');
    assert.ok(blockedSeen > 0, 'the soak never exercised a tile contest');
    t.diagnostic(
      `${invertSeen} inversions, ${heldSeen} holds, ${blockedSeen} contests, ${stuckSeen} stuck`,
    );
  });
});
