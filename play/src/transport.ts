import { Wire, fnv1a } from './engine/index.js';
import { normalizeConfig } from './engine/board.js';

function hex8(n: number): string { return (n >>> 0).toString(16).padStart(8, '0'); }
const Code = {
  roomId: function (s: unknown): string {
    const str = String(s == null ? '' : s).trim();
    return 'tbtt-' + hex8(fnv1a(str)) + hex8(fnv1a('~' + str));
  }
};

// Partial turns lack commitments and cannot safely join a live room.
function trimUnresolved(str: string): string {
  const r = Wire.decodeExport(str);
  if (!r.ok) return str;
  const roster = r.value.config.roster;
  const turns = new Map<number, string[]>();
  for (const e of r.value.log) turns.set(e.turn, [...(turns.get(e.turn) ?? []), e.color]);
  let cut = 0;
  while (turns.get(cut)?.length === roster.length && roster.every((c) => turns.get(cut)!.includes(c))) cut++;
  const log = r.value.log.filter((e) => e.turn < cut);
  try { return Wire.encodeExport(normalizeConfig(r.value.config), log, r.value.names); }
  catch { return str; }
}

export type ChannelState = 'offline' | 'connecting' | 'live' | 'failed';
export type ChannelStatus = { state: ChannelState; peers: string[]; detail: string | null };
export type Channel = {
  id: string | null;
  send: (text: string) => void;
  onMessage: ((text: string, peerId: string) => void) | null;
  onStatus: ((s: ChannelStatus) => void) | null;
  close: () => void;
};

// Subscribers need the current state, not just later changes.
function statusPort(ch: Channel, initial: ChannelStatus): (next: ChannelStatus) => void {
  let fn: Channel['onStatus'] = null, cur = initial;
  Object.defineProperty(ch, 'onStatus', {
    get: function () { return fn; },
    set: function (v: Channel['onStatus']) { fn = v; if (fn) fn(copyStatus(cur)); }
  });
  return function (next) { cur = next; if (fn) fn(copyStatus(cur)); };
}
function copyStatus(s: ChannelStatus): ChannelStatus {
  return { state: s.state, peers: s.peers.slice(), detail: s.detail ?? null };
}

export type RoomAction = {
  send: (data: string) => unknown;
  onMessage: ((data: string, context: { peerId: string }) => void) | null;
};
export type Room = {
  makeAction: (namespace: string) => RoomAction;
  leave: () => unknown;
  getPeers: () => Record<string, unknown>;
  onPeerJoin: ((peerId: string) => void) | null;
  onPeerLeave: ((peerId: string) => void) | null;
};
export type RoomLoader = (roomId: string) => Promise<{ room: Room; selfId: string }>;

const joinTrystero: RoomLoader = async (roomId) => {
  const m = await import('@trystero-p2p/nostr');
  // The room ID varies the relay subset while remaining shared by peers.
  return { room: m.joinRoom({ appId: roomId }, roomId), selfId: m.selfId };
};

function PeerChannel(roomId: string, loadRoom: RoomLoader = joinTrystero): Channel {
  let room: Room | null = null, act: RoomAction | null = null;
  let peers: string[] = [], closed = false;

  const ch: Channel = {
    id: null,
    onMessage: null,
    onStatus: null,
    send: function (text) { if (act) act.send(String(text)); },
    close: function () {
      if (closed) return;
      closed = true;
      if (room) { try { room.leave(); } catch {} }
      room = null; act = null;
      emit({ state: 'offline', peers: [], detail: null });
    }
  };
  const emit = statusPort(ch, { state: 'connecting', peers: [], detail: null });

  // Trystero callbacks may arrive after close().
  function report(): void {
    if (closed) return;
    emit({ state: peers.length ? 'live' : 'connecting', peers: peers.slice(), detail: null });
  }

  loadRoom(roomId).then(function (joined) {
    if (closed) { try { joined.room.leave(); } catch {} return; }
    room = joined.room;
    ch.id = joined.selfId;
    act = room.makeAction('tbtt2');
    act.onMessage = function (data, context) {
      if (!closed && ch.onMessage) ch.onMessage(String(data), context.peerId);
    };
    room.onPeerJoin = function (id) {
      if (peers.indexOf(id) < 0) peers.push(id);
      report();
    };
    room.onPeerLeave = function (id) {
      peers = peers.filter((p) => p !== id);
      report();
    };
    peers = Object.keys(room.getPeers() || {});
    report();
  }).catch(function (e: unknown) {
    if (closed) return;
    emit({ state: 'failed', peers: [], detail: String(e instanceof Error ? e.message : e) });
  });

  return ch;
}

export type LoopbackEnd = Channel & {
  id: string;
  wires: LoopbackEnd[];
  emit: (s: ChannelStatus) => void;
};

let lbSeq = 0;
function makeLoopback(id: string): LoopbackEnd {
  const ch: LoopbackEnd = {
    id: id,
    onMessage: null,
    onStatus: null,
    wires: [],
    emit: () => {},
    send: function (text) {
      for (const o of ch.wires.slice()) if (o.onMessage) o.onMessage(String(text), ch.id);
    },
    close: function () {
      for (const peer of ch.wires) {
        peer.wires = peer.wires.filter((end) => end !== ch);
        peer.emit({ state: 'live', peers: peer.wires.map((end) => end.id), detail: null });
      }
      ch.wires = []; ch.onMessage = null;
      ch.emit({ state: 'offline', peers: [], detail: null });
    }
  };
  ch.emit = statusPort(ch, { state: 'live', peers: [], detail: null });
  return ch;
}

const LoopbackChannel = Object.assign(makeLoopback, {
  make: function (id?: string): LoopbackEnd { return makeLoopback(id || 'lb' + (++lbSeq)); },
  link: function (a: LoopbackEnd, b: LoopbackEnd): void {
    if (a.wires.indexOf(b) < 0) a.wires.push(b);
    if (b.wires.indexOf(a) < 0) b.wires.push(a);
    a.emit({ state: 'live', peers: a.wires.map((o) => o.id), detail: null });
    b.emit({ state: 'live', peers: b.wires.map((o) => o.id), detail: null });
  },
  pair: function (): [LoopbackEnd, LoopbackEnd] {
    const n = ++lbSeq;
    const a = makeLoopback('lb' + n + 'a'), b = makeLoopback('lb' + n + 'b');
    LoopbackChannel.link(a, b);
    return [a, b];
  }
});

export { Session } from './session.js';
export type { SessionOptions, SessionView, SeatView } from './session.js';
export { Code, trimUnresolved, PeerChannel, LoopbackChannel, joinTrystero };
