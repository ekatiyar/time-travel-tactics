/* Transport tests for tbtt_prototype_turn_transport.html.
   Injected into the page by run_tests.py; not shipped in the HTML.

   These cover the TRANSPORT block only. The engine underneath is the time_travel
   prototype's, tested by that prototype's tests.js, which tests.include pulls in
   ahead of this file.

   Two-phase turns make receiving asynchronous — verifying a reveal means hashing,
   and crypto.subtle.digest is a promise — so runTests and every test body are
   async. run_tests.py evaluates runTests() and Playwright awaits what it returns,
   so the harness needs nothing added. */

async function runTests() {
  const results = [];
  const { Match, Wire } = window.TBTT;

  // ---- harness ------------------------------------------------------------

  async function test(name, fn) {
    try {
      await fn();
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

  // A channel still delivers synchronously, but the handler on the far end is
  // async and returns nothing a test can wait on, and one message sets off a
  // chain of them: a commitment lands, that completes the set, the reveal goes
  // out, the other side hashes it and submits. Every test that puts a string on
  // a wire and then reads a view settles first. Rounds of setTimeout drain the
  // whole chain, not just the microtasks queued so far.
  async function settle(rounds) {
    for (let i = 0; i < (rounds || 8); i++) await new Promise((r) => setTimeout(r, 0));
  }

  // ---- the wire format, rebuilt here --------------------------------------
  //
  // Built from the spec rather than read off a Session, so a test can hand a
  // client a commitment nobody issued, or open one with the wrong string.

  const NONCE_A = '0123456789abcdef0123456789abcdef';
  const NONCE_B = 'fedcba9876543210fedcba9876543210';

  const CLAIM_RE = /^!([CPTA])~([A-Za-z0-9_-]{1,12})@([A-Za-z0-9_-]{1,80})$/;
  const COMMITMENT_RE = /^#(\d{1,4})([CPTA]):([0-9a-f]{32})$/;
  const REVEAL_RE = /^(\d{1,4}[CPTA]:[WASDHI]#[0-9a-f]{4}(?:~[A-Za-z0-9_-]{1,12})?)\|([0-9a-f]{32})$/;

  function kindOf(s) {
    if (CLAIM_RE.test(s)) return 'claim';
    if (COMMITMENT_RE.test(s)) return 'commitment';
    if (REVEAL_RE.test(s)) return 'reveal';
    return 'unknown';
  }

  async function digestFor(turn, color, action, nonce) {
    const pre = new TextEncoder().encode(turn + ':' + color + ':' + action + ':' + nonce);
    const buf = await crypto.subtle.digest('SHA-256', pre);
    return Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, '0')).join('')
      .slice(0, 32); // the first 128 bits
  }

  // The two strings one colour puts on the wire for one action. The commitment
  // binds turn and colour, which is what stops it being replayed elsewhere; the
  // reveal is the engine's own action string with the nonce hung off the end.
  async function twoPhase(o) {
    const nonce = o.nonce || NONCE_A;
    const digest = await digestFor(o.turn, o.color, o.action, nonce);
    return {
      nonce: nonce,
      digest: digest,
      commitment: '#' + o.turn + o.color + ':' + digest,
      reveal: Wire.encodeAction({
        turn: o.turn, color: o.color, action: o.action, hash: o.hash, name: o.name
      }) + '|' + nonce
    };
  }

  // ---- fixtures -----------------------------------------------------------

  // Records every string handed to the channel. Wrap before Session.open.
  function record(ch) {
    const sent = [];
    const raw = ch.send.bind(ch);
    ch.send = function (text) { sent.push(text); return raw(text); };
    return sent;
  }

  // Two sessions on the two ends of one loopback channel, each with its own
  // Match built from the same config, and a record of what each end broadcast.
  function mkPair(over) {
    const { Session, LoopbackChannel } = transport();
    const c = cfg(over);
    const ends = LoopbackChannel.pair();
    const a = ends[0], b = ends[1];
    const sentA = record(a), sentB = record(b);
    const changes = { a: 0, b: 0 };
    const sa = Session.open({ match: Match.fromConfig(c), channel: a, onChange: function () { changes.a++; } });
    const sb = Session.open({ match: Match.fromConfig(c), channel: b, onChange: function () { changes.b++; } });
    return { a, b, sa, sb, changes, sentA, sentB };
  }

  // One session and a bare channel wired to it. The bare end is the opponent a
  // test writes by hand, so it can send strings in an order or a shape no honest
  // client would produce. heard is everything the session broadcast.
  function mkSolo(over) {
    const { Session, LoopbackChannel } = transport();
    const c = cfg(over);
    const a = LoopbackChannel.make(), peer = LoopbackChannel.make();
    const sa = Session.open({ match: Match.fromConfig(c), channel: a, onChange: function () {} });
    const heard = [];
    peer.onMessage = function (text) { heard.push(text); };
    LoopbackChannel.link(a, peer);
    return { a, peer, sa, heard };
  }

  function seat(s, color, name) {
    const r = s.claim(color, name);
    assert(r && r.ok, 'claim ' + color + ': ' + (r && r.error));
    return r;
  }
  function peerClaim(peer, color, name) {
    peer.send('!' + color + '~' + name + '@' + peer.id);
  }
  async function commitLegal(s) {
    const v = s.view();
    const opt = v.actions.filter((a) => a.reason === null)[0];
    assert(opt, 'no legal action for ' + v.me.color);
    const r = await s.commit(opt.action);
    assert(r && r.ok, 'commit ' + opt.action + ': ' + (r && r.error));
  }

  // ---- a turn over the wire -----------------------------------------------

  await test('two loopback sessions play a turn without anyone pasting a string', async () => {
    const { sa, sb, changes, sentA, sentB } = mkPair();
    seat(sa, 'C', 'Rook');
    seat(sb, 'P', 'Vale');
    eq(sa.view().me.color, 'C', 'the claim picks the seat the view renders');
    eq(sb.view().me.color, 'P');

    await sa.commit('D');
    await sb.commit('A');
    await settle();

    eq(sa.view().turn, 1, 'coral advanced');
    eq(sb.view().turn, 1, 'purple advanced');
    eq(sa.view().hash, sb.view().hash, 'and they agree on the state');
    eq(sa.view().me.x, 1, 'coral stepped right');
    eq(sb.view().me.x, 14, 'purple stepped left');
    assert(sa.view().bodies.some((bd) => bd.color === 'P' && bd.t === 1),
      "coral can see purple's t1 body");
    eq(sa.view().status, 'live', 'a wired pair reports live');
    assert(!sa.view().error, 'no error: ' + sa.view().error);
    assert(changes.a > 0 && changes.b > 0, 'onChange fired on both sides');

    // One turn costs each side a commitment and then a reveal, in that order,
    // and nothing else goes out at all.
    for (const sent of [sentA, sentB]) {
      const kinds = sent.map(kindOf);
      eq(kinds.join(','), 'claim,commitment,reveal', 'the whole turn on one wire: ' + sent.join(' '));
    }
  });

  await test('commit is a promise now, because it has to hash before it can send', async () => {
    const { sa } = mkPair();
    seat(sa, 'C', 'Rook');

    const pending = sa.commit('D');
    assert(pending && typeof pending.then === 'function',
      'commit must return a promise: crypto.subtle.digest is one and it is in the way');
    const r = await pending;
    assert(r && r.ok, 'and it still resolves to the usual {ok, error}: ' + (r && r.error));

    // Locally the action is submitted straight away, so the screen has something
    // to draw while the opponent is still deciding.
    eq(sa.view().myAction,
      Wire.encodeAction({ turn: 0, color: 'C', action: 'D', hash: sa.view().hash, name: 'Rook' }),
      'the view still carries your own action string');
    const again = await sa.commit('D');
    assert(again && !again.ok, 'and a second commit for the same turn is still refused');
  });

  await test('changing your mind before the other player commits reaches them', async () => {
    // The bug two-phase exists for. Under one phase the first action is already
    // on the wire and already applied on the far side, so the withdrawal is
    // invisible there and the two matches fork on the next hash without saying so.
    const { sa, sb } = mkPair();
    seat(sa, 'C', 'Rook');
    seat(sb, 'P', 'Vale');

    await sa.commit('D');
    const w = sa.withdraw();
    assert(typeof w.then !== 'function', 'withdraw hashes nothing, so it stays synchronous');
    assert(w && w.ok, 'purple has not committed, so the action is still yours to take back: ' + (w && w.error));
    eq(sa.view().myAction, null, 'and it is gone locally');
    await sa.commit('H');

    await sb.commit('A');
    await settle();

    eq(sa.view().turn, 1, 'the turn resolved');
    eq(sb.view().turn, 1);
    eq(sa.view().hash, sb.view().hash, 'on one state, not two');
    eq(sa.view().me.x, 0, 'coral held, which was the second action');
    eq(sa.view().me.t, 1);
    assert(sb.view().bodies.some((bd) => bd.color === 'C' && bd.t === 1 && bd.x === 0),
      'and purple saw the second action, not the first');
    assert(!sa.view().error, 'no error: ' + sa.view().error);
    assert(!sb.view().error, 'none on the far side either: ' + sb.view().error);
    assert(!sb.view().notice, 'and nothing for purple to act on: ' + sb.view().notice);
  });

  await test('the second player to commit gets no window to change their mind', async () => {
    const { sa, sb, sentB } = mkPair();
    seat(sa, 'C', 'Rook');
    seat(sb, 'P', 'Vale');

    await sa.commit('D');
    await settle();
    const before = sentB.length;
    await sb.commit('A');
    await settle();

    // Purple committing completes the set, so purple's own reveal leaves in the
    // same breath. There is no moment in between for a withdrawal to happen in.
    const fresh = sentB.slice(before);
    assert(fresh.some((s) => kindOf(s) === 'commitment'), 'purple published a commitment: ' + fresh.join(' '));
    assert(fresh.some((s) => kindOf(s) === 'reveal'), 'and opened it immediately: ' + fresh.join(' '));
    eq(sb.view().turn, 1, 'the turn is already resolved');
    const w = sb.withdraw();
    assert(w && !w.ok, 'so there is nothing left to take back');
    eq(sa.view().hash, sb.view().hash);
  });

  await test('a commitment is still reported: waiting shows the other colour is in', async () => {
    const { sa, sb } = mkPair();
    seat(sa, 'C', 'Rook');
    seat(sb, 'P', 'Vale');
    assert(sa.view().waiting.indexOf('P') >= 0, 'purple is owed before it commits');

    await sb.commit('A');
    await settle();

    // waiting is who you are still owed something by. Under two phases the thing
    // you are owed is a commitment, and the moment it lands you have lost the
    // right to change your action — so the strip has to say purple is in, even
    // though purple's move is still sealed and the match has not seen it.
    assert(sa.view().waiting.indexOf('P') < 0, 'purple is in and should not still be waited on');
    assert(sa.view().waiting.indexOf('C') < 0, 'you are never waiting on yourself');
    eq(sa.view().waiting.length, 0, 'everyone else is in, coral is just deciding');
    eq(sa.view().turn, 0, 'and still nothing has resolved');
  });

  // ---- commitments and reveals --------------------------------------------

  await test('a commitment on its own moves nothing', async () => {
    const { peer, sa, heard } = mkSolo();
    seat(sa, 'C', 'Rook');
    peerClaim(peer, 'P', 'Vale');

    const p = await twoPhase({ turn: 0, color: 'P', action: 'A', hash: sa.view().hash });
    peer.send(p.commitment);
    await settle();

    eq(sa.view().turn, 0, 'a commitment discloses nothing, so it decides nothing');
    assert(sa.view().pending.indexOf('P') >= 0, 'and nothing was submitted for purple');
    eq(sa.view().me.t, 0, 'coral has not travelled');
    assert(!sa.view().error, 'an unopened commitment is not an error: ' + sa.view().error);
    assert(!sa.view().notice, 'nor a notice: ' + sa.view().notice);
    assert(heard.every((s) => kindOf(s) !== 'reveal'), 'coral has not committed, so it cannot have revealed');

    // It was kept, though. Coral's own commit completes the set and the reveal
    // goes on the spot, with nobody asking for it.
    await sa.commit('D');
    await settle();
    eq(heard.filter((s) => kindOf(s) === 'reveal').length, 1,
      'the reveal goes the instant the last commitment is in: ' + heard.join(' '));
    eq(sa.view().turn, 0, 'purple still has to open its own');
  });

  await test('a reveal that opens no commitment is dropped in silence', async () => {
    const { peer, sa } = mkSolo();
    seat(sa, 'C', 'Rook');
    peerClaim(peer, 'P', 'Vale');
    await sa.commit('D');
    await settle();

    const hash = sa.view().hash;
    const sealed = await twoPhase({ turn: 0, color: 'P', action: 'A', hash, nonce: NONCE_A });
    const forged = await twoPhase({ turn: 0, color: 'P', action: 'H', hash, nonce: NONCE_A });

    peer.send(sealed.commitment);
    peer.send(forged.reveal); // the sealed nonce, a different action: it opens nothing
    await settle();

    eq(sa.view().turn, 0, 'a reveal its commitment does not open must not resolve the turn');
    assert(sa.view().pending.indexOf('P') >= 0, 'and must not be submitted');
    assert(!sa.view().error, 'this is malformed input, not divergence: ' + sa.view().error);
    assert(!sa.view().notice, 'and nothing the player can do anything about: ' + sa.view().notice);

    peer.send(sealed.reveal);
    await settle();
    eq(sa.view().turn, 1, 'the reveal that does open it is still accepted');
    assert(sa.view().bodies.some((bd) => bd.color === 'P' && bd.t === 1 && bd.x === 14),
      'and the action that ran is the sealed one, not the forged one');
  });

  await test('a commitment cannot be replayed into another turn', async () => {
    const { peer, sa } = mkSolo();
    seat(sa, 'C', 'Rook');
    peerClaim(peer, 'P', 'Vale');

    const t0 = await twoPhase({ turn: 0, color: 'P', action: 'A', hash: sa.view().hash });
    peer.send(t0.commitment);
    await sa.commit('D');
    peer.send(t0.reveal);
    await settle();
    eq(sa.view().turn, 1, 'turn 0 played normally');

    // The same digest, relabelled for turn 1. The turn is in the preimage, so
    // the matching reveal for turn 1 hashes to something else entirely.
    peer.send('#1P:' + t0.digest);
    const replay = await twoPhase({ turn: 1, color: 'P', action: 'A', hash: sa.view().hash, nonce: t0.nonce });
    peer.send(replay.reveal);
    await sa.commit('D');
    await settle();

    eq(sa.view().turn, 1, 'a commitment lifted from another turn opens nothing');
    assert(sa.view().pending.indexOf('P') >= 0, 'purple is still owed turn 1');
    assert(!sa.view().error, 'a replay is noise, not divergence: ' + sa.view().error);

    const t1 = await twoPhase({ turn: 1, color: 'P', action: 'A', hash: sa.view().hash });
    peer.send(t1.commitment);
    peer.send(t1.reveal);
    await settle();
    eq(sa.view().turn, 2, "and purple's real commitment for turn 1 still works");
  });

  await test('extra commitments for one turn are harmless: the opened one counts', async () => {
    const { peer, sa } = mkSolo();
    seat(sa, 'C', 'Rook');
    peerClaim(peer, 'P', 'Vale');

    const hash = sa.view().hash;
    const first = await twoPhase({ turn: 0, color: 'P', action: 'A', hash, nonce: NONCE_A });
    const second = await twoPhase({ turn: 0, color: 'P', action: 'H', hash, nonce: NONCE_B });

    // Purple changed its mind and published again. A commitment tells nobody
    // anything, so publishing three costs nobody anything either.
    peer.send(first.commitment);
    peer.send(second.commitment);
    peer.send(first.commitment);
    await settle();
    eq(sa.view().turn, 0, 'still nothing to act on');

    await sa.commit('D');
    peer.send(second.reveal);
    await settle();

    eq(sa.view().turn, 1, 'the turn resolves on whichever one purple opened');
    assert(sa.view().bodies.some((bd) => bd.color === 'P' && bd.t === 1 && bd.x === 15),
      'purple held, which is the commitment it opened, not the first one it sent');
    assert(!sa.view().error, 'no error: ' + sa.view().error);
  });

  // ---- arrival order ------------------------------------------------------

  await test('a reveal that arrives before the commitment it opens still lands', async () => {
    const { peer, sa } = mkSolo();
    seat(sa, 'C', 'Rook');
    peerClaim(peer, 'P', 'Vale');

    const p = await twoPhase({ turn: 0, color: 'P', action: 'A', hash: sa.view().hash });
    peer.send(p.reveal); // nothing has been published that opens this yet
    await settle();
    eq(sa.view().turn, 0, 'an unopened reveal decides nothing on its own');
    assert(!sa.view().error, 'and waiting for its commitment is not an error: ' + sa.view().error);

    peer.send(p.commitment);
    await sa.commit('D');
    await settle();

    eq(sa.view().turn, 1, 'the commitment arriving late completes the pair');
    assert(sa.view().bodies.some((bd) => bd.color === 'P' && bd.t === 1 && bd.x === 14),
      'and the move that ran is the one that was sealed');
  });

  await test('duplicate commitments and duplicate reveals are harmless', async () => {
    const { peer, sa } = mkSolo();
    seat(sa, 'C', 'Rook');
    peerClaim(peer, 'P', 'Vale');

    const p = await twoPhase({ turn: 0, color: 'P', action: 'A', hash: sa.view().hash });
    peer.send(p.commitment);
    peer.send(p.commitment);
    await settle();
    peer.send(p.reveal);
    peer.send(p.reveal);
    await settle();
    eq(sa.view().turn, 0, 'coral has not committed, so nothing has resolved');
    assert(!sa.view().error, 'a repeat before coral commits: ' + sa.view().error);

    await sa.commit('D');
    await settle();
    eq(sa.view().turn, 1, 'the turn resolved exactly once');
    const hash = sa.view().hash;

    peer.send(p.commitment); // and once more, after they have both been used
    peer.send(p.reveal);
    await settle();
    eq(sa.view().turn, 1, 'a late repeat changes nothing');
    eq(sa.view().hash, hash);
    assert(!sa.view().error, 'a repeat after the turn resolved: ' + sa.view().error);
  });

  await test('a commitment for the next turn can arrive during this one', async () => {
    const { peer, sa } = mkSolo();
    seat(sa, 'C', 'Rook');
    peerClaim(peer, 'P', 'Vale');

    const t0 = await twoPhase({ turn: 0, color: 'P', action: 'A', hash: sa.view().hash, nonce: NONCE_A });
    const earlyCommitment = '#1P:' + await digestFor(1, 'P', 'A', NONCE_B);

    peer.send(earlyCommitment); // a whole turn ahead of everyone
    peer.send(t0.commitment);
    await sa.commit('D');
    await settle();
    eq(sa.view().turn, 0, 'turn 0 still needs purple to open');

    peer.send(t0.reveal);
    await settle();
    eq(sa.view().turn, 1, 'and now it resolves');

    const t1 = await twoPhase({ turn: 1, color: 'P', action: 'A', hash: sa.view().hash, nonce: NONCE_B });
    peer.send(t1.reveal); // opens the commitment that turned up a turn early
    await sa.commit('D');
    await settle();
    eq(sa.view().turn, 2, 'the early commitment was kept and still opened');
    assert(!sa.view().error, 'no error: ' + sa.view().error);
  });

  // ---- claims -------------------------------------------------------------

  await test('two clients claiming one colour: the lower client id keeps it', async () => {
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

  await test('claims() tells the colour picker what to grey out', async () => {
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

  await test('a peer that appears late is sent the claim and the current-turn commitment', async () => {
    const { Session, LoopbackChannel } = transport();
    const c = cfg();
    // pair() wires both ends up front, so nobody is ever new. Built one end at a
    // time instead, and linked once the second is open: the status report that
    // link() emits is the entire trigger.
    const a = LoopbackChannel.make('lateA');
    const sentA = record(a);
    const sa = Session.open({ match: Match.fromConfig(c), channel: a, onChange: function () {} });
    seat(sa, 'C', 'Rook');
    await sa.commit('D'); // into an empty room
    await settle();
    const before = sentA.length;

    const b = LoopbackChannel.make('lateB');
    const sb = Session.open({ match: Match.fromConfig(c), channel: b, onChange: function () {} });
    LoopbackChannel.link(a, b);
    await settle();

    const announced = sentA.slice(before);
    assert(announced.some((s) => kindOf(s) === 'claim'), 'the joiner should have been told coral is taken');
    assert(announced.some((s) => kindOf(s) === 'commitment'),
      "and given coral's commitment for the turn in progress: " + announced.join(' '));
    assert(announced.every((s) => kindOf(s) !== 'reveal'),
      'but not a reveal — purple has not committed, so coral has nothing to open yet');
    eq(sb.claims().C.clientId, a.id);
    eq(sb.claims().C.name, 'Rook');

    seat(sb, 'P', 'Vale');
    await sb.commit('A');
    await settle();
    eq(sb.view().turn, 1, 'the joiner caught up and the turn resolved');
    eq(sa.view().turn, 1);
    eq(sa.view().hash, sb.view().hash);
    eq(sa.view().names.C, 'Rook', 'claiming seats the name in the Match, not only in the claim');
    eq(sb.view().names.C, 'Rook', 'and the joiner ends up with it too');
  });

  await test('a peer that appears after you have revealed is sent the reveal too', async () => {
    // Coral has committed, purple's commitment is already in, so coral has opened
    // and is only waiting for purple to do the same. A client arriving now needs
    // all three strings: given only the commitment it would sit forever on a turn
    // everyone else has finished with.
    const { Session, LoopbackChannel } = transport();
    const c = cfg();
    const a = LoopbackChannel.make('midA');
    const sentA = record(a);
    const sa = Session.open({ match: Match.fromConfig(c), channel: a, onChange: function () {} });
    const peer = LoopbackChannel.make('midP');
    LoopbackChannel.link(a, peer);
    seat(sa, 'C', 'Rook');

    const p = await twoPhase({ turn: 0, color: 'P', action: 'A', hash: sa.view().hash });
    await sa.commit('D');
    peer.send(p.commitment);
    await settle();
    eq(sa.view().turn, 0, 'purple has committed but not opened');

    const before = sentA.length;
    LoopbackChannel.link(a, LoopbackChannel.make('midL'));
    await settle();

    const announced = sentA.slice(before);
    eq(announced.filter((s) => kindOf(s) === 'claim').length, 1, 'the claim: ' + announced.join(' '));
    eq(announced.filter((s) => kindOf(s) === 'commitment').length, 1, 'the commitment: ' + announced.join(' '));
    eq(announced.filter((s) => kindOf(s) === 'reveal').length, 1,
      'and the reveal coral has already published: ' + announced.join(' '));
    eq(announced.length, 3, 'and nothing else: ' + announced.join(' '));
  });

  // ---- match code ---------------------------------------------------------

  await test('the same code string gives the same room id, a different one does not', async () => {
    const { Code } = transport();
    const s1 = Wire.encodeMatchCode(cfg({ seed: 'aaa' }));
    const s2 = Wire.encodeMatchCode(cfg({ seed: 'aaa' }));
    const s3 = Wire.encodeMatchCode(cfg({ seed: 'bbb' }));
    eq(s1, 'M1:16x9:0:aaa:40:CP', 'a match code is the engine\'s own six segments, nothing appended');

    const id = Code.roomId(s1);
    assert(typeof id === 'string' && id.length, 'a room id is a non-empty string');
    eq(Code.roomId(s2), id, 'the same code has to find the same room');
    assert(Code.roomId(s3) !== id, 'a different seed is a different room');
    eq(Code.roomId(' ' + s1 + '\n'), id, 'stray whitespace must not split the room');
  });

  // ---- errors -------------------------------------------------------------

  await test('a hash mismatch is latched in view().error, not swallowed', async () => {
    const { peer, sa } = mkSolo();
    seat(sa, 'C', 'Rook');
    peerClaim(peer, 'P', 'Vale');
    await sa.commit('D'); // committed, so an opened reveal is applied rather than held
    await settle();

    // Properly sealed, properly opened, and for a state neither of us is in.
    // Commit-reveal decides when an action becomes visible and nothing more; the
    // state hash is still the only thing that catches a fork, so it still has to.
    const p = await twoPhase({ turn: 0, color: 'P', action: 'A', hash: 'dead' });
    peer.send(p.commitment);
    peer.send(p.reveal);
    await settle();

    const first = sa.view().error;
    assert(first, 'a diverged timeline has to surface');
    eq(sa.view().turn, 0, 'and the turn does not resolve on it');

    peer.send('!P~Vale@' + peer.id); // unrelated traffic must not wipe the report
    await settle();
    eq(sa.view().error, first, 'the error is held, not flashed and lost');
  });

  // ---- wire discipline ----------------------------------------------------

  await test('nothing but claims, commitments and reveals ever reaches the wire', async () => {
    // Match.export() serialises the current turn's partial submissions, so a
    // session that broadcast one would hand the opponent this turn's move. A bare
    // action string is now the same kind of leak: an action only travels inside a
    // reveal, and a reveal only goes once every commitment for the turn is in.
    const { sa, sb, sentA, sentB } = mkPair({ w: 8, h: 2, cap: 8, seed: 'wire' });
    seat(sa, 'C', 'Rook');
    seat(sb, 'P', 'Vale');

    let guard = 0;
    while (!sa.view().over && guard++ < 100) {
      await commitLegal(sa);
      await commitLegal(sb);
      await settle();
    }
    assert(sa.view().over, 'the match should have reached the cap');
    eq(sa.view().hash, sb.view().hash, 'and the two sides still agree');

    const all = sentA.concat(sentB);
    for (const s of all) {
      assert(typeof s === 'string' && s.length, 'sent something that is not a string');
      assert(s.slice(0, 3) !== 'X1:', 'an export went on the wire: ' + s);
      const kind = kindOf(s);
      assert(kind !== 'unknown', 'neither a claim, a commitment nor a reveal: ' + s);
      if (kind === 'reveal') {
        assert(Wire.decodeAction(REVEAL_RE.exec(s)[1]).ok, 'unreadable action inside a reveal: ' + s);
      }
    }
    eq(all.filter((s) => kindOf(s) === 'claim').length, 2, 'both claims went out');
    eq(all.filter((s) => kindOf(s) === 'commitment').length, 16, 'one commitment per colour per turn');
    eq(all.filter((s) => kindOf(s) === 'reveal').length, 16, 'and one reveal per colour per turn');
  });

  return { results };
}
