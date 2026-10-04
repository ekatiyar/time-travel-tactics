import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Session, Code, trimUnresolved } from '../play/src/transport.js';
import { Match, Wire, metaTurn } from '../play/src/engine/index.js';
import type { Color, Config } from '../play/src/engine/index.js';
import { QueuedNetwork, messageType } from './helpers/queued-channel.js';

type Sess = ReturnType<typeof Session.open>;
const CONFIG: Config = {
  mode: 'sandbox', w: 16, h: 9, wallPct: 0, seed: 'test', cap: 40, roster: ['C', 'P']
};
const NAMES = { C: 'Rook', P: 'Vale', T: 'Nim', A: 'Ash' };

function decoded(raw: string) {
  const result = Wire.decodeExport(raw);
  assert.ok(result.ok, 'export should decode');
  return result.value;
}
function imported(raw: string) {
  const result = Match.fromExport(raw);
  assert.ok(result.ok, 'export should import');
  return result.value;
}
function seat(s: Sess, color: Color) {
  const row = s.view().seats.find((candidate) => candidate.color === color);
  assert.ok(row, 'missing seat ' + color);
  return row;
}
function fixture(roster: Color[] = ['C', 'P']) {
  const network = new QueuedNetwork();
  const sessions: Sess[] = [];
  const config = { ...CONFIG, roster };
  const open = (id: string, entry: 'create' | 'join' | 'resume', raw?: string): Sess => {
    const saved = raw ? imported(raw) : null;
    const session = Session.open({
      match: saved?.match ?? Match.fromConfig(config), names: saved?.names,
      channel: network.connect(id), entry
    });
    sessions.push(session);
    return session;
  };
  const close = () => sessions.forEach((session) => session.close());
  const start = async () => {
    const players = roster.map((color, i) => open('peer' + i, i === 0 ? 'create' : 'join'));
    players.forEach((player, i) => assert.ok(player.join(NAMES[roster[i]!]).ok));
    await network.pump();
    players.forEach((player) => assert.ok(player.ready().ok));
    await network.pump();
    players.forEach((player, i) => {
      assert.equal(player.color(), roster[i]);
      assert.equal(player.view().phase, 'playing');
      assert.equal(player.view().canCommit, true);
    });
    return players;
  };
  return { network, sessions, config, open, close, start };
}

for (const roster of [['C', 'P'], ['C', 'P', 'T'], ['C', 'P', 'T', 'A']] as Color[][]) {
  it(roster.length + ' players start only after every configured owner is Ready', async () => {
    const f = fixture(roster);
    try {
      const players = roster.map((color, i) => f.open('peer' + i, i === 0 ? 'create' : 'join'));
      players.forEach((player, i) => assert.ok(player.join(NAMES[roster[i]!]).ok));
      await f.network.pump();
      assert.deepEqual(players.map((player) => player.color()), roster);
      for (const player of players.slice(0, -1)) assert.ok(player.ready().ok);
      await f.network.pump();
      assert.ok(players.every((player) => !player.view().canCommit));
      assert.equal((await players[0]!.commit('H')).ok, false);
      assert.ok(players.at(-1)!.ready().ok);
      await f.network.pump();
      assert.ok(players.every((player) => player.view().canCommit));
      assert.deepEqual(decoded(players[0]!.export()).names,
        Object.fromEntries(roster.map((color) => [color, NAMES[color]])));
      assert.ok(decoded(players[0]!.export()).log.length === 0);
    } finally { f.close(); }
  });
}

