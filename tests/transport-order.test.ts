import { it } from 'node:test';
import assert from 'node:assert/strict';
import { Match, Wire } from '../play/src/engine/index.js';
import type { Color } from '../play/src/engine/index.js';
import { Session } from '../play/src/transport.js';
import { QueuedNetwork, messageType } from './helpers/queued-channel.js';

function fixture(roster: Color[] = ['C', 'P']) {
  const network = new QueuedNetwork(), players: Session[] = [];
  const config = { mode: 'sandbox' as const, w: 16, h: 9, cap: 40, wallPct: 0, seed: 'ordering', roster };
  const names = { C: 'Coral', P: 'Purple', T: 'Teal', A: 'Amber' };
  const open = (id: string, entry: 'create' | 'join' | 'resume' = 'join', raw?: string) => {
    const saved = raw ? Match.fromExport(raw) : null;
    if (saved) assert.ok(saved.ok);
    const ch = network.connect(id);
    const s = Session.open({ channel: ch, entry, match: saved?.ok ? saved.value.match : Match.fromConfig(config),
      names: saved?.ok ? saved.value.names : entry === 'resume' ? names : undefined });
    players.push(s); return { s, ch };
  };
  const start = async () => {
    const list = roster.map((c, i) => { const { s } = open('p' + i, i ? 'join' : 'create'); s.join(names[c]); return s; });
    await network.pump(); list.forEach((s) => assert.ok(s.ready().ok)); await network.pump();
    list.forEach((s) => assert.ok(s.view().canCommit)); return list;
  };
  return { network, open, start, close: () => players.forEach((s) => s.close()) };
}

it('a proposal arriving before the Ready confirmation waits for that lobby revision', async () => {
  const f = fixture();
  try {
    const a = f.open('host', 'create').s, b = f.open('other').s;
    a.join('Coral'); b.join('Purple'); await f.network.pump();
    a.ready(); b.ready();
    await f.network.pump((m) => !(m.to === 'other' && messageType(m) === 'lobby'));
    assert.equal(b.view().canCommit, false);
    await f.network.pump();
    assert.ok(a.view().canCommit && b.view().canCommit);
  } finally { f.close(); }
});

it('a name edit before acknowledgment supersedes a proposal without freezing old names', async () => {
  const f = fixture();
  try {
    const a = f.open('host', 'create').s, b = f.open('other').s;
    a.join('Coral'); b.join('Old'); await f.network.pump();
    a.ready(); b.ready(); await f.network.pump((m) => messageType(m) !== 'proposal');
    assert.ok(b.join('New').ok);
    await f.network.pump((m) => messageType(m) !== 'ack');
    await f.network.pump();
    assert.equal(a.view().canCommit, false); assert.equal(b.view().canCommit, false);
    const decoded = Wire.decodeExport(a.export()); assert.ok(decoded.ok); assert.deepEqual(decoded.value.names, {});
    assert.ok(b.ready().ok); await f.network.pump();
    assert.ok(a.view().canCommit && b.view().canCommit);
    assert.equal(a.view().names.P, 'New');
  } finally { f.close(); }
});

it('joining and editing another player preserves existing Ready consent', async () => {
  const f = fixture(['C', 'P', 'T']);
  try {
    const a = f.open('host', 'create').s; a.join('Coral'); await f.network.pump(); a.ready(); await f.network.pump();
    const b = f.open('other').s; b.join('Old'); await f.network.pump(); b.join('New'); await f.network.pump();
    assert.equal(a.view().seats.find((s) => s.color === 'C')?.ready, true);
    assert.equal(a.view().canCommit, false);
  } finally { f.close(); }
});

it('same-snapshot simultaneous resume founders converge before assigning seats', async () => {
  const f = fixture();
  try {
    const a = f.open('z', 'resume').s, b = f.open('a', 'resume').s;
    await f.network.pump();
    assert.equal(a.view().hostId, 'a'); assert.equal(b.view().hostId, 'a');
    a.requestSeat('C'); b.requestSeat('P'); await f.network.pump();
    a.ready(); b.ready(); await f.network.pump();
    assert.ok(a.view().canCommit && b.view().canCommit);
  } finally { f.close(); }
});

