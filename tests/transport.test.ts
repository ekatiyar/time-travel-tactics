import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { Session, Code, trimUnresolved, LoopbackChannel } from '../play/src/transport.js';
import { Match, Wire, metaTurn } from '../play/src/engine.js';
import type { Action, Color, Config } from '../play/src/engine.js';
import type { Channel, LoopbackEnd } from '../play/src/transport.js';

function makeEnd(id?: string): LoopbackEnd {
  return LoopbackChannel.make(id);
}
function makePair(): [LoopbackEnd, LoopbackEnd] {
  return LoopbackChannel.pair();
}

type Sess = ReturnType<typeof Session.open>;

function matches(actual: string | null, re: RegExp, message?: string): void {
  assert.ok(actual !== null, message ?? 'expected text matching ' + re + ', got null');
  assert.match(actual, re, message);
}

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

const CONFIG: Config = { w: 16, h: 9, wallPct: 0, seed: 'test', cap: 40, roster: ['C', 'P'] };

function cfg(over?: Partial<typeof CONFIG>) {
  return { ...CONFIG, ...over };
}

// Delivery starts async work that tests cannot await directly.
async function settle(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
}

function record(ch: LoopbackEnd): string[] {
  const sent: string[] = [];
  const raw = ch.send.bind(ch);
  ch.send = (text) => { sent.push(text); raw(text); };
  return sent;
}

function mkLone(id?: string, over?: Partial<typeof CONFIG>, names?: Partial<Record<Color, string>>) {
  const ch = makeEnd(id);
  const sent = record(ch);
  const s = Session.open({
    match: Match.fromConfig(cfg(over)), channel: ch, names: names, onChange: () => {}
  });
  return { ch, s, sent };
}

function mkPair(over?: Partial<typeof CONFIG>) {
  const [a, b] = makePair();
  const sentA = record(a), sentB = record(b);
  const changes = { a: 0, b: 0 };
  const c = cfg(over);
  const sa = Session.open({ match: Match.fromConfig(c), channel: a, onChange: () => { changes.a++; } });
  const sb = Session.open({ match: Match.fromConfig(c), channel: b, onChange: () => { changes.b++; } });
  return { a, b, sa, sb, changes, sentA, sentB };
}

function mkSolo(over?: Partial<typeof CONFIG>, names?: Partial<Record<Color, string>>) {
  const { ch: a, s: sa, sent } = mkLone(undefined, over, names);
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

    assert.ok(!sa.view().pending.includes('C'),
      'the action is in the log locally, so the screen has something to draw');
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
    const { sa, sb } = mkPair();
    seat(sa, 'C', 'Rook');
    seat(sb, 'P', 'Vale');

    await sa.commit('D');
    const w = sa.withdraw();
    assert.ok(!(w instanceof Promise), 'withdraw hashes nothing, so it stays synchronous');
    assert.ok(w.ok, 'purple has not committed, so the action is still yours to take back: ' + w.error);
    assert.ok(sa.view().pending.includes('C'), 'and it is gone locally');
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

    assert.deepEqual(sa.view().waiting, [], 'everyone else is in, coral is just deciding');
    assert.equal(sa.view().turn, 0, 'and still nothing has resolved');
  });
});

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
    peer.send(forged.reveal);
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

    peer.send(first.reveal);
    await settle();

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