describe('lobby consent and reservations', () => {
  it('changing your name clears only your readiness and leaves saved names untouched before activation', async () => {
    const f = fixture(['C', 'P', 'T']);
    try {
      const a = f.open('host', 'create'), b = f.open('other', 'join');
      assert.ok(a.join('Old').ok); assert.ok(b.join('Vale').ok);
      await f.network.pump();
      assert.ok(a.ready().ok); assert.ok(b.ready().ok);
      await f.network.pump();
      const before = a.export();
      assert.ok(a.join('New').ok);
      await f.network.pump();
      assert.equal(seat(a, 'C').name, 'New');
      assert.equal(seat(a, 'C').ready, false);
      assert.equal(seat(a, 'P').ready, true);
      assert.equal(a.export(), before);
      assert.deepEqual(decoded(a.export()).names, {});
    } finally { f.close(); }
  });

  it('a delayed Ready cannot restore consent after a newer unready', async () => {
    const f = fixture(['C', 'P', 'T']);
    try {
      const a = f.open('host', 'create'), b = f.open('other', 'join');
      a.join('Rook'); b.join('Vale'); await f.network.pump();
      b.ready();
      const old = f.network.messages.filter((message) => message.from === 'other');
      f.network.messages.splice(0);
      b.ready(false); await f.network.pump();
      old.forEach((message) => f.network.inject(message));
      await f.network.pump();
      assert.equal(seat(a, 'P').ready, false);
    } finally { f.close(); }
  });

  it('duplicate concurrent fresh requests reserve distinct colours', async () => {
    const f = fixture(['C', 'P', 'T']);
    try {
      const a = f.open('host', 'create'), b = f.open('b', 'join'), c = f.open('c', 'join');
      a.join('Rook'); b.join('Vale'); c.join('Nim');
      const requests = f.network.messages.filter((message) => messageType(message) === 'request');
      f.network.messages.push(...requests.map((message) => ({ ...message })));
      await f.network.pump();
      assert.equal(a.color(), 'C');
      assert.deepEqual(new Set([b.color(), c.color()]), new Set(['P', 'T']));
      assert.equal(a.view().canCommit, false);
    } finally { f.close(); }
  });

  it('matching and stale full-room visitors leave the active group able to play', async () => {
    const f = fixture();
    try {
      const [a, b] = await f.start();
      const stale = a!.export();
      await Promise.all([a!.commit('D'), b!.commit('A')]); await f.network.pump();
      const matching = f.open('aaVisitor', 'resume', a!.export());
      await f.network.pump();
      const old = f.open('abStale', 'resume', stale);
      await f.network.pump();
      assert.equal(matching.color(), null); assert.equal(old.color(), null);
      assert.equal(matching.view().canCommit, false); assert.equal(old.view().canCommit, false);
      assert.equal(old.view().phase, 'mismatch');
      assert.equal(a!.view().hostId, 'peer0');
      assert.ok(a!.view().canCommit && b!.view().canCommit);
      await Promise.all([a!.commit('H'), b!.commit('H')]); await f.network.pump();
      assert.equal(a!.view().turn, 2); assert.equal(a!.export(), b!.export());
    } finally { f.close(); }
  });
});