it('an unseated host computes turns without owning a colour', async () => {
  const f = fixture();
  try {
    const host = f.open('a', 'resume').s; await f.network.pump();
    const a = f.open('b', 'resume').s, b = f.open('c', 'resume').s;
    await f.network.pump(); a.requestSeat('C'); b.requestSeat('P'); await f.network.pump();
    a.ready(); b.ready(); await f.network.pump();
    assert.equal(host.color(), null); assert.equal(host.view().hostId, 'a');
    for (let turn = 0; turn < 3; turn++) {
      assert.ok((await a.commit('H')).ok); assert.ok((await b.commit('H')).ok); await f.network.pump();
      assert.equal(host.view().turn, turn + 1); assert.equal(a.export(), host.export()); assert.equal(a.export(), b.export());
    }
  } finally { f.close(); }
});

it('host loss discards only incomplete staging and ignores former-host activation', async () => {
  const f = fixture(['C', 'P', 'T']);
  try {
    const [a, b, c] = await f.start();
    const raw = a!.export();
    const old = f.network.sent.filter((m) => m.from === 'p0' && ['activate', 'lobby', 'proposal'].includes(messageType(m)));
    await a!.commit('H'); await b!.commit('H'); await f.network.pump();
    a!.close(); await f.network.pump();
    assert.equal(b!.export(), raw); assert.equal(c!.export(), raw);
    old.forEach((m) => f.network.inject(m)); await f.network.pump();
    const replacement = f.open('new', 'resume', raw).s; await f.network.pump();
    replacement.requestSeat('C'); await f.network.pump(); replacement.ready(); await f.network.pump();
    assert.equal(b!.view().hostId, 'p1');
    assert.deepEqual(b!.view().uncommitted, ['C', 'P', 'T']);
    for (const s of [b!, c!, replacement]) assert.ok((await s.commit('H')).ok);
    await f.network.pump(); assert.equal(b!.view().turn, 1); assert.equal(b!.export(), replacement.export());
  } finally { f.close(); }
});

it('incompatible connection observations prevent activation', async () => {
  const f = fixture();
  try {
    const { s: a } = f.open('host', 'create'), { s: b, ch } = f.open('other');
    a.join('Coral'); b.join('Purple'); await f.network.pump();
    ch.onStatus?.({ state: 'connecting', peers: [], detail: null });
    a.ready(); b.ready(); await f.network.pump();
    assert.equal(a.view().canCommit, false); assert.equal(b.view().canCommit, false);
  } finally { f.close(); }
});

it('checkpoints arriving after next-turn commitments release their buffered messages', async () => {
  const f = fixture();
  try {
    const [a, b] = await f.start();
    await a!.commit('H'); await b!.commit('H');
    await f.network.pump((m) => !(m.to === 'p0' && messageType(m) === 'checkpoint'));
    assert.equal(a!.view().turn, 1); assert.equal(b!.view().turn, 1);
    assert.equal(a!.view().canCommit, false); assert.equal(b!.view().canCommit, true);
    assert.ok((await b!.commit('H')).ok);
    await f.network.pump((m) => !(m.to === 'p0' && messageType(m) === 'checkpoint'));
    await f.network.pump();
    assert.deepEqual(a!.view().uncommitted, ['C']);
    await a!.commit('H'); await f.network.pump();
    assert.equal(a!.view().turn, 2); assert.equal(a!.export(), b!.export());
  } finally { f.close(); }
});

for (const diverge of [false, true]) it('discovering ' + (diverge ? 'divergent' : 'equal') + ' active groups preserves completed history', async () => {
  const f = fixture();
  try {
    for (const id of ['a', 'b']) f.network.setPeerView(id, ['a', 'b'].filter((peer) => peer !== id));
    for (const id of ['x', 'y']) f.network.setPeerView(id, ['x', 'y'].filter((peer) => peer !== id));
    const [a, b, x, y] = ['a', 'b', 'x', 'y'].map((id) => f.open(id, 'resume').s);
    await f.network.pump();
    a!.requestSeat('C'); b!.requestSeat('P'); x!.requestSeat('C'); y!.requestSeat('P'); await f.network.pump();
    for (const s of [a!, b!, x!, y!]) s.ready();
    await f.network.pump();
    for (const s of [a!, b!, x!, y!]) assert.ok(s.view().canCommit);
    if (diverge) {
      await a!.commit('D'); await b!.commit('H'); await x!.commit('H'); await y!.commit('H'); await f.network.pump();
    }
    const saved = [a!, b!, x!, y!].map((s) => s.export());
    for (const id of ['a', 'b', 'x', 'y']) f.network.setPeerView(id, ['a', 'b', 'x', 'y'].filter((peer) => peer !== id));
    await f.network.pump();
    assert.deepEqual([a!, b!, x!, y!].map((s) => s.export()), saved);
    if (diverge) {
      for (const s of [a!, b!, x!, y!]) { assert.equal(s.view().canCommit, false); assert.equal(s.view().phase, 'mismatch'); }
    } else {
      assert.equal(a!.view().hostId, 'a'); assert.equal(b!.view().hostId, 'a');
      assert.ok(a!.view().canCommit && b!.view().canCommit);
      assert.equal(x!.color(), null); assert.equal(y!.color(), null);
    }
  } finally { f.close(); }
});

