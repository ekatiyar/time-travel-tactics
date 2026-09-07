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
  // Submit every colour's action for the current turn, asserting each is accepted.
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
    play(m, { C: 'E', P: 'W' });
    play(m, { C: 'E', P: 'W' });
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

  test('inversion flips direction, keeps position, steps the playhead back', () => {
    const m = Match.fromConfig(cfg({ w: 8, h: 2 }));
    play(m, { C: 'E', P: 'W' });
    play(m, { C: 'E', P: 'W' });
    play(m, { C: 'E', P: 'W' });
    const before = m.view('C').me;
    eq(before.t, 3); eq(before.x, 3); eq(before.y, 0);
    play(m, { C: 'I', P: 'W' });
    const after = m.view('C').me;
    eq(after.dir, -1, 'direction flipped');
    eq(after.t, 2, 'playhead stepped in the new direction');
    eq(after.x, 3, 'x unchanged'); eq(after.y, 0, 'y unchanged');
    eq(after.p, 4, 'personal index still incremented');
  });

  test('personal index keeps incrementing while moving backward', () => {
    const m = Match.fromConfig(cfg({ w: 8, h: 2 }));
    play(m, { C: 'E', P: 'W' });
    play(m, { C: 'E', P: 'W' });
    play(m, { C: 'I', P: 'W' });
    play(m, { C: 'W', P: 'W' });
    const me = m.view('C').me;
    eq(me.p, 4, 'index'); eq(me.t, 0, 'world turn'); eq(me.dir, -1);
  });

  test('backward at t0: inverting is the only legal action', () => {
    const m = Match.fromConfig(cfg({ w: 8, h: 2 }));
    play(m, { C: 'E', P: 'W' });
    play(m, { C: 'I', P: 'W' });
    const me = m.view('C').me;
    eq(me.t, 0); eq(me.dir, -1);
    const l = m.legalActions('C');
    assert(l.N, 'N blocked'); assert(l.S, 'S blocked');
    assert(l.E, 'E blocked'); assert(l.W, 'W blocked');
    eq(l.I, null, 'invert legal');
    assert(l.X, 'pass is not offered while inverting is still possible');
  });

  test('inverting onto your own body is legal (the turnstile)', () => {
    const m = Match.fromConfig(cfg({ w: 8, h: 2 }));
    // C: E E E I W W I  -- ends inverting back onto its own p1 body at t1.
    play(m, { C: 'E', P: 'W' });
    play(m, { C: 'E', P: 'W' });
    play(m, { C: 'E', P: 'W' });
    play(m, { C: 'I', P: 'W' });
    play(m, { C: 'W', P: 'W' });
    play(m, { C: 'W', P: 'W' });
    eq(m.legalActions('C').I, null, 'invert onto own instance must be legal');
    play(m, { C: 'I', P: 'W' });
    const me = m.view('C').me;
    eq(me.t, 1); eq(me.x, 1); eq(me.y, 0); eq(me.p, 7); eq(me.dir, 1);
    const onTile = bodyAt(m, 'C', 1).filter((b) => b.x === 1 && b.y === 0);
    eq(onTile.length, 2, 'p1 and p7 share tile (1,0) at t1');
    eq(onTile.map((b) => b.p).sort((a, b) => a - b).join(','), '1,7');
  });

  // ---- movement legality --------------------------------------------------

  test('pass is only offered when nothing else is legal', () => {
    const m = Match.fromConfig(cfg());
    const l = m.legalActions('C');
    assert(l.E === null || l.S === null, 'spawn has a legal move');
    assert(l.X, 'pass must be refused while a real action exists, got: ' + l.X);
    assert(!m.submit({ turn: 0, color: 'C', action: 'X', hash: m.stateHash() }).ok, 'pass rejected');
  });

  test('board edge blocks a move', () => {
    const m = Match.fromConfig(cfg());
    const l = m.legalActions('C'); // spawn is (0,0)
    assert(l.N, 'north off board'); assert(l.W, 'west off board');
    eq(l.E, null); eq(l.S, null);
  });

  test('your own other instance blocks a move', () => {
    const m = Match.fromConfig(cfg({ w: 8, h: 2 }));
    play(m, { C: 'E', P: 'W' });
    play(m, { C: 'E', P: 'W' });
    play(m, { C: 'E', P: 'W' });
    play(m, { C: 'I', P: 'W' });
    play(m, { C: 'W', P: 'W' });
    play(m, { C: 'W', P: 'W' });
    play(m, { C: 'I', P: 'W' });
    // Now at (1,0) t1 heading forward; C's own p2 sits on (2,0) at t2.
    const l = m.legalActions('C');
    eq(l.E, 'occupied', 'east blocked by own instance');
    eq(l.W, null, 'west free'); eq(l.S, null, 'south free');
  });

  test("another colour's recorded body blocks an invert", () => {
    const m = Match.fromConfig(cfg({ w: 3, h: 2 }));
    play(m, { C: 'E', P: 'N' }); // C (1,0)@t1 ; P (2,0)@t1
    play(m, { C: 'E', P: 'W' }); // C (2,0)@t2 ; P (1,0)@t2
    // Inverting would put C on (2,0)@t1, where purple's p1 already sits.
    const l = m.legalActions('C');
    assert(l.I && !/self/i.test(l.I), 'invert blocked by opponent, got: ' + l.I);
  });

  test("another colour's recorded body blocks a move", () => {
    const m = Match.fromConfig(cfg({ w: 3, h: 2 }));
    play(m, { C: 'E', P: 'N' }); // C (1,0)@t1 ; P (2,0)@t1
    play(m, { C: 'E', P: 'W' }); // C (2,0)@t2 ; P (1,0)@t2
    play(m, { C: 'S', P: 'S' }); // C (2,1)@t3 ; P (1,1)@t3
    play(m, { C: 'I', P: 'N' }); // C inverts -> (2,1)@t2 ; P (1,0)@t4
    const l = m.legalActions('C'); // heading back to t1 from (2,1)
    assert(l.N && !/self/i.test(l.N), 'north blocked by purple p1 at (2,0)@t1, got: ' + l.N);
  });

  test('a generated wall blocks a move', () => {
    let found = null;
    for (let s = 0; s < 80 && !found; s++) {
      const m = Match.fromConfig(cfg({ wallPct: 30, seed: 'w' + s }));
      const l = m.legalActions('C');
      if (l.E && /wall/i.test(l.E)) found = { s, l };
      else if (l.S && /wall/i.test(l.S)) found = { s, l };
    }
    assert(found, 'no seed in 0..79 put a wall next to coral spawn at 30% density');
  });

  // ---- collisions ---------------------------------------------------------

  test('contested tile: priority winner takes it, loser stays put', () => {
    const m = Match.fromConfig(cfg({ w: 4, h: 2, seed: 'collide' }));
    play(m, { C: 'E', P: 'N' }); // C (1,0)@t1 ; P (3,0)@t1
    const prio = m.view('C').priority.slice();
    eq(prio.length, 2);
    const stay = { C: [1, 0], P: [3, 0] };
    play(m, { C: 'E', P: 'W' }); // both target (2,0)@t2
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
    let bounces = 0, upsets = 0, cascades = 0, first = null;

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
        const evts = m.view('C').events, kindOf = {};
        for (const e of evts) kindOf[e.color] = e.kind;
        for (const e of evts) {
          if (e.kind !== 'blocked') continue;
          bounces++;
          // Whoever won held their square: they inverted, or were bounced themselves.
          assert(kindOf[e.by] === 'inverted' || kindOf[e.by] === 'blocked' || kindOf[e.by] === 'moved',
            'blocker ' + e.by + ' has no outcome this turn');
          // A bounced mover bouncing someone else is the cascade the fixed point exists for.
          if (kindOf[e.by] === 'blocked') cascades++;
          if (prio.indexOf(e.by) > prio.indexOf(e.color)) {
            upsets++;
            if (!first) first = { seed: 'hold' + s, turn, e: e, by: kindOf[e.by] };
          }
        }
      }
    }

    assert(upsets > 0, 'never saw a stayer beat a higher-priority mover in 600 matches');
    assert(cascades > 0, 'a bounced mover never went on to bounce anyone — fixed point untested');
    assert(first.by !== 'moved', 'a lower-priority winner must have stayed, not moved: ' + first.by);
    results.push({
      name: '  (' + bounces + ' bounces: ' + upsets + ' beat higher priority, ' + cascades +
        ' cascaded; first at ' + first.seed + ' turn ' + first.turn + ')',
      ok: true, error: null,
    });
  });

  test('priority order is deterministic per seed and turn', () => {
    const a = Match.fromConfig(cfg({ roster: ['C', 'P', 'T', 'A'], seed: 'prio' }));
    const b = Match.fromConfig(cfg({ roster: ['C', 'P', 'T', 'A'], seed: 'prio' }));
    for (let i = 0; i < 5; i++) {
      eq(a.view('C').priority.join(''), b.view('C').priority.join(''), 'turn ' + i);
      const acts = { C: 'E', P: 'W', T: 'W', A: 'E' };
      play(a, acts); play(b, acts);
    }
    const orders = new Set();
    const m2 = Match.fromConfig(cfg({ roster: ['C', 'P', 'T', 'A'], seed: 'prio' }));
    for (let i = 0; i < 12; i++) {
      orders.add(m2.view('C').priority.join(''));
      play(m2, { C: 'E', P: 'W', T: 'W', A: 'E' });
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
    play(m, { C: 'E', P: 'W' });
    play(m, { C: 'E', P: 'W' });
    play(m, { C: 'E', P: 'W' });
    play(m, { C: 'I', P: 'W' });
    play(m, { C: 'W', P: 'W' });
    eq(m.view('C').me.horizon, 3, 'coral inverted at t3');
    eq(m.view('P').me.horizon, 5, 'purple stayed forward');
  });

  test('view hides everything beyond your horizon', () => {
    const m = Match.fromConfig(cfg({ w: 8, h: 2 }));
    play(m, { C: 'E', P: 'W' });
    play(m, { C: 'E', P: 'W' });
    play(m, { C: 'E', P: 'W' });
    play(m, { C: 'I', P: 'W' });
    play(m, { C: 'W', P: 'W' });
    play(m, { C: 'W', P: 'W' });
    const v = m.view('C');
    assert(v.bodies.every((b) => b.t <= 3), 'no body past coral horizon');
    assert(v.bodies.some((b) => b.color === 'P'), 'purple trail inside horizon is visible');
    assert(!v.bodies.some((b) => b.color === 'P' && b.t > 3), 'purple past horizon hidden');
    const vp = m.view('P');
    assert(vp.bodies.some((b) => b.color === 'P' && b.t > 3), 'purple sees its own later turns');
    assert(v.me.horizon !== undefined && vp.me.horizon !== undefined);
    assert(!('horizon' in (v.opponents || {})), 'opponent horizons are not disclosed');
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
      // flood fill from the first spawn
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

  // ---- wire ---------------------------------------------------------------

  test('Wire round-trips an action string', () => {
    const s = Wire.encodeAction({ turn: 7, color: 'C', action: 'N', hash: 'a3f2' });
    eq(s, '7C:N#a3f2');
    const r = Wire.decodeAction(s);
    assert(r.ok, r.error);
    eq(r.value.turn, 7); eq(r.value.color, 'C'); eq(r.value.action, 'N'); eq(r.value.hash, 'a3f2');
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
    play(m, { C: 'E', P: 'W' });
    play(m, { C: 'E', P: 'W' });
    play(m, { C: 'I', P: 'W' });
    const r = Match.fromExport(m.export());
    assert(r.ok, r.error);
    eq(r.value.stateHash(), m.stateHash(), 'hash survives export/import');
    eq(JSON.stringify(r.value.view('C')), JSON.stringify(m.view('C')), 'view survives export/import');
    eq(r.value.currentTurn(), m.currentTurn());
  });

  test('malformed strings are rejected, not swallowed', () => {
    for (const bad of ['', 'nonsense', '7C:Q#a3f2', 'xC:N#a3f2', '7Z:N#a3f2', '7C:N', 'M1:bad', 'X1:']) {
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

    assert(!m.submit({ turn, color: 'C', action: 'E', hash: 'dead' }).ok, 'stale hash');
    assert(!m.submit({ turn: turn + 3, color: 'C', action: 'E', hash }).ok, 'wrong turn');
    assert(!m.submit({ turn, color: 'C', action: 'N', hash }).ok, 'illegal action (off board)');
    assert(!m.submit({ turn, color: 'Z', action: 'E', hash }).ok, 'unknown colour');
    eq(m.currentTurn(), turn, 'rejected submits do not advance the turn');

    assert(m.submit({ turn, color: 'C', action: 'E', hash }).ok, 'valid submit');
    assert(!m.submit({ turn, color: 'C', action: 'S', hash }).ok, 'repeat submit');
    eq(m.pendingColors().join(''), 'P', 'purple still pending');
  });

  test('the match stops at the cap', () => {
    const m = Match.fromConfig(cfg({ w: 8, h: 2, cap: 3, seed: 'cap' }));
    for (let i = 0; i < 3; i++) play(m, { C: i % 2 ? 'W' : 'E', P: i % 2 ? 'E' : 'W' });
    assert(m.view('C').over, 'match reports over');
    const r = m.submit({ turn: 3, color: 'C', action: 'E', hash: m.stateHash() });
    assert(!r.ok, 'no submits past the cap');
  });

  // ---- determinism soak ---------------------------------------------------

  test('a block reason never names a colour or a world turn', () => {
    // The renderer shows these verbatim on hover, and the blocked tile can sit
    // past the viewer's horizon, so the text itself has to stay uninformative.
    const ALLOWED = new Set([
      null, 'occupied', 'wall', 'off the board', 'unknown action',
      'that is before the start of time', 'you still have a real action available',
      'the match is over',
    ]);
    const names = ['Coral', 'Purple', 'Teal', 'Amber'];

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
          m.submit({ turn, color, action: opts[(s + color.charCodeAt(0)) % opts.length], hash });
        }
      }
    }
  });

  test('the reported horizon leak stays plugged', () => {
    // Purple has only lived to t2 here; before the fix, hovering north reported
    // "Coral is there at t3".
    const imp = Match.fromExport('X1:M1:3x2:0:lk16:14:CP|CEPW,CWPI,CEPI,CIPN,CE');
    assert(imp.ok, 'repro import: ' + imp.error);
    const v = imp.value.view('P');
    eq(v.me.horizon, 2, 'purple horizon');
    for (const a of Object.keys(v.legal)) {
      const r = v.legal[a];
      assert(!r || (r.indexOf('Coral') < 0 && !/t\d/.test(r)), 'leak via ' + a + ': ' + r);
    }
  });

  test('soak: 200 random matches replay identically and hold every invariant', () => {
    let stuckSeen = 0, invertSeen = 0, blockedSeen = 0;
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
          const opts = Object.keys(legal).filter((k) => legal[k] === null);
          assert(opts.length, 'soak ' + s + ': ' + color + ' has no action at all, not even a pass');
          const action = opts[Math.floor(rnd() * opts.length)];
          if (action === 'I') invertSeen++;
          if (action === 'X') stuckSeen++;
          const r = m.submit({ turn, color, action, hash });
          assert(r.ok, 'soak ' + s + ' turn ' + turn + ' ' + color + ': ' + r.error);
          log.push({ turn, color, action });
        }
        eq(m.currentTurn(), turn + 1, 'soak ' + s + ': turn must advance once all colours submit');

        const v = m.view(roster[0]);
        blockedSeen += v.events.filter((e) => e.kind === 'blocked').length;

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
    assert(blockedSeen > 0, 'soak never exercised a tile contest');
    results.push({
      name: '  (soak coverage: ' + invertSeen + ' inversions, ' + blockedSeen +
        ' contests, ' + stuckSeen + ' stuck)', ok: true, error: null,
    });
  });

  return { results };
}
