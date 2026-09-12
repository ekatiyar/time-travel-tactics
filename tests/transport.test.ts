/* Transport tests: a Session over a loopback channel, the two-phase turn it
   plays, and the three strings that carry it.

   The engine underneath has its own suite. PeerChannel is not covered here. It
   needs a network, and nothing in this file touches one. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { Session, Code, trimUnresolved, LoopbackChannel } from '../play/src/transport.js';
import { Match, Wire, metaTurn } from '../play/src/engine.js';
import type { Action, Color, Config } from '../play/src/engine.js';
import type { Channel, LoopbackEnd } from '../play/src/transport.js';

// ---- the seam -------------------------------------------------------------

function makeEnd(id?: string): LoopbackEnd {
  return LoopbackChannel.make(id);
}
function makePair(): [LoopbackEnd, LoopbackEnd] {
  return LoopbackChannel.pair();
}

type Sess = ReturnType<typeof Session.open>;

/** assert.match, where the value is allowed to be null and null is a failure. */
function matches(actual: string | null, re: RegExp, message?: string): void {
  assert.ok(actual !== null, message ?? 'expected text matching ' + re + ', got null');
  assert.match(actual, re, message);
}

// ---- the wire format, rebuilt here ----------------------------------------
//
// Built from the spec rather than read off a Session, so a test can hand a
// client a commitment nobody issued, or open one with the wrong string.