for (const change of ['name', 'ready', 'resume-ready'] as const) {
  it(`rejects ${change} changes after acknowledgment while activation is delayed`, async () => {
    const f = fixture();
    try {
      const resumed = change === 'resume-ready';
      const a = f.open('host', resumed ? 'resume' : 'create').s;
      const b = f.open('other', resumed ? 'resume' : 'join').s;
      await f.network.pump();
      if (resumed) { a.requestSeat('C'); b.requestSeat('P'); }
      else { a.join('Coral'); b.join('Purple'); }
      await f.network.pump(); a.ready(); b.ready();
      await f.network.pump((m) => !(m.to === 'other' && messageType(m) === 'activate'));
      assert.equal(a.view().phase, 'playing');
      assert.equal(b.view().phase, 'agreeing');
      assert.equal(b.view().canReady, false);
      assert.equal(b.view().canEditName, false);
      assert.equal((change === 'name' ? b.join('New') : b.ready(false)).ok, false);
      await f.network.pump();
      assert.ok(a.view().canCommit && b.view().canCommit);
      assert.equal(a.export(), b.export());
      assert.equal(b.view().names.P, 'Purple');
    } finally { f.close(); }
  });
}

for (const early of [false, true]) for (const choice of ['ready', 'not-ready', 'occupied', 'mismatch'] as const) {
  it(`preserves provisional resume choice through discovery: ${choice}, early claim ${early}`, async () => {
    const f = fixture();
    try {
      const [a, b] = await f.start();
      await a!.commit('H'); await b!.commit('H'); await f.network.pump();
      const saved = b!.export();
      if (choice !== 'occupied') { a!.close(); await f.network.pump(); }
      const raw = choice === 'mismatch' ? Match.fromConfig({ mode: 'sandbox', w: 16, h: 9, cap: 40, wallPct: 0, seed: 'ordering', roster: ['C', 'P'] }).export({ C: 'Coral', P: 'Purple' }) : saved;
      const c = f.open('visitor', 'resume', raw).s;
      const isolated = (m: { to: string }) => m.to !== 'visitor';
      if (!early) await f.network.pump(isolated);
      else assert.equal(c.view().phase, 'connecting');
      assert.ok(c.requestSeat('C').ok); await f.network.pump(isolated);
      assert.ok(c.ready().ok); await f.network.pump(isolated);
      if (choice === 'not-ready') { assert.ok(c.ready(false).ok); await f.network.pump(isolated); }
      await f.network.pump();
      if (choice === 'occupied') {
        assert.equal(c.color(), null); assert.equal(c.view().canCommit, false);
        assert.equal(a!.color(), 'C');
      } else if (choice === 'mismatch') {
        assert.equal(c.view().phase, 'mismatch'); assert.equal(c.view().canCommit, false);
        assert.equal(c.export(), raw); assert.equal(b!.export(), saved);
      } else {
        assert.equal(c.color(), 'C'); assert.equal(c.export(), saved);
        assert.equal(c.view().canCommit, choice === 'ready');
        assert.equal(b!.view().canCommit, choice === 'ready');
        if (choice === 'not-ready') {
          assert.equal(c.view().seats.find((s) => s.isLocal)?.ready, false);
          assert.ok(c.ready().ok); await f.network.pump(); assert.ok(c.view().canCommit);
        }
      }
    } finally { f.close(); }
  });
}
