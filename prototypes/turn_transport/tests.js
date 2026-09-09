/* Transport tests for tbtt_prototype_turn_transport.html.
   Injected into the page by run_tests.py; not shipped in the HTML.

   These cover the TRANSPORT block only. The engine underneath is the time_travel
   prototype's, tested by that prototype's tests.js, which tests.include pulls in
   ahead of this file. */

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

  // Fetched per test rather than destructured once, so a missing module fails
  // each test on its own line instead of taking the whole file down.
  function transport() {
    const T = window.TBTT_TRANSPORT;
    if (!T) throw new Error('window.TBTT_TRANSPORT is missing');
    return T;
  }

  // Two sessions on the two ends of one loopback channel, each with its own
  // Match built from the same config. LoopbackChannel.pair() is assumed to
  // deliver synchronously: send() has reached the other end's onMessage by the
  // time it returns, so no test here waits or pumps.
  function mkPair(over) {
    const { Session, LoopbackChannel } = transport();
    const c = cfg(over);
    const ends = LoopbackChannel.pair();
    const a = ends[0], b = ends[1];
    const changes = { a: 0, b: 0 };
    const sa = Session.open({ match: Match.fromConfig(c), channel: a, onChange: function () { changes.a++; } });
    const sb = Session.open({ match: Match.fromConfig(c), channel: b, onChange: function () { changes.b++; } });
    return { a, b, sa, sb, changes };
  }

  function seat(s, color, name) {
    const r = s.claim(color, name);
    assert(r && r.ok, 'claim ' + color + ': ' + (r && r.error));
    return r;
  }
  // Records every string handed to the channel. Wrap before Session.open.
  function record(ch) {
    const sent = [];
    const raw = ch.send.bind(ch);
    ch.send = function (text) { sent.push(text); return raw(text); };
    return sent;
  }
  function commitLegal(s) {
    const v = s.view();
    const opt = v.actions.filter((a) => a.reason === null)[0];
    assert(opt, 'no legal action for ' + v.me.color);
    s.commit(opt.action);
  }

  // ---- a turn over the wire -----------------------------------------------

  test('two loopback sessions play a turn without anyone pasting a string', () => {
    const { sa, sb, changes } = mkPair();
    seat(sa, 'C', 'Rook');
    seat(sb, 'P', 'Vale');
    eq(sa.view().me.color, 'C', 'the claim picks the seat the view renders');
    eq(sb.view().me.color, 'P');

    sa.commit('D');
    sb.commit('A');

    eq(sa.view().turn, 1, 'coral advanced');
    eq(sb.view().turn, 1, 'purple advanced');
    eq(sa.view().hash, sb.view().hash, 'and they agree on the state');
    eq(sa.view().me.x, 1, 'coral stepped right');
    eq(sb.view().me.x, 14, 'purple stepped left');
    assert(sa.view().bodies.some((bd) => bd.color === 'P' && bd.t === 1),
      "coral can see purple's t1 body");
    eq(sa.view().status, 'live', 'a wired pair is live, not manual');
    assert(!sa.view().error, 'no error: ' + sa.view().error);
    assert(changes.a > 0 && changes.b > 0, 'onChange fired on both sides');
  });

  test('an action that arrives before you commit is held, not applied', () => {
    const { sa, sb } = mkPair();
    seat(sa, 'C', 'Rook');
    seat(sb, 'P', 'Vale');

    sb.commit('A'); // reaches coral, who has not moved yet

    eq(sa.view().turn, 0, 'the turn must not resolve on one action');
    eq(sa.view().me.t, 0, 'coral has not travelled');
    assert(sa.view().pending.indexOf('P') >= 0,
      "the held action has not been submitted to coral's match");
    assert(!sa.view().error, 'holding an early action is not an error');
  });

  test('a held action is still reported: waiting shows the other colour is in', () => {
    const { sa, sb } = mkPair();
    seat(sa, 'C', 'Rook');
    seat(sb, 'P', 'Vale');
    assert(sa.view().waiting.indexOf('P') >= 0, 'purple is owed before it acts');

    sb.commit('A');

    // waiting is who you are still owed an action by, so it never lists your own
    // colour, and a held action drops its colour even though the match has not
    // seen it. Both sides of that are the point: the strip says "waiting for
    // Vale" or it says nothing.
    assert(sa.view().waiting.indexOf('P') < 0, 'purple is in and should not still be waited on');
    assert(sa.view().waiting.indexOf('C') < 0, 'you are never waiting on yourself');
    eq(sa.view().waiting.length, 0, 'everyone else is in, coral is just deciding');
  });

  test('committing flushes the buffer and the turn resolves', () => {
    const { sa, sb } = mkPair();
    seat(sa, 'C', 'Rook');
    seat(sb, 'P', 'Vale');

    sb.commit('A');
    eq(sa.view().turn, 0, 'still held');
    sa.commit('D');

    eq(sa.view().turn, 1, 'the flush resolved the turn');
    eq(sa.view().hash, sb.view().hash, 'both sides landed on the same state');
    eq(sa.view().waiting.join(''), 'P', 'a fresh turn owes purple again');
    assert(sa.view().bodies.some((bd) => bd.color === 'P' && bd.t === 1),
      "the buffered action really was purple's move");
  });

  test('a duplicate delivery of the same action is harmless', () => {
    const { b, sa, sb } = mkPair();
    seat(sa, 'C', 'Rook');
    seat(sb, 'P', 'Vale');

    sb.commit('A');
    const str = sb.view().myAction;
    assert(str, 'purple should still hold the string it sent');
    b.send(str);
    b.send(str);
    assert(!sa.view().error, 'a repeat before the flush: ' + sa.view().error);

    sa.commit('D');
    eq(sa.view().turn, 1, 'the turn resolved exactly once');
    b.send(str); // and once more, after it has already been applied
    eq(sa.view().turn, 1, 'a late repeat changes nothing');
    assert(!sa.view().error, 'a repeat after the flush: ' + sa.view().error);
    eq(sa.view().hash, sb.view().hash);
  });

  // ---- claims -------------------------------------------------------------

  test('two clients claiming one colour: the lower client id keeps it', () => {
    // No authority, so both ends run the same comparison on the two client ids
    // and reach the same seat. Ids compare as strings.
    const first = mkPair();
    const lowFirst = first.a.id < first.b.id ? first.sa : first.sb;
    const highFirst = first.a.id < first.b.id ? first.sb : first.sa;
    const lowId = first.a.id < first.b.id ? first.a.id : first.b.id;

    const r1 = lowFirst.claim('C', 'Rook');
    assert(r1 && r1.ok, 'the lower id claimed first and must hold it: ' + (r1 && r1.error));
    const r2 = highFirst.claim('C', 'Vale');
    assert(r2 && !r2.ok, 'the higher id must lose the contest');
    assert(typeof r2.error === 'string' && r2.error.length, 'and be told why');
    eq(first.sa.claims().C.clientId, lowId, 'one side names the winner');
    eq(first.sb.claims().C.clientId, lowId, 'the other side names the same winner');
    eq(first.sa.claims().C.name, 'Rook');

    // Reversed arrival order has to reach the same seat.
    const second = mkPair();
    const lowSecond = second.a.id < second.b.id ? second.sa : second.sb;
    const highSecond = second.a.id < second.b.id ? second.sb : second.sa;
    const lowId2 = second.a.id < second.b.id ? second.a.id : second.b.id;
    highSecond.claim('C', 'Vale');
    lowSecond.claim('C', 'Rook');
    eq(second.sa.claims().C.clientId, lowId2, 'arrival order does not decide it');
    eq(second.sb.claims().C.clientId, lowId2, 'and both sides still agree');
    eq(second.sa.claims().C.name, 'Rook');
  });

  test('claims() tells the colour picker what to grey out', () => {
    const { a, b, sa, sb } = mkPair({ roster: ['C', 'P', 'T', 'A'] });
    seat(sa, 'C', 'Rook');
    seat(sb, 'P', 'Vale');

    const mine = sa.claims();
    eq(Object.keys(mine).sort().join(''), 'CP', 'only taken colours are listed');
    eq(mine.C.name, 'Rook'); eq(mine.C.clientId, a.id);
    eq(mine.P.name, 'Vale'); eq(mine.P.clientId, b.id);
    eq(mine.T, undefined, 'a free colour is absent, not present and blank');
    const theirs = sb.claims();
    eq(theirs.C.clientId, a.id, 'both sides see the same board');
    eq(theirs.P.clientId, b.id);
  });

  // ---- rejoin -------------------------------------------------------------

  test('a peer that appears late is sent the claim and the current-turn action', () => {
    const { Session, LoopbackChannel } = transport();
    const c = cfg();
    // pair() wires both ends up front, so nobody is ever new. Built one end at a
    // time instead, and linked once the second is open: the status report that
    // link() emits is the entire trigger.
    const a = LoopbackChannel.make('lateA');
    const sa = Session.open({ match: Match.fromConfig(c), channel: a, onChange: function () {} });
    seat(sa, 'C', 'Rook');
    sa.commit('D'); // broadcast into an empty room

    const b = LoopbackChannel.make('lateB');
    const sb = Session.open({ match: Match.fromConfig(c), channel: b, onChange: function () {} });
    LoopbackChannel.link(a, b);

    assert(sb.claims().C, 'the joiner should have been told coral is taken');
    eq(sb.claims().C.clientId, a.id);
    eq(sb.claims().C.name, 'Rook');

    seat(sb, 'P', 'Vale');
    sb.commit('A');
    eq(sb.view().turn, 1, 'the joiner caught up and the turn resolved');
    eq(sa.view().turn, 1);
    eq(sa.view().hash, sb.view().hash);
    // The joiner learns the name from the claim string, not from view().names:
    // Session.claim does not seed the Match, so the turn-0 action it resends
    // carries no ~name.
  });

  // ---- match code ---------------------------------------------------------

  test('Code round-trips, and a bare match code reads as paste', () => {
    const { Code } = transport();
    const c = cfg({ w: 16, h: 9, wallPct: 11, seed: '19f4', cap: 43, roster: ['C', 'P', 'T', 'A'] });

    const s = Code.encode(c, 'P');
    eq(s, 'M1:16x9:11:19f4:43:CPTA:P');
    eq(s.slice(0, s.lastIndexOf(':')), Wire.encodeMatchCode(c),
      'the game segment is byte-identical to what the engine writes');
    eq(Code.encode(c, 'X'), Wire.encodeMatchCode(c) + ':X');

    const r = Code.decode(s);
    assert(r.ok, r.error);
    eq(r.transport, 'P');
    for (const k of ['w', 'h', 'wallPct', 'seed', 'cap']) eq(r.cfg[k], c[k], k);
    eq(r.cfg.roster.join(''), 'CPTA');

    const bare = Code.decode(Wire.encodeMatchCode(c));
    assert(bare.ok, bare.error);
    eq(bare.transport, 'X', 'a code with no trailing segment is a paste match');
    eq(bare.cfg.seed, '19f4');

    for (const bad of ['', 'nonsense', 'M1:bad', 'M1:16x9:11:19f4:43:CPTA:Q']) {
      const rb = Code.decode(bad);
      assert(!rb.ok, 'expected a rejection for ' + JSON.stringify(bad));
      assert(typeof rb.error === 'string' && rb.error.length, 'error text for ' + bad);
    }
  });

  test('the same code string gives the same room id, a different one does not', () => {
    const { Code } = transport();
    const s1 = Code.encode(cfg({ seed: 'aaa' }), 'P');
    const s2 = Code.encode(cfg({ seed: 'aaa' }), 'P');
    const s3 = Code.encode(cfg({ seed: 'bbb' }), 'P');

    const id = Code.roomId(s1);
    assert(typeof id === 'string' && id.length, 'a room id is a non-empty string');
    eq(Code.roomId(s2), id, 'the same code has to find the same room');
    assert(Code.roomId(s3) !== id, 'a different seed is a different room');
    assert(Code.roomId(Code.encode(cfg({ seed: 'aaa' }), 'X')) !== id,
      'the id hashes the whole string, transport segment included');
  });

  // ---- errors -------------------------------------------------------------

  test('a hash mismatch is latched in view().error, not swallowed', () => {
    const { b, sa, sb } = mkPair();
    seat(sa, 'C', 'Rook');
    seat(sb, 'P', 'Vale');

    sa.commit('D'); // committed, so the next action is applied rather than held
    b.send('0P:A#dead'); // right turn, right colour, a state neither of us is in

    const first = sa.view().error;
    assert(first, 'a diverged timeline has to surface');
    eq(sa.view().turn, 0, 'and the turn does not resolve on it');

    b.send('!P~Vale@' + b.id); // unrelated traffic must not wipe the report
    eq(sa.view().error, first, 'the error is held, not flashed and lost');
    eq(sa.view().error, sa.view().error, 'and reads the same every time');
  });

  // ---- wire discipline ----------------------------------------------------

  test('nothing but actions and claims ever reaches the wire', () => {
    // Match.export() serialises the current turn's partial submissions, so a
    // session that broadcast one would hand the opponent this turn's move.
    const { Session, LoopbackChannel } = transport();
    const c = cfg({ w: 8, h: 2, cap: 8, seed: 'wire' });
    const ends = LoopbackChannel.pair();
    const a = ends[0], b = ends[1];
    const sentA = record(a), sentB = record(b);
    const sa = Session.open({ match: Match.fromConfig(c), channel: a, onChange: function () {} });
    const sb = Session.open({ match: Match.fromConfig(c), channel: b, onChange: function () {} });
    seat(sa, 'C', 'Rook');
    seat(sb, 'P', 'Vale');

    let guard = 0;
    while (!sa.view().over && guard++ < 100) {
      commitLegal(sa);
      commitLegal(sb);
    }
    assert(sa.view().over, 'the match should have reached the cap');
    eq(sa.view().hash, sb.view().hash, 'and the two sides still agree');

    const all = sentA.concat(sentB);
    assert(all.length >= 16, 'a capped match should have put every action on the wire, saw ' + all.length);
    for (const s of all) {
      assert(typeof s === 'string' && s.length, 'sent something that is not a string');
      assert(s.slice(0, 3) !== 'X1:', 'an export went on the wire: ' + s);
      if (s.charAt(0) === '!') continue;
      assert(/^[0-9]/.test(s), 'neither an action nor a claim: ' + s);
      assert(Wire.decodeAction(s).ok, 'unreadable action string: ' + s);
    }
    assert(all.some((s) => s.charAt(0) === '!'), 'the claims never went out');
  });

  // ---- paste fallback -----------------------------------------------------

  test('PasteChannel round-trips a string through the outbox', () => {
    const { Session, PasteChannel } = transport();
    const ch = new PasteChannel();
    const got = [];
    ch.onMessage = function (t) { got.push(t); };

    ch.send('0C:D#a3f2');
    // Assumed beyond the five-member Channel interface: send() appends to an
    // inspectable ch.outbox, and ch.receive(text) is the Apply path.
    eq(ch.outbox.length, 1, 'the string to copy out is waiting');
    eq(ch.outbox[0], '0C:D#a3f2');

    ch.receive('0P:A#a3f2');
    eq(got.length, 1, 'the pasted string arrived');
    eq(got[0], '0P:A#a3f2', 'unchanged');

    const s = Session.open({
      match: Match.fromConfig(cfg()), channel: new PasteChannel(), onChange: function () {},
    });
    seat(s, 'C', 'Rook');
    eq(s.view().status, 'manual', 'paste is manual, never live');
    eq(s.view().peers.length, 0, 'and has no peers to report');
    s.close();
  });

  return { results };
}