describe('completed-turn staging', () => {
  it('does not freeze names or accept actions before its activation arrives', async () => {
    const f = fixture();
    try {
      const a = f.open('peer0', 'create'), b = f.open('peer1', 'join');
      a.join('Rook'); b.join('Vale'); await f.network.pump();
      const before = b.export();
      a.ready(); b.ready();
      await f.network.pump((message) => !(message.to === 'peer1' && messageType(message) === 'activate'));
      assert.equal(b.export(), before);
      assert.equal(b.view().canCommit, false);
      assert.equal((await b.commit('A')).ok, false);
      assert.equal(a.view().canCommit, true);
      assert.ok((await a.commit('D')).ok);
      await f.network.pump((message) => !(message.to === 'peer1' && messageType(message) === 'activate'));
      assert.equal(b.export(), before);
      await f.network.pump();
      assert.deepEqual(decoded(b.export()).names, { C: 'Rook', P: 'Vale' });
      assert.ok((await b.commit('A')).ok); await f.network.pump();
      assert.equal(a.view().turn, 1); assert.equal(a.export(), b.export());
    } finally { f.close(); }
  });

  it('rejects foreign, wrong-room, wrong-version and stale-epoch action messages', async () => {
    const f = fixture();
    try {
      const [a, b] = await f.start();
      const outsider = f.open('outsider', 'resume', a!.export());
      await f.network.pump();
      assert.ok((await b!.commit('A')).ok);
      const delivery = f.network.messages.find((message) => message.to === 'peer0' && messageType(message) === 'commit');
      assert.ok(delivery);
      const original = JSON.parse(delivery.text) as { v: number; room: string; value: Record<string, unknown> };
      f.network.messages.splice(0);
      f.network.inject({ ...delivery, from: 'outsider' });
      const invalid = [
        { ...original, v: 1 }, { ...original, room: 'another-room' },
        { ...original, value: { ...original.value, id: 'superseded-epoch-attempt' } },
        { ...original, value: { ...original.value, turn: 90 } }
      ];
      for (const message of invalid) {
        f.network.inject({ ...delivery, text: JSON.stringify(message) });
      }
      await f.network.pump();
      assert.deepEqual(a!.view().uncommitted, ['C', 'P']);
      assert.equal(a!.view().turn, 0);
      assert.equal(outsider.view().canCommit, false);
      f.network.inject(delivery); await f.network.pump();
      assert.deepEqual(a!.view().uncommitted, ['C']);
      assert.ok((await a!.commit('D')).ok); await f.network.pump();
      assert.equal(a!.view().turn, 1); assert.equal(a!.export(), b!.export());
    } finally { f.close(); }
  });

  it('holds an authenticated reveal until its commitment arrives', async () => {
    const f = fixture();
    try {
      const [a, b] = await f.start();
      await Promise.all([a!.commit('D'), b!.commit('A')]);
      await f.network.pump((message) => !(message.to === 'peer0' && messageType(message) === 'commit'));
      assert.equal(a!.view().turn, 0);
      assert.notEqual(a!.view().phase, 'mismatch');
      await f.network.pump();
      assert.equal(a!.view().turn, 1); assert.equal(a!.export(), b!.export());
    } finally { f.close(); }
  });

  it('rejects an altered reveal and completes only with the committed actions', async () => {
    const f = fixture();
    try {
      const [a, b] = await f.start();
      const before = a!.export();
      await Promise.all([a!.commit('D'), b!.commit('A')]);
      await f.network.pump((message) => messageType(message) !== 'reveal');
      const delivery = f.network.messages.find((message) => message.from === 'peer1' && message.to === 'peer0' && messageType(message) === 'reveal');
      assert.ok(delivery);
      const forged = JSON.parse(delivery.text);
      forged.value.action = 'H';
      f.network.inject({ ...delivery, text: JSON.stringify(forged) });
      await f.network.pump((message) => messageType(message) !== 'reveal');
      assert.equal(a!.view().turn, 0);
      assert.equal(a!.export(), before);
      await f.network.pump();
      assert.equal(a!.view().turn, 1);
      assert.equal(a!.export(), b!.export());
      assert.deepEqual(decoded(a!.export()).log, [
        { turn: 0, color: 'C', action: 'D' }, { turn: 0, color: 'P', action: 'A' }
      ]);
    } finally { f.close(); }
  });

  it('keeps commitments and verified partial reveals out of completed exports', async () => {
    const f = fixture();
    try {
      const [a, b] = await f.start();
      const before = a!.export();
      assert.ok((await a!.commit('D')).ok); await f.network.pump();
      assert.equal(a!.export(), before); assert.equal(b!.export(), before);
      assert.equal(a!.view().canChange, true);
      assert.ok((await b!.commit('A')).ok);
      await f.network.pump((message) => messageType(message) !== 'reveal');
      assert.equal(a!.export(), before); assert.equal(b!.export(), before);
      assert.equal(a!.view().turn, 0);
      await f.network.pump();
      assert.equal(a!.view().turn, 1); assert.equal(a!.export(), b!.export());
      assert.equal(decoded(a!.export()).log.length, 2);
    } finally { f.close(); }
  });

  it('ignores a superseded commitment after withdrawal and recommit, even delivered last', async () => {
    const f = fixture();
    try {
      const [a, b] = await f.start();
      assert.ok((await a!.commit('D')).ok);
      const old = f.network.messages.filter((message) => messageType(message) === 'commit');
      assert.ok(old.length > 0);
      f.network.messages.splice(0);
      assert.ok(a!.withdraw().ok);
      assert.ok((await a!.commit('H')).ok);
      await f.network.pump();
      old.forEach((message) => f.network.inject(message));
      await f.network.pump();
      assert.ok((await b!.commit('A')).ok); await f.network.pump();
      assert.equal(a!.view().turn, 1); assert.equal(a!.export(), b!.export());
      assert.equal(decoded(a!.export()).log.find((action) => action.color === 'C')?.action, 'H');
    } finally { f.close(); }
  });

  it('buffers a checkpoint that arrives before local reveals finish', async () => {
    const f = fixture();
    try {
      const [a, b] = await f.start();
      await Promise.all([a!.commit('D'), b!.commit('A')]);
      await f.network.pump((message) => !(message.to === 'peer0' && messageType(message) === 'reveal'));
      assert.equal(b!.view().turn, 1);
      assert.equal(a!.view().turn, 0);
      assert.notEqual(a!.view().phase, 'mismatch');
      assert.equal(b!.view().canCommit, false);
      await f.network.pump();
      assert.equal(a!.view().turn, 1); assert.equal(a!.export(), b!.export());
      assert.ok(a!.view().canCommit && b!.view().canCommit);
    } finally { f.close(); }
  });

  it('duplicate and reverse-delivered turn traffic applies exactly one complete batch', async () => {
    const f = fixture();
    try {
      const [a, b] = await f.start();
      await Promise.all([a!.commit('D'), b!.commit('A')]);
      f.network.messages.push(...f.network.messages.map((message) => ({ ...message })));
      f.network.messages.reverse();
      await f.network.pump();
      assert.equal(a!.view().turn, 1); assert.equal(b!.view().turn, 1);
      assert.equal(a!.export(), b!.export());
      assert.equal(decoded(a!.export()).log.length, 2);
    } finally { f.close(); }
  });

  it('closed sessions ignore queued traffic and unfinished hash callbacks', async () => {
    const f = fixture();
    try {
      const [a, b] = await f.start();
      const saved = a!.export();
      const pending = a!.commit('D');
      a!.close();
      await pending; await f.network.pump();
      assert.equal(a!.export(), saved);
      assert.equal(a!.view().canCommit, false);
      assert.equal(b!.view().canCommit, false);
    } finally { f.close(); }
  });
});

