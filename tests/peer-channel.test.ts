import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { PeerChannel } from '../play/src/transport.js';
import type { Channel, ChannelStatus, Room, RoomLoader } from '../play/src/transport.js';

type FakeAction = {
  send: (data: string) => unknown;
  onMessage: ((data: string, context: { peerId: string }) => void) | null;
};

type Fake = {
  room: Room;
  action: FakeAction;
  sent: string[];
  namespaces: string[];
  leaves: () => number;
  join: (id: string) => void;
  part: (id: string) => void;
  deliver: (text: string) => void;
};

function fakeRoom(o: { peers?: string[]; leaveThrows?: Error } = {}): Fake {
  const present = (o.peers ?? []).slice();
  const sent: string[] = [], namespaces: string[] = [];
  let leaves = 0;

  const action: FakeAction = {
    send: (data) => { sent.push(data); },
    onMessage: null
  };
  const room: Room = {
    makeAction: (namespace) => { namespaces.push(namespace); return action; },
    leave: () => { leaves++; if (o.leaveThrows) throw o.leaveThrows; },
    getPeers: () => {
      const out: Record<string, unknown> = {};
      for (const id of present) out[id] = {};
      return out;
    },
    onPeerJoin: null,
    onPeerLeave: null
  };

  return {
    room, action, sent, namespaces,
    leaves: () => leaves,
    join: (id) => {
      if (present.indexOf(id) < 0) present.push(id);
      if (room.onPeerJoin) room.onPeerJoin(id);
    },
    part: (id) => {
      const i = present.indexOf(id);
      if (i >= 0) present.splice(i, 1);
      if (room.onPeerLeave) room.onPeerLeave(id);
    },
    deliver: (text) => { if (action.onMessage) action.onMessage(text, { peerId: 'relay' }); }
  };
}

type Deferred = {
  load: RoomLoader;
  ids: string[];
  resolve: (room: Room) => void;
  reject: (reason: unknown) => void;
};

function deferredLoader(): Deferred {
  const ids: string[] = [];
  let resolve: (room: Room) => void = () => {};
  let reject: (reason: unknown) => void = () => {};
  const room = new Promise<Room>((res, rej) => { resolve = res; reject = rej; });
  return { load: (id) => { ids.push(id); return room; }, ids, resolve, reject };
}

async function settle(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
}

function open(load: RoomLoader, roomId = 'tbtt-0000000000000000'): { ch: Channel; seen: ChannelStatus[] } {
  const ch = PeerChannel(roomId, load);
  const seen: ChannelStatus[] = [];
  ch.onStatus = (s) => { seen.push(s); };
  return { ch, seen };
}

async function joined(o?: { peers?: string[]; leaveThrows?: Error }) {
  const fake = fakeRoom(o);
  const { ch, seen } = open(() => Promise.resolve(fake.room));
  await settle();
  return { fake, ch, seen };
}

function last(seen: ChannelStatus[]): ChannelStatus {
  const s = seen[seen.length - 1];
  assert.ok(s, 'nothing was reported on onStatus');
  return s;
}

describe('joining a room', () => {
  it('stays connecting in an empty room, because reaching the relays is not a game', async () => {
    const d = deferredLoader();
    const { seen } = open(d.load, 'tbtt-abcdef0123456789');
    assert.deepEqual(d.ids, ['tbtt-abcdef0123456789'], 'the room id reaches the loader unchanged');
    assert.deepEqual(last(seen), { state: 'connecting', peers: [], detail: null });

    const fake = fakeRoom();
    d.resolve(fake.room);
    await settle();
    assert.deepEqual(last(seen), { state: 'connecting', peers: [], detail: null },
      'the join resolving only means the relays answered');

    fake.join('p1');
    assert.deepEqual(last(seen), { state: 'live', peers: ['p1'], detail: null },
      'somebody to play against is what makes it live');
  });

  it('seeds its peer list from getPeers, not only from onPeerJoin', async () => {
    const { seen } = await joined({ peers: ['a', 'b'] });
    assert.deepEqual(last(seen), { state: 'live', peers: ['a', 'b'], detail: null });
  });

  it('lists a peer once when the room announces it twice', async () => {
    const { fake, seen } = await joined();
    fake.join('p1');
    fake.join('p1');
    assert.deepEqual(last(seen).peers, ['p1']);
  });
});

describe('a peer leaving', () => {
  it('is dropped from the list, and nobody else with it', async () => {
    const { fake, seen } = await joined({ peers: ['a', 'b'] });
    fake.part('a');
    assert.deepEqual(last(seen), { state: 'live', peers: ['b'], detail: null });

    fake.part('nobody');
    assert.deepEqual(last(seen).peers, ['b'], 'a leaver we never had takes nobody with it');
  });

  it('drops the room back to connecting when it was the last one', async () => {
    const { fake, seen } = await joined({ peers: ['a'] });
    fake.part('a');
    assert.deepEqual(last(seen), { state: 'connecting', peers: [], detail: null },
      'an empty room is one no turn can resolve in');
  });
});

