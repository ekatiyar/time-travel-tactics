/* Engine tests for tbtt_prototype_time_travel_only.html.
   Injected into the page by run_tests.py; not shipped in the HTML. */

function runTests() {
  const results = [];
  const { Match, Wire } = window.TBTT;

  // ---- harness ------------------------------------------------------------

  function test(name, fn) {
    try {
      fn();
      results.push({ name, ok: true, error: null });
    } catch (e) {
      results.push({ name, ok: false, error: e && e.stack ? e.stack : String(e) });
    }
  }
  function assert(cond, msg) {
    if (!cond) throw new Error(msg || 'assertion failed');
  }
  function eq(a, b, msg) {
    if (a !== b) throw new Error((msg || 'not equal') + ': got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b));
  }

  function cfg(over) {
    return Object.assign(
      { w: 16, h: 9, wallPct: 0, seed: 'test', cap: 40, roster: ['C', 'P'] },
      over || {}
    );
  }
  function play(m, actions) {
    const turn = m.currentTurn();
    const hash = m.stateHash();
    for (const color of Object.keys(actions)) {
      const r = m.submit({ turn, color, action: actions[color], hash });
      assert(r.ok, 'submit ' + color + ' ' + actions[color] + ' turn ' + turn + ': ' + r.error);
    }
    eq(m.currentTurn(), turn + 1, 'turn should advance once all colours submitted');
  }
  // Every body a colour ever recorded, from that colour's own (unfiltered) tape.
  function bodyAt(m, color, t) {
    return m.view(color).bodies.filter((b) => b.color === color && b.t === t);
  }
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ---- clocks -------------------------------------------------------------

  test('forward player: world turn and personal index both track meta time', () => {
    const m = Match.fromConfig(cfg());
    play(m, { C: 'D', P: 'A' });
    play(m, { C: 'D', P: 'A' });
    const v = m.view('C');
    eq(v.me.t, 2, 'world turn');
    eq(v.me.p, 2, 'personal index');
    eq(v.me.dir, 1, 'direction');
    eq(v.me.x, 2); eq(v.me.y, 0);
    eq(m.currentTurn(), 2);
  });

  test('spawns: palette order maps to fixed corners', () => {
    const m = Match.fromConfig(cfg({ roster: ['C', 'P', 'T', 'A'] }));
    const at = (c) => { const me = m.view(c).me; return [me.x, me.y]; };
    assert(JSON.stringify(at('C')) === JSON.stringify([0, 0]), 'coral top-left');
    assert(JSON.stringify(at('P')) === JSON.stringify([15, 8]), 'purple bottom-right');
    assert(JSON.stringify(at('T')) === JSON.stringify([15, 0]), 'teal top-right');
    assert(JSON.stringify(at('A')) === JSON.stringify([0, 8]), 'amber bottom-left');
  });

  // ---- inversion ----------------------------------------------------------

  test('inverting flips direction and keeps your world turn', () => {
    const m = Match.fromConfig(cfg({ w: 8, h: 2 }));
    play(m, { C: 'D', P: 'A' });
    play(m, { C: 'D', P: 'A' });
    play(m, { C: 'D', P: 'A' });
    const before = m.view('C').me;
    eq(before.t, 3); eq(before.x, 3); eq(before.y, 0);
    play(m, { C: 'I', P: 'A' });
    const after = m.view('C').me;
    eq(after.dir, -1, 'direction flipped');
    eq(after.t, 3, 'world turn unchanged, the flip costs no world time');
    eq(after.x, 3, 'x unchanged'); eq(after.y, 0, 'y unchanged');
    eq(after.p, 4, 'personal index still incremented');
    const stack = bodyAt(m, 'C', 3).filter((b) => b.x === 3 && b.y === 0);
    eq(stack.length, 2, 'the turnstile: both instances share one (t,x,y)');
    eq(stack.map((b) => b.p).sort((a, b) => a - b).join(','), '3,4');
  });

  test('inverting twice stacks three bodies and is a legal stall', () => {
    const m = Match.fromConfig(cfg({ w: 8, h: 2 }));
    play(m, { C: 'D', P: 'A' });
    play(m, { C: 'I', P: 'A' });
    play(m, { C: 'I', P: 'A' });
    const me = m.view('C').me;
    eq(me.t, 1, 'world turn never moved'); eq(me.p, 3); eq(me.dir, 1);
    eq(bodyAt(m, 'C', 1).filter((b) => b.x === 1 && b.y === 0).length, 3,
      'p1, p2 and p3 all sit on (1,0) at t1');
  });

  test('personal index keeps incrementing while moving backward', () => {
    const m = Match.fromConfig(cfg({ w: 8, h: 2 }));
    play(m, { C: 'D', P: 'A' });
    play(m, { C: 'D', P: 'A' });
    play(m, { C: 'I', P: 'A' });
    play(m, { C: 'S', P: 'A' }); // stepping back has to leave its own record behind
    const me = m.view('C').me;
    eq(me.p, 4, 'index'); eq(me.t, 1, 'world turn'); eq(me.dir, -1);
    eq(me.x, 2); eq(me.y, 1);
  });

  test('backward at t0: inverting is the only legal action', () => {
    const m = Match.fromConfig(cfg({ w: 8, h: 2 }));
    play(m, { C: 'D', P: 'A' });
    play(m, { C: 'I', P: 'A' });
    play(m, { C: 'S', P: 'A' });
    const me = m.view('C').me;
    eq(me.t, 0); eq(me.dir, -1);
    const l = m.legalActions('C');
    for (const a of ['W', 'A', 'S', 'D', 'H']) {
      eq(l[a], 'that is before the start of time', a + ' should hit the t0 wall');
    }
    eq(l.I, null, 'invert legal');
  });

  // ---- movement legality --------------------------------------------------

  test('holding costs a world turn but not a step', () => {
    const m = Match.fromConfig(cfg({ w: 8, h: 2 }));
    play(m, { C: 'D', P: 'A' });
    play(m, { C: 'H', P: 'A' });
    const me = m.view('C').me;
    eq(me.t, 2, 'world turn advanced'); eq(me.p, 2, 'personal index advanced');
    eq(me.x, 1, 'x unchanged'); eq(me.y, 0, 'y unchanged');
    eq(bodyAt(m, 'C', 2).length, 1, 'a held turn still records a body');
  });

  test('pass is gone: X is not an action any more', () => {
    const m = Match.fromConfig(cfg({ w: 8, h: 2, seed: 'nox' }));
    assert(window.TBTT.ACTIONS.indexOf('X') < 0, 'X is still in the alphabet');
    eq(m.legalActions('C').X, undefined, 'X is still offered');
    assert(!Wire.decodeAction('0C:X#a3f2').ok, 'X still decodes');
    assert(!Match.fromExport('X1:M1:8x2:0:nox:9:CP|CXPA').ok, 'X still imports');
    assert(!m.submit({ turn: 0, color: 'C', action: 'X', hash: m.stateHash() }).ok, 'X still submits');
  });

  test('board edge blocks a move', () => {
    const m = Match.fromConfig(cfg());
    const l = m.legalActions('C'); // spawn is (0,0)
    assert(l.W, 'up off board'); assert(l.A, 'left off board');
    eq(l.D, null); eq(l.S, null);
  });

  test('your own other instance blocks a move', () => {
    const m = Match.fromConfig(cfg({ w: 8, h: 2 }));
    play(m, { C: 'D', P: 'A' });   // C (1,0)@t1
    play(m, { C: 'D', P: 'A' });   // C (2,0)@t2
    play(m, { C: 'D', P: 'A' });   // C (3,0)@t3
    play(m, { C: 'I', P: 'A' });   // C stays (3,0)@t3, now heading backward
    // Retracing your steps is the one thing you cannot do. (2,0) at t2 is where
    // your own p2 already stands.
    const l = m.legalActions('C');
    eq(l.A, 'occupied', 'the tile you came from is blocked by your own instance');
    eq(l.S, null, 'down free'); eq(l.D, null, 'right free');
    eq(l.H, null, 'holding is free, nobody recorded (3,0) at t2');
  });

  test('inverting can never be blocked', () => {
    // Its target is the tile you already stand on, at the world turn you already
    // stand in, so bounds, walls and occupancy all pass. That is what guarantees
    // every player always has at least one legal action.
    const m = Match.fromConfig(cfg({ w: 3, h: 2 }));
    play(m, { C: 'D', P: 'W' }); // C (1,0)@t1 ; P (2,0)@t1
    play(m, { C: 'D', P: 'A' }); // C (2,0)@t2 ; P (1,0)@t2
    eq(m.legalActions('C').I, null, 'coral');
    eq(m.legalActions('P').I, null, 'purple');
  });

  test("another colour's recorded body blocks a backward move", () => {
    const m = Match.fromConfig(cfg({ w: 4, h: 2 }));
    play(m, { C: 'D', P: 'W' }); // C (1,0)@t1 ; P (3,0)@t1
    play(m, { C: 'S', P: 'A' }); // C (1,1)@t2 ; P (2,0)@t2
    play(m, { C: 'D', P: 'A' }); // C (2,1)@t3 ; P (1,0)@t3
    play(m, { C: 'W', P: 'S' }); // C (2,0)@t4 ; P (1,1)@t4
    play(m, { C: 'I', P: 'D' }); // C turns around on (2,0)@t4 ; P (2,1)@t5
    // Walking back means walking into written history, and none of it can change.
    const l = m.legalActions('C');
    eq(l.A, 'occupied', "left is where purple's p3 already is");
    eq(l.S, "occupied", "down is coral's own p3");
    eq(l.D, null, 'right is free');
  });

  test('holding is refused when that tile is already written to another colour', () => {
    const m = Match.fromConfig(cfg({ w: 4, h: 2 }));
    play(m, { C: 'D', P: 'A' }); // C (1,0)@t1 ; P (2,1)@t1
    play(m, { C: 'S', P: 'W' }); // C (1,1)@t2 ; P (2,0)@t2
    play(m, { C: 'D', P: 'H' }); // C (2,1)@t3 ; P holds (2,0)@t3
    play(m, { C: 'W', P: 'D' }); // C (2,0)@t4 ; P (3,0)@t4
    play(m, { C: 'I', P: 'S' }); // C turns around on (2,0)@t4 ; P (3,1)@t5
    // Standing still is a move through time, and t3 on this tile is purple's.
    const l = m.legalActions('C');
    eq(l.H, 'occupied', 'holding would walk back onto purple');
    eq(l.I, null, 'inverting is still available, as it always is');
    eq(l.A, null, 'left is free');
  });

  test('holding beats a higher-priority mover onto your square', () => {
    // Priority is seed-derived, so find a seed where purple outranks coral.
    let m = null;
    for (let s = 0; s < 200 && !m; s++) {
      const c = Match.fromConfig(cfg({ w: 3, h: 2, seed: 'hold' + s }));
      play(c, { C: 'D', P: 'W' }); // C (1,0)@t1 ; P (2,0)@t1
      if (c.view('C').priority[0] === 'P') m = c;
    }
    assert(m, 'no seed in 0..199 gave purple priority on turn 1');
    play(m, { C: 'H', P: 'A' }); // coral stands still, purple walks into it
    const c = m.view('C').me;
    eq(c.x, 1, 'coral kept its square'); eq(c.y, 0);
    eq(c.t, 2, 'and still spent the world turn'); eq(c.p, 2);
    const p = m.view('P').me;
    eq(p.x, 2, 'purple bounced'); eq(p.y, 0);
    eq(p.t, 2, 'a bounced mover still travels in time'); eq(p.p, 2);
    const ev = m.view('P').events.filter((e) => e.color === 'P' && e.kind === 'blocked');
    eq(ev.length, 1, 'purple gets one blocked event');
    eq(ev[0].by, 'C', 'blocked by the holder');
  });

  test('a generated wall blocks a move', () => {
    let found = null;
    for (let s = 0; s < 80 && !found; s++) {
      const m = Match.fromConfig(cfg({ wallPct: 30, seed: 'w' + s }));
      const l = m.legalActions('C');
      if (l.D && /wall/i.test(l.D)) found = { s, l };
      else if (l.S && /wall/i.test(l.S)) found = { s, l };
    }
    assert(found, 'no seed in 0..79 put a wall next to coral spawn at 30% density');
  });

  // ---- collisions ---------------------------------------------------------

  test('contested tile: priority winner takes it, loser stays put', () => {
    const m = Match.fromConfig(cfg({ w: 4, h: 2, seed: 'collide' }));
    play(m, { C: 'D', P: 'W' }); // C (1,0)@t1 ; P (3,0)@t1
    const prio = m.view('C').priority.slice();
    eq(prio.length, 2);
    const stay = { C: [1, 0], P: [3, 0] };
    play(m, { C: 'D', P: 'A' }); // both target (2,0)@t2
    const win = prio[0], lose = prio[1];
    const w = m.view(win).me, l = m.view(lose).me;
    eq(w.x, 2, 'winner x'); eq(w.y, 0, 'winner y');
    eq(l.x, stay[lose][0], 'loser x unchanged'); eq(l.y, stay[lose][1], 'loser y unchanged');
    eq(w.t, 2, 'winner playhead advanced'); eq(l.t, 2, 'loser playhead still advanced');
    eq(w.p, 2, 'winner index'); eq(l.p, 2, 'loser index still advanced');
    assert(m.view(lose).events.some((e) => e.color === lose && e.kind === 'blocked'),
      'loser should get a blocked event');
  });

  test('standing still holds your square against a higher-priority mover', () => {
    // Staying beats moving no matter who has priority, so a mover can lose its
    // target to someone below it in the order. Search for a real instance
    // rather than hand-building one, since priority comes from the seed.
    const roster = ['C', 'P', 'T', 'A'];
    let bounces = 0, upsets = 0, first = null;
    const kindsSeen = new Set();

    for (let s = 0; s < 600; s++) {
      const m = Match.fromConfig(cfg({ w: 5, h: 4, wallPct: 10, seed: 'hold' + s, cap: 14, roster }));
      let step = 0;
      while (!m.view('C').over) {
        const turn = m.currentTurn(), hash = m.stateHash();
        const prio = m.view('C').priority.slice();
        for (const color of roster) {
          const legal = m.legalActions(color);
          const opts = Object.keys(legal).filter((k) => legal[k] === null);
          m.submit({ turn, color, action: opts[(s * 13 + step++) % opts.length], hash });
        }
        const evts = m.view('C').events.filter((e) => e.turn === turn), kindOf = {};
        for (const e of evts) { kindOf[e.color] = e.kind; kindsSeen.add(e.kind); }
        for (const e of evts) {
          if (e.kind !== 'blocked') continue;
          bounces++;
          // Whoever won held their square: they held, inverted, or were bounced themselves.
          assert(/^(held|inverted|blocked|moved)$/.test(kindOf[e.by] || ''),
            'blocker ' + e.by + ' has no outcome this turn');
          if (prio.indexOf(e.by) > prio.indexOf(e.color)) {
            upsets++;
            if (!first) first = { seed: 'hold' + s, turn, e: e, by: kindOf[e.by] };
          }
        }
      }
    }

    assert(upsets > 0, 'never saw a stayer beat a higher-priority mover in 600 matches');
    assert(first.by !== 'moved', 'a lower-priority winner must have stayed, not moved: ' + first.by);
    assert(kindsSeen.has('held'), 'the search never picked hold, so it is untested here');
    results.push({
      name: '  (' + bounces + ' bounces: ' + upsets + ' beat higher priority; first at ' +
        first.seed + ' turn ' + first.turn + ')',
      ok: true, error: null,
    });
  });

  test('a bounced mover bounces the next player in turn', () => {
    // The cascade the resolver's fixed point exists for. Built by hand rather than
    // searched: random play finds none in 600 matches, because a cascade needs one
    // player bounced and a second aimed at exactly the square they fall back to.
    const m = Match.fromConfig(cfg({ w: 3, h: 2, wallPct: 0, roster: ['C', 'P', 'T'] }));
    play(m, { C: 'H', P: 'W', T: 'A' });
    // Coral (0,0), teal (1,0), purple (2,0), three abreast at t1, all forward.
    for (const [c, xy] of [['C', [0, 0]], ['T', [1, 0]], ['P', [2, 0]]]) {
      const me = m.view(c).me;
      eq(me.x + ',' + me.y + '@' + me.t, xy[0] + ',' + xy[1] + '@1', c + ' lines up');
    }

    // Purple holds. Teal walks into purple and is thrown back onto (1,0). Coral
    // walks into (1,0) and is thrown back by the player who was just thrown back.
    play(m, { P: 'H', T: 'D', C: 'D' });
    const byColor = {};
    for (const e of m.view('C').events.filter((e) => e.turn === 1)) byColor[e.color] = e;
    eq(byColor.P.kind, 'held', 'purple stood its ground');
    eq(byColor.T.kind, 'blocked', 'teal lost the contest');
    eq(byColor.T.by, 'P', 'to purple');
    eq(byColor.C.kind, 'blocked', 'coral lost too');
    eq(byColor.C.by, 'T', 'to the player who had just been bounced');
    for (const [c, xy] of [['C', [0, 0]], ['T', [1, 0]], ['P', [2, 0]]]) {
      const me = m.view(c).me;
      eq(me.x + ',' + me.y + '@' + me.t, xy[0] + ',' + xy[1] + '@2',
        c + ' spent the world turn without the step');
      eq(me.p, 2, c + ' personal index still advanced');
    }
  });

  test('priority order is deterministic per seed and turn', () => {
    const a = Match.fromConfig(cfg({ roster: ['C', 'P', 'T', 'A'], seed: 'prio' }));
    const b = Match.fromConfig(cfg({ roster: ['C', 'P', 'T', 'A'], seed: 'prio' }));
    for (let i = 0; i < 5; i++) {
      eq(a.view('C').priority.join(''), b.view('C').priority.join(''), 'turn ' + i);
      const acts = { C: 'D', P: 'A', T: 'A', A: 'D' };
      play(a, acts); play(b, acts);
    }
    const orders = new Set();
    const m2 = Match.fromConfig(cfg({ roster: ['C', 'P', 'T', 'A'], seed: 'prio' }));
    for (let i = 0; i < 12; i++) {
      orders.add(m2.view('C').priority.join(''));
      play(m2, { C: 'D', P: 'A', T: 'A', A: 'D' });
    }
    assert(orders.size > 1, 'priority order should vary across turns, saw only ' + [...orders]);

    const seeds = new Set();
    for (const seed of ['s0', 's1', 's2', 's3', 's4', 's5']) {
      seeds.add(Match.fromConfig(cfg({ roster: ['C', 'P', 'T', 'A'], seed })).view('C').priority.join(''));
    }
    assert(seeds.size > 1, 'priority order should vary across seeds');
  });

  // ---- horizon ------------------------------------------------------------

  test('horizon is the furthest world turn you personally reached', () => {
    const m = Match.fromConfig(cfg({ w: 8, h: 2 }));
    play(m, { C: 'D', P: 'A' });
    play(m, { C: 'D', P: 'A' });
    play(m, { C: 'D', P: 'A' });
    play(m, { C: 'I', P: 'A' });
    play(m, { C: 'S', P: 'A' });   // sidestep: retracing onto your own body is refused
    eq(m.view('C').me.horizon, 3, 'coral inverted at t3');
    eq(m.view('P').me.horizon, 5, 'purple stayed forward');
  });

  test('view hides everything beyond your horizon', () => {
    const m = Match.fromConfig(cfg({ w: 8, h: 2 }));
    play(m, { C: 'D', P: 'A' });
    play(m, { C: 'D', P: 'A' });
    play(m, { C: 'D', P: 'A' });
    play(m, { C: 'I', P: 'A' });
    play(m, { C: 'S', P: 'A' });   // (3,1)@t2
    play(m, { C: 'A', P: 'A' });   // (2,1)@t1
    const v = m.view('C');
    assert(v.bodies.every((b) => b.t <= 3), 'no body past coral horizon');
    assert(v.bodies.some((b) => b.color === 'P'), 'purple trail inside horizon is visible');
    assert(!v.bodies.some((b) => b.color === 'P' && b.t > 3), 'purple past horizon hidden');
    const vp = m.view('P');
    assert(vp.bodies.some((b) => b.color === 'P' && b.t > 3), 'purple sees its own later turns');
    assert(v.me.horizon !== undefined && vp.me.horizon !== undefined);
    assert(!('horizon' in (v.opponents || {})), 'opponent horizons are not disclosed');
  });

  // ---- view isolation -----------------------------------------------------

  test('two view calls never hand out the same event object', () => {
    // A renderer is free to annotate what it was given, so one call's scribble
    // must not turn up in the next.
    const m = Match.fromConfig(cfg({ w: 8, h: 2, seed: 'iso' }));
    play(m, { C: 'D', P: 'A' });
    const v1 = m.view('C'), v2 = m.view('C');
    assert(v1.events.length > 0, 'a resolved turn should have produced events');
    assert(v1.events[0] !== v2.events[0], 'the two views share one event object');
    eq(JSON.stringify(v1.events[0]), JSON.stringify(v2.events[0]), 'but they say the same thing');
  });

  // ---- wall generation ----------------------------------------------------

  test('wall generation is deterministic and leaves every spawn connected', () => {
    for (let s = 0; s < 40; s++) {
      const c = cfg({ w: 16, h: 9, wallPct: 30, seed: 'gen' + s, roster: ['C', 'P', 'T', 'A'] });
      const a = Match.fromConfig(c), b = Match.fromConfig(c);
      const wa = JSON.stringify(a.view('C').walls), wb = JSON.stringify(b.view('C').walls);
      eq(wa, wb, 'same seed same walls, seed ' + s);

      const v = a.view('C');
      const wall = new Set(v.walls.map((p) => p[0] + ',' + p[1]));
      const spawns = ['C', 'P', 'T', 'A'].map((col) => { const me = a.view(col).me; return [me.x, me.y]; });
      for (const sp of spawns) assert(!wall.has(sp[0] + ',' + sp[1]), 'wall on a spawn, seed ' + s);
      const seen = new Set([spawns[0][0] + ',' + spawns[0][1]]);
      const q = [spawns[0]];
      while (q.length) {
        const [x, y] = q.pop();
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = x + dx, ny = y + dy, k = nx + ',' + ny;
          if (nx < 0 || ny < 0 || nx >= 16 || ny >= 9 || wall.has(k) || seen.has(k)) continue;
          seen.add(k); q.push([nx, ny]);
        }
      }
      for (const sp of spawns) assert(seen.has(sp[0] + ',' + sp[1]), 'spawn unreachable, seed ' + s);
    }
  });

  // ---- config limits ------------------------------------------------------

  test('the config accepts exactly the range the setup form offers', () => {
    const bad = [{ w: 65 }, { h: 65 }, { cap: 401 }, { cap: 1 }, { wallPct: 46 }];
    for (const over of bad) {
      let threw = false;
      try { Match.fromConfig(cfg(over)); } catch (e) { threw = true; }
      assert(threw, 'expected a rejection for ' + JSON.stringify(over));
    }
    for (const over of [{ w: 64, h: 64 }, { cap: 400 }, { cap: 2 }, { wallPct: 45 }]) {
      Match.fromConfig(cfg(over));
    }
  });

  // ---- wire ---------------------------------------------------------------

  test('Wire round-trips an action string', () => {
    const s = Wire.encodeAction({ turn: 7, color: 'C', action: 'W', hash: 'a3f2' });
    eq(s, '7C:W#a3f2');
    const r = Wire.decodeAction(s);
    assert(r.ok, r.error);
    eq(r.value.turn, 7); eq(r.value.color, 'C'); eq(r.value.action, 'W'); eq(r.value.hash, 'a3f2');
  });

  test('Wire round-trips a match code', () => {
    const c = cfg({ w: 16, h: 9, wallPct: 11, seed: '19f4', cap: 43, roster: ['C', 'P', 'T', 'A'] });
    const s = Wire.encodeMatchCode(c);
    const r = Wire.decodeMatchCode(s);
    assert(r.ok, r.error);
    for (const k of ['w', 'h', 'wallPct', 'seed', 'cap']) eq(r.value[k], c[k], k);
    eq(r.value.roster.join(''), 'CPTA');
  });

  test('Wire round-trips a full export', () => {
    const m = Match.fromConfig(cfg({ w: 8, h: 2, seed: 'exp' }));
    play(m, { C: 'D', P: 'A' });
    play(m, { C: 'D', P: 'A' });
    play(m, { C: 'I', P: 'A' });
    const r = Match.fromExport(m.export());
    assert(r.ok, r.error);
    eq(r.value.stateHash(), m.stateHash(), 'hash survives export/import');
    eq(JSON.stringify(r.value.view('C')), JSON.stringify(m.view('C')), 'view survives export/import');
    eq(r.value.currentTurn(), m.currentTurn());
  });

  test('a turn-0 action string carries a name, later turns do not', () => {
    eq(Wire.encodeAction({ turn: 0, color: 'C', action: 'D', hash: 'a3f2', name: 'Rook' }),
      '0C:D#a3f2~Rook');
    eq(Wire.encodeAction({ turn: 4, color: 'C', action: 'D', hash: 'a3f2', name: 'Rook' }),
      '4C:D#a3f2', 'the name only rides the opening string');
    const r = Wire.decodeAction('0C:D#a3f2~Rook');
    assert(r.ok, r.error);
    eq(r.value.name, 'Rook');
    eq(Wire.decodeAction('7C:W#a3f2').value.name, null, 'a nameless string is not an error');
    for (const bad of ['0C:D#a3f2~', '0C:D#a3f2~has~tilde', '0C:D#a3f2~has|bar',
      '0C:D#a3f2~thirteenchars']) {
      assert(!Wire.decodeAction(bad).ok, 'expected rejection for ' + bad);
    }
  });

  test('names reach every client without touching the state hash', () => {
    const c = cfg({ w: 8, h: 2, seed: 'names' });
    const named = Match.fromConfig(c), plain = Match.fromConfig(c);
    for (const m of [named, plain]) {
      const withName = m === named;
      m.submit({ turn: 0, color: 'C', action: 'D', hash: m.stateHash(), name: withName ? 'Rook' : undefined });
      m.submit({ turn: 0, color: 'P', action: 'A', hash: m.stateHash(), name: withName ? 'Vale' : undefined });
    }
    eq(named.stateHash(), plain.stateHash(), 'names must not change agreed state');
    eq(named.view('C').names.P, 'Vale', 'you see the name that arrived');
    eq(plain.view('C').names.P, undefined, 'and nothing before it arrives');
    assert(!named.submit({ turn: 1, color: 'C', action: 'D', hash: named.stateHash(), name: 'x~y' }).ok,
      'a name with a delimiter in it is refused, not stripped');
  });

  test('an export carries every name it knows', () => {
    const m = Match.fromConfig(cfg({ w: 8, h: 2, seed: 'exp2' }));
    m.submit({ turn: 0, color: 'C', action: 'D', hash: m.stateHash(), name: 'Rook' });
    m.submit({ turn: 0, color: 'P', action: 'A', hash: m.stateHash(), name: 'Vale' });
    play(m, { C: 'D', P: 'A' });
    const r = Match.fromExport(m.export());
    assert(r.ok, r.error);
    eq(r.value.view('C').names.C, 'Rook');
    eq(r.value.view('C').names.P, 'Vale');
    eq(r.value.stateHash(), m.stateHash(), 'hash still survives the round trip');
  });

  test('a space is not a legal name character', () => {
    const m = Match.fromConfig(cfg({ w: 8, h: 2, seed: 'space' }));
    eq(m.setName('C', 'Bo Vale'), false, 'a spaced name is refused');
    eq(m.names().C, undefined, 'and nothing is stored');
    eq(m.setName('C', 'Bo_Vale'), true, 'an underscore still reads as a separator');
    eq(m.names().C, 'Bo_Vale');
  });

  test('a spaced name does not survive an action string', () => {
    assert(!Wire.decodeAction('0P:W#00cb~Bo Vale').ok, 'a space should not decode');
    const r = Wire.decodeAction('0P:W#00cb~Bo_Vale');
    assert(r.ok, r.error);
    eq(r.value.name, 'Bo_Vale');
  });

  test('a spaced name does not survive an export either', () => {
    const r = Wire.decodeExport('X1:M1:8x2:0:exp:9:CP|CDPA|C~Bo Vale');
    assert(!r.ok || r.value.names.C !== 'Bo Vale', 'the export handed back a spaced name');
  });

  test('malformed strings are rejected, not swallowed', () => {
    for (const bad of ['', 'nonsense', '7C:Q#a3f2', 'xC:W#a3f2', '7Z:W#a3f2', '7C:W', 'M1:bad', 'X1:']) {
      const a = Wire.decodeAction(bad);
      const b = Wire.decodeMatchCode(bad);
      const c = Wire.decodeExport(bad);
      assert(!(a.ok && b.ok && c.ok), 'expected rejection for ' + JSON.stringify(bad));
      for (const r of [a, b, c]) if (!r.ok) assert(typeof r.error === 'string' && r.error.length, 'error text for ' + bad);
    }
  });

  // ---- submit guards ------------------------------------------------------

  test('submit rejects a stale hash, a wrong turn, a repeat, and an illegal action', () => {
    const m = Match.fromConfig(cfg({ w: 8, h: 2, seed: 'guard' }));
    const turn = m.currentTurn(), hash = m.stateHash();

    assert(!m.submit({ turn, color: 'C', action: 'D', hash: 'dead' }).ok, 'stale hash');
    assert(!m.submit({ turn: turn + 3, color: 'C', action: 'D', hash }).ok, 'wrong turn');
    assert(!m.submit({ turn, color: 'C', action: 'W', hash }).ok, 'illegal action (off board)');
    assert(!m.submit({ turn, color: 'Z', action: 'D', hash }).ok, 'unknown colour');
    eq(m.currentTurn(), turn, 'rejected submits do not advance the turn');

    assert(m.submit({ turn, color: 'C', action: 'D', hash }).ok, 'valid submit');
    assert(!m.submit({ turn, color: 'C', action: 'S', hash }).ok, 'repeat submit');
    eq(m.pendingColors().join(''), 'P', 'purple still pending');
  });

  test('the match stops at the cap', () => {
    const m = Match.fromConfig(cfg({ w: 8, h: 2, cap: 3, seed: 'cap' }));
    for (let i = 0; i < 3; i++) play(m, { C: i % 2 ? 'A' : 'D', P: i % 2 ? 'D' : 'A' });
    assert(m.view('C').over, 'match reports over');
    const r = m.submit({ turn: 3, color: 'C', action: 'D', hash: m.stateHash() });
    assert(!r.ok, 'no submits past the cap');
  });

  // ---- withdraw -----------------------------------------------------------

  test('withdraw returns you to pending and lets you act differently', () => {
    const m = Match.fromConfig(cfg({ w: 8, h: 2, seed: 'wd1' }));
    const turn = m.currentTurn(), hash = m.stateHash();
    assert(m.submit({ turn, color: 'C', action: 'D', hash }).ok, 'first commit');
    assert(m.pendingColors().indexOf('C') < 0, 'coral is committed');

    const r = m.withdraw('C');
    assert(r.ok, 'withdraw: ' + r.error);
    assert(m.pendingColors().indexOf('C') >= 0, 'coral is pending again');
    eq(m.currentTurn(), turn, 'taking an action back does not move the turn');
    eq(m.stateHash(), hash, 'nor the state everyone agreed on');

    assert(m.submit({ turn, color: 'C', action: 'S', hash: m.stateHash() }).ok, 'second commit');
    assert(m.submit({ turn, color: 'P', action: 'A', hash: m.stateHash() }).ok, 'purple');
    const me = m.view('C').me;
    eq(me.x, 0, 'coral went down, not right'); eq(me.y, 1);
  });

  test('withdraw refuses when you have not acted this turn', () => {
    const m = Match.fromConfig(cfg({ w: 8, h: 2, seed: 'wd2' }));
    const r = m.withdraw('C');
    assert(!r.ok, 'there is nothing to take back');
    assert(typeof r.error === 'string' && r.error.length, 'error text');
  });

  test('withdraw refuses once the turn has resolved', () => {
    const m = Match.fromConfig(cfg({ w: 8, h: 2, seed: 'wd3' }));
    play(m, { C: 'D', P: 'A' });
    const r = m.withdraw('C');
    assert(!r.ok, 'an applied turn is history, not a draft');
    assert(typeof r.error === 'string' && r.error.length, 'error text');
    eq(m.currentTurn(), 1, 'and the turn stands');
  });

  test('withdraw twice refuses the second time', () => {
    const m = Match.fromConfig(cfg({ w: 8, h: 2, seed: 'wd4' }));
    const turn = m.currentTurn(), hash = m.stateHash();
    assert(m.submit({ turn, color: 'C', action: 'D', hash }).ok, 'commit');
    assert(m.withdraw('C').ok, 'first withdraw');
    const r = m.withdraw('C');
    assert(!r.ok, 'second withdraw');
    assert(typeof r.error === 'string' && r.error.length, 'error text');
  });

  test('withdraw refuses an unknown colour', () => {
    const m = Match.fromConfig(cfg({ w: 8, h: 2, seed: 'wd5' }));
    const r = m.withdraw('Z');
    assert(!r.ok, 'Z is not in this match');
    assert(typeof r.error === 'string' && r.error.length, 'error text');
  });

  test('an export taken after a withdraw has lost the withdrawn action', () => {
    const m = Match.fromConfig(cfg({ w: 8, h: 2, seed: 'wd6' }));
    const turn = m.currentTurn(), hash = m.stateHash();
    assert(m.submit({ turn, color: 'C', action: 'D', hash }).ok, 'commit');
    const before = m.export();
    assert(m.withdraw('C').ok, 'withdraw');
    const after = m.export();
    assert(before !== after, 'the export still carries the action it was told to forget');
    const r = Match.fromExport(after);
    assert(r.ok, r.error);
    assert(r.value.pendingColors().indexOf('C') >= 0, 'the reimported match has coral pending');
  });

  // ---- my committed action ------------------------------------------------

  test('the view carries the wire string for your own committed action', () => {
    const m = Match.fromConfig(cfg({ w: 8, h: 2, seed: 'mine' }));
    eq(m.view('C').myAction, null, 'nothing committed yet');

    const t0 = m.currentTurn(), h0 = m.stateHash();
    assert(m.submit({ turn: t0, color: 'C', action: 'D', hash: h0, name: 'Rook' }).ok, 'commit');
    eq(m.view('C').myAction,
      Wire.encodeAction({ turn: t0, color: 'C', action: 'D', hash: h0, name: 'Rook' }),
      'the opening string carries the name');
    eq(m.view('P').myAction, null, "and nobody is handed anyone else's");

    assert(m.submit({ turn: t0, color: 'P', action: 'A', hash: m.stateHash() }).ok, 'purple');
    eq(m.view('C').myAction, null, 'a resolved turn leaves nothing to send');

    const t1 = m.currentTurn(), h1 = m.stateHash();
    assert(m.submit({ turn: t1, color: 'C', action: 'D', hash: h1 }).ok, 'commit again');
    eq(m.view('C').myAction,
      Wire.encodeAction({ turn: t1, color: 'C', action: 'D', hash: h1, name: 'Rook' }),
      'later turns drop the name');
  });

  test('withdrawing clears your committed action string', () => {
    const m = Match.fromConfig(cfg({ w: 8, h: 2, seed: 'mine2' }));
    const turn = m.currentTurn(), hash = m.stateHash();
    assert(m.submit({ turn, color: 'C', action: 'D', hash }).ok, 'commit');
    assert(m.view('C').myAction, 'there is a string to send');
    assert(m.withdraw('C').ok, 'withdraw');
    eq(m.view('C').myAction, null, 'nothing to send once it is taken back');
  });

  // ---- determinism soak ---------------------------------------------------

  test('a block reason never names a colour or a world turn', () => {
    // The renderer shows these verbatim on hover, and the blocked tile can sit
    // past the viewer's horizon, so the text itself has to stay uninformative.
    const ALLOWED = new Set([
      null, 'occupied', 'wall', 'off the board', 'unknown action',
      'that is before the start of time', 'the match is over',
    ]);
    const names = ['Coral', 'Purple', 'Teal', 'Amber', 'Rook', 'Vale', 'Nim', 'Sable'];

    for (let s = 0; s < 60; s++) {
      const roster = ['C', 'P', 'T', 'A'];
      const c = cfg({ w: 6, h: 5, wallPct: 14, seed: 'reason' + s, cap: 14, roster });
      const m = Match.fromConfig(c);
      while (!m.view('C').over) {
        const turn = m.currentTurn(), hash = m.stateHash();
        for (const color of roster) {
          const legal = m.legalActions(color);
          for (const a of Object.keys(legal)) {
            const r = legal[a];
            assert(ALLOWED.has(r), 'seed ' + s + ' reason "' + r + '" is not in the safe vocabulary');
            if (r) {
              assert(!/t\d/.test(r), 'reason "' + r + '" leaks a world turn');
              assert(!names.some((n) => r.indexOf(n) >= 0), 'reason "' + r + '" leaks a colour');
            }
          }
          const opts = Object.keys(legal).filter((k) => legal[k] === null);
          m.submit({
            turn, color, hash,
            action: opts[(s + color.charCodeAt(0)) % opts.length],
            name: turn === 0 ? { C: 'Rook', P: 'Vale', T: 'Nim', A: 'Sable' }[color] : undefined,
          });
        }
      }
    }
  });

  test('a blocked direction never names a body past your horizon', () => {
    // Purple turns around at t1 while coral runs on. Hovering a blocked direction
    // must not report "Coral is there at t3".
    const m = Match.fromConfig(cfg({ w: 4, h: 2, seed: 'leak' }));
    play(m, { C: 'D', P: 'A' }); // C (1,0)@t1 ; P (2,1)@t1
    play(m, { C: 'D', P: 'I' }); // C (2,0)@t2 ; P turns around on (2,1)@t1
    const v = m.view('P');
    eq(v.me.horizon, 1, 'purple never reached past t1');
    assert(v.bodies.every((b) => b.t <= 1), 'and sees nothing past it');
    for (const a of v.actions) {
      assert(!a.reason || (a.reason.indexOf('Coral') < 0 && !/t\d/.test(a.reason)),
        'leak via ' + a.action + ': ' + a.reason);
    }
    eq(v.actions.length, 6, 'every action is offered with a verdict');
    eq(v.actions.filter((a) => a.reason === null).length > 0, true, 'at least one is legal');
  });

  test('soak: 200 random matches replay identically and hold every invariant', () => {
    let stuckSeen = 0, invertSeen = 0, heldSeen = 0, blockedSeen = 0;
    for (let s = 0; s < 200; s++) {
      const rnd = mulberry32(s * 2654435761);
      const roster = ['C', 'P', 'T', 'A'].slice(0, 2 + Math.floor(rnd() * 3));
      const c = {
        w: 4 + Math.floor(rnd() * 10), h: 3 + Math.floor(rnd() * 6),
        wallPct: Math.floor(rnd() * 25), seed: 'soak' + s, cap: 14, roster,
      };
      const m = Match.fromConfig(c);
      const log = [];

      while (!m.view(roster[0]).over) {
        const turn = m.currentTurn(), hash = m.stateHash();
        for (const color of roster) {
          const legal = m.legalActions(color);
          // Inverting is unblockable by construction, so this is the load-bearing
          // reason no player can ever run out of moves.
          eq(legal.I, null, 'soak ' + s + ': ' + color + ' cannot invert');
          const opts = Object.keys(legal).filter((k) => legal[k] === null);
          const action = opts[Math.floor(rnd() * opts.length)];
          if (action === 'I') invertSeen++;
          if (action === 'H') heldSeen++;
          const r = m.submit({ turn, color, action, hash });
          assert(r.ok, 'soak ' + s + ' turn ' + turn + ' ' + color + ': ' + r.error);
          log.push({ turn, color, action });
        }
        eq(m.currentTurn(), turn + 1, 'soak ' + s + ': turn must advance once all colours submit');

        const v = m.view(roster[0]);
        const here = v.events.filter((e) => e.turn === turn);
        blockedSeen += here.filter((e) => e.kind === 'blocked').length;

        // Only an inverted player can be stuck. A forward player's fallback square
        // is unwritten future, so nothing can already own it.
        for (const color of roster) {
          if (!m.view(color).events.some((e) => e.turn === turn && e.color === color && e.kind === 'stuck')) continue;
          stuckSeen++;
          eq(m.view(color).me.dir, -1, 'soak ' + s + ': a forward player got stuck at turn ' + turn);
        }

        // Invariant: no two different colours share a tile at the same world turn.
        for (const color of roster) {
          const occ = new Map();
          for (const b of m.view(color).bodies) {
            const k = b.t + ',' + b.x + ',' + b.y;
            if (occ.has(k) && occ.get(k) !== b.color) {
              throw new Error('soak ' + s + ': ' + occ.get(k) + ' and ' + b.color + ' share ' + k);
            }
            occ.set(k, b.color);
          }
        }
      }

      // Invariant: replaying the same log rebuilds the same state.
      const re = Match.fromConfig(c);
      for (const e of log) {
        const r = re.submit({ turn: e.turn, color: e.color, action: e.action, hash: re.stateHash() });
        assert(r.ok, 'soak replay ' + s + ': ' + r.error);
      }
      eq(re.stateHash(), m.stateHash(), 'soak ' + s + ' replay hash');

      // Invariant: export/import is lossless.
      const imp = Match.fromExport(m.export());
      assert(imp.ok, 'soak ' + s + ' import: ' + imp.error);
      eq(imp.value.stateHash(), m.stateHash(), 'soak ' + s + ' export hash');
    }
    assert(invertSeen > 0, 'soak never exercised inversion');
    assert(heldSeen > 0, 'soak never exercised holding');
    assert(blockedSeen > 0, 'soak never exercised a tile contest');
    results.push({
      name: '  (soak coverage: ' + invertSeen + ' inversions, ' + heldSeen + ' holds, ' +
        blockedSeen + ' contests, ' + stuckSeen + ' stuck)', ok: true, error: null,
    });
  });

  return { results };
}