describe('resume and transferred hosting', () => {
  it('a departure after only some peers complete pauses unequal histories without rollback', async () => {
    const f = fixture(['C', 'P', 'T']);
    try {
      const [a, b, c] = await f.start();
      await Promise.all([a!.commit('H'), b!.commit('H'), c!.commit('H')]);
      await f.network.pump((message) => !(message.to === 'peer0' && messageType(message) === 'reveal'));
      assert.equal(a!.view().turn, 0); assert.equal(b!.view().turn, 1);
      const before = [a!.export(), b!.export()];
      c!.close();
      await f.network.pump();
      assert.equal(a!.view().canCommit, false); assert.equal(b!.view().canCommit, false);
      assert.ok([a!, b!].some((player) => player.view().phase === 'mismatch'));
      assert.deepEqual([a!.export(), b!.export()], before);
    } finally { f.close(); }
  });

  it('concurrent historical requests have one confirmed winner without replacing it by ID', async () => {
    const f = fixture();
    try {
      const raw = Match.fromConfig(f.config).export({ C: 'Rook', P: 'Vale' });
      const host = f.open('host', 'resume', raw);
      await f.network.pump();
      host.requestSeat('P'); await f.network.pump();
      const first = f.open('zzFirst', 'resume', raw), later = f.open('aaLater', 'resume', raw);
      await f.network.pump();
      assert.ok(first.requestSeat('C').ok);
      assert.ok(later.requestSeat('C').ok);
      await f.network.pump((message) => message.from !== 'aaLater');
      assert.equal(first.color(), 'C');
      await f.network.pump();
      assert.equal(first.color(), 'C'); assert.equal(later.color(), null);
      assert.equal(host.view().hostId, 'host');
      assert.equal(seat(host, 'C').ownerId, 'zzFirst');
    } finally { f.close(); }
  });

  it('a lone resume opener can host without Coral and retains historical names', async () => {
    const f = fixture();
    try {
      const raw = Match.fromConfig(f.config).export({ C: 'Rook', P: 'Vale' });
      const a = f.open('resumeHost', 'resume', raw);
      await f.network.pump();
      assert.equal(a.color(), null);
      assert.equal(a.view().hostId, 'resumeHost');
      assert.ok(seat(a, 'P').canClaim);
      assert.ok(a.requestSeat('P').ok); await f.network.pump();
      assert.equal(a.color(), 'P'); assert.equal(seat(a, 'P').name, 'Vale');
      assert.equal(a.view().canCommit, false);
      const b = f.open('resumeOther', 'resume', raw);
      await f.network.pump();
      assert.equal(b.requestSeat('P').ok, false); await f.network.pump();
      assert.equal(b.color(), null);
      assert.equal(a.color(), 'P');
      assert.ok(b.requestSeat('C').ok); await f.network.pump();
      a.ready(); b.ready(); await f.network.pump();
      assert.ok(a.view().canCommit && b.view().canCommit);
      assert.deepEqual(decoded(a.export()).names, { C: 'Rook', P: 'Vale' });
    } finally { f.close(); }
  });

  it('surviving ownership and readiness persist when the host leaves and its seat is replaced', async () => {
    const f = fixture(['C', 'P', 'T']);
    try {
      const [a, b, c] = await f.start();
      const raw = a!.export();
      a!.close(); await f.network.pump();
      assert.equal(b!.view().hostId, 'peer1'); assert.equal(c!.view().hostId, 'peer1');
      assert.equal(b!.color(), 'P'); assert.equal(c!.color(), 'T');
      assert.ok(seat(b!, 'P').ready && seat(b!, 'T').ready);
      assert.equal(b!.view().canCommit, false);
      const replacement = f.open('aaReplacement', 'resume', raw);
      await f.network.pump();
      assert.ok(replacement.requestSeat('C').ok); await f.network.pump();
      assert.equal(replacement.color(), 'C');
      assert.equal(replacement.view().hostId, 'peer1');
      replacement.ready(); await f.network.pump();
      assert.ok([b!, c!, replacement].every((player) => player.view().canCommit));
      await Promise.all([b!.commit('H'), c!.commit('H'), replacement.commit('H')]);
      await f.network.pump();
      assert.equal(b!.view().turn, 1); assert.equal(b!.export(), replacement.export());
    } finally { f.close(); }
  });

  for (const lag of [false, true]) {
    it('resume openers pause on ' + (lag ? 'one-turn lag' : 'same-turn divergence') + ' without replacing history', async () => {
      const f = fixture();
      try {
        const left = Wire.encodeExport(f.config,
          [{ turn: metaTurn(0), color: 'C', action: 'D' }, { turn: metaTurn(0), color: 'P', action: 'H' }],
          { C: 'Rook', P: 'Vale' });
        const right = lag ? Match.fromConfig(f.config).export({ C: 'Rook', P: 'Vale' }) :
          Wire.encodeExport(f.config,
            [{ turn: metaTurn(0), color: 'C', action: 'H' }, { turn: metaTurn(0), color: 'P', action: 'H' }],
            { C: 'Rook', P: 'Vale' });
        const a = f.open('left', 'resume', left), b = f.open('right', 'resume', right);
        const before = [a.export(), b.export()];
        await f.network.pump();
        assert.equal(a.view().canCommit, false); assert.equal(b.view().canCommit, false);
        assert.ok([a, b].some((player) => player.view().phase === 'mismatch'));
        assert.deepEqual([a.export(), b.export()], before);
      } finally { f.close(); }
    });
  }
});