describe('arrival order', () => {
  it('accepts a reveal that arrives before the commitment it opens', async () => {
    const { peer, sa } = mkSolo();
    seat(sa, 'C', 'Rook');
    peerClaim(peer, 'P', 'Vale');

    const p = await twoPhase({ turn: 0, color: 'P', action: 'A', hash: sa.view().hash });
    peer.send(p.reveal);
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

    peer.send(p.commitment);
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
    peer.send(t1.reveal);
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
      '#0T:' + JUNK_DIGEST,
      '#40P:' + JUNK_DIGEST,
      '0P:D#zzzz|' + NONCE_A
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

describe('colour claims', () => {
  it('give a contested colour to the lower client id', () => {
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
    const { sa, peer } = mkSolo();
    peerClaim(peer, 'P', 'Vale');
    assert.equal(sa.view().names.P, 'Vale', 'no turn has resolved yet, and none should have to');
  });

  it('name the winner of a contested colour, whichever claim arrived first', () => {
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
    const { ch: mine, s: sa } = mkLone('zzMine');
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
    const four = mkPair({ roster: ['C', 'P', 'T', 'A'] });
    assert.equal(four.sa.view().status, 'connecting', 'one peer of the three needed is not live');
    assert.equal(four.sa.view().peersNeeded, 2, 'and it says how many are still missing');

    const two = mkPair();
    assert.equal(two.sa.view().status, 'live', 'the one peer a two-colour roster needs is live');
    assert.equal(two.sa.view().peersNeeded, 0);
  });
});

describe('names', () => {
  it('carries the name on the turn-0 reveal and nowhere later', async () => {
    const { sa, sb, sentA } = mkPair();
    seat(sa, 'C', 'Rook');
    seat(sb, 'P', 'Vale');
    const h0 = sa.view().hash;

    await sa.commit('D');
    await sb.commit('A');
    await settle();
    const opening = sentA.filter((t) => t.startsWith('0C:'));
    assert.deepEqual(opening.map((t) => t.split('|')[0]), ['0C:D#' + h0 + '~Rook'],
      'the opening reveal names the player');

    const h1 = sa.view().hash;
    await sa.commit('D');
    await sb.commit('A');
    await settle();
    const late = sentA.filter((t) => t.startsWith('1C:'));
    assert.deepEqual(late.map((t) => t.split('|')[0]), ['1C:D#' + h1],
      'later reveals drop it, because the name is already everywhere');
  });

  it('puts a played name in the export and a bare claim nowhere near it', () => {
    const { sa, peer } = mkSolo();
    peerClaim(peer, 'P', 'Vale');

    assert.equal(sa.view().names.P, 'Vale', 'the screen says who is sitting there');
    assert.equal(decoded(sa.export()).names.P, undefined,
      'but nobody has played as purple, so the export has nothing to record');
  });

  it('exports the name of whoever actually played the turn', async () => {
    const { sa, sb } = mkPair();
    seat(sa, 'C', 'Rook');
    seat(sb, 'P', 'Vale');
    await sa.commit('D');
    await sb.commit('A');
    await settle();

    assert.deepEqual(decoded(sb.export()).names, { C: 'Rook', P: 'Vale' },
      'both sides of a resolved turn are named from the far end too');
  });

  it('seats an imported name straight into the view and the next export', () => {
    const { s } = mkLone('imp', undefined, { C: 'Rook', P: 'Vale' });
    assert.deepEqual(s.view().names, { C: 'Rook', P: 'Vale' });
    assert.deepEqual(decoded(s.export()).names, { C: 'Rook', P: 'Vale' });
  });

  it('keeps the first name a colour was played under', async () => {
    const { sa, peer } = mkSolo(undefined, { P: 'Vale' });
    seat(sa, 'C', 'Rook');
    const t = await twoPhase({
      turn: 0, color: 'P', action: 'A', hash: sa.view().hash, name: 'Rook'
    });
    peer.send(t.commitment);
    peer.send(t.reveal);
    await sa.commit('D');
    await settle();

    assert.equal(sa.view().turn, 1, 'the turn resolved, so the reveal was applied');
    assert.equal(decoded(sa.export()).names.P, 'Vale', 'the imported name stands');
  });

  it('ignores a name it has no seat for and a name the wire could not carry', () => {
    const { s } = mkLone('junk', { roster: ['C', 'P'] }, { T: 'Nim', C: 'Bo Vale' });
    assert.deepEqual(s.view().names, {}, 'teal is not in this match and a space is not a name');
    assert.deepEqual(decoded(s.export()).names, {});
  });
});

describe('a peer arriving late', () => {
  it('is sent the claim and the commitment for the turn in progress', async () => {
    const { ch: a, s: sa, sent: sentA } = mkLone('lateA');
    seat(sa, 'C', 'Rook');
    await sa.commit('D');
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
    const { ch: a, s: sa } = mkLone('liveA');
    seat(sa, 'C', 'Rook');
    await sa.commit('D');
    await settle();

    const b = makeEnd('joinB');
    const from = imported(trimUnresolved(sa.export()));
    const sb = Session.open({
      match: from.match, channel: b, names: from.names, onChange: () => {}
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

describe('export trimming', () => {
  it('cuts a mid-turn draft back to the last finished turn', async () => {
    const { sa, sb } = mkPair();
    seat(sa, 'C', 'Rook');
    seat(sb, 'P', 'Vale');
    await sa.commit('D');
    await sb.commit('A');
    await settle();
    assert.equal(sa.view().turn, 1, 'turn 0 finished');
    await commitLegal(sa);

    const raw = sa.export();
    assert.ok(!imported(raw).match.pendingColors().includes('C'),
      'the untrimmed export carries the draft, which is the whole problem');

    const trimmed = imported(trimUnresolved(raw));
    assert.equal(trimmed.match.currentTurn(), sa.view().turn, 'the finished turns are all still there');
    assert.deepEqual(trimmed.match.pendingColors(), ['C', 'P'],
      'the unfinished one is owed by everybody again, so commit() has something to do');
    assert.equal(trimmed.match.stateHash(), sa.view().hash, 'on the state the live session is already on');
    assert.equal(trimmed.names.C, 'Rook', 'and the names survive the cut');
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
    const back = imported(raw);
    assert.equal(trimUnresolved(raw), back.match.export(back.names), 'there was nothing to cut');
  });

  it('leaves a string it cannot decode to Match.fromExport', () => {
    assert.equal(trimUnresolved('not an export'), 'not an export');
  });
});

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

describe('the divergence check', () => {
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
    await sa.commit('D');
    await settle();
    await diverge(sa, peer);

    const first = sa.view().error;
    assert.ok(first, 'a diverged timeline has to surface');
    assert.equal(sa.view().turn, 0, 'and the turn does not resolve on it');

    peer.send('!P~Vale@' + peer.id);
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

    matches(sa.view().error, /^Turn 0 is for state dead\b/);
    matches(sa.view().error, new RegExp('this match is on ' + hash));
    matches(sa.view().error, /Export, then re-import/, 'and says what the player can do');
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

    const good = await twoPhase({ turn: 0, color: 'P', action: 'H', hash: sa.view().hash, nonce: NONCE_B });
    peer.send(good.commitment);
    peer.send(good.reveal);
    await settle();
    assert.equal(sa.view().error, first, 'the report from the fork stands');
  });

  it('catches a mismatch that was buffered before we committed', async () => {
    const { peer, sa } = mkSolo();
    seat(sa, 'C', 'Rook');
    peerClaim(peer, 'P', 'Vale');

    await diverge(sa, peer);
    assert.equal(sa.view().error, null, 'nothing is judged while it is still buffered');

    await sa.commit('D');
    await settle();
    matches(sa.view().error, /Export, then re-import/, 'committing flushes it, and it fails there');
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

describe('wire discipline', () => {
  it('puts nothing but claims, commitments and reveals on the wire', async () => {
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