const CLAIM_RE = /^!([CPTA])~([A-Za-z0-9_-]{1,12})@([A-Za-z0-9_-]{1,80})$/;
const COMMITMENT_RE = /^#(\d{1,4})([CPTA]):([0-9a-f]{32})$/;
const REVEAL_RE = /^(\d{1,4}[CPTA]:[WASDHI]#[0-9a-f]{4}(?:~[A-Za-z0-9_-]{1,12})?)\|([0-9a-f]{32})$/;

const NONCE_A = '0123456789abcdef0123456789abcdef';
const NONCE_B = 'fedcba9876543210fedcba9876543210';
const JUNK_DIGEST = 'ffffffffffffffffffffffffffffffff';

type Kind = 'claim' | 'commitment' | 'reveal' | 'unknown';

function kindOf(s: string): Kind {
  if (CLAIM_RE.test(s)) return 'claim';
  if (COMMITMENT_RE.test(s)) return 'commitment';
  if (REVEAL_RE.test(s)) return 'reveal';
  return 'unknown';
}

async function digestFor(turn: number, color: string, action: string, nonce: string): Promise<string> {
  const pre = new TextEncoder().encode(turn + ':' + color + ':' + action + ':' + nonce);
  const buf = await crypto.subtle.digest('SHA-256', pre);
  return Array.from(new Uint8Array(buf, 0, 16))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

interface Sealed {
  nonce: string;
  digest: string;
  commitment: string;
  reveal: string;
}

// The two strings one colour puts on the wire for one action. The commitment
// binds turn and colour, which is what stops it being replayed elsewhere; the
// reveal is the engine's own action string with the nonce hung off the end.
async function twoPhase(o: {
  turn: number;
  color: Color;
  action: Action;
  hash: string;
  nonce?: string;
  name?: string;
}): Promise<Sealed> {
  const nonce = o.nonce || NONCE_A;
  const digest = await digestFor(o.turn, o.color, o.action, nonce);
  return {
    nonce,
    digest,
    commitment: '#' + o.turn + o.color + ':' + digest,
    reveal: Wire.encodeAction({
      turn: metaTurn(o.turn), color: o.color, action: o.action, hash: o.hash, name: o.name
    }) + '|' + nonce
  };
}

// ---- fixtures -------------------------------------------------------------

const CONFIG: Config = { w: 16, h: 9, wallPct: 0, seed: 'test', cap: 40, roster: ['C', 'P'] };

function cfg(over?: Partial<typeof CONFIG>) {
  return { ...CONFIG, ...over };
}

// A channel delivers synchronously, but the handler on the far end is async and
// returns nothing a test can wait on, and one message sets off a chain of them.
// A commitment lands, that completes the set, the reveal goes out, the other
// side hashes it and submits. Rounds of setTimeout drain the whole chain, not
// just the microtasks queued so far.
async function settle(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
}

// Records every string handed to the channel. Wrap before Session.open.
function record(ch: LoopbackEnd): string[] {
  const sent: string[] = [];
  const raw = ch.send.bind(ch);
  ch.send = (text) => { sent.push(text); raw(text); };
  return sent;
}

// One session on one end of an unwired channel. Linking it to anything is the
// test's own business, which is what lets a test bring a peer in late.
function mkLone(id?: string, over?: Partial<typeof CONFIG>) {
  const ch = makeEnd(id);
  const sent = record(ch);
  const s = Session.open({ match: Match.fromConfig(cfg(over)), channel: ch, onChange: () => {} });
  return { ch, s, sent };
}

// Two sessions on the two ends of one loopback channel, each with its own Match
// built from the same config, and a record of what each end broadcast.
function mkPair(over?: Partial<typeof CONFIG>) {
  const [a, b] = makePair();
  const sentA = record(a), sentB = record(b);
  const changes = { a: 0, b: 0 };
  const c = cfg(over);
  const sa = Session.open({ match: Match.fromConfig(c), channel: a, onChange: () => { changes.a++; } });
  const sb = Session.open({ match: Match.fromConfig(c), channel: b, onChange: () => { changes.b++; } });
  return { a, b, sa, sb, changes, sentA, sentB };
}

// One session and a bare channel wired to it. The bare end is the opponent a
// test writes by hand, so it can send strings in an order or a shape no honest
// client would produce. heard is everything the session broadcast.
function mkSolo(over?: Partial<typeof CONFIG>) {
  const { ch: a, s: sa, sent } = mkLone(undefined, over);
  const peer = makeEnd();
  const heard: string[] = [];
  peer.onMessage = (text) => { heard.push(text); };
  LoopbackChannel.link(a, peer);
  return { a, peer, sa, heard, sent };
}

function seat(s: Sess, color: string, name: string): void {
  const r = s.claim(color, name);
  assert.ok(r.ok, 'claim ' + color + ': ' + r.error);
}

function peerClaim(peer: Channel, color: string, name: string): void {
  peer.send('!' + color + '~' + name + '@' + peer.id);
}

async function commitLegal(s: Sess): Promise<void> {
  const v = s.view();
  const opt = v.actions.filter((a) => a.reason === null)[0];
  assert.ok(opt, 'no legal action for ' + v.me.color);
  const r = await s.commit(opt.action);
  assert.ok(r.ok, 'commit ' + opt.action + ': ' + r.error);
}

function decoded(str: string) {
  const d = Wire.decodeExport(str);
  assert.ok(d.ok, 'export should decode: ' + str);
  assert.ok(d.value);
  return d.value;
}

function imported(str: string) {
  const r = Match.fromExport(str);
  assert.ok(r.ok, 'export should load: ' + str);
  assert.ok(r.value);
  return r.value;
}

// ---- a turn over the wire -------------------------------------------------

describe('a turn over a loopback pair', () => {
  it('plays without anyone pasting a string', async () => {
    const { sa, sb, changes, sentA, sentB } = mkPair();
    seat(sa, 'C', 'Rook');
    seat(sb, 'P', 'Vale');
    assert.equal(sa.view().me.color, 'C', 'the claim picks the seat the view renders');
    assert.equal(sb.view().me.color, 'P');

    await sa.commit('D');
    await sb.commit('A');
    await settle();

    assert.equal(sa.view().turn, 1, 'coral advanced');
    assert.equal(sb.view().turn, 1, 'purple advanced');
    assert.equal(sa.view().hash, sb.view().hash, 'and they agree on the state');
    assert.equal(sa.view().me.x, 1, 'coral stepped right');
    assert.equal(sb.view().me.x, 14, 'purple stepped left');
    assert.ok(sa.view().bodies.some((b) => b.color === 'P' && b.t === 1),
      "coral can see purple's t1 body");
    assert.equal(sa.view().status, 'live', 'a wired pair reports live');
    assert.equal(sa.view().error, null);
    assert.ok(changes.a > 0 && changes.b > 0, 'onChange fired on both sides');

    // One turn costs each side a commitment and then a reveal, in that order,
    // and nothing else goes out at all.
    assert.deepEqual(sentA.map(kindOf), ['claim', 'commitment', 'reveal'], sentA.join(' '));
    assert.deepEqual(sentB.map(kindOf), ['claim', 'commitment', 'reveal'], sentB.join(' '));
  });

  it('returns a promise from commit, because the digest is one', async () => {
    const { sa } = mkPair();
    seat(sa, 'C', 'Rook');

    const pending = sa.commit('D');
    assert.ok(pending instanceof Promise,
      'crypto.subtle.digest is a promise and it is in the way');
    const r = await pending;
    assert.deepEqual(r, { ok: true, error: null }, 'and it still resolves to the usual result');
  });

  it('submits your own action locally while the opponent is still deciding', async () => {
    const { sa } = mkPair();
    seat(sa, 'C', 'Rook');
    await sa.commit('D');

    assert.equal(sa.view().myAction,
      Wire.encodeAction({ turn: metaTurn(0), color: 'C', action: 'D', hash: sa.view().hash, name: 'Rook' }),
      'the view carries your own action string, so the screen has something to draw');
    const again = await sa.commit('D');
    assert.equal(again.ok, false, 'a second commit for the same turn is refused');
  });

  it('refuses commit and withdraw before a colour is claimed', async () => {
    const { sa } = mkPair();
    assert.deepEqual(await sa.commit('D'), { ok: false, error: 'pick a colour first' });
    assert.deepEqual(sa.withdraw(), { ok: false, error: 'pick a colour first' });
    assert.equal(sa.color(), null);
  });

  it('lets the first to commit change their mind, and the change reaches the far side', async () => {
    // Two phases exist so this withdrawal is not too late. Under one phase the
    // action would already be applied on the far side, and the fork would go
    // unannounced until the next hash.
    const { sa, sb } = mkPair();
    seat(sa, 'C', 'Rook');
    seat(sb, 'P', 'Vale');

    await sa.commit('D');
    const w = sa.withdraw();
    assert.ok(!(w instanceof Promise), 'withdraw hashes nothing, so it stays synchronous');
    assert.ok(w.ok, 'purple has not committed, so the action is still yours to take back: ' + w.error);
    assert.equal(sa.view().myAction, null, 'and it is gone locally');
    await sa.commit('H');

    await sb.commit('A');
    await settle();

    assert.equal(sa.view().turn, 1, 'the turn resolved');
    assert.equal(sb.view().turn, 1);
    assert.equal(sa.view().hash, sb.view().hash, 'on one state, not two');
    assert.equal(sa.view().me.x, 0, 'coral held, which was the second action');
    assert.equal(sa.view().me.t, 1);
    assert.ok(sb.view().bodies.some((b) => b.color === 'C' && b.t === 1 && b.x === 0),
      'and purple saw the second action, not the first');
    assert.equal(sa.view().error, null);
    assert.equal(sb.view().error, null);
    assert.equal(sb.view().notice, null, 'nothing for purple to act on');
  });

  it('gives the second to commit no window to change their mind', async () => {
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
    assert.deepEqual(fresh.map(kindOf), ['commitment', 'reveal'], fresh.join(' '));
    assert.equal(sb.view().turn, 1, 'the turn is already resolved');
    assert.equal(sb.withdraw().ok, false, 'so there is nothing left to take back');
    assert.equal(sa.view().hash, sb.view().hash);
  });

  it('reports canChange for as long as the reveal has not gone out', async () => {
    const { sa, sb } = mkPair();
    seat(sa, 'C', 'Rook');
    seat(sb, 'P', 'Vale');
    assert.equal(sa.view().canChange, false, 'nothing to change before you commit');

    await sa.commit('D');
    await settle();
    assert.equal(sa.view().canChange, true, 'purple is not in yet, so the action is still yours');

    await sb.commit('A');
    await settle();
    assert.equal(sa.view().canChange, false, 'the turn resolved, so there is nothing to change');
  });

  it('stops waiting on a colour the moment its commitment lands', async () => {
    const { sa, sb } = mkPair();
    seat(sa, 'C', 'Rook');
    seat(sb, 'P', 'Vale');
    assert.deepEqual(sa.view().waiting, ['P'], 'purple is owed before it commits');

    await sb.commit('A');
    await settle();

    // A commitment counts as in, one phase before a submission does.
    assert.deepEqual(sa.view().waiting, [], 'everyone else is in, coral is just deciding');
    assert.equal(sa.view().turn, 0, 'and still nothing has resolved');
  });
});

// ---- commitments ----------------------------------------------------------

describe('commitments', () => {
  it('move nothing on their own', async () => {
    const { peer, sa, heard } = mkSolo();
    seat(sa, 'C', 'Rook');
    peerClaim(peer, 'P', 'Vale');

    const p = await twoPhase({ turn: 0, color: 'P', action: 'A', hash: sa.view().hash });
    peer.send(p.commitment);
    await settle();

    assert.equal(sa.view().turn, 0, 'a commitment discloses nothing, so it decides nothing');
    assert.ok(sa.view().pending.includes('P'), 'and nothing was submitted for purple');
    assert.equal(sa.view().me.t, 0, 'coral has not travelled');
    assert.equal(sa.view().error, null, 'an unopened commitment is not an error');
    assert.equal(sa.view().notice, null);
    assert.ok(heard.every((s) => kindOf(s) !== 'reveal'),
      'coral has not committed, so it cannot have revealed');
  });

  it('trigger the reveal the instant the last one is in', async () => {
    const { peer, sa, heard } = mkSolo();
    seat(sa, 'C', 'Rook');
    peerClaim(peer, 'P', 'Vale');

    const p = await twoPhase({ turn: 0, color: 'P', action: 'A', hash: sa.view().hash });
    peer.send(p.commitment);
    await settle();
    await sa.commit('D');
    await settle();

    assert.equal(heard.filter((s) => kindOf(s) === 'reveal').length, 1,
      'nobody asked for it: ' + heard.join(' '));
    assert.equal(sa.view().turn, 0, 'purple still has to open its own');
  });

  it('are ignored for the colour we hold, so nobody else can make us reveal', async () => {
    const { peer, sa, heard } = mkSolo();
    seat(sa, 'C', 'Rook');
    peerClaim(peer, 'P', 'Vale');
    await sa.commit('D');
    await settle();

    peer.send('#0C:' + JUNK_DIGEST);
    await settle();
    assert.ok(heard.every((s) => kindOf(s) !== 'reveal'),
      'a forged commitment for coral must not complete the set: ' + heard.join(' '));

    const p = await twoPhase({ turn: 0, color: 'P', action: 'A', hash: sa.view().hash });
    peer.send(p.commitment);
    await settle();
    assert.equal(heard.filter((s) => kindOf(s) === 'reveal').length, 1,
      "purple's own commitment is what opens it");
  });

  it('cannot be replayed into another turn', async () => {
    const { peer, sa } = mkSolo();
    seat(sa, 'C', 'Rook');
    peerClaim(peer, 'P', 'Vale');

    const t0 = await twoPhase({ turn: 0, color: 'P', action: 'A', hash: sa.view().hash });
    peer.send(t0.commitment);
    await sa.commit('D');
    peer.send(t0.reveal);
    await settle();
    assert.equal(sa.view().turn, 1, 'turn 0 played normally');

    // The same digest, relabelled for turn 1. The turn is in the preimage, so
    // the matching reveal for turn 1 hashes to something else entirely.
    peer.send('#1P:' + t0.digest);
    const replay = await twoPhase({ turn: 1, color: 'P', action: 'A', hash: sa.view().hash, nonce: t0.nonce });
    peer.send(replay.reveal);
    await sa.commit('D');
    await settle();

    assert.equal(sa.view().turn, 1, 'a commitment lifted from another turn opens nothing');
    assert.ok(sa.view().pending.includes('P'), 'purple is still owed turn 1');
    assert.equal(sa.view().error, null, 'a replay is noise, not divergence');

    const t1 = await twoPhase({ turn: 1, color: 'P', action: 'A', hash: sa.view().hash });
    peer.send(t1.commitment);
    peer.send(t1.reveal);
    await settle();
    assert.equal(sa.view().turn, 2, "and purple's real commitment for turn 1 still works");
  });

  it('may be published several times for one turn, and the opened one counts', async () => {
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
    assert.equal(sa.view().turn, 0, 'still nothing to act on');

    await sa.commit('D');
    peer.send(second.reveal);
    await settle();

    assert.equal(sa.view().turn, 1, 'the turn resolves on whichever one purple opened');
    assert.ok(sa.view().bodies.some((b) => b.color === 'P' && b.t === 1 && b.x === 15),
      'purple held, which is the commitment it opened, not the first one it sent');
    assert.equal(sa.view().error, null);
  });
});

// ---- reveals --------------------------------------------------------------

describe('reveals', () => {
  it('are dropped when they open no commitment', async () => {
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

    assert.equal(sa.view().turn, 0, 'a reveal its commitment does not open must not resolve the turn');
    assert.ok(sa.view().pending.includes('P'), 'and must not be submitted');
    assert.equal(sa.view().error, null, 'this is malformed input, not divergence');
    assert.equal(sa.view().notice, null);

    peer.send(sealed.reveal);
    await settle();
    assert.equal(sa.view().turn, 1, 'the reveal that does open it is still accepted');
    assert.ok(sa.view().bodies.some((b) => b.color === 'P' && b.t === 1 && b.x === 14),
      'and the action that ran is the sealed one, not the forged one');
  });

  it('are held one per colour per turn, and the latest wins', async () => {
    const { peer, sa } = mkSolo();
    seat(sa, 'C', 'Rook');
    peerClaim(peer, 'P', 'Vale');

    const hash = sa.view().hash;
    const first = await twoPhase({ turn: 0, color: 'P', action: 'A', hash, nonce: NONCE_A });
    const second = await twoPhase({ turn: 0, color: 'P', action: 'H', hash, nonce: NONCE_B });

    peer.send(first.reveal); // nothing opens it yet, so it is kept
    await settle();

    // Purple thought better of it before opening anything. The reveal it will
    // actually open is the last one it sent, so that is the one worth keeping.
    peer.send(second.reveal);
    await settle();

    await sa.commit('D');
    peer.send(first.commitment);
    await settle();
    assert.equal(sa.view().turn, 0,
      'one record per colour per turn, so the superseded reveal is gone and its own '
      + 'commitment opens nothing');

    peer.send(second.commitment);
    await settle();

    assert.equal(sa.view().turn, 1, 'the commitment arriving last still opens what was held');
    assert.ok(sa.view().bodies.some((b) => b.color === 'P' && b.t === 1 && b.x === 15),
      'purple held, which is the reveal that was kept');
    assert.equal(sa.view().error, null);
  });
});

// ---- arrival order --------------------------------------------------------

describe('arrival order', () => {
  it('accepts a reveal that arrives before the commitment it opens', async () => {
    const { peer, sa } = mkSolo();
    seat(sa, 'C', 'Rook');
    peerClaim(peer, 'P', 'Vale');

    const p = await twoPhase({ turn: 0, color: 'P', action: 'A', hash: sa.view().hash });
    peer.send(p.reveal); // nothing has been published that opens this yet
    await settle();
    assert.equal(sa.view().turn, 0, 'an unopened reveal decides nothing on its own');
    assert.equal(sa.view().error, null, 'waiting for its commitment is not an error');

    peer.send(p.commitment);
    await sa.commit('D');
    await settle();

    assert.equal(sa.view().turn, 1, 'the commitment arriving late completes the pair');
    assert.ok(sa.view().bodies.some((b) => b.color === 'P' && b.t === 1 && b.x === 14),
      'and the move that ran is the one that was sealed');
  });

  it('ignores duplicate commitments and duplicate reveals', async () => {
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
    assert.equal(sa.view().turn, 0, 'coral has not committed, so nothing has resolved');
    assert.equal(sa.view().error, null);

    await sa.commit('D');
    await settle();
    assert.equal(sa.view().turn, 1, 'the turn resolved exactly once');
    const hash = sa.view().hash;

    peer.send(p.commitment); // and once more, after they have both been used
    peer.send(p.reveal);
    await settle();
    assert.equal(sa.view().turn, 1, 'a late repeat changes nothing');
    assert.equal(sa.view().hash, hash);
    assert.equal(sa.view().error, null);
  });

  it('keeps a commitment that arrives a whole turn early', async () => {
    const { peer, sa } = mkSolo();
    seat(sa, 'C', 'Rook');
    peerClaim(peer, 'P', 'Vale');

    const t0 = await twoPhase({ turn: 0, color: 'P', action: 'A', hash: sa.view().hash, nonce: NONCE_A });
    const early = '#1P:' + await digestFor(1, 'P', 'A', NONCE_B);

    peer.send(early);
    peer.send(t0.commitment);
    await sa.commit('D');
    await settle();
    assert.equal(sa.view().turn, 0, 'turn 0 still needs purple to open');

    peer.send(t0.reveal);
    await settle();
    assert.equal(sa.view().turn, 1, 'and now it resolves');

    const t1 = await twoPhase({ turn: 1, color: 'P', action: 'A', hash: sa.view().hash, nonce: NONCE_B });
    peer.send(t1.reveal); // opens the commitment that turned up a turn early
    await sa.commit('D');
    await settle();
    assert.equal(sa.view().turn, 2, 'the early commitment was kept and still opened');
    assert.equal(sa.view().error, null);
  });

  it('drops strings that are neither a claim, a commitment nor a reveal', async () => {
    const { peer, sa } = mkSolo();
    seat(sa, 'C', 'Rook');
    peerClaim(peer, 'P', 'Vale');
    const before = sa.view().hash;

    for (const junk of [
      '', 'hello', '#0P:zz', '!X~Vale@' + peer.id, sa.export(),
      '#0T:' + JUNK_DIGEST,                 // a colour outside the roster
      '#40P:' + JUNK_DIGEST,                // a turn past the cap
      '0P:D#zzzz|' + NONCE_A                // an action string that does not decode
    ]) peer.send(junk);
    await settle();

    assert.equal(sa.view().turn, 0);
    assert.equal(sa.view().hash, before);
    assert.deepEqual(sa.view().waiting, ['P'], 'purple is still owed a commitment');
    assert.equal(sa.view().error, null, 'noise on a public room is not the match\'s problem');
    assert.equal(sa.view().notice, null);
    assert.deepEqual(Object.keys(sa.claims()).sort(), ['C', 'P'], 'and no seat moved');
  });
});

// ---- closing --------------------------------------------------------------

describe('closing a session', () => {
  it('stops hearing the room, and the room stops resolving turns for it', async () => {
    const { a, peer, sa } = mkSolo();
    seat(sa, 'C', 'Rook');
    peerClaim(peer, 'P', 'Vale');
    await sa.commit('D');
    await settle();
    sa.close();

    const p = await twoPhase({ turn: 0, color: 'P', action: 'A', hash: sa.view().hash });
    peer.send(p.commitment);
    peer.send(p.reveal);
    await settle();

    assert.equal(a.onMessage, null, 'the handler is off the channel');
    assert.equal(sa.view().turn, 0, 'so the turn cannot resolve');
    assert.equal(sa.view().error, null);
  });
});

// ---- claims ---------------------------------------------------------------

describe('colour claims', () => {
  it('give a contested colour to the lower client id', () => {
    // No authority, so both ends run the same comparison on the two client ids
    // and reach the same seat. Ids compare as strings.
    const { a, b, sa, sb } = mkPair();
    const low = a.id < b.id ? sa : sb;
    const high = a.id < b.id ? sb : sa;
    const lowId = a.id < b.id ? a.id : b.id;

    const first = low.claim('C', 'Rook');
    assert.deepEqual(first, { ok: true, error: null }, 'the lower id claimed first and keeps it');
    const second = high.claim('C', 'Vale');
    assert.equal(second.ok, false, 'the higher id must lose the contest');
    matches(second.error, /taken by Rook/, 'and be told why');

    assert.deepEqual(sa.claims().C, { name: 'Rook', clientId: lowId }, 'one side names the winner');
    assert.deepEqual(sb.claims().C, { name: 'Rook', clientId: lowId }, 'and so does the other');
  });

  it('reach the same seat whichever claim arrives first', () => {
    const { a, b, sa, sb } = mkPair();
    const low = a.id < b.id ? sa : sb;
    const high = a.id < b.id ? sb : sa;
    const lowId = a.id < b.id ? a.id : b.id;

    high.claim('C', 'Vale');
    low.claim('C', 'Rook');

    assert.deepEqual(sa.claims().C, { name: 'Rook', clientId: lowId }, 'arrival order does not decide it');
    assert.deepEqual(sb.claims().C, { name: 'Rook', clientId: lowId });
  });

  it('name the other side on the view as soon as the claim lands', () => {
    // The picker reads claims() directly, but every screen past it reads
    // view().names. Without this the other seat stays labelled by its colour
    // until their turn-0 reveal turns up carrying the name.
    const { sa, peer } = mkSolo();
    peerClaim(peer, 'P', 'Vale');
    assert.equal(sa.view().names.P, 'Vale', 'no turn has resolved yet, and none should have to');
  });

  it('name the winner of a contested colour, whichever claim arrived first', () => {
    // Match.setName is first-write-wins on purpose, so the losing claim must not
    // be the one that reaches it. A third client watching two players fight over
    // a colour sees both claims, in whatever order the relays deliver them.
    const { sa, peer } = mkSolo();
    peer.send('!P~Vale@zzzz');
    peer.send('!P~Rook@aaaa');

    assert.equal(sa.claims().P?.name, 'Rook', 'the lower client id holds the seat');
    assert.equal(sa.view().names.P, 'Rook', 'and the screen says so');
  });

  it('list only the taken colours, for the picker to grey out', () => {
    const { a, b, sa, sb } = mkPair({ roster: ['C', 'P', 'T', 'A'] });
    seat(sa, 'C', 'Rook');
    seat(sb, 'P', 'Vale');

    assert.deepEqual(sa.claims(), {
      C: { name: 'Rook', clientId: a.id },
      P: { name: 'Vale', clientId: b.id }
    }, 'a free colour is absent, not present and blank');
    assert.deepEqual(sb.claims(), sa.claims(), 'both sides see the same board');
  });

  it('refuse a colour that is not in the roster', () => {
    const { sa } = mkPair();
    const r = sa.claim('T', 'Rook');
    assert.deepEqual(r, { ok: false, error: 'colour T is not in this match' });
    assert.equal(sa.color(), null);
    assert.equal(sa.view().notice, r.error, 'the picker has something to print');
  });

  it('take back what you played with a colour you lose', async () => {
    // The seat can go out from under you between committing and the turn
    // resolving. What you submitted locally has to go with it, or you carry on
    // holding a draft for a colour that is no longer yours and nobody is told.
    const { ch: mine, s: sa } = mkLone('zzMine'); // the higher id: the contest goes against us
    const peer = makeEnd('aaThem');
    LoopbackChannel.link(mine, peer);

    seat(sa, 'C', 'Rook');
    await sa.commit('D');
    await settle();

    peerClaim(peer, 'C', 'Vale');
    await settle();
    assert.equal(sa.color(), null, 'the lower id keeps coral');
    matches(sa.view().notice, /Pick another colour/, 'and we are told to pick another');

    const r = sa.claim('P', 'Rook');
    assert.ok(r.ok, 'purple is free: ' + r.error);
    assert.equal(sa.view().notice, null, 'which clears the notice');
    await sa.commit('A');
    await settle();

    assert.equal(sa.view().turn, 0, 'purple is the only colour we act for, so the turn is not complete');
    const log = decoded(sa.export()).log;
    assert.deepEqual(log, [{ turn: 0, color: 'P', action: 'A' }],
      'one action in the log, under the colour we still hold');
    assert.ok(sa.view().pending.includes('C'), 'coral is owed by whoever holds it now');
  });

  it('count every seat before the room reports live', () => {
    // A turn needs a commitment from every roster colour, so one peer on a
    // four-colour roster cannot resolve anything. Saying live there invites a
    // player to start a match that hangs on turn 0.
    const four = mkPair({ roster: ['C', 'P', 'T', 'A'] });
    assert.equal(four.sa.view().status, 'connecting', 'one peer of the three needed is not live');
    assert.equal(four.sa.view().peersNeeded, 2, 'and it says how many are still missing');

    const two = mkPair();
    assert.equal(two.sa.view().status, 'live', 'the one peer a two-colour roster needs is live');
    assert.equal(two.sa.view().peersNeeded, 0);
  });
});

// ---- a peer arriving late -------------------------------------------------

describe('a peer arriving late', () => {
  it('is sent the claim and the commitment for the turn in progress', async () => {
    // pair() wires both ends up front, so nobody is ever new. Built one end at a
    // time instead, and linked once the second is open. The status report that
    // link() emits is the entire trigger.
    const { ch: a, s: sa, sent: sentA } = mkLone('lateA');
    seat(sa, 'C', 'Rook');
    await sa.commit('D'); // into an empty room
    await settle();
    const before = sentA.length;

    const b = makeEnd('lateB');
    const sb = Session.open({ match: Match.fromConfig(cfg()), channel: b, onChange: () => {} });
    LoopbackChannel.link(a, b);
    await settle();

    const announced = sentA.slice(before);
    assert.deepEqual(announced.map(kindOf), ['claim', 'commitment'],
      'no reveal: purple has not committed, so coral has nothing to open yet');
    assert.deepEqual(sb.claims().C, { name: 'Rook', clientId: a.id });

    seat(sb, 'P', 'Vale');
    await sb.commit('A');
    await settle();
    assert.equal(sb.view().turn, 1, 'the joiner caught up and the turn resolved');
    assert.equal(sa.view().turn, 1);
    assert.equal(sa.view().hash, sb.view().hash);
    assert.equal(sa.view().names.C, 'Rook', 'claiming seats the name in the Match, not only in the claim');
    assert.equal(sb.view().names.C, 'Rook', 'and the joiner ends up with it too');
  });

  it('is sent the reveal as well, once we have opened ours', async () => {
    // Coral has already revealed, and purple's commitment is in. A peer arriving
    // now needs the reveal too, or it sits forever on a turn already finished.
    const { ch: a, s: sa, sent: sentA } = mkLone('midA');
    const peer = makeEnd('midP');
    LoopbackChannel.link(a, peer);
    seat(sa, 'C', 'Rook');

    const p = await twoPhase({ turn: 0, color: 'P', action: 'A', hash: sa.view().hash });
    await sa.commit('D');
    peer.send(p.commitment);
    await settle();
    assert.equal(sa.view().turn, 0, 'purple has committed but not opened');

    const before = sentA.length;
    LoopbackChannel.link(a, makeEnd('midL'));
    await settle();

    const announced = sentA.slice(before);
    assert.deepEqual(announced.map(kindOf), ['claim', 'commitment', 'reveal'],
      'and nothing else: ' + announced.join(' '));
  });

  it('can rejoin from a trimmed export and finish the turn the room waits on', async () => {
    // Untrimmed, this hangs. The import carries coral's draft, so purple's own
    // commit completes the turn locally on the spot, the reveal is never sent,
    // and coral waits for something that never comes.
    const { ch: a, s: sa } = mkLone('liveA');
    seat(sa, 'C', 'Rook');
    await sa.commit('D'); // into an empty room, so the turn is still open
    await settle();

    const b = makeEnd('joinB');
    const sb = Session.open({
      match: imported(trimUnresolved(sa.export())), channel: b, onChange: () => {}
    });
    LoopbackChannel.link(a, b);
    await settle();
    assert.deepEqual(sb.claims().C, { name: 'Rook', clientId: a.id },
      'linking announces the seat coral already holds');
    assert.equal(sb.view().turn, 0, 'and the importer is on the turn coral is waiting to finish');

    seat(sb, 'P', 'Vale');
    await sb.commit('A');
    await settle();

    assert.equal(sb.view().turn, 1, 'the joiner resolved the turn');
    assert.equal(sa.view().turn, 1, 'and so did the peer that had been waiting on it');
    assert.equal(sa.view().hash, sb.view().hash, 'on one state, not two');
    assert.ok(sa.view().bodies.some((b) => b.color === 'P' && b.t === 1 && b.x === 14),
      "coral saw the joiner's move");
    assert.equal(sa.view().error, null);
    assert.equal(sb.view().error, null);
  });
});

// ---- export trimming ------------------------------------------------------

describe('export trimming', () => {
  it('cuts a mid-turn draft back to the last finished turn', async () => {
    const { sa, sb } = mkPair();
    seat(sa, 'C', 'Rook');
    seat(sb, 'P', 'Vale');
    await sa.commit('D');
    await sb.commit('A');
    await settle();
    assert.equal(sa.view().turn, 1, 'turn 0 finished');
    await commitLegal(sa); // and turn 1 is under way, with only coral in

    const raw = sa.export();
    assert.ok(!imported(raw).pendingColors().includes('C'),
      'the untrimmed export carries the draft, which is the whole problem');

    const trimmed = imported(trimUnresolved(raw));
    assert.equal(trimmed.currentTurn(), sa.view().turn, 'the finished turns are all still there');
    assert.deepEqual(trimmed.pendingColors(), ['C', 'P'], 'the unfinished one is owed by everybody again');
    assert.equal(trimmed.view('C').myAction, null, 'no draft comes back, so commit() has something to do');
    assert.equal(trimmed.stateHash(), sa.view().hash, 'on the state the live session is already on');
    assert.equal(trimmed.names().C, 'Rook', 'and the names survive the cut');
  });

  it('changes nothing at a turn boundary', async () => {
    const { sa, sb } = mkPair();
    seat(sa, 'C', 'Rook');
    seat(sb, 'P', 'Vale');
    await sa.commit('D');
    await sb.commit('A');
    await settle();
    assert.equal(sa.view().turn, 1, 'nobody is mid-turn');

    const raw = sa.export();
    assert.equal(trimUnresolved(raw), imported(raw).export(), 'there was nothing to cut');
  });

  it('leaves a string it cannot decode to Match.fromExport', () => {
    assert.equal(trimUnresolved('not an export'), 'not an export');
  });
});

// ---- match code -----------------------------------------------------------

describe('room ids', () => {
  it('put one code in one room, whitespace and all', () => {
    const s1 = Wire.encodeMatchCode(cfg({ seed: 'aaa' }));
    const s2 = Wire.encodeMatchCode(cfg({ seed: 'aaa' }));
    const s3 = Wire.encodeMatchCode(cfg({ seed: 'bbb' }));
    assert.equal(s1, 'M1:16x9:0:aaa:40:CP',
      "a match code is the engine's own six segments, nothing appended");

    const id = Code.roomId(s1);
    assert.equal(Code.roomId(s2), id, 'the same code has to find the same room');
    assert.notEqual(Code.roomId(s3), id, 'a different seed is a different room');
    assert.equal(Code.roomId(' ' + s1 + '\n'), id, 'stray whitespace must not split the room');
  });

  it('are a fixed shape, so a relay never sees a match code', () => {
    assert.match(Code.roomId('M1:16x9:0:aaa:40:CP'), /^tbtt-[0-9a-f]{16}$/);
  });
});

// ---- divergence -----------------------------------------------------------
//
// Commit-reveal decides when an action becomes visible and nothing more. The
// state hash is still the only thing that catches a fork, so every path that
// applies an action has to check it and hold on to what it found.

describe('the divergence check', () => {
  // A properly sealed, properly opened action for a state neither of us is in.
  async function diverge(sa: Sess, peer: Channel) {
    const p = await twoPhase({ turn: 0, color: 'P', action: 'A', hash: 'dead' });
    peer.send(p.commitment);
    peer.send(p.reveal);
    await settle();
  }

  it('latches the mismatch in view().error', async () => {
    const { peer, sa } = mkSolo();
    seat(sa, 'C', 'Rook');
    peerClaim(peer, 'P', 'Vale');
    await sa.commit('D'); // committed, so an opened reveal is applied rather than held
    await settle();
    await diverge(sa, peer);

    const first = sa.view().error;
    assert.ok(first, 'a diverged timeline has to surface');
    assert.equal(sa.view().turn, 0, 'and the turn does not resolve on it');

    peer.send('!P~Vale@' + peer.id); // unrelated traffic must not wipe the report
    await settle();
    assert.equal(sa.view().error, first, 'the error is held, not flashed and lost');
  });

  it('reports the turn, the state that arrived, and the state we are on', async () => {
    const { peer, sa } = mkSolo();
    seat(sa, 'C', 'Rook');
    peerClaim(peer, 'P', 'Vale');
    const hash = sa.view().hash;
    await sa.commit('D');
    await settle();
    await diverge(sa, peer);

    matches(sa.view().error, /^turn 0 arrived on state dead\b/);
    matches(sa.view().error, new RegExp('this match is on ' + hash));
    matches(sa.view().error, /Export and re-import/, 'and says what the player can do');
  });

  it('does not apply the action that failed the check', async () => {
    const { peer, sa } = mkSolo();
    seat(sa, 'C', 'Rook');
    peerClaim(peer, 'P', 'Vale');
    await sa.commit('D');
    await settle();
    await diverge(sa, peer);

    assert.deepEqual(decoded(sa.export()).log, [{ turn: 0, color: 'C', action: 'D' }],
      'only our own draft is in the log');
    assert.ok(sa.view().pending.includes('P'), 'purple is still owed the turn');
    assert.equal(sa.view().me.t, 0, 'and nothing moved');
  });

  it('holds the report through a later reveal that would otherwise be accepted', async () => {
    const { peer, sa } = mkSolo();
    seat(sa, 'C', 'Rook');
    peerClaim(peer, 'P', 'Vale');
    await sa.commit('D');
    await settle();
    await diverge(sa, peer);
    const first = sa.view().error;
    assert.ok(first, 'the fork was reported');

    // Nothing you do at the keyboard fixes a fork, so a well-formed message that
    // happens to arrive afterwards must not read as recovery.
    const good = await twoPhase({ turn: 0, color: 'P', action: 'H', hash: sa.view().hash, nonce: NONCE_B });
    peer.send(good.commitment);
    peer.send(good.reveal);
    await settle();
    assert.equal(sa.view().error, first, 'the report from the fork stands');
  });

  it('catches a mismatch that was buffered before we committed', async () => {
    // Opened reveals are held, not applied, until we have committed, so the
    // check has to run on the buffer too and not only on arrival.
    const { peer, sa } = mkSolo();
    seat(sa, 'C', 'Rook');
    peerClaim(peer, 'P', 'Vale');

    await diverge(sa, peer);
    assert.equal(sa.view().error, null, 'nothing is judged while it is still buffered');

    await sa.commit('D');
    await settle();
    matches(sa.view().error, /timelines have diverged/, 'committing flushes it, and it fails there');
    assert.equal(sa.view().turn, 0);
  });

  it('does not judge a reveal for a turn the match has not reached', async () => {
    const { peer, sa } = mkSolo();
    seat(sa, 'C', 'Rook');
    peerClaim(peer, 'P', 'Vale');
    await sa.commit('D');
    await settle();

    const ahead = await twoPhase({ turn: 1, color: 'P', action: 'A', hash: 'dead' });
    peer.send(ahead.commitment);
    peer.send(ahead.reveal);
    await settle();

    assert.equal(sa.view().error, null,
      'turn 1 is still ahead of us, and its hash is nobody\'s business yet');
    assert.equal(sa.view().turn, 0);
  });
});

// ---- wire discipline ------------------------------------------------------

describe('wire discipline', () => {
  it('puts nothing but claims, commitments and reveals on the wire', async () => {
    // Match.export() would leak this turn's move if broadcast, and so would a
    // bare action string. An action travels only inside a reveal, sent once
    // every commitment for the turn is in.
    const { sa, sb, sentA, sentB } = mkPair({ w: 8, h: 2, cap: 8, seed: 'wire' });
    seat(sa, 'C', 'Rook');
    seat(sb, 'P', 'Vale');

    let guard = 0;
    while (!sa.view().over && guard++ < 100) {
      await commitLegal(sa);
      await commitLegal(sb);
      await settle();
    }
    assert.ok(sa.view().over, 'the match should have reached the cap');
    assert.equal(sa.view().hash, sb.view().hash, 'and the two sides still agree');

    const all = sentA.concat(sentB);
    for (const s of all) {
      assert.ok(s.length, 'sent an empty string');
      assert.notEqual(s.slice(0, 3), 'X1:', 'an export went on the wire: ' + s);
      const kind = kindOf(s);
      assert.notEqual(kind, 'unknown', 'neither a claim, a commitment nor a reveal: ' + s);
      if (kind === 'reveal') {
        const m = REVEAL_RE.exec(s);
        assert.ok(m, s);
        assert.ok(Wire.decodeAction(m[1]).ok, 'unreadable action inside a reveal: ' + s);
      }
    }
    const counts = { claim: 0, commitment: 0, reveal: 0, unknown: 0 };
    for (const s of all) counts[kindOf(s)]++;
    assert.deepEqual(counts, { claim: 2, commitment: 16, reveal: 16, unknown: 0 },
      'two claims, then one commitment and one reveal per colour per turn');
  });
});