describe('canonical exports and discovery', () => {
  it('equivalent action insertion orders encode the same completed snapshot', () => {
    const log = [
      { turn: metaTurn(0), color: 'C' as const, action: 'D' as const },
      { turn: metaTurn(0), color: 'P' as const, action: 'A' as const }
    ];
    assert.equal(Wire.encodeExport(CONFIG, log, { P: 'Vale', C: 'Rook' }),
      Wire.encodeExport(CONFIG, [...log].reverse(), { C: 'Rook', P: 'Vale' }));
  });

  it('trims partial engine exports while retaining names and completed turns', () => {
    const raw = Wire.encodeExport(CONFIG, [
      { turn: metaTurn(0), color: 'C', action: 'D' }, { turn: metaTurn(0), color: 'P', action: 'A' },
      { turn: metaTurn(1), color: 'C', action: 'H' }
    ], { C: 'Rook', P: 'Vale' });
    const completed = imported(trimUnresolved(raw));
    assert.equal(completed.match.currentTurn(), 1);
    assert.deepEqual(completed.match.pendingColors(), ['C', 'P']);
    assert.deepEqual(completed.names, { C: 'Rook', P: 'Vale' });
    assert.equal(trimUnresolved('not an export'), 'not an export');
  });

  it('derives room IDs from the match code, ignoring surrounding whitespace', () => {
    const code = Wire.encodeMatchCode(CONFIG);
    assert.equal(Code.roomId(' ' + code + '\n'), Code.roomId(code));
    assert.match(Code.roomId(code), /^tbtt-[0-9a-f]{16}$/);
    assert.notEqual(Code.roomId(Wire.encodeMatchCode({ ...CONFIG, seed: 'different' })), Code.roomId(code));
  });

  it('a resumed replacement discovers the existing room after a completed turn', async () => {
    const f = fixture();
    try {
      const [a, b] = await f.start();
      await Promise.all([a!.commit('D'), b!.commit('A')]); await f.network.pump();
      const saved = a!.export();
      b!.close(); await f.network.pump();
      const replacement = f.open('replacement', 'resume', saved);
      await f.network.pump();
      const expectedRoom = Code.roomId(Wire.encodeMatchCode(f.config));
      const sent = f.network.sent.filter((message) => message.from === 'replacement');
      assert.ok(sent.length > 0);
      assert.ok(sent.every((message) => JSON.parse(message.text).room === expectedRoom));
      assert.ok(replacement.requestSeat('P').ok); await f.network.pump();
      assert.ok(replacement.ready().ok); await f.network.pump();
      assert.ok(a!.view().canCommit && replacement.view().canCommit);
      assert.equal(replacement.view().turn, 1);
      assert.equal(replacement.export(), saved);
    } finally { f.close(); }
  });

  it('control messages contain no completed log or replacement export', async () => {
    const f = fixture();
    try {
      const [a, b] = await f.start();
      await Promise.all([a!.commit('D'), b!.commit('A')]); await f.network.pump();
      for (const delivery of f.network.sent) {
        const message = JSON.parse(delivery.text) as { v: number; room: string; type: string; value: Record<string, unknown> };
        assert.equal(message.v, 2); assert.equal(typeof message.room, 'string');
        assert.ok(['hello', 'lobby', 'request', 'consent', 'proposal', 'ack', 'activate', 'commit', 'reveal', 'checkpoint'].includes(String(message.type)));
        assert.equal(delivery.text.includes('X1:'), false);
        for (const field of ['log', 'match', 'export']) {
          assert.equal(Object.hasOwn(message, field), false);
          assert.equal(Object.hasOwn(message.value, field), false);
        }
        if (message.type === 'commit') {
          assert.equal(Object.hasOwn(message.value, 'action'), false);
          assert.equal(Object.hasOwn(message.value, 'nonce'), false);
          assert.match(String(message.value.digest), /^[a-f0-9]{64}$/);
        }
      }
    } finally { f.close(); }
  });
});