describe('messages', () => {
  it('reach onMessage, and a message before anyone is listening is dropped', async () => {
    const { fake, ch } = await joined({ peers: ['a'] });
    fake.deliver('nobody is listening yet');

    const heard: Array<[string, string]> = [];
    ch.onMessage = (text, peerId) => { heard.push([text, peerId]); };
    fake.deliver('!C~Rook@p-0000000000000000');
    assert.deepEqual(heard, [['!C~Rook@p-0000000000000000', 'relay']]);
  });

  it('go out through the room action', async () => {
    const { fake, ch } = await joined({ peers: ['a'] });
    ch.send('#0C:' + 'a'.repeat(32));
    assert.deepEqual(fake.sent, ['#0C:' + 'a'.repeat(32)]);
    assert.deepEqual(fake.namespaces, ['m'],
      'the namespace is on the wire, so a client that renames it hears nobody');
  });

  it('are dropped, not queued, when sent before the room is ready', async () => {
    const d = deferredLoader();
    const fake = fakeRoom({ peers: ['a'] });
    const { ch } = open(d.load);
    ch.send('early');

    d.resolve(fake.room);
    await settle();
    assert.deepEqual(fake.sent, [],
      'a replayed turn would arrive stale, and Session re-announces on a peer joining anyway');

    ch.send('late');
    assert.deepEqual(fake.sent, ['late'], 'and the channel still works afterwards');
  });
});

describe('a loader that rejects', () => {
  it('reports failed with the error message as detail', async () => {
    const d = deferredLoader();
    const { seen } = open(d.load);
    d.reject(new Error('no relay answered'));
    await settle();
    assert.deepEqual(last(seen), { state: 'failed', peers: [], detail: 'no relay answered' });
  });

  it('reports failed when the rejection is not an Error', async () => {
    const d = deferredLoader();
    const { seen } = open(d.load);
    d.reject('relays unreachable');
    await settle();
    assert.deepEqual(last(seen), { state: 'failed', peers: [], detail: 'relays unreachable' });
  });
});

describe('the status port', () => {
  it('reports where the channel already is the moment onStatus is assigned', async () => {
    const fake = fakeRoom({ peers: ['a'] });
    const ch = PeerChannel('tbtt-0000000000000000', () => Promise.resolve(fake.room));
    await settle();

    const seen: ChannelStatus[] = [];
    ch.onStatus = (s) => { seen.push(s); };
    assert.deepEqual(seen, [{ state: 'live', peers: ['a'], detail: null }]);
  });

  it('hands every subscriber its own copy, so an edit to one does not travel', async () => {
    const { fake, ch, seen } = await joined({ peers: ['a'] });
    last(seen).peers.push('ghost');

    const later: ChannelStatus[] = [];
    ch.onStatus = (s) => { later.push(s); };
    assert.deepEqual(last(later).peers, ['a'], 'the next subscriber gets the room, not the edit');

    fake.join('b');
    assert.deepEqual(last(later).peers, ['a', 'b']);
  });
});

describe('closing', () => {
  it('wires nothing to a room that turns up after close', async () => {
    const d = deferredLoader();
    const fake = fakeRoom({ peers: ['a'] });
    const { ch, seen } = open(d.load);
    ch.close();

    d.resolve(fake.room);
    await settle();

    assert.deepEqual(fake.namespaces, [], 'no action was made');
    assert.equal(fake.action.onMessage, null, 'so nothing is listening');
    assert.equal(fake.room.onPeerJoin, null, 'and no peer event can revive it');
    assert.equal(fake.room.onPeerLeave, null);
    assert.equal(fake.leaves(), 0, 'there was no room to leave at the time');
    assert.deepEqual(last(seen), { state: 'offline', peers: [], detail: null },
      'the late room does not report live over the top of offline');

    ch.send('too late');
    assert.deepEqual(fake.sent, [], 'and a send reaches nobody');
  });

  it('leaves the room, reports offline, and stops sending', async () => {
    const { fake, ch, seen } = await joined({ peers: ['a'] });
    ch.close();

    assert.equal(fake.leaves(), 1);
    assert.deepEqual(last(seen), { state: 'offline', peers: [], detail: null });

    ch.send('after');
    assert.deepEqual(fake.sent, [], 'the send path goes with it');
  });

  it('ignores a peer event that lands after close', async () => {
    const { fake, ch, seen } = await joined({ peers: ['a'] });
    ch.close();

    fake.join('b');
    fake.part('a');
    assert.deepEqual(last(seen), { state: 'offline', peers: [], detail: null });
  });

  it('reports offline even when leaving throws', async () => {
    const { fake, ch, seen } = await joined({ peers: ['a'], leaveThrows: new Error('already gone') });
    ch.close();

    assert.equal(fake.leaves(), 1, 'leave was attempted');
    assert.deepEqual(last(seen), { state: 'offline', peers: [], detail: null });
  });
});

describe('client ids', () => {
  it('are distinct, and shaped for the claim grammar', () => {
    const load: RoomLoader = () => new Promise<Room>(() => {});
    const a = PeerChannel('tbtt-0000000000000000', load).id;
    const b = PeerChannel('tbtt-0000000000000000', load).id;

    assert.match(a, /^p-[0-9a-f]{16}$/);
    assert.notEqual(a, b, 'two clients sharing an id deadlock every colour contest');
  });
});
